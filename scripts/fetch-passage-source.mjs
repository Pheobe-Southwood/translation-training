#!/usr/bin/env node
/**
 * Fetch the public English source text for the 完型 / 阅读 long-sentence bank.
 *
 * Source: 懒笔记 (english-exam.lazynote.cn) — the same site already recorded as the
 * primary reference for the translation bank in `docs/DATA-SOURCES.md`. It serves
 * the exam texts server-rendered (no JSON payload), so this script scrapes the
 * section pages and normalises them into one JSON file per unit.
 *
 * Why this exists: the 《逐词逐句精讲册》 PDFs turned out to be image-only scans whose
 * OCR mangles the Chinese (columns interleaved, lines garbled), so the book could not
 * serve as the machine-readable source. The public pages instead carry, for every
 * passage, the textbook English text *and* a published paragraph-by-paragraph Chinese
 * translation, which is exactly the pairing the bank needs — so the book is kept only
 * as a later manual cross-check.
 *
 * Output: `data/source/web/<examId>.json`
 *   {
 *     examId, year, bank, partIndex, slug, url, fetchedAt, title,
 *     paragraphs: [{ index, en, zh }],   // English paragraph + its published translation
 *     clozeAnswers: { "<blank>": { letter, word } },   // cloze only, from 【答案】
 *     pageText                           // full stripped text, kept for reference
 *   }
 *
 * Cloze blanks are marked from the markup (`<u>&emsp;N&emsp;</u>` → `{{BLANK:N}}`) and
 * then substituted with the published answer word, because the flattened text also
 * contains genuine numbers that a `\sN\s` search cannot distinguish from a blank.
 *
 * Usage:
 *   node scripts/fetch-passage-source.mjs [--years 2004,2005] [--force] [--delay 1500]
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://english-exam.lazynote.cn';
const OUT_DIR = 'data/source/web';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) translation-training-bank/1.0';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const FORCE = args.includes('--force');
const BANK_FILTER = option('bank', '').trim();
const DELAY = Number(option('delay', '1500'));
const YEARS = option('years', '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 2002 && n <= 2026);
const REQUESTED_YEARS = YEARS.length ? YEARS : Array.from({ length: 22 }, (_, i) => 2004 + i);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(`[web] ${parts.join(' ')}`);

function slugFor(year) {
  return year <= 2009 ? String(year) : `${year}-english-one`;
}

async function fetchText(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (error) {
    if (attempt < 3) {
      await sleep(DELAY * attempt * 2);
      return fetchText(url, attempt + 1);
    }
    throw error;
  }
}

/** Strip tags but keep block boundaries so paragraph-level text survives. */
function toLines(html) {
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<(p|div|br|li|h[1-6]|td|th|tr|section|article)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const hasHan = (s) => /[\u4e00-\u9fff]/.test(s);
const looksEnglish = (s) => !hasHan(s) && (s.match(/[A-Za-z]{2,}/g) || []).length >= 8;

const hanCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/**
 * A paragraph start is either
 *  - reading: `P<n>` glued to the English text (`P1Hunting for a job…`);
 *  - cloze:   a long English line whose blanks are rendered as bare numbers
 *             (`Families have also  13  changes these years.`).
 */
function isParagraphStart(line, bank) {
  if (bank === 'cloze') {
    return looksEnglish(line) && line.length >= 80 && /\{\{BLANK:\d{1,2}\}\}/.test(line);
  }
  return /^P\d+\s*\S/.test(line) && line.length >= 40 && looksEnglish(line);
}

/**
 * Pair every English paragraph with the Chinese translation printed right after it.
 *
 * The site renders the passage paragraph-by-paragraph with the published Chinese
 * translation immediately following each paragraph, which is exactly the pairing
 * the passage bank needs: clean English plus an authoritative translation.
 */
function extractParagraphPairs(lines, bank) {
  const pairs = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isParagraphStart(line, bank)) continue;

    let index;
    let en;
    if (bank === 'cloze') {
      index = pairs.length + 1;
      en = line.trim();
    } else {
      const match = line.match(/^P(\d+)\s*([\s\S]+)$/);
      if (!match) continue;
      index = Number(match[1]);
      en = match[2].trim();
    }

    const key = `${index}:${en.slice(0, 60)}`;
    if (seen.has(`${index}`)) continue;
    if (en.length < 60) continue;

    const zhParts = [];
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j += 1) {
      const candidate = lines[j];
      if (isParagraphStart(candidate, bank)) break;
      if (hanCount(candidate) >= 15) {
        zhParts.push(candidate.trim());
        // A paragraph translation is normally one long line; two at most.
        if (zhParts.join('').length > 120) break;
      } else if (zhParts.length > 0) {
        break;
      }
    }

    if (zhParts.length === 0) {
      log(`  warn: paragraph ${index} has no Chinese translation`);
      continue;
    }

    seen.add(`${index}`);
    seen.add(key);
    pairs.push({ index, en, zh: zhParts.join('') });
  }

  pairs.sort((a, b) => a.index - b.index);
  return pairs;
}

