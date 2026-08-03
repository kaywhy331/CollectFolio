import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const app = resolve(root, 'app');
const errors = [];
const placeholderPattern = new RegExp(`\\b(?:${['TO' + 'DO', 'FIX' + 'ME', 'CHANGE' + 'ME', 'YOUR_' + '[A-Z_]+' ].join('|')})\\b`);
const required = [
  'package.json', 'netlify.toml', 'README.md', 'app/index.html', 'app/manifest.webmanifest', 'app/sw.js',
  'app/assets/css/app.css', 'app/assets/js/app.js', 'app/assets/js/core/db.js', 'app/assets/js/core/calculations.js',
  'app/assets/js/services/catalog.js', 'app/assets/js/services/image-algorithms.js', 'app/assets/js/services/image.js',
  'app/assets/js/services/scan-workbench.js', 'app/assets/js/services/scan-review.js', 'app/assets/js/services/supabase.js',
  'supabase/migrations/0001_initial.sql', 'docs/PRD.md', 'docs/TECHNICAL_SPEC.md', 'docs/NETLIFY_DEPLOY.md'
];

async function filesUnder(directory) {
  const result = [];
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name);
    if ((await stat(path)).isDirectory()) result.push(...await filesUnder(path)); else result.push(path);
  }
  return result;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

for (const name of required) if (!await exists(resolve(root, name))) errors.push(`Missing required file: ${name}`);

const packageJSON = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (Object.keys(packageJSON.dependencies || {}).length || Object.keys(packageJSON.devDependencies || {}).length) errors.push('package.json must have zero dependencies and devDependencies.');
for (const script of ['dev', 'build', 'test', 'check']) if (!packageJSON.scripts?.[script]) errors.push(`Missing npm script: ${script}`);

const appFiles = await filesUnder(app);
const sourceFiles = [...appFiles, ...await filesUnder(resolve(root, 'scripts')), resolve(root, 'netlify.toml'), resolve(root, 'supabase/migrations/0001_initial.sql')];
for (const file of sourceFiles) {
  const extension = extname(file);
  if (!['.js', '.mjs', '.html', '.css', '.toml', '.sql', '.webmanifest'].includes(extension)) continue;
  const source = await readFile(file, 'utf8');
  if (placeholderPattern.test(source)) errors.push(`Unsafe placeholder in ${relative(root, file)}`);
  if (file !== resolve(root, 'scripts/dev.mjs') && /http:\/\//i.test(source)) errors.push(`Insecure URL in ${relative(root, file)}`);
}

const index = await readFile(resolve(app, 'index.html'), 'utf8');
for (const reference of ['./manifest.webmanifest', './runtime-config.js', './assets/css/app.css', './assets/js/app.js']) if (!index.includes(reference)) errors.push(`index.html does not reference ${reference}`);
for (const view of ['home', 'search', 'add', 'portfolio', 'profile']) if (!index.includes(`data-view="${view}"`)) errors.push(`index.html is missing ${view} navigation.`);

const serviceWorker = await readFile(resolve(app, 'sw.js'), 'utf8');
if (!serviceWorker.includes("const CACHE = 'collectfolio-shell-v0.1.1'")) errors.push('Service worker cache name must be collectfolio-shell-v0.1.1.');
if (!serviceWorker.includes('Promise.allSettled') && !(await readFile(resolve(app, 'assets/js/services/catalog.js'), 'utf8')).includes('Promise.allSettled')) errors.push('Catalog provider fan-out must use Promise.allSettled.');
for (const file of appFiles) {
  const name = `./${relative(app, file).replaceAll('\\', '/')}`;
  if (file === resolve(app, 'sw.js')) continue;
  if (!serviceWorker.includes(name)) errors.push(`Service-worker shell does not reference ${name}`);
}

const javascript = appFiles.filter((file) => extname(file) === '.js');
for (const file of javascript) {
  const source = await readFile(file, 'utf8');
  for (const tag of source.matchAll(/<img\b[^>]*>/g)) if (!/referrerpolicy=["']no-referrer["']/.test(tag[0])) errors.push(`External-capable image lacks no-referrer policy in ${relative(root, file)}`);
  for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1]);
    if (!await exists(target)) errors.push(`Unresolved import ${match[1]} in ${relative(root, file)}`);
  }
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`JavaScript syntax error in ${relative(root, file)}: ${checked.stderr.trim()}`);
}
for (const file of (await filesUnder(resolve(root, 'scripts'))).filter((path) => extname(path) === '.mjs')) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`JavaScript syntax error in ${relative(root, file)}: ${checked.stderr.trim()}`);
}

const migration = await readFile(resolve(root, 'supabase/migrations/0001_initial.sql'), 'utf8');
for (const table of ['profiles', 'holdings', 'holding_deletions', 'portfolio_snapshots', 'scan_sessions']) {
  if (!migration.includes(`create table if not exists public.${table}`)) errors.push(`Migration missing ${table}.`);
  if (!migration.includes(`alter table public.${table} enable row level security`)) errors.push(`Migration missing RLS for ${table}.`);
}

const netlify = await readFile(resolve(root, 'netlify.toml'), 'utf8');
for (const text of ['command = "npm run build"', 'publish = "dist"', 'NODE_VERSION = "22"', 'to = "/index.html"', 'for = "/sw.js"']) if (!netlify.includes(text)) errors.push(`netlify.toml missing ${text}`);
if (/unsafe-eval/.test(netlify)) errors.push('Content Security Policy must not allow unsafe-eval.');

if (errors.length) {
  console.error(`Validation failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`Validation passed: ${required.length} required files, ${javascript.length} browser modules, zero npm packages.`);
