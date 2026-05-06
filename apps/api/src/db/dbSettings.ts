import { getDb, row } from "./index.js";

// ── DB Settings 读取 ──
// 所有 API Key / Secret 统一存入 settings 表，按 key 读取。
// 运行时缓存，调用 refresh() 可重新加载。

const cache = new Map<string, string>();

function readSetting(key: string): string {
  // 先查缓存
  if (cache.has(key)) return cache.get(key)!;
  // 再查 DB
  const db = getDb();
  const val = row<{ value: string }>(
    db.prepare("SELECT value FROM settings WHERE key = ?"),
    key
  )?.value ?? "";
  cache.set(key, val);
  return val;
}

// ── 公共 API ──

/** 火山引擎 ASR API Key */
export function getAsrApiKey(): string {
  return readSetting("asr_api_key");
}

/** 火山引擎 ASR Resource ID */
export function getAsrResourceId(): string {
  return readSetting("asr_resource_id") || "volc.seedasr.sauc.duration";
}

/** B站 Cookie（active account，优先级低于 source 级别的 cookie） */
export function getBilibiliCookie(): string {
  const db = getDb();
  const account = row<{ cookie: string }>(
    db.prepare("SELECT cookie FROM bilibili_accounts WHERE is_active = 1 LIMIT 1")
  );
  return account?.cookie ?? "";
}

/** LLM API Key */
export function getLlmApiKey(): string {
  return readSetting("llm_api_key");
}

/** LLM Base URL */
export function getLlmBaseUrl(): string {
  return readSetting("llm_base_url");
}

/** LLM Model */
export function getLlmModel(): string {
  return readSetting("llm_model") || "gpt-4o-mini";
}

/** LLM API Format */
export function getLlmApiFormat(): "openai" | "anthropic" {
  return readSetting("llm_api_format") === "anthropic" ? "anthropic" : "openai";
}

/** 写入设置 */
export function setSetting(key: string, value: string): void {
  const db = getDb();
  const timestamp = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, timestamp);
  cache.set(key, value);
}

/** 批量写入 */
export function setSettings(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    setSetting(key, value);
  }
}

/** 清除缓存（下次读取时从 DB 重新加载） */
export function refreshSettings(): void {
  cache.clear();
}