/**
 * Parse the cloze answer key out of the section page.
 *
 * The page prints, per blank: `1.` / `【答案】` / `[ C ] centering固定搭配`. Only the
 * letter+word matter here — they are substituted back into the blank-numbered
 * passage so the bank stores a readable, complete article.
 */
function parseClozeAnswers(lines) {
  const answers = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '【答案】') continue;
    const match = (lines[i + 1] || '').match(/^\[\s*([A-D])\s*\]\s*(.+)$/);
    if (!match) continue;
    // The answer line is `[ C ] centering固定搭配` — the option text runs up to the
    // Chinese 考点 label. Options may be multi-word ("For example", "as well as",
    // "decide on", "In theory"), so cut at the first Han character instead of
    // matching a single Latin token.
    let word = match[2];
    const hanIndex = word.search(/[\u4e00-\u9fff]/);
    if (hanIndex >= 0) word = word.slice(0, hanIndex);
    word = word.trim().replace(/\s+/g, ' ');
    if (!word) continue;
    let number = null;
    for (let k = i - 1; k >= Math.max(0, i - 4); k -= 1) {
      const num = lines[k].match(/^(\d{1,2})\.$/);
      if (num) {
        number = Number(num[1]);
        break;
      }
    }
    if (number && number >= 1 && number <= 20) {
      answers.set(number, { letter: match[1], word });
    }
  }
  return answers;
}

/**
 * Turn every cloze blank into an unambiguous `{{BLANK:n}}` sentinel.
 *
 * The passage renders a blank as `<u>&emsp;N&emsp;</u>`; the per-blank analysis
 * section renders an empty `<u>` for the same slot. Only the underlined number is a
 * blank — the article also contains genuine numbers ("as young as 14 months"),
 * which a bare ` 14 ` text search cannot tell apart. That ambiguity previously
 * corrupted real numbers and left real blanks unfilled, so the marker has to be
 * taken from the markup, not guessed from the flattened text.
 */
