import { Scissors, ArrowRight } from "lucide-react";
import type { Candidate, ClipSelection } from "../../types";

export type CandidatePanelProps = {
  candidates: Candidate[];
  loading: boolean;
  selection: ClipSelection | null;
  isExporting?: boolean;
  onSelect: (candidate: Candidate) => void;
  onExport: () => void;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function CandidatePanel({
  candidates,
  loading,
  selection,
  isExporting,
  onSelect,
  onExport,
}: CandidatePanelProps) {
  if (loading) {
    return (
      <div style={{ padding: 16, color: "#8a8a8c", fontSize: 12 }}>
        加载候选片段...
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div style={{ padding: 16, color: "#8a8a8c", fontSize: 12 }}>
        暂无候选片段
      </div>
    );
  }

  const hasSelection = selection && selection.end > selection.start;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#141416",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid #2a2a2c",
          fontSize: 12,
          fontWeight: 600,
          color: "#b0b0b0",
        }}
      >
        <span>AI 候选片段 ({candidates.length})</span>
        {hasSelection && (
          <button
            onClick={onExport}
            disabled={isExporting}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 500,
              color: "#fff",
              background: isExporting ? "#3a8c4f" : "#4ade80",
              border: "none",
              borderRadius: 4,
              cursor: isExporting ? "not-allowed" : "pointer",
              opacity: isExporting ? 0.8 : 1,
            }}
          >
            <Scissors size={12} />
            {isExporting ? "导出中..." : "导出选区"}
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {candidates.map((c, idx) => {
          const isSelected =
            selection?.candidateId === c.id ||
            (selection &&
              Math.abs(selection.start - c.start_time) < 1 &&
              Math.abs(selection.end - c.end_time) < 1);

          return (
            <button
              key={c.id}
              onClick={() => onSelect(c)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 12px",
                textAlign: "left",
                background: isSelected
                  ? "rgba(232, 179, 57, 0.08)"
                  : idx % 2 === 0
                    ? "#1a1a1c"
                    : "#161618",
                border: "none",
                borderLeft: isSelected ? "2px solid #e8b339" : "2px solid transparent",
                cursor: "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "#222224";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = isSelected
                  ? "rgba(232, 179, 57, 0.08)"
                  : idx % 2 === 0
                    ? "#1a1a1c"
                    : "#161618";
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: "#f0f0f0",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {c.ai_description || `候选片段 #${c.id}`}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    marginTop: 4,
                    fontSize: 10,
                    color: "#8a8a8c",
                  }}
                >
                  <span className="mono">
                    {formatTime(c.start_time)} <ArrowRight size={10} /> {formatTime(c.end_time)}
                  </span>
                  <span style={{ marginLeft: "auto" }}>{Math.round(c.duration)}s</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
