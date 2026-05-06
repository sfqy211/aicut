import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { getDb, row, rows } from "../../db/index.js";
import { getBilibiliCookie } from "../../db/dbSettings.js";
import { eventBus } from "../../events/bus.js";
import {
  libraryPaths,
  getSourceDir,
  getSourceCoverPath,
  getSessionCoverPath,
  ensureSessionDir,
} from "../library/index.js";
import { addSegment, endSessionPlaylist, getPlaylist } from "./playlist.js";
import { HlsDownloader, type DownloadError } from "./hlsDownloader.js";
import { DanmuClient } from "./danmuClient.js";
import { fetchRoomInfo, fetchLiveStatus, fetchHlsStream } from "./biliApi.js";
import { buildHlsStream, type HlsStream } from "./hlsStream.js";
import { importDanmuTxtToDb } from "./danmuClient.js";
import { startAsrStream, stopAsrStream, isAsrRunning } from "../asr/index.js";
import { startScheduler, stopScheduler, isSchedulerRunning } from "../analysis/scheduler.js";

// --- 类型定义 ---

export type LiveInfoSnapshot = {
  living?: boolean;
  owner?: string;
  title?: string;
  avatar?: string;
  cover?: string;
};

export type RuntimeStatus = {
  sourceId: number;
  monitoring: boolean;
  state: "idle" | "monitoring" | "recording" | "stopping" | "error";
  sessionId: number | null;
  progressTime: string | null;
  lastError: string | null;
  updatedAt: number;
  liveInfo?: LiveInfoSnapshot;
  localCoverPath?: string | null;
  lastRecordTime?: number | null;
  lastSessionTitle?: string | null;
};

export type RecorderStatus = {
  enabled: boolean;
  message: string;
  activeSources: number;
};

type SourceRow = {
  id: number;
  room_id: string;
  streamer_name: string | null;
  cookie: string | null;
  auto_record: number;
  output_dir: string | null;
};

interface EngineState {
  sourceId: number;
  roomId: string;
  cookie: string | null;
  monitoring: boolean;
  state: RuntimeStatus["state"];
  sessionId: number | null;
  liveId: string | null;
  liveInfo: LiveInfoSnapshot;
  lastError: string | null;
  updatedAt: number;
  // 运行时组件
  downloader: HlsDownloader | null;
  danmuClient: DanmuClient | null;
  hlsStream: HlsStream | null;
  // 续录状态
  shouldContinue: boolean;
  sessionStartMs: number;
  totalDuration: number;
  totalSize: number;
  // 定时器
  checkTimer: ReturnType<typeof setTimeout> | null;
}

const engines = new Map<number, EngineState>();
const CHECK_INTERVAL_MS = 5000;

// --- 公共 API（兼容 recorderManager.ts 原有接口）---

export function getRecorderStatus(): RecorderStatus {
  const active = [...engines.values()].filter((e) => e.monitoring).length;
  return {
    enabled: true,
    activeSources: engines.size,
    message: active > 0 ? `Monitoring ${active} source(s)` : "Recorder idle",
  };
}

export function getSourceRuntime(sourceId: number): RuntimeStatus | null {
  const engine = engines.get(sourceId);
  if (!engine) return null;

  const source = getSource(sourceId);
  const localCoverPath = source ? findLatestLocalCover(source.room_id) : null;

  const lastSession = row<{ start_time: number; title: string | null }>(
    getDb().prepare(
      `SELECT start_time, title FROM sessions
       WHERE source_id = ? AND status != 'recording'
       ORDER BY start_time DESC LIMIT 1`
    ),
    sourceId
  );

  return {
    sourceId,
    monitoring: engine.monitoring,
    state: engine.state,
    sessionId: engine.sessionId,
    progressTime: engine.downloader ? formatDuration(engine.totalDuration) : null,
    lastError: engine.lastError,
    updatedAt: engine.updatedAt,
    liveInfo: engine.liveInfo,
    localCoverPath,
    lastRecordTime: lastSession?.start_time ?? null,
    lastSessionTitle: lastSession?.title ?? null,
  };
}

export function listSourceRuntime(): RuntimeStatus[] {
  return [...engines.keys()].map((id) => getSourceRuntime(id)!).filter(Boolean);
}

