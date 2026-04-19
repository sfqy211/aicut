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
    <section className="page-stack">
      <div className="section-header">
        <span className="eyebrow">Sources</span>
        <h1>直播源管理</h1>
        <p>先记录房间与主播名。录制器接入后，这里会控制自动监听、分段和 Cookie 登录。</p>
      </div>
      <div className="form-panel">
        <label>
          房间号
          <input value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="7734200" />
        </label>
        <label>
          主播名
          <input value={streamerName} onChange={(event) => setStreamerName(event.target.value)} placeholder="可选" />
        </label>
        <label className="wide-input">
          Cookie / cookie.json 路径
          <input
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            placeholder="可填原始 Cookie，或本地 cookie.json 路径"
          />
        </label>
        <button onClick={addSource} disabled={!roomId || submitting}>
          添加 B站直播源
        </button>
      </div>
      <div className="table-panel">
        <h2>已配置直播源</h2>
        {sources.length === 0 ? (
          <p className="empty">还没有直播源。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>房间</th>
                <th>主播</th>
                <th>Cookie</th>
                <th>自动录制</th>
                <th>状态</th>
                <th>进度</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>{source.room_id}</td>
                  <td>{source.streamer_name || "-"}</td>
                  <td className="cookie-cell">
                    <input
                      defaultValue={source.cookie || ""}
                      placeholder="原始 Cookie 或 cookie.json 路径"
                      onBlur={(event) => {
                        if (event.target.value !== (source.cookie || "")) {
                          void updateCookie(source.id, event.target.value);
                        }
                      }}
                    />
                  </td>
                  <td>{source.auto_record ? "开启" : "关闭"}</td>
                  <td>{source.runtime?.state || "idle"}</td>
                  <td>{source.runtime?.progressTime || "-"}</td>
                  <td>
                    <button className="mini-button" onClick={() => toggleMonitoring(source)}>
                      {source.runtime?.monitoring ? "停止监控" : "启动监控"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
