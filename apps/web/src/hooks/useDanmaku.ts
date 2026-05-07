import { useEffect, useRef, useState } from "react";
import { apiGet } from "../api/client";
import type { DanmakuEvent } from "../types";

/**
 * Danmaku 加载 Hook。
 *
 * 两种模式：
 * 1. 直播模式 (timeWindow == null): 全量加载 + SSE 实时增量
 * 2. 回放模式 (timeWindow != null): 按播放位置 ± timeWindow 时间窗口加载，
 *    用户 seek 超过阈值时自动重新加载新窗口。
 */
export function useDanmaku(
  sessionId: number | null,
  timeWindow?: { currentTime: number; sessionStartSec: number }
) {
  const [events, setEvents] = useState<DanmakuEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const lastIdRef = useRef<number>(0);
  const lastTimestampRef = useRef<number>(-1);
  // 回放模式：记录已加载的时间窗口，避免重复请求
  const loadedWindowRef = useRef<{ fromMs: number; toMs: number } | null>(null);

  const isPlaybackMode = timeWindow != null;

  // ── 直播模式：全量加载 ──
  useEffect(() => {
    if (sessionId == null || isPlaybackMode) {
      // 回放模式不在这里加载
      return;
    }

    let cancelled = false;
    setLoading(true);
    apiGet<DanmakuEvent[]>(`/api/sessions/${sessionId}/danmaku`)
      .then((data) => {
        if (cancelled) return;
        setEvents(data);
        if (data.length > 0) {
          const lastItem = data[data.length - 1];
          if (lastItem) {
            lastTimestampRef.current = lastItem.timestamp_ms;
          }
        }
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, isPlaybackMode]);

  // ── 回放模式：时间窗口加载 ──
  useEffect(() => {
    if (sessionId == null || !isPlaybackMode) return;

    const WINDOW_SEC = 300; // ±5 分钟
    const { currentTime, sessionStartSec } = timeWindow;

    // 将相对时间 (秒) 转为绝对毫秒
    const centerMs = (sessionStartSec + currentTime) * 1000;
    const fromMs = Math.max(0, centerMs - WINDOW_SEC * 1000);
    const toMs = centerMs + WINDOW_SEC * 1000;

    // 去重：如果新窗口完全在已加载窗口内，跳过
    const prev = loadedWindowRef.current;
    if (prev && fromMs >= prev.fromMs && toMs <= prev.toMs) {
      return;
    }

    let cancelled = false;
    setLoading(true);

    apiGet<DanmakuEvent[]>(
      `/api/sessions/${sessionId}/danmaku?from=${Math.floor(fromMs)}&to=${Math.floor(toMs)}`
    )
      .then((data) => {
        if (cancelled) return;
        setEvents(data);
        loadedWindowRef.current = { fromMs, toMs };
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, isPlaybackMode, timeWindow?.currentTime]);

  // ── SSE 增量 (仅直播模式) ──
  useEffect(() => {
    if (sessionId == null || isPlaybackMode) return;

    const es = new EventSource("/api/events/stream");

    // 实时弹幕：直接追加
    const realtimeHandler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "danmaku.received" && data.payload?.sessionId === sessionId) {
          const p = data.payload;
          const ev: DanmakuEvent = {
            id: -p.timestampMs,
            event_type: p.type,
            timestamp_ms: p.timestampMs,
            text: p.text,
            user_id: p.userId ?? null,
            user_name: p.userName ?? null,
            price: p.price ?? 0,
          };
          setEvents((prev) => {
            const merged = [...prev, ev];
            merged.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
            const trimmed = merged.length > 5000 ? merged.slice(merged.length - 5000) : merged;
            return trimmed;
          });
          lastTimestampRef.current = ev.timestamp_ms;
        }
      } catch {
        // ignore
      }
    };

    // 批量导入完成：增量拉取
    const importedHandler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "segment.danmaku_imported" && data.payload?.sessionId === sessionId) {
          const since = lastTimestampRef.current >= 0 ? lastTimestampRef.current : undefined;
          const url = since !== undefined
            ? `/api/sessions/${sessionId}/danmaku?since=${since}`
            : `/api/sessions/${sessionId}/danmaku`;
          apiGet<DanmakuEvent[]>(url)
            .then((newEvents) => {
              if (newEvents.length === 0) return;
              setEvents((prev) => {
                const existingIds = new Set(prev.map((e) => e.id));
                const merged = [...prev];
                for (const ev of newEvents) {
                  if (!existingIds.has(ev.id)) {
                    merged.push(ev);
                  }
                }
                merged.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
                const trimmed = merged.length > 5000 ? merged.slice(merged.length - 5000) : merged;
                return trimmed;
              });
              const maxTs = Math.max(...newEvents.map((e) => e.timestamp_ms));
              lastTimestampRef.current = maxTs;
            })
            .catch(() => {});
        }
      } catch {
        // ignore
      }
    };

    es.addEventListener("danmaku.received", realtimeHandler);
    es.addEventListener("segment.danmaku_imported", importedHandler);
    return () => {
      es.removeEventListener("danmaku.received", realtimeHandler);
      es.removeEventListener("segment.danmaku_imported", importedHandler);
      es.close();
    };
  }, [sessionId, isPlaybackMode]);

  return { events, loading };
}
