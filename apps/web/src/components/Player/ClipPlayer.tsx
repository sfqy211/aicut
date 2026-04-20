import { useEffect, useMemo, useRef, useState } from "react";
import HtmlPlayer from "react-player/HtmlPlayer";

type RangeChange = {
  start: number;
  end: number;
};

type Props = {
  src: string;
  title: string;
  previewStart: number;
  previewEnd: number;
  clipStart: number;
  clipEnd: number;
  danmaku?: string[];
  onRangeChange?: (range: RangeChange) => void;
};

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ClipPlayer({
  src,
  title,
  previewStart,
  previewEnd,
  clipStart,
  clipEnd,
  danmaku = [],
  onRangeChange,
}: Props) {
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loopPreview, setLoopPreview] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const previewDuration = Math.max(1, previewEnd - previewStart);
  const localClipStart = Math.max(0, clipStart - previewStart);
  const localClipEnd = Math.max(localClipStart + 1, clipEnd - previewStart);
  const clipWidth = Math.max(0.8, ((clipEnd - clipStart) / previewDuration) * 100);
  const clipOffset = ((clipStart - previewStart) / previewDuration) * 100;

  const visibleDanmaku = useMemo(() => danmaku.slice(0, 4), [danmaku]);

  useEffect(() => {
    setIsReady(false);
    setPlaying(false);
    setPlaybackError(null);
  }, [src]);

  useEffect(() => {
    const element = playerRef.current;
    if (!element) return;

    if (playing) {
      void element.play().catch(() => {
        setPlaying(false);
      });
      return;
    }

    element.pause();
  }, [playing, src]);

  function seekTo(time: number) {
    if (!playerRef.current) return;
    playerRef.current.currentTime = time;
  }

  function handleTimeUpdate(currentTime: number) {
    if (!loopPreview || !playing) return;
    if (currentTime >= localClipEnd - 0.15) {
      seekTo(localClipStart);
    }
  }

  function nudgeStart(delta: number) {
    const nextStart = Math.min(Math.max(previewStart, clipStart + delta), clipEnd - 1);
    onRangeChange?.({ start: nextStart, end: clipEnd });
  }

  function nudgeEnd(delta: number) {
    const nextEnd = Math.max(Math.min(previewEnd, clipEnd + delta), clipStart + 1);
    onRangeChange?.({ start: clipStart, end: nextEnd });
  }

  return (
    <section className="clip-player-shell">
      <div className="clip-player-stage">
        <div className="clip-player-head">
          <div>
            <div className="clip-player-kicker">Candidate Preview</div>
            <h3 className="clip-player-title">{title}</h3>
          </div>
          <div className="clip-player-actions">
            <button
              className={`btn btn-sm ${loopPreview ? "btn-primary" : ""}`}
              type="button"
              onClick={() => setLoopPreview((current) => !current)}
            >
              {loopPreview ? "循环预览" : "单次播放"}
            </button>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                seekTo(localClipStart);
                setPlaying(true);
              }}
            >
              从入点播放
            </button>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => setPlaying((current) => !current)}
            >
              {playing ? "暂停" : "播放"}
            </button>
          </div>
        </div>

        <div className="clip-player-frame">
          <HtmlPlayer
            ref={playerRef}
            src={src}
            width="100%"
            height="100%"
            controls
            preload="metadata"
            onLoadedMetadata={() => {
              setIsReady(true);
              seekTo(localClipStart);
            }}
            onError={() => setPlaybackError("预览视频加载失败，请检查源文件或 FFmpeg。")}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget.currentTime)}
          />
          {visibleDanmaku.length > 0 && (
            <div className="clip-player-danmaku">
              {visibleDanmaku.map((item, index) => (
                <span
                  key={`${item}-${index}`}
                  className="clip-player-danmaku-item"
                  style={{ animationDelay: `${index * 0.35}s` }}
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="clip-player-rail">
          <div className="clip-player-rail-meta">
            <span className="mono">{formatTime(previewStart)}</span>
            <span className="clip-player-rail-label">
              预览范围 {formatTime(clipStart)} - {formatTime(clipEnd)}
            </span>
            <span className="mono">{formatTime(previewEnd)}</span>
          </div>
          <div className="clip-player-rail-track">
            <div
              className="clip-player-rail-window"
              style={{ left: `${clipOffset}%`, width: `${clipWidth}%` }}
            />
          </div>
          <div className="clip-player-sliders">
            <label className="clip-slider-group">
              <span>入点</span>
              <input
                type="range"
                min={previewStart}
                max={clipEnd - 1}
                step={1}
                value={clipStart}
                onChange={(event) =>
                  onRangeChange?.({ start: Number(event.target.value), end: clipEnd })
                }
              />
              <strong className="mono">{formatTime(clipStart)}</strong>
            </label>
            <label className="clip-slider-group">
              <span>出点</span>
              <input
                type="range"
                min={clipStart + 1}
                max={previewEnd}
                step={1}
                value={clipEnd}
                onChange={(event) =>
                  onRangeChange?.({ start: clipStart, end: Number(event.target.value) })
                }
              />
              <strong className="mono">{formatTime(clipEnd)}</strong>
            </label>
          </div>
          <div className="clip-player-fine-tune">
            <button className="btn btn-sm" type="button" onClick={() => nudgeStart(-1)}>
              入点 -1s
            </button>
            <button className="btn btn-sm" type="button" onClick={() => nudgeStart(1)}>
              入点 +1s
            </button>
            <button className="btn btn-sm" type="button" onClick={() => nudgeEnd(-1)}>
              出点 -1s
            </button>
            <button className="btn btn-sm" type="button" onClick={() => nudgeEnd(1)}>
              出点 +1s
            </button>
          </div>
        </div>
      </div>

      <div className="clip-player-status">
        <span className={`tag ${isReady ? "tag-success" : ""}`}>
          {isReady ? "PLAYER READY" : "BUFFERING"}
        </span>
        <span className="mono">片段时长 {formatTime(Math.max(1, clipEnd - clipStart))}</span>
        {playbackError ? <span className="text-danger">{playbackError}</span> : null}
      </div>
    </section>
  );
}
