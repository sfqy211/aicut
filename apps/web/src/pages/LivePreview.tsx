import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Mosaic,
  MosaicWindow,
  MosaicContext,
  MosaicWindowContext,
  getLeaves,
  updateTree,
  createRemoveUpdate,
} from "react-mosaic-component";
import type { MosaicNode, MosaicPath } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { X, Eye, Play, Pause, Maximize, Minimize } from "lucide-react";
import { apiPost } from "../api/client";
import { useDanmaku } from "../hooks/useDanmaku";
import { useSessionFull } from "../hooks/useSessionFull";
import { CandidatePanel } from "../components/CandidatePanel/CandidatePanel";
import type { DanmakuEvent, LiveTranscriptChunk, SessionDetail, Candidate, ClipSelection } from "../types";

// ── 弹幕密度小图 ──

function DanmakuDensityChart({
  events,
  candidates,
  currentTime,
  windowSec = 300,
}: {
  events: DanmakuEvent[];
  candidates: Candidate[];
  currentTime: number;
  windowSec?: number;
}) {
  const bucketSec = 10;
  const buckets = Math.ceil(windowSec / bucketSec);
  const counts = new Array(buckets).fill(0);

  // 收集当前窗口内的弹幕密度
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const nowMs = lastEvent ? lastEvent.timestamp_ms : Date.now();
  const nowEpochSec = Math.floor(nowMs / 1000);
  for (const ev of events) {
    const ageSec = (nowMs - ev.timestamp_ms) / 1000;
    const bucket = Math.floor((windowSec - ageSec) / bucketSec);
    if (bucket >= 0 && bucket < buckets) {
      counts[bucket]++;
    }
  }

  const maxCount = Math.max(1, ...counts);
  const mean = counts.reduce((a, b) => a + b, 0) / buckets;
  const threshold = mean * 2; // 简化的 Z-score 可视化

  // 候选区间高亮
  const candidateRanges = candidates
    .filter((c) => {
      // candidate.start_time 是绝对纪元秒，检查是否在图表窗口内
      const ageSec = nowEpochSec - c.start_time;
      return ageSec >= 0 && ageSec <= windowSec;
    })
    .map((c) => {
      const ageSec = nowEpochSec - c.start_time;
      const durSec = c.duration || 0;
      const leftRatio = (windowSec - ageSec) / windowSec;
      const widthRatio = Math.min(durSec / windowSec, 1 - leftRatio);
      return { id: c.id, grade: c.grade, leftRatio, widthRatio };
    });

  const width = 240;
  const height = 36;
  const barW = (width - 4) / buckets;

  return (
    <div className="density-mini-chart" style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
      <svg width={width} height={height} style={{ display: "block" }}>
        {/* 阈值线 */}
        <line
          x1={0} y1={height - (threshold / maxCount) * height}
          x2={width} y2={height - (threshold / maxCount) * height}
          stroke="var(--text-secondary)" strokeWidth={0.5} strokeDasharray="3,2" opacity={0.5}
        />
        {/* 柱状图 */}
        {counts.map((c, i) => (
          <rect
            key={i}
            x={i * barW + 1}
            y={height - (c / maxCount) * height}
            width={Math.max(1, barW - 2)}
            height={(c / maxCount) * height}
            fill={c >= threshold ? "var(--warning, #f59e0b)" : "var(--text-secondary)"}
            opacity={c >= threshold ? 0.9 : 0.3}
            rx={1}
          />
        ))}
        {/* 候选区间高亮 */}
        {candidateRanges.map((r) => {
          const gradeColor = r.grade === "S" ? "#f59e0b" : r.grade === "A" ? "#22c55e" : "#3b82f6";
          return (
            <rect
              key={r.id}
              x={r.leftRatio * width}
              y={0}
              width={Math.max(2, r.widthRatio * width)}
              height={height}
              fill={gradeColor}
              opacity={0.15}
              rx={2}
            />
          );
        })}
      </svg>
      <div className="mono" style={{ fontSize: 9, display: "flex", justifyContent: "space-between", color: "var(--text-secondary)", marginTop: 1 }}>
        <span>-{Math.floor(windowSec / 60)}min</span>
        {candidateRanges.length > 0 && (
          <span style={{ color: "var(--warning, #f59e0b)" }}>
            {candidateRanges.length} 候选
          </span>
        )}
        <span>now</span>
      </div>
    </div>
  );
}

