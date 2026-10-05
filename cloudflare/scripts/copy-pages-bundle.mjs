import { copyFile, mkdir } from "node:fs/promises";

await mkdir("pages-dist", { recursive: true });
await copyFile("pages-bundle/index.js", "pages-dist/_worker.js");
console.log("Pages Advanced Mode bundle copied to pages-dist/_worker.js");
