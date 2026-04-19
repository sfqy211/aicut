import { getDb, row, rows } from "../../db/index.js";

export interface SessionStats {
  sessionId: number;
  duration: number;

  danmaku: {
    total: number;
    densityPerMin: number;
    distribution: number[];
    p50: number;
    p75: number;
    p90: number;
  };

  interaction: {
    totalSc: number;
    totalGift: number;
    total: number;
    distribution: number[];
    p75: number;
    p90: number;
    p95: number;
  };

  energy: {
    distribution: number[];
    p75: number;
    p90: number;
  };
}

export interface DanmakuBucket {
  segmentId: number;
  timestampMs: number;
  eventType: string;
  price: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

// 计算百分位数
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (upper >= sorted.length) return sorted[sorted.length - 1] ?? 0;
  const lowerVal = sorted[lower] ?? 0;
  const upperVal = sorted[upper] ?? 0;
  return lowerVal * (1 - weight) + upperVal * weight;
}

// 计算整场直播统计
export function computeSessionStats(sessionId: number): SessionStats {
  const db = getDb();

  // 获取 session 总时长
  const session = row<{ total_duration: number | null }>(
    db.prepare("SELECT total_duration FROM sessions WHERE id = ?"),
    sessionId
  );
  const duration = session?.total_duration ?? 0;

  // 获取所有弹幕事件
  const danmakuEvents = rows<DanmakuBucket>(
    db.prepare(
      `SELECT de.segment_id, de.timestamp_ms, de.event_type, de.price
       FROM danmaku_events de
       JOIN segments s ON s.id = de.segment_id
       WHERE s.session_id = ? AND de.event_type IN ('danmaku', 'super_chat', 'gift', 'guard')
       ORDER BY de.timestamp_ms ASC`
    ),
    sessionId
  );

  // 计算弹幕密度分布（按 30s 窗口）
  const windowSize = 30000; // 30 秒，单位毫秒
  const totalWindows = Math.max(1, Math.ceil((duration * 1000) / windowSize));
  const danmakuCounts = new Array(totalWindows).fill(0);
  const priceCounts = new Array(totalWindows).fill(0);

  let totalDanmaku = 0;
  let totalSc = 0;
  let totalGift = 0;

  for (const event of danmakuEvents) {
    const windowIndex = Math.min(
      Math.floor(event.timestampMs / windowSize),
      totalWindows - 1
    );

    if (event.eventType === "danmaku") {
      danmakuCounts[windowIndex]++;
      totalDanmaku++;
    } else if (event.eventType === "super_chat") {
      priceCounts[windowIndex] += event.price;
      totalSc += event.price;
    } else if (event.eventType === "gift" || event.eventType === "guard") {
      priceCounts[windowIndex] += event.price;
      totalGift += event.price;
    }
  }

  // 排序并计算百分位
  const sortedDanmaku = [...danmakuCounts].sort((a, b) => a - b);
  const sortedPrice = [...priceCounts].sort((a, b) => a - b);

  // 获取转写 segments 计算能量分布
  const transcripts = rows<{ segments_json: string | null }>(
    db.prepare(
      `SELECT segments_json FROM transcripts t
       JOIN segments s ON s.id = t.segment_id
       WHERE s.session_id = ? AND t.segments_json IS NOT NULL`
    ),
    sessionId
  );

  const energyDistribution: number[] = [];
  for (const t of transcripts) {
    if (!t.segments_json) continue;
    try {
      const segments = JSON.parse(t.segments_json) as TranscriptSegment[];
      for (let i = 1; i < segments.length; i++) {
        const prev = segments[i - 1];
        const curr = segments[i];
        if (prev && curr) {
          const duration = curr.start - prev.start;
          const wordCount = curr.text?.length ?? 0;
          if (duration > 0) {
            energyDistribution.push(wordCount / duration); // 字/秒
          }
        }
      }
    } catch {
      // 忽略解析错误
    }
  }

  const sortedEnergy = [...energyDistribution].sort((a, b) => a - b);

  const stats: SessionStats = {
    sessionId,
    duration,
    danmaku: {
      total: totalDanmaku,
      densityPerMin: duration > 0 ? (totalDanmaku / duration) * 60 : 0,
      distribution: danmakuCounts,
      p50: percentile(sortedDanmaku, 50),
      p75: percentile(sortedDanmaku, 75),
      p90: percentile(sortedDanmaku, 90),
    },
    interaction: {
      totalSc,
      totalGift,
      total: totalSc + totalGift,
      distribution: priceCounts,
      p75: percentile(sortedPrice, 75),
      p90: percentile(sortedPrice, 90),
      p95: percentile(sortedPrice, 95),
    },
    energy: {
      distribution: energyDistribution,
      p75: percentile(sortedEnergy, 75),
      p90: percentile(sortedEnergy, 90),
    },
  };

  // 缓存到数据库
  cacheStats(sessionId, stats);

  return stats;
}

