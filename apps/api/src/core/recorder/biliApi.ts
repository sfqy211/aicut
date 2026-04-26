import {
  getInfo,
  getStream,
  getLiveStatus,
} from "@bililive-tools/bilibili-recorder/stream.js";

export interface BiliRoomInfo {
  roomId: number;
  uid: number;
  living: boolean;
  owner: string;
  title: string;
  avatar: string;
  cover: string;
  liveStartTime: Date;
  liveId: string;
  area: string;
}

export interface BiliStreamInfo {
  url: string;
  name: string;
  source: string;
  // 底层流元数据
  baseUrl: string;
  host: string;
  extra: string;
  format: "ts" | "fmp4" | "flv";
  codec: "avc" | "hevc";
  currentQn: number;
  acceptQn: number[];
}

export interface BiliLiveStatus {
  living: boolean;
  liveId: string;
  owner: string;
  title: string;
}

/**
 * 获取直播间详细信息（含封面、头像等）
 */
export async function fetchRoomInfo(roomId: string): Promise<BiliRoomInfo> {
  const info = await getInfo(roomId);
  return {
    roomId: info.roomId,
    uid: info.uid,
    living: info.living,
    owner: info.owner,
    title: info.title,
    avatar: info.avatar,
    cover: info.cover,
    liveStartTime: info.liveStartTime,
    liveId: info.liveId,
    area: info.area,
  };
}

/**
 * 获取直播状态（轻量，用于轮询检查）
 */
export async function fetchLiveStatus(roomId: string): Promise<BiliLiveStatus> {
  const status = await getLiveStatus(roomId);
  return {
    living: status.living,
    liveId: status.liveId,
    owner: status.owner,
    title: status.title,
  };
}

/**
 * 获取 HLS 流地址
 * @param roomId 房间号
 * @param options 流选项
 */
export async function fetchHlsStream(
  roomId: string,
  options: {
    cookie?: string;
    quality?: number;
    formatName?: "ts" | "hls" | "hls_only" | "fmp4" | "fmp4_only" | "flv" | "auto";
    codecName?: "avc" | "hevc" | "auto";
    onlyAudio?: boolean;
  } = {}
): Promise<BiliStreamInfo> {
  const res = await getStream({
    channelId: roomId,
    quality: options.quality ?? 10000,
    cookie: options.cookie,
    formatName: options.formatName ?? "hls",
    codecName: options.codecName ?? "avc",
    onlyAudio: options.onlyAudio ?? false,
  });

  const stream = res.currentStream;
  const url = stream.url;

  // 解析 format 和 codec
  const streamOptions = (res as any).streamOptions;
  const format = streamOptions?.format_name ?? "ts";
  const codec = streamOptions?.codec_name ?? "avc";

  // 从 url 中解析 host / base / extra
  const parsed = parseStreamUrl(url);

  return {
    url,
    name: stream.name,
    source: stream.source,
    baseUrl: parsed.base,
    host: parsed.host,
    extra: parsed.extra,
    format: format as "ts" | "fmp4" | "flv",
    codec: codec as "avc" | "hevc",
    currentQn: (res as any).current_qn ?? 10000,
    acceptQn: (res as any).accept_qn ?? [],
  };
}

/**
 * 解析 B站 CDN 流 URL 为 host / base / extra
 * 例如：https://d1--cn-gotcha204.bilivideo.com/live-bvc/xxx/live_123/playlist.m3u8?expires=123&token=abc
 */
function parseStreamUrl(url: string): { host: string; base: string; extra: string } {
  try {
    const u = new URL(url);
    const host = `${u.protocol}//${u.host}`;
    const base = u.pathname;
    const extra = u.search.slice(1); // 去掉开头的 ?
    return { host, base, extra };
  } catch {
    // 兜底：简单字符串分割
    const match = url.match(/^(https?:\/\/[^\/]+)(\/.*\?)(.*)$/);
    if (match) {
      return { host: match[1]!, base: match[2]!.slice(0, -1), extra: match[3]! };
    }
    return { host: "", base: url, extra: "" };
  }
}
