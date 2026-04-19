import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row } from "../db/index.js";
import { assertReadableFile } from "../core/library/index.js";
import { eventBus } from "../events/bus.js";

const importInput = z.object({
  filePath: z.string().min(1),
  title: z.string().optional(),
  danmakuPath: z.string().optional()
});

export const importsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/imports/local", async (request, reply) => {
    const input = importInput.parse(request.body);
    const videoStat = assertReadableFile(input.filePath);
    if (input.danmakuPath) assertReadableFile(input.danmakuPath);

    const db = getDb();
    const sessionResult = db
      .prepare(
        `INSERT INTO sessions (session_type, title, status, total_size, start_time)
         VALUES ('import', @title, 'processing', @size, unixepoch())`
      )
      .run({
        title: input.title ?? path.basename(input.filePath),
        size: videoStat.size
      });

    const segmentResult = db
      .prepare(
        `INSERT INTO segments (session_id, file_path, size, has_danmaku, danmaku_path, status)
         VALUES (@sessionId, @filePath, @size, @hasDanmaku, @danmakuPath, 'pending')`
      )
      .run({
        sessionId: sessionResult.lastInsertRowid,
        filePath: input.filePath,
        size: videoStat.size,
        hasDanmaku: input.danmakuPath ? 1 : 0,
        danmakuPath: input.danmakuPath ?? null
      });

    eventBus.publish("import.created", {
      sessionId: sessionResult.lastInsertRowid,
      segmentId: segmentResult.lastInsertRowid
    });

    return reply.code(201).send(row(db.prepare("SELECT * FROM sessions WHERE id = ?"), sessionResult.lastInsertRowid));
  });
};
