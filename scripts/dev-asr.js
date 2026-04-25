import { spawn } from "node:child_process";
import path from "node:path";

/**
 * 单独启动 ASR Worker (V2 - SenseVoice)
 */
const asrDir = path.resolve("services/asr-worker");
const python = process.env.AICUT_PYTHON || "python";

console.log(`\x1b[33m[ASR Worker]\x1b[0m 启动中...`);
console.log(`  工作目录: ${asrDir}`);
console.log(`  Python: ${python}`);

const child = spawn(python, ["main.py"], {
  cwd: asrDir,
  env: { ...process.env },
  stdio: "inherit",
});

child.on("exit", (code) => {
  if (code && code !== 0) {
    console.error(`\x1b[31m[ASR Worker]\x1b[0m 异常退出 (code: ${code})`);
  }
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  console.log("\n\x1b[33m[ASR Worker]\x1b[0m 正在停止...");
  child.kill();
});
