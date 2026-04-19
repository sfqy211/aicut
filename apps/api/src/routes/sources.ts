import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDb, row, rows } from "../db/index.js";
import { eventBus } from "../events/bus.js";

const sourceInput = z.object({
  roomId: z.string().min(1),
  streamerName: z.string().optional(),
  cookie: z.string().optional(),
  autoRecord: z.boolean().optional(),
  outputDir: z.string().optional()
});

export const sourcesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sources", async () => {
    return rows(getDb().prepare("SELECT * FROM sources ORDER BY id DESC"));
  });

  app.post("/sources/bilibili", async (request, reply) => {
    const input = sourceInput.parse(request.body);
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO sources (platform, room_id, streamer_name, cookie, auto_record, output_dir)
         VALUES ('bilibili', @roomId, @streamerName, @cookie, @autoRecord, @outputDir)`
      )
      .run({
        roomId: input.roomId,
        streamerName: input.streamerName ?? null,
        cookie: input.cookie ?? null,
        autoRecord: input.autoRecord === false ? 0 : 1,
        outputDir: input.outputDir ?? null
      });

    const source = row(db.prepare("SELECT * FROM sources WHERE id = ?"), result.lastInsertRowid);
    eventBus.publish("source.created", { id: result.lastInsertRowid });
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
           output_dir = COALESCE(@outputDir, output_dir),
           updated_at = unixepoch()
       WHERE id = @id`
    ).run({
      id: params.id,
      roomId: input.roomId ?? null,
      streamerName: input.streamerName ?? null,
      cookie: input.cookie ?? null,
      autoRecord: input.autoRecord === undefined ? null : input.autoRecord ? 1 : 0,
      outputDir: input.outputDir ?? null
    });

    eventBus.publish("source.updated", { id: params.id });
    return row(db.prepare("SELECT * FROM sources WHERE id = ?"), params.id);
  });

  app.delete("/sources/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    getDb().prepare("DELETE FROM sources WHERE id = ?").run(params.id);
    eventBus.publish("source.deleted", { id: params.id });
    return reply.code(204).send();
  });
};
