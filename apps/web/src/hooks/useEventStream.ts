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

    return () => events.close();
  }, []);

  return lastEvent;
}
