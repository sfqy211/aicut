import { analyzeWindow } from "./analyze.js";

// ── 每源调度器 ──

interface SourceTimer {
  sourceId: number;
  sessionId: number;
  intervalMs: number;
  lastAnalysisMs: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const activeSchedulers = new Map<number, SourceTimer>();

/**
 * 为指定 source 启动定时分析调度器。
 * 每隔 analysis_interval 分钟，收集未分析的内容并调用 LLM。
 */
export function startScheduler(
  sourceId: number,
  sessionId: number,
  sessionStartMs: number,
  intervalMinutes: number
): void {
  if (activeSchedulers.has(sourceId)) return;
  if (intervalMinutes <= 0) return;

  const intervalMs = intervalMinutes * 60 * 1000;

  const sourceTimer: SourceTimer = {
    sourceId,
    sessionId,
    intervalMs,
    lastAnalysisMs: sessionStartMs,
    running: false,
    timer: null as any, // set below
  };

  const scheduleNext = () => {
    sourceTimer.timer = setTimeout(() => {
      void tick(sourceTimer).finally(() => scheduleNext());
    }, intervalMs);
  };

  sourceTimer.timer = setTimeout(() => {
    void tick(sourceTimer).finally(() => scheduleNext());
  }, intervalMs);

  activeSchedulers.set(sourceId, sourceTimer);
  console.log(
    `[Scheduler] Started for source ${sourceId}, interval ${intervalMinutes}min`
  );
}

/**
 * 停止指定 source 的调度器，并对剩余内容执行最终分析。
 */
export async function stopScheduler(sourceId: number): Promise<void> {
  const st = activeSchedulers.get(sourceId);
  if (!st) return;

  clearTimeout(st.timer);
  activeSchedulers.delete(sourceId);

  // Wait for in-flight tick to complete
  while (st.running) {
    await new Promise(r => setTimeout(r, 100));
  }

  // 最终分析：处理剩余未分析的内容
  const nowMs = Date.now();
  if (nowMs > st.lastAnalysisMs + 5000) {
    try {
      console.log(`[Scheduler] Final analysis for source ${sourceId}`);
      await analyzeWindow(
        st.sessionId,
        st.lastAnalysisMs,
        nowMs
      );
    } catch (err) {
      console.error(`[Scheduler] Final analysis failed for source ${sourceId}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[Scheduler] Stopped for source ${sourceId}`);
}

/**
 * 检查 source 是否有活跃的调度器
 */
export function isSchedulerRunning(sourceId: number): boolean {
  return activeSchedulers.has(sourceId);
}

// ── 内部 ──

async function tick(st: SourceTimer): Promise<void> {
  if (st.running) return;
  st.running = true;

  const nowMs = Date.now();
  const sinceMs = st.lastAnalysisMs;
  const untilMs = nowMs;

  try {
    const candidateIds = await analyzeWindow(
      st.sessionId,
      sinceMs,
      untilMs
    );
    if (candidateIds.length > 0) {
      console.log(
        `[Scheduler] Source ${st.sourceId}: created ${candidateIds.length} candidate(s): ` +
          candidateIds.map((id) => `#${id}`).join(", ")
      );
    }
  } catch (err) {
    console.error(
      `[Scheduler] Source ${st.sourceId} analysis failed:`,
      err instanceof Error ? err.message : err
    );
  } finally {
    st.running = false;
  }

  st.lastAnalysisMs = nowMs;
}


