import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../../config.js";
import { eventBus } from "../../events/bus.js";
import { VolcengineAsrSession, type AsrResult } from "./volcengineAsr.js";

// ── 运行中的 ASR 流 ──

interface ActiveAsr {
  session: VolcengineAsrSession;
  ffmpeg: ChildProcess;
  sessionId: number;
}

const activeStreams = new Map<number, ActiveAsr>();

// ── 公共 API ──

/**
 * 为指定 session 启动流式 ASR。
 * 内部会 spawn ffmpeg 从 audioUrl 拉取音频并转为 PCM 16kHz mono，
 * 然后实时送入火山引擎 ASR WebSocket。
 */
export async function startAsrStream(
  sessionId: number,
  audioUrl: string,
  sessionStartTimeMs: number,
): Promise<void> {
  if (activeStreams.has(sessionId)) {
    console.log(`[ASR] Session ${sessionId} already has active ASR stream`);
    return;
  }

  const asrSession = new VolcengineAsrSession(
    {
      apiKey: config.volcengineApiKey,
      resourceId: config.volcengineResourceId,
    },
    {
      onOpen: () => {
        console.log(`[ASR] Volcengine connected for session ${sessionId}`);
        eventBus.publish("session.transcription_live", { sessionId, status: "started" });
      },
      onResult: (result: AsrResult, isFinal: boolean) => {
        for (const utt of result.utterances) {
          // 将火山引擎的时间戳（从流开始的毫秒）映射到 session 时间轴
          const chunk = {
            start: (sessionStartTimeMs + utt.start_time) / 1000,
            end: (sessionStartTimeMs + utt.end_time) / 1000,
            text: utt.text,
            isPartial: !utt.definite,
          };
          eventBus.publish("session.transcription_live", { sessionId, chunk });
        }
      },
      onError: (err: Error) => {
        console.error(`[ASR] Error for session ${sessionId}:`, err.message);
        eventBus.publish("session.transcription_failed", { sessionId, error: err.message });
      },
      onClose: () => {
        console.log(`[ASR] Volcengine connection closed for session ${sessionId}`);
      },
    },
  );

  // 启动 ffmpeg：从音频 URL 拉取，转为 PCM 16kHz 16bit mono
  const ffmpeg = spawn(config.ffmpegPath, [
    "-i", audioUrl,
    "-f", "s16le",
    "-ar", "16000",
    "-ac", "1",
    "-acodec", "pcm_s16le",
    "pipe:1",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const active: ActiveAsr = { session: asrSession, ffmpeg, sessionId };
  activeStreams.set(sessionId, active);

  // 连接火山引擎
  await asrSession.start();

  // 将 ffmpeg 的 PCM 输出实时送入 ASR
  ffmpeg.stdout!.on("data", (chunk: Buffer) => {
    // 每次送 200ms 的音频数据（16000Hz × 2bytes × 0.2s = 6400 bytes）
    const CHUNK_SIZE = 6400;
    for (let offset = 0; offset < chunk.length; offset += CHUNK_SIZE) {
      const slice = chunk.subarray(offset, Math.min(offset + CHUNK_SIZE, chunk.length));
      asrSession.sendAudio(slice);
    }
  });

  ffmpeg.on("error", (err) => {
    console.error(`[ASR] ffmpeg error for session ${sessionId}:`, err.message);
    eventBus.publish("session.transcription_failed", { sessionId, error: err.message });
    cleanup(sessionId);
  });

  ffmpeg.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[ASR] ffmpeg exited with code ${code} for session ${sessionId}`);
    }
    // ffmpeg 结束时，发送最后一帧给 ASR
    if (asrSession.isOpen) {
      asrSession.close();
    }
  });

  // stderr 用于调试（不输出到控制台，避免噪音）
  ffmpeg.stderr?.on("data", () => {});
}

/**
 * 停止指定 session 的 ASR 流，返回已收集的最终文本。
 */
export function stopAsrStream(sessionId: number): void {
  const active = activeStreams.get(sessionId);
  if (!active) return;

  console.log(`[ASR] Stopping stream for session ${sessionId}`);

  // 先关闭 ASR（发送最后一帧）
  active.session.close();

  // 再杀 ffmpeg
  if (active.ffmpeg && !active.ffmpeg.killed) {
    active.ffmpeg.kill("SIGTERM");
  }

  activeStreams.delete(sessionId);
}

/**
 * 检查 session 是否有活跃的 ASR 流
 */
export function isAsrRunning(sessionId: number): boolean {
  return activeStreams.has(sessionId);
}

// ── 内部清理 ──

function cleanup(sessionId: number): void {
  const active = activeStreams.get(sessionId);
  if (!active) return;

  if (active.ffmpeg && !active.ffmpeg.killed) {
    active.ffmpeg.kill("SIGTERM");
  }
  active.session.close();
  activeStreams.delete(sessionId);
}
