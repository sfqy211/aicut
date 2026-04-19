import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row, rows } from "../db/index.js";
import { libraryPaths } from "../core/library/index.js";
import { eventBus } from "../events/bus.js";

const exportInput = z.object({
  sessionId: z.number().int().positive(),
  candidateIds: z.array(z.number().int().positive()).min(1),
  options: z
    .object({
      hardcodeSubtitles: z.boolean().default(false),
      hardcodeDanmaku: z.boolean().default(false),
      quality: z.enum(["original", "1080p", "720p"]).default("original"),
      format: z.enum(["mp4", "webm"]).default("mp4"),
    })
    .default({}),
});

export const exportsRoutes: FastifyPluginAsync = async (app) => {
  // 获取导出列表
  app.get("/exports", async (request) => {
    const query = z
      .object({
        sessionId: z.coerce.number().int().positive().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query ?? {});

    const db = getDb();
    let sql: string;
    let params: unknown[];

    if (query.sessionId && query.status) {
      sql = `SELECT e.*, s.title AS session_title
             FROM exports e
             LEFT JOIN sessions s ON s.id = e.session_id
             WHERE e.session_id = ? AND e.status = ?
             ORDER BY e.id DESC`;
      params = [query.sessionId, query.status];
    } else if (query.sessionId) {
      sql = `SELECT e.*, s.title AS session_title
             FROM exports e
             LEFT JOIN sessions s ON s.id = e.session_id
             WHERE e.session_id = ?
             ORDER BY e.id DESC`;
      params = [query.sessionId];
    } else if (query.status) {
      sql = `SELECT e.*, s.title AS session_title
             FROM exports e
             LEFT JOIN sessions s ON s.id = e.session_id
             WHERE e.status = ?
             ORDER BY e.id DESC
             LIMIT ?`;
      params = [query.status, query.limit];
    } else {
      sql = `SELECT e.*, s.title AS session_title
             FROM exports e
             LEFT JOIN sessions s ON s.id = e.session_id
             ORDER BY e.id DESC
             LIMIT ?`;
      params = [query.limit];
    }

    return rows(db.prepare(sql), params);
  });

  // 获取单个导出详情
  app.get("/exports/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();

    const exportJob = row(
      db.prepare(
        `SELECT e.*, s.title AS session_title
         FROM exports e
         LEFT JOIN sessions s ON s.id = e.session_id
         WHERE e.id = ?`
      ),
      params.id
    );

    if (!exportJob) return reply.notFound("Export not found");
    return exportJob;
  });

  // 创建导出任务
  app.post("/exports", async (request, reply) => {
    const input = exportInput.parse(request.body);
    const db = getDb();

    // 验证 session 存在
    const session = row(
      db.prepare("SELECT id FROM sessions WHERE id = ?"),
      input.sessionId
    );

    if (!session) return reply.notFound("Session not found");

    // 验证 candidates 存在且属于该 session
    const placeholders = input.candidateIds.map(() => "?").join(",");
    const validCandidates = rows<{ id: number }>(
      db.prepare(
        `SELECT id FROM candidates WHERE session_id = ? AND id IN (${placeholders})`
      ),
      [input.sessionId, ...input.candidateIds]
    );

    if (validCandidates.length === 0) {
      return reply.badRequest("No valid candidates found");
    }

    const result = db
      .prepare(
        `INSERT INTO exports (session_id, candidate_ids, options_json, status, progress)
         VALUES (@sessionId, @candidateIds, @options, 'pending', 0)`
      )
      .run({
        sessionId: input.sessionId,
        candidateIds: JSON.stringify(input.candidateIds),
        options: JSON.stringify(input.options),
      });

    const exportId = Number(result.lastInsertRowid);
    eventBus.publish("export.created", { id: exportId });

    // 异步处理导出
    const { processExportTask } = await import("../core/export/ffmpeg.js");
    processExportTask(exportId).catch((err) => {
      console.error(`Export ${exportId} failed:`, err);
    });

    return reply.code(201).send(row(db.prepare("SELECT * FROM exports WHERE id = ?"), exportId));
  });

  // 重试失败的导出
  app.post("/exports/:id/retry", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();

    const exportJob = row<{ id: number; status: string }>(
      db.prepare("SELECT id, status FROM exports WHERE id = ?"),
      params.id
    );

    if (!exportJob) return reply.notFound("Export not found");

    if (exportJob.status !== "error") {
      return reply.badRequest("Can only retry failed exports");
    }

    // 重置状态
    db.prepare("UPDATE exports SET status = 'pending', progress = 0, error_msg = NULL WHERE id = ?").run(
      params.id
    );

    // 异步处理
    const { processExportTask } = await import("../core/export/ffmpeg.js");
    processExportTask(params.id).catch((err) => {
      console.error(`Export ${params.id} retry failed:`, err);
    });

    return row(db.prepare("SELECT * FROM exports WHERE id = ?"), params.id);
  });

  // 取消导出
  app.delete("/exports/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const db = getDb();

    const exportJob = row<{ id: number; status: string }>(
      db.prepare("SELECT id, status FROM exports WHERE id = ?"),
      params.id
    );

    if (!exportJob) return reply.notFound("Export not found");

    if (exportJob.status === "completed") {
      return reply.badRequest("Cannot delete completed exports");
    }

    db.prepare("UPDATE exports SET status = 'cancelled' WHERE id = ?").run(params.id);
    return reply.code(204).send();
  });
};
