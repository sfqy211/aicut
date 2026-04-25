import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { config } from "./config.js";
import { ensureLibrary } from "./core/library/index.js";
import {
  getRecorderStatus,
  restoreAutoRecorders,
  updateRecorderFfmpegPath,
} from "./core/recorder/recorderManager.js";
import { getDb, row } from "./db/index.js";
import { candidatesRoutes } from "./routes/candidates.js";
import { eventsRoutes } from "./routes/events.js";
import { exportsRoutes } from "./routes/exports.js";
import { hlsRoutes } from "./core/hls/index.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { settingsRoutes } from "./routes/settings.js";
import { sourcesRoutes } from "./routes/sources.js";

export async function buildServer() {
  ensureLibrary();
  const db = getDb();
  const persistedFfmpegPath = row<{ value: string }>(
    db.prepare("SELECT value FROM settings WHERE key = 'ffmpeg_path'")
  )?.value;
  const persistedRecorderSegment = row<{ value: string }>(
    db.prepare("SELECT value FROM settings WHERE key = 'recorder_segment'")
  )?.value;

  if (persistedFfmpegPath) {
    updateRecorderFfmpegPath(persistedFfmpegPath);
  }
  if (persistedRecorderSegment) {
    config.recorderSegment = persistedRecorderSegment;
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  await app.register(cors, { origin: true });
  await app.register(sensible);

  app.get("/api/health", async () => ({
    ok: true,
    recorder: getRecorderStatus(),
    libraryRoot: config.libraryRoot
  }));

  await app.register(sourcesRoutes, { prefix: "/api" });
  await app.register(hlsRoutes, { prefix: "/api" });
  await app.register(sessionsRoutes, { prefix: "/api" });
  await app.register(candidatesRoutes, { prefix: "/api" });
  await app.register(exportsRoutes, { prefix: "/api" });
  await app.register(settingsRoutes, { prefix: "/api" });
  await app.register(eventsRoutes, { prefix: "/api" });

  app.addHook("onReady", async () => {
    await restoreAutoRecorders();
  });

  return app;
}

const app = await buildServer();
await app.listen({ host: config.host, port: config.port });
