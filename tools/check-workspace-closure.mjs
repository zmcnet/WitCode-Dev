// 校验 pnpm workspace 依赖图是否闭合：所有 workspace:* 依赖都能在仓库内找到同名包。
// 用法: node check-workspace-closure.mjs <repo-root>
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node check-workspace-closure.mjs <repo-root>');
  process.exit(2);
}

const patterns = [
  'apps/dev-docs',
  'packages/*',
  'apps/zcode-cli',
  'apps/zcode-cli/packages/*',
  'apps/zcode-cli/tools/*',
];

const dirs = [];
for (const p of patterns) {
  if (!p.includes('*')) {
    dirs.push(join(root, p));
    continue;
  }
  const base = join(root, p.slice(0, p.indexOf('*')).replace(/\/$/, ''));
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base, { withFileTypes: true })) {
    if (name.isDirectory()) dirs.push(join(base, name.name));
  }
}

const packages = new Map();
for (const dir of dirs) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.name) continue;
  packages.set(pkg.name, pkgPath);
}

const missing = [];
let workspaceDeps = 0;
for (const [name, pkgPath] of packages) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field] ?? {};
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        workspaceDeps++;
        if (!packages.has(dep)) missing.push(`${name} -> ${dep} (${field})`);
      }
    }
  }
}

console.log(`workspace packages: ${packages.size}`);
console.log(`workspace:* deps: ${workspaceDeps}`);
console.log(`unresolved: ${missing.length}`);
for (const m of missing.slice(0, 30)) console.log('  ' + m);
process.exit(missing.length ? 1 : 0);
