#!/usr/bin/env node
/**
 * Pre-push secret guard.
 *
 * Scans every git-tracked file (and, when present, the built `dist/` output) for
 * credential-shaped strings. Exits non-zero on the first category that matches so a
 * leaked key can never be committed again.
 *
 * Usage:  node scripts/check-secrets.mjs
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PATTERNS = [
  { name: 'DeepSeek/OpenAI-style API key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub personal access token', re: /ghp_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub fine-grained token', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** Files we never want to flag (this guard itself documents the patterns). */
const ALLOWLIST = new Set(['scripts/check-secrets.mjs']);

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function scan(files, { relative }) {
  const hits = [];
  for (const file of files) {
    const rel = relative ? file : path.relative(process.cwd(), file);
    if (ALLOWLIST.has(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable
    }
    if (text.includes('\u0000')) continue; // binary
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      const match = re.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        hits.push({ rel, line, name, sample: `${match[0].slice(0, 6)}…(${match[0].length} chars)` });
      }
    }
  }
  return hits;
}

const hits = [
  ...scan(trackedFiles(), { relative: true }),
  ...scan(walk(path.resolve(process.cwd(), 'dist')), { relative: false }),
];

if (hits.length > 0) {
  console.error('\n✖ Secret scan FAILED — refusing to ship credentials:\n');
  for (const h of hits) console.error(`  ${h.rel}:${h.line}  ${h.name}  ${h.sample}`);
  console.error('\nRemove the credential (read it from process.env instead) and retry.\n');
  process.exit(1);
}

console.log('✔ Secret scan clean (git-tracked files + dist/)');
