/**
 * 启发式评分 — 对密度峰值窗口打分，不依赖任何 LLM
 *
 * 五个信号加权：
 *   密度 Z-score (35%)  — 从 density.ts 传入
 *   重复度       (25%)  — 相同/近似文本占比 (弹幕跟风)
 *   情绪标点     (15%)  — 含 [？！?！]{2,} 的弹幕占比
 *   弹幕加速度   (15%)  — 密度一阶导数 (突增)
 *   SC 权重      (10%)  — 付费醒目留言金额
 */

import type { DensityPeak } from "./density.js";
import { normalizeDanmaku } from "./utils.js";

// ── 公共类型 ──

export interface DanmakuSample {
  text: string;
  price: number;
}

export interface WindowScore {
  /** 综合得分 (0-100) */
  total: number;
  /** 密度 Z-score 归一化分 */
  density: number;
  /** 重复度得分 */
  repeat: number;
  /** 情绪标点得分 */
  emotion: number;
  /** SC 权重得分 */
  scWeight: number;
  /** 弹幕加速度得分 */
  acceleration: number;
  /** 评级 */
  grade: "S" | "A" | "B" | "C";
}

// ── 公开 API ──

/**
 * 对密度峰值窗口做启发式评分。
 *
 * @param danmaku  该窗口内的弹幕采样列表
 * @param peak     密度峰值信息 (含 zScore, count)
 */
export function scorePeakWindow(
  danmaku: DanmakuSample[],
  peak: DensityPeak
): WindowScore {
  if (danmaku.length === 0) {
    return {
      total: 0,
      density: 0,
      repeat: 0,
      emotion: 0,
      scWeight: 0,
      acceleration: 0,
      grade: "C",
    };
  }

  // ── 1. 密度分 (Z-score → 0-100 归一化) ──
  const densityScore = Math.max(0, Math.min(100, 50 + peak.zScore * 10));

  // ── 2. 重复度 ──
  const textCounts = new Map<string, number>();
  for (const d of danmaku) {
    const norm = normalizeDanmaku(d.text || "");
    if (!norm) continue;
    textCounts.set(norm, (textCounts.get(norm) || 0) + 1);
  }
  let maxRepeat = 0;
  for (const v of textCounts.values()) {
    if (v > maxRepeat) maxRepeat = v;
  }
  const repeatRatio = maxRepeat / danmaku.length;
  const repeatScore = Math.min(100, repeatRatio * 200); // >50% 重复 → 满分

  // ── 3. 情绪标点 ──
  const emotionCount = danmaku.filter((d) =>
    /[？！?！]{2,}/.test(d.text || "")
  ).length;
  const emotionScore = Math.min(
    100,
    (emotionCount / danmaku.length) * 200
  );

  // ── 4. SC 权重 (对数归一化) ──
  const scTotal = danmaku.reduce((s, d) => s + (d.price || 0), 0);
  const scScore =
    scTotal > 0 ? Math.min(100, Math.log10(scTotal + 1) * 30) : 0;

  // ── 5. 弹幕加速度 (基于 zScore 偏离均值程度) ──
  const accelerationScore = Math.min(100, Math.max(0, 30 + peak.zScore * 15));

  // ── 加权计算 ──
  const total = Math.round(
    densityScore * 0.35 +
      repeatScore * 0.25 +
      emotionScore * 0.15 +
      accelerationScore * 0.15 +
      scScore * 0.1
  );

  const grade: WindowScore["grade"] =
    total >= 80 ? "S" : total >= 60 ? "A" : total >= 40 ? "B" : "C";

  return {
    total,
    density: Math.round(densityScore),
    repeat: Math.round(repeatScore),
    emotion: Math.round(emotionScore),
    scWeight: Math.round(scScore),
    acceleration: Math.round(accelerationScore),
    grade,
  };
}

/**
 * 从 LLM 描述文本中提取描述丰富度分数 (0-100)。
 * 基于描述长度、是否包含具体事件/情绪词。
 */
export function extractDescriptionRichness(description: string): number {
  if (!description || description.trim().length === 0) return 0;

  const len = description.length;
  let score = 0;

  // 长度分：30 字以下 → 可疑，100 字以上 → 充实
  if (len < 30) {
    score += 20;
  } else if (len > 80) {
    score += 40;
  } else {
    score += 30;
  }

  // 内容信号：包含具体事件描述
  const contentSignals = [
    "讨论", "介绍", "展示", "玩", "唱", "跳", "画",
    "观众", "弹幕", "互动", "话题", "操作", "技巧",
    "高潮", "转折", "亮点", "精彩", "争议", "共鸣",
  ];

  const matchCount = contentSignals.filter((s) => description.includes(s)).length;
  score += Math.min(40, matchCount * 10);

  return Math.min(100, score);
}
