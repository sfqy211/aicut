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
      transcribing: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM segments WHERE status = 'transcribing'")
      )?.count ?? 0,
      queued: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM segments WHERE status = 'pending'")
      )?.count ?? 0,
      readySegments: row<{ count: number }>(
        db.prepare("SELECT COUNT(*) AS count FROM segments WHERE status = 'ready'")
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

    return {
      session,
      segments: rows(
        db.prepare(
          `SELECT segments.*,
                  transcripts.full_text AS transcript_text,
                  transcripts.segments_json,
                  COUNT(danmaku_events.id) AS danmaku_count
           FROM segments
           LEFT JOIN transcripts ON transcripts.segment_id = segments.id
           LEFT JOIN danmaku_events ON danmaku_events.segment_id = segments.id
           WHERE segments.session_id = ?
           GROUP BY segments.id
           ORDER BY segments.start_offset ASC`
        ),
        params.id
      ),
      candidates: rows(db.prepare("SELECT * FROM candidates WHERE session_id = ? ORDER BY score_total DESC"), params.id)
    };
  });
};
