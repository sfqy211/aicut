import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, row } from "../../db/index.js";
import type { SessionStats } from "./stats.js";
import type { RuleScore, WindowData } from "./rules.js";
import { getKeywordMatches } from "./keywords.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

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
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout?: number;
}

export interface TaskLLMSettings {
  maxTokens: number;
  temperature: number;
  topP?: number;
  responseFormat?: string;
  description?: string;
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
    action?: string;
  }>;
  settings: {
    global: {
      timeout: number;
      maxConcurrency: number;
      strictMode?: boolean;
    };
    taskConfig: {
      scoring: TaskLLMSettings;
      titleGeneration?: TaskLLMSettings;
      summaryGeneration?: TaskLLMSettings;
      [key: string]: TaskLLMSettings | undefined;
    };
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
      global: {
        timeout: 30000,
        maxConcurrency: 3,
      },
      taskConfig: {
        scoring: {
          maxTokens: 500,
          temperature: 0.3,
        },
      },
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
  const apiFormat = row<{ value: string }>(
    db.prepare("SELECT value FROM settings WHERE key = 'llm_api_format'"),
    undefined
  )?.value;

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
    apiFormat: apiFormat === "anthropic" ? "anthropic" : "openai",
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    model: model ?? "gpt-4o-mini",
    timeout: loadPromptsConfig().settings.global.timeout,
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

  const keywordMatchDetails = getKeywordMatches(window.transcriptText);

  // 替换模板变量
  let userPrompt = template
    .replace(/\{\{streamerName\}\}/g, streamerName ?? "未知")
    .replace(/\{\{liveTitle\}\}/g, liveTitle ?? "未知")
    .replace(/\{\{startTime\}\}/g, formatTime(window.startTime))
    .replace(/\{\{endTime\}\}/g, formatTime(window.endTime))
    .replace(/\{\{duration\}\}/g, String(window.duration))
    .replace(/\{\{peakTime\}\}/g, window.peakTime ?? "无")
    .replace(/\{\{danmakuCount\}\}/g, String(window.danmakuCount))
    .replace(/\{\{danmakuDensity\}\}/g, danmakuDensity)
    .replace(/\{\{topDanmaku\}\}/g, window.topDanmaku.join("、") || "无")
    .replace(/\{\{keywordMatchDetails\}\}/g, keywordMatchDetails)
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

  const taskSettings = promptsConfig.settings.taskConfig.scoring;
  const endpoint = resolveLlmEndpoint(config);
  const headers = buildLlmHeaders(config);
  const body = JSON.stringify(buildLlmPayload(config, {
    system,
    user,
    model: config.model,
    temperature: taskSettings.temperature,
    maxTokens: taskSettings.maxTokens,
    responseFormat: taskSettings.responseFormat,
  }));

  // 重试机制：最多 3 次，指数退避
  const maxRetries = 3;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        config.timeout ?? promptsConfig.settings.global.timeout
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 可重试的状态码：429(限流)、500/502/503(服务端错误)
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}`;
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.warn(`[LLM] Retry ${attempt}/${maxRetries} after ${delay}ms (HTTP ${response.status})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        console.error(`[LLM] All ${maxRetries} retries failed: ${lastError}`);
        return null;
      }

      if (!response.ok) {
        console.error(`[LLM] API error: HTTP ${response.status}`);
        return null;
      }

      const data = await response.json();
      const content = extractLlmText(config, data);

      if (!content) {
        console.error("[LLM] Response missing content");
        return null;
      }

      return parseLlmResult(content);
    } catch (error) {
      if (error instanceof Error) {
        // AbortError = 超时，可重试
        if (error.name === "AbortError") {
          lastError = "timeout";
          if (attempt < maxRetries) {
            const delay = 1000 * attempt;
            console.warn(`[LLM] Retry ${attempt}/${maxRetries} after timeout`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }
        lastError = error.message;
      }
      if (attempt >= maxRetries) {
        console.error(`[LLM] All ${maxRetries} retries failed: ${lastError}`);
        return null;
      }
    }
  }

  return null;
}

