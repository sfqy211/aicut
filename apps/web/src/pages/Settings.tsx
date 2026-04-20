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
  const [runtimeForm, setRuntimeForm] = useState({ ffmpegPath: "", recorderSegment: "" });
  const [saving, setSaving] = useState<"llm" | "runtime" | null>(null);

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
      recorderSegment: nextSettings.recorder_segment?.value ?? nextSystem.recorderSegment,
    });
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
        recorderSegment: runtimeForm.recorderSegment || undefined,
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
              placeholder="MiniMax-M2.7 / gpt-4o-mini / claude-model"
            />
          </label>
          <div className="settings-hint">
            OpenAI 兼容填写 `https://api.minimaxi.com/v1`，Anthropic 兼容填写 `https://api.minimaxi.com/anthropic`。
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
          <label className="form-group">
            <span className="form-label">录制分段时长</span>
            <input
              className="form-input"
              value={runtimeForm.recorderSegment}
              onChange={(event) => setRuntimeForm((current) => ({ ...current, recorderSegment: event.target.value }))}
              placeholder="30"
            />
          </label>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveRuntime} disabled={saving === "runtime"}>
              {saving === "runtime" ? "保存中..." : "应用运行时配置"}
            </button>
            <span className="text-muted">FFmpeg 立即生效，录制分段对新启动的录制器生效。</span>
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
