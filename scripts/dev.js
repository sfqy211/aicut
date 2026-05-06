import { spawn } from "node:child_process";

const processes = [
  {
    name: "api",
    command: "pnpm",
    args: ["--filter", "@aicut/api", "dev"],
  },
  {
    name: "web",
    command: "pnpm",
    args: ["--filter", "@aicut/web", "dev"],
  },
];

const children = processes.map((proc) => {
  const child = spawn(proc.command, proc.args, {
    cwd: proc.cwd ?? process.cwd(),
    env: proc.env ?? process.env,
    shell: process.platform === "win32",
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${proc.name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${proc.name}] ${chunk}`));
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${proc.name}] exited with code ${code}`);
    }
  });

  return child;
});

function shutdown() {
  for (const child of children) child.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