function VideoProgressBar({
  currentTime,
  duration,
  danmakuEvents,
  sessionStartTime,
  candidates,
  selection,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  danmakuEvents: DanmakuEvent[];
  sessionStartTime: number;
  candidates: Candidate[];
  selection: ClipSelection | null;
  onSeek: (time: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const formatTime = useCallback((seconds: number) => {
    const safe = Math.max(0, seconds);
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = Math.floor(safe % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, []);

  const densityPoints = useMemo(() => {
    if (duration <= 0) return [] as { ts: number; count: number }[];
    const bucketSec = 5;
    const bucketCount = Math.max(1, Math.ceil(duration / bucketSec));
    const counts = new Array(bucketCount).fill(0);
    for (const ev of danmakuEvents) {
      const relativeSec = ev.timestamp_ms / 1000 - sessionStartTime;
      if (relativeSec < 0 || relativeSec > duration) continue;
      const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(relativeSec / bucketSec)));
      counts[bucket] += 1;
    }
    return counts.map((count, i) => ({ ts: i * bucketSec, count }));
  }, [danmakuEvents, duration, sessionStartTime]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !containerWidth || duration <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const scale = window.devicePixelRatio || 1;
    const width = containerWidth;
    const height = 18;
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (densityPoints.length === 0) return;
    const maxCount = Math.max(1, ...densityPoints.map((p) => p.count));
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (const point of densityPoints) {
      const x = (point.ts / duration) * width;
      const y = height - (point.count / maxCount) * (height - 2);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = "rgba(245, 166, 39, 0.35)";
    ctx.fill();
    ctx.strokeStyle = "rgba(245, 166, 39, 0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [containerWidth, densityPoints, duration]);

  const getTimeFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return (x / rect.width) * duration;
  }, [duration]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    e.preventDefault();
    const time = getTimeFromClientX(e.clientX);
    onSeek(time);
    setDragging(true);
  }, [duration, getTimeFromClientX, onSeek]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => onSeek(getTimeFromClientX(e.clientX));
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, getTimeFromClientX, onSeek]);

  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;

  return (
    <div
      ref={containerRef}
      className="video-progress-bar"
      onMouseDown={handleMouseDown}
      onMouseMove={(e) => {
        if (duration <= 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        setHover({ x, time: (x / rect.width) * duration });
      }}
      onMouseLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} className="video-progress-canvas" />

      {candidates.map((c) => {
        if (duration <= 0 || !sessionStartTime) return null;
        const start = c.start_time - sessionStartTime;
        const end = c.end_time - sessionStartTime;
        if (end <= 0 || start >= duration) return null;
        const left = (Math.max(0, start) / duration) * 100;
        const width = ((Math.min(duration, end) - Math.max(0, start)) / duration) * 100;
        const color = c.grade === "S" ? "rgba(245, 166, 39, 0.18)" : c.grade === "A" ? "rgba(34, 197, 94, 0.16)" : "rgba(59, 130, 246, 0.14)";
        return <div key={c.id} className="video-progress-range" style={{ left: `${left}%`, width: `${width}%`, background: color }} />;
      })}

      {selection && duration > 0 && (
        <div
          className="video-progress-range video-progress-selection"
          style={{
            left: `${Math.max(0, (selection.start / duration) * 100)}%`,
            width: `${Math.max(0, ((selection.end - selection.start) / duration) * 100)}%`,
          }}
        />
      )}

      <div className="video-progress-fill" style={{ width: `${progress * 100}%` }} />
      <div className="video-progress-playhead" style={{ left: `${progress * 100}%` }} />

      <div className="video-progress-time mono">
        {duration > 0 ? `${formatTime(currentTime)} / ${formatTime(duration)}` : "--:-- / --:--"}
      </div>

      {hover && duration > 0 && (
        <div className="video-progress-tooltip" style={{ left: `${hover.x}px` }}>
          {formatTime(hover.time)}
        </div>
      )}
    </div>
  );
}

type PanelKey = "video" | "subtitles" | "danmaku" | "candidates";

const PANEL_TITLES: Record<PanelKey, string> = {
  video: "直播画面",
  subtitles: "转录字幕",
  danmaku: "弹幕与互动",
  candidates: "候选片段",
};

const ALL_PANELS: PanelKey[] = ["video", "subtitles", "danmaku", "candidates"];

const DEFAULT_LAYOUT: MosaicNode<PanelKey> = {
  type: "split",
  direction: "row",
  children: [
    {
      type: "split",
      direction: "column",
      children: ["video", "subtitles"],
      splitPercentages: [60, 40],
    },
    {
      type: "split",
      direction: "column",
      children: ["danmaku", "candidates"],
      splitPercentages: [70, 30],
    },
  ],
  splitPercentages: [60, 40],
};

