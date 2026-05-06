import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api/client";
import { useEventStream } from "../hooks/useEventStream";
import type { Source } from "../types";
import { LayoutGrid, List, Play, Square, Trash2, MoreHorizontal, Radio, Clock } from "lucide-react";

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseTimeToSeconds(timeStr: string): number {
  const parts = timeStr.split(":").map(Number);
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return 0;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function Sources() {
  const [sources, setSources] = useState<Source[]>([]);
  const [roomId, setRoomId] = useState("");
  const [streamerName, setStreamerName] = useState("");
  const [analysisInterval, setAnalysisInterval] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [viewMode, setViewMode] = useState<"card" | "list">(() => {
    return (localStorage.getItem("aicut:sources:view") as "card" | "list") || "card";
  });
  const lastEvent = useEventStream();

  async function refresh() {
    setSources(await apiGet<Source[]>("/api/sources"));
  }

  useEffect(() => {
    void refresh();
  }, [lastEvent]);

  useEffect(() => {
    localStorage.setItem("aicut:sources:view", viewMode);
  }, [viewMode]);

  async function addSource() {
    setSubmitting(true);
    try {
      await apiPost("/api/sources/bilibili", {
        roomId,
        streamerName,
        autoRecord: true,
        analysisInterval,
      });
      setRoomId("");
      setStreamerName("");
      setAnalysisInterval(5);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function patchInterval(id: number, interval: number) {
    await apiPatch(`/api/sources/${id}`, { analysis_interval: interval });
    await refresh();
  }

  async function toggleMonitoring(source: Source) {
    if (source.runtime?.monitoring) {
      await apiPost(`/api/sources/${source.id}/stop`, {});
    } else {
      await apiPost(`/api/sources/${source.id}/start`, {});
    }
    await refresh();
  }

  async function deleteSource(id: number) {
    if (!confirm("确定删除此直播源？")) return;
    await apiDelete(`/api/sources/${id}`);
    await refresh();
  }

  function getCoverUrl(source: Source): string | undefined {
    if (source.runtime?.liveInfo?.cover) {
      return source.runtime.liveInfo.cover;
    }
    if (source.runtime?.localCoverPath) {
      return `/api/sources/${source.id}/cover`;
    }
    return undefined;
  }

  return (
    <>
      {/* Toolbar */}
      <div className="form-row sources-toolbar">
        <div className="form-group">
          <label className="form-label">房间号</label>
          <input
            className="form-input"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="例如 7734200"
          />
        </div>
        <div className="form-group">
          <label className="form-label">主播名（可选）</label>
          <input
            className="form-input"
            value={streamerName}
            onChange={(e) => setStreamerName(e.target.value)}
            placeholder="可选"
          />
        </div>
        <div className="form-group">
          <label className="form-label">分析间隔（分钟）</label>
          <input
            className="form-input"
            type="number"
            min={1}
            value={analysisInterval}
            onChange={(e) => setAnalysisInterval(Number(e.target.value) || 5)}
            style={{ width: 80 }}
          />
        </div>
        <button className="btn btn-primary" onClick={addSource} disabled={!roomId || submitting}>
          添加直播源
        </button>

        <div className="view-toggle">
          <button
            className={`btn btn-sm ${viewMode === "card" ? "active" : ""}`}
            onClick={() => setViewMode("card")}
            title="卡片视图"
          >
            <LayoutGrid size={16} />
          </button>
          <button
            className={`btn btn-sm ${viewMode === "list" ? "active" : ""}`}
            onClick={() => setViewMode("list")}
            title="列表视图"
          >
            <List size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      {sources.length === 0 ? (
        <div className="panel">
          <div className="panel-body text-muted">暂无直播源</div>
        </div>
      ) : viewMode === "card" ? (
        <div className="source-card-grid">
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              coverUrl={getCoverUrl(source)}
              onToggle={() => toggleMonitoring(source)}
              onDelete={() => deleteSource(source.id)}
              onPatchInterval={patchInterval}
            />
          ))}
        </div>
      ) : (
        <div className="panel">
          <SourceListView
            sources={sources}
            onToggle={toggleMonitoring}
            onDelete={deleteSource}
            onPatchInterval={patchInterval}
          />
        </div>
      )}
    </>
  );
}

