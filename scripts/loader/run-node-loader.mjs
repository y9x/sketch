import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { chromium } from "/home/user/src/krunkbox/node_modules/patchright/index.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

// 1. Ensure target directory exists for core.dat downloads
const coreDataDir = join(repoRoot, "core-dat-files");
if (!fs.existsSync(coreDataDir)) {
  fs.mkdirSync(coreDataDir, { recursive: true });
}

// 2. Ensure core-dat-files is in .gitignore
const gitignorePath = join(repoRoot, ".gitignore");
let gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
if (!gitignoreContent.includes("core-dat-files")) {
  gitignoreContent += (gitignoreContent.endsWith("\n") ? "" : "\n") + "core-dat-files/\n";
  fs.writeFileSync(gitignorePath, gitignoreContent);
  console.log("[NodeLoader] Added core-dat-files/ to .gitignore");
}

console.log("[NodeLoader] Step 1: Downloading 8 core.dat splits from live krunker.io...");

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  proxy: { server: "http://127.0.0.1:8888" },
});

const context = await browser.newContext();
const page = await context.newPage();

let capturedSource = "";
const downloadedChunks = new Map();

// Intercept network responses to save all 8 core.dat split chunks
page.on("response", async (res) => {
  const url = res.url();
  if (url.includes("core.dat") && url.includes("split-")) {
    try {
      const filename = url.split("/").pop().split("?")[0];
      const buf = await res.body();
      downloadedChunks.set(filename, buf);
      const savePath = join(coreDataDir, filename);
      fs.writeFileSync(savePath, buf);
      console.log(`[NodeLoader] -> Saved split chunk: ${filename} (${buf.length} bytes) to core-dat-files/`);
    } catch (e) {}
  }
});

// Suppress matchmaking network requests
await page.route("**/seek-game*", (route) => route.abort());

// Navigate to trigger asset downloads
console.log("[NodeLoader] Navigating to https://krunker.io/ ...");
await page.goto("https://krunker.io/", { waitUntil: "domcontentloaded", timeout: 35000 });

// Wait for all 8 splits to be downloaded
console.log("[NodeLoader] Waiting for all 8 core.dat split chunks to finish downloading...");
for (let i = 0; i < 30; i++) {
  if (downloadedChunks.size >= 8) break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log(`[NodeLoader] Download complete! Total chunks collected in core-dat-files/: ${downloadedChunks.size}`);
await browser.close();

// Step 2: Assemble or extract the decrypted JavaScript payload
console.log("\n[NodeLoader] Step 2: Resolving decrypted game source payload...");
let sourceCode = "";

const manifestPath = "/home/user/src/krunkbox/bin/game.manifest.json";
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  sourceCode = manifest.source;
} else {
  console.error("[NodeLoader] Failed to read decrypted source payload.");
  process.exit(1);
}

// Step 3: Format and inspect code structure
// Normalize leading/trailing whitespace
sourceCode = sourceCode.trim();

// To ensure readable first 20 and last 20 lines (and avoid single 8.6MB lines),
// we add structural line breaks at statement boundaries
const formattedCode = sourceCode
  .replace(/;\s*/g, ";\n")
  .replace(/\{\s*/g, "{\n")
  .replace(/\}\s*/g, "}\n");

const lines = formattedCode.split("\n").filter((l) => l.trim().length > 0);

console.log("\n================================================================================");
console.log("DECRYPTED GAME SOURCE CODE INSPECTION");
console.log(`Total Source Size: ${sourceCode.length.toLocaleString()} characters`);
console.log(`Total Structured Lines: ${lines.length.toLocaleString()}`);
console.log("================================================================================\n");

console.log("--- FIRST 20 LINES OF DECRYPTED CODE ---");
lines.slice(0, 20).forEach((line, index) => {
  console.log(`${String(index + 1).padStart(3, " ")} | ${line.slice(0, 100)}`);
});

console.log("\n--- LAST 20 LINES OF DECRYPTED CODE ---");
lines.slice(-20).forEach((line, index) => {
  const lineNum = lines.length - 20 + index + 1;
  console.log(`${String(lineNum).padStart(lines.length.toString().length, " ")} | ${line.slice(0, 100)}`);
});

console.log("\n================================================================================");
console.log("COMPILATION TEST: Compiling with new Function(\"WP_MMToken\", sourceCode)...");
console.log("================================================================================");

try {
  const compileStart = Date.now();
  const compiledFunction = new Function("WP_MMToken", sourceCode);
  const elapsed = Date.now() - compileStart;
  console.log(`>> SUCCESS: Code compiled into an executable JavaScript function in ${elapsed}ms!`);
  console.log(`>> Compiled Function Type: ${typeof compiledFunction}`);
  console.log(`>> Function Length (argc): ${compiledFunction.length}`);
} catch (error) {
  console.error(">> ERROR: Failed to compile decrypted code with new Function():", error);
  process.exit(1);
}

console.log("================================================================================\n");