export async function startRecorder(sourceId: number): Promise<RuntimeStatus> {
  const source = getSource(sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found`);

  let engine = engines.get(sourceId);
  if (engine?.monitoring) {
    console.log(`[Recorder] Source ${sourceId} already monitoring`);
    return getSourceRuntime(sourceId)!;
  }

  console.log(`[Recorder] Starting source ${sourceId}, room: ${source.room_id}`);
  fs.mkdirSync(getSourceDir(source.room_id), { recursive: true });

  engine = createEngine(sourceId, source.room_id, source.cookie);
  engines.set(sourceId, engine);
  engine.monitoring = true;
  engine.state = "monitoring";

  // 立即执行一次检查，然后启动定时器
  void checkStatus(engine);
  eventBus.publish("source.monitoring_started", { sourceId });
  return getSourceRuntime(sourceId)!;
}

export async function stopRecorder(sourceId: number): Promise<RuntimeStatus | null> {
  const engine = engines.get(sourceId);
  if (!engine) return null;

  engine.monitoring = false;
  engine.state = "stopping";
  if (engine.checkTimer) {
    clearTimeout(engine.checkTimer);
    engine.checkTimer = null;
  }

  // 如果正在录制，结束当前 session
  if (engine.sessionId && engine.downloader) {
    await finalizeSession(engine, false);
  }

  engine.state = "idle";
  engine.sessionId = null;
  engines.delete(sourceId);
  eventBus.publish("source.monitoring_stopped", { sourceId });
  return getSourceRuntime(sourceId);
}

export async function stopSessionRecording(sessionId: number): Promise<boolean> {
  for (const engine of engines.values()) {
    if (engine.sessionId === sessionId) {
      await finalizeSession(engine, false);
      return true;
    }
  }
  return false;
}

export async function restoreAutoRecorders() {
  const sources = rows<SourceRow>(
    getDb().prepare("SELECT * FROM sources WHERE auto_record = 1 ORDER BY id ASC")
  );
  for (const source of sources) {
    try {
      await startRecorder(source.id);
    } catch (error) {
      const engine = engines.get(source.id);
      if (engine) {
        engine.state = "error";
        engine.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

export function updateRecorderFfmpegPath(nextPath: string) {
  config.ffmpegPath = nextPath;
}

// --- 核心状态机 ---

function createEngine(sourceId: number, roomId: string, cookie: string | null): EngineState {
  return {
    sourceId,
    roomId,
    cookie,
    monitoring: false,
    state: "idle",
    sessionId: null,
    liveId: null,
    liveInfo: {},
    lastError: null,
    updatedAt: Date.now(),
    downloader: null,
    danmuClient: null,
    hlsStream: null,
    shouldContinue: false,
    sessionStartMs: 0,
    totalDuration: 0,
    totalSize: 0,
    checkTimer: null,
  };
}

async function checkStatus(engine: EngineState) {
  if (!engine.monitoring) return;

  try {
    const status = await fetchLiveStatus(engine.roomId);
    const wasLiving = engine.liveInfo.living;
    const nowLiving = status.living;

    // 直播状态变化时才更新房间信息
    if (nowLiving && (!wasLiving || engine.liveInfo.title !== status.title)) {
      try {
        const info = await fetchRoomInfo(engine.roomId);
        engine.liveInfo = {
          living: info.living,
          owner: info.owner,
          title: info.title,
          avatar: info.avatar,
          cover: info.cover,
        };
        // 下载封面到房间级目录
        if (info.cover) {
          await downloadCover(info.cover, getSourceCoverPath(engine.roomId));
        }
      } catch (err) {
        console.error(`[Recorder] Failed to fetch room info:`, err);
      }
    } else {
      engine.liveInfo.living = nowLiving;
    }

    // 开播且（未录制或需要续录）→ 启动录制
    if (nowLiving && (engine.state !== "recording" || engine.shouldContinue)) {
      await startRecording(engine, status.liveId, status.title, status.owner);
    }

    // 下播且正在录制 → 结束录制
    if (!nowLiving && engine.state === "recording") {
      await finalizeSession(engine, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Recorder] checkStatus error for source ${engine.sourceId}:`, message);
    engine.lastError = message;
  }

  engine.updatedAt = Date.now();
  if (engine.monitoring) {
    engine.checkTimer = setTimeout(() => checkStatus(engine), CHECK_INTERVAL_MS);
  }
}

