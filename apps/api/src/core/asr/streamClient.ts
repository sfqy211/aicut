import { config } from "../../config.js";
import { eventBus } from "../../events/bus.js";

export type LiveTranscriptChunk = {
  start: number;
  end: number;
  text: string;
  isPartial: boolean;
};

type StreamStartResponse = {
  ok: boolean;
  stream_id: string;
};

type StreamStopResponse = {
  ok: boolean;
  stream_id: string;
  segments: LiveTranscriptChunk[];
};

const transcriptCache = new Map<number, LiveTranscriptChunk[]>();
const sseControllers = new Map<number, AbortController>();

export async function startAsrStream(
  sessionId: number,
  streamUrl: string,
  sessionStartTimeMs: number
): Promise<void> {
  // 启动流式识别
  const startRes = await fetch(`${config.asrWorkerUrl}/stream/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream_id: String(sessionId),
      stream_url: streamUrl,
      session_start_time_ms: sessionStartTimeMs,
    }),
  });

  if (!startRes.ok) {
    const body = await startRes.text();
    throw new Error(`ASR stream start failed: ${startRes.status} ${body}`);
  }

  const data = (await startRes.json()) as StreamStartResponse;
  if (!data.ok) {
    throw new Error("ASR stream start returned not ok");
  }

  // 启动 SSE 消费
  transcriptCache.set(sessionId, []);
  const controller = new AbortController();
  sseControllers.set(sessionId, controller);

  void consumeSse(sessionId, controller.signal);
}

async function consumeSse(sessionId: number, signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch(`${config.asrWorkerUrl}/stream/${sessionId}/events`, {
      signal,
    });

    if (!response.ok || !response.body) {
      console.error(`[ASR SSE] Failed to connect for session ${sessionId}`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6);
        } else if (line === "" && eventType && eventData) {
          if (eventType === "asr_result") {
            try {
              const payload = JSON.parse(eventData) as {
                type: string;
                segment: LiveTranscriptChunk;
              };
              const cache = transcriptCache.get(sessionId) ?? [];
              cache.push(payload.segment);
              // 向前端推送实时字幕
              eventBus.publish("session.transcription_live", {
                sessionId,
                chunk: payload.segment,
              });
            } catch {
              // ignore parse error
            }
          }
          eventType = "";
          eventData = "";
        }
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      console.error(`[ASR SSE] Error for session ${sessionId}:`, error);
    }
  }
}

export async function stopAsrStream(sessionId: number): Promise<LiveTranscriptChunk[]> {
  // 停止 SSE
  const controller = sseControllers.get(sessionId);
  if (controller) {
    controller.abort();
    sseControllers.delete(sessionId);
  }

  // 停止 ASR Worker 流
  const stopRes = await fetch(`${config.asrWorkerUrl}/stream/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream_id: String(sessionId) }),
  });

  if (!stopRes.ok) {
    const body = await stopRes.text();
    throw new Error(`ASR stream stop failed: ${stopRes.status} ${body}`);
  }

  const data = (await stopRes.json()) as StreamStopResponse;

  // 合并缓存与最终结果
  const cache = transcriptCache.get(sessionId) ?? [];
  transcriptCache.delete(sessionId);

  const finalSegments = data.segments ?? [];
  // 去重合并：以最终结果为主
  const all = [...cache, ...finalSegments];
  // 简单去重：按 start + text
  const seen = new Set<string>();
  const merged: LiveTranscriptChunk[] = [];
  for (const seg of all) {
    const key = `${seg.start.toFixed(2)}_${seg.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(seg);
    }
  }
  merged.sort((a, b) => a.start - b.start);
  return merged;
}

export function getTranscriptCache(sessionId: number): LiveTranscriptChunk[] {
  return transcriptCache.get(sessionId) ?? [];
}
