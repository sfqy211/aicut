import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import type { Candidate, SessionDetail } from "../types";

export function useCandidates(sessionId: number | null) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sessionId == null) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiGet<SessionDetail>(`/api/sessions/${sessionId}`)
      .then((detail) => {
        if (cancelled) return;
        setCandidates(detail.candidates ?? []);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return { candidates, loading };
}
