import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import WebSocket from "ws";
import { getDb } from "../db/index.js";
import { setSettings, refreshSettings } from "../db/dbSettings.js";

const BIGMODEL_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

const asrConfigInput = z.object({
  apiKey: z.string().optional(),
  resourceId: z.string().optional(),
});

const cookieConfigInput = z.object({
  cookie: z.string().optional(),
});

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // 获取设置（简化版）
  app.get("/settings", async () => {
    const db = getDb();
    const settings = db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key").all() as Array<{
      key: string;
      value: string;
      updated_at: number;
    }>;

    const result: Record<string, { value: string | null; updatedAt: number }> = {
      llm_api_key: { value: null, updatedAt: 0 },
      llm_base_url: { value: null, updatedAt: 0 },
      llm_model: { value: null, updatedAt: 0 },
      asr_api_key: { value: null, updatedAt: 0 },
      asr_resource_id: { value: "volc.seedasr.sauc.duration", updatedAt: 0 },
      bilibili_cookie: { value: null, updatedAt: 0 },
    };

    for (const setting of settings) {
      if (
        setting.key === "llm_api_key" ||
        setting.key === "asr_api_key" ||
        setting.key === "bilibili_cookie"
      ) {
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

  // 保存 LLM 配置
  app.patch("/settings/llm", async (request) => {
    const input = z.object({
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
    }).parse(request.body);

    const entries: Record<string, string> = {};
    if (input.baseUrl !== undefined) entries.llm_base_url = input.baseUrl;
    if (input.apiKey !== undefined) entries.llm_api_key = input.apiKey;
    if (input.model !== undefined) entries.llm_model = input.model;

    if (Object.keys(entries).length === 0) return { updated: false };

    setSettings(entries);
    refreshSettings();
    return { updated: true, fields: Object.keys(entries) };
  });

  // 测试 LLM 连接
  app.post("/settings/llm/test", async () => {
    const db = getDb();
    const settings = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('llm_api_key', 'llm_base_url', 'llm_model', 'llm_api_format')"
    ).all() as Array<{ key: string; value: string }>;

    const configMap: Record<string, string> = {};
    for (const s of settings) {
      configMap[s.key] = s.value;
    }

    const apiKey = configMap.llm_api_key;
    const baseUrl = configMap.llm_base_url || "https://api.openai.com/v1";
    const model = configMap.llm_model || "gpt-4o-mini";
    const apiFormat = configMap.llm_api_format || "openai";

    if (!apiKey) {
      return { ok: false, error: "LLM API key not configured" };
    }

    try {
      let url: string;
      let headers: Record<string, string>;
      let body: string;

      if (apiFormat === "anthropic") {
        url = `${baseUrl}/messages`;
        headers = {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        };
        body = JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "回复OK" }],
        });
      } else {
        url = `${baseUrl}/chat/completions`;
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        };
        body = JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "回复OK" }],
        });
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = (await response.json()) as Record<string, unknown>;
      let responseText: string;
      if (apiFormat === "anthropic") {
        const content = data.content as Array<Record<string, string>> | undefined;
        responseText = content?.[0]?.text ?? JSON.stringify(data);
      } else {
        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        const msg = choices?.[0]?.message;
        responseText = msg ? String(typeof msg === "string" ? msg : (msg as Record<string, unknown>).content ?? JSON.stringify(msg)) : JSON.stringify(data);
      }

      return { ok: true, model, response: responseText };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 测试 ASR 连接
  app.post("/settings/asr/test", async () => {
    const db = getDb();
    const settings = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('asr_api_key', 'asr_resource_id')"
    ).all() as Array<{ key: string; value: string }>;

    const configMap: Record<string, string> = {};
    for (const s of settings) {
      configMap[s.key] = s.value;
    }

    const apiKey = configMap.asr_api_key;
    const resourceId = configMap.asr_resource_id || "volc.seedasr.sauc.duration";

    if (!apiKey) {
      return { ok: false, error: "ASR API key not configured" };
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false;
      const connectId = crypto.randomUUID();
      const ws = new WebSocket(BIGMODEL_ASR_URL, {
        headers: {
          "X-Api-Key": apiKey,
          "X-Api-Resource-Id": resourceId,
          "X-Api-Connect-Id": connectId,
          "X-Api-Sequence": "-1",
        },
      });

      ws.on("open", () => {
        if (settled) return;
        settled = true;
        ws.close();
        resolve({ ok: true });
      });

      ws.on("error", (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: err.message || "WebSocket connection failed" });
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
        resolve({ ok: false, error: "Connection timeout" });
      }, 10000);
    });
  });

  // 更新 ASR 配置
  app.patch("/settings/asr", async (request) => {
    const input = asrConfigInput.parse(request.body);
    const entries: Record<string, string> = {};

    if (input.apiKey !== undefined) entries.asr_api_key = input.apiKey;
    if (input.resourceId !== undefined) entries.asr_resource_id = input.resourceId;

    if (Object.keys(entries).length === 0) return { updated: false };

    setSettings(entries);
    refreshSettings();
    return { updated: true, fields: Object.keys(entries) };
  });

  // 更新 B站 Cookie
  app.patch("/settings/cookie", async (request) => {
    const input = cookieConfigInput.parse(request.body);
    if (!input.cookie) return { updated: false };

    setSettings({ bilibili_cookie: input.cookie });
    refreshSettings();
    return { updated: true };
  });

  // B站 QR 登录 - 获取二维码
  app.post("/settings/bilibili/qrcode", async () => {
    const response = await fetch(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
    );
    const data = (await response.json()) as {
      code: number;
      data?: { url: string; qrcode_key: string };
    };

    if (data.code !== 0 || !data.data) {
      throw { statusCode: 502, message: "Failed to generate QR code" };
    }

    return { url: data.data.url, qrcode_key: data.data.qrcode_key };
  });

  // B站 QR 登录 - 轮询状态
  app.get("/settings/bilibili/qrcode/poll", async (request) => {
    const query = request.query as { qrcode_key?: string };
    if (!query.qrcode_key) {
      throw { statusCode: 400, message: "Missing qrcode_key parameter" };
    }

    const response = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(query.qrcode_key)}`
    );
    const data = (await response.json()) as {
      code: number;
      data?: { url?: string; refresh_token?: string; timestamp?: number };
    };

    // code: 0=成功, 86101=未扫码, 86090=已扫码未确认, 86038=已过期
    if (data.code === 0) {
      // 登录成功，从响应头提取 Cookie 并保存
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) {
        const cookieStr = setCookies
          .map((c) => c.split(";")[0])
          .join("; ");
        setSettings({ bilibili_cookie: cookieStr });
        refreshSettings();
      }
    }

    return { code: data.code, data: data.data };
  });

  // B站账号信息
  app.get("/settings/bilibili/account", async () => {
    const db = getDb();
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'bilibili_cookie'").get() as
      | { value: string }
      | undefined;
    const cookie = setting?.value;

    if (!cookie) {
      return { logged_in: false };
    }

    try {
      const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
        headers: { Cookie: cookie },
      });
      const data = (await response.json()) as {
        code: number;
        data?: { uname?: string; face?: string; mid?: number };
      };

      if (data.code !== 0 || !data.data) {
        return { logged_in: false };
      }

      return {
        logged_in: true,
        uname: data.data.uname ?? "",
        face: data.data.face ?? "",
        uid: data.data.mid ?? 0,
      };
    } catch {
      return { logged_in: false };
    }
  });

  // 退出 B站登录
  app.post("/settings/bilibili/logout", async () => {
    setSettings({ bilibili_cookie: "" });
    refreshSettings();
    return { ok: true };
  });
};
