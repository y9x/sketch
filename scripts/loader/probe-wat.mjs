// Locates the XOR-combine loop in the wasm text form. If the payload is
// decrypted by XORing an HMAC-SHA384 keystream, exactly one hot function should
// contain xor ops tightly coupled to i32/i64 loads and stores.
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
    
const WAT = "/home/user/src/krunkbox/bin/loader/loader.wat"

const rl = createInterface({ input: createReadStream(WAT), crlfDelay: Infinity })

let cur = null
const funcs = []
// wabt emits stripped modules as `(func (;12;) (type 3) ...`, with no $name.
const funcStartRe = /^\s*\(func\s+(?:\(;(\d+);\)|(\$[^\s)]+))/

let lineNo = 0
for await (const line of rl) {
  lineNo++
  const m = funcStartRe.exec(line)
  if (m) {
    if (cur) funcs.push(cur)
    cur = {
      name: m[1],
      startLine: lineNo,
      lines: 0,
      xor: 0,
      load: 0,
      store: 0,
      shl: 0,
      shr: 0,
      add: 0,
      rotl: 0,
      i64: 0,
      calls: 0,
    }
    continue
  }
  if (!cur) continue
  cur.lines++
  if (line.includes(".xor")) cur.xor++
  if (/\.load/.test(line)) cur.load++
  if (/\.store/.test(line)) cur.store++
  if (line.includes(".shl")) cur.shl++
  if (/\.shr_[su]/.test(line)) cur.shr++
  if (/\.add\b/.test(line)) cur.add++
  if (line.includes(".rotl") || line.includes(".rotr")) cur.rotl++
  if (line.includes("i64.")) cur.i64++
  if (/\bcall\b/.test(line)) cur.calls++
}
if (cur) funcs.push(cur)

console.log(`parsed ${funcs.length} functions from loader.wat (${lineNo} lines)\n`)

const hdr = (t) => console.log(`\n=== ${t} ===`)
const fmt = (f) =>
  `${f.name.padEnd(30)} L${String(f.startLine).padEnd(8)} len=${String(f.lines).padEnd(6)} ` +
  `xor=${String(f.xor).padEnd(5)} ld=${String(f.load).padEnd(5)} st=${String(f.store).padEnd(5)} ` +
  `rotl=${String(f.rotl).padEnd(5)} i64=${String(f.i64).padEnd(6)} calls=${f.calls}`

hdr("Top 15 by absolute xor count (SHA-512 compression will dominate)")
for (const f of [...funcs].sort((a, b) => b.xor - a.xor).slice(0, 15)) console.log(fmt(f))

hdr("Top 15 XOR-dense but SMALL (a payload XOR loop is short & tight)")
for (const f of [...funcs]
  .filter((f) => f.xor >= 1 && f.lines > 0 && f.lines < 400)
  .sort((a, b) => b.xor / b.lines - a.xor / a.lines)
  .slice(0, 15))
  console.log(fmt(f) + `  density=${(f.xor / f.lines).toFixed(3)}`)

hdr("XOR present, NO rotl, i64-light -> byte/word XOR combine, not a hash core")
for (const f of [...funcs]
  .filter((f) => f.xor >= 2 && f.rotl === 0 && f.i64 <= 4 && f.store >= 1)
  .sort((a, b) => b.xor - a.xor)
  .slice(0, 25))
  console.log(fmt(f))
