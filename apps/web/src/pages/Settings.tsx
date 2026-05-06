import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../api/client";
import type { SettingsMap } from "../types";

type BilibiliAccount = {
  logged_in: boolean;
  uname: string;
  face: string;
  uid: number;
};

export function Settings() {
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [llmForm, setLlmForm] = useState({ baseUrl: "", apiKey: "", model: "" });
  const [asrForm, setAsrForm] = useState({ apiKey: "", resourceId: "" });
  const [saving, setSaving] = useState<"llm" | "asr" | null>(null);
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [asrTestResult, setAsrTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Bilibili QR login state
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrKey, setQrKey] = useState<string | null>(null);
  const [qrPolling, setQrPolling] = useState(false);
  const [qrStatus, setQrStatus] = useState<string | null>(null);
  const [account, setAccount] = useState<BilibiliAccount | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    const nextSettings = await apiGet<SettingsMap>("/api/settings");
    setSettings(nextSettings);
    setLlmForm({
      baseUrl: nextSettings.llm_base_url?.value ?? "",
      apiKey: "",
      model: nextSettings.llm_model?.value ?? "",
    });
    setAsrForm({
      apiKey: "",
      resourceId: nextSettings.asr_resource_id?.value ?? "volc.seedasr.sauc.duration",
    });
    // Fetch account info
    try {
      const acc = await apiGet<BilibiliAccount>("/api/settings/bilibili/account");
      setAccount(acc.logged_in ? acc : null);
    } catch {
      setAccount(null);
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  async function saveLlm() {
    setSaving("llm");
    try {
      await apiPatch("/api/settings/llm", {
        baseUrl: llmForm.baseUrl || undefined,
        apiKey: llmForm.apiKey || undefined,
        model: llmForm.model || undefined,
      });
      await refresh();
    } finally {
      setSaving(null);
    }
  }

  async function testLlm() {
    setLlmTestResult(null);
    try {
      const res = await apiPost<{ ok: boolean; msg?: string }>("/api/settings/llm/test", {});
      setLlmTestResult({ ok: res.ok, msg: res.msg ?? (res.ok ? "连接成功" : "连接失败") });
    } catch (e: unknown) {
      setLlmTestResult({ ok: false, msg: e instanceof Error ? e.message : "请求失败" });
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

  async function testAsr() {
    setAsrTestResult(null);
    try {
      const res = await apiPost<{ ok: boolean; msg?: string }>("/api/settings/asr/test", {});
      setAsrTestResult({ ok: res.ok, msg: res.msg ?? (res.ok ? "连接成功" : "连接失败") });
    } catch (e: unknown) {
      setAsrTestResult({ ok: false, msg: e instanceof Error ? e.message : "请求失败" });
    }
  }

  function applyMiMoPreset() {
    setLlmForm({ baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "", model: "mimo-v2.5-pro" });
  }

  const stopPolling = useCallback(() => {
    setQrPolling(false);
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  async function startQrLogin() {
    setQrUrl(null);
    setQrKey(null);
    setQrStatus(null);
    stopPolling();
    try {
      const res = await apiPost<{ url: string; qrcode_key: string }>("/api/settings/bilibili/qrcode", {});
      setQrUrl(res.url);
      setQrKey(res.qrcode_key);
      setQrPolling(true);
      pollTimer.current = setInterval(() => {
        void pollQr(res.qrcode_key);
      }, 2000);
    } catch (e: unknown) {
      setQrStatus(`获取二维码失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
  }

  async function pollQr(key: string) {
    try {
      const res = await apiGet<{ code: number; data?: { url?: string }; account?: BilibiliAccount }>(
        `/api/settings/bilibili/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`
      );
      if (res.code === 0) {
        stopPolling();
        setQrStatus("登录成功");
        setQrUrl(null);
        setQrKey(null);
        // 直接使用 poll 响应中的账号信息，避免二次请求时序问题
        if (res.account?.logged_in) {
          setAccount(res.account);
        }
      } else if (res.code === 86038) {
        stopPolling();
        setQrStatus("二维码已过期，请重新获取");
      } else if (res.code === 86090) {
        setQrStatus("已扫码，请在手机上确认");
      } else if (res.code === 86101) {
        setQrStatus("等待扫码...");
      } else {
        setQrStatus(`状态码: ${res.code}`);
      }
    } catch {
      stopPolling();
      setQrStatus("轮询失败，请重试");
    }
  }

  async function logoutBilibili() {
    try {
      await apiPost("/api/settings/bilibili/logout", {});
      setAccount(null);
      setQrUrl(null);
      setQrKey(null);
      setQrStatus(null);
    } catch {
      // ignore
    }
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
            <button className="btn btn-sm" onClick={applyMiMoPreset}>
              MiMo v2.5 Pro
            </button>
          </div>
          <label className="form-group">
            <span className="form-label">Base URL</span>
            <input
              className="form-input"
              value={llmForm.baseUrl}
              onChange={(event) => setLlmForm((current) => ({ ...current, baseUrl: event.target.value }))}
              placeholder="https://api.openai.com/v1"
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
              placeholder="mimo-v2.5-pro / gpt-4o-mini"
            />
          </label>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveLlm} disabled={saving === "llm"}>
              {saving === "llm" ? "保存中..." : "保存 LLM 配置"}
            </button>
            <button className="btn btn-sm" onClick={testLlm} disabled={saving === "llm"}>
              测试连接
            </button>
            {llmTestResult && (
              <span className={llmTestResult.ok ? "text-success" : "text-error"}>
                {llmTestResult.msg}
              </span>
            )}
            {settings?.llm_api_key?.value && <span className="text-muted">API Key 已存在，页面不会回显明文。</span>}
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
            <button className="btn btn-sm" onClick={testAsr} disabled={saving === "asr"}>
              测试连接
            </button>
            {asrTestResult && (
              <span className={asrTestResult.ok ? "text-success" : "text-error"}>
                {asrTestResult.msg}
              </span>
            )}
            {settings?.asr_api_key?.value && <span className="text-muted">API Key 已存在，页面不会回显明文。</span>}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">B站登录</span>
          <span className="tag">BILIBILI</span>
        </div>
        <div className="panel-body settings-stack">
          {account ? (
            <div className="settings-bilibili-account">
              <img src={account.face} alt={account.uname} className="bilibili-avatar" />
              <span className="bilibili-username">{account.uname}</span>
              <button className="btn btn-sm" onClick={logoutBilibili}>
                退出登录
              </button>
            </div>
          ) : (
            <>
              {!qrUrl && (
                <button className="btn btn-primary" onClick={startQrLogin} disabled={qrPolling}>
                  扫码登录
                </button>
              )}
              {qrUrl && (
                <div className="settings-qr">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                    alt="B站登录二维码"
                    className="qr-image"
                  />
                  <div className="settings-qr-status">
                    {qrPolling && !qrStatus && "等待扫码..."}
                    {qrStatus && <span>{qrStatus}</span>}
                  </div>
                  {qrStatus !== "登录成功" && (
                    <button className="btn btn-sm" onClick={startQrLogin}>
                      刷新二维码
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}