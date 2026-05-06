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

const FLAG_POS_SEQ = 0b0001;
const FLAG_NEG_WITH_SEQ = 0b0011;

const SERIAL_NONE = 0b0000;
const SERIAL_JSON = 0b0001;
const COMP_GZIP = 0b0001;

const BIGMODEL_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";

// ── 类型定义 ──

export interface VolcengineAsrConfig {
  appKey: string;
  accessKey: string;
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

function buildFullRequest(config: object): Buffer {
  const header = buildHeader(CLIENT_FULL_REQUEST, FLAG_POS_SEQ, SERIAL_JSON, COMP_GZIP);
  const compressed = gzipSync(Buffer.from(JSON.stringify(config)));
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(1);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(compressed.length);
  return Buffer.concat([header, seqBuf, sizeBuf, compressed]);
}

function buildAudioRequest(audioData: Buffer, sequence: number, isLast: boolean): Buffer {
  const flags = isLast ? FLAG_NEG_WITH_SEQ : FLAG_POS_SEQ;
  const header = buildHeader(CLIENT_AUDIO_ONLY, flags, SERIAL_NONE, COMP_GZIP);
  const compressed = gzipSync(audioData);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(isLast ? -sequence : sequence);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(compressed.length);
  return Buffer.concat([header, seqBuf, sizeBuf, compressed]);
}

// ── 响应解析 ──

interface ParsedResponse {
  code?: number;
  message?: string;
  result?: AsrResult;
  error?: boolean;
}

function parseResponse(data: Buffer): ParsedResponse {
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
    let payloadBuf = body.subarray(4, 4 + payloadSize);
    if (compression === COMP_GZIP) {
      payloadBuf = gunzipSync(payloadBuf);
    }
    return JSON.parse(payloadBuf.toString("utf-8")) as ParsedResponse;
  }

  if (messageType === SERVER_ERROR && body.length >= 8) {
    const errorCode = body.readUInt32BE(0);
    const msgSize = body.readUInt32BE(4);
    const msgBuf = body.subarray(8, 8 + msgSize);
    return { error: true, code: errorCode, message: msgBuf.toString("utf-8") };
  }

  return {};
}

// ── 流式 ASR 会话 ──

export class VolcengineAsrSession {
  private ws: WebSocket | null = null;
  private seq = 2; // 1 已用于 config
  private closed = false;
  private events: VolcengineAsrEvents;

  constructor(
    private config: VolcengineAsrConfig,
    events: Partial<VolcengineAsrEvents> = {},
  ) {
    this.events = {
      onResult: events.onResult ?? (() => {}),
      onError: events.onError ?? (() => {}),
      onOpen: events.onOpen ?? (() => {}),
      onClose: events.onClose ?? (() => {}),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();

      this.ws = new WebSocket(BIGMODEL_ASR_URL, {
        headers: {
          "X-Api-App-Key": this.config.appKey,
          "X-Api-Access-Key": this.config.accessKey,
          "X-Api-Resource-Id": "volc.bigasr.sauc.duration",
          "X-Api-Request-Id": requestId,
        },
      });

      this.ws.on("open", () => {
        // 发送配置帧
        const fullConfig = {
          user: { uid: `aicut-${requestId.slice(0, 8)}` },
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
            this.events.onError(new Error(`ASR error ${result.code}: ${result.message}`));
            return;
          }
          if (result.code === 1000 && result.result) {
            const hasFinal = result.result.utterances?.some((u) => u.definite);
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
    this.ws.send(buildAudioRequest(pcmChunk, this.seq, false));
    this.seq++;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // 发送最后一帧
      this.ws.send(buildAudioRequest(Buffer.alloc(0), this.seq, true));
      // 延迟关闭，等待最终结果
      setTimeout(() => {
        this.ws?.close();
        this.ws = null;
      }, 1000);
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.closed;
  }
}
