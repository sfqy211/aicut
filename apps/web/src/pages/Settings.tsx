import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../api/client";
import type { SettingsMap, SystemSettings } from "../types";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function Settings() {
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [system, setSystem] = useState<SystemSettings | null>(null);
  const [llmForm, setLlmForm] = useState({ apiFormat: "openai", baseUrl: "", apiKey: "", model: "" });
  const [runtimeForm, setRuntimeForm] = useState({ ffmpegPath: "" });
  const [asrForm, setAsrForm] = useState({ apiKey: "", resourceId: "" });
  const [cookieForm, setCookieForm] = useState({ cookie: "" });
  const [saving, setSaving] = useState<"llm" | "runtime" | "asr" | "cookie" | null>(null);

  async function refresh() {
    const [nextSettings, nextSystem] = await Promise.all([
      apiGet<SettingsMap>("/api/settings"),
      apiGet<SystemSettings>("/api/settings/system"),
    ]);

    setSettings(nextSettings);
    setSystem(nextSystem);
    setLlmForm({
      apiFormat: nextSettings.llm_api_format?.value === "anthropic" ? "anthropic" : "openai",
      baseUrl: nextSettings.llm_base_url?.value ?? "",
      apiKey: "",
      model: nextSettings.llm_model?.value ?? "",
    });
    setRuntimeForm({
      ffmpegPath: nextSettings.ffmpeg_path?.value ?? nextSystem.ffmpegPath,
    });
    setAsrForm({
      apiKey: "",
      resourceId: nextSettings.asr_resource_id?.value ?? "volc.seedasr.sauc.duration",
    });
    setCookieForm({ cookie: "" });
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveLlm() {
    setSaving("llm");
    try {
      await apiPatch("/api/settings/llm", {
        apiFormat: llmForm.apiFormat,
        baseUrl: llmForm.baseUrl || undefined,
        apiKey: llmForm.apiKey || undefined,
        model: llmForm.model || undefined,
      });
      await refresh();
    } finally {
      setSaving(null);
    }
  }

  async function saveRuntime() {
    setSaving("runtime");
    try {
      await apiPatch("/api/settings/runtime", {
        ffmpegPath: runtimeForm.ffmpegPath || undefined,
      });
      await refresh();
    } finally {
      setSaving(null);
    }
  }

  async function saveAsr() {
    setSaving("asr");
    try {
      await apiPatch("/api/settings/asr", {
        apiKey: asrForm.apiKey || undefined,
        resourceId: asrForm.resourceId || undefined,
      });
      await refresh();
    } finally {
      setSaving(null);
    }
  }

  async function saveCookie() {
    setSaving("cookie");
    try {
      await apiPatch("/api/settings/cookie", {
        cookie: cookieForm.cookie || undefined,
      });
      await refresh();
    } finally {
      setSaving(null);
    }
  }

  async function chooseFfmpeg() {
    const result = await apiPost<{ selected: boolean; path: string | null }>("/api/settings/runtime/browse-ffmpeg", {});
    if (result.selected && result.path) {
      setRuntimeForm((current) => ({ ...current, ffmpegPath: result.path ?? current.ffmpegPath }));
    }
  }

  function applyMiniMaxPreset(mode: "openai" | "anthropic") {
    const preset =
      mode === "anthropic"
        ? { apiFormat: "anthropic" as const, baseUrl: "https://api.minimaxi.com/anthropic" }
        : { apiFormat: "openai" as const, baseUrl: "https://api.minimaxi.com/v1" };

    setLlmForm((current) => ({
      ...current,
      ...preset,
      model: current.model || "MiniMax-M2.7",
    }));
  }

  function applyMiMoPreset() {
    setLlmForm((current) => ({
      ...current,
      apiFormat: "openai",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: current.model || "mimo-v2.5-pro",
    }));
  }

  return (
    <div className="settings-layout">
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">LLM 配置</span>
          <span className="tag">API READY</span>
        </div>
        <div className="panel-body settings-stack">
          <div className="settings-presets">
            <button className="btn btn-sm" onClick={() => applyMiniMaxPreset("openai")}>
              MiniMax OpenAI 兼容
            </button>
            <button className="btn btn-sm" onClick={() => applyMiniMaxPreset("anthropic")}>
              MiniMax Anthropic 兼容
            </button>
            <button className="btn btn-sm" onClick={applyMiMoPreset}>
              MiMo v2.5 Pro
            </button>
          </div>
          <label className="form-group">
            <span className="form-label">接口协议</span>
            <select
              className="form-input"
              value={llmForm.apiFormat}
              onChange={(event) => setLlmForm((current) => ({ ...current, apiFormat: event.target.value as "openai" | "anthropic" }))}
            >
              <option value="openai">OpenAI API 兼容</option>
              <option value="anthropic">Anthropic API 兼容</option>
            </select>
          </label>
          <label className="form-group">
            <span className="form-label">API URL</span>
            <input
              className="form-input"
              value={llmForm.baseUrl}
              onChange={(event) => setLlmForm((current) => ({ ...current, baseUrl: event.target.value }))}
              placeholder="https://api.openai.com"
            />
          </label>
          <label className="form-group">
            <span className="form-label">API Key</span>
            <input
              className="form-input"
              value={llmForm.apiKey}
              onChange={(event) => setLlmForm((current) => ({ ...current, apiKey: event.target.value }))}
              placeholder={settings?.llm_api_key?.value ? "已配置，留空则保持不变" : "sk-..."}
              type="password"
            />
          </label>
          <label className="form-group">
            <span className="form-label">Model</span>
            <input
              className="form-input"
              value={llmForm.model}
              onChange={(event) => setLlmForm((current) => ({ ...current, model: event.target.value }))}
              placeholder="mimo-v2.5-pro / gpt-4o-mini / MiniMax-M2.7"
            />
          </label>
          <div className="settings-hint">
            OpenAI 兼容填写 Base URL（如 `https://api.xiaomimimo.com/v1`），Anthropic 兼容填写 `https://api.minimaxi.com/anthropic`。
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveLlm} disabled={saving === "llm"}>
              {saving === "llm" ? "保存中..." : "保存 LLM 配置"}
            </button>
            {settings?.llm_api_key?.value && <span className="text-muted">API Key 已存在，页面不会回显明文。</span>}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">运行时配置</span>
          <span className="tag">LOCAL NODE</span>
        </div>
        <div className="panel-body settings-stack">
          <label className="form-group">
            <span className="form-label">FFmpeg 路径</span>
            <div className="settings-inline">
              <input
                className="form-input"
                value={runtimeForm.ffmpegPath}
                placeholder="请选择 ffmpeg.exe"
                readOnly
              />
              <button className="btn btn-sm" onClick={chooseFfmpeg}>
                选择 ffmpeg.exe
              </button>
            </div>
          </label>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveRuntime} disabled={saving === "runtime"}>
              {saving === "runtime" ? "保存中..." : "保存 FFmpeg 路径"}
            </button>
            <span className="text-muted">FFmpeg 路径立即生效。</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">ASR 配置</span>
          <span className="tag">VOLCENGINE</span>
        </div>
        <div className="panel-body settings-stack">
          <label className="form-group">
            <span className="form-label">API Key</span>
            <input
              className="form-input"
              value={asrForm.apiKey}
              onChange={(e) => setAsrForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={settings?.asr_api_key?.value ? "已配置，留空则保持不变" : "火山引擎控制台获取"}
              type="password"
            />
          </label>
          <label className="form-group">
            <span className="form-label">Resource ID</span>
            <input
              className="form-input"
              value={asrForm.resourceId}
              onChange={(e) => setAsrForm((f) => ({ ...f, resourceId: e.target.value }))}
              placeholder="volc.seedasr.sauc.duration"
            />
          </label>
          <div className="settings-hint">
            豆包2.0 小时版：volc.seedasr.sauc.duration | 并发版：volc.seedasr.sauc.concurrent
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveAsr} disabled={saving === "asr"}>
              {saving === "asr" ? "保存中..." : "保存 ASR 配置"}
            </button>
            {settings?.asr_api_key?.value && <span className="text-muted">API Key 已存在，页面不会回显明文。</span>}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">B站 Cookie</span>
          <span className="tag">BILIBILI</span>
        </div>
        <div className="panel-body settings-stack">
          <label className="form-group">
            <span className="form-label">Cookie 内容</span>
            <textarea
              className="form-input"
              value={cookieForm.cookie}
              onChange={(e) => setCookieForm({ cookie: e.target.value })}
              placeholder={settings?.bilibili_cookie?.value ? "已配置，留空则保持不变" : "粘贴完整 Cookie 字符串或 JSON"}
              rows={3}
              style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
            />
          </label>
          <div className="settings-hint">
            支持三种格式：原始 Cookie 字符串、JSON 数组、JSON 对象。优先级低于直播源级别配置的 Cookie。
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveCookie} disabled={saving === "cookie"}>
              {saving === "cookie" ? "保存中..." : "保存 Cookie"}
            </button>
            {settings?.bilibili_cookie?.value && <span className="text-muted">Cookie 已存在，页面不会回显明文。</span>}
          </div>
        </div>
      </section>

      <section className="panel settings-span-full">
        <div className="panel-header">
          <span className="panel-title">磁盘与库状态</span>
          <span className="tag">STORAGE</span>
        </div>
        <div className="panel-body settings-storage">
          <div className="storage-meter">
            <div className="storage-meter-head">
              <strong>库目录</strong>
              <span className="mono">{system?.libraryRoot ?? "-"}</span>
            </div>
            <div className="bar-bg storage-bar">
              <div
                className="bar-fill warning"
                style={{ width: `${system?.disk.usagePercent ?? 0}%` }}
              />
            </div>
            <div className="storage-meta">
              <span>已用 {formatBytes(system?.disk.usedBytes ?? 0)}</span>
              <span>剩余 {formatBytes(system?.disk.freeBytes ?? 0)}</span>
              <span>{system?.disk.usagePercent ?? 0}%</span>
            </div>
          </div>

          <div className="settings-stat-grid">
            <div className="settings-stat">
              <span className="settings-stat-label">直播源</span>
              <strong className="mono">{system?.sources ?? 0}</strong>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-label">会话</span>
              <strong className="mono">{system?.sessions ?? 0}</strong>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-label">候选</span>
              <strong className="mono">{system?.candidates ?? 0}</strong>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-label">导出任务</span>
              <strong className="mono">{system?.exports ?? 0}</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
