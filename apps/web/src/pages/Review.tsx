import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Candidate, CandidateDetail, ExportJob } from "../types";

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

// ── 评分组件 ──

const GRADE_COLORS: Record<string, string> = {
  S: "#f59e0b",
  A: "#22c55e",
  B: "#3b82f6",
  C: "#6b7280",
};

const GRADE_ORDER: Record<string, number> = { S: 4, A: 3, B: 2, C: 1 };

function ScoreBadge({ score, grade }: { score: number; grade: string }) {
  const color = GRADE_COLORS[grade] ?? GRADE_COLORS.C;
  return (
    <span
      className="score-badge"
      style={{ background: color, color: "#fff", fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 3, whiteSpace: "nowrap" }}
      title={`综合评分 ${score} 分 · ${grade}级`}
    >
      {score} · {grade}
    </span>
  );
}

function ScoreDetail({ detail }: { detail: string }) {
  let parsed: Record<string, number> | null = null;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.density !== "number") return null;

  const bars: { label: string; value: number; key: string }[] = [
    { label: "密度", value: parsed.density ?? 0, key: "density" },
    { label: "重复", value: parsed.repeat ?? 0, key: "repeat" },
    { label: "情绪", value: parsed.emotion ?? 0, key: "emotion" },
    { label: "加速", value: parsed.acceleration ?? 0, key: "acceleration" },
    { label: "SC", value: parsed.scWeight ?? 0, key: "scWeight" },
  ];

  return (
    <div className="score-detail" style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
      {bars.map((b) => (
        <div key={b.key} style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 10 }}>
          <span style={{ color: "var(--text-secondary)", width: 22 }}>{b.label}</span>
          <div className="bar-bg" style={{ width: 36, height: 3 }}>
            <div className="bar-fill accent" style={{ width: `${b.value}%` }} />
          </div>
          <span className="mono" style={{ fontSize: 10, width: 20 }}>{b.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Review() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<CandidateDetail | null>(null);
  const [draftRange, setDraftRange] = useState<{ start: number; end: number } | null>(null);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [sortBy, setSortBy] = useState<"time" | "score" | "grade">("score");
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [exportsExpanded, setExportsExpanded] = useState(false);
  const lastEvent = useEventStream();

  async function refresh() {
    const status = filter === "all" ? "" : `?status=${filter}`;
    const nextCandidates = await apiGet<Candidate[]>(`/api/candidates${status}`);
    setCandidates(nextCandidates);
    setSelectedId((current) => current ?? nextCandidates[0]?.id ?? null);
  }

  useEffect(() => {
    if (!lastEvent || lastEvent === "candidates.generated" || lastEvent === "candidates.updated") {
      void refresh();
    }
  }, [filter, lastEvent]);

  // Initial load when filter changes (no event needed)
  useEffect(() => {
    void refresh();
  }, [filter]);

  // 排序后的候选列表
  const sortedCandidates = useMemo(() => {
    const arr = [...candidates];
    switch (sortBy) {
      case "score":
        arr.sort((a, b) => b.score - a.score);
        break;
      case "grade":
        arr.sort((a, b) => (GRADE_ORDER[b.grade] ?? 0) - (GRADE_ORDER[a.grade] ?? 0) || b.score - a.score);
        break;
      case "time":
      default:
        arr.sort((a, b) => a.start_time - b.start_time);
        break;
    }
    return arr;
  }, [candidates, sortBy]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      setDraftRange(null);
      setExports([]);
      return;
    }

    void apiGet<CandidateDetail>(`/api/candidates/${selectedId}`).then((detail) => {
      setSelectedDetail(detail);
      setDraftRange({
        start: detail.start_time,
        end: detail.end_time,
      });
      // 加载该 session 的导出历史
      void apiGet<ExportJob[]>(`/api/exports?sessionId=${detail.session_id}&limit=20`).then(setExports);
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
        <span className="toolbar-sep" />
        <span className="toolbar-label">排序:</span>
        <button className={`filter-btn ${sortBy === "score" ? "active" : ""}`} onClick={() => setSortBy("score")}>
          ⭐ 评分
        </button>
        <button className={`filter-btn ${sortBy === "grade" ? "active" : ""}`} onClick={() => setSortBy("grade")}>
          🏷 评级
        </button>
        <button className={`filter-btn ${sortBy === "time" ? "active" : ""}`} onClick={() => setSortBy("time")}>
          ⏱ 时间
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
            {sortedCandidates.map((candidate) => (
              <div
                key={candidate.id}
                className={`candidate-card ${candidate.id === selectedId ? "selected" : ""} ${candidate.status}`}
                onClick={() => setSelectedId((current) => (current === candidate.id ? null : candidate.id))}
              >
                <div className="card-content">
                  <div className="card-header-row">
                    <span className="card-time mono">{formatTime(candidate.start_time)} - {formatTime(candidate.end_time)}</span>
                    <ScoreBadge score={candidate.score} grade={candidate.grade} />
                  </div>
                  <div className="card-meta">
                    <span>{formatDuration(candidate.duration)}</span>
                  </div>
                  {candidate.ai_description && <p className="card-highlight">{candidate.ai_description}</p>}
                  {candidate.score_detail && <ScoreDetail detail={candidate.score_detail} />}
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
                      title={`候选片段 #${selected.id}`}
                      previewStart={selected.start_time}
                      previewEnd={selected.end_time}
                      clipStart={activeRange.start}
                      clipEnd={activeRange.end}
                      danmaku={[]}
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
                </div>

                {selected.ai_description && (
                  <div className="detail-section">
                    <div className="detail-section-title">AI 描述</div>
                    <p>{selected.ai_description}</p>
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

                {/* 导出历史 */}
                <div className="detail-section" style={{ marginTop: 12 }}>
                  <button
                    className="detail-section-title"
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, width: "100%" }}
                    onClick={() => setExportsExpanded((v) => !v)}
                  >
                    <span>导出历史</span>
                    <span className="tag">{exports.length}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-secondary)" }}>
                      {exportsExpanded ? "收起" : "展开"}
                    </span>
                  </button>
                  {exportsExpanded && (
                    exports.length === 0 ? (
                      <p className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>该场次暂无导出记录</p>
                    ) : (
                      <table className="data-table" style={{ marginTop: 8, fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>状态</th>
                            <th>进度</th>
                            <th>输出路径</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exports.map((job) => (
                            <tr key={job.id}>
                              <td className="mono">#{job.id}</td>
                              <td className={job.status === "completed" ? "text-success" : job.status === "failed" ? "text-danger" : "text-muted"}>
                                {job.status}
                              </td>
                              <td>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <div className="bar-bg" style={{ width: 60, height: 4 }}>
                                    <div className="bar-fill accent" style={{ width: `${job.progress}%` }} />
                                  </div>
                                  <span className="mono" style={{ fontSize: 11 }}>{job.progress}%</span>
                                </div>
                              </td>
                              <td className="text-muted" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {job.output_path || "-"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  )}
                </div>
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
