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
import { apiGet } from "../api/client";
import { useDanmaku } from "../hooks/useDanmaku";
import type { DanmakuEvent, LiveTranscriptChunk, SessionDetail } from "../types";

type PanelKey = "video" | "subtitles" | "danmaku" | "ai";

const PANEL_TITLES: Record<PanelKey, string> = {
  video: "直播画面",
  subtitles: "转录字幕",
  danmaku: "弹幕与互动",
  ai: "AI 实时分析",
};

const ALL_PANELS: PanelKey[] = ["video", "subtitles", "danmaku", "ai"];

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
      children: ["danmaku", "ai"],
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
  const danmakuAutoScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { events: danmakuEvents, loading: danmakuLoading } = useDanmaku(sessionId);
  const isRecording = sessionDetail?.session.status === "recording";

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
          const raw = detail.segments[0]?.segments_json;
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

  const formatTime = useCallback((seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, []);

  const formatMs = useCallback(
    (ms: number) => {
      return formatTime(Math.floor(ms / 1000));
    },
    [formatTime]
  );

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
              />
            )}
            {id === "ai" && <AIPanel />}
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
      handleBackToLive,
      handleSeekToSubtitle,
      handleDanmakuScroll,
      formatTime,
      formatMs,
      handleHidePanel,
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
}: {
  playerRef: React.RefObject<HTMLVideoElement | null>;
  isLiveMode: boolean;
  isRecording: boolean;
  liveSubtitle: LiveTranscriptChunk | null;
  onBackToLive: () => void;
}) {
  return (
    <div className="live-preview-video-wrap">
      <video ref={playerRef} controls style={{ width: "100%", height: "100%" }} />
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
}: {
  danmakuListRef: React.RefObject<HTMLDivElement | null>;
  danmakuEvents: DanmakuEvent[];
  filteredDanmaku: DanmakuEvent[];
  danmakuLoading: boolean;
  danmakuFilter: string;
  onFilterChange: (f: string) => void;
  onScroll: () => void;
  formatMs: (ms: number) => string;
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

function AIPanel() {
  return (
    <div className="live-preview-ai-panel">
      <div className="ai-skeleton" style={{ height: 120 }} />
      <div className="ai-skeleton" style={{ height: 80 }} />
      <div className="ai-skeleton" style={{ height: 160 }} />
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>
        分析面板预留接口，后续接入 LLM 实时评分与摘要。
      </div>
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
