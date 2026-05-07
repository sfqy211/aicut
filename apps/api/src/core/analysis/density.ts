/**
 * 弹幕密度峰值检测 — 移植自 bili-shadowreplay AppLive.svelte:86-244
 *
 * 算法：滑动窗口 + Z-score 阈值 + 局部极大值 +
 *       非极大值抑制 (NMS) + 动态边界扩展
 *
 * 复杂度：O(N)，N 为窗口内弹幕数
 * 典型耗时：5 分钟窗口 (500-5000 条弹幕) < 10ms
 */

export interface DensityPeak {
  /** 峰值窗口起始时间 (毫秒，相对输入数组的 min 时间戳) */
  startMs: number;
  /** 峰值窗口结束时间 (毫秒，相对) */
  endMs: number;
  /** 密度最高点时间 (毫秒，相对) */
  peakMs: number;
  /** 窗口内弹幕数 */
  count: number;
  /** Z-score = (count - mean) / stdDev */
  zScore: number;
}

interface DensityWindow {
  /** 窗口中心时间 (毫秒，相对) */
  centerMs: number;
  /** 窗口内弹幕数 */
  count: number;
}

interface Candidate {
  centerMs: number;
  count: number;
  index: number;
}

/**
 * 检测弹幕密度峰值。
 *
 * @param timestamps   绝对毫秒时间戳数组（已排序）
 * @param windowSec    滑动窗口大小 (秒)，默认 30
 * @param stepMs       滑动步长 (毫秒)，默认 5000
 * @param k            Z-score 倍数，默认 2.0 (对应 ~80% 阈值)
 * @param minDurationSec  最短候选片段 (秒)，默认 15
 * @param maxDurationSec  最长候选片段 (秒)，默认 180
 */
export function detectDanmakuPeaks(
  timestamps: number[],
  windowSec: number = 30,
  stepMs: number = 5000,
  k: number = 2.0,
  minDurationSec: number = 15,
  maxDurationSec: number = 180
): DensityPeak[] {
  // 太少的弹幕没有分析价值
  if (timestamps.length < 10) return [];

  const windowMs = windowSec * 1000;
  const minTs = timestamps[0]!;
  const maxTs = timestamps[timestamps.length - 1]!;
  const totalBuckets = Math.ceil((maxTs - minTs) / stepMs) + 1;

  // ── Step 1: 直方图 (O(N)) ──
  const histogram = new Array<number>(totalBuckets).fill(0);
  for (const ts of timestamps) {
    const idx = Math.floor((ts - minTs) / stepMs);
    if (idx >= 0 && idx < totalBuckets) {
      histogram[idx] = (histogram[idx] ?? 0) + 1;
    }
  }

  // ── Step 2: 滑动窗口密度 (O(B)) ──
  const windowBuckets = Math.ceil(windowMs / stepMs);
  if (windowBuckets > totalBuckets) return [];

  const density: DensityWindow[] = [];
  let windowSum = 0;
  for (let i = 0; i < Math.min(windowBuckets, totalBuckets); i++) {
    windowSum += histogram[i] ?? 0;
  }

  for (let i = 0; i <= totalBuckets - windowBuckets; i++) {
    const centerMs = (i + windowBuckets / 2) * stepMs;
    density.push({ centerMs, count: windowSum });

    // 滑动：去左加右
    windowSum -= histogram[i] ?? 0;
    if (i + windowBuckets < totalBuckets) {
      windowSum += histogram[i + windowBuckets] ?? 0;
    }
  }

  if (density.length === 0) return [];

  // ── Step 3: Z-score 阈值 ──
  const counts = density.map((d) => d.count);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance =
    counts.reduce((s, c) => s + (c - mean) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);

  const zThreshold = mean + k * stdDev;
  const absMin = Math.max(5, mean * 1.1);
  const effectiveThreshold = Math.max(zThreshold, absMin);
  const expansionBaseline = mean + 0.5 * stdDev;

  // ── Step 4: 局部极大值 ──
  const candidates: Candidate[] = [];
  for (let i = 1; i < density.length - 1; i++) {
    const curr = density[i];
    if (!curr) continue;
    const prev = density[i - 1];
    const next = density[i + 1];
    if (!prev || !next) continue;

    if (
      curr.count >= effectiveThreshold &&
      curr.count >= prev.count &&
      curr.count >= next.count
    ) {
      candidates.push({
        centerMs: curr.centerMs,
        count: curr.count,
        index: i,
      });
    }
  }

  // 按密度降序排列（最强的先处理）
  candidates.sort((a, b) => b.count - a.count);

  // ── Step 5: 动态边界扩展 + NMS ──
  const peaks: DensityPeak[] = [];

  for (const cand of candidates) {
    // NMS: 检查是否被已选峰值覆盖
    const isSuppressed = peaks.some(
      (p) => cand.centerMs >= p.startMs && cand.centerMs <= p.endMs
    );
    if (isSuppressed) continue;

    // 向左扩展
    let leftIdx = cand.index;
    while (
      leftIdx > 0 &&
      (density[leftIdx]?.count ?? 0) > expansionBaseline
    ) {
      leftIdx--;
    }

    // 向右扩展
    let rightIdx = cand.index;
    while (
      rightIdx < density.length - 1 &&
      (density[rightIdx]?.count ?? 0) > expansionBaseline
    ) {
      rightIdx++;
    }

    const leftD = density[leftIdx];
    const rightD = density[rightIdx];
    if (!leftD || !rightD) continue;

    let startMs = leftD.centerMs - stepMs;
    let endMs = rightD.centerMs + stepMs;

    // 边界约束
    startMs = Math.max(0, startMs);
    const totalDurationMs = maxTs - minTs;
    endMs = Math.min(totalDurationMs, endMs);

    // 时长约束
    let durationSec = (endMs - startMs) / 1000;
    if (durationSec < minDurationSec) {
      const pad = ((minDurationSec - durationSec) / 2) * 1000;
      startMs = Math.max(0, startMs - pad);
      endMs = Math.min(totalDurationMs, endMs + pad);
    } else if (durationSec > maxDurationSec) {
      const halfMax = (maxDurationSec / 2) * 1000;
      const peakCenter = cand.centerMs;
      startMs = Math.max(0, peakCenter - halfMax);
      endMs = Math.min(totalDurationMs, peakCenter + halfMax);
    }

    // Z-score
    const zScore =
      stdDev > 0
        ? Math.round(((cand.count - mean) / stdDev) * 100) / 100
        : 0;

    peaks.push({
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      peakMs: Math.round(cand.centerMs),
      count: cand.count,
      zScore,
    });
  }

  return peaks;
}
