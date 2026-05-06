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

  // SSE 增量更新：监听实时弹幕 + 批量导入完成
  useEffect(() => {
    if (sessionId == null) return;

    const es = new EventSource("/api/events/stream");

    // 实时弹幕：直接追加，无需请求 API
    const realtimeHandler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "danmaku.received" && data.payload?.sessionId === sessionId) {
          const p = data.payload;
          const ev: DanmakuEvent = {
            id: -p.timestampMs, // 临时负 ID，避免与 DB 自增 ID 冲突
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

    // 批量导入完成：重新拉取确保数据完整
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
  }, [sessionId]);

  return { events, loading };
}
