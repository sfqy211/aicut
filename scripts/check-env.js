import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["node", ["--version"]],
  ["pnpm", ["--version"]],
  ["python", ["--version"]],
  [process.env.AICUT_FFMPEG_PATH || "ffmpeg", ["-version"]],
];

for (const [bin, args] of checks) {
  try {
    const output =
      process.platform === "win32"
        ? execFileSync("cmd.exe", ["/d", "/s", "/c", `${bin} ${args.join(" ")}`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          })
        : execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    console.log(`[ok] ${bin}: ${output.split("\n")[0]}`);
  } catch {
    console.log(`[missing] ${bin}`);
  }
}

for (const dir of ["library", "library/sources", "library/transcripts", "library/candidates", "library/exports"]) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  console.log(`[ok] ${dir}`);
}