async function startRecording(
  engine: EngineState,
  liveId: string,
  title: string,
  owner: string
) {
  console.log(`[Recorder] Live started: source ${engine.sourceId}, liveId=${liveId}`);
  engine.state = "recording";
  engine.shouldContinue = false; // 重置续录标志

  // 复用 session（续录场景）或创建新 session
  let sessionId = engine.sessionId;
  if (!sessionId || engine.liveId !== liveId) {
    sessionId = createSession(engine, liveId, title, owner);
    engine.sessionId = sessionId;
    engine.liveId = liveId;
    engine.sessionStartMs = Date.now();
    engine.totalDuration = 0;
    engine.totalSize = 0;
  } else {
    console.log(`[Recorder] Reusing session ${sessionId} for liveId=${liveId}`);
  }

  // 创建 session 目录并复制封面
  ensureSessionDir(engine.roomId, liveId);
  const sourceCover = getSourceCoverPath(engine.roomId);
  const sessionCover = getSessionCoverPath(engine.roomId, liveId);
  if (fs.existsSync(sourceCover) && !fs.existsSync(sessionCover)) {
    fs.copyFileSync(sourceCover, sessionCover);
  }

  // 启动弹幕客户端（如果未启动）
  if (!engine.danmuClient) {
    const cookieInfo = readCookie(engine.cookie);
    engine.danmuClient = new DanmuClient({
      roomId: engine.roomId,
      sessionId,
      liveId,
      sessionStartMs: engine.sessionStartMs,
      cookie: cookieInfo.auth,
      uid: cookieInfo.uid,
    });
    await engine.danmuClient.start();
  }

  // 获取 HLS 流地址
  const cookieInfo = readCookie(engine.cookie);
  const streamInfo = await fetchHlsStream(engine.roomId, {
    cookie: cookieInfo.auth,
    quality: 10000,
    formatName: "hls",
    codecName: "avc",
  });

  const hlsStream = buildHlsStream(
    liveId,
    streamInfo.host,
    streamInfo.baseUrl,
    streamInfo.extra,
    streamInfo.format === "fmp4" ? "fmp4" : "ts",
    streamInfo.codec
  );

  console.log(`[Recorder] HLS stream: ${hlsStream.index()}`);

  // 保存 HLS 流信息供 ASR 使用
  engine.hlsStream = hlsStream;

  // 启动 HLS 下载器
  engine.downloader = new HlsDownloader({
    sessionId,
    roomId: engine.roomId,
    liveId,
    stream: hlsStream,
    onStreamExpired: () => {
      console.log(`[Recorder] Stream expired for source ${engine.sourceId}, will continue`);
      engine.shouldContinue = true;
    },
    onError: (err: DownloadError) => {
      handleDownloadError(engine, err);
    },
    onSegment: (seg) => {
      handleNewSegment(engine, seg);
    },
  });

  await engine.downloader.start();

  // 启动在线 ASR（续录时复用同一流）
  if (!isAsrRunning(sessionId)) {
    void startAsrForSession(engine, sessionId);
  }

  // 启动定时分析调度器
  const sourceRow = row<{ analysis_interval: number }>(
    getDb().prepare("SELECT analysis_interval FROM sources WHERE id = ?"),
    engine.sourceId
  );
  const interval = sourceRow?.analysis_interval ?? 5;
  if (interval > 0 && !isSchedulerRunning(engine.sourceId)) {
    startScheduler(engine.sourceId, sessionId, engine.sessionStartMs, interval);
  }

  eventBus.publish("source.recording_started", {
    sourceId: engine.sourceId,
    sessionId,
    liveId,
    startTime: engine.sessionStartMs,
  });
}

async function handleDownloadError(engine: EngineState, err: DownloadError) {
  console.error(`[Recorder] Download error for source ${engine.sourceId}: ${err.reason} - ${err.message}`);

  if (err.reason === "StreamExpired") {
    engine.shouldContinue = true;
    // 停止当前下载器，等待 checkStatus 重新启动
    await engine.downloader?.stop();
    engine.downloader = null;
    return;
  }

  if (err.reason === "ResolutionChanged") {
    // 分辨率变化，结束当前 session
    await finalizeSession(engine, true);
    return;
  }

  if (err.reason === "UpdateTimeout") {
    // 主播下播或流断
    await finalizeSession(engine, true);
    return;
  }

  // 其他网络错误，尝试继续
  engine.lastError = `${err.reason}: ${err.message}`;
}

