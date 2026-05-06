import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import WebSocket from "ws";
import { getDb, row } from "../db/index.js";
import { setSettings, refreshSettings } from "../db/dbSettings.js";

const BIGMODEL_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

const TV_APPKEY = "4409e2ce8ffd12b8";
const TV_SECRET = "59b43e04ad6965f34319062b478f83dd";

function generateTvSign(params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  const query = sorted.map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHash("md5").update(query + TV_SECRET).digest("hex");
}

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
    };

    for (const setting of settings) {
      if (result[setting.key]) {
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

  // B站 TV 版 QR 登录 - 获取二维码
  // 使用 TV 版 API，cookies 在响应体中返回，比 web 版更可靠
  app.post("/settings/bilibili/qrcode", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      appkey: TV_APPKEY,
      local_id: "0",
      ts: String(ts),
    };
    params.sign = generateTvSign(params);

    const body = new URLSearchParams(params);
    const response = await fetch(
      "https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }
    );
    const data = (await response.json()) as {
      code: number;
      data?: { url: string; auth_code: string };
    };

    if (data.code !== 0 || !data.data) {
      throw { statusCode: 502, message: "Failed to generate QR code" };
    }

    return { url: data.data.url, qrcode_key: data.data.auth_code };
  });

  // B站 TV 版 QR 登录 - 轮询状态
  app.get("/settings/bilibili/qrcode/poll", async (request) => {
    const query = request.query as { qrcode_key?: string };
    if (!query.qrcode_key) {
      throw { statusCode: 400, message: "Missing qrcode_key parameter" };
    }

    const ts = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      appkey: TV_APPKEY,
      auth_code: query.qrcode_key,
      local_id: "0",
      ts: String(ts),
    };
    params.sign = generateTvSign(params);

    const body = new URLSearchParams(params);
    const response = await fetch(
      "https://passport.bilibili.com/x/passport-tv-login/qrcode/poll",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }
    );
    const data = (await response.json()) as {
      code: number;
      data?: {
        cookie_info?: { cookies?: Array<{ name: string; value: string }> };
        token_info?: { access_token?: string; mid?: number; refresh_token?: string };
      };
    };

    // code: 0=成功, 86039=未扫码, 86090=已扫码未确认, 86038=已过期
    if (data.code === 0 && data.data) {
      const cookieInfo = data.data.cookie_info;
      const tokenInfo = data.data.token_info;

      if (cookieInfo?.cookies && cookieInfo.cookies.length > 0 && tokenInfo) {
        const cookieStr = cookieInfo.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        const uid = tokenInfo.mid ?? 0;

        if (uid > 0) {
          // 获取账号昵称
          let uname = "";
          let face = "";
          try {
            const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", {
              headers: { Cookie: cookieStr },
            });
            const navData = (await navRes.json()) as {
              code: number;
              data?: { uname?: string; face?: string };
            };
            if (navData.code === 0 && navData.data) {
              uname = navData.data.uname ?? "";
              face = navData.data.face ?? "";
            }
          } catch { /* ignore */ }

          const db = getDb();
          const existingCount = row<{ count: number }>(
            db.prepare("SELECT COUNT(*) as count FROM bilibili_accounts")
          )?.count ?? 0;

          db.prepare(
            `INSERT INTO bilibili_accounts (uid, uname, face, cookie, is_active, updated_at)
             VALUES (@uid, @uname, @face, @cookie, @isActive, unixepoch())
             ON CONFLICT(uid) DO UPDATE SET
               uname = excluded.uname, face = excluded.face,
               cookie = excluded.cookie, updated_at = unixepoch()`
          ).run({
            uid,
            uname,
            face,
            cookie: cookieStr,
            isActive: existingCount === 0 ? 1 : 0,
          });

          return {
            code: 0,
            account: { logged_in: true, uname, face, uid },
          };
        }
      }

      console.warn("[Settings] TV QR login success but missing cookie_info or token_info");
    }

    return { code: data.code };
  });

  // B站账号列表
  app.get("/settings/bilibili/accounts", async () => {
    const db = getDb();
    const accounts = db.prepare(
      "SELECT uid, uname, face, is_active, created_at FROM bilibili_accounts ORDER BY created_at ASC"
    ).all() as Array<{ uid: number; uname: string; face: string; is_active: number; created_at: number }>;

    return accounts;
  });

  // 切换活跃账号
  app.post("/settings/bilibili/accounts/:uid/activate", async (request, reply) => {
    const params = z.object({ uid: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();

    const account = db.prepare("SELECT uid FROM bilibili_accounts WHERE uid = ?").get(params.uid);
    if (!account) return reply.notFound("Account not found");

    db.prepare("UPDATE bilibili_accounts SET is_active = 0").run();
    db.prepare("UPDATE bilibili_accounts SET is_active = 1, updated_at = unixepoch() WHERE uid = ?").run(params.uid);

    return { ok: true };
  });

  // 删除账号
  app.delete("/settings/bilibili/accounts/:uid", async (request, reply) => {
    const params = z.object({ uid: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();

    const account = db.prepare("SELECT uid, is_active FROM bilibili_accounts WHERE uid = ?").get(params.uid) as { uid: number; is_active: number } | undefined;
    if (!account) return reply.notFound("Account not found");

    db.prepare("DELETE FROM bilibili_accounts WHERE uid = ?").run(params.uid);

    // 如果删除的是 active account，自动激活第一个剩余账号
    if (account.is_active) {
      const first = db.prepare("SELECT uid FROM bilibili_accounts ORDER BY created_at ASC LIMIT 1").get() as { uid: number } | undefined;
      if (first) {
        db.prepare("UPDATE bilibili_accounts SET is_active = 1 WHERE uid = ?").run(first.uid);
      }
    }

    return { ok: true };
  });
};
