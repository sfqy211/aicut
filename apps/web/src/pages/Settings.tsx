import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api/client";
import type { SettingsMap } from "../types";
import { Eye, EyeOff, Plus, Star, Trash2, X } from "lucide-react";

type BilibiliAccount = {
  uid: number;
  uname: string;
  face: string;
  is_active: number;
  created_at: number;
};

export function Settings() {
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [llmForm, setLlmForm] = useState({ baseUrl: "", apiKey: "", model: "" });
  const [asrForm, setAsrForm] = useState({ apiKey: "", resourceId: "" });
  const [saving, setSaving] = useState<"llm" | "asr" | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [asrTestResult, setAsrTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Bilibili multi-account state
  const [accounts, setAccounts] = useState<BilibiliAccount[]>([]);
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrKey, setQrKey] = useState<string | null>(null);
  const [qrPolling, setQrPolling] = useState(false);
  const [qrStatus, setQrStatus] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    const nextSettings = await apiGet<SettingsMap>("/api/settings");
    setSettings(nextSettings);
    setLlmForm({
      baseUrl: nextSettings.llm_base_url?.value ?? "",
      apiKey: nextSettings.llm_api_key?.value ?? "",
      model: nextSettings.llm_model?.value ?? "",
    });
    setAsrForm({
      apiKey: nextSettings.asr_api_key?.value ?? "",
      resourceId: nextSettings.asr_resource_id?.value ?? "volc.seedasr.sauc.duration",
    });
    // Fetch accounts
    try {
      const accs = await apiGet<BilibiliAccount[]>("/api/settings/bilibili/accounts");
      setAccounts(accs);
    } catch {
      setAccounts([]);
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

  // --- QR Modal ---

  const stopPolling = useCallback(() => {
    setQrPolling(false);
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const openQrModal = useCallback(() => {
    setShowQrModal(true);
    setQrUrl(null);
    setQrKey(null);
    setQrStatus(null);
    stopPolling();
    // 自动获取二维码
    void doStartQrLogin();
  }, [stopPolling]);

  async function doStartQrLogin() {
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
      if (res.code === 0 && res.account) {
        stopPolling();
        setQrStatus("登录成功");
        // 关闭弹窗，刷新账号列表
        setTimeout(() => {
          setShowQrModal(false);
          void refresh();
        }, 800);
      } else if (res.code === 0 && !res.account) {
        stopPolling();
        setQrStatus("登录失败：未能获取账号信息，请重试");
      } else if (res.code === 86038) {
        stopPolling();
        setQrStatus("二维码已过期，请刷新");
      } else if (res.code === 86090) {
        setQrStatus("已扫码，请在手机上确认");
      } else if (res.code === 86101 || res.code === 86039) {
        // 86101=web版未扫码, 86039=TV版未扫码
        setQrStatus("等待扫码...");
      } else {
        setQrStatus(`状态码: ${res.code}`);
      }
    } catch {
      stopPolling();
      setQrStatus("轮询失败，请重试");
    }
  }

  async function activateAccount(uid: number) {
    await apiPost(`/api/settings/bilibili/accounts/${uid}/activate`, {});
    await refresh();
  }

  async function deleteAccount(uid: number) {
    await apiDelete(`/api/settings/bilibili/accounts/${uid}`);
    await refresh();
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
            <div className="form-input-with-action">
              <input
                className="form-input"
                value={llmForm.apiKey}
                onChange={(event) => setLlmForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="sk-..."
                type={showKeys ? "text" : "password"}
              />
              <button className="btn btn-ghost btn-sm key-toggle" onClick={() => setShowKeys((v) => !v)} title={showKeys ? "隐藏" : "显示"}>
                {showKeys ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
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
            <div className="form-input-with-action">
              <input
                className="form-input"
                value={asrForm.apiKey}
                onChange={(e) => setAsrForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="火山引擎控制台获取"
                type={showKeys ? "text" : "password"}
              />
              <button className="btn btn-ghost btn-sm key-toggle" onClick={() => setShowKeys((v) => !v)} title={showKeys ? "隐藏" : "显示"}>
                {showKeys ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
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
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">B站账号</span>
          <span className="tag">{accounts.length} 个账号</span>
        </div>
        <div className="panel-body settings-stack">
          {accounts.length === 0 ? (
            <div className="text-muted" style={{ fontSize: 13 }}>暂无已登录账号</div>
          ) : (
            <div className="account-list">
              {accounts.map((acc) => (
                <div key={acc.uid} className={`account-item ${acc.is_active ? "active" : ""}`}>
                  <div className="account-info">
                    <span className="account-name">{acc.uname || `UID ${acc.uid}`}</span>
                    <span className="account-uid mono">UID: {acc.uid}</span>
                    {acc.is_active ? (
                      <span className="tag" style={{ background: "var(--accent)", color: "#fff", fontSize: 10 }}>当前使用</span>
                    ) : null}
                  </div>
                  <div className="account-actions">
                    {!acc.is_active && (
                      <button className="btn btn-sm btn-ghost" onClick={() => activateAccount(acc.uid)} title="切换为此账号">
                        <Star size={13} /> 切换
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => deleteAccount(acc.uid)} title="删除账号">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-primary" onClick={openQrModal}>
            <Plus size={14} /> 添加账号
          </button>
        </div>
      </section>

      {/* QR 登录浮窗 */}
      {showQrModal && (
        <div className="modal-overlay" onClick={() => { setShowQrModal(false); stopPolling(); }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">扫码登录 B 站</span>
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowQrModal(false); stopPolling(); }}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              {qrUrl ? (
                <>
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                    alt="B站登录二维码"
                    className="qr-image"
                  />
                  <div className="qr-status">
                    {qrPolling && !qrStatus && "等待扫码..."}
                    {qrStatus && <span>{qrStatus}</span>}
                  </div>
                  {qrStatus !== "登录成功" && (
                    <button className="btn btn-sm" onClick={doStartQrLogin}>
                      刷新二维码
                    </button>
                  )}
                </>
              ) : (
                <div className="text-muted">
                  {qrStatus ?? "正在获取二维码..."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}