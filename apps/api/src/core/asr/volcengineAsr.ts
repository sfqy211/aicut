import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import WebSocket from "ws";

// ── 二进制协议常量 ──

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE_UNITS = 0b0001;

const CLIENT_FULL_REQUEST = 0b0001;
const CLIENT_AUDIO_ONLY = 0b0010;
const SERVER_FULL_RESPONSE = 0b1001;
const SERVER_ERROR = 0b1111;

// 音频帧 flags：官方示例中普通音频包不带 sequence number
const FLAG_NONE = 0b0000;
const FLAG_LAST_NO_SEQ = 0b0010; // 最后一包，无 sequence
const FLAG_POS_SEQ = 0b0001;

const SERIAL_NONE = 0b0000;
const SERIAL_JSON = 0b0001;
const COMP_GZIP = 0b0001;

// 双向流式优化版（推荐）：仅在结果变化时返回，性能更优
const BIGMODEL_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

// ── 类型定义 ──

export interface VolcengineAsrConfig {
  apiKey: string;
  /** 资源 ID，默认 volc.seedasr.sauc.duration（豆包2.0小时版） */
  resourceId?: string;
}

export interface AsrUtterance {
  text: string;
  start_time: number;
  end_time: number;
  definite: boolean;
  words?: { text: string; start_time: number; end_time: number }[];
}

export interface AsrResult {
  text: string;
  utterances: AsrUtterance[];
}

export interface VolcengineAsrEvents {
  onResult: (result: AsrResult, isFinal: boolean) => void;
  onError: (error: Error) => void;
  onOpen: () => void;
  onClose: () => void;
}

// ── 二进制帧构建 ──

