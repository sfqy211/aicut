import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Candidate } from "../types";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}分${s}秒`;
}

function ScoreBar({ value, max, label, color }: { value: number; max: number; label: string; color: string }) {
  const percent = Math.min(100, (value / max) * 100);
  return (
    <div className="score-bar">
      <span className="score-label">{label}</span>
      <div className="score-track">
        <div className={`score-fill ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="score-value">{value.toFixed(0)}</span>
    </div>
  );
}

export function Review() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const lastEvent = useEventStream();

  async function refresh() {
    const status = filter === "all" ? "" : `?status=${filter}`;
    setCandidates(await apiGet<Candidate[]>(`/api/candidates${status}`));
  }

  useEffect(() => {
    void refresh();
  }, [filter, lastEvent]);

  async function approve(id: number) {
    await apiPost(`/api/candidates/${id}/approve`, {});
    await refresh();
  }

  async function reject(id: number) {
    await apiPost(`/api/candidates/${id}/reject`, {});
    await refresh();
  }

  async function bulkApprove() {
    const pendingIds = candidates.filter((c) => c.status === "pending").map((c) => c.id);
    if (pendingIds.length === 0) return;
    await apiPost("/api/candidates/bulk-approve", { ids: pendingIds });
    await refresh();
  }

  const selected = candidates.find((c) => c.id === selectedId);
  const pendingCount = candidates.filter((c) => c.status === "pending").length;

  return (
    <section className="review-layout">
      <div className="section-header">
        <span className="eyebrow">Review Queue</span>
        <h1>候选审核</h1>
        <p>
          待审核 <strong>{pendingCount}</strong> 个片段
        </p>
      </div>

      <div className="review-filters">
        <button className={filter === "pending" ? "active" : ""} onClick={() => setFilter("pending")}>
          待审核
        </button>
        <button className={filter === "approved" ? "active" : ""} onClick={() => setFilter("approved")}>
          已批准
        </button>
        <button className={filter === "rejected" ? "active" : ""} onClick={() => setFilter("rejected")}>
          已驳回
        </button>
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
          全部
        </button>
        {pendingCount > 0 && (
          <button className="bulk-action" onClick={bulkApprove}>
            全部批准
          </button>
        )}
      </div>

      {candidates.length === 0 ? (
        <div className="empty-state">
          <p>还没有候选片段。</p>
          <p className="hint">录制转写完成后，系统会自动生成候选片段。</p>
        </div>
      ) : (
        <div className="review-grid">
          <div className="candidate-list">
            {candidates.map((candidate) => (
              <div
                key={candidate.id}
                className={`candidate-card ${candidate.id === selectedId ? "selected" : ""} ${candidate.status}`}
                onClick={() => setSelectedId(candidate.id)}
              >
                <div className="card-header">
                  <span className="card-score">{candidate.score_total.toFixed(0)}</span>
                  <span className="card-time">
                    {formatTime(candidate.start_time)} - {formatTime(candidate.end_time)}
                  </span>
                </div>
                <div className="card-meta">
                  <span className="card-duration">{formatDuration(candidate.duration)}</span>
                  {candidate.llm_category && <span className="card-category">{candidate.llm_category}</span>}
                </div>
                {candidate.ai_highlight && <p className="card-highlight">{candidate.ai_highlight}</p>}
                {candidate.ai_title_suggestion && (
                  <p className="card-title">{candidate.ai_title_suggestion}</p>
                )}
                {candidate.llm_risk && <p className="card-risk">⚠️ {candidate.llm_risk}</p>}
                {candidate.status !== "pending" && (
                  <span className={`status-badge ${candidate.status}`}>
                    {candidate.status === "approved" ? "已批准" : "已驳回"}
                  </span>
                )}
              </div>
            ))}
          </div>

          {selected && (
            <div className="candidate-detail">
              <h2>片段详情</h2>

              <div className="detail-section">
                <h3>时间信息</h3>
                <p>
                  {formatTime(selected.start_time)} - {formatTime(selected.end_time)}（
                  {formatDuration(selected.duration)}）
                </p>
              </div>

              <div className="detail-section">
                <h3>评分详情</h3>
                <ScoreBar value={selected.score_danmaku} max={40} label="弹幕密度" color="blue" />
                <ScoreBar value={selected.score_interaction} max={30} label="付费互动" color="green" />
                <ScoreBar value={selected.score_transcript} max={20} label="关键词" color="yellow" />
                <ScoreBar value={selected.score_energy} max={10} label="能量" color="red" />
                <div className="total-score">
                  规则分: <strong>{selected.rule_score.toFixed(1)}</strong> → 最终分:{" "}
                  <strong>{selected.score_total.toFixed(1)}</strong>
                </div>
              </div>

              {selected.ai_title_suggestion && (
                <div className="detail-section">
                  <h3>推荐标题</h3>
                  <p className="ai-title">{selected.ai_title_suggestion}</p>
                </div>
              )}

              {selected.ai_reason && (
                <div className="detail-section">
                  <h3>推荐理由</h3>
                  <p>{selected.ai_reason}</p>
                </div>
              )}

              {selected.llm_risk && (
                <div className="detail-section risk-section">
                  <h3>⚠️ 风险提示</h3>
                  <p>{selected.llm_risk}</p>
                </div>
              )}

              {selected.status === "pending" && (
                <div className="detail-actions">
                  <button className="approve-button" onClick={() => approve(selected.id)}>
                    ✓ 批准
                  </button>
                  <button className="reject-button" onClick={() => reject(selected.id)}>
                    ✗ 驳回
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
