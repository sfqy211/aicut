import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row, rows } from "../db/index.js";
import { eventBus } from "../events/bus.js";

const reviewInput = z.object({
  note: z.string().optional()
});

export const candidatesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/candidates", async (request) => {
    const query = z
      .object({
        status: z.string().optional(),
        sessionId: z.coerce.number().int().positive().optional()
      })
      .parse(request.query);

    if (query.sessionId && query.status) {
      return rows(
        getDb().prepare("SELECT * FROM candidates WHERE session_id = ? AND status = ? ORDER BY score_total DESC"),
        [query.sessionId, query.status]
      );
    }
    if (query.sessionId) {
      return rows(getDb().prepare("SELECT * FROM candidates WHERE session_id = ? ORDER BY score_total DESC"), query.sessionId);
    }
    if (query.status) {
      return rows(getDb().prepare("SELECT * FROM candidates WHERE status = ? ORDER BY id DESC"), query.status);
    }

    return rows(getDb().prepare("SELECT * FROM candidates ORDER BY id DESC LIMIT 200"));
  });

  app.post("/candidates/:id/approve", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = reviewInput.parse(request.body ?? {});
    const db = getDb();
    const candidate = row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
    if (!candidate) return reply.notFound("Candidate not found");

    db.prepare("UPDATE candidates SET status = 'approved', user_note = @note, updated_at = unixepoch() WHERE id = @id").run({
      id: params.id,
      note: input.note ?? null
    });
    eventBus.publish("candidate.approved", { id: params.id });
    return row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
  });

  app.post("/candidates/:id/reject", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = reviewInput.parse(request.body ?? {});
    const db = getDb();
    const candidate = row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
    if (!candidate) return reply.notFound("Candidate not found");

    db.prepare("UPDATE candidates SET status = 'rejected', user_note = @note, updated_at = unixepoch() WHERE id = @id").run({
      id: params.id,
      note: input.note ?? null
    });
    eventBus.publish("candidate.rejected", { id: params.id });
    return row(db.prepare("SELECT * FROM candidates WHERE id = ?"), params.id);
  });
};