function handleNewSegment(
  engine: EngineState,
  seg: { sequence: number; filePath: string; duration: number; size: number }
) {
  const sessionId = engine.sessionId!;

  // 更新数据库
  const startOffset = getNextStartOffset(sessionId);
  getDb()
    .prepare(
      `INSERT INTO segments (session_id, sequence, file_path, start_offset, duration, size, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ready')`
    )
    .run(sessionId, seg.sequence, seg.filePath, startOffset, seg.duration, seg.size);

  // 更新 playlist
  addSegment(sessionId, engine.roomId, engine.liveId!, {
    sequence: seg.sequence,
    filePath: seg.filePath,
    duration: seg.duration,
    size: seg.size,
  });

  engine.totalDuration += seg.duration;
  engine.totalSize += seg.size;

  // 更新 session 统计
  getDb()
    .prepare(
      "UPDATE sessions SET total_duration = ?, total_size = ?, updated_at = unixepoch() WHERE id = ?"
    )
    .run(Math.floor(engine.totalDuration), engine.totalSize, sessionId);

  eventBus.publish("source.recorder_progress", {
    sourceId: engine.sourceId,
    progress: { time: formatDuration(engine.totalDuration), size: engine.totalSize },
  });
}

async function finalizeSession(engine: EngineState, autoRestart: boolean) {
  const sessionId = engine.sessionId;
  if (!sessionId) return;

  console.log(`[Recorder] Finalizing session ${sessionId} for source ${engine.sourceId}`);

  engine.state = "monitoring";
  engine.shouldContinue = false;

  // 停止下载器
  await engine.downloader?.stop();
  engine.downloader = null;

  // 停止弹幕客户端
  engine.danmuClient?.stop();
  engine.danmuClient = null;

  // 停止 ASR
  stopAsrForSession(sessionId);

  // 停止定时分析调度器（内部会执行最终分析）
  await stopScheduler(engine.sourceId);

  // 结束 playlist
  endSessionPlaylist(sessionId);

  // 更新 session
  getDb()
    .prepare(
      `UPDATE sessions
       SET status = 'processing', end_time = unixepoch(), total_duration = ?, total_size = ?, updated_at = unixepoch()
       WHERE id = ?`
    )
    .run(Math.floor(engine.totalDuration), engine.totalSize, sessionId);

  // 导入弹幕（兜底：danmu.txt 中可能包含 DB 写入失败的数据）
  if (engine.liveId) {
    try {
      const danmuPath = path.join(getSourceDir(engine.roomId), engine.liveId, "danmu.txt");
      if (fs.existsSync(danmuPath)) {
        importDanmuTxtToDb(sessionId, danmuPath);
      }
    } catch (err) {
      console.error(`[Recorder] Failed to import danmu for session ${sessionId}:`, err);
    }
  }

  eventBus.publish("source.recording_stopped", { sourceId: engine.sourceId, sessionId });

  engine.sessionId = null;
  engine.liveId = null;
  engine.totalDuration = 0;
  engine.totalSize = 0;
}

// --- ASR 管理 ---

