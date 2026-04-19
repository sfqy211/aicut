import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row, rows } from "../db/index.js";
import { eventBus } from "../events/bus.js";

const reviewInput = z.object({
  note: z.string().optional()
});

const bulkApproveInput = z.object({
  ids: z.array(z.number().int().positive())
});

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
             ORDER BY c.score_total DESC`;
      params = [query.sessionId, query.status];
    } else if (query.sessionId) {
      sql = `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
             FROM candidates c
             LEFT JOIN sessions s ON s.id = c.session_id
             WHERE c.session_id = ?
             ORDER BY c.score_total DESC`;
      params = [query.sessionId];
    } else if (query.status) {
      sql = `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
             FROM candidates c
             LEFT JOIN sessions s ON s.id = c.session_id
             WHERE c.status = ?
             ORDER BY c.score_total DESC
             LIMIT ?`;
      params = [query.status, query.limit];
    } else {
      sql = `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration
             FROM candidates c
             LEFT JOIN sessions s ON s.id = c.session_id
             ORDER BY c.score_total DESC
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
        `SELECT c.*, s.title AS session_title, s.total_duration AS session_duration,
                seg.file_path AS segment_file_path
         FROM candidates c
         LEFT JOIN sessions s ON s.id = c.session_id
         LEFT JOIN segments seg ON seg.id = c.segment_id
         WHERE c.id = ?`
      ),
      params.id
    );

    if (!candidate) return reply.notFound("Candidate not found");
    return candidate;
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

  // 手动触发候选生成
  app.post("/candidates/generate/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();

    const session = row(
      db.prepare("SELECT id FROM sessions WHERE id = ?"),
      params.sessionId
    );

    if (!session) return reply.notFound("Session not found");

    // 动态导入避免循环依赖
    const { generateCandidates } = await import("../core/analysis/scoring.js");
    const count = await generateCandidates(params.sessionId);

    return { sessionId: params.sessionId, candidatesGenerated: count };
  });
};
