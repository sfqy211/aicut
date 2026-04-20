import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Candidate, CandidateDetail } from "../types";

const ClipPlayer = lazy(async () => {
  const module = await import("../components/Player/ClipPlayer");
  return { default: module.ClipPlayer };
});

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
      <div className="bar-bg">
        <div className={`bar-fill ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="score-value mono">{value.toFixed(0)}</span>
    </div>
  );
}

export function Review() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<CandidateDetail | null>(null);
  const [draftRange, setDraftRange] = useState<{ start: number; end: number } | null>(null);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const lastEvent = useEventStream();

  async function refresh() {
    const status = filter === "all" ? "" : `?status=${filter}`;
    const nextCandidates = await apiGet<Candidate[]>(`/api/candidates${status}`);
    setCandidates(nextCandidates);
    setSelectedId((current) => current ?? nextCandidates[0]?.id ?? null);
  }

  useEffect(() => {
    void refresh();
  }, [filter, lastEvent]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      setDraftRange(null);
      return;
    }

    void apiGet<CandidateDetail>(`/api/candidates/${selectedId}`).then((detail) => {
      setSelectedDetail(detail);
      setDraftRange({
        start: detail.start_time,
        end: detail.end_time,
      });
    });
  }, [selectedId, lastEvent]);

  async function approve(id: number) {
    await apiPost(`/api/candidates/${id}/approve`, {});
    await refresh();
  }

  async function reject(id: number) {
    await apiPost(`/api/candidates/${id}/reject`, {});
    await refresh();
  }

  async function bulkApprove() {
    const pendingIds = candidates.filter((candidate) => candidate.status === "pending").map((candidate) => candidate.id);
    if (pendingIds.length === 0) return;
    await apiPost("/api/candidates/bulk-approve", { ids: pendingIds });
    await refresh();
  }

  const selected = selectedDetail;
  const activeRange = draftRange && selected
    ? draftRange
    : selected
      ? { start: selected.start_time, end: selected.end_time }
      : null;
  const pendingCount = candidates.filter((candidate) => candidate.status === "pending").length;
  const previewUrl = selected?.preview_url
    ? `${selected.preview_url}&stamp=${selected.updated_at ?? selected.created_at}`
    : null;

  const playerDanmaku = useMemo(() => {
    if (!selected) return [];
    return [selected.ai_highlight, selected.ai_title_suggestion, selected.ai_reason].filter(
      (item): item is string => Boolean(item)
    );
  }, [selected]);

  return (
    <div className="review-layout">
      <div className="review-toolbar">
        <button className={`filter-btn ${filter === "pending" ? "active" : ""}`} onClick={() => setFilter("pending")}>
          待审核 ({pendingCount})
        </button>
        <button className={`filter-btn ${filter === "approved" ? "active" : ""}`} onClick={() => setFilter("approved")}>
          已批准
        </button>
        <button className={`filter-btn ${filter === "rejected" ? "active" : ""}`} onClick={() => setFilter("rejected")}>
          已驳回
        </button>
        <button className={`filter-btn ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
          全部
        </button>
        {pendingCount > 0 && (
          <button className="btn btn-sm bulk-action" onClick={bulkApprove}>
            全部批准
          </button>
        )}
      </div>

      {candidates.length === 0 ? (
        <div className="panel">
          <div className="panel-body text-muted">暂无候选片段</div>
        </div>
      ) : (
        <div className="review-grid review-grid-player">
          <div className="candidate-list">
            {candidates.map((candidate) => (
              <div
                key={candidate.id}
                className={`candidate-card ${candidate.id === selectedId ? "selected" : ""} ${candidate.status}`}
                onClick={() => setSelectedId((current) => (current === candidate.id ? null : candidate.id))}
              >
                <div className="card-score">
                  <span className="card-score-value mono">{candidate.score_total.toFixed(0)}</span>
                  <span className="card-score-label">分</span>
                </div>
                <div className="card-content">
                  <span className="card-time mono">{formatTime(candidate.start_time)} - {formatTime(candidate.end_time)}</span>
                  <div className="card-meta">
                    <span>{formatDuration(candidate.duration)}</span>
                    {candidate.llm_category && <span className="card-category">{candidate.llm_category}</span>}
                  </div>
                  {candidate.ai_highlight && <p className="card-highlight">{candidate.ai_highlight}</p>}
                  {candidate.ai_title_suggestion && <p className="card-title">{candidate.ai_title_suggestion}</p>}
                  {candidate.llm_risk && <p className="card-risk">风险: {candidate.llm_risk}</p>}
                  {candidate.status !== "pending" && (
                    <span className={`status-badge ${candidate.status}`}>
                      {candidate.status === "approved" ? "已批准" : "已驳回"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="candidate-detail candidate-detail-wide">
            {selected && activeRange ? (
              <>
                <div className="candidate-detail-title">预览与审核</div>

                {previewUrl ? (
                  <Suspense fallback={<div className="panel-body text-muted">播放器加载中...</div>}>
                    <ClipPlayer
                      src={previewUrl}
                      title={selected.ai_title_suggestion || `候选片段 #${selected.id}`}
                      previewStart={selected.preview_start_time ?? selected.start_time}
                      previewEnd={selected.preview_end_time ?? selected.end_time}
                      clipStart={activeRange.start}
                      clipEnd={activeRange.end}
                      danmaku={playerDanmaku}
                      onRangeChange={setDraftRange}
                    />
                  </Suspense>
                ) : (
                  <div className="panel-body text-muted">当前候选缺少可预览的视频分段</div>
                )}

                <div className="detail-section detail-section-grid">
                  <div>
                    <div className="detail-section-title">时间信息</div>
                    <p>{formatTime(selected.start_time)} - {formatTime(selected.end_time)}（{formatDuration(selected.duration)}）</p>
                    <p className="text-muted">
                      预览调整: {formatTime(activeRange.start)} - {formatTime(activeRange.end)}
                    </p>
                  </div>
                  <div>
                    <div className="detail-section-title">预览源</div>
                    <p className="text-muted">{selected.segment_file_path || "缺少源文件"}</p>
                  </div>
                </div>

                <div className="detail-section">
                  <div className="detail-section-title">评分详情</div>
                  <ScoreBar value={selected.score_danmaku} max={40} label="弹幕密度" color="accent" />
                  <ScoreBar value={selected.score_interaction} max={30} label="付费互动" color="success" />
                  <ScoreBar value={selected.score_transcript} max={20} label="关键词" color="warning" />
                  <ScoreBar value={selected.score_energy} max={10} label="能量" color="danger" />
                  <div className="total-score">
                    规则分: <strong className="mono">{selected.rule_score.toFixed(1)}</strong> → 最终分: <strong className="mono">{selected.score_total.toFixed(1)}</strong>
                  </div>
                </div>

                {selected.ai_title_suggestion && (
                  <div className="detail-section">
                    <div className="detail-section-title">推荐标题</div>
                    <p style={{ fontWeight: 500 }}>{selected.ai_title_suggestion}</p>
                  </div>
                )}

                {selected.ai_reason && (
                  <div className="detail-section">
                    <div className="detail-section-title">推荐理由</div>
                    <p>{selected.ai_reason}</p>
                  </div>
                )}

                {selected.llm_risk && (
                  <div className="detail-section risk-section">
                    <div className="detail-section-title" style={{ color: "var(--danger)" }}>风险提示</div>
                    <p>{selected.llm_risk}</p>
                  </div>
                )}

                <div className="detail-section preview-note">
                  <div className="detail-section-title">说明</div>
                  <p>当前入出点调整仅用于预览判断，尚未写回候选数据库。</p>
                </div>

                {selected.status === "pending" && (
                  <div className="detail-actions">
                    <button className="btn btn-approve" onClick={() => approve(selected.id)}>批准</button>
                    <button className="btn btn-reject" onClick={() => reject(selected.id)}>驳回</button>
                  </div>
                )}
              </>
            ) : (
              <div className="panel-body text-muted">点击左侧候选片段展开播放器</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
