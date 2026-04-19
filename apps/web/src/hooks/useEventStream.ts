import { useEffect, useState } from "react";

export function useEventStream() {
  const [lastEvent, setLastEvent] = useState<string>("等待事件");

  useEffect(() => {
    const events = new EventSource("/api/events/stream");
    const handler = (event: MessageEvent) => {
      setLastEvent(event.type);
    };
    events.addEventListener("heartbeat", handler);
    events.addEventListener("source.created", handler);
    events.addEventListener("import.created", handler);
    events.addEventListener("candidate.approved", handler);
    events.addEventListener("candidate.rejected", handler);
    events.addEventListener("export.created", handler);
    events.addEventListener("source.monitoring_started", handler);
    events.addEventListener("source.monitoring_stopped", handler);
    events.addEventListener("source.recording_started", handler);
    events.addEventListener("source.recording_stopped", handler);
    events.addEventListener("source.recorder_progress", handler);
    events.addEventListener("segment.created", handler);
    events.addEventListener("segment.transcription_progress", handler);
    events.addEventListener("segment.transcription_completed", handler);
    events.addEventListener("segment.transcription_failed", handler);
    events.addEventListener("segment.danmaku_imported", handler);

    return () => events.close();
  }, []);

  return lastEvent;
}
