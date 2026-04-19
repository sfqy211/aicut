import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row } from "../db/index.js";
import {
  getAllKeywords,
  getPromptsConfig,
  reloadKeywordsConfig,
  reloadPromptsConfig,
} from "../core/analysis/index.js";

const llmConfigInput = z.object({
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // 获取所有设置
  app.get("/settings", async () => {
    const db = getDb();
    const settings = db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key").all() as Array<{
      key: string;
      value: string;
      updated_at: number;
    }>;

    const result: Record<string, { value: string | null; updatedAt: number }> = {
      llm_base_url: { value: null, updatedAt: 0 },
      llm_api_key: { value: null, updatedAt: 0 },
      llm_model: { value: null, updatedAt: 0 },
    };

    for (const setting of settings) {
      // 不返回 API Key 的完整值
      if (setting.key === "llm_api_key") {
        result[setting.key] = {
          value: setting.value ? "******" : null,
          updatedAt: setting.updated_at,
        };
      } else if (result[setting.key]) {
        result[setting.key] = {
          value: setting.value,
          updatedAt: setting.updated_at,
        };
      }
    }

    return result;
  });

  // 更新 LLM 配置
  app.patch("/settings/llm", async (request) => {
    const input = llmConfigInput.parse(request.body);
    const db = getDb();

    const updates: string[] = [];
    const values: Record<string, string> = {};

    if (input.baseUrl !== undefined) {
      updates.push("llm_base_url = @baseUrl");
      values.baseUrl = input.baseUrl;
    }

    if (input.apiKey !== undefined) {
      updates.push("llm_api_key = @apiKey");
      values.apiKey = input.apiKey;
    }

    if (input.model !== undefined) {
      updates.push("llm_model = @model");
      values.model = input.model;
    }

    if (updates.length === 0) {
      return { updated: false };
    }

    // 使用 upsert
    const timestamp = Math.floor(Date.now() / 1000);

    for (const [key, val] of Object.entries(values)) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @timestamp)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @timestamp`
      ).run({ key: key === "baseUrl" ? "llm_base_url" : key === "apiKey" ? "llm_api_key" : "llm_model", value: val, timestamp });
    }

    return { updated: true, fields: Object.keys(values) };
  });

  // 获取关键词配置
  app.get("/settings/keywords", async () => {
    return getAllKeywords();
  });

  // 获取提示词配置
  app.get("/settings/prompts", async () => {
    const config = getPromptsConfig();
    // 不返回敏感信息
    return {
      version: config.version,
      description: config.description,
      categories: config.categories,
      riskKeywords: config.riskKeywords,
      settings: config.settings,
    };
  });

  // 重新加载配置（开发用）
  app.post("/settings/reload", async () => {
    reloadKeywordsConfig();
    reloadPromptsConfig();
    return { reloaded: true };
  });

  // 获取系统状态
  app.get("/settings/system", async () => {
    const db = getDb();

    const stats = {
      sources: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM sources")
      )?.count ?? 0,
      sessions: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM sessions")
      )?.count ?? 0,
      segments: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM segments")
      )?.count ?? 0,
      candidates: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM candidates")
      )?.count ?? 0,
      exports: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM exports")
      )?.count ?? 0,
      pendingCandidates: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE status = 'pending'")
      )?.count ?? 0,
      approvedCandidates: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE status = 'approved'")
      )?.count ?? 0,
    };

    return stats;
  });
};
