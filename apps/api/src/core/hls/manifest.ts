import { spawn } from "node:child_process";
import { config } from "../../config.js";
import { getPlaylist, generateM3u8 as generateFromPlaylist } from "../recorder/playlist.js";

export type SegmentInfo = {
  id: string;
  filePath: string;
  duration: number; // seconds
};

export type SessionManifest = {
  sessionId: number;
  segments: SegmentInfo[];
  ended: boolean;
};

/**
 * 从 playlist 获取 session manifest（只读适配层）
 */
export function getManifest(sessionId: number): SessionManifest | undefined {
  const playlist = getPlaylist(sessionId);
  if (!playlist) return undefined;
  return {
    sessionId,
    segments: playlist.segments.map((s) => ({
      id: `seq_${s.sequence}`,
      filePath: s.filePath,
      duration: s.duration,
    })),
    ended: playlist.ended,
  };
}

/**
 * 生成 m3u8 文本（委托给 playlist 模块）
 */
export function generateM3u8(sessionId: number): string {
  return generateFromPlaylist(sessionId);
}

/**
 * 使用 ffprobe 探测 segment 时长
 */
export async function getSegmentDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffprobePath = config.ffmpegPath.replace(/ffmpeg/i, "ffprobe");
    const child = spawn(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.on("close", () => {
      const duration = parseFloat(output);
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 120);
    });
    child.on("error", () => resolve(120));
  });
}

// --- 兼容旧接口（不再维护独立内存结构）---

export function ensureSessionManifest(sessionId: number): SessionManifest {
  return getManifest(sessionId) ?? { sessionId, segments: [], ended: false };
}

export function addSegment(sessionId: number, filePath: string, duration: number): SegmentInfo {
  // 旧接口保留，但不再维护独立的 manifests Map
  // 新录制逻辑已迁移到 recorder/playlist.ts
  return { id: "legacy", filePath, duration };
}

export function endSessionManifest(sessionId: number): void {
  // 空实现，结束逻辑由 playlist.ts 处理
  void sessionId;
}
