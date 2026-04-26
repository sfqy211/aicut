import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Session, SessionDetail, SessionSegment } from "../types";

function formatSeconds(value: number | null | undefined) {
  if (value == null) return "--";
  const min = Math.floor(value / 60);
  const sec = value % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

type SessionsProps = {
  onEnterLivePreview: (sessionId: number) => void;
};

export function Sessions({ onEnterLivePreview }: SessionsProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const lastEvent = useEventStream();

  useEffect(() => {
    void apiGet<Session[]>("/api/sessions").then((items) => {
      setSessions(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
    });
  }, [lastEvent]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void apiGet<SessionDetail>(`/api/sessions/${selectedId}`).then(setDetail);
  }, [selectedId, lastEvent]);

  const segments = detail?.segments ?? [];
  const selectedSession = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);

  return (
    <div className="sessions-layout">
      {/* Session List */}
      <aside className="panel" style={{ display: "flex", flexDirection: "column" }}>
        <div className="panel-header">
          <span className="panel-title">会话列表</span>
          <span className="tag">{sessions.length} SESSIONS</span>
        </div>
        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="panel-body text-muted">暂无会话</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                className={`session-chip ${session.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(session.id)}
              >
                <span className="session-chip-title">{session.title || `Session #${session.id}`}</span>
                <span className="session-chip-meta">{session.status}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Session Detail */}
      <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
        <div className="panel-header">
          <span className="panel-title">{selectedSession?.title || "选择会话"}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {selectedSession && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => onEnterLivePreview(selectedSession.id)}
              >
                监控
              </button>
            )}
            {selectedSession && <span className="tag">直播</span>}
          </div>
        </div>
        {detail == null ? (
          <div className="panel-body text-muted">暂无数据</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>分段</th>
                <th>状态</th>
                <th>时长</th>
                <th>弹幕热度</th>
                <th>转写</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((segment) => (
                <SegmentRow key={segment.id} segment={segment} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SegmentRow({ segment }: { segment: SessionSegment }) {
  const heat = Math.min(100, Math.round((segment.danmaku_count / Math.max(segment.duration || 30, 30)) * 300));

  return (
    <tr>
      <td>
        <span className="mono">#{segment.id}</span>
      </td>
      <td className={segment.status === "completed" ? "text-success" : segment.status === "failed" ? "text-danger" : "text-muted"}>
        {segment.status}
      </td>
      <td className="mono">{formatSeconds(segment.duration)}</td>
      <td>
        <div className="heat-strip">
          <div className="heat-strip-fill" style={{ width: `${heat}%` }} />
        </div>
        <span className="mono text-muted" style={{ fontSize: 11 }}>{segment.danmaku_count}</span>
      </td>
      <td style={{ maxWidth: 360, color: "var(--text-secondary)", lineHeight: 1.4 }}>
        {segment.transcript_text || segment.error_msg || "等待转写"}
      </td>
    </tr>
  );
}