function useRecordingTime(progressTime: string | null | undefined, isRecording: boolean) {
  const [displayTime, setDisplayTime] = useState<string>(progressTime || "");

  useEffect(() => {
    if (!isRecording || !progressTime) {
      setDisplayTime(progressTime || "");
      return;
    }

    const baseSeconds = parseTimeToSeconds(progressTime);
    const startAt = Date.now();

    const tick = () => {
      const elapsed = Math.floor((Date.now() - startAt) / 1000);
      setDisplayTime(formatDuration(baseSeconds + elapsed));
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isRecording, progressTime]);

  return displayTime;
}

function SourceCard({
  source,
  coverUrl,
  onToggle,
  onDelete,
  onPatchInterval,
}: {
  source: Source;
  coverUrl?: string;
  onToggle: () => void;
  onDelete: () => void;
  onPatchInterval: (id: number, interval: number) => void;
}) {
  const isRecording = source.runtime?.state === "recording";
  const isMonitoring = source.runtime?.monitoring;
  const liveTitle = source.runtime?.liveInfo?.title;
  const owner = source.runtime?.liveInfo?.owner || source.streamer_name || `房间 ${source.room_id}`;
  const lastTime = formatDateTime(source.runtime?.lastRecordTime);
  const lastTitle = source.runtime?.lastSessionTitle;
  const recordingTime = useRecordingTime(source.runtime?.progressTime, isRecording);

  return (
    <div className="source-card">
      <div className="source-card-cover">
        {coverUrl ? (
          <img src={coverUrl} alt={owner} referrerPolicy="no-referrer" />
        ) : (
          <div className="source-card-cover-placeholder">
            <Radio size={32} />
          </div>
        )}
        {isRecording && (
          <div className="source-card-recording-bar">
            <span className="recording-dot" />
            <span className="recording-text">录制中</span>
            <span className="recording-time">{recordingTime}</span>
          </div>
        )}
        {liveTitle && <span className="source-card-room-title" title={liveTitle}>{liveTitle}</span>}
      </div>

      <div className="source-card-body">
        <div className="source-card-top-row">
          <span className="source-card-owner" title={owner}>{owner}</span>
          <div className="source-card-top-tags">
            <span className="source-card-tag platform">{source.platform}</span>
            <StatusTag state={source.runtime?.state} />
          </div>
          <div className="source-card-menu">
            <button className="btn btn-sm btn-icon menu-trigger">
              <MoreHorizontal size={16} />
            </button>
            <div className="source-card-menu-dropdown">
              <button onClick={onToggle} className="menu-item">
                {isMonitoring ? <Square size={14} /> : <Play size={14} />}
                <span>{isMonitoring ? "停止监控" : "开始监控"}</span>
              </button>
              <button onClick={onDelete} className="menu-item menu-item-danger">
                <Trash2 size={14} />
                <span>删除直播源</span>
              </button>
            </div>
          </div>
        </div>

        {(lastTime !== "-" || lastTitle) && (
          <div className="source-card-last-record" title={lastTitle || ""}>
            <Clock size={12} />
            <span className="last-record-time">{lastTime}</span>
            {lastTitle && <span className="last-record-title">{lastTitle}</span>}
          </div>
        )}

        <div className="source-card-interval" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
          <span>分析间隔:</span>
          <input
            type="number"
            min={1}
            value={source.analysis_interval}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0) onPatchInterval(source.id, v);
            }}
            style={{ width: 48, fontSize: 12, padding: "2px 4px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-secondary)" }}
          />
          <span>分钟</span>
        </div>
      </div>
    </div>
  );
}

function SourceListRow({
  source,
  onToggle,
  onDelete,
  onPatchInterval,
}: {
  source: Source;
  onToggle: (source: Source) => void;
  onDelete: (id: number) => void;
  onPatchInterval: (id: number, interval: number) => void;
}) {
  const isRecording = source.runtime?.state === "recording";
  const recordingTime = useRecordingTime(source.runtime?.progressTime, isRecording);

  return (
    <tr>
      <td>
        <div className="source-list-name">
          {source.runtime?.liveInfo?.avatar ? (
            <img
              className="source-list-avatar"
              src={source.runtime.liveInfo.avatar}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="source-list-avatar-placeholder">
              <Radio size={14} />
            </div>
          )}
          <span>
            {source.runtime?.liveInfo?.owner || source.streamer_name || "-"}
            {source.runtime?.liveInfo?.living && (
              <span className="source-list-live-dot" title="直播中" />
            )}
          </span>
        </div>
      </td>
      <td className="mono">{source.room_id}</td>
      <td>{source.platform}</td>
      <td>
        <StatusTag state={source.runtime?.state} />
      </td>
      <td className="mono text-muted">{recordingTime || "-"}</td>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="number"
            min={1}
            value={source.analysis_interval}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0) onPatchInterval(source.id, v);
            }}
            style={{ width: 48, fontSize: 12, padding: "2px 4px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-secondary)" }}
          />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>分钟</span>
        </div>
      </td>
      <td>
        <div className="source-list-actions">
          <button
            className={`btn btn-sm ${source.runtime?.monitoring ? "btn-danger" : "btn-primary"}`}
            onClick={() => onToggle(source)}
          >
            {source.runtime?.monitoring ? "停止" : "启动"}
          </button>
          <button className="btn btn-sm btn-icon" onClick={() => onDelete(source.id)} title="删除">
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function SourceListView({
  sources,
  onToggle,
  onDelete,
  onPatchInterval,
}: {
  sources: Source[];
  onToggle: (source: Source) => void;
  onDelete: (id: number) => void;
  onPatchInterval: (id: number, interval: number) => void;
}) {
  return (
    <table className="data-table source-list-table">
      <thead>
        <tr>
          <th>主播</th>
          <th>房间号</th>
          <th>平台</th>
          <th>状态</th>
          <th>进度</th>
          <th>分析间隔</th>
          <th style={{ width: "140px" }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {sources.map((source) => (
          <SourceListRow
            key={source.id}
            source={source}
            onToggle={onToggle}
            onDelete={onDelete}
            onPatchInterval={onPatchInterval}
          />
        ))}
      </tbody>
    </table>
  );
}

function StatusTag({ state }: { state?: string }) {
  if (!state) return <span className="source-card-tag">-</span>;

  const map: Record<string, { label: string; cls: string }> = {
    idle: { label: "空闲", cls: "idle" },
    monitoring: { label: "监控中", cls: "monitoring" },
    recording: { label: "录制中", cls: "recording" },
    stopping: { label: "停止中", cls: "stopping" },
    error: { label: "错误", cls: "error" },
  };

  const info = map[state] || { label: state, cls: "" };
  return <span className={`source-card-tag status ${info.cls}`}>{info.label}</span>;
}