type Props = {
  sessionId: number | null;
};

export function LivePreview({ sessionId }: Props) {
  const [layout, setLayout] = useState<MosaicNode<PanelKey> | null>(DEFAULT_LAYOUT);
  const [hiddenPanels, setHiddenPanels] = useState<Set<PanelKey>>(new Set());

  const playerRef = useRef<HTMLVideoElement | null>(null);
  const subtitleListRef = useRef<HTMLDivElement | null>(null);
  const danmakuListRef = useRef<HTMLDivElement | null>(null);

  const [isLiveMode, setIsLiveMode] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [subtitles, setSubtitles] = useState<LiveTranscriptChunk[]>([]);
  const [liveSubtitle, setLiveSubtitle] = useState<LiveTranscriptChunk | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [danmakuFilter, setDanmakuFilter] = useState<string>("all");
  const [userScrolledDanmaku, setUserScrolledDanmaku] = useState(false);
  const [timeMode, setTimeMode] = useState<"relative" | "absolute">("relative");
  const danmakuAutoScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isRecording = sessionDetail?.session.status === "recording";

  // 回放模式：按播放位置加载弹幕时间窗口 (±5 分钟)
  // 直播模式：全量加载 + SSE 实时推送
  const danmakuTimeWindow = useMemo(() => {
    if (isRecording || !sessionDetail?.session.start_time) return undefined;
    return {
      currentTime,
      sessionStartSec: sessionDetail.session.start_time,
    };
  }, [isRecording, currentTime, sessionDetail?.session.start_time]);

  const { events: danmakuEvents, loading: danmakuLoading } = useDanmaku(
    sessionId,
    danmakuTimeWindow
  );
  const { data: fullData, isLoading: fullLoading } = useSessionFull(sessionId);

  const candidates = fullData?.candidates ?? [];
  const candidatesLoading = fullLoading;

  const [selection, setSelection] = useState<ClipSelection | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  // 从 batch 端点的数据中提取 session 详情和解析字幕
  useEffect(() => {
    if (!fullData) {
      setSessionDetail(null);
      setSubtitles([]);
      setLiveSubtitle(null);
      return;
    }
    setSessionDetail({ session: fullData.session, transcript: fullData.transcript, segments: [], candidates: fullData.candidates } satisfies SessionDetail);
    try {
      const raw = fullData.transcript?.segments_json;
      if (raw) {
        const parsed = JSON.parse(raw) as LiveTranscriptChunk[];
        if (Array.isArray(parsed)) {
          const sessionStart = fullData.session.start_time ?? 0;
          const relative = parsed
            .map((s) => ({ ...s, start: s.start - sessionStart, end: s.end - sessionStart }))
            .filter((s) => s.start >= 0);
          setSubtitles(relative);
        }
      }
    } catch {
      // ignore
    }
  }, [fullData]);

  const hlsUrl = sessionId != null ? `/api/sessions/${sessionId}/hls/playlist.m3u8` : "";

  // HLS 初始化
  useEffect(() => {
    if (!hlsUrl) return;
    const video = playerRef.current;
    if (!video) return;
    let hls: any;
    const init = async () => {
      const Hls = (await import("hls.js")).default;
      if (Hls.isSupported()) {
        if (isRecording) {
          // 直播模式：低延迟配置
          hls = new Hls({
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 5,
            maxBufferLength: 10,
          });
        } else {
          // 回放模式：预加载配置，支持快速 seek
          hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            startFragPrefetch: true,
            enableWorker: true,
          });
        }
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!isRecording) {
            // 回放模式不自动播放，从头开始
            video.currentTime = 0;
          } else {
            video.play().catch(() => {});
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsUrl;
        video.play().catch(() => {});
      }
    };
    void init();

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      let dur = 0;
      if (video.duration && video.duration !== Infinity && video.duration > 0) {
        dur = video.duration;
      } else {
        const seekable = video.seekable;
        if (seekable.length > 0) {
          dur = seekable.end(seekable.length - 1) - seekable.start(0);
        }
      }
      if (dur > 0) setVideoDuration(dur);
      if (isLiveMode) {
        const seekable = video.seekable;
        if (seekable.length > 0) {
          const liveEdge = seekable.end(seekable.length - 1);
          if (liveEdge - video.currentTime > 10) setIsLiveMode(false);
        }
      }
    };
    const onSeeking = () => {
      const seekable = video.seekable;
      if (seekable.length > 0) {
        const liveEdge = seekable.end(seekable.length - 1);
        if (video.currentTime < liveEdge - 5) setIsLiveMode(false);
      }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", onSeeking);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeking", onSeeking);
      if (hls) hls.destroy();
    };
  }, [hlsUrl, isLiveMode]);

  // SSE 实时字幕
  useEffect(() => {
    if (sessionId == null) return;
    const events = new EventSource("/api/events/stream");
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "session.transcription_live" && data.payload?.sessionId === sessionId) {
          const chunk = data.payload?.chunk as LiveTranscriptChunk | undefined;
          if (chunk) {
            // 将绝对纪元秒转为相对时间
            const sessionStart = sessionDetail?.session.start_time ?? 0;
            const relativeChunk = {
              ...chunk,
              start: chunk.start - sessionStart,
              end: chunk.end - sessionStart,
            };
            setLiveSubtitle(relativeChunk);
            setSubtitles((prev) => {
              const next = [...prev];
              const existingIndex = next.findIndex((s) => s.start === relativeChunk.start);
              if (existingIndex >= 0) {
                next[existingIndex] = relativeChunk;
              } else {
                next.push(relativeChunk);
                next.sort((a, b) => a.start - b.start);
              }
              if (next.length > 500) return next.slice(next.length - 500);
              return next;
            });
          }
        }
      } catch {
        // ignore
      }
    };
    events.addEventListener("session.transcription_live", handler);
    return () => {
      events.removeEventListener("session.transcription_live", handler);
      events.close();
    };
  }, [sessionId, sessionDetail]);

  // 字幕列表自动滚动
  useEffect(() => {
    if (subtitleListRef.current && isLiveMode) {
      subtitleListRef.current.scrollTop = subtitleListRef.current.scrollHeight;
    }
  }, [subtitles, isLiveMode]);

  // 当前活跃字幕
  const activeSubtitle = useMemo(() => {
    if (isLiveMode) return liveSubtitle;
    const list = subtitles;
    let left = 0;
    let right = list.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const seg = list[mid];
      if (!seg) break;
      if (seg.start <= currentTime && currentTime <= seg.end) return seg;
      if (currentTime < seg.start) right = mid - 1;
      else left = mid + 1;
    }
    return null;
  }, [currentTime, isLiveMode, liveSubtitle, subtitles]);

  const handleBackToLive = useCallback(() => {
    const video = playerRef.current;
    if (!video) return;
    const seekable = video.seekable;
    if (seekable.length > 0) {
      video.currentTime = seekable.end(seekable.length - 1) - 3;
    }
    setIsLiveMode(true);
  }, []);

  const handleSeekToSubtitle = useCallback((sub: LiveTranscriptChunk) => {
    const video = playerRef.current;
    if (!video) return;
    // sub.start 已经是相对时间（从 session 开始的偏移秒数）
    video.currentTime = sub.start;
    setIsLiveMode(false);
  }, []);

  // 弹幕筛选
  const filteredDanmaku = useMemo(() => {
    if (danmakuFilter === "all") return danmakuEvents;
    return danmakuEvents.filter((e) => e.event_type === danmakuFilter);
  }, [danmakuEvents, danmakuFilter]);

  // 弹幕自动滚动
  useEffect(() => {
    if (danmakuListRef.current && !userScrolledDanmaku) {
      danmakuListRef.current.scrollTop = danmakuListRef.current.scrollHeight;
    }
  }, [filteredDanmaku, userScrolledDanmaku]);

  const handleDanmakuScroll = useCallback(() => {
    const el = danmakuListRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (!isAtBottom) {
      setUserScrolledDanmaku(true);
      if (danmakuAutoScrollTimer.current) clearTimeout(danmakuAutoScrollTimer.current);
      danmakuAutoScrollTimer.current = setTimeout(() => setUserScrolledDanmaku(false), 3000);
    }
  }, []);

  // 相对时间：MM:SS（从 session 开始的偏移）
  const formatRelative = useCallback((seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, []);

  // 绝对时间：HH:mm:ss（中国时间）
  const formatAbsolute = useCallback((epochMs: number) => {
    const d = new Date(epochMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }, []);

  // 字幕时间：start 是绝对纪元秒
  // 字幕时间：sub.start 已是相对秒数
  const formatTime = useCallback(
    (seconds: number) => {
      if (timeMode === "absolute") {
        const sessionStart = sessionDetail?.session.start_time;
        if (sessionStart) return formatAbsolute((sessionStart + seconds) * 1000);
      }
      return formatRelative(seconds);
    },
    [timeMode, formatAbsolute, formatRelative, sessionDetail]
  );

  // 弹幕时间：timestamp_ms 是绝对 epoch 毫秒
  const formatMs = useCallback(
    (ms: number) => {
      if (timeMode === "absolute") return formatAbsolute(ms);
      // 相对模式：需要减去 session 开始时间
      const sessionStart = sessionDetail?.session.start_time;
      if (sessionStart) return formatRelative((ms / 1000) - sessionStart);
      return formatAbsolute(ms);
    },
    [timeMode, formatAbsolute, formatRelative, sessionDetail]
  );

  // 时间轴跳转
  const handleSeek = useCallback((time: number) => {
    const video = playerRef.current;
    if (!video) return;
    video.currentTime = time;
    setIsLiveMode(false);
  }, []);

  // 选中候选片段
  const handleSelectCandidate = useCallback((candidate: Candidate) => {
    const video = playerRef.current;
    if (!video) return;
    video.currentTime = candidate.start_time;
    setIsLiveMode(false);
    setSelection({
      start: candidate.start_time,
      end: candidate.end_time,
      candidateId: candidate.id,
    });
  }, []);

  // 切片快捷键
  const handleSetClipStart = useCallback(() => {
    const video = playerRef.current;
    if (!video) return;
    const start = video.currentTime;
    setSelection((prev) => {
      const end = prev && prev.end > start ? prev.end : video.duration || start + 30;
      return { start, end };
    });
  }, []);

  const handleSetClipEnd = useCallback(() => {
    const video = playerRef.current;
    if (!video) return;
    const end = video.currentTime;
    setSelection((prev) => {
      const start = prev && prev.start < end ? prev.start : 0;
      return { start, end };
    });
  }, []);

  const handleSeekToClipStart = useCallback(() => {
    if (selection) handleSeek(selection.start);
  }, [selection, handleSeek]);

  const handleSeekToClipEnd = useCallback(() => {
    if (selection) handleSeek(selection.end);
  }, [selection, handleSeek]);

  const handleClearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  const handleExport = useCallback(async () => {
    if (!sessionId || !selection || selection.end <= selection.start) return;
    setIsExporting(true);
    try {
      await apiPost("/api/exports", {
        sessionId,
        ranges: [{ start: Math.floor(selection.start), end: Math.ceil(selection.end) }],
        options: { format: "mp4", quality: "original" },
      });
      alert("导出任务已创建，可在「导出管理」中查看进度。");
    } catch (err) {
      alert("导出失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsExporting(false);
    }
  }, [sessionId, selection]);

  // 全局键盘监听
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isInInput =
        !!tag && ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
      if (isInInput) return;

      switch (e.key) {
        case "[":
          e.preventDefault();
          handleSetClipStart();
          break;
        case "]":
          e.preventDefault();
          handleSetClipEnd();
          break;
        case "q":
        case "Q":
          e.preventDefault();
          handleSeekToClipStart();
          break;
        case "e":
        case "E":
          e.preventDefault();
          handleSeekToClipEnd();
          break;
        case "c":
        case "C":
          e.preventDefault();
          handleClearSelection();
          break;
        case "h":
        case "H":
          e.preventDefault();
          setShowShortcuts((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    handleSetClipStart,
    handleSetClipEnd,
    handleSeekToClipStart,
    handleSeekToClipEnd,
    handleClearSelection,
  ]);

  // 隐藏/显示面板
  const handleHidePanel = useCallback((key: PanelKey) => {
    setHiddenPanels((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const handleShowPanel = useCallback(
    (key: PanelKey) => {
      setHiddenPanels((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setLayout((prev) => addPanelToLayout(prev, key));
    },
    []
  );

  // 同步：当 Mosaic onChange 触发时，更新 hiddenPanels 以反映实际树中的叶子
  const handleLayoutChange = useCallback((newNode: MosaicNode<PanelKey> | null) => {
    setLayout(newNode);
    if (newNode) {
      const leaves = getLeaves(newNode);
      setHiddenPanels((prev) => {
        const next = new Set<PanelKey>();
        for (const key of prev) {
          if (!leaves.includes(key)) next.add(key);
        }
        return next;
      });
    }
  }, []);

  const renderTile = useCallback(
    (id: PanelKey, path: MosaicPath) => {
      return (
        <MosaicWindow
          title={PANEL_TITLES[id]}
          path={path}
          toolbarControls={<PanelCloseButton panelKey={id} onClose={handleHidePanel} />}
          className="mosaic-window-custom"
        >
          <div className="mosaic-panel-content">
            {id === "video" && (
              <VideoPanel
                playerRef={playerRef}
                isLiveMode={isLiveMode}
                isRecording={isRecording}
                liveSubtitle={liveSubtitle}
                onBackToLive={handleBackToLive}
                showShortcuts={showShortcuts}
                onToggleShortcuts={() => setShowShortcuts((v) => !v)}
                currentTime={currentTime}
                videoDuration={videoDuration}
                danmakuEvents={danmakuEvents}
                sessionStartTime={sessionDetail?.session.start_time ?? 0}
                candidates={candidates}
                selection={selection}
                onSeek={handleSeek}
              />
            )}
            {id === "subtitles" && (
              <SubtitlesPanel
                subtitleListRef={subtitleListRef}
                subtitles={subtitles}
                isLiveMode={isLiveMode}
                onSeek={handleSeekToSubtitle}
                formatTime={formatTime}
              />
            )}
            {id === "danmaku" && (
              <DanmakuPanel
                danmakuListRef={danmakuListRef}
                danmakuEvents={danmakuEvents}
                filteredDanmaku={filteredDanmaku}
                danmakuLoading={danmakuLoading}
                danmakuFilter={danmakuFilter}
                onFilterChange={setDanmakuFilter}
                onScroll={handleDanmakuScroll}
                formatMs={formatMs}
                timeMode={timeMode}
                onTimeModeChange={setTimeMode}
                candidates={candidates}
                currentTime={currentTime}
              />
            )}
            {id === "candidates" && (
              <CandidatePanel
                candidates={candidates}
                loading={candidatesLoading}
                selection={selection}
                isExporting={isExporting}
                onSelect={handleSelectCandidate}
                onExport={handleExport}
              />
            )}
          </div>
        </MosaicWindow>
      );
    },
    [
      isLiveMode,
      isRecording,
      liveSubtitle,
      subtitles,
      activeSubtitle,
      danmakuEvents,
      filteredDanmaku,
      danmakuLoading,
      danmakuFilter,
      candidates,
      candidatesLoading,
      selection,
      showShortcuts,
      currentTime,
      handleBackToLive,
      handleSeekToSubtitle,
      handleDanmakuScroll,
      formatTime,
      formatMs,
      timeMode,
      handleHidePanel,
      handleSeek,
      handleSelectCandidate,
      handleExport,
      videoDuration,
      sessionDetail,
    ]
  );

  if (sessionId == null) {
    return (
      <div className="live-preview-empty">
        <span style={{ fontSize: 32, opacity: 0.3 }}>实时预览</span>
        <span>请在「会话管理」中选择一个直播场次以进入实时预览</span>
      </div>
    );
  }

  const visiblePanelsInTree = layout ? getLeaves(layout) : [];
  const activePanels = new Set(visiblePanelsInTree);

  return (
    <div className="live-preview-mosaic-shell">
      <div className="live-preview-mosaic-toolbar">
        {ALL_PANELS.map((key) => (
          <button
            key={key}
            className={`live-preview-mosaic-toolbar-btn ${activePanels.has(key) ? "active" : ""}`}
            onClick={() => (activePanels.has(key) ? handleHidePanel(key) : handleShowPanel(key))}
          >
            {activePanels.has(key) ? <X size={13} /> : <Eye size={13} />}
            {PANEL_TITLES[key]}
          </button>
        ))}
      </div>
      <div className="live-preview-mosaic-area">
        <Mosaic<PanelKey>
          value={layout}
          onChange={handleLayoutChange}
          renderTile={renderTile}
          className="mosaic-custom"
          resize={{ minimumPaneSizePercentage: 5 }}
        />
      </div>
    </div>
  );
}

// ============== Sub Components ==============

function PanelCloseButton({ panelKey, onClose }: { panelKey: PanelKey; onClose: (k: PanelKey) => void }) {
  const { mosaicActions } = useContext(MosaicContext);
  const { mosaicWindowActions } = useContext(MosaicWindowContext);

  const handleClick = useCallback(() => {
    const path = mosaicWindowActions.getPath();
    mosaicActions.remove(path);
    onClose(panelKey);
  }, [mosaicActions, mosaicWindowActions, panelKey, onClose]);

  return (
    <button className="mosaic-window-close-btn" onClick={handleClick} title="隐藏">
      <X size={14} />
    </button>
  );
}

function VideoPanel({
  playerRef,
  isLiveMode,
  isRecording,
  liveSubtitle,
  onBackToLive,
  showShortcuts,
  onToggleShortcuts,
  currentTime,
  videoDuration,
  danmakuEvents,
  sessionStartTime,
  candidates,
  selection,
  onSeek,
}: {
  playerRef: React.RefObject<HTMLVideoElement | null>;
  isLiveMode: boolean;
  isRecording: boolean;
  liveSubtitle: LiveTranscriptChunk | null;
  onBackToLive: () => void;
  showShortcuts: boolean;
  onToggleShortcuts: () => void;
  currentTime: number;
  videoDuration: number;
  danmakuEvents: DanmakuEvent[];
  sessionStartTime: number;
  candidates: Candidate[];
  selection: ClipSelection | null;
  onSeek: (time: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const video = playerRef.current;
    if (!video) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("ended", handleEnded);

    setIsPlaying(!video.paused);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("ended", handleEnded);
    };
  }, [playerRef]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const handleTogglePlay = useCallback(() => {
    const video = playerRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
      return;
    }
    video.pause();
  }, [playerRef]);

  const handleToggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    void el.requestFullscreen?.().catch(() => {});
  }, []);

  return (
    <div className="live-preview-video-wrap" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div ref={containerRef} style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <video ref={playerRef} style={{ width: "100%", height: "100%", objectFit: "contain" }} onClick={handleTogglePlay} />
        <div className="live-preview-video-controls">
          <button className="btn btn-sm live-preview-video-control-btn" onClick={handleTogglePlay} title={isPlaying ? "暂停" : "播放"}>
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {isPlaying ? "暂停" : "播放"}
          </button>
          <button className="btn btn-sm live-preview-video-control-btn" onClick={handleToggleFullscreen} title={isFullscreen ? "退出全屏" : "全屏"}>
            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            {isFullscreen ? "退出全屏" : "全屏"}
          </button>
        </div>
        {!isLiveMode && isRecording && (
          <button className="btn btn-sm live-preview-back-to-live" onClick={onBackToLive}>
            回到最新
          </button>
        )}
        {isLiveMode && liveSubtitle && (
          <div
            style={{
              position: "absolute",
              bottom: 48,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "6px 14px",
              fontSize: 14,
              color: "#fff",
              background: "rgba(0,0,0,0.65)",
              whiteSpace: "nowrap",
              maxWidth: "90%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              pointerEvents: "none",
            }}
          >
            {liveSubtitle.text}
          </div>
        )}
        {showShortcuts && (
          <ShortcutsHelp onClose={onToggleShortcuts} />
        )}
      </div>
      <VideoProgressBar
        currentTime={currentTime}
        duration={videoDuration}
        danmakuEvents={danmakuEvents}
        sessionStartTime={sessionStartTime}
        candidates={candidates}
        selection={selection}
        onSeek={onSeek}
      />
    </div>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const items = [
    { key: "[", desc: "设置入点（选区起点）" },
    { key: "]", desc: "设置出点（选区终点）" },
    { key: "Q", desc: "跳转到入点" },
    { key: "E", desc: "跳转到出点" },
    { key: "C", desc: "清除选区" },
    { key: "H", desc: "显示 / 隐藏快捷键提示" },
  ];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.7)",
        zIndex: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#1a1a1c",
          border: "1px solid #333",
          borderRadius: 6,
          padding: "16px 20px",
          minWidth: 260,
          pointerEvents: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f0f0", marginBottom: 10 }}>快捷键</div>
        {items.map((item) => (
          <div key={item.key} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12 }}>
            <span style={{ color: "#e8b339", fontWeight: 600, fontFamily: "monospace" }}>{item.key}</span>
            <span style={{ color: "#b0b0b0" }}>{item.desc}</span>
          </div>
        ))}
        <div style={{ fontSize: 11, color: "#666", marginTop: 10, textAlign: "center" }}>点击空白处关闭</div>
      </div>
    </div>
  );
}

function SubtitlesPanel({
  subtitleListRef,
  subtitles,
  isLiveMode,
  onSeek,
  formatTime,
}: {
  subtitleListRef: React.RefObject<HTMLDivElement | null>;
  subtitles: LiveTranscriptChunk[];
  isLiveMode: boolean;
  onSeek: (sub: LiveTranscriptChunk) => void;
  formatTime: (s: number) => string;
}) {
  return (
    <div className="live-preview-subtitle-panel">
      <div className="live-preview-subtitle-list" ref={subtitleListRef}>
        {subtitles.length === 0 ? (
          <div className="text-muted" style={{ padding: 12 }}>
            等待字幕...
          </div>
        ) : (
          subtitles.map((sub, idx) => (
            <div
              key={`${sub.start}-${idx}`}
              className="subtitle-item"
              onClick={() => onSeek(sub)}
            >
              <span className="subtitle-time">{formatTime(sub.start)}</span>
              <span className="subtitle-text">{sub.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const DANMAKU_FILTERS = [
  { key: "all", label: "全部" },
  { key: "danmaku", label: "弹幕" },
  { key: "super_chat", label: "SC" },
  { key: "gift", label: "礼物" },
  { key: "guard", label: "舰长" },
] as const;

function DanmakuPanel({
  danmakuListRef,
  danmakuEvents,
  filteredDanmaku,
  danmakuLoading,
  danmakuFilter,
  onFilterChange,
  onScroll,
  formatMs,
  timeMode,
  onTimeModeChange,
  candidates,
  currentTime,
}: {
  danmakuListRef: React.RefObject<HTMLDivElement | null>;
  danmakuEvents: DanmakuEvent[];
  filteredDanmaku: DanmakuEvent[];
  danmakuLoading: boolean;
  danmakuFilter: string;
  onFilterChange: (f: string) => void;
  onScroll: () => void;
  formatMs: (ms: number) => string;
  timeMode: "relative" | "absolute";
  onTimeModeChange: (m: "relative" | "absolute") => void;
  candidates: Candidate[];
  currentTime: number;
}) {
  return (
    <div className="live-preview-danmaku-panel">
      <DanmakuDensityChart events={danmakuEvents} candidates={candidates} currentTime={currentTime} />
      <div className="danmaku-filter-bar">
        {DANMAKU_FILTERS.map((f) => (
          <button
            key={f.key}
            className={`danmaku-filter-btn ${danmakuFilter === f.key ? "active" : ""}`}
            onClick={() => onFilterChange(f.key)}
          >
            {f.label}
          </button>
        ))}
        <button
          className={`danmaku-filter-btn ${timeMode === "absolute" ? "active" : ""}`}
          onClick={() => onTimeModeChange(timeMode === "relative" ? "absolute" : "relative")}
          title={timeMode === "relative" ? "切换为绝对时间" : "切换为相对时间"}
        >
          {timeMode === "relative" ? "相对" : "时钟"}
        </button>
      </div>
      <div className="danmaku-list" ref={danmakuListRef} onScroll={onScroll}>
        {danmakuLoading && danmakuEvents.length === 0 ? (
          <div className="text-muted" style={{ padding: 12 }}>
            加载中...
          </div>
        ) : filteredDanmaku.length === 0 ? (
          <div className="text-muted" style={{ padding: 12 }}>
            暂无弹幕
          </div>
        ) : (
          filteredDanmaku.map((ev) => <DanmakuRow key={ev.id} event={ev} formatMs={formatMs} />)
        )}
      </div>
    </div>
  );
}

function DanmakuRow({ event, formatMs }: { event: DanmakuEvent; formatMs: (ms: number) => string }) {
  return (
    <div className={`danmaku-item type-${event.event_type}`}>
      <span className="danmaku-item-time">{formatMs(event.timestamp_ms)}</span>
      {(event.user_name || event.user_id) && (
        <span className="danmaku-item-user">{event.user_name || event.user_id}</span>
      )}
      <span className="danmaku-item-text">{event.text}</span>
      {event.price > 0 && <span className="danmaku-item-price">¥{event.price}</span>}
    </div>
  );
}

// ============== Helpers ==============

function addPanelToLayout<T extends string>(layout: MosaicNode<T> | null, key: T): MosaicNode<T> | null {
  if (layout === null) return key as MosaicNode<T>;

  if (typeof layout === "string" || typeof layout === "number") {
    return {
      type: "split",
      direction: "row",
      children: [layout, key],
      splitPercentages: [50, 50],
    };
  }

  if ("type" in layout && layout.type === "split") {
    const childCount = layout.children.length;
    const newChildren = [...layout.children, key];
    // 保持现有比例，新面板均分剩余空间
    const newSplitPercentages = layout.splitPercentages
      ? [...layout.splitPercentages.map((p) => (p * childCount) / (childCount + 1)), 100 / (childCount + 1)]
      : undefined;
    return {
      ...layout,
      children: newChildren,
      splitPercentages: newSplitPercentages,
    };
  }

  // tabs or other
  return {
    type: "split",
    direction: "row",
    children: [layout, key],
    splitPercentages: [50, 50],
  };
}