// 提取并解析 LLM 返回的 JSON
function parseLlmResult(content: string): LLMResult | null {
  // 尝试 1：直接解析（如果 content 就是纯 JSON）
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && "worth" in parsed) {
      return normalizeLlmResult(parsed);
    }
  } catch { /* not pure JSON, continue */ }

  // 尝试 2：从 markdown 代码块中提取
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]!.trim());
      if (parsed && typeof parsed === "object" && "worth" in parsed) {
        return normalizeLlmResult(parsed);
      }
    } catch { /* invalid JSON in code block */ }
  }

  // 尝试 3：提取最外层 JSON 对象（处理前后有额外文本的情况）
  const braceMatch = extractJsonObject(content);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch);
      if (parsed && typeof parsed === "object" && "worth" in parsed) {
        return normalizeLlmResult(parsed);
      }
    } catch { /* invalid JSON */ }
  }

  console.error("[LLM] Failed to extract JSON from response");
  return null;
}

// 从文本中提取最外层 {} 对象（正确处理嵌套括号）
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// 规范化 LLM 返回结果
function normalizeLlmResult(parsed: Record<string, unknown>): LLMResult {
  return {
    worth: Boolean(parsed.worth),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
    category: String(parsed.category ?? "其他"),
    highlight: String(parsed.highlight ?? "").slice(0, 30),
    title: String(parsed.title ?? "").slice(0, 50),
    reason: String(parsed.reason ?? "").slice(0, 100),
    risk: parsed.risk ? String(parsed.risk) : null,
    suggestedAdjustment: {
      trimStart: Number((parsed.suggestedAdjustment as Record<string, unknown>)?.trimStart ?? 0),
      trimEnd: Number((parsed.suggestedAdjustment as Record<string, unknown>)?.trimEnd ?? 0),
    },
  };
}

function resolveLlmEndpoint(config: LLMConfig): string {
  if (config.apiFormat === "anthropic") {
    if (config.baseUrl.endsWith("/messages")) return config.baseUrl;
    if (config.baseUrl.endsWith("/v1")) return `${config.baseUrl}/messages`;
    return `${config.baseUrl}/v1/messages`;
  }

  // OpenAI 格式
  if (config.baseUrl.endsWith("/chat/completions")) return config.baseUrl;
  if (config.baseUrl.endsWith("/v1")) return `${config.baseUrl}/chat/completions`;
  // 兜底：假设 baseUrl 是域名根，追加 /v1/chat/completions
  return `${config.baseUrl}/v1/chat/completions`;
}

function buildLlmHeaders(config: LLMConfig): Record<string, string> {
  if (config.apiFormat === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

function buildLlmPayload(
  config: LLMConfig,
  input: {
    system: string;
    user: string;
    model: string;
    temperature: number;
    maxTokens: number;
    responseFormat?: string;
  }
) {
  if (config.apiFormat === "anthropic") {
    return {
      model: input.model,
      system: input.system,
      max_tokens: input.maxTokens,
      temperature: clampTemperature(input.temperature),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.user,
            },
          ],
        },
      ],
    };
  }

  // OpenAI 标准格式
  const payload: Record<string, unknown> = {
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    temperature: clampTemperature(input.temperature),
    max_tokens: input.maxTokens,
  };

  // 支持 json_object 响应格式（强制 JSON 输出）
  if (input.responseFormat === "json_object") {
    payload.response_format = { type: "json_object" };
  }

  return payload;
}

function extractLlmText(config: LLMConfig, data: any): string | null {
  if (config.apiFormat === "anthropic") {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks
      .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
      .map((block: any) => block.text)
      .join("\n")
      .trim() || null;
  }

  return data?.choices?.[0]?.message?.content ?? null;
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(1, value);
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
