import fs from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { generatePreview } from "../core/export/ffmpeg.js";
import { getDb, row, rows } from "../db/index.js";
import { eventBus } from "../events/bus.js";

const reviewInput = z.object({
  note: z.string().optional()
});

const bulkApproveInput = z.object({
  ids: z.array(z.number().int().positive())
});

const previewQuery = z.object({
  padding: z.coerce.number().int().min(0).max(30).default(12)
});

type CandidateMediaRow = {
  id: number;
  session_id: number;
  start_time: number;
  end_time: number;
  duration: number;
  ai_description: string | null;
  created_at: number;
  updated_at: number;
  session_title?: string | null;
  session_duration?: number | null;
};

export const candidatesRoutes: FastifyPluginAsync = async (app) => {
  // 获取候选列表（支持筛选）
  app.get("/candidates", async (request) => {
    const query = z
      .object({
        status: z.string().optional(),
        sessionId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100)
      })
      .parse(request.query);

    const db = getDb();
    let sql: string;
    let params: unknown[];

    if (query.sessionId && query.status) {
      sql = `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
             FROM candidates c
             LEFT JOIN sessions s ON s.id = c.session_id
             WHERE c.session_id = ? AND c.status = ?
             ORDER BY c.created_at DESC`;
      params = [query.sessionId, query.status];
    } else if (query.sessionId) {
      sql = `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
             FROM candidates c
             LEFT JOIN sessions s ON s.id = c.session_id
             WHERE c.session_id = ?
             ORDER BY c.created_at DESC`;
      params = [query.sessionId];
    } else if (query.status) {
      sql = `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
             FROM candidates c
             LEFT JOIN sessions s ON s.id = c.session_id
             WHERE c.status = ?
             ORDER BY c.created_at DESC
             LIMIT ?`;
      params = [query.status, query.limit];
    } else {
      sql = `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
             FROM candidates c
             LEFT JOIN sessions s ON s.id = c.session_id
             ORDER BY c.created_at DESC
             LIMIT ?`;
      params = [query.limit];
    }

    return rows(db.prepare(sql), params);
  });

  // 获取单个候选详情
  app.get("/candidates/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();

    const candidate = row(
      db.prepare(
        `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
         FROM candidates c
         LEFT JOIN sessions s ON s.id = c.session_id
         WHERE c.id = ?`
      ),
      params.id
    );

    if (!candidate) return reply.notFound("Candidate not found");
    return enrichCandidatePreview(candidate as CandidateMediaRow & Record<string, unknown>);
  });

  // 低码率候选预览
  app.get("/candidates/:id/preview.mp4", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const query = previewQuery.parse(request.query ?? {});
    const db = getDb();

    const candidate = row<CandidateMediaRow>(
      db.prepare("SELECT id, session_id, start_time, end_time, duration, ai_description, created_at, updated_at FROM candidates WHERE id = ?"),
      params.id
    );

    if (!candidate) return reply.notFound("Candidate not found");

    // Find the segment that contains the candidate's start time
    type SegmentRow = { file_path: string; start_offset: number; duration: number };
    const segment = row<SegmentRow>(
      db.prepare(
        `SELECT file_path, start_offset, duration FROM segments
         WHERE session_id = ? AND start_offset <= ? AND (start_offset + duration) >= ?
         ORDER BY start_offset ASC
         LIMIT 1`
      ),
      [candidate.session_id, candidate.start_time, candidate.start_time]
    );

    if (!segment) return reply.notFound("Candidate media not found");
    if (!fs.existsSync(segment.file_path)) {
      return reply.notFound("Candidate source file missing");
    }

    const previewInfo = computePreviewWindow(candidate, segment, query.padding);
    const previewDir = path.join(config.libraryRoot, "previews");
    fs.mkdirSync(previewDir, { recursive: true });

    const previewName = [
      `candidate_${candidate.id}`,
      candidate.start_time,
      candidate.end_time,
      previewInfo.previewStart,
      previewInfo.previewEnd
    ].join("_");
    const previewPath = path.join(previewDir, `${previewName}.mp4`);

    if (!fs.existsSync(previewPath)) {
      await generatePreview(
        segment.file_path,
        previewPath,
        previewInfo.localPreviewStart,
        previewInfo.previewDuration
      );
    }

    return streamVideoFile(reply, previewPath);
  });

  // 批准候选
  app.post("/candidates/:id/approve", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = reviewInput.parse(request.body ?? {});
    const db = getDb();

    const candidate = row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
    if (!candidate) return reply.notFound("Candidate not found");

    db.prepare(
      "UPDATE candidates SET status = 'approved', user_note = @note, updated_at = unixepoch() WHERE id = @id"
    ).run({
      id: params.id,
      note: input.note ?? null
    });

    eventBus.publish("candidate.approved", { id: params.id });
    return row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
  });

  // 驳回候选
  app.post("/candidates/:id/reject", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = reviewInput.parse(request.body ?? {});
    const db = getDb();

    const candidate = row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
    if (!candidate) return reply.notFound("Candidate not found");

    db.prepare(
      "UPDATE candidates SET status = 'rejected', user_note = @note, updated_at = unixepoch() WHERE id = @id"
    ).run({
      id: params.id,
      note: input.note ?? null
    });

    eventBus.publish("candidate.rejected", { id: params.id });
    return row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
  });

  // 批量批准
  app.post("/candidates/bulk-approve", async (request) => {
    const input = bulkApproveInput.parse(request.body);
    const db = getDb();

    const placeholders = input.ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE candidates SET status = 'approved', updated_at = unixepoch() WHERE id IN (${placeholders})`
    ).run(...input.ids);

    for (const id of input.ids) {
      eventBus.publish("candidate.approved", { id });
    }

    return { updated: input.ids.length };
  });
};

function enrichCandidatePreview<T extends CandidateMediaRow & Record<string, unknown>>(candidate: T) {
  // Preview times are based on global session timestamps
  const padding = 12;
  const previewStart = Math.max(0, candidate.start_time - padding);
  const previewEnd = candidate.end_time + padding;
  const previewDuration = Math.max(1, previewEnd - previewStart);

  return {
    ...candidate,
    preview_start_time: previewStart,
    preview_end_time: previewEnd,
    preview_duration: previewDuration,
    preview_padding: padding,
    preview_url: `/api/candidates/${candidate.id}/preview.mp4?padding=${padding}`
  };
}

type SegmentInfo = { file_path: string; start_offset: number; duration: number };

function computePreviewWindow(candidate: CandidateMediaRow, segment: SegmentInfo, padding: number) {
  const segmentStart = segment.start_offset;
  const relativeClipStart = Math.max(0, candidate.start_time - segmentStart);
  const relativeClipEnd = Math.max(relativeClipStart + 1, candidate.end_time - segmentStart);
  const segmentDuration = Math.max(
    segment.duration,
    relativeClipEnd,
    candidate.duration
  );

  const localPreviewStart = Math.max(0, relativeClipStart - padding);
  const localPreviewEnd = Math.min(segmentDuration, relativeClipEnd + padding);
  const previewDuration = Math.max(1, localPreviewEnd - localPreviewStart);
  const previewStart = segmentStart + localPreviewStart;
  const previewEnd = previewStart + previewDuration;

  return {
    segmentStart,
    segmentDuration,
    localPreviewStart,
    localPreviewEnd,
    previewStart,
    previewEnd,
    previewDuration,
    relativeClipStart: candidate.start_time - previewStart,
    relativeClipEnd: candidate.end_time - previewStart
  };
}

async function streamVideoFile(
  reply: FastifyReply,
  filePath: string
) {
  const stat = fs.statSync(filePath);
  const range = reply.request.headers.range;

  reply.header("accept-ranges", "bytes");
  reply.header("content-type", "video/mp4");
  reply.header("cache-control", "private, max-age=300");

  if (!range) {
    reply.header("content-length", stat.size);
    return reply.send(fs.createReadStream(filePath));
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    return reply.code(416).send("Invalid range");
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : stat.size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
    return reply.code(416).send("Range not satisfiable");
  }

  reply.code(206);
  reply.header("content-range", `bytes ${start}-${end}/${stat.size}`);
  reply.header("content-length", end - start + 1);
  return reply.send(fs.createReadStream(filePath, { start, end }));
}
