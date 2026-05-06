import { getDb, row } from "../../db/index.js";
import { getLlmApiKey, getLlmBaseUrl, getLlmModel, getLlmApiFormat } from "../../db/dbSettings.js";

// ── 类型 ──

export interface LLMConfig {
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout?: number;
}

// ── 配置读取 ──

export function getLLMConfig(): LLMConfig | null {
  const apiKey = getLlmApiKey();
  const baseUrl = getLlmBaseUrl();
  if (!apiKey || !baseUrl) return null;

  return {
    apiFormat: getLlmApiFormat(),
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    model: getLlmModel(),
    timeout: 30000,
  };
}

// ── 描述请求 ──

interface WindowDataForLLM {
  transcriptText: string;
  danmakuLines: string[];
  scLines: string[];
}

const SYSTEM_PROMPT = `你是直播内容分析助手。根据提供的字幕和弹幕数据，用简洁的中文描述这段时间内发生了什么。

要求：
1. 只描述事实，不做价值判断
2. 区分字幕内容和弹幕/SC内容
3. 如果有明显的高潮、转折、互动，简要标注
4. 控制在 100 字以内`;

function buildUserPrompt(data: WindowDataForLLM): string {
  const parts: string[] = [];

  if (data.transcriptText) {
    parts.push(`【字幕文本】\n${data.transcriptText}`);
  } else {
    parts.push("【字幕文本】\n（无字幕）");
  }

  if (data.danmakuLines.length > 0) {
    const display = data.danmakuLines.length > 30
      ? [...data.danmakuLines.slice(0, 15), `...（共${data.danmakuLines.length}条）...`, ...data.danmakuLines.slice(-15)]
      : data.danmakuLines;
    parts.push(`【弹幕】\n${display.join("\n")}`);
  } else {
    parts.push("【弹幕】\n（无弹幕）");
  }

  if (data.scLines.length > 0) {
    parts.push(`【SC / 醒目留言】\n${data.scLines.join("\n")}`);
  }

  return parts.join("\n\n");
}

/**
 * 调用 LLM 描述窗口内容。返回描述文本，失败返回 null。
 */
export async function describeWithLLM(data: WindowDataForLLM): Promise<string | null> {
  const config = getLLMConfig();
  if (!config) {
    console.warn("[LLM] Not configured, skipping description");
    return null;
  }

  const endpoint = resolveEndpoint(config);
  const headers = buildHeaders(config);
  const body = JSON.stringify(buildPayload(config, {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(data),
  }));

  // 重试逻辑
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout ?? 30000);

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.error(`[LLM] HTTP ${response.status}`);
        return null;
      }

      const result = await response.json();
      const text = extractText(config, result);
      return text?.trim() || null;
    } catch (err) {
      if (attempt >= 3) {
        console.error("[LLM] All retries failed:", err instanceof Error ? err.message : err);
        return null;
      }
    }
  }

  return null;
}

// ── HTTP 工具函数 ──

function resolveEndpoint(config: LLMConfig): string {
  if (config.apiFormat === "anthropic") {
    if (config.baseUrl.endsWith("/messages")) return config.baseUrl;
    if (config.baseUrl.endsWith("/v1")) return `${config.baseUrl}/messages`;
    return `${config.baseUrl}/v1/messages`;
  }
  if (config.baseUrl.endsWith("/chat/completions")) return config.baseUrl;
  if (config.baseUrl.endsWith("/v1")) return `${config.baseUrl}/chat/completions`;
  return `${config.baseUrl}/v1/chat/completions`;
}

function buildHeaders(config: LLMConfig): Record<string, string> {
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

function buildPayload(config: LLMConfig, input: { system: string; user: string }) {
  if (config.apiFormat === "anthropic") {
    return {
      model: config.model,
      system: input.system,
      max_tokens: 300,
      temperature: 0.3,
      messages: [{ role: "user", content: input.user }],
    };
  }
  return {
    model: config.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    max_tokens: 300,
    temperature: 0.3,
  };
}

function extractText(config: LLMConfig, data: Record<string, unknown>): string | null {
  if (config.apiFormat === "anthropic") {
    const blocks = Array.isArray(data?.content) ? data.content as Array<{ type: string; text: string }> : [];
    return blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() || null;
  }
  return (data?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? null;
}
