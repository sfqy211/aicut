import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const apiDistDir = path.join(repoRoot, "apps", "api", "dist");
const schemaSrc = path.join(repoRoot, "apps", "api", "src", "db", "schema.sql");
const schemaDest = path.join(apiDistDir, "schema.sql");
const deployDir = path.join(repoRoot, "dist-resources", "api-runtime");

await fs.mkdir(apiDistDir, { recursive: true });
await fs.copyFile(schemaSrc, schemaDest);
await fs.rm(deployDir, { recursive: true, force: true });

execSync(`pnpm --filter @aicut/api deploy --prod --legacy "${deployDir}"`, {
  cwd: repoRoot,
  stdio: "inherit",
});
