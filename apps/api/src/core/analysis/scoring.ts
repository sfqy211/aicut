import { getDb, row, rows } from "../../db/index.js";
import { eventBus } from "../../events/bus.js";
import { calculateFinalScore, scoreWithLLM } from "./llm.js";
import {
  calculateRuleScore,
  generateWindows,
  isHighValue,
  shouldCallLLM,
} from "./rules.js";
import { computeSessionStats, getWindowData } from "./stats.js";

export interface CandidateInput {
  sessionId: number;
  segmentId: number | null;
  startTime: number;
  endTime: number;
  duration: number;
}

export interface GeneratedCandidate extends CandidateInput {
  ruleScore: number;
  scoreDanmaku: number;
  scoreInteraction: number;
  scoreKeyword: number;
  scoreEnergy: number;
  finalScore: number;
  llmResult: {
    category: string | null;
    confidence: number | null;
    worth: boolean | null;
    risk: string | null;
  } | null;
  aiHighlight: string | null;
  aiTitle: string | null;
  aiReason: string | null;
  suggestedTrimStart: number;
  suggestedTrimEnd: number;
}

// 主入口：为 session 生成候选片段
export async function generateCandidates(sessionId: number): Promise<number> {
  const db = getDb();

  const session = row<{
    status: string;
    total_duration: number | null;
    title: string | null;
    source_id: number | null;
  }>(
    db.prepare("SELECT status, total_duration, title, source_id FROM sessions WHERE id = ?"),
    sessionId
  );

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const source = session.source_id
    ? row<{ streamer_name: string | null }>(
        db.prepare("SELECT streamer_name FROM sources WHERE id = ?"),
        session.source_id
      )
    : null;

  const metadata = {
    streamerName: source?.streamer_name ?? undefined,
    liveTitle: session.title ?? undefined,
  };

  const stats = computeSessionStats(sessionId);

  if (stats.duration < 60) {
    console.log(`Session ${sessionId} too short (${stats.duration}s), skipping`);
    return 0;
  }

  const windows = generateWindows(stats.duration, {
    minDuration: 45,
    maxDuration: 120,
    step: 15,
  });

  console.log(
    `Generating candidates for session ${sessionId}: ${windows.length} windows`
  );

  const llmCandidates: Array<{
    window: { start: number; end: number; duration: number };
    windowData: ReturnType<typeof getWindowData>;
    ruleScore: ReturnType<typeof calculateRuleScore>;
  }> = [];

  const scoredWindows: Array<{
    window: { start: number; end: number; duration: number };
    windowData: ReturnType<typeof getWindowData>;
    ruleScore: ReturnType<typeof calculateRuleScore>;
    segmentId: number | null;
  }> = [];

  for (const window of windows) {
    const windowData = getWindowData(
      sessionId,
      window.start * 1000,
      window.end * 1000
    );

    const energyPeak = windowData.danmakuCount / window.duration;

    const windowWithEnergy = {
      startTime: window.start,
      endTime: window.end,
      duration: window.duration,
      danmakuCount: windowData.danmakuCount,
      priceTotal: windowData.priceTotal,
      topDanmaku: windowData.topDanmaku,
      scMessages: windowData.scMessages,
      transcriptText: windowData.transcriptText,
      energyPeak,
    };

    const ruleScore = calculateRuleScore(windowWithEnergy, stats);

    const segmentId = findSegmentForWindow(sessionId, window.start, window.end);

    scoredWindows.push({
      window,
      windowData,
      ruleScore,
      segmentId,
    });

    if (
      shouldCallLLM(ruleScore, stats) ||
      isHighValue(windowData.priceTotal, stats)
    ) {
      llmCandidates.push({
        window,
        windowData,
        ruleScore,
      });
    }
  }

  const llmResults = new Map<string, Awaited<ReturnType<typeof scoreWithLLM>>>();
  const maxConcurrency = 3;

  for (let i = 0; i < llmCandidates.length; i += maxConcurrency) {
    const batch = llmCandidates.slice(i, i + maxConcurrency);
    const results = await Promise.all(
      batch.map((item) =>
        scoreWithLLM(
          {
            startTime: item.window.start,
            endTime: item.window.end,
            duration: item.window.duration,
            danmakuCount: item.windowData.danmakuCount,
            priceTotal: item.windowData.priceTotal,
            topDanmaku: item.windowData.topDanmaku,
            scMessages: item.windowData.scMessages,
            transcriptText: item.windowData.transcriptText,
            energyPeak: item.windowData.danmakuCount / item.window.duration,
          },
          item.ruleScore,
          stats,
          metadata
        ).catch((err) => {
          console.error(`LLM scoring failed: ${err.message}`);
          return null;
        })
      )
    );

    for (let j = 0; j < batch.length; j++) {
      const batchItem = batch[j];
      const resultItem = results[j];
      if (batchItem && resultItem !== undefined) {
        const key = `${batchItem.window.start}-${batchItem.window.end}`;
        llmResults.set(key, resultItem);
      }
    }
  }

  const dedupedCandidates = deduplicateCandidates(
    scoredWindows.map((item) => {
      const key = `${item.window.start}-${item.window.end}`;
      const llmResult = llmResults.get(key) ?? null;
      const finalScore = calculateFinalScore(item.ruleScore, llmResult);

      return {
        sessionId,
        segmentId: item.segmentId,
        startTime: item.window.start,
        endTime: item.window.end,
        duration: item.window.duration,
        ruleScore: item.ruleScore.total,
        scoreDanmaku: item.ruleScore.danmaku,
        scoreInteraction: item.ruleScore.interaction,
        scoreKeyword: item.ruleScore.keyword,
        scoreEnergy: item.ruleScore.energy,
        finalScore,
        llmResult: llmResult
          ? {
              category: llmResult.category,
              confidence: llmResult.confidence,
              worth: llmResult.worth,
              risk: llmResult.risk,
            }
          : null,
        aiHighlight: llmResult?.highlight ?? null,
        aiTitle: llmResult?.title ?? null,
        aiReason: llmResult?.reason ?? null,
        suggestedTrimStart: llmResult?.suggestedAdjustment?.trimStart ?? 0,
        suggestedTrimEnd: llmResult?.suggestedAdjustment?.trimEnd ?? 0,
      };
    })
  );

  const insert = db.prepare(
    `INSERT INTO candidates (
      session_id, segment_id, start_time, end_time, duration,
      rule_score, score_danmaku, score_interaction, score_transcript, score_energy,
      score_total, llm_score, llm_category, llm_confidence, llm_worth, llm_risk,
      ai_summary, ai_title_suggestion, ai_reason, ai_highlight,
      suggested_trim_start, suggested_trim_end, status
    ) VALUES (
      @sessionId, @segmentId, @startTime, @endTime, @duration,
      @ruleScore, @scoreDanmaku, @scoreInteraction, @scoreKeyword, @scoreEnergy,
      @finalScore, @llmScore, @llmCategory, @llmConfidence, @llmWorth, @llmRisk,
      @aiHighlight, @aiTitle, @aiReason, @aiHighlight2,
      @suggestedTrimStart, @suggestedTrimEnd, 'pending'
    )`
  );

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM candidates WHERE session_id = ?").run(sessionId);

    for (const candidate of dedupedCandidates) {
      insert.run({
        sessionId: candidate.sessionId,
        segmentId: candidate.segmentId,
        startTime: candidate.startTime,
        endTime: candidate.endTime,
        duration: candidate.duration,
        ruleScore: candidate.ruleScore,
        scoreDanmaku: candidate.scoreDanmaku,
        scoreInteraction: candidate.scoreInteraction,
        scoreKeyword: candidate.scoreKeyword,
        scoreEnergy: candidate.scoreEnergy,
        finalScore: candidate.finalScore,
        llmScore: candidate.llmResult?.confidence ?? null,
        llmCategory: candidate.llmResult?.category ?? null,
        llmConfidence: candidate.llmResult?.confidence ?? null,
        llmWorth: candidate.llmResult?.worth ? 1 : 0,
        llmRisk: candidate.llmResult?.risk ?? null,
        aiHighlight: candidate.aiHighlight,
        aiTitle: candidate.aiTitle,
        aiReason: candidate.aiReason,
        aiHighlight2: candidate.aiHighlight,
        suggestedTrimStart: candidate.suggestedTrimStart,
        suggestedTrimEnd: candidate.suggestedTrimEnd,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  eventBus.publish("candidates.generated", {
    sessionId,
    count: dedupedCandidates.length,
    topCandidates: dedupedCandidates.slice(0, 5).map((c) => ({
      startTime: c.startTime,
      endTime: c.endTime,
      score: c.finalScore,
      title: c.aiTitle,
    })),
  });

  return dedupedCandidates.length;
}

function findSegmentForWindow(
  sessionId: number,
  windowStart: number,
  windowEnd: number
): number | null {
  const db = getDb();
  const segments = rows<{ id: number; start_offset: number; duration: number | null }>(
    db.prepare(
      `SELECT id, start_offset, duration FROM segments
       WHERE session_id = ?
       ORDER BY start_offset ASC`
    ),
    sessionId
  );

  const windowCenter = (windowStart + windowEnd) / 2;

  for (const seg of segments) {
    const segStart = seg.start_offset;
    const segEnd = segStart + (seg.duration ?? 1800);

    if (windowCenter >= segStart && windowCenter < segEnd) {
      return seg.id;
    }
  }

  return segments[0]?.id ?? null;
}

function deduplicateCandidates(
  candidates: GeneratedCandidate[]
): GeneratedCandidate[] {
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => b.finalScore - a.finalScore);

  const result: GeneratedCandidate[] = [];
  const used = new Set<string>();

  for (const candidate of sorted) {
    const key = `${candidate.startTime}-${candidate.endTime}`;
    if (used.has(key)) continue;

    let hasOverlap = false;
    for (const existing of result) {
      const overlap = calculateOverlap(
        candidate.startTime,
        candidate.endTime,
        existing.startTime,
        existing.endTime
      );
      if (overlap > 0.5) {
        hasOverlap = true;
        break;
      }
    }

    if (!hasOverlap) {
      result.push(candidate);
      used.add(key);
    }
  }

  return result.slice(0, 20);
}

function calculateOverlap(
  start1: number,
  end1: number,
  start2: number,
  end2: number
): number {
  const overlapStart = Math.max(start1, start2);
  const overlapEnd = Math.min(end1, end2);

  if (overlapStart >= overlapEnd) return 0;

  const overlapDuration = overlapEnd - overlapStart;
  const duration1 = end1 - start1;
  const duration2 = end2 - start2;
  const minDuration = Math.min(duration1, duration2);

  return overlapDuration / minDuration;
}

export function isSessionReadyForAnalysis(sessionId: number): boolean {
  const db = getDb();
  const result = row<{ pending: number }>(
    db.prepare(
      `SELECT COUNT(*) AS pending FROM segments
       WHERE session_id = ? AND status IN ('pending', 'transcribing')`
    ),
    sessionId
  );

  return (result?.pending ?? 1) === 0;
}

export async function tryGenerateCandidates(sessionId: number): Promise<number | null> {
  if (!isSessionReadyForAnalysis(sessionId)) {
    return null;
  }

  const existing = row<{ count: number }>(
    getDb().prepare("SELECT COUNT(*) AS count FROM candidates WHERE session_id = ?"),
    sessionId
  );

  if (existing && existing.count > 0) {
    console.log(`Session ${sessionId} already has ${existing.count} candidates`);
    return existing.count;
  }

  return generateCandidates(sessionId);
}
