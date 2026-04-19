import { spawn } from "node:child_process";
import { config } from "../../config.js";

export type ClipExportOptions = {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
};

export function exportClip(options: ClipExportOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      String(options.startSeconds),
      "-i",
      options.inputPath,
      "-t",
      String(options.durationSeconds),
      "-c",
      "copy",
      options.outputPath
    ];
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `FFmpeg exited with code ${code}`));
      }
    });
  });
}
