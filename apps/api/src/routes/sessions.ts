import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row, rows } from "../db/index.js";

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sessions/overview", async () => {
    const db = getDb();
    return {
      recording: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'recording'")
      )?.count ?? 0,
      // V2: 流式 ASR 不再按 segment 排队，这些计数保持为 0
      transcribing: 0,
      queued: 0,
      readySegments: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM segments")
      )?.count ?? 0,
      pendingCandidates: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE status = 'pending'")
      )?.count ?? 0
    };
  });

  app.get("/sessions", async () => {
    return rows(
      getDb().prepare(
        `SELECT sessions.*, sources.room_id, sources.streamer_name
         FROM sessions
         LEFT JOIN sources ON sources.id = sessions.source_id
         ORDER BY sessions.id DESC`
      )
    );
  });

  app.get("/sessions/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();
    const session = row(db.prepare("SELECT * FROM sessions WHERE id = ?"), params.id);
    if (!session) return reply.notFound("Session not found");

    // V2: transcripts 为 session 级，单独查询
    const transcript = row<{ full_text: string | null; segments_json: string | null }>(
      db.prepare("SELECT full_text, segments_json FROM transcripts WHERE session_id = ?"),
      params.id
    );

    return {
      session,
      segments: rows(
        db.prepare(
          `SELECT segments.*,
                  @fullText AS transcript_text,
                  @segmentsJson AS segments_json,
                  COUNT(danmaku_events.id) AS danmaku_count
           FROM segments
           LEFT JOIN danmaku_events ON danmaku_events.segment_id = segments.id
           WHERE segments.session_id = ?
           GROUP BY segments.id
           ORDER BY segments.start_offset ASC`
        ),
        params.id
      ).map((s: any) => ({ ...s, transcript_text: transcript?.full_text ?? null, segments_json: transcript?.segments_json ?? null })),
      candidates: rows(db.prepare("SELECT * FROM candidates WHERE session_id = ? ORDER BY score_total DESC"), params.id)
    };
  });

  app.get("/sessions/:id/danmaku", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const query = z.object({ since: z.coerce.number().optional() }).parse(request.query);
    const db = getDb();

    const session = row(db.prepare("SELECT id FROM sessions WHERE id = ?"), params.id);
    if (!session) return reply.notFound("Session not found");

    const since = query.since;
    const sql = `
      SELECT de.id, de.event_type, de.timestamp_ms, de.text, de.user_id, de.price
      FROM danmaku_events de
      JOIN segments s ON s.id = de.segment_id
      WHERE s.session_id = ?
        ${since !== undefined ? "AND de.timestamp_ms > ?" : ""}
      ORDER BY de.timestamp_ms ASC
      LIMIT 5000
    `;
    const stmt = db.prepare(sql);
    const result = since !== undefined
      ? rows(stmt, [params.id, since])
      : rows(stmt, params.id);

    return result;
  });
};
