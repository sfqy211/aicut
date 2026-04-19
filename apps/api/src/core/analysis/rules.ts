import { countKeywords } from "./keywords.js";
import type { SessionStats } from "./stats.js";

export interface WindowData {
  startTime: number; // 秒
  endTime: number; // 秒
  duration: number; // 秒
  danmakuCount: number;
  priceTotal: number; // 分
  topDanmaku: string[];
  scMessages: string[];
  transcriptText: string;
  energyPeak: number; // 语速峰值
}

export interface RuleScore {
  total: number;
  danmaku: number;
  interaction: number;
  keyword: number;
  energy: number;
}

// Sigmoid 函数：平滑映射到 0-1
// x=0 时返回 0.5，x>0 快速趋近 1，x<0 趋近 0
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// 计算规则评分
export function calculateRuleScore(
  window: WindowData,
  stats: SessionStats
): RuleScore {
  // 1. 弹幕密度分 (40分) - 阈值 = P75
  const danmakuThreshold = Math.max(1, stats.danmaku.p75);
  const danmakuScore =
    40 * sigmoid((window.danmakuCount / danmakuThreshold - 1) * 2);

  // 2. 付费互动分 (30分) - 阈值 = P90
  const interactionThreshold = Math.max(100, stats.interaction.p90); // 至少 1 元
  const interactionScore =
    30 * sigmoid((window.priceTotal / interactionThreshold - 1) * 2);

  // 3. 关键词分 (20分) - 固定规则
  const keywordResult = countKeywords(window.transcriptText);
  const keywordScore = Math.min(
    20,
    Math.max(0, keywordResult.positive * 5 - keywordResult.negative * 10)
  );

  // 4. 声音能量分 (10分) - 阈值 = P90
  const energyThreshold = Math.max(1, stats.energy.p90);
  const energyScore =
    10 * sigmoid((window.energyPeak / energyThreshold - 1) * 2);

  const total = danmakuScore + interactionScore + keywordScore + energyScore;

  return {
    total: Math.round(total * 100) / 100,
    danmaku: Math.round(danmakuScore * 100) / 100,
    interaction: Math.round(interactionScore * 100) / 100,
    keyword: Math.round(keywordScore * 100) / 100,
    energy: Math.round(energyScore * 100) / 100,
  };
}

// 判断是否需要 LLM 二次评分
export function shouldCallLLM(
  ruleScore: RuleScore,
  stats: SessionStats
): boolean {
  // 条件 1：规则总分 >= 60
  if (ruleScore.total >= 60) return true;

  // 条件 2：单维度 >= 该维度满分的 80%
  if (ruleScore.danmaku >= 40 * 0.8) return true;
  if (ruleScore.interaction >= 30 * 0.8) return true;

  // 条件 3：付费金额 >= P95（极端高价值片段）
  const p95Price = stats.interaction.p95;
  // 这个条件需要在调用时检查，这里只返回维度条件

  return false;
}

// 检查是否满足 P95 付费条件
export function isHighValue(priceTotal: number, stats: SessionStats): boolean {
  const p95 = stats.interaction.p95;
  return p95 > 0 && priceTotal >= p95;
}

// 生成滑动窗口
export function generateWindows(
  duration: number,
  options: {
    minDuration?: number;
    maxDuration?: number;
    step?: number;
  } = {}
): Array<{ start: number; end: number; duration: number }> {
  const minDuration = options.minDuration ?? 45;
  const maxDuration = options.maxDuration ?? 120;
  const step = options.step ?? 15;

  const windows: Array<{ start: number; end: number; duration: number }> = [];

  // 从不同窗口大小生成
  for (let windowSize = minDuration; windowSize <= maxDuration; windowSize += 15) {
    for (let start = 0; start + windowSize <= duration; start += step) {
      windows.push({
        start,
        end: start + windowSize,
        duration: windowSize,
      });
    }
  }

  return windows;
}
