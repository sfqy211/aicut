import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Source } from "../types";

export function Sources() {
  const [sources, setSources] = useState<Source[]>([]);
  const [roomId, setRoomId] = useState("");
  const [streamerName, setStreamerName] = useState("");
  const [cookie, setCookie] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const lastEvent = useEventStream();

  async function refresh() {
    setSources(await apiGet<Source[]>("/api/sources"));
  }

  useEffect(() => {
    void refresh();
  }, [lastEvent]);

  async function addSource() {
    setSubmitting(true);
    try {
      await apiPost("/api/sources/bilibili", {
        roomId,
        streamerName,
        cookie,
        autoRecord: true,
      });
      setRoomId("");
      setStreamerName("");
      setCookie("");
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleMonitoring(source: Source) {
    if (source.runtime?.monitoring) {
      await apiPost(`/api/sources/${source.id}/stop`, {});
    } else {
      await apiPost(`/api/sources/${source.id}/start`, {});
    }
    await refresh();
  }

  async function updateCookie(sourceId: number, nextCookie: string) {
    await apiPatch(`/api/sources/${sourceId}`, { cookie: nextCookie });
    await refresh();
  }

  return (
    <>
      {/* Add Source Form */}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">房间号</label>
          <input className="form-input" value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="7734200" />
        </div>
        <div className="form-group">
          <label className="form-label">主播名</label>
          <input className="form-input" value={streamerName} onChange={(e) => setStreamerName(e.target.value)} placeholder="可选" />
        </div>
        <div className="form-group flex-1">
          <label className="form-label">Cookie / cookie.json 路径</label>
          <input className="form-input" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="原始 Cookie 或本地 cookie.json 路径" />
        </div>
        <button className="btn btn-primary" onClick={addSource} disabled={!roomId || submitting}>
          添加直播源
        </button>
      </div>

      {/* Sources Table */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">直播源配置</span>
          <span className="tag">{sources.length} SOURCES</span>
        </div>
        {sources.length === 0 ? (
          <div className="panel-body text-muted">暂无直播源</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>房间号</th>
                <th>主播</th>
                <th>Cookie</th>
                <th>状态</th>
                <th>进度</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td className="mono">{source.room_id}</td>
                  <td>{source.streamer_name || "-"}</td>
                  <td>
                    <input
                      className="form-input"
                      defaultValue={source.cookie || ""}
                      placeholder="Cookie 或路径"
                      onBlur={(e) => {
                        if (e.target.value !== (source.cookie || "")) {
                          void updateCookie(source.id, e.target.value);
                        }
                      }}
                      style={{ minWidth: "180px" }}
                    />
                  </td>
                  <td>
                    <StatusBadge state={source.runtime?.state} />
                  </td>
                  <td className="mono text-muted">{source.runtime?.progressTime || "-"}</td>
                  <td>
                    <button
                      className={`btn btn-sm ${source.runtime?.monitoring ? "btn-danger" : "btn-primary"}`}
                      onClick={() => toggleMonitoring(source)}
                    >
                      {source.runtime?.monitoring ? "停止" : "启动"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function StatusBadge({ state }: { state?: string }) {
  if (!state) return <span className="text-muted">-</span>;

  const map: Record<string, { label: string; cls: string }> = {
    idle: { label: "空闲", cls: "text-muted" },
    monitoring: { label: "监控中", cls: "text-success" },
    recording: { label: "录制中", cls: "text-success" },
    stopping: { label: "停止中", cls: "text-warning" },
    error: { label: "错误", cls: "text-danger" },
  };

  const info = map[state] || { label: state, cls: "" };
  return <span className={info.cls}>{info.label}</span>;
}
