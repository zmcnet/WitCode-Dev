import { readFileSync, writeFileSync } from 'node:fs';

function apply(file, pairs) {
  let src = readFileSync(file, 'utf8');
  for (const [from, to, expected] of pairs) {
    const count = src.split(from).length - 1;
    if (count !== expected) throw new Error(`${file}: "${from}" expected ${expected}, found ${count}`);
    src = src.split(from).join(to);
    console.log(`  ${file}: ${count} x ${from}`);
  }
  writeFileSync(file, src, 'utf8');
}

apply('apps/web/src/components/settings/mcp/mcp.css', [
  ['border-color: rgba(74, 222, 128, 0.45);', 'border-color: color-mix(in srgb, var(--ok) 45%, transparent);', 1],
  ['background: rgba(74, 222, 128, 0.1);', 'background: color-mix(in srgb, var(--ok) 10%, transparent);', 1],
  ['border-color: rgba(248, 113, 113, 0.45);', 'border-color: color-mix(in srgb, var(--warn) 45%, transparent);', 1],
  ['background: rgba(248, 113, 113, 0.1);', 'background: color-mix(in srgb, var(--warn) 10%, transparent);', 1],
]);

apply('apps/web/src/components/dock/dock.css', [
  ['background: rgba(74, 222, 128, 0.08);', 'background: color-mix(in srgb, var(--ok) 8%, transparent);', 1],
  ['background: rgba(248, 113, 113, 0.08);', 'background: color-mix(in srgb, var(--warn) 8%, transparent);', 1],
]);

console.log('DONE');
