#!/usr/bin/env node
/**
 * Extract plain text from the scanned 《逐词逐句精讲册英语一》 PDFs.
 *
 * The books are image-only PDFs (one full-page JPEG per page, no text layer), so
 * `pdftotext` yields nothing and Baidu's server-side parser returns no content
 * either. The only workable path is local OCR:
 *
 *   PDF page --pdftoppm--> PNG --tesseract(chi_sim+eng)--> text
 *
 * Each volume becomes `data/source/text/<year>.txt` with `<<<PAGE n>>>` markers so
 * downstream curators can cite the page they took something from.
 *
 * The raw PDFs, rendered pages and OCR text live under `data/`, which is already
 * git-ignored: they must never be committed.
 *
 * Usage:
 *   node scripts/extract-pdf-source.mjs [options]
 *
 * Options:
 *   --pdf-dir <dir>     where the PDFs live           (default data/source/pdf)
 *   --out-dir <dir>     where the .txt files go       (default data/source/text)
 *   --pages-dir <dir>   scratch dir for rendered PNGs (default data/source/pages)
 *   --dpi <n>           render resolution             (default 150)
 *   --workers <n>       parallel tesseract processes  (default CPU count, max 8)
 *   --only <year[,..]>  restrict to specific years
 *   --force             re-OCR volumes whose .txt already exists
 *   --keep-pages        keep rendered PNGs (default: delete after each volume)
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PDF_DIR = option('pdf-dir', 'data/source/pdf');
const OUT_DIR = option('out-dir', 'data/source/text');
const PAGES_DIR = option('pages-dir', 'data/source/pages');
const DPI = Number(option('dpi', '150'));
const WORKERS = Math.min(Number(option('workers', String(os.cpus().length))), 8);
const ONLY = option('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const FORCE = flag('force');
const KEEP_PAGES = flag('keep-pages');

const HAS_CHI_SIM = await checkChiSim();

async function checkChiSim() {
  try {
    const { stdout } = await execFileAsync('tesseract', ['--list-langs']);
    return stdout.includes('chi_sim');
  } catch {
    return false;
  }
}

function log(...parts) {
  console.log(`[extract] ${parts.join(' ')}`);
}

function yearOf(file) {
  const match = path.basename(file).match(/(\d{4})/);
  return match ? match[1] : null;
}

/** Simple fixed-size worker pool: `${WORKERS}` tasks run at once. */
async function pool(items, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(WORKERS, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function ocrPage(imagePath, txtPath) {
  // OMP_THREAD_LIMIT=1 is essential, not cosmetic: tesseract is built with OpenMP,
  // and with several OCR workers on a busy box its threads spin-wait instead of
  // yielding. Measured on a loaded 4-core machine: 182s CPU per page with spinning
  // vs ~7s with the limit set.
  await execFileAsync(
    'tesseract',
    [imagePath, txtPath.replace(/\.txt$/, ''), '-l', 'chi_sim+eng', '--psm', '3'],
    {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, OMP_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' },
    }
  );
}

async function extractVolume(pdfPath) {
  const year = yearOf(pdfPath);
  if (!year) {
    log(`skip (no 4-digit year in name): ${pdfPath}`);
    return { year: null, pages: 0, chars: 0 };
  }

  const outPath = path.join(OUT_DIR, `${year}.txt`);
  if (!FORCE && fs.existsSync(outPath) && fs.statSync(outPath).size > 2000) {
    log(`${year}: already extracted (${fs.statSync(outPath).size} bytes), skipping`);
    return { year, pages: 0, chars: fs.statSync(outPath).size, skipped: true };
  }

  const pageDir = path.join(PAGES_DIR, year);
  await fsp.rm(pageDir, { recursive: true, force: true });
  await fsp.mkdir(pageDir, { recursive: true });

  const started = Date.now();
  log(`${year}: rendering ${path.basename(pdfPath)} at ${DPI}dpi ...`);
  // JPEG, not PNG: a 150dpi page is ~28M pixels and PNG encoding dominates the
  // whole run (measured ~7.5s/page vs <1s/page for JPEG). Tesseract reads JPEG fine.
  await execFileAsync(
    'pdftoppm',
    ['-r', String(DPI), '-jpeg', '-jpegopt', 'quality=88', pdfPath, path.join(pageDir, 'page')],
    { maxBuffer: 16 * 1024 * 1024 }
  );

  const images = (await fsp.readdir(pageDir))
    .filter((name) => name.endsWith('.jpg'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (images.length === 0) throw new Error(`${year}: pdftoppm produced no pages`);

  const chunks = new Array(images.length);
  let done = 0;
  await pool(images, async (name, index) => {
    const imagePath = path.join(pageDir, name);
    const txtPath = path.join(pageDir, `${name}.txt`);
    await ocrPage(imagePath, txtPath);
    chunks[index] = await fsp.readFile(txtPath, 'utf8');
    done += 1;
    if (done % 10 === 0 || done === images.length) {
      const pct = Math.round((done / images.length) * 100);
      log(`${year}: OCR ${done}/${images.length} pages (${pct}%)`);
    }
  });

  const body = chunks
    .map((text, index) => `<<<PAGE ${index + 1}>>>\n${(text || '').replace(/\r\n/g, '\n').trim()}`)
    .join('\n\n');

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(outPath, body, 'utf8');

  if (!KEEP_PAGES) await fsp.rm(pageDir, { recursive: true, force: true });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(`${year}: done — ${images.length} pages, ${body.length} chars, ${seconds}s -> ${outPath}`);
  return { year, pages: images.length, chars: body.length };
}

async function main() {
  if (!HAS_CHI_SIM) {
    console.error(
      '[extract] FATAL: tesseract has no chi_sim language data. The books are\n' +
        'scanned Chinese pages, so English-only OCR is useless. Install chi_sim first:\n' +
        '  curl -fL -o /usr/share/tesseract-ocr/5/tessdata/chi_sim.traineddata \\\n' +
        '    https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata'
    );
    process.exit(1);
  }

  if (!fs.existsSync(PDF_DIR)) {
    console.error(`[extract] FATAL: pdf dir not found: ${PDF_DIR}`);
    process.exit(1);
  }

  const pdfs = (await fsp.readdir(PDF_DIR))
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .filter((name) => (ONLY.length ? ONLY.includes(yearOf(name)) : true))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => path.join(PDF_DIR, name));

  if (pdfs.length === 0) {
    console.error(`[extract] FATAL: no PDFs matched in ${PDF_DIR}`);
    process.exit(1);
  }

  log(`${pdfs.length} volume(s), dpi=${DPI}, workers=${WORKERS}`);
  const results = [];
  for (const pdf of pdfs) {
    try {
      results.push(await extractVolume(pdf));
    } catch (error) {
      console.error(`[extract] ${path.basename(pdf)} failed: ${error.message}`);
      results.push({ year: yearOf(pdf), error: error.message });
    }
  }

  const totalPages = results.reduce((sum, r) => sum + (r.pages || 0), 0);
  const totalChars = results.reduce((sum, r) => sum + (r.chars || 0), 0);
  log(`SUMMARY volumes=${results.length} pages=${totalPages} chars=${totalChars}`);
  for (const r of results) {
    if (r.error) log(`  ${r.year}: ERROR ${r.error}`);
  }
}

await main();
