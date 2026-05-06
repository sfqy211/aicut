import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

export const config = {
  host: "127.0.0.1",
  port: 43110,
  dbPath: resolveFromRoot("./library/aicut.db"),
  libraryRoot: resolveFromRoot("./library"),
  ffmpegPath: path.join(repoRoot, "bin", "ffmpeg.exe"),
};
