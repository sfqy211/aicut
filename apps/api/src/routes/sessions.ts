import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row, rows } from "../db/index.js";

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
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
      segments: rows(db.prepare("SELECT * FROM segments WHERE session_id = ? ORDER BY start_offset ASC"), params.id),
      candidates: rows(db.prepare("SELECT * FROM candidates WHERE session_id = ? ORDER BY score_total DESC"), params.id)
    };
  });
};
