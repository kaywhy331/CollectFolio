// DCL-VER-02 -- Banned-phrase lint (UX Declutter PRD, Appendix C).
//
// Scans app/assets/js/**/*.js for governance/engineering vocabulary that must
// never reach collector-facing copy (RULE-3). JS comments are stripped first
// so // and /* */ code comments never trigger a hit -- the remainder (code
// plus string/template-literal content, where these phrases actually live)
// is matched against the Appendix-C pattern list.
//
// Usage:
//   node scripts/check-copy.mjs            # report only, always exits 0
//   node scripts/check-copy.mjs --strict   # exits 1 if any hit survives the allowlist
//
// Wiring into `npm test` / `npm run check` happens later (end of P1) -- this
// script is standalone for now (DCL-VER-02 scope only), reachable via
// `npm run lint:copy`.

import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scanRoot = resolve(root, 'app/assets/js');

// Appendix C -- exact phrase list, matched case-insensitively as a substring.
const BANNED_PATTERNS = [
  'research gate',
  'publication gate',
  'walk-forward',
  'feature-flag',
  'operator-review',
  'rights-cleared',
  'bounded crop',
  'scanner rollback',
  'research queue',
  'hosted isolation',
  'rollback checks',
  'append-only',
  'immutable key',
  'in this build',
  'this release',
  'intentionally unavailable',
  'authoritative catalog total',
  'fabricated',
  'exchange rate was guessed',
  'model baseline',
  'assumes flat market',
  'Collection intake',
  'Destination:',
  'not disclosed',
  'never inferred',
  'never rewritten',
];

// Per-file allowlist. Keys are paths relative to app/assets/js (posix-style).
//   full: true      -> the file is never scanned at all.
//   patterns: [...] -> hits for exactly these patterns (case-insensitive) are
//                      dropped for this file only; every other entry in
//                      BANNED_PATTERNS still applies normally.
const FILE_ALLOWLIST = {
  // The shared copy registry from DCL-LEX-01. It is the one legitimate home for
  // every string on this list -- including "never rewritten" (Appendix C:
  // "outside registry"). Fully exempt.
  'core/copy.js': { full: true },

  // DCL-LEX-11: the sanctioned single home for every data-integrity guarantee
  // (PRD Appendix B, rendered by methodologyDisclosure()). RULE-1 requires this
  // prose to exist in exactly one place app-wide, and this is that place --
  // policy language here ("fabricated", "never rewritten", "authoritative
  // catalog total", etc.) is the intended destination, not a violation. Fully
  // exempt for the same reason core/copy.js is.
  'core/methodology.js': { full: true },

  // "not disclosed" is part of the Data & Methodology disclosure body rendered by
  // dataDetailsSection() in this file (Appendix C carve-out: "outside Data &
  // Methodology"). This allowlist is file-level, not section-level -- the simplest
  // honest approximation available without a structural/DOM-aware parse. Caveat:
  // if "not disclosed" is ever added to this file *outside* dataDetailsSection,
  // this lint will not catch it. Every other Appendix-C pattern is still enforced
  // in this file.
  'views/price-intelligence-detail.js': { patterns: ['not disclosed'] },

  // Privacy-disclosure service name only. "CollectCapture" is not itself an
  // Appendix-C pattern, so this entry currently has no effect on hit counts --
  // it documents the intended exception ahead of DCL-SCAN-02/03 copy work.
  // Appendix-C patterns are deliberately NOT allowlisted here: the current
  // "bounded crop" / "scanner rollback" hits in these two files are real
  // pre-cleanup violations and must keep failing until that copy is rewritten.
  'views/add.js': { patterns: ['CollectCapture'] },
  'views/scan.js': { patterns: ['CollectCapture'] },
};

function toPosix(p) {
  return p.split(sep).join('/');
}

async function collectJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(full)));
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(full);
    }
  }
  return files;
}

const KEYWORDS_ALLOW_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'default', 'extends',
]);

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Strips // and /* * / comments from JS source, replacing their characters
 * with spaces (newlines preserved) so line numbers in the output stay
 * aligned with the original file. Tracks single/double-quoted strings and
 * template literals (including ${...} interpolation) so comment-looking
 * sequences inside string content are left untouched, and applies a light
 * regex-literal heuristic so a `/pattern/` isn't misread as a comment
 * opener.
 */
