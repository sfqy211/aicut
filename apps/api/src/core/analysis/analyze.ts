import { getDb, rows } from "../../db/index.js";
import { eventBus } from "../../events/bus.js";
import { describeWithLLM } from "./llm.js";

// ── 窗口数据收集 ──

interface WindowData {
  sessionId: number;
  startTimeMs: number;
  endTimeMs: number;
  transcriptText: string;
  danmakuLines: string[];
  scLines: string[];
}

/**
 * 收集指定时间窗口内的字幕和弹幕数据。
 * 只取内容，不包含发送者信息。
 */
function collectWindowData(sessionId: number, sinceMs: number, untilMs: number): WindowData {
  const db = getDb();

  // 字幕：从 transcripts 表取 segments_json，按时间过滤
  const transcriptRows = rows<{ segments_json: string | null }>(
    db.prepare("SELECT segments_json FROM transcripts WHERE session_id = ?"),
    sessionId
  );

  const transcriptParts: string[] = [];
  for (const row of transcriptRows) {
    if (!row.segments_json) continue;
    try {
      const segments = JSON.parse(row.segments_json) as Array<{
        start: number;
        end: number;
        text: string;
      }>;
      for (const seg of segments) {
        const segStartMs = seg.start * 1000;
        const segEndMs = seg.end * 1000;
        if (segEndMs > sinceMs && segStartMs < untilMs) {
          transcriptParts.push(seg.text);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // 弹幕和 SC：从 danmaku_events 表取，按时间过滤
  const danmakuRows = rows<{ event_type: string; text: string | null; price: number }>(
    db.prepare(
      `SELECT event_type, text, price FROM danmaku_events
       WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
       ORDER BY timestamp_ms ASC`
    ),
    [sessionId, sinceMs, untilMs]
  );

  const danmakuLines: string[] = [];
  const scLines: string[] = [];

  for (const ev of danmakuRows) {
    if (!ev.text) continue;
    if (ev.event_type === "super_chat" || ev.price > 0) {
      scLines.push(ev.text);
    } else if (ev.event_type === "danmaku") {
      danmakuLines.push(ev.text);
    }
  }

  return {
    sessionId,
    startTimeMs: sinceMs,
    endTimeMs: untilMs,
    transcriptText: transcriptParts.join(""),
    danmakuLines,
    scLines,
  };
}

// ── 分析入口 ──

/**
 * 对指定 session 的 [sinceMs, untilMs) 时间窗口执行 AI 分析。
 * 收集字幕+弹幕 → 调用 LLM 描述 → 保存候选。
 */
export async function analyzeWindow(
  sessionId: number,
  sinceMs: number,
  untilMs: number
): Promise<number | null> {
  const windowData = collectWindowData(sessionId, sinceMs, untilMs);

  console.log(
    `[Analysis] Session ${sessionId}: window ${new Date(sinceMs).toLocaleTimeString()} ~ ${new Date(untilMs).toLocaleTimeString()}, ` +
    `transcript=${windowData.transcriptText.length}chars, danmaku=${windowData.danmakuLines.length}, sc=${windowData.scLines.length}`
  );

  // 跳过空窗口
  if (
    !windowData.transcriptText &&
    windowData.danmakuLines.length === 0 &&
    windowData.scLines.length === 0
  ) {
    console.log(`[Analysis] Session ${sessionId}: empty window, skipping`);
    return null;
  }

  const description = await describeWithLLM(windowData);
  if (!description) {
    console.log(`[Analysis] Session ${sessionId}: LLM returned null`);
    return null;
  }

  console.log(`[Analysis] Session ${sessionId}: description="${description.slice(0, 80)}..."`);

  const startTimeSec = Math.floor(sinceMs / 1000);
  const endTimeSec = Math.floor(untilMs / 1000);
  const duration = endTimeSec - startTimeSec;

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO candidates (session_id, start_time, end_time, duration, ai_description, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    )
    .run(sessionId, startTimeSec, endTimeSec, duration, description);

  const candidateId = Number(result.lastInsertRowid);

  eventBus.publish("candidates.generated", {
    sessionId,
    count: 1,
    candidateId,
  });

  return candidateId;
}
