import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { getDb, row } from "../db/index.js";
import { setSettings, refreshSettings } from "../db/dbSettings.js";
import { updateRecorderFfmpegPath } from "../core/recorder/recorderManager.js";

const execFileAsync = promisify(execFile);

const llmConfigInput = z.object({
  apiFormat: z.enum(["openai", "anthropic"]).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const runtimeConfigInput = z.object({
  ffmpegPath: z.string().min(1).optional(),
});

const asrConfigInput = z.object({
  apiKey: z.string().optional(),
  resourceId: z.string().optional(),
});

const cookieConfigInput = z.object({
  cookie: z.string().optional(),
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
      llm_api_format: { value: "openai", updatedAt: 0 },
      llm_base_url: { value: null, updatedAt: 0 },
      llm_api_key: { value: null, updatedAt: 0 },
      llm_model: { value: null, updatedAt: 0 },
      ffmpeg_path: { value: config.ffmpegPath, updatedAt: 0 },
      asr_api_key: { value: null, updatedAt: 0 },
      asr_resource_id: { value: "volc.seedasr.sauc.duration", updatedAt: 0 },
      bilibili_cookie: { value: null, updatedAt: 0 },
    };

    for (const setting of settings) {
      // 不返回敏感字段的完整值
      if (setting.key === "llm_api_key" || setting.key === "asr_api_key" || setting.key === "bilibili_cookie") {
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

    if (input.apiFormat !== undefined) {
      updates.push("llm_api_format = @apiFormat");
      values.apiFormat = input.apiFormat;
    }

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
      ).run({
        key:
          key === "apiFormat"
            ? "llm_api_format"
            : key === "baseUrl"
              ? "llm_base_url"
              : key === "apiKey"
                ? "llm_api_key"
                : "llm_model",
        value: val,
        timestamp,
      });
    }

    return { updated: true, fields: Object.keys(values) };
  });

  // 更新运行时配置
  app.patch("/settings/runtime", async (request) => {
    const input = runtimeConfigInput.parse(request.body);
    const db = getDb();
    const timestamp = Math.floor(Date.now() / 1000);
    const updatedFields: string[] = [];

    if (input.ffmpegPath !== undefined) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('ffmpeg_path', @value, @timestamp)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @timestamp`
      ).run({
        value: input.ffmpegPath,
        timestamp,
      });
      updateRecorderFfmpegPath(input.ffmpegPath);
      updatedFields.push("ffmpegPath");
    }

    return {
      updated: updatedFields.length > 0,
      fields: updatedFields,
      effective: {
        ffmpegPath: config.ffmpegPath,
      },
    };
  });

  app.post("/settings/runtime/browse-ffmpeg", async (_request, reply) => {
    const selectedPath = await browseForFfmpeg();
    if (!selectedPath) {
      return { selected: false, path: null };
    }

    return {
      selected: true,
      path: selectedPath,
    };
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

// 获取系统状态
  app.get("/settings/system", async () => {
    const db = getDb();
    const disk = readDiskSpace(config.libraryRoot);

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
      ffmpegPath: config.ffmpegPath,
      libraryRoot: config.libraryRoot,
      disk,
    };

    return stats;
  });
};

function readDiskSpace(targetPath: string) {
  try {
    const info = fs.statfsSync(targetPath);
    const totalBytes = Number(info.blocks) * Number(info.bsize);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

    return {
      totalBytes,
      freeBytes,
      usedBytes,
      usagePercent,
    };
  } catch {
    return {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usagePercent: 0,
    };
  }
}

async function browseForFfmpeg(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new Error("Native ffmpeg file picker is only available on Windows");
  }

  const command = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Title = '选择 ffmpeg.exe'",
    "$dialog.Filter = 'FFmpeg executable (ffmpeg.exe)|ffmpeg.exe|Executable (*.exe)|*.exe'",
    "$dialog.CheckFileExists = $true",
    "$dialog.Multiselect = $false",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", command],
    {
      windowsHide: false,
    }
  );

  const selectedPath = stdout.trim();
  return selectedPath || null;
}
