import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import type { Source } from "../types";

export function Sources() {
  const [sources, setSources] = useState<Source[]>([]);
  const [roomId, setRoomId] = useState("");
  const [streamerName, setStreamerName] = useState("");

  async function refresh() {
    setSources(await apiGet<Source[]>("/api/sources"));
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addSource() {
    await apiPost("/api/sources/bilibili", {
      roomId,
      streamerName,
      autoRecord: true,
    });
    setRoomId("");
    setStreamerName("");
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
        <button onClick={addSource} disabled={!roomId}>
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
                <th>自动录制</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>{source.room_id}</td>
                  <td>{source.streamer_name || "-"}</td>
                  <td>{source.auto_record ? "开启" : "关闭"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
