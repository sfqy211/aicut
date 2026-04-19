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

export function Sessions() {
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
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId]
  );

  return (
    <section className="sessions-layout">
      <aside className="session-list-panel">
        <div className="section-header compact">
          <span className="eyebrow">Sessions</span>
          <h1>直播会话</h1>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={session.id === selectedId ? "session-chip active" : "session-chip"}
              onClick={() => setSelectedId(session.id)}
            >
              <strong>{session.title || `Session #${session.id}`}</strong>
              <small>{session.status}</small>
            </button>
          ))}
          {sessions.length === 0 && <p className="empty">暂无会话。</p>}
        </div>
      </aside>
      <div className="session-detail-panel">
        <div className="section-header compact">
          <span className="eyebrow">Detail</span>
          <h1>{selectedSession?.title || "选择一场会话"}</h1>
          <p>这里展示录制分段、转写状态、弹幕热度与文本内容。</p>
        </div>
        {detail == null ? (
          <p className="empty">还没有可展示的会话。</p>
        ) : (
          <div className="segment-table">
            <table>
              <thead>
                <tr>
                  <th>分段</th>
                  <th>状态</th>
                  <th>时长</th>
                  <th>弹幕热度</th>
                  <th>转写文本</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <SegmentRow key={segment.id} segment={segment} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function SegmentRow({ segment }: { segment: SessionSegment }) {
  const heat = Math.min(100, Math.round((segment.danmaku_count / Math.max(segment.duration || 30, 30)) * 300));

  return (
    <tr>
      <td>
        <strong>#{segment.id}</strong>
        <div className="subtle">{segment.file_path.split(/[\\/]/).pop()}</div>
      </td>
      <td>{segment.status}</td>
      <td>{formatSeconds(segment.duration)}</td>
      <td>
        <div className="heat-strip">
          <span style={{ width: `${heat}%` }} />
        </div>
        <small>{segment.danmaku_count} 条</small>
      </td>
      <td className="transcript-cell">{segment.transcript_text || segment.error_msg || "等待转写结果"}</td>
    </tr>
  );
}
