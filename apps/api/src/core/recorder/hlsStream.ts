import { URL } from "node:url";

export interface HlsStream {
  /** live_id，同一场直播恒定 */
  id: string;
  /** CDN host，例如 https://d1--cn-gotcha204.bilivideo.com */
  host: string;
  /** m3u8 路径，例如 /live-bvc/xxx/live_123/playlist.m3u8 */
  base: string;
  /** URL 查询参数，例如 expires=123&token=abc */
  extra: string;
  /** 封装格式：ts 或 fmp4 */
  format: "ts" | "fmp4";
  /** 编码格式：avc 或 hevc */
  codec: "avc" | "hevc";
  /** 流过期时间戳（秒） */
  expire: number;

  /** 完整 m3u8 URL */
  index(): string;
  /** 构造 segment 完整下载 URL */
  tsUrl(segName: string): string;
  /** 检查流是否即将过期（安全阈值 3 分钟） */
  isExpired(): boolean;
}

const SAFE_EXPIRE_MS = 3 * 60 * 1000; // 3 分钟安全阈值

/**
 * 从 BiliStreamInfo 构建 HlsStream 对象
 */
export function buildHlsStream(
  liveId: string,
  host: string,
  base: string,
  extra: string,
  format: "ts" | "fmp4",
  codec: "avc" | "hevc"
): HlsStream {
  const expire = extractExpire(extra);

  return {
    id: liveId,
    host,
    base,
    extra,
    format,
    codec,
    expire,

    index() {
      return `${this.host}${this.base}?${this.extra}`;
    },

    tsUrl(segName: string) {
      // 处理 segName 可能是相对路径或绝对路径
      if (segName.startsWith("http://") || segName.startsWith("https://")) {
        return segName;
      }

      // segName 可能是 /path/to/seg.ts 或 seg.ts
      if (segName.startsWith("/")) {
        return `${this.host}${segName}?${this.extra}`;
      }

      // segName 是相对路径，需要基于 m3u8 目录解析
      const baseDir = this.base.substring(0, this.base.lastIndexOf("/") + 1);
      return `${this.host}${baseDir}${segName}?${this.extra}`;
    },

    isExpired() {
      if (this.expire <= 0) return false;
      return Date.now() > this.expire * 1000 - SAFE_EXPIRE_MS;
    },
  };
}

/**
 * 从 extra 字符串中提取 expires 时间戳（秒）
 */
function extractExpire(extra: string): number {
  const match = extra.match(/[?&]expires=(\d+)/);
  if (match) {
    return parseInt(match[1] ?? "0", 10);
  }
  return 0;
}

/**
 * 检查 segment URL 是否需要合并查询参数
 * B站 CDN 的 segment URL 可能自带部分参数，需要与 playlist 参数合并
 */
export function mergeQueryParams(baseExtra: string, segQuery: string): string {
  if (!segQuery) return baseExtra;
  if (!baseExtra) return segQuery;

  const baseParams = new URLSearchParams(baseExtra);
  const segParams = new URLSearchParams(segQuery);

  // segment 参数优先覆盖 base 参数（如 token 可能不同）
  for (const [key, value] of segParams) {
    baseParams.set(key, value);
  }

  return baseParams.toString();
}