async function startAsrForSession(engine: EngineState, sessionId: number) {
  try {
    const cookieInfo = readCookie(engine.cookie);
    // 复用录制已有的 HLS m3u8 URL，ffmpeg 加 -vn 提取音频轨
    // 避免单独请求音频流 URL（可能 403 或独立过期）
    const hlsUrl = engine.hlsStream?.index();
    if (!hlsUrl) {
      console.warn(`[ASR] No HLS stream URL available, skipping ASR for session ${sessionId}`);
      return;
    }
    console.log(`[ASR] Using HLS stream URL for ASR: ${hlsUrl.slice(0, 80)}...`);
    await startAsrStream(sessionId, hlsUrl, engine.sessionStartMs, cookieInfo.auth);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ASR] Failed to start for session ${sessionId}: ${message}`);
    eventBus.publish("session.transcription_failed", { sessionId, error: message });
  }
}

function stopAsrForSession(sessionId: number) {
  if (!isAsrRunning(sessionId)) return;
  try {
    stopAsrStream(sessionId);
    console.log(`[ASR] Stopped for session ${sessionId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ASR] Failed to stop for session ${sessionId}: ${message}`);
  }
}

// --- Session 管理 ---

function createSession(
  engine: EngineState,
  liveId: string,
  title: string,
  owner: string
): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO sessions (source_id, session_type, live_id, title, streamer_name, cover_url, avatar_url, start_time, status)
       VALUES (@sourceId, 'live', @liveId, @title, @streamerName, @coverUrl, @avatarUrl, @startTime, 'recording')`
    )
    .run({
      sourceId: engine.sourceId,
      liveId,
      title: title || `Bilibili ${engine.roomId}`,
      streamerName: owner || null,
      coverUrl: engine.liveInfo.cover || null,
      avatarUrl: engine.liveInfo.avatar || null,
      startTime: Math.floor(Date.now() / 1000),
    });

  const sessionId = Number(result.lastInsertRowid);
  console.log(`[Recorder] Created session ${sessionId} for source ${engine.sourceId}`);
  return sessionId;
}

function getNextStartOffset(sessionId: number): number {
  const value = row<{ nextOffset: number | null }>(
    getDb().prepare(
      `SELECT COALESCE(MAX(start_offset + COALESCE(duration, 0)), 0) AS nextOffset
       FROM segments WHERE session_id = ?`
    ),
    sessionId
  );
  return value?.nextOffset ?? 0;
}

// --- 辅助函数 ---

function getSource(sourceId: number): SourceRow | undefined {
  return row<SourceRow>(getDb().prepare("SELECT * FROM sources WHERE id = ?"), sourceId);
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function downloadCover(url: string, destPath: string): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://live.bilibili.com/",
      },
    });
    if (!res.ok) return;
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
  } catch (err) {
    console.error(`[Recorder] Failed to download cover:`, err);
  }
}

export function findLatestLocalCover(roomId: string): string | null {
  const roomDir = path.join(libraryPaths.sources, roomId);
  if (!fs.existsSync(roomDir)) return null;

  let latestPath: string | null = null;
  let latestMtime = 0;
  const stack: string[] = [roomDir];

  try {
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          stack.push(full);
        } else if (/\.(jpg|jpeg|png|webp)$/i.test(entry)) {
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestPath = full;
          }
        }
      }
    }
  } catch {
    return null;
  }

  return latestPath;
}

function readCookie(cookie: string | null): { auth?: string; uid?: number } {
  // 优先级 1：source 级别的 cookie（sources.cookie 列）
  if (cookie?.trim()) {
    const raw = cookie.trim();
    let content = raw;
    if (!raw.includes("=") && fs.existsSync(path.resolve(raw))) {
      content = fs.readFileSync(path.resolve(raw), "utf8");
    } else if (fs.existsSync(raw)) {
      content = fs.readFileSync(path.resolve(raw), "utf8");
    }
    return parseCookieContent(content);
  }

  // 优先级 2：DB settings 表（扫码登录保存的 cookie）
  const dbCookie = getBilibiliCookie();
  if (dbCookie?.trim()) {
    return parseCookieContent(dbCookie);
  }

  return {};
}

function parseCookieContent(content: string): { auth?: string; uid?: number } {
  const trimmed = content.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.cookie && typeof parsed.cookie === "string") {
        return { auth: parsed.cookie, uid: extractUid(parsed.cookie) };
      }
      const cookies = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.cookies)
          ? parsed.cookies
          : Object.entries(parsed)
              .filter(([key]) => !key.startsWith("_"))
              .map(([name, value]) => ({ name, value }));
      const auth = cookies
        .map((item: any) => `${item.name ?? item.key}=${item.value}`)
        .filter((item: string) => item && !item.startsWith("undefined=") && !item.startsWith("_"))
        .join("; ");
      return { auth, uid: extractUid(auth) };
    } catch {
      // ignore
    }
  }

  return { auth: trimmed, uid: extractUid(trimmed) };
}

function extractUid(cookie: string): number | undefined {
  const match = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
  return match ? Number(match[1]) : undefined;
}
