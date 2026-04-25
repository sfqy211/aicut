import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provider as bilibiliProvider } from "@bililive-tools/bilibili-recorder";
import {
  createRecorderManager,
  setFFMPEGPath,
  type RecorderManager,
  type SerializedRecorder
} from "@bililive-tools/manager";
import { config } from "../../config.js";
import { findDanmakuSidecar, importDanmakuForSegment } from "../danmaku/parser.js";
import { libraryPaths } from "../library/index.js";
import { getDb, row, rows } from "../../db/index.js";
import { eventBus } from "../../events/bus.js";
import { addSegment, endSessionManifest, getSegmentDuration } from "../hls/index.js";
import { getAudioStreamUrl } from "../bilibili/streamUrl.js";
import { startAsrStream, stopAsrStream } from "../asr/streamClient.js";
import { tryGenerateCandidates } from "../analysis/scoring.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

type SourceRow = {
  id: number;
  room_id: string;
  streamer_name: string | null;
  cookie: string | null;
  auto_record: number;
  output_dir: string | null;
};

type RuntimeStatus = {
  sourceId: number;
  recorderId: string;
  monitoring: boolean;
  state: "idle" | "monitoring" | "recording" | "stopping" | "error";
  sessionId: number | null;
  progressTime: string | null;
  lastError: string | null;
  updatedAt: number;
};

export type RecorderStatus = {
  enabled: boolean;
  message: string;
  activeSources: number;
};

type RecorderExtra = { sourceId?: number };

const recorderIdBySource = new Map<number, string>();
const activeSessionBySource = new Map<number, number>();
const runtimeBySource = new Map<number, RuntimeStatus>();
const sessionStartTimeBySource = new Map<number, number>();
let listenersBound = false;

setFFMPEGPath(config.ffmpegPath);

// 捕获弹幕客户端等未处理的错误，避免进程崩溃（只注册一次）
let errorHandlersInstalled = false;
if (!errorHandlersInstalled) {
  errorHandlersInstalled = true;
  process.on("uncaughtException", (error) => {
    console.error("[Recorder] Uncaught exception:", error.message);
    // 不退出进程，允许录制器继续运行
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[Recorder] Unhandled rejection:", reason);
  });
}

const manager = createRecorderManager<RecorderExtra>({
  providers: [bilibiliProvider],
  savePathRule: path.join(
    libraryPaths.sources,
    "{channelId}",
    "{year}-{month}-{date}",
    "{hour}-{min}-{sec} {title}"
  ),
  autoCheckInterval: 5000,
  maxThreadCount: 1,
  waitTime: 500,
  autoRemoveSystemReservedChars: true,
  biliBatchQuery: false,
  providerCheckConfig: {
    Bilibili: {
      autoCheckInterval: 5000,
      maxThreadCount: 1,
      waitTime: 500
    }
  }
});

bindManagerEvents();

export function getRecorderStatus(): RecorderStatus {
  return {
    enabled: true,
    activeSources: runtimeBySource.size,
    message: manager.isCheckLoopRunning ? "Recorder check loop is running." : "Recorder is idle."
  };
}

export function updateRecorderFfmpegPath(nextPath: string) {
  config.ffmpegPath = nextPath;
  setFFMPEGPath(nextPath);
}

export function getSourceRuntime(sourceId: number): RuntimeStatus | null {
  return runtimeBySource.get(sourceId) ?? null;
}

export function listSourceRuntime(): RuntimeStatus[] {
  return [...runtimeBySource.values()];
}

