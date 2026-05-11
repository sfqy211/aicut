import { getDb, rows, row } from "../../db/index.js";
import { eventBus } from "../../events/bus.js";
import { describeWithLLM } from "./llm.js";
import { detectDanmakuPeaks, type DensityPeak } from "./density.js";
import {
  scorePeakWindow,
  extractDescriptionRichness,
  type DanmakuSample,
  type WindowScore,
} from "./scoring.js";
import { normalizeDanmaku } from "./utils.js";
import { getDensityK, getAnalysisMinGrade } from "../../db/dbSettings.js";

// ── 窗口数据收集 ──

interface WindowData {
  sessionId: number;
  startTimeMs: number;
  endTimeMs: number;
  transcriptText: string;
  danmakuSamples: DanmakuSample[];
  danmakuLines: string[];
  scLines: string[];
}

/**
 * 收集指定时间窗口内的字幕和弹幕数据。
 */
function collectWindowData(sessionId: number, sinceMs: number, untilMs: number): WindowData {
  const db = getDb();

  // 字幕：从 transcripts 表取 segments_json，按时间过滤
  const transcriptRows = rows<{ segments_json: string | null }>(
    db.prepare("SELECT segments_json FROM transcripts WHERE session_id = ?"),
    sessionId
  );

  const transcriptParts: string[] = [];
  for (const tRow of transcriptRows) {
    if (!tRow.segments_json) continue;
    try {
      const segments = JSON.parse(tRow.segments_json) as Array<{
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
    } catch {
      /* ignore parse errors */
    }
  }

  // 弹幕和 SC
  const danmakuRows = rows<{
    event_type: string;
    text: string | null;
    price: number;
  }>(
    db.prepare(
      `SELECT event_type, text, price FROM danmaku_events
       WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
       ORDER BY timestamp_ms ASC`
    ),
    [sessionId, sinceMs, untilMs]
  );

  const danmakuSamples: DanmakuSample[] = [];
  const danmakuLines: string[] = [];
  const scLines: string[] = [];

  for (const ev of danmakuRows) {
    if (!ev.text) continue;
    danmakuSamples.push({ text: ev.text, price: ev.price || 0 });
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
    danmakuSamples,
    danmakuLines,
    scLines,
  };
}

/**
 * 加载弹幕时间戳数组 — 供 density.ts 使用。
 * 返回绝对毫秒时间戳，已排序。
 */
function getDanmakuTimestamps(sessionId: number, sinceMs: number, untilMs: number): number[] {
  const db = getDb();
  const rows_ = rows<{ timestamp_ms: number }>(
    db.prepare(
      `SELECT timestamp_ms FROM danmaku_events
       WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
       ORDER BY timestamp_ms ASC`
    ),
    [sessionId, sinceMs, untilMs]
  );
  return rows_.map((r) => r.timestamp_ms);
}

// ── 去重 ──

/**
 * 检查两个时间区间是否重叠超过阈值 (0-1)。
 */
function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const overlapStart = Math.max(a.start, b.start);
  const overlapEnd = Math.min(a.end, b.end);
  if (overlapStart >= overlapEnd) return 0;
  const overlap = overlapEnd - overlapStart;
  const minDuration = Math.min(a.end - a.start, b.end - b.start);
  return minDuration > 0 ? overlap / minDuration : 0;
}

// ── 分析入口 ──

/**
 * 对指定 session 的 [sinceMs, untilMs) 时间窗口执行 AI 分析。
 *
 * V2 流水线：
 *   1. 加载弹幕时间戳
 *   2. 密度峰值检测 → peaks[]
 *   3. 对每个峰值：收集窗口数据 → 启发式评分
 *   4. S/A 级窗口 → LLM 描述 → INSERT candidate (带 score/grade)
 *   5. 去重合并重叠候选
 *
 * @returns 生成的候选 ID 列表
 */