function stripComments(source) {
  const out = [];
  const stack = [{ type: 'root' }];
  let regexAllowed = true;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const top = stack[stack.length - 1];
    const ch = source[i];

    if (top.type === 'single' || top.type === 'double') {
      if (ch === '\\' && i + 1 < n) {
        out.push(ch, source[i + 1]);
        i += 2;
        continue;
      }
      if ((top.type === 'single' && ch === "'") || (top.type === 'double' && ch === '"')) {
        stack.pop();
      }
      out.push(ch);
      i += 1;
      continue;
    }

    if (top.type === 'template') {
      if (ch === '\\' && i + 1 < n) {
        out.push(ch, source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '`') {
        stack.pop();
        out.push(ch);
        i += 1;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        stack.push({ type: 'interp', depth: 1 });
        out.push('$', '{');
        i += 2;
        regexAllowed = true;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }

    // top.type is 'root' or 'interp' here -- ordinary code context.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(source[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      regexAllowed = true;
      continue;
    }

    if (ch === "'") {
      stack.push({ type: 'single' });
      out.push(ch);
      i += 1;
      regexAllowed = false;
      continue;
    }
    if (ch === '"') {
      stack.push({ type: 'double' });
      out.push(ch);
      i += 1;
      regexAllowed = false;
      continue;
    }
    if (ch === '`') {
      stack.push({ type: 'template' });
      out.push(ch);
      i += 1;
      regexAllowed = false;
      continue;
    }

    if (top.type === 'interp' && ch === '{') {
      top.depth += 1;
      out.push(ch);
      i += 1;
      regexAllowed = true;
      continue;
    }
    if (top.type === 'interp' && ch === '}') {
      top.depth -= 1;
      out.push(ch);
      i += 1;
      if (top.depth === 0) {
        stack.pop();
      }
      regexAllowed = false;
      continue;
    }

    if (ch === '/' && regexAllowed) {
      // Try to consume a full regex literal so its body is never re-scanned
      // for comment openers. Falls back to plain division if it doesn't
      // close before a newline (can't be a valid regex literal then).
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== '\n') {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') { inClass = true; j += 1; continue; }
        if (c === ']') { inClass = false; j += 1; continue; }
        if (c === '/' && !inClass) { closed = true; j += 1; break; }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-zA-Z]/.test(source[j])) j += 1;
        out.push(source.slice(i, j));
        i = j;
        regexAllowed = false;
        continue;
      }
      // Not a closable regex literal -- treat '/' as division below.
    }

    if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < n && WORD_CHAR.test(source[j])) j += 1;
      const word = source.slice(i, j);
      out.push(word);
      regexAllowed = /^\d/.test(word) ? false : KEYWORDS_ALLOW_REGEX.has(word);
      i = j;
      continue;
    }

    out.push(ch);
    i += 1;
    if (ch === ')' || ch === ']') {
      regexAllowed = false;
    } else if (!/\s/.test(ch)) {
      regexAllowed = true;
    }
  }

  return out.join('');
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATTERN_MATCHERS = BANNED_PATTERNS.map((pattern) => ({
  pattern,
  regex: new RegExp(escapeRegExp(pattern), 'i'),
}));

function findHits(strippedSource, relPath) {
  const allow = FILE_ALLOWLIST[relPath];
  if (allow?.full) return [];
  const allowedPatterns = new Set((allow?.patterns || []).map((p) => p.toLowerCase()));
  const lines = strippedSource.split('\n');
  const hits = [];
  lines.forEach((line, idx) => {
    for (const { pattern, regex } of PATTERN_MATCHERS) {
      if (allowedPatterns.has(pattern.toLowerCase())) continue;
      if (regex.test(line)) {
        hits.push({ file: relPath, line: idx + 1, pattern, snippet: line.trim().slice(0, 120) });
      }
    }
  });
  return hits;
}

async function main() {
  const strict = process.argv.includes('--strict');
  const files = (await collectJsFiles(scanRoot)).sort();
  const allHits = [];

  for (const file of files) {
    const relPath = toPosix(relative(scanRoot, file));
    const source = await readFile(file, 'utf8');
    const stripped = stripComments(source);
    allHits.push(...findHits(stripped, relPath));
  }

  const displayRoot = 'app/assets/js/';
  for (const hit of allHits) {
    console.log(`${displayRoot}${hit.file}:${hit.line}:${hit.pattern} | ${hit.snippet}`);
  }

  const fileCount = new Set(allHits.map((h) => h.file)).size;
  console.log('');
  console.log(
    allHits.length === 0
      ? 'check-copy: 0 violations.'
      : `check-copy: ${allHits.length} violation(s) across ${fileCount} file(s).`
  );

  if (strict && allHits.length > 0) {
    process.exitCode = 1;
  }
}

main();
