import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveTranscriptChunk } from "../types";

type LiveMonitorProps = {
  sessionId: number;
  sessionTitle: string;
  onClose: () => void;
};

export function LiveMonitor({ sessionId, sessionTitle, onClose }: LiveMonitorProps) {
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [subtitles, setSubtitles] = useState<LiveTranscriptChunk[]>([]);
  const [liveSubtitle, setLiveSubtitle] = useState<LiveTranscriptChunk | null>(null);
  const subtitleListRef = useRef<HTMLDivElement | null>(null);

  const hlsUrl = `/api/sessions/${sessionId}/hls/playlist.m3u8`;

  // 初始化 vidstack / HLS
  useEffect(() => {
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
          if (liveEdge - video.currentTime > 10) {
            setIsLiveMode(false);
          }
        }
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", () => {
      const seekable = video.seekable;
      if (seekable.length > 0) {
        const liveEdge = seekable.end(seekable.length - 1);
        if (video.currentTime < liveEdge - 5) {
          setIsLiveMode(false);
        }
      }
    });

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (hls) {
        hls.destroy();
      }
    };
  }, [hlsUrl, isLiveMode]);

  // SSE 实时字幕
  useEffect(() => {
    const events = new EventSource("/api/events/stream");
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === "session.transcription_live" && data.payload?.sessionId === sessionId) {
        const chunk = data.payload?.chunk as LiveTranscriptChunk | undefined;
        if (chunk) {
          setLiveSubtitle(chunk);
          setSubtitles((prev) => {
            const next = [...prev, chunk];
            if (next.length > 100) next.shift();
            return next;
          });
        }
      }
    };
    events.addEventListener("session.transcription_live", handler);
    return () => {
      events.removeEventListener("session.transcription_live", handler);
      events.close();
    };
  }, [sessionId]);

  // 自动滚动字幕
  useEffect(() => {
    if (subtitleListRef.current && isLiveMode) {
      subtitleListRef.current.scrollTop = subtitleListRef.current.scrollHeight;
    }
  }, [subtitles, isLiveMode]);

  // 查找当前时间对应的历史字幕
  const activeSubtitle = useMemo(() => {
    if (isLiveMode) return liveSubtitle;
    // 二分查找
    const list = subtitles;
    let left = 0;
    let right = list.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const seg = list[mid];
      if (!seg) break;
      if (seg.start <= currentTime && currentTime <= seg.end) {
        return seg;
      }
      if (currentTime < seg.start) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    return null;
  }, [currentTime, isLiveMode, liveSubtitle, subtitles]);

  const handleBackToLive = () => {
    const video = playerRef.current;
    if (!video) return;
    const seekable = video.seekable;
    if (seekable.length > 0) {
      video.currentTime = seekable.end(seekable.length - 1) - 3;
    }
    setIsLiveMode(true);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="live-monitor-overlay">
      <div className="live-monitor-panel">
        <div className="live-monitor-header">
          <span className="live-monitor-title">
            LiveMonitor - {sessionTitle || `Session #${sessionId}`}
          </span>
          <div className="live-monitor-actions">
            {!isLiveMode && (
              <button className="btn btn-sm btn-primary" onClick={handleBackToLive}>
                回到最新
              </button>
            )}
            <button className="btn btn-sm" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="live-monitor-body">
          <div className="live-monitor-video">
            <video
              ref={playerRef}
              controls
              style={{ width: "100%", height: "100%", background: "#000" }}
            />
            {isLiveMode && liveSubtitle && (
              <div className="live-subtitle-bubble">
                {liveSubtitle.text}
              </div>
            )}
          </div>

          <div className="live-monitor-sidebar">
            <div className="panel-header">
              <span className="panel-title">实时字幕</span>
              <span className="tag">{isLiveMode ? "LIVE" : "REVIEW"}</span>
            </div>
            <div className="subtitle-list" ref={subtitleListRef}>
              {subtitles.length === 0 ? (
                <div className="text-muted" style={{ padding: 12 }}>等待字幕...</div>
              ) : (
                subtitles.map((sub, idx) => (
                  <div
                    key={idx}
                    className={`subtitle-item ${sub === activeSubtitle ? "active" : ""}`}
                    onClick={() => {
                      if (playerRef.current) {
                        playerRef.current.currentTime = sub.start;
                        setIsLiveMode(false);
                      }
                    }}
                  >
                    <span className="subtitle-time">{formatTime(sub.start)}</span>
                    <span className="subtitle-text">{sub.text}</span>
                    {sub.isPartial && <span className="tag">Partial</span>}
                  </div>
                ))
              )}
            </div>
            {activeSubtitle && !isLiveMode && (
              <div className="subtitle-current">
                <span className="subtitle-time">{formatTime(activeSubtitle.start)}</span>
                <span className="subtitle-text">{activeSubtitle.text}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
