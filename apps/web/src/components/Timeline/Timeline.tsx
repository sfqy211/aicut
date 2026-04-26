import { useMemo, useRef, useCallback } from "react";
import type { Candidate, ClipSelection } from "../../types";

export type TimelineProps = {
  duration: number;
  currentTime: number;
  candidates: Candidate[];
  selection: ClipSelection | null;
  onSeek: (time: number) => void;
  onSelectCandidate: (candidate: Candidate) => void;
};

export function Timeline({
  duration,
  currentTime,
  candidates,
  selection,
  onSeek,
  onSelectCandidate,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scale = 1;

  const timeToPercent = useCallback(
    (t: number) => {
      if (duration <= 0) return 0;
      return Math.min(100, Math.max(0, (t / duration) * 100));
    },
    [duration]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el || duration <= 0) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      onSeek(ratio * duration);
    },
    [duration, onSeek]
  );

  const ticks = useMemo(() => {
    if (duration <= 0) return [];
    const maxTicks = 12;
    const interval = Math.max(30, Math.ceil(duration / maxTicks / 30) * 30);
    const arr: number[] = [];
    for (let t = 0; t < duration; t += interval) {
      arr.push(t);
    }
    return arr;
  }, [duration]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const candidateColor = (score: number) => {
    if (score >= 80) return "rgba(232, 179, 57, 0.65)";
    if (score >= 60) return "rgba(212, 146, 58, 0.55)";
    return "rgba(139, 105, 20, 0.45)";
  };

  return (
    <div
      style={{
        height: 96,
        background: "#141416",
        borderTop: "1px solid #2a2a2c",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
      }}
    >
      {/* 候选色带层 */}
      <div
        ref={containerRef}
        onClick={handleClick}
        style={{
          position: "relative",
          flex: 1,
          overflow: "hidden",
          cursor: "pointer",
          width: `${100 * scale}%`,
          minWidth: "100%",
        }}
      >
        {/* 时间刻度 */}
        {ticks.map((t) => (
          <div
            key={t}
            style={{
              position: "absolute",
              left: `${timeToPercent(t)}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: "#2a2a2c",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: 4,
                fontSize: 10,
                color: "#8a8a8c",
                whiteSpace: "nowrap",
              }}
            >
              {formatTime(t)}
            </span>
          </div>
        ))}

        {/* 候选区间条 */}
        <div style={{ position: "absolute", top: 20, left: 0, right: 0, height: 18 }}>
          {candidates.map((c) => (
            <button
              key={c.id}
              onClick={(e) => {
                e.stopPropagation();
                onSelectCandidate(c);
              }}
              title={`${c.ai_title_suggestion || "候选片段"} (${formatTime(c.start_time)} - ${formatTime(c.end_time)})`}
              style={{
                position: "absolute",
                left: `${timeToPercent(c.start_time)}%`,
                width: `${timeToPercent(c.end_time) - timeToPercent(c.start_time)}%`,
                height: "100%",
                background: candidateColor(c.score_total),
                border: "none",
                borderRadius: 2,
                cursor: "pointer",
                minWidth: 2,
              }}
            />
          ))}
        </div>

        {/* 用户选区条 */}
        {selection && (
          <div style={{ position: "absolute", top: 42, left: 0, right: 0, height: 14 }}>
            <div
              style={{
                position: "absolute",
                left: `${timeToPercent(selection.start)}%`,
                width: `${timeToPercent(selection.end) - timeToPercent(selection.start)}%`,
                height: "100%",
                background: "rgba(74, 222, 128, 0.45)",
                borderRadius: 2,
              }}
            />
            {/* 起点竖线 */}
            <div
              style={{
                position: "absolute",
                left: `${timeToPercent(selection.start)}%`,
                top: -2,
                bottom: -2,
                width: 2,
                background: "#4ade80",
              }}
            />
            {/* 终点竖线 */}
            <div
              style={{
                position: "absolute",
                left: `${timeToPercent(selection.end)}%`,
                top: -2,
                bottom: -2,
                width: 2,
                background: "#4ade80",
              }}
            />
          </div>
        )}

        {/* 播放头 */}
        <div
          style={{
            position: "absolute",
            left: `${timeToPercent(currentTime)}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: "#fff",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -2,
              left: -4,
              width: 0,
              height: 0,
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "5px solid #fff",
            }}
          />
        </div>
      </div>

      {/* 底部信息条 */}
      <div
        style={{
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 8px",
          fontSize: 11,
          color: "#8a8a8c",
          borderTop: "1px solid #2a2a2c",
        }}
      >
        <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
        {selection && (
          <span style={{ color: "#4ade80" }}>
            选区: {formatTime(selection.start)} - {formatTime(selection.end)} ({formatTime(selection.end - selection.start)})
          </span>
        )}
      </div>
    </div>
  );
}
