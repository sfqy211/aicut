import { config } from "../../config.js";
import { getDb, row } from "../../db/index.js";
import { eventBus } from "../../events/bus.js";
import { tryGenerateCandidates } from "../analysis/scoring.js";

export type StandardASRSegment = {
  start: number;
  end: number;
  text: string;
};

export type StandardASRWord = {
  word: string;
  start: number;
  end: number;
};

export type StandardASRResult = {
  text: string;
  duration?: number;
  language?: string;
  segments: StandardASRSegment[];
  words?: StandardASRWord[];
};

export async function transcribeFile(filePath: string): Promise<StandardASRResult> {
  const response = await fetch(`${config.asrWorkerUrl}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_path: filePath })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ASR worker failed: ${response.status} ${body}`);
  }

  return (await response.json()) as StandardASRResult;
}

type SegmentRow = {
  id: number;
  session_id: number;
  file_path: string;
  status: string;
};

const queue: number[] = [];
const queued = new Set<number>();
let processing = false;

export function enqueueAsrTask(segmentId: number) {
  if (queued.has(segmentId)) return;
  queued.add(segmentId);
  queue.push(segmentId);
  publishProgress(segmentId, 5, "queued");
  void processQueue();
}

export async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (queue.length > 0) {
      const segmentId = queue.shift();
      if (!segmentId) continue;
      queued.delete(segmentId);
      await processSegment(segmentId);
    }
  } finally {
    processing = false;
  }
}

export function restoreAsrQueue() {
  const db = getDb();
  const segments = db
    .prepare("SELECT id FROM segments WHERE status IN ('pending', 'transcribing') ORDER BY id ASC")
    .all() as Array<{ id: number }>;

  for (const segment of segments) {
    enqueueAsrTask(segment.id);
  }
}

async function processSegment(segmentId: number) {
  const db = getDb();
  const segment = row<SegmentRow>(db.prepare("SELECT * FROM segments WHERE id = ?"), segmentId);
  if (!segment) return;

  try {
    updateSegmentStatus(segmentId, "transcribing");
    publishProgress(segmentId, 15, "transcribing");
    publishProgress(segmentId, 35, "calling_asr_worker");

    const result = await transcribeFile(segment.file_path);
    publishProgress(segmentId, 85, "writing_transcript");

    db.prepare("DELETE FROM transcripts WHERE segment_id = ?").run(segmentId);
    db.prepare(
      `INSERT INTO transcripts (segment_id, language, full_text, words_json, segments_json)
       VALUES (@segmentId, @language, @fullText, @wordsJson, @segmentsJson)`
    ).run({
      segmentId,
      language: result.language ?? "zh",
      fullText: result.text,
      wordsJson: JSON.stringify(result.words ?? []),
      segmentsJson: JSON.stringify(result.segments ?? [])
    });

    db.prepare(
      `UPDATE segments
       SET status = 'ready',
           duration = COALESCE(@duration, duration),
           updated_at = unixepoch()
       WHERE id = @segmentId`
    ).run({
      segmentId,
      duration: result.duration == null ? null : Math.round(result.duration)
    });

    updateSessionTotals(segment.session_id);
    publishProgress(segmentId, 100, "ready");
    eventBus.publish("segment.transcription_completed", { segmentId, sessionId: segment.session_id });

    // 尝试生成候选片段（如果 session 所有分段都已转写完成）
    void tryGenerateCandidates(segment.session_id).catch((err) => {
      console.error(`Failed to generate candidates for session ${segment.session_id}:`, err);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE segments SET status = 'error', error_msg = @message, updated_at = unixepoch() WHERE id = @segmentId").run({
      segmentId,
      message
    });
    eventBus.publish("segment.transcription_failed", { segmentId, error: message });
  }
}

function updateSegmentStatus(segmentId: number, status: string) {
  getDb().prepare("UPDATE segments SET status = @status, updated_at = unixepoch() WHERE id = @segmentId").run({
    segmentId,
    status
  });
}

function updateSessionTotals(sessionId: number) {
  const db = getDb();
  const totals = row<{ duration: number | null; size: number | null; notReady: number }>(
    db.prepare(
      `SELECT SUM(COALESCE(duration, 0)) AS duration,
              SUM(COALESCE(size, 0)) AS size,
              SUM(CASE WHEN status IN ('pending', 'transcribing') THEN 1 ELSE 0 END) AS notReady
       FROM segments
       WHERE session_id = ?`
    ),
    sessionId
  );

  db.prepare(
    `UPDATE sessions
     SET total_duration = @duration,
         total_size = @size,
         status = CASE
           WHEN status = 'processing' AND @notReady = 0 THEN 'completed'
           ELSE status
         END,
         updated_at = unixepoch()
     WHERE id = @sessionId`
  ).run({
    sessionId,
    duration: totals?.duration ?? 0,
    size: totals?.size ?? 0,
    notReady: totals?.notReady ?? 0
  });
}

function publishProgress(segmentId: number, progress: number, status: string) {
  eventBus.publish("segment.transcription_progress", { segmentId, progress, status });
}
