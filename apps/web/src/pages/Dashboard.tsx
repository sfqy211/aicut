import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Candidate, Session, SessionOverview, Source } from "../types";

export function Dashboard() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [overview, setOverview] = useState<SessionOverview | null>(null);
  const lastEvent = useEventStream();

  useEffect(() => {
    void Promise.all([
      apiGet<Source[]>("/api/sources").then(setSources),
      apiGet<Session[]>("/api/sessions").then(setSessions),
      apiGet<Candidate[]>("/api/candidates?status=pending").then(setCandidates),
      apiGet<SessionOverview>("/api/sessions/overview").then(setOverview),
    ]);
  }, [lastEvent]);

  const recordingCount = overview?.recording ?? 0;
  const pendingCount = candidates.length;

  return (
    <>
      {/* KPIs */}
      <div className="kpi-grid">
        <div className="panel panel-hover kpi-card reveal visible">
          <div className="kpi-header">
            <span className="kpi-label">录制中</span>
            <div className="kpi-icon"><Radio size={16} /></div>
          </div>
          <div className="kpi-value mono">{recordingCount}</div>
        </div>
        <div className="panel panel-hover kpi-card reveal visible">
          <div className="kpi-header">
            <span className="kpi-label">转写中</span>
            <div className="kpi-icon"><Activity size={16} /></div>
          </div>
          <div className="kpi-value mono">{overview?.transcribing ?? 0}</div>
        </div>
        <div className="panel panel-hover kpi-card reveal visible">
          <div className="kpi-header">
            <span className="kpi-label">排队等待</span>
            <div className="kpi-icon"><Rows3 size={16} /></div>
          </div>
          <div className="kpi-value mono">{overview?.queued ?? 0}</div>
        </div>
        <div className="panel panel-hover kpi-card reveal visible">
          <div className="kpi-header">
            <span className="kpi-label">待审核</span>
            <div className="kpi-icon" style={{ color: pendingCount > 0 ? "var(--warning)" : "var(--accent)" }}>
              <WandSparkles size={16} />
            </div>
          </div>
          <div className={`kpi-value mono ${pendingCount > 0 ? "text-warning" : ""}`}>{pendingCount}</div>
        </div>
      </div>

      {/* Tables Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 24 }}>
        {/* Sources Table */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">直播源状态</span>
            <span className="tag">REALTIME</span>
          </div>
          {sources.length === 0 ? (
            <div className="panel-body text-muted">暂无直播源</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>房间号</th>
                  <th>主播</th>
                  <th>状态</th>
                  <th>进度</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td className="mono">{source.room_id}</td>
                    <td>{source.streamer_name || "-"}</td>
                    <td>
                      <StatusBadge state={source.runtime?.state} monitoring={source.runtime?.monitoring} />
                    </td>
                    <td className="mono text-muted">{source.runtime?.progressTime || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Sessions Table */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">最近会话</span>
            <span className="tag">LATEST</span>
          </div>
          {sessions.length === 0 ? (
            <div className="panel-body text-muted">暂无会话</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>类型</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 8).map((session) => (
                  <tr key={session.id}>
                    <td>{session.title || `Session #${session.id}`}</td>
                    <td>
                      <span className="tag">直播</span>
                    </td>
                    <td className="text-muted">{session.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function StatusBadge({ state, monitoring }: { state?: string; monitoring?: boolean }) {
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

function Radio({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M4.93 4.93a10 10 0 0 1 14.14 0"></path>
      <path d="M7.76 7.76a6 6 0 0 1 8.48 0"></path>
    </svg>
  );
}

function Activity({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
    </svg>
  );
}

function Rows3({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 6H3"></path>
      <path d="M21 12H3"></path>
      <path d="M21 18H3"></path>
    </svg>
  );
}

function WandSparkles({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"></path>
      <path d="m14 7 3 3"></path>
      <path d="M5 6v4"></path>
      <path d="M19 14v4"></path>
      <path d="M10 2v2"></path>
      <path d="M7 8H3"></path>
      <path d="M21 16h-4"></path>
      <path d="M11 3H9"></path>
    </svg>
  );
}
