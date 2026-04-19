import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

export const config = {
  host: process.env.AICUT_API_HOST ?? "127.0.0.1",
  port: Number(process.env.AICUT_API_PORT ?? 43110),
  dbPath: resolveFromRoot(process.env.AICUT_DB_PATH ?? "./library/aicut.db"),
  libraryRoot: resolveFromRoot(process.env.AICUT_LIBRARY_ROOT ?? "./library"),
  asrWorkerUrl: process.env.AICUT_ASR_WORKER_URL ?? "http://127.0.0.1:43112",
  ffmpegPath: process.env.AICUT_FFMPEG_PATH ?? "ffmpeg",
  recorderSegment: process.env.AICUT_RECORDER_SEGMENT ?? "30"
};