// 从缓存读取统计
export function getCachedStats(sessionId: number): SessionStats | null {
  const db = getDb();
  const cached = row<{
    danmaku_total: number;
    danmaku_p50: number | null;
    danmaku_p75: number | null;
    danmaku_p90: number | null;
    interaction_total: number;
    interaction_p75: number | null;
    interaction_p90: number | null;
    interaction_p95: number | null;
    energy_p75: number | null;
    energy_p90: number | null;
  }>(
    db.prepare("SELECT * FROM session_stats WHERE session_id = ?"),
    sessionId
  );

  if (!cached) return null;

  return {
    sessionId,
    duration: 0, // 需要重新查询
    danmaku: {
      total: cached.danmaku_total,
      densityPerMin: 0,
      distribution: [],
      p50: cached.danmaku_p50 ?? 0,
      p75: cached.danmaku_p75 ?? 0,
      p90: cached.danmaku_p90 ?? 0,
    },
    interaction: {
      totalSc: 0,
      totalGift: 0,
      total: cached.interaction_total,
      distribution: [],
      p75: cached.interaction_p75 ?? 0,
      p90: cached.interaction_p90 ?? 0,
      p95: cached.interaction_p95 ?? 0,
    },
    energy: {
      distribution: [],
      p75: cached.energy_p75 ?? 0,
      p90: cached.energy_p90 ?? 0,
    },
  };
}

// 缓存统计到数据库
function cacheStats(sessionId: number, stats: SessionStats) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO session_stats (
      session_id, danmaku_total, danmaku_p50, danmaku_p75, danmaku_p90,
      interaction_total, interaction_p75, interaction_p90, interaction_p95,
      energy_p75, energy_p90, computed_at
    ) VALUES (
      @sessionId, @danmakuTotal, @danmakuP50, @danmakuP75, @danmakuP90,
      @interactionTotal, @interactionP75, @interactionP90, @interactionP95,
      @energyP75, @energyP90, unixepoch()
    )`
  ).run({
    sessionId,
    danmakuTotal: stats.danmaku.total,
    danmakuP50: stats.danmaku.p50,
    danmakuP75: stats.danmaku.p75,
    danmakuP90: stats.danmaku.p90,
    interactionTotal: stats.interaction.total,
    interactionP75: stats.interaction.p75,
    interactionP90: stats.interaction.p90,
    interactionP95: stats.interaction.p95,
    energyP75: stats.energy.p75,
    energyP90: stats.energy.p90,
  });
}

// 获取窗口内的弹幕和付费数据
export function getWindowData(
  sessionId: number,
  startTimeMs: number,
  endTimeMs: number
): {
  danmakuCount: number;
  priceTotal: number;
  topDanmaku: string[];
  scMessages: string[];
  transcriptText: string;
} {
  const db = getDb();

  // 获取时间范围内的弹幕
  const events = rows<{
    event_type: string;
    text: string;
    price: number;
  }>(
    db.prepare(
      `SELECT event_type, text, price FROM danmaku_events de
       JOIN segments s ON s.id = de.segment_id
       WHERE s.session_id = ?
         AND de.timestamp_ms >= ?
         AND de.timestamp_ms < ?
       ORDER BY de.timestamp_ms ASC`
    ),
    [sessionId, startTimeMs, endTimeMs]
  );

  let danmakuCount = 0;
  let priceTotal = 0;
  const danmakuTexts: string[] = [];
  const scMessages: string[] = [];

  for (const e of events) {
    if (e.event_type === "danmaku") {
      danmakuCount++;
      if (e.text) danmakuTexts.push(e.text);
    } else if (e.event_type === "super_chat") {
      priceTotal += e.price;
      if (e.text) scMessages.push(e.text);
    } else if (e.event_type === "gift" || e.event_type === "guard") {
      priceTotal += e.price;
    }
  }

  // 统计高频弹幕
  const danmakuFreq = new Map<string, number>();
  for (const text of danmakuTexts) {
    const normalized = text.trim().slice(0, 20);
    if (normalized) {
      danmakuFreq.set(normalized, (danmakuFreq.get(normalized) ?? 0) + 1);
    }
  }
  const topDanmaku = [...danmakuFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text]) => text);

  // 获取窗口内的转写文本
  const transcripts = rows<{ full_text: string | null }>(
    db.prepare(
      `SELECT t.full_text FROM transcripts t
       JOIN segments s ON s.id = t.segment_id
       WHERE s.session_id = ? AND t.full_text IS NOT NULL`
    ),
    sessionId
  );

  const transcriptText = transcripts
    .map((t) => t.full_text ?? "")
    .join(" ")
    .slice(0, 500);

  return {
    danmakuCount,
    priceTotal,
    topDanmaku,
    scMessages: scMessages.slice(0, 10),
    transcriptText,
  };
}
