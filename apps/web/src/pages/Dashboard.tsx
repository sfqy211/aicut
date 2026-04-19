import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Candidate, Session, Source } from "../types";

export function Dashboard() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const lastEvent = useEventStream();

  useEffect(() => {
    void Promise.all([
      apiGet<Source[]>("/api/sources").then(setSources),
      apiGet<Session[]>("/api/sessions").then(setSessions),
      apiGet<Candidate[]>("/api/candidates?status=pending").then(setCandidates),
    ]);
  }, [lastEvent]);

  return (
    <section className="page-grid">
      <div className="hero-panel">
        <span className="eyebrow">AICut Control Room</span>
        <h1>录制、转写、候选切片都会在这里汇合。</h1>
        <p>当前阶段已接通本地数据库、REST API 和实时事件流，后续会继续接入录制器、ASR 队列与 LLM 分析。</p>
      </div>
      <div className="metrics-panel">
        <Metric label="直播源" value={sources.length} />
        <Metric label="会话" value={sessions.length} />
        <Metric label="待审候选" value={candidates.length} />
        <Metric label="最近事件" value={lastEvent} compact />
      </div>
      <div className="table-panel wide">
        <h2>最近会话</h2>
        {sessions.length === 0 ? (
          <p className="empty">还没有直播会话或本地导入。先添加直播源，或通过 API 导入本地文件。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>类型</th>
                <th>状态</th>
                <th>房间</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{session.title || `Session #${session.id}`}</td>
                  <td>{session.session_type}</td>
                  <td>{session.status}</td>
                  <td>{session.room_id || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: number | string; compact?: boolean }) {
  return (
    <div className={compact ? "metric compact" : "metric"}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