function markClozeBlanks(html) {
  return html.replace(
    /<u[^>]*>((?:&emsp;|&nbsp;|&#\d+;|\s)*)(\d{1,2})((?:&emsp;|&nbsp;|&#\d+;|\s)*)<\/u>/g,
    (_match, _before, number) => ` {{BLANK:${number}}} `
  );
}

/** Substitute the parsed answer word into each sentinel. */
function fillClozeParagraph(text, answers) {
  const filled = text.replace(/\{\{BLANK:(\d{1,2})\}\}/g, (match, raw) => {
    const answer = answers.get(Number(raw));
    return answer ? answer.word : match;
  });
  // A blank next to punctuation leaves a stray space ("fades rather ,"); collapse it.
  return filled.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

function discoverSectionLinks(paperHtml, slug) {
  const links = new Set();
  const re = new RegExp(`href="(/kaoyan/sections/${slug}/section[^"]*)"`, 'g');
  let match;
  while ((match = re.exec(paperHtml))) links.add(match[1]);
  return [...links];
}

function partIndexFromLink(link) {
  if (/\/section1\/?$/.test(link)) return { bank: 'cloze', partIndex: 0 };
  const reading = link.match(/\/section2-part-a(?:-(\d+))?\/?$/);
  if (reading) return { bank: 'reading', partIndex: reading[1] ? Number(reading[1]) : 1 };
  return null;
}

async function fetchUnit(year, link, bank, partIndex) {
  const examId = bank === 'cloze' ? `${year}-cloze` : `${year}-reading-${partIndex}`;
  const outPath = path.join(OUT_DIR, `${examId}.json`);
  if (!FORCE && fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
    log(`${examId}: cached`);
    return { examId, cached: true };
  }

  const url = `${BASE}${link}`;
  const rawHtml = await fetchText(url);
  const html = bank === 'cloze' ? markClozeBlanks(rawHtml) : rawHtml;
  const lines = toLines(html);
  // Cloze pages repeat long English lines inside the per-blank analysis (【验证】
  // quotes the sentence with `__(n)__`), so restrict the article region to the
  // part between the Directions body and the first answer block.
  let clozeRegion = lines;
  if (bank === 'cloze') {
    const start = lines.findIndex((line) => /Read the following text/i.test(line));
    const answerStart = lines.findIndex((line, index) => index > Math.max(start, 0) && line.trim() === '【答案】');
    if (start >= 0) {
      clozeRegion = lines.slice(start + 1, answerStart > start ? answerStart : lines.length);
    }
  }

  const paragraphs = extractParagraphPairs(clozeRegion, bank);
  const answers = bank === 'cloze' ? parseClozeAnswers(lines) : new Map();
  if (bank === 'cloze') {
    for (const paragraph of paragraphs) {
      paragraph.enOriginal = paragraph.en;
      paragraph.en = fillClozeParagraph(paragraph.en, answers);
    }
    if (answers.size < 20) log(`  warn: only ${answers.size}/20 cloze answers parsed`);
    const unfilled = paragraphs
      .map((p) => p.en)
      .join(' ')
      .match(/\{\{BLANK:\d{1,2}\}\}/g);
    if (unfilled) log(`  warn: ${unfilled.length} blank(s) left unfilled: ${unfilled.join(',')}`);
  }

  const titleLine = lines.find((line) => /年考研英语.*真题/.test(line)) || '';

  const record = {
    examId,
    year,
    bank,
    partIndex,
    url,
    fetchedAt: new Date().toISOString().slice(0, 10),
    title: titleLine.slice(0, 200),
    paragraphs,
    ...(bank === 'cloze'
      ? { clozeAnswers: Object.fromEntries([...answers].map(([k, v]) => [String(k), v])) }
      : {}),
    pageText: lines.join('\n'),
  };

  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const withZh = paragraphs.filter((item) => item.zh).length;
  log(`${examId}: paragraphs=${paragraphs.length} translated=${withZh} -> ${outPath}`);
  return { examId, paragraphs: paragraphs.length, translated: withZh };
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const summary = [];

  for (const year of REQUESTED_YEARS) {
    const slug = slugFor(year);
    const paperUrl = `${BASE}/kaoyan/paper/${slug}/`;
    log(`--- ${year} (${slug}) ---`);
    let paperHtml;
    try {
      paperHtml = await fetchText(paperUrl);
    } catch (error) {
      log(`${year}: paper page failed: ${error.message}`);
      summary.push({ year, error: error.message });
      await sleep(DELAY);
      continue;
    }

    const links = discoverSectionLinks(paperHtml, slug);
    const targets = links
      .map((link) => ({ link, ...partIndexFromLink(link) }))
      .filter((item) => item.bank)
      .filter((item) => (BANK_FILTER ? item.bank === BANK_FILTER : true))
      .sort((a, b) => (a.bank === b.bank ? a.partIndex - b.partIndex : a.bank === 'cloze' ? -1 : 1));

    if (targets.length === 0) {
      log(`${year}: no cloze/reading links discovered`);
      summary.push({ year, error: 'no links' });
      await sleep(DELAY);
      continue;
    }

    for (const target of targets) {
      try {
        summary.push({ year, ...(await fetchUnit(year, target.link, target.bank, target.partIndex)) });
      } catch (error) {
        log(`${year} ${target.bank}-${target.partIndex}: ${error.message}`);
        summary.push({ year, error: `${target.link}: ${error.message}` });
      }
      await sleep(DELAY);
    }
  }

  const ok = summary.filter((s) => !s.error).length;
  log(`SUMMARY units=${ok}/${summary.length} -> ${OUT_DIR}`);
  for (const item of summary.filter((s) => s.error)) log(`  FAIL ${item.year}: ${item.error}`);
}

await main();
