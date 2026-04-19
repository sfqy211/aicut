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
      includeSubtitles: z.boolean().default(true),
      includeDanmaku: z.boolean().default(false),
      quality: z.enum(["source", "balanced"]).default("source")
    })
    .default({})
});

export const exportsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/exports", async () => {
    return rows(getDb().prepare("SELECT * FROM exports ORDER BY id DESC LIMIT 200"));
  });

  app.post("/exports", async (request, reply) => {
    const input = exportInput.parse(request.body);
    const db = getDb();
    const outputPath = path.join(libraryPaths.exports, `session-${input.sessionId}-${Date.now()}.mp4`);
    const result = db
      .prepare(
        `INSERT INTO exports (session_id, candidate_ids, output_path, options_json, status, progress)
         VALUES (@sessionId, @candidateIds, @outputPath, @options, 'pending', 0)`
      )
      .run({
        sessionId: input.sessionId,
        candidateIds: JSON.stringify(input.candidateIds),
        outputPath,
        options: JSON.stringify(input.options)
      });

    eventBus.publish("export.created", { id: result.lastInsertRowid });
    return reply.code(201).send(row(db.prepare("SELECT * FROM exports WHERE id = ?"), result.lastInsertRowid));
  });
};
