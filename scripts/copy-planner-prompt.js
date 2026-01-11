const fs = require("node:fs");
const path = require("node:path");

const projectRoot = process.cwd();
const sourcePath = path.join(
  projectRoot,
  "src",
  "shared",
  "planner",
  "planner_system_prompt_v1.txt"
);
const targetDir = path.join(projectRoot, "dist", "shared", "planner");
const targetPath = path.join(targetDir, "planner_system_prompt_v1.txt");

try {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`[build] copied planner prompt to ${targetPath}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[build] failed to copy planner prompt: ${message}`);
  process.exitCode = 1;
}
