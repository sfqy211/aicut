import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Session, Source } from "../types";
import { Radio, Video, Trash2 } from "lucide-react";

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

  const liveSessions = useMemo(() => sessions.filter((s) => s.status === "recording"), [sessions]);
  const endedSessions = useMemo(() => sessions.filter((s) => s.status !== "recording"), [sessions]);

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
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 24 }}>
            {/* 直播中 */}
            {liveSessions.length > 0 && (
              <section>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <Radio size={14} style={{ color: "var(--danger)" }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--danger)" }}>直播中</span>
                  <span className="tag">{liveSessions.length}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                  {liveSessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isLive
                      onEnter={() => onEnterLivePreview(session.id)}
                      onDelete={() => handleDeleteSession(session.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* 已结束 */}
            {endedSessions.length > 0 && (
              <section>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <Video size={14} style={{ color: "var(--text-secondary)" }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>已结束</span>
                  <span className="tag">{endedSessions.length}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                  {endedSessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isLive={false}
                      onEnter={() => onEnterLivePreview(session.id)}
                      onDelete={() => handleDeleteSession(session.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionCard({
  session,
  isLive,
  onEnter,
  onDelete,
}: {
  session: Session;
  isLive: boolean;
  onEnter: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    <div
      className="panel"
      style={{
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderLeft: `3px solid ${isLive ? "var(--danger)" : "var(--border)"}`,
        cursor: "pointer",
        transition: "all 0.15s",
      }}
      onClick={onEnter}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.title || `直播 ${session.live_id || `#${session.id}`}`}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
            {formatDateTime(session.start_time ?? session.created_at)}
          </div>
        </div>
        {isLive ? (
          <span className="tag" style={{ background: "var(--danger)", color: "#fff", fontSize: 10, flexShrink: 0 }}>
            LIVE
          </span>
        ) : (
          <span className="tag" style={{ fontSize: 10, flexShrink: 0 }}>
            {session.status}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-secondary)" }}>
        <span>时长 {formatSeconds(session.total_duration)}</span>
        <span>大小 {formatBytes(session.total_size)}</span>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          className={`btn btn-sm ${confirmDelete ? "btn-danger" : "btn-ghost"}`}
          onClick={handleDeleteClick}
          title={confirmDelete ? "再次点击确认删除" : "删除场次"}
        >
          <Trash2 size={13} />
          {confirmDelete ? "确认删除" : "删除"}
        </button>
        <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); onEnter(); }}>
          {isLive ? "实时监控" : "查看回放"}
        </button>
      </div>
    </div>
  );
}
