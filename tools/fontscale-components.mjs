// One-off helper: wrap component CSS text font-sizes in calc(Npx * var(--font-scale, 1)).
// Usage: node tools/fontscale-components.mjs <file...>  (logs each replacement)
import { readFileSync, writeFileSync } from 'node:fs';

const RE = /font-size:\s*(\d+(?:\.\d+)?)px/g;
let total = 0;
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const hits = [];
  const out = src.replace(RE, (m, n, offset) => {
    // line number for logging
    const before = src.slice(0, offset);
    const line = before.split('\n').length;
    hits.push(`    ${line}  ${n}px -> calc(${n}px * var(--font-scale, 1))`);
    return `font-size: calc(${n}px * var(--font-scale, 1))`;
  });
  if (hits.length) {
    writeFileSync(file, out, 'utf8');
    total += hits.length;
    console.log(`${file}: ${hits.length}`);
    console.log(hits.join('\n'));
  } else {
    console.log(`${file}: 0 (unchanged)`);
  }
}
console.log(`TOTAL converted: ${total}`);
