import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { SessionFullData } from "../types";

/**
 * 批量加载 session 完整数据。
 * 一次请求返回 session + transcript + candidates + exports，
 * 替代原来的 useCandidates + 独立 fetch session detail 两次请求。
 */
export function useSessionFull(sessionId: number | null) {
  return useQuery({
    queryKey: ["session-full", sessionId],
    queryFn: () => apiGet<SessionFullData>(`/api/sessions/${sessionId}/full`),
    enabled: sessionId != null,
    staleTime: 10_000,
    // 异常时不重试太多次（本地 API 出错即失败）
    retry: 1,
  });
}
