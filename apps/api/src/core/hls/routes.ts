import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import { getManifest, generateM3u8 } from "./manifest.js";
import { getSegmentBySequence } from "../recorder/playlist.js";

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
    const seqStr = segmentId.replace(".ts", "");
    const sequence = parseInt(seqStr.replace("seq_", ""), 10);

    // 从内存 playlist 查找（playlist 路由已预加载到内存）
    const seg = getSegmentBySequence(sessionId, sequence);
    if (!seg) {
      return reply.code(404).send({ error: "Segment not found" });
    }

    if (!fs.existsSync(seg.filePath)) {
      return reply.code(404).send({ error: "Segment file not found" });
    }

    // segment 是不可变文件，允许浏览器缓存
    const stream = fs.createReadStream(seg.filePath);
    reply.header("content-type", "video/mp2t");
    reply.header("cache-control", "public, max-age=86400, immutable");
    return stream;
  });
};
