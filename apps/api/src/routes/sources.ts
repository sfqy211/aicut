import fs from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getSourceRuntime, startRecorder, stopRecorder } from "../core/recorder/recorderManager.js";
import { getDb, row, rows } from "../db/index.js";
import { eventBus } from "../events/bus.js";

const sourceInput = z.object({
  roomId: z.string().min(1),
  streamerName: z.string().optional(),
  cookie: z.string().optional(),
  autoRecord: z.boolean().optional(),
  analysisInterval: z.number().int().min(0).max(60).optional(),
});

export const sourcesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sources", async () => {
    return rows<any>(getDb().prepare("SELECT * FROM sources ORDER BY id DESC")).map((source) => ({
      ...source,
      runtime: getSourceRuntime(source.id)
    }));
  });

  app.post("/sources/bilibili", async (request, reply) => {
    const input = sourceInput.parse(request.body);
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO sources (platform, room_id, streamer_name, cookie, auto_record, analysis_interval)
         VALUES ('bilibili', @roomId, @streamerName, @cookie, @autoRecord, @analysisInterval)`
      )
      .run({
        roomId: input.roomId,
        streamerName: input.streamerName ?? null,
        cookie: input.cookie ?? null,
        autoRecord: input.autoRecord === false ? 0 : 1,
        analysisInterval: input.analysisInterval ?? 5,
      });

    const source = row(db.prepare("SELECT * FROM sources WHERE id = ?"), result.lastInsertRowid);
    eventBus.publish("source.created", { id: result.lastInsertRowid });
    if (input.autoRecord !== false) {
      void startRecorder(Number(result.lastInsertRowid)).catch((error) => {
        eventBus.publish("source.recorder_error", {
          sourceId: result.lastInsertRowid,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return reply.code(201).send(source);
  });

  app.patch("/sources/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const input = sourceInput.partial().parse(request.body);
    const db = getDb();
    const existing = row(db.prepare("SELECT * FROM sources WHERE id = ?"), params.id);
    if (!existing) return reply.notFound("Source not found");

    db.prepare(
      `UPDATE sources
       SET room_id = COALESCE(@roomId, room_id),
           streamer_name = COALESCE(@streamerName, streamer_name),
           cookie = COALESCE(@cookie, cookie),
           auto_record = COALESCE(@autoRecord, auto_record),
           analysis_interval = COALESCE(@analysisInterval, analysis_interval),
           updated_at = unixepoch()
       WHERE id = @id`
    ).run({
      id: params.id,
      roomId: input.roomId ?? null,
      streamerName: input.streamerName ?? null,
      cookie: input.cookie ?? null,
      autoRecord: input.autoRecord === undefined ? null : input.autoRecord ? 1 : 0,
      analysisInterval: input.analysisInterval ?? null,
    });

    eventBus.publish("source.updated", { id: params.id });
    return row(db.prepare("SELECT * FROM sources WHERE id = ?"), params.id);
  });

  app.post("/sources/:id/start", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const existing = row(getDb().prepare("SELECT * FROM sources WHERE id = ?"), params.id);
    if (!existing) return reply.notFound("Source not found");
    try {
      return await startRecorder(params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventBus.publish("source.recorder_error", { sourceId: params.id, error: message });
      return reply.badRequest(`Failed to start recorder: ${message}`);
    }
  });

  app.post("/sources/:id/stop", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const existing = row(getDb().prepare("SELECT * FROM sources WHERE id = ?"), params.id);
    if (!existing) return reply.notFound("Source not found");
    try {
      return await stopRecorder(params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.badRequest(`Failed to stop recorder: ${message}`);
    }
  });

  app.get("/sources/:id/cover", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const source = row<{ room_id: string }>(getDb().prepare("SELECT room_id FROM sources WHERE id = ?"), params.id);
    if (!source) return reply.notFound("Source not found");

    const { findLatestLocalCover } = await import("../core/recorder/recorderManager.js");
    const coverPath = findLatestLocalCover(source.room_id);
    if (!coverPath || !fs.existsSync(coverPath)) {
      return reply.notFound("Cover not found");
    }

    const ext = path.extname(coverPath).toLowerCase();
    const mime: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    };
    reply.header("content-type", mime[ext] || "application/octet-stream");
    return reply.send(fs.createReadStream(coverPath));
  });

  app.delete("/sources/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    getDb().prepare("DELETE FROM sources WHERE id = ?").run(params.id);
    eventBus.publish("source.deleted", { id: params.id });
    return reply.code(204).send();
  });
};