export async function startRecorder(sourceId: number): Promise<RuntimeStatus> {
  const source = getSource(sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found`);

  const existingId = recorderIdBySource.get(sourceId);
  if (existingId && manager.getRecorder(existingId)) {
    ensureCheckLoop();
    setRuntime(sourceId, existingId, { monitoring: true, state: "monitoring" });
    console.log(`[Recorder] Source ${sourceId} already monitoring`);
    return runtimeBySource.get(sourceId)!;
  }

  const cookie = readCookie(source.cookie);
  console.log(`[Recorder] Starting source ${sourceId}, room: ${source.room_id}`);
  console.log(`[Recorder] Cookie auth: ${cookie.auth ? 'provided' : 'missing'}, uid: ${cookie.uid ?? 'not set'}`);

  const recorderId = `source-${source.id}`;
  fs.mkdirSync(path.join(libraryPaths.sources, source.room_id), { recursive: true });

  manager.addRecorder({
    id: recorderId,
    providerId: "Bilibili",
    channelId: source.room_id,
    remarks: source.streamer_name ?? `room-${source.room_id}`,
    quality: 10000,
    streamPriorities: [],
    sourcePriorities: [],
    segment: "2",
    saveGiftDanma: true,
    saveSCDanma: true,
    saveCover: true,
    disableProvideCommentsWhenRecording: false,
    auth: cookie.auth,
    uid: cookie.uid,
    useServerTimestamp: true,
    recorderType: "ffmpeg",
    videoFormat: "ts",
    formatName: "auto",
    codecName: "auto",
    extra: { sourceId }
  });

  recorderIdBySource.set(sourceId, recorderId);
  setRuntime(sourceId, recorderId, { monitoring: true, state: "monitoring" });
  ensureCheckLoop();
  console.log(`[Recorder] Source ${sourceId} started, check loop: ${manager.isCheckLoopRunning}`);
  eventBus.publish("source.monitoring_started", { sourceId });
  return runtimeBySource.get(sourceId)!;
}

export async function stopRecorder(sourceId: number): Promise<RuntimeStatus | null> {
  const recorderId = recorderIdBySource.get(sourceId);
  if (!recorderId) return runtimeBySource.get(sourceId) ?? null;

  const recorder = manager.getRecorder(recorderId);
  if (recorder) {
    setRuntime(sourceId, recorderId, { state: "stopping" });
    await manager.stopRecord(recorderId);
    manager.removeRecorder(recorder);
  }

  recorderIdBySource.delete(sourceId);
  activeSessionBySource.delete(sourceId);
  setRuntime(sourceId, recorderId, { monitoring: false, state: "idle", progressTime: null });
  eventBus.publish("source.monitoring_stopped", { sourceId });
  return runtimeBySource.get(sourceId) ?? null;
}

export async function restoreAutoRecorders() {
  const sources = rows<SourceRow>(
    getDb().prepare("SELECT * FROM sources WHERE auto_record = 1 ORDER BY id ASC")
  );
  for (const source of sources) {
    try {
      await startRecorder(source.id);
    } catch (error) {
      setRuntime(source.id, `source-${source.id}`, {
        monitoring: false,
        state: "error",
        lastError: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function bindManagerEvents() {
  if (listenersBound) return;
  listenersBound = true;

  console.log("[Recorder] Binding manager events");

  manager.on("RecordStart", ({ recorder, recordHandle }) => {
    const sourceId = getSourceIdFromRecorder(recorder);
    if (!sourceId) return;
    const sessionId = ensureActiveSession(sourceId, recorder);
    const startTime = Date.now();
    sessionStartTimeBySource.set(sourceId, startTime);
    console.log(`[Recorder] RecordStart: source ${sourceId}, session ${sessionId}, path: ${recordHandle.savePath}`);
    setRuntime(sourceId, recorder.id, {
      state: "recording",
      monitoring: true,
      sessionId,
      progressTime: recordHandle.progress?.time ?? null
    });
    eventBus.publish("source.recording_started", { sourceId, sessionId, savePath: recordHandle.savePath, startTime });

    // 启动流式 ASR
    void (async () => {
      try {
        const source = getSource(sourceId);
        if (!source) return;
        const cookie = readCookie(source.cookie);
        const streamUrl = await getAudioStreamUrl(source.room_id, cookie.auth);
        await startAsrStream(sessionId, streamUrl, startTime);
        console.log(`[ASR] Stream started for session ${sessionId}`);
        eventBus.publish("session.transcription_live", { sessionId, status: "started" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ASR] Failed to start stream for session ${sessionId}: ${message}`);
        eventBus.publish("session.transcription_failed", { sessionId, error: message });
      }
    })();
  });

  manager.on("RecordStop", ({ recorder }) => {
    const sourceId = getSourceIdFromRecorder(recorder);
    if (!sourceId) return;
    console.log(`[Recorder] RecordStop: source ${sourceId}`);
    const sessionId = activeSessionBySource.get(sourceId);
    if (sessionId) {
      getDb()
        .prepare("UPDATE sessions SET status = 'processing', end_time = unixepoch(), updated_at = unixepoch() WHERE id = ?")
        .run(sessionId);
      // V2: segments 不再用于 ASR 状态追踪，全部标记为 ready
      getDb()
        .prepare("UPDATE segments SET status = 'ready', updated_at = unixepoch() WHERE session_id = ?")
        .run(sessionId);
      endSessionManifest(sessionId);

      // 停止 ASR 流并入库
      void (async () => {
        try {
          const segments = await stopAsrStream(sessionId);
          console.log(`[ASR] Stream stopped for session ${sessionId}, segments=${segments.length}`);

          const fullText = segments.map((s) => s.text).join(" ");
          getDb()
            .prepare(
              `INSERT INTO transcripts (session_id, language, full_text, segments_json)
               VALUES (@sessionId, @language, @fullText, @segmentsJson)`
            )
            .run({
              sessionId,
              language: "auto",
              fullText,
              segmentsJson: JSON.stringify(segments),
            });

          eventBus.publish("session.transcription_completed", { sessionId, segmentCount: segments.length });

          // 触发候选生成
          void tryGenerateCandidates(sessionId).catch((err) => {
            console.error(`[Analysis] Failed to generate candidates for session ${sessionId}:`, err);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[ASR] Failed to stop stream for session ${sessionId}: ${message}`);
          eventBus.publish("session.transcription_failed", { sessionId, error: message });
        }
      })();
    }
    activeSessionBySource.delete(sourceId);
    sessionStartTimeBySource.delete(sourceId);
    setRuntime(sourceId, recorder.id, { state: "monitoring", sessionId: null, progressTime: null });
    eventBus.publish("source.recording_stopped", { sourceId, sessionId: sessionId ?? null });
  });

  manager.on("RecorderProgress", ({ recorder, progress }) => {
    const sourceId = getSourceIdFromRecorder(recorder);
    if (!sourceId) return;
    setRuntime(sourceId, recorder.id, { progressTime: progress.time ?? null });
    eventBus.publish("source.recorder_progress", { sourceId, progress });
  });

  manager.on("videoFileCreated", async ({ recorder, filename }) => {
    const sourceId = getSourceIdFromRecorder(recorder);
    if (!sourceId) return;
    const sessionId = activeSessionBySource.get(sourceId);
    if (sessionId) {
      const duration = await getSegmentDuration(filename);
      addSegment(sessionId, filename, duration);
    }
  });

  manager.on("videoFileCompleted", ({ recorder, filename }) => {
    const sourceId = getSourceIdFromRecorder(recorder);
    if (!sourceId) return;
    console.log(`[Recorder] VideoFileCompleted: source ${sourceId}, file: ${filename}`);
    try {
      const segmentId = createSegmentFromVideo(sourceId, recorder, filename);
      eventBus.publish("segment.created", { sourceId, segmentId, filePath: filename });
      // V2: 流式 ASR 不再按 segment 排队，由 session 级流处理
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Recorder] VideoFileCompleted error: ${message}`);
      setRuntime(sourceId, recorder.id, { state: "error", lastError: message });
      eventBus.publish("source.recorder_error", { sourceId, error: message });
    }
  });

  manager.on("error", ({ source, err }) => {
    console.error(`[Recorder] Manager error: ${err instanceof Error ? err.message : String(err)}`);
    eventBus.publish("source.recorder_error", {
      source,
      error: err instanceof Error ? err.message : String(err)
    });
  });
}

function createSegmentFromVideo(sourceId: number, recorder: SerializedRecorder<RecorderExtra>, filename: string): number {
  const db = getDb();
  const sessionId = ensureActiveSession(sourceId, recorder);
  const stat = fs.statSync(filename);
  const danmakuPath = findDanmakuSidecar(filename);
  const startOffset = getNextStartOffset(sessionId);

  const result = db
    .prepare(
      `INSERT INTO segments (session_id, file_path, start_offset, size, has_danmaku, danmaku_path, status)
       VALUES (@sessionId, @filePath, @startOffset, @size, @hasDanmaku, @danmakuPath, 'pending')`
    )
    .run({
      sessionId,
      filePath: filename,
      startOffset,
      size: stat.size,
      hasDanmaku: danmakuPath ? 1 : 0,
      danmakuPath
    });

  const segmentId = Number(result.lastInsertRowid);
  if (danmakuPath) {
    importDanmakuForSegment(segmentId, danmakuPath);
  }
  updateSessionSize(sessionId);
  return segmentId;
}

function ensureActiveSession(sourceId: number, recorder: SerializedRecorder<RecorderExtra>): number {
  const cached = activeSessionBySource.get(sourceId);
  if (cached) return cached;

  const db = getDb();
  const existing = row<{ id: number }>(
    db.prepare(
      `SELECT id FROM sessions
       WHERE source_id = ? AND status IN ('recording', 'processing')
       ORDER BY id DESC LIMIT 1`
    ),
    sourceId
  );
  if (existing) {
    activeSessionBySource.set(sourceId, existing.id);
    return existing.id;
  }

  const liveInfo = recorder.liveInfo;
  const result = db
    .prepare(
      `INSERT INTO sessions (source_id, session_type, title, start_time, status)
       VALUES (@sourceId, 'live', @title, @startTime, 'recording')`
    )
    .run({
      sourceId,
      title: liveInfo?.title ?? `Bilibili ${recorder.channelId}`,
      startTime: Math.floor(toTimestamp(liveInfo?.recordStartTime) / 1000)
    });

  const sessionId = Number(result.lastInsertRowid);
  activeSessionBySource.set(sourceId, sessionId);
  return sessionId;
}

function getNextStartOffset(sessionId: number): number {
  const value = row<{ nextOffset: number | null }>(
    getDb().prepare(
      `SELECT COALESCE(MAX(start_offset + COALESCE(duration, 1800)), 0) AS nextOffset
       FROM segments
       WHERE session_id = ?`
    ),
    sessionId
  );
  return value?.nextOffset ?? 0;
}

function updateSessionSize(sessionId: number) {
  const totals = row<{ size: number | null }>(
    getDb().prepare("SELECT SUM(COALESCE(size, 0)) AS size FROM segments WHERE session_id = ?"),
    sessionId
  );
  getDb()
    .prepare("UPDATE sessions SET total_size = @size, updated_at = unixepoch() WHERE id = @sessionId")
    .run({ sessionId, size: totals?.size ?? 0 });
}

function ensureCheckLoop() {
  if (!manager.isCheckLoopRunning) {
    manager.startCheckLoop();
  }
}

function setRuntime(sourceId: number, recorderId: string, patch: Partial<RuntimeStatus>) {
  const previous = runtimeBySource.get(sourceId);
  runtimeBySource.set(sourceId, {
    sourceId,
    recorderId,
    monitoring: previous?.monitoring ?? false,
    state: previous?.state ?? "idle",
    sessionId: previous?.sessionId ?? null,
    progressTime: previous?.progressTime ?? null,
    lastError: previous?.lastError ?? null,
    updatedAt: Date.now(),
    ...patch
  });
}

function getSource(sourceId: number): SourceRow | undefined {
  return row<SourceRow>(getDb().prepare("SELECT * FROM sources WHERE id = ?"), sourceId);
}

function getSourceIdFromRecorder(recorder: SerializedRecorder<RecorderExtra>): number | null {
  const sourceId = recorder.extra?.sourceId;
  return typeof sourceId === "number" ? sourceId : null;
}

function readCookie(cookie: string | null): { auth?: string; uid?: number } {
  // 如果提供了 cookie 参数
  if (cookie?.trim()) {
    const raw = cookie.trim();
    let content = raw;

    // 检查是否是文件路径
    if (!raw.includes("=") && fs.existsSync(path.resolve(raw))) {
      content = fs.readFileSync(path.resolve(raw), "utf8");
    } else if (fs.existsSync(raw)) {
      content = fs.readFileSync(raw, "utf8");
    }

    return parseCookieContent(content);
  }

  // 默认从 config/cookie.json 读取
  const configCookiePath = path.join(repoRoot, "config/cookie.json");
  if (fs.existsSync(configCookiePath)) {
    try {
      const content = fs.readFileSync(configCookiePath, "utf8");
      return parseCookieContent(content);
    } catch (error) {
      console.warn(`Failed to read config/cookie.json: ${error}`);
    }
  }

  return {};
}

function parseCookieContent(content: string): { auth?: string; uid?: number } {
  const trimmed = content.trim();

  // 如果是 JSON 格式
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      // 跳过注释字段
      if (parsed.cookie && typeof parsed.cookie === "string") {
        return { auth: parsed.cookie, uid: extractUid(parsed.cookie) };
      }
      // 数组格式
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
      // JSON 解析失败，作为原始字符串处理
    }
  }

  return { auth: trimmed, uid: extractUid(trimmed) };
}

function extractUid(cookie: string): number | undefined {
  const match = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function toTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : Date.now();
  }
  return Date.now();
}
