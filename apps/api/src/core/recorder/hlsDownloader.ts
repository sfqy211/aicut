import fs from "node:fs";
import { spawn } from "node:child_process";
import type { HlsStream } from "./hlsStream.js";
import {
  addSegment,
  readLastSequence,
  writeLastSequence,
} from "./playlist.js";
import { getSegmentPath, ensureSessionDir } from "../library/index.js";
import { config } from "../../config.js";

export interface HlsSegment {
  sequence: number;
  uri: string;
  duration: number;
}

export interface ParsedPlaylist {
  mediaSequence: number;
  segments: HlsSegment[];
  ended: boolean;
}

export type DownloadErrorReason =
  | "StreamExpired"
  | "ResolutionChanged"
  | "UpdateTimeout"
  | "NetworkError"
  | "ParseError";

export interface DownloadError {
  reason: DownloadErrorReason;
  message: string;
}

export interface HlsDownloaderOptions {
  sessionId: number;
  roomId: string;
  liveId: string;
  stream: HlsStream;
  /** 流过期回调 */
  onStreamExpired: () => void;
  /** 其他错误回调 */
  onError: (err: DownloadError) => void;
  /** 新 segment 回调 */
  onSegment: (seg: {
    sequence: number;
    filePath: string;
    duration: number;
    size: number;
  }) => void;
}

const POLL_INTERVAL_MS = 1000; // 轮询间隔 1 秒
const UPDATE_TIMEOUT_MS = 20 * 1000; // 20 秒无更新视为超时
const STREAM_EXPIRED_RETRY_MS = 2000; // 流过期后重试间隔

export class HlsDownloader {
  private opts: HlsDownloaderOptions;
  private abortController = new AbortController();
  private lastSequence = -1;
  private lastPlaylistTime = Date.now();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastResolution: { width: number; height: number } | null = null;

  constructor(opts: HlsDownloaderOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    // 恢复上次下载的 sequence（断点续传）
    this.lastSequence = readLastSequence(this.opts.roomId, this.opts.liveId);
    if (this.lastSequence >= 0) {
      this.lastSequence--; // 重新检查上一个，防止遗漏
    }

    ensureSessionDir(this.opts.roomId, this.opts.liveId);
    this.lastPlaylistTime = Date.now();

    // 启动轮询循环
    this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController.abort();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private pollLoop = async () => {
    if (!this.running) return;

    try {
      // 检查流是否过期
      if (this.opts.stream.isExpired()) {
        this.opts.onStreamExpired();
        // 给上层一点时间处理续录，然后继续轮询
        this.scheduleNext(STREAM_EXPIRED_RETRY_MS);
        return;
      }

      // 检查更新超时
      if (Date.now() - this.lastPlaylistTime > UPDATE_TIMEOUT_MS) {
        this.opts.onError({ reason: "UpdateTimeout", message: "20s 内无新 segment" });
        this.running = false;
        return;
      }

      const playlist = await this.fetchPlaylist();
      if (!playlist) {
        this.scheduleNext(POLL_INTERVAL_MS);
        return;
      }

      if (playlist.ended) {
        this.opts.onError({ reason: "UpdateTimeout", message: "Playlist ended" });
        this.running = false;
        return;
      }

      // 发现新 segment
      let hasNew = false;
      for (const seg of playlist.segments) {
        if (seg.sequence > this.lastSequence) {
          await this.downloadSegment(seg);
          this.lastSequence = seg.sequence;
          writeLastSequence(this.opts.roomId, this.opts.liveId, seg.sequence);
          hasNew = true;
        }
      }

      if (hasNew) {
        this.lastPlaylistTime = Date.now();
      }

      this.scheduleNext(POLL_INTERVAL_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 忽略主动中止的错误
      if (message.includes("abort") || message.includes("Abort")) {
        return;
      }
      this.opts.onError({ reason: "NetworkError", message });
      this.scheduleNext(POLL_INTERVAL_MS);
    }
  };

  private scheduleNext(delay: number) {
    if (!this.running) return;
    this.pollTimer = setTimeout(this.pollLoop, delay);
  }

  private async fetchPlaylist(): Promise<ParsedPlaylist | null> {
    const url = this.opts.stream.index();
    const res = await fetch(url, {
      signal: this.abortController.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://live.bilibili.com/",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching playlist`);
    }

    const text = await res.text();
    return parseMediaPlaylist(text);
  }

  private async downloadSegment(seg: HlsSegment): Promise<void> {
    const url = this.opts.stream.tsUrl(seg.uri);
    const filePath = getSegmentPath(this.opts.roomId, this.opts.liveId, seg.sequence);

    const res = await fetch(url, {
      signal: this.abortController.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://live.bilibili.com/",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} downloading segment ${seg.sequence}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    // ffprobe 探测时长和分辨率
    const { duration, width, height } = await probeSegment(filePath);

    // 分辨率变化检测
    if (this.lastResolution && (width !== this.lastResolution.width || height !== this.lastResolution.height)) {
      // 分辨率变化，结束当前 session
      this.opts.onError({
        reason: "ResolutionChanged",
        message: `Resolution changed from ${this.lastResolution.width}x${this.lastResolution.height} to ${width}x${height}`,
      });
      this.running = false;
      return;
    }

    if (width && height) {
      this.lastResolution = { width, height };
    }

    // 如果 ffprobe 无法获取时长，使用 playlist 中的 duration
    const finalDuration = Number.isFinite(duration) && duration > 0 ? duration : seg.duration;

    // 通知上层
    this.opts.onSegment({
      sequence: seg.sequence,
      filePath,
      duration: finalDuration,
      size: buffer.length,
    });
  }
}

// --- 轻量 m3u8 MediaPlaylist 解析 ---

function parseMediaPlaylist(text: string): ParsedPlaylist {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#EXTM3U"));

  let mediaSequence = 0;
  const segments: HlsSegment[] = [];
  let ended = false;
  let pendingDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.split(":")[1] ?? "0", 10) || 0;
    } else if (line.startsWith("#EXTINF:")) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      pendingDuration = match ? parseFloat(match[1] ?? "0") : 0;
    } else if (line === "#EXT-X-ENDLIST") {
      ended = true;
    } else if (!line.startsWith("#")) {
      // segment URI
      segments.push({
        sequence: mediaSequence + segments.length,
        uri: line,
        duration: pendingDuration || 2,
      });
      pendingDuration = 0;
    }
  }

  return { mediaSequence, segments, ended };
}

// --- ffprobe 探测 ---

interface ProbeResult {
  duration: number;
  width: number;
  height: number;
}

async function probeSegment(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const ffprobePath = config.ffmpegPath.replace(/ffmpeg/i, "ffprobe");
    const child = spawn(
      ffprobePath,
      [
        "-v", "error",
        "-show_entries", "format=duration:stream=width,height",
        "-of", "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.on("close", () => {
      try {
        const data = JSON.parse(output);
        const duration = parseFloat(data.format?.duration ?? "0");
        const stream = data.streams?.[0];
        const width = stream?.width ?? 0;
        const height = stream?.height ?? 0;
        resolve({ duration, width, height });
      } catch {
        resolve({ duration: 0, width: 0, height: 0 });
      }
    });
    child.on("error", () => resolve({ duration: 0, width: 0, height: 0 }));
  });
}
