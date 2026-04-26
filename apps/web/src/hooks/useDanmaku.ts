import { useEffect, useRef, useState } from "react";
import { apiGet } from "../api/client";
import type { DanmakuEvent } from "../types";

export function useDanmaku(sessionId: number | null) {
  const [events, setEvents] = useState<DanmakuEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const lastIdRef = useRef<number>(0);
  const lastTimestampRef = useRef<number>(-1);

  // 全量加载
  useEffect(() => {
    if (sessionId == null) {
      setEvents([]);
      lastIdRef.current = 0;
      lastTimestampRef.current = -1;
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
  }, [sessionId]);

  // SSE 增量更新：监听 segment.danmaku_imported
  useEffect(() => {
    if (sessionId == null) return;

    const es = new EventSource("/api/events/stream");
    const handler = (event: MessageEvent) => {
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
                // 限制最大条数避免 DOM 爆炸
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
    es.addEventListener("segment.danmaku_imported", handler);
    return () => {
      es.removeEventListener("segment.danmaku_imported", handler);
      es.close();
    };
  }, [sessionId]);

  return { events, loading };
}
