// One-off helper: theme-aware color fixes for component CSS.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const DIR = 'apps/web/src/components';
const btnFiles = {
  'settings/automations/automations.css': 'automations',
  'settings/commands/commands.css': 'commands',
  'settings/hooks/hooks.css': 'hooks',
  'settings/mcp/mcp.css': 'mcp',
  'settings/plugins/plugins.css': 'plugins',
  'settings/skills/skills.css': 'skills',
};

function apply(file, pairs) {
  const path = `${DIR}/${file}`;
  let src = readFileSync(path, 'utf8');
  for (const [from, to, expected] of pairs) {
    const count = src.split(from).length - 1;
    if (count !== expected) {
      throw new Error(`${path}: expected ${expected} of "${from}", found ${count}`);
    }
    src = src.split(from).join(to);
    console.log(`  ${path}: ${count} x ${from} -> ${to}`);
  }
  writeFileSync(path, src, 'utf8');
}

for (const [file, prefix] of Object.entries(btnFiles)) {
  const pairs = [
    ['border-color: #5c2b2b;', 'border-color: var(--danger-border);', 1],
    ['color: #ffb4b4;', 'color: var(--danger-fg);', 1],
    ['border: 1px solid #5c2b2b;', 'border: 1px solid var(--danger-border);', ['automations', 'mcp', 'plugins'].includes(prefix) ? 1 : 0],
  ];
  apply(file, pairs);
  // Light theme: primary button uses --brand-strong (#000) → needs white foreground,
  // mirroring the global .theme-light .btn.primary fix in styles.css.
  appendFileSync(`${DIR}/${file}`, `\n/* Light 主题：主按钮底色为 --brand-strong(#000)，文字需反白。 */\n.theme-light .${prefix}-btn-primary {\n  color: #ffffff;\n}\n`);
}

// Status tag tints: derive from theme-aware --ok / --warn instead of dark-theme literals.
for (const file of ['settings/automations/automations.css', 'settings/mcp/mcp.css']) {
  apply(file, [
    ['border-color: rgba(74, 222, 128, 0.45);', 'border-color: color-mix(in srgb, var(--ok) 45%, transparent);', 1],
    ['background: rgba(74, 222, 128, 0.1);', 'background: color-mix(in srgb, var(--ok) 10%, transparent);', 1],
    ['border-color: rgba(248, 113, 113, 0.45);', 'border-color: color-mix(in srgb, var(--warn) 45%, transparent);', 1],
    ['background: rgba(248, 113, 113, 0.1);', 'background: color-mix(in srgb, var(--warn) 10%, transparent);', 1],
    ['background: rgba(248, 113, 113, 0.08);', 'background: color-mix(in srgb, var(--warn) 8%, transparent);', 1],
  ]);
}

apply('dock/dock.css', [
  ['background: rgba(74, 222, 128, 0.08);', 'background: color-mix(in srgb, var(--ok) 8%, transparent);', 1],
  ['background: rgba(248, 113, 113, 0.08);', 'background: color-mix(in srgb, var(--warn) 8%, transparent);', 1],
]);

console.log('DONE');