function buildHeader(messageType: number, flags: number, serial: number, compression: number): Buffer {
  const buf = Buffer.alloc(4);
  buf[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNITS;
  buf[1] = (messageType << 4) | flags;
  buf[2] = (serial << 4) | compression;
  buf[3] = 0x00;
  return buf;
}

/**
 * Full Client Request：Header + PayloadSize + Payload(JSON gzip)
 * 官方示例中 flags=0b0000（无 sequence number）
 */
function buildFullRequest(config: object): Buffer {
  const header = buildHeader(CLIENT_FULL_REQUEST, FLAG_NONE, SERIAL_JSON, COMP_GZIP);
  const compressed = gzipSync(Buffer.from(JSON.stringify(config)));
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(compressed.length);
  return Buffer.concat([header, sizeBuf, compressed]);
}

/**
 * Audio-Only Request：Header + PayloadSize + Payload(audio gzip)
 * 普通帧 flags=0b0000，最后一帧 flags=0b0010
 */
function buildAudioRequest(audioData: Buffer, isLast: boolean): Buffer {
  const flags = isLast ? FLAG_LAST_NO_SEQ : FLAG_NONE;
  const header = buildHeader(CLIENT_AUDIO_ONLY, flags, SERIAL_NONE, COMP_GZIP);
  const compressed = gzipSync(audioData);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(compressed.length);
  return Buffer.concat([header, sizeBuf, compressed]);
}

// ── 响应解析 ──

interface ParsedResponse {
  code?: number;
  message?: string;
  result?: AsrResult;
  audio_info?: { duration?: number };
  error?: boolean;
}

function parseResponse(data: Buffer): ParsedResponse {
  try {
    if (data.length < 4) return {};

    const messageType = (data[1] ?? 0) >> 4;
    const flags = (data[1] ?? 0) & 0x0f;
    const compression = (data[2] ?? 0) & 0x0f;
    const headerBytes = ((data[0] ?? 0) & 0x0f) * 4;

    let body = data.subarray(headerBytes);

    // 跳过 sequence number（如果存在）
    const hasSeq = !!(flags & 0x01);
    if (hasSeq && body.length >= 4) {
      body = body.subarray(4);
    }

    if (messageType === SERVER_FULL_RESPONSE && body.length >= 4) {
      const payloadSize = body.readUInt32BE(0);
      if (4 + payloadSize > body.length) {
        return { error: true, code: -1, message: "Truncated response payload" };
      }
      let payloadBuf = body.subarray(4, 4 + payloadSize);
      if (compression === COMP_GZIP) {
        payloadBuf = gunzipSync(payloadBuf);
      }
      return JSON.parse(payloadBuf.toString("utf-8")) as ParsedResponse;
    }

    if (messageType === SERVER_ERROR && body.length >= 8) {
      const errorCode = body.readUInt32BE(0);
      const msgSize = body.readUInt32BE(4);
      const safeMsgSize = Math.min(msgSize, body.length - 8);
      const msgBuf = body.subarray(8, 8 + safeMsgSize);
      return { error: true, code: errorCode, message: msgBuf.toString("utf-8") };
    }

    return {};
  } catch {
    return { error: true, code: -1, message: "Failed to parse ASR response" };
  }
}

// ── 流式 ASR 会话 ──

export class VolcengineAsrSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private events: VolcengineAsrEvents;
  private requestId: string;

  constructor(
    private volcConfig: VolcengineAsrConfig,
    events: Partial<VolcengineAsrEvents> = {},
  ) {
    this.requestId = crypto.randomUUID();
    this.events = {
      onResult: events.onResult ?? (() => {}),
      onError: events.onError ?? (() => {}),
      onOpen: events.onOpen ?? (() => {}),
      onClose: events.onClose ?? (() => {}),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const resourceId = this.volcConfig.resourceId ?? "volc.seedasr.sauc.duration";

      this.ws = new WebSocket(BIGMODEL_ASR_URL, {
        headers: {
          "X-Api-Key": this.volcConfig.apiKey,
          "X-Api-Resource-Id": resourceId,
          "X-Api-Connect-Id": this.requestId,
          "X-Api-Sequence": "-1",
        },
      });

      this.ws.on("open", () => {
        // 发送配置帧（Full Client Request）
        const fullConfig = {
          user: { uid: `aicut-${this.requestId.slice(0, 8)}` },
          audio: { format: "pcm", rate: 16000, bits: 16, channel: 1, codec: "raw" },
          request: {
            model_name: "bigmodel",
            enable_itn: true,
            enable_punc: true,
            show_utterance: true,
            result_type: "single",
            end_window_size: 800,
          },
        };
        this.ws!.send(buildFullRequest(fullConfig));
        this.events.onOpen();
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const result = parseResponse(data);
          if (result.error) {
            // 45000081 = 等包超时，正常结束（音频流结束后的预期行为）
            if (result.code === 45000081) {
              this.events.onClose();
              return;
            }
            this.events.onError(new Error(`ASR error ${result.code}: ${result.message}`));
            return;
          }
          // 成功响应：有 result 且无 error 即为有效结果
          // bigmodel_async 正常结果帧可能不带 code 字段，不能依赖 code 判断
          if (result.result && !result.error) {
            // bigmodel_async 有时返回只有 text 没有 utterances 的结果帧，跳过
            if (!result.result.utterances || !Array.isArray(result.result.utterances)) {
              return;
            }
            const hasFinal = result.result.utterances.some((u) => u.definite);
            this.events.onResult(result.result, !!hasFinal);
          }
        } catch (err) {
          this.events.onError(err instanceof Error ? err : new Error(String(err)));
        }
      });

      this.ws.on("error", (err) => {
        this.events.onError(err);
        reject(err);
      });

      this.ws.on("close", () => {
        this.events.onClose();
      });
    });
  }

  sendAudio(pcmChunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return;
    this.ws.send(buildAudioRequest(pcmChunk, false));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // 发送最后一帧（空数据 + last flag）
      this.ws.send(buildAudioRequest(Buffer.alloc(0), true));
      // 延迟关闭，等待最终结果
      setTimeout(() => {
        this.ws?.close();
        this.ws = null;
      }, 2000);
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.closed;
  }
}
