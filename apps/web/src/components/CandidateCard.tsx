import { Check, Clock, Scissors, X } from "lucide-react";
import type { Candidate } from "../types";

type Props = {
  candidate: Candidate;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
};

function formatTime(seconds: number) {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export function CandidateCard({ candidate, onApprove, onReject }: Props) {
  return (
    <article className="candidate-card">
      <div className="candidate-main">
        <div className="candidate-title">
          <Scissors size={18} />
          <strong>{`候选片段 #${candidate.id}`}</strong>
        </div>
        <p>{candidate.ai_description || "等待 AI 描述生成"}</p>
        <div className="candidate-meta">
          <span>
            <Clock size={14} />
            {formatTime(candidate.start_time)} - {formatTime(candidate.end_time)}
          </span>
          <span>{candidate.duration}s</span>
          <span className={`status-pill ${candidate.status}`}>{candidate.status}</span>
        </div>
      </div>
      <div className="candidate-actions">
        <button className="approve" onClick={() => onApprove(candidate.id)}>
          <Check size={16} />
          保留
        </button>
        <button className="reject" onClick={() => onReject(candidate.id)}>
          <X size={16} />
          驳回
        </button>
      </div>
    </article>
  );
}
