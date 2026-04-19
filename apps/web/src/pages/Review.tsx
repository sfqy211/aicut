import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { CandidateCard } from "../components/CandidateCard";
import type { Candidate } from "../types";

export function Review() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  async function refresh() {
    setCandidates(await apiGet<Candidate[]>("/api/candidates?status=pending"));
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function approve(id: number) {
    await apiPost(`/api/candidates/${id}/approve`, {});
    await refresh();
  }

  async function reject(id: number) {
    await apiPost(`/api/candidates/${id}/reject`, {});
    await refresh();
  }

  return (
    <section className="review-layout">
      <div className="section-header">
        <span className="eyebrow">Review Queue</span>
        <h1>候选审核</h1>
        <p>这里会放置播放器、转写、弹幕热度和候选卡片。当前骨架先接通候选查询与审核动作。</p>
      </div>
      <div className="player-shell">
        <div className="player-placeholder">媒体预览区</div>
        <div className="timeline-placeholder">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="candidate-list">
        {candidates.length === 0 ? (
          <p className="empty">还没有待审核候选。转写和分析队列接入后会自动出现。</p>
        ) : (
          candidates.map((candidate) => (
            <CandidateCard key={candidate.id} candidate={candidate} onApprove={approve} onReject={reject} />
          ))
        )}
      </div>
    </section>
  );
}
