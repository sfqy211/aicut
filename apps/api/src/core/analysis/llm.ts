import { getDb, row } from "../../db/index.js";
import type { SessionStats } from "./stats.js";
import type { RuleScore, WindowData } from "./rules.js";

export interface LLMResult {
  worth: boolean;
  confidence: number;
  category: string;
  highlight: string;
  title: string;
  reason: string;
  risk: string | null;
  suggestedAdjustment: {
    trimStart: number;
    trimEnd: number;
  };
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout?: number;
}

// 获取 LLM 配置
export function getLLMConfig(): LLMConfig | null {
  const db = getDb();
  const baseUrl = row<{ value: string }>(
    db.prepare("SELECT value FROM settings WHERE key = 'llm_base_url'"),
    undefined
  )?.value;

  const apiKey = row<{ value: string }>(
    db.prepare("SELECT value FROM settings WHERE key = 'llm_api_key'"),
    undefined
  )?.value;

  const model = row<{ value: string }>(
    db.prepare("SELECT value FROM settings WHERE key = 'llm_model'"),
    undefined
  )?.value;

  if (!baseUrl || !apiKey) return null;

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    model: model ?? "gpt-4o-mini",
    timeout: 30000,
  };
}

// 构建 LLM prompt
function buildPrompt(
  window: WindowData,
  ruleScore: RuleScore,
  stats: SessionStats,
  streamerName?: string,
  liveTitle?: string
): string {
  const danmakuDensity = stats.danmaku.densityPerMin > 0
    ? (window.danmakuCount / stats.danmaku.densityPerMin * window.duration / 60).toFixed(1)
    : "1.0";

  return `你是一个直播切片专家，负责判断一个直播片段是否值得剪辑成短视频。

## 直播信息
- 主播：${streamerName ?? "未知"}
- 标题：${liveTitle ?? "未知"}

## 片段信息
- 时间：${formatTime(window.startTime)} - ${formatTime(window.endTime)}（${window.duration}秒）
- 弹幕数：${window.danmakuCount} 条（是平均值的 ${danmakuDensity} 倍）
- 高频弹幕：${window.topDanmaku.join("、") || "无"}
- SC 金额：${(window.priceTotal / 100).toFixed(2)} 元
- SC 内容：${window.scMessages.slice(0, 5).join("、") || "无"}
- 转写文本：${window.transcriptText || "无"}

## 规则评分
- 总分：${ruleScore.total.toFixed(1)} / 100
- 弹幕分：${ruleScore.danmaku.toFixed(1)} / 40
- 互动分：${ruleScore.interaction.toFixed(1)} / 30
- 关键词分：${ruleScore.keyword.toFixed(1)} / 20
- 能量分：${ruleScore.energy.toFixed(1)} / 10

## 任务
请判断这个片段是否值得剪辑，并给出你的分析。

## 输出格式（JSON）
{
  "worth": boolean,
  "confidence": number,
  "category": string,
  "highlight": string,
  "title": string,
  "reason": string,
  "risk": string | null,
  "suggestedAdjustment": { "trimStart": number, "trimEnd": number }
}

字段说明：
- worth: 是否值得切
- confidence: 置信度 0-1
- category: 分类（高能/搞笑/感人/整活/技术/聊天/其他）
- highlight: 核心看点（一句话，20字内）
- title: 推荐标题（带emoji，30字内）
- reason: 推荐理由（50字内）
- risk: 风险提示（如：争议言论、敏感词），无则为 null
- suggestedAdjustment: 建议的时间调整（秒）`;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 调用 LLM API
export async function scoreWithLLM(
  window: WindowData,
  ruleScore: RuleScore,
  stats: SessionStats,
  metadata?: { streamerName?: string; liveTitle?: string }
): Promise<LLMResult | null> {
  const config = getLLMConfig();
  if (!config) {
    console.warn("LLM not configured, skipping LLM scoring");
    return null;
  }

  const prompt = buildPrompt(
    window,
    ruleScore,
    stats,
    metadata?.streamerName,
    metadata?.liveTitle
  );

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout ?? 30000);

    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: "你是一个专业的直播切片分析助手。请严格按照 JSON 格式输出，不要添加任何额外文字。",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`LLM API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error("LLM response missing content");
      return null;
    }

    // 解析 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("LLM response missing JSON");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      worth: Boolean(parsed.worth),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
      category: String(parsed.category ?? "其他"),
      highlight: String(parsed.highlight ?? "").slice(0, 30),
      title: String(parsed.title ?? "").slice(0, 50),
      reason: String(parsed.reason ?? "").slice(0, 100),
      risk: parsed.risk ? String(parsed.risk) : null,
      suggestedAdjustment: {
        trimStart: Number(parsed.suggestedAdjustment?.trimStart ?? 0),
        trimEnd: Number(parsed.suggestedAdjustment?.trimEnd ?? 0),
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`LLM scoring error: ${error.message}`);
    }
    return null;
  }
}

// 计算最终评分
export function calculateFinalScore(
  ruleScore: RuleScore,
  llmResult: LLMResult | null
): number {
  if (!llmResult) {
    // 未触发 LLM，使用规则分
    return ruleScore.total;
  }

  if (!llmResult.worth) {
    // LLM 判断不值得，降权
    return ruleScore.total * 0.5;
  }

  // LLM 确认值得，加权
  const llmBoost = llmResult.confidence * 20; // 最多加 20 分
  const adjustedScore = ruleScore.total + llmBoost;

  // 风险惩罚
  const riskPenalty = llmResult.risk ? 15 : 0;

  return Math.min(100, Math.max(0, adjustedScore - riskPenalty));
}
