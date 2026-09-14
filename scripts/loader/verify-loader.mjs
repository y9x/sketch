// Exercises the loader's decrypt -> brotli -> reassemble -> param recovery path.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { brotli_dec, initSync } from "brotli-dec-wasm/web";

const fromRoot = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

const sha = (b) => createHash("sha256").update(b).digest("hex");

const ks = readFileSync(fromRoot("src/loader/keystream.bin"));
const metadata = readFileSync(fromRoot("src/loader/keystream.ts"), "utf8");
const BUILD = /KEYSTREAM_BUILD = "([^"]+)"/.exec(metadata)?.[1];
if (!BUILD) throw new Error("could not read KEYSTREAM_BUILD");

const splitDirs = ["core-dat-files", "data", "core-data"];
let parts = null;
for (const d of splitDirs) {
  const names = Array.from({ length: 8 }, (_u, i) =>
    d === "core-data" ? `${d}/split-${i}.bin` : `${d}/core.dat-${BUILD}.split-${i}`
  );
  if (names.every((n) => existsSync(fromRoot(n)))) {
    parts = names.map((n) => readFileSync(fromRoot(n)));
    console.log("using split dir:", d);
    break;
  }
}
if (!parts) throw new Error("no fixture splits found");

const ct = Buffer.concat(parts);
console.log("ct bytes    =", ct.length, "sha", sha(ct).slice(0, 24));
console.log("keystream   =", ks.length, "sha", sha(ks).slice(0, 24));
if (ct.length !== ks.length) throw new Error("length mismatch");

const plain = Buffer.alloc(ct.length);
for (let i = 0; i < ct.length; i++) plain[i] = ct[i] ^ ks[i];

initSync({ module: readFileSync(fromRoot("src/loader/brotli.wasm")) });
const body = brotli_dec(new Uint8Array(plain));
console.log("brotli out  =", body.length);

const full = Buffer.alloc(body.length + 2);
full[0] = 0x0a;
Buffer.from(body).copy(full, 1);
full[full.length - 1] = 0x0a;
const source = new TextDecoder("utf-8").decode(full);

console.log("source utf8 =", full.length, "chars", source.length);
if (source.length < 5_000_000) throw new Error("decoded source is too small");
new Function(source);

const IDENT_RE = /\b[0-9a-f]{20}\b/g;
const CALLBACK_RE = /'function'\s*==\s*typeof\s+([0-9a-f]{20})\s*&&\s*\1\s*\(/;
const seen = [];
let m;
while ((m = IDENT_RE.exec(source)) !== null)
  if (!seen.includes(m[0])) seen.push(m[0]);
const cb = CALLBACK_RE.exec(source);
const callback = cb ? cb[1] : seen[1];
const token = seen[0] === callback ? seen[1] : seen[0];
console.log("recovered   =", JSON.stringify([token, callback]));
if (!token || !callback) throw new Error("could not recover wrapper params");
console.log(`VERIFIED BUILD ${BUILD}`);
