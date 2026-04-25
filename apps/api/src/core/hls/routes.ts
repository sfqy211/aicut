import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import { getManifest, generateM3u8 } from "./manifest.js";

export const hlsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sessions/:id/hls/playlist.m3u8", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionId = Number(id);
    const manifest = getManifest(sessionId);
    if (!manifest) {
      return reply.code(404).send({ error: "Session manifest not found" });
    }

    const m3u8 = generateM3u8(sessionId);
    reply.header("content-type", "application/vnd.apple.mpegurl");
    reply.header("cache-control", "no-cache");
    return m3u8;
  });

  app.get("/sessions/:id/hls/:segmentId.ts", async (request, reply) => {
    const { id, segmentId } = request.params as { id: string; segmentId: string };
    const sessionId = Number(id);
    const manifest = getManifest(sessionId);
    if (!manifest) {
      return reply.code(404).send({ error: "Session manifest not found" });
    }

    const seg = manifest.segments.find((s) => s.id === segmentId.replace(".ts", ""));
    if (!seg) {
      return reply.code(404).send({ error: "Segment not found" });
    }

    if (!fs.existsSync(seg.filePath)) {
      return reply.code(404).send({ error: "Segment file not found" });
    }

    const stream = fs.createReadStream(seg.filePath);
    reply.header("content-type", "video/mp2t");
    reply.header("cache-control", "no-cache");
    return stream;
  });
};
