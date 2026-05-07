import fs from "node:fs";
import path from "node:path";
import {
  libraryPaths,
  getPlaylistPath,
  getEntriesLogPath,
  getSequenceFilePath,
  ensureSessionDir,
} from "../library/index.js";

export interface SegmentEntry {
  /** HLS sequence number */
  sequence: number;
  /** 本地文件路径 */
  filePath: string;
  /** segment 时长（秒） */
  duration: number;
  /** 文件大小（字节） */
  size: number;
  /** 在 session 时间轴上的起始偏移（秒） */
  startOffset: number;
}

export interface SessionPlaylist {
  sessionId: number;
  roomId: string;
  liveId: string;
  segments: SegmentEntry[];
  ended: boolean;
}

// 内存中的 manifest 缓存
const playlists = new Map<number, SessionPlaylist>();

// segment 序列号 → entry 的快速索引 (O(1) 查找)
const segmentBySequence = new Map<number, Map<number, SegmentEntry>>();

function indexSegment(sessionId: number, entry: SegmentEntry): void {
  let idx = segmentBySequence.get(sessionId);
  if (!idx) {
    idx = new Map();
    segmentBySequence.set(sessionId, idx);
  }
  idx.set(entry.sequence, entry);
}

/**
 * 获取或创建内存中的 session playlist
 */
export function ensureSessionPlaylist(
  sessionId: number,
  roomId: string,
  liveId: string
): SessionPlaylist {
  let playlist = playlists.get(sessionId);
  if (!playlist) {
    playlist = { sessionId, roomId, liveId, segments: [], ended: false };
    playlists.set(sessionId, playlist);
  }
  return playlist;
}

/**
 * 从本地文件恢复 playlist（进程重启后调用）
 */
export function restoreSessionPlaylist(
  sessionId: number,
  roomId: string,
  liveId: string
): SessionPlaylist | undefined {
  const entriesPath = getEntriesLogPath(roomId, liveId);
  if (!fs.existsSync(entriesPath)) {
    return undefined;
  }

  const playlist: SessionPlaylist = {
    sessionId,
    roomId,
    liveId,
    segments: [],
    ended: false,
  };

  const lines = fs.readFileSync(entriesPath, "utf-8").split("\n").filter(Boolean);
  let currentOffset = 0;

  for (const line of lines) {
    // 格式: url|seq|duration|size|ts|is_header
    const parts = line.split("|");
    if (parts.length < 5) continue;

    const seq = parseInt(parts[1] ?? "0", 10);
    const duration = parseFloat(parts[2] ?? "0");
    const size = parseInt(parts[3] ?? "0", 10);
    const filePath = path.join(getSessionDir(roomId, liveId), `${seq}.ts`);

    if (fs.existsSync(filePath)) {
      playlist.segments.push({
        sequence: seq,
        filePath,
        duration: Number.isFinite(duration) ? duration : 0,
        size: Number.isFinite(size) ? size : 0,
        startOffset: currentOffset,
      });
      currentOffset += duration;
    }
  }

  // 检查本地 playlist.m3u8 是否已结束
  const playlistPath = getPlaylistPath(roomId, liveId);
  if (fs.existsSync(playlistPath)) {
    const content = fs.readFileSync(playlistPath, "utf-8");
    playlist.ended = content.includes("#EXT-X-ENDLIST");
  }

  playlists.set(sessionId, playlist);

  // 构建 O(1) 序列号索引
  for (const seg of playlist.segments) {
    indexSegment(sessionId, seg);
  }

  return playlist;
}

/**
 * 添加 segment 到 playlist，同时更新内存和本地文件
 */
export function addSegment(
  sessionId: number,
  roomId: string,
  liveId: string,
  entry: Omit<SegmentEntry, "startOffset">
): SegmentEntry {
  const playlist = ensureSessionPlaylist(sessionId, roomId, liveId);

  // 计算 startOffset
  const lastSeg = playlist.segments[playlist.segments.length - 1];
  const startOffset = lastSeg ? lastSeg.startOffset + lastSeg.duration : 0;

  const fullEntry: SegmentEntry = { ...entry, startOffset };
  playlist.segments.push(fullEntry);

  // 更新 O(1) 序列号索引
  indexSegment(sessionId, fullEntry);

  // 追加到 entries.log
  appendEntryLog(roomId, liveId, entry);

  // 重写 playlist.m3u8
  writePlaylistM3u8(roomId, liveId, playlist);

  return fullEntry;
}

/**
 * 标记 session 结束，追加 ENDLIST
 */
export function endSessionPlaylist(sessionId: number): void {
  const playlist = playlists.get(sessionId);
  if (!playlist) return;

  playlist.ended = true;
  writePlaylistM3u8(playlist.roomId, playlist.liveId, playlist);
}

/**
 * 获取内存中的 playlist
 */
export function getPlaylist(sessionId: number): SessionPlaylist | undefined {
  return playlists.get(sessionId);
}

/**
 * 生成供前端使用的 m3u8 文本（使用 seg_{seq} 路由 ID）
 */
export function generateM3u8(sessionId: number): string {
  const playlist = playlists.get(sessionId);
  if (!playlist) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    playlist.ended ? "#EXT-X-PLAYLIST-TYPE:VOD" : "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-TARGETDURATION:10",
  ];

  for (const seg of playlist.segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    lines.push(`/api/sessions/${sessionId}/hls/seq_${seg.sequence}.ts`);
  }

  if (playlist.ended) {
    lines.push("#EXT-X-ENDLIST");
  }

  return lines.join("\n") + "\n";
}

/**
 * 根据 sequence 查找 segment 文件路径 (O(1) Map 查找)
 */
export function getSegmentBySequence(
  sessionId: number,
  sequence: number
): SegmentEntry | undefined {
  return segmentBySequence.get(sessionId)?.get(sequence);
}

// --- 本地文件操作 ---

function appendEntryLog(
  roomId: string,
  liveId: string,
  entry: Omit<SegmentEntry, "startOffset">
) {
  const logPath = getEntriesLogPath(roomId, liveId);
  // 格式: url|seq|duration|size|ts|is_header
  // 简化：filePath|seq|duration|size|timestamp|0
  const line = `${entry.filePath}|${entry.sequence}|${entry.duration}|${entry.size}|${Date.now()}|0\n`;
  fs.appendFileSync(logPath, line);
}

function writePlaylistM3u8(roomId: string, liveId: string, playlist: SessionPlaylist) {
  const playlistPath = getPlaylistPath(roomId, liveId);
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-TARGETDURATION:10",
  ];

  for (const seg of playlist.segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    lines.push(`${seg.sequence}.ts`);
  }

  if (playlist.ended) {
    lines.push("#EXT-X-ENDLIST");
  }

  fs.writeFileSync(playlistPath, lines.join("\n") + "\n");
}

// --- Sequence 文件读写 ---

export function readLastSequence(roomId: string, liveId: string): number {
  const seqPath = getSequenceFilePath(roomId, liveId);
  if (!fs.existsSync(seqPath)) return -1;
  const content = fs.readFileSync(seqPath, "utf-8").trim();
  const seq = parseInt(content, 10);
  return Number.isFinite(seq) ? seq : -1;
}

export function writeLastSequence(roomId: string, liveId: string, sequence: number): void {
  const seqPath = getSequenceFilePath(roomId, liveId);
  fs.writeFileSync(seqPath, String(sequence));
}

function getSessionDir(roomId: string, liveId: string): string {
  return path.join(libraryPaths.sources, roomId, liveId);
}
