import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, row } from "../../db/index.js";
import type { SessionStats } from "./stats.js";
import type { RuleScore, WindowData } from "./rules.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

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

export interface PromptsConfig {
  version: string;
  description: string;
  systemPrompts: {
    scoring: { role: string; content: string };
    [key: string]: { role: string; content: string };
  };
  userPrompts: {
    scoring: {
      template: string;
      variables: string[];
    };
    [key: string]: {
      template: string;
      variables: string[];
    };
  };
  categories: Record<string, { emoji: string; description: string }>;
  riskKeywords: Array<{
    keyword: string;
    level: string;
    description: string;
  }>;
  settings: {
    maxTokens: number;
    temperature: number;
    timeout: number;
    maxConcurrency: number;
  };
}

let cachedPrompts: PromptsConfig | null = null;

// 加载提示词配置
export function loadPromptsConfig(): PromptsConfig {
  if (cachedPrompts) return cachedPrompts;

  const configPath = path.join(repoRoot, "config/prompts.json");

  if (!fs.existsSync(configPath)) {
    console.warn(`Prompts config not found at ${configPath}, using defaults`);
    return getDefaultPrompts();
  }

  try {
    const content = fs.readFileSync(configPath, "utf8");
    cachedPrompts = JSON.parse(content) as PromptsConfig;
    return cachedPrompts;
  } catch (error) {
    console.error(`Failed to load prompts config: ${error}`);
    return getDefaultPrompts();
  }
}

// 默认提示词
function getDefaultPrompts(): PromptsConfig {
  return {
    version: "0.0.0",
    description: "Default prompts",
    systemPrompts: {
      scoring: {
        role: "system",
        content: "你是一个专业的直播切片分析助手。请严格按照 JSON 格式输出。",
      },
    },
    userPrompts: {
      scoring: {
        template: "请分析这个直播片段是否值得剪辑。",
        variables: [],
      },
    },
    categories: {
      高能: { emoji: "🔥", description: "" },
      搞笑: { emoji: "😂", description: "" },
    },
    riskKeywords: [],
    settings: {
      maxTokens: 500,
      temperature: 0.3,
      timeout: 30000,
      maxConcurrency: 3,
    },
  };
}

// 重新加载配置
export function reloadPromptsConfig(): void {
  cachedPrompts = null;
  loadPromptsConfig();
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
    timeout: loadPromptsConfig().settings.timeout,
  };
}

// 格式化时间
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 构建提示词
function buildPrompt(
  window: WindowData,
  ruleScore: RuleScore,
  stats: SessionStats,
  streamerName?: string,
  liveTitle?: string
): { system: string; user: string } {
  const config = loadPromptsConfig();
  const template = config.userPrompts.scoring.template;

  const danmakuDensity = stats.danmaku.densityPerMin > 0
    ? (window.danmakuCount / stats.danmaku.densityPerMin * window.duration / 60).toFixed(1)
    : "1.0";

  // 替换模板变量
  let userPrompt = template
    .replace(/\{\{streamerName\}\}/g, streamerName ?? "未知")
    .replace(/\{\{liveTitle\}\}/g, liveTitle ?? "未知")
    .replace(/\{\{startTime\}\}/g, formatTime(window.startTime))
    .replace(/\{\{endTime\}\}/g, formatTime(window.endTime))
    .replace(/\{\{duration\}\}/g, String(window.duration))
    .replace(/\{\{danmakuCount\}\}/g, String(window.danmakuCount))
    .replace(/\{\{danmakuDensity\}\}/g, danmakuDensity)
    .replace(/\{\{topDanmaku\}\}/g, window.topDanmaku.join("、") || "无")
    .replace(/\{\{scTotal\}\}/g, (window.priceTotal / 100).toFixed(2))
    .replace(/\{\{scMessages\}\}/g, window.scMessages.slice(0, 5).join("、") || "无")
    .replace(/\{\{transcriptText\}\}/g, window.transcriptText || "无")
    .replace(/\{\{ruleScoreTotal\}\}/g, ruleScore.total.toFixed(1))
    .replace(/\{\{ruleScoreDanmaku\}\}/g, ruleScore.danmaku.toFixed(1))
    .replace(/\{\{ruleScoreInteraction\}\}/g, ruleScore.interaction.toFixed(1))
    .replace(/\{\{ruleScoreKeyword\}\}/g, ruleScore.keyword.toFixed(1))
    .replace(/\{\{ruleScoreEnergy\}\}/g, ruleScore.energy.toFixed(1));

  return {
    system: config.systemPrompts.scoring.content,
    user: userPrompt,
  };
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

  const promptsConfig = loadPromptsConfig();
  const { system, user } = buildPrompt(
    window,
    ruleScore,
    stats,
    metadata?.streamerName,
    metadata?.liveTitle
  );

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      config.timeout ?? promptsConfig.settings.timeout
    );

    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: promptsConfig.settings.temperature,
        max_tokens: promptsConfig.settings.maxTokens,
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
    return ruleScore.total;
  }

  if (!llmResult.worth) {
    return ruleScore.total * 0.5;
  }

  const llmBoost = llmResult.confidence * 20;
  const adjustedScore = ruleScore.total + llmBoost;
  const riskPenalty = llmResult.risk ? 15 : 0;

  return Math.min(100, Math.max(0, adjustedScore - riskPenalty));
}

// 获取配置（供 API 使用）
export function getPromptsConfig() {
  return loadPromptsConfig();
}
