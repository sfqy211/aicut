import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Session, Source } from "../types";
import { Radio, Trash2 } from "lucide-react";

function formatBytes(value: number | null | undefined) {
  if (value == null) return "--";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSeconds(value: number | null | undefined) {
  if (value == null) return "--";
  const min = Math.floor(value / 60);
  const sec = value % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function formatDateTime(ts: number | undefined) {
  if (!ts) return "--";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type SessionsProps = {
  onEnterLivePreview: (sessionId: number) => void;
};

export function Sessions({ onEnterLivePreview }: SessionsProps) {
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const lastEvent = useEventStream();

  // 加载主播列表
  useEffect(() => {
    void apiGet<Source[]>("/api/sources").then((items) => {
      setSources(items);
      setSelectedSourceId((current) => current ?? items[0]?.id ?? null);
    });
  }, [lastEvent]);

  // 加载选中主播的场次
  useEffect(() => {
    if (selectedSourceId == null) {
      setSessions([]);
      return;
    }
    void apiGet<Session[]>(`/api/sources/${selectedSourceId}/sessions`).then(setSessions);
  }, [selectedSourceId, lastEvent]);

  const sortedSessions = useMemo(() => {
    const live = sessions.filter((s) => s.status === "recording");
    const ended = sessions.filter((s) => s.status !== "recording");
    live.sort((a, b) => (b.start_time ?? b.created_at ?? 0) - (a.start_time ?? a.created_at ?? 0));
    ended.sort((a, b) => (b.start_time ?? b.created_at ?? 0) - (a.start_time ?? a.created_at ?? 0));
    return { live, ended };
  }, [sessions]);

  const handleDeleteSession = (sessionId: number) => {
    void apiDelete(`/api/sessions/${sessionId}`).then(() => {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    }).catch(() => {});
  };

  const selectedSource = useMemo(
    () => sources.find((s) => s.id === selectedSourceId) ?? null,
    [sources, selectedSourceId]
  );

  return (
    <div className="sessions-layout">
      {/* 左侧：主播列表 */}
      <aside className="panel" style={{ display: "flex", flexDirection: "column" }}>
        <div className="panel-header">
          <span className="panel-title">主播列表</span>
          <span className="tag">{sources.length} 主播</span>
        </div>
        <div className="session-list">
          {sources.length === 0 ? (
            <div className="panel-body text-muted">暂无主播</div>
          ) : (
            sources.map((source) => {
              const isRecording = source.runtime?.state === "recording";
              return (
                <button
                  key={source.id}
                  className={`session-chip ${source.id === selectedSourceId ? "active" : ""}`}
                  onClick={() => setSelectedSourceId(source.id)}
                >
                  <span className="session-chip-title">
                    {source.streamer_name || `房间 ${source.room_id}`}
                  </span>
                  <span className="session-chip-meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="mono" style={{ fontSize: 11 }}>{source.room_id}</span>
                    {isRecording && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--danger)" }}>
                        <Radio size={10} />
                        直播中
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* 右侧：直播场次 */}
      <div className="panel" style={{ display: "flex", flexDirection: "column", overflow: "auto" }}>
        <div className="panel-header">
          <span className="panel-title">
            {selectedSource ? (selectedSource.streamer_name || `房间 ${selectedSource.room_id}`) : "选择主播"}
          </span>
          <span className="tag">{sessions.length} 场次</span>
        </div>

        {sessions.length === 0 ? (
          <div className="panel-body text-muted">该主播暂无直播场次</div>
        ) : (
          <div className="session-table-wrap">
            <table className="session-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>标题</th>
                  <th>开始时间</th>
                  <th>时长</th>
                  <th>大小</th>
                  <th style={{ textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedSessions.live.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    onEnter={() => onEnterLivePreview(session.id)}
                    onDelete={() => handleDeleteSession(session.id)}
                  />
                ))}
                {sortedSessions.ended.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    onEnter={() => onEnterLivePreview(session.id)}
                    onDelete={() => handleDeleteSession(session.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  onEnter,
  onDelete,
}: {
  session: Session;
  onEnter: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isLive = session.status === "recording";

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete();
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  return (
    <tr
      className={`session-table-row ${isLive ? "live" : ""}`}
      onClick={onEnter}
    >
      <td>
        <span className="session-table-status">
          <span className={`session-table-status-dot ${isLive ? "recording" : "ended"}`} />
          {isLive ? (
            <span className="tag" style={{ background: "var(--danger)", color: "#fff", fontSize: 10, flexShrink: 0 }}>
              LIVE
            </span>
          ) : (
            <span className="tag" style={{ fontSize: 10, flexShrink: 0 }}>
              {session.status}
            </span>
          )}
        </span>
      </td>
      <td>
        <div className="session-table-title">
          {session.title || `直播 ${session.live_id || `#${session.id}`}`}
        </div>
      </td>
      <td className="session-table-mono">
        {formatDateTime(session.start_time ?? session.created_at)}
      </td>
      <td className="session-table-mono">
        {formatSeconds(session.total_duration)}
      </td>
      <td className="session-table-mono">
        {formatBytes(session.total_size)}
      </td>
      <td>
        <div className="session-table-actions">
          <button
            className={`btn btn-sm ${confirmDelete ? "btn-danger" : "btn-ghost"}`}
            onClick={handleDeleteClick}
            title={confirmDelete ? "再次点击确认删除" : "删除场次"}
          >
            <Trash2 size={13} />
            {confirmDelete ? "确认删除" : "删除"}
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={(e) => { e.stopPropagation(); onEnter(); }}
          >
            {isLive ? "实时监控" : "查看回放"}
          </button>
        </div>
      </td>
    </tr>
  );
}