export async function analyzeWindow(
  sessionId: number,
  sinceMs: number,
  untilMs: number
): Promise<number[]> {
  // ── 第一层：密度峰值检测 ──
  const timestamps = getDanmakuTimestamps(sessionId, sinceMs, untilMs);

  const k = getDensityK();
  const minGrade = getAnalysisMinGrade();
  const gradeOrder: Record<string, number> = { S: 4, A: 3, B: 2, C: 1 };
  const minGradeLevel = gradeOrder[minGrade] ?? 3; // 默认 A (3)

  console.log(
    `[Analysis] Session ${sessionId}: ${timestamps.length} danmaku in window ` +
      `${new Date(sinceMs).toLocaleTimeString()} ~ ${new Date(untilMs).toLocaleTimeString()}` +
      ` (k=${k.toFixed(1)}, minGrade=${minGrade})`
  );

  const peaks = detectDanmakuPeaks(timestamps, 30, 5000, k);
  if (peaks.length === 0) {
    console.log(`[Analysis] Session ${sessionId}: no peaks detected`);
    return [];
  }

  console.log(
    `[Analysis] Session ${sessionId}: detected ${peaks.length} peak(s)` +
      peaks.map((p) => ` Z=${p.zScore.toFixed(1)}(${p.count})`).join(", ")
  );

  const candidateIds: number[] = [];

  for (const peak of peaks) {
    // 将相对毫秒转为绝对毫秒
    const peakStartMs = sinceMs + peak.startMs;
    const peakEndMs = sinceMs + peak.endMs;

    // ── 第二层：收集窗口数据 + 启发式评分 ──
    const windowData = collectWindowData(sessionId, peakStartMs, peakEndMs);

    const score = scorePeakWindow(windowData.danmakuSamples, peak);

    console.log(
      `[Analysis] Peak ${peak.zScore > 0 ? "+" : ""}${peak.zScore.toFixed(1)}σ: ` +
        `score=${score.total}(${score.grade}) ` +
        `D=${score.density} R=${score.repeat} E=${score.emotion} A=${score.acceleration} SC=${score.scWeight}`
    );

    // B/C 级跳过 (根据用户设定的 minGrade)
    if ((gradeOrder[score.grade] ?? 0) < minGradeLevel) {
      console.log(`[Analysis] Peak skipped: grade ${score.grade} < minGrade ${minGrade}`);
      continue;
    }

    // ── 第三层：LLM 描述 ──
    let description: string | null = null;
    let llmScore = 0;

    {
      // 按频次排序弹幕 (高频弹幕更有分析价值)
      const freqSorted = sortDanmakuByFrequency(windowData.danmakuSamples);

      description = await describeWithLLM({
        transcriptText: windowData.transcriptText,
        danmakuLines: freqSorted.slice(0, 20),
        scLines: windowData.scLines.slice(0, 5),
        zScore: peak.zScore,
        heuristicScore: score.total,
      });

      if (description) {
        llmScore = extractDescriptionRichness(description);
      }
    }

    // ── 综合评分 ──
    const finalScore = description
      ? Math.round(score.total * 0.6 + llmScore * 0.4)
      : score.total;

    const finalGrade: WindowScore["grade"] = description
      ? (finalScore >= 80 ? "S" : finalScore >= 60 ? "A" : finalScore >= 40 ? "B" : "C")
      : score.grade; // 无 LLM 时保留启发式评级

    // ── INSERT ──
    const startTimeSec = Math.floor(peakStartMs / 1000);
    const endTimeSec = Math.floor(peakEndMs / 1000);
    const duration = endTimeSec - startTimeSec;

    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO candidates
         (session_id, start_time, end_time, duration, ai_description, score, score_detail, grade, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        sessionId,
        startTimeSec,
        endTimeSec,
        duration,
        description || null,
        finalScore,
        JSON.stringify(score),
        finalGrade
      );

    const candidateId = Number(result.lastInsertRowid);
    candidateIds.push(candidateId);

    console.log(
      `[Analysis] Candidate #${candidateId}: ${finalScore}pts(${finalGrade}) ` +
        `${startTimeSec}-${endTimeSec} "${(description || "(no LLM)").slice(0, 60)}..."`
    );
  }

  // ── 去重合并 ──
  const deduped = deduplicateCandidates(candidateIds);
  const removed = candidateIds.length - deduped.length;
  if (removed > 0) {
    console.log(`[Analysis] Removed ${removed} duplicate candidate(s)`);
  }

  // 推送事件
  if (deduped.length > 0) {
    eventBus.publish("candidates.generated", {
      sessionId,
      count: deduped.length,
      candidateIds: deduped,
    });
  }

  return deduped;
}

// ── 内部工具 ──

/**
 * 按文本频次排序弹幕（归一化后），高频弹幕排在前面。
 * 用于选取"最频繁"的弹幕发送给 LLM。
 * 保留原始文本（取每组中最长的），避免截断后丢失上下文。
 */
function sortDanmakuByFrequency(samples: DanmakuSample[]): string[] {
  const groups = new Map<string, { count: number; original: string }>();
  for (const s of samples) {
    const key = normalizeDanmaku(s.text || "");
    if (!key) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { count: 1, original: s.text });
    } else {
      existing.count++;
      // Keep the longer original (more informative for LLM)
      if (s.text.length > existing.original.length) {
        existing.original = s.text;
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map(g => g.original);
}

/**
 * 去重：重叠 >50% 的候选只保留评分最高的。
 * 有 LLM 描述的候选优先保留（即使评分略低 5 分以内）。
 */
function deduplicateCandidates(ids: number[]): number[] {
  if (ids.length <= 1) return ids;

  const db = getDb();
  const candidates = ids
    .map((id) =>
      row<{ id: number; start_time: number; end_time: number; score: number; ai_description: string | null }>(
        db.prepare("SELECT id, start_time, end_time, score, ai_description FROM candidates WHERE id = ?"),
        id
      )
    )
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.score - a.score);

  const kept: Array<{ id: number; start: number; end: number; score: number; ai_description: string | null }> = [];

  for (const c of candidates) {
    const overlapIdx = kept.findIndex(
      (k) => overlapRatio({ start: c.start_time, end: c.end_time }, { start: k.start, end: k.end }) > 0.5
    );

    if (overlapIdx === -1) {
      kept.push({ id: c.id, start: c.start_time, end: c.end_time, score: c.score, ai_description: c.ai_description });
    } else {
      const keptCandidate = kept[overlapIdx]!;
      // If the kept candidate has no description but the current one does, swap them
      if (!keptCandidate.ai_description && c.ai_description) {
        db.prepare("DELETE FROM candidates WHERE id = ?").run(keptCandidate.id);
        kept[overlapIdx] = { id: c.id, start: c.start_time, end: c.end_time, score: c.score, ai_description: c.ai_description };
      } else {
        // Delete the current (lower-score) candidate
        db.prepare("DELETE FROM candidates WHERE id = ?").run(c.id);
      }
    }
  }

  return kept.map((k) => k.id);
}
