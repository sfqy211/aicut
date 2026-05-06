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
import { X, Eye } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import { useDanmaku } from "../hooks/useDanmaku";
import { useCandidates } from "../hooks/useCandidates";
import { Timeline } from "../components/Timeline/Timeline";
import { CandidatePanel } from "../components/CandidatePanel/CandidatePanel";
import type { DanmakuEvent, LiveTranscriptChunk, SessionDetail, Candidate, ClipSelection } from "../types";

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

  const { events: danmakuEvents, loading: danmakuLoading } = useDanmaku(sessionId);
  const { candidates, loading: candidatesLoading } = useCandidates(sessionId);
  const isRecording = sessionDetail?.session.status === "recording";

  const [selection, setSelection] = useState<ClipSelection | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  // 加载 session 详情与历史字幕
  useEffect(() => {
    if (sessionId == null) {
      setSessionDetail(null);
      setSubtitles([]);
      setLiveSubtitle(null);
      return;
    }
    let cancelled = false;
    apiGet<SessionDetail>(`/api/sessions/${sessionId}`)
      .then((detail) => {
        if (cancelled) return;
        setSessionDetail(detail);
        try {
          // 优先使用 session 级 transcript（流式 ASR 持久化）
          const raw = detail.transcript?.segments_json;
          if (raw) {
            const parsed = JSON.parse(raw) as LiveTranscriptChunk[];
            if (Array.isArray(parsed)) setSubtitles(parsed);
          }
        } catch {
          // ignore
        }
      })
      .catch(() => {
        if (!cancelled) setSessionDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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
        hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 5 });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
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
            setLiveSubtitle(chunk);
            setSubtitles((prev) => {
              const next = [...prev];
              const existingIndex = next.findIndex((s) => s.start === chunk.start);
              if (existingIndex >= 0) {
                next[existingIndex] = chunk;
              } else {
                next.push(chunk);
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
  }, [sessionId]);

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
  const formatTime = useCallback(
    (seconds: number) => {
      if (timeMode === "absolute") return formatAbsolute(seconds * 1000);
      // 相对模式：需要减去 session 开始时间
      const sessionStart = sessionDetail?.session.start_time;
      if (sessionStart) return formatRelative(seconds - sessionStart);
      return formatAbsolute(seconds * 1000);
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
                duration={videoDuration}
                currentTime={currentTime}
                candidates={candidates}
                selection={selection}
                onSeek={handleSeek}
                onSelectCandidate={handleSelectCandidate}
                showShortcuts={showShortcuts}
                onToggleShortcuts={() => setShowShortcuts((v) => !v)}
              />
            )}
            {id === "subtitles" && (
              <SubtitlesPanel
                subtitleListRef={subtitleListRef}
                subtitles={subtitles}
                activeSubtitle={activeSubtitle}
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
  duration,
  currentTime,
  candidates,
  selection,
  onSeek,
  onSelectCandidate,
  showShortcuts,
  onToggleShortcuts,
}: {
  playerRef: React.RefObject<HTMLVideoElement | null>;
  isLiveMode: boolean;
  isRecording: boolean;
  liveSubtitle: LiveTranscriptChunk | null;
  onBackToLive: () => void;
  duration: number;
  currentTime: number;
  candidates: Candidate[];
  selection: ClipSelection | null;
  onSeek: (time: number) => void;
  onSelectCandidate: (candidate: Candidate) => void;
  showShortcuts: boolean;
  onToggleShortcuts: () => void;
}) {
  return (
    <div className="live-preview-video-wrap" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <video ref={playerRef} controls style={{ width: "100%", height: "100%", objectFit: "contain" }} />
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
      <Timeline
        duration={duration}
        currentTime={currentTime}
        candidates={candidates}
        selection={selection}
        onSeek={onSeek}
        onSelectCandidate={onSelectCandidate}
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
  activeSubtitle,
  isLiveMode,
  onSeek,
  formatTime,
}: {
  subtitleListRef: React.RefObject<HTMLDivElement | null>;
  subtitles: LiveTranscriptChunk[];
  activeSubtitle: LiveTranscriptChunk | null;
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
              className={`subtitle-item ${sub === activeSubtitle ? "active" : ""}`}
              onClick={() => onSeek(sub)}
            >
              <span className="subtitle-time">{formatTime(sub.start)}</span>
              <span className="subtitle-text">{sub.text}</span>
              {sub.isPartial && <span className="tag">Partial</span>}
            </div>
          ))
        )}
      </div>
      {activeSubtitle && !isLiveMode && (
        <div className="subtitle-current-bar">
          <span className="subtitle-time">{formatTime(activeSubtitle.start)}</span>
          <span className="subtitle-text">{activeSubtitle.text}</span>
        </div>
      )}
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
}) {
  return (
    <div className="live-preview-danmaku-panel">
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
      {event.user_id && <span className="danmaku-item-user">{event.user_id}</span>}
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
