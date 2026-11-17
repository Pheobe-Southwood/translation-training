# Bilingual reference sources

## What is stored

`src/shared/data/exams.json` keeps the existing English bank untouched and adds:

- `referencePassageMarkdown` — network-published Chinese full passage;
- `referenceTranslations` — five network-published Chinese reference translations;
- `referenceSource` — source name, URL and access date;
- `referenceSegmentSources` — `web`, `web-completed` or `reviewed-fallback`;
- `referenceNotes` — every completion/fallback and the reason.

The English fields remain the standard answer for Chinese→English. The Chinese
fields are the prompt.

The separate `cloze` / `reading` long-sentence banks are stored in
`src/shared/data/passage-bank.json`; their source, extraction method and
segment-level reference provenance are documented under *Passage banks* below.

## Primary source

**懒笔记·考研英语英译汉真题在线对照** (1998–2026, full passage + per-sentence
`【译文】`). Accessed 2026-10-22.

- Index: https://english-exam.lazynote.cn/kaoyan/sections/translation-underlined/
- 2010–2026: `/kaoyan/sections/{year}-english-one/section2-part-c/`
- 2005–2009: `/kaoyan/sections/{year}/section2-part-c/`
- 2002–2004: `/kaoyan/sections/{year}/section2-part-b/`

The data was extracted once with `scripts/research-reference-bank.mjs`; the
committed JSON is the source of truth and CI never fetches these pages.

## Cross-checks

These were used to verify wording and to detect source/page mismatches:

- 2024 启航考研翻译答案: https://jixun.iqihang.com/info/yyzd/2023335827.html
- 2011 新东方在线翻译真题: https://m.koolearn.com/kaoyan/20140711/823483.html
- 2022 新东方翻译解析: https://mtoutiao.xdf.cn/kaoyan/202607/15308421.html
- 2023 新东方翻译解析: https://mtoutiao.xdf.cn/kaoyan/202607/15308429.html

Cross-check rules:

1. Compare the English target first. Do not use a Chinese answer from a page whose
   English sentence does not match the existing bank.
2. A page that mixes years or reorders questions is discarded for that question.
   For example, one “2025 answer” page was found to contain 2022 text, and a 2023
   page's Q46 did not match the existing 2023 bank. Neither was used blindly.
3. If the published per-sentence answer is truncated, use the same page's full
   passage translation to complete the missing clause and mark it `web-completed`.

## Known gaps and fallbacks

The existing English bank contains two non-underlined sentences from the same
articles, for which the public per-sentence answers do not exist:

| Exam | Existing English | Handling |
| --- | --- | --- |
| 2011 Q47 | “We may all, from time to time, entertain the feeling…” | `reviewed-fallback`; hand-checked Chinese translation |
| 2022 Q50 | “Furthermore, Scovell’s story involved much more than just intelligence work…” | `reviewed-fallback`; hand-checked Chinese translation |

The fallback translations are recorded in `referenceNotes` and in the research
script's `OVERRIDES`. The existing English text was not changed.

## Quality corrections

The first extraction reproduced the published answers. A bilingual audit then
found statements that added parenthetical context, omitted a listed item, or
mistranslated a key term. Those were corrected minimally and marked
`web-completed`:

- 2002: removed added “（行为）” / “系统地”; corrected “possessions” from “特质”.
- 2005: removed added “（怀疑与乐观交织的）”; restored “our” in “Unity in our diversity”.
- 2006: fixed the direction of “define him as an individual”.
- 2007: removed “（加拿大的）”; corrected “notions of significance”.
- 2008: removed parenthetical additions.
- 2009: fixed “the powers” and “are led to distinguish”.
- 2010: corrected “overworded evidence”.
- 2011: removed “加以审视”; restored “begin”.
- 2012: corrected “generative equation”, “Here”, “more constrained beginnings”,
  “universality”, and the final Chomsky/Greenberg sentence.
- 2015: “This movement” is “这场运动”, not “移民浪潮”.
- 2016: fixed the “it is perfectly ordinary that…” construction.
- 2017: “providers” is “提供者”; fixed “possibilities of the operating environment”.
- 2018: “大学毕业生” and “迅速”, not “大学才子/纷纷”.
- 2019: “institutions” is “科研机构”, not “制度”.
- 2020: removed added “哥白尼等人”; restored “trying to” and the Kant “after” relation.
- 2021: removed “（西方）”“高校” additions; corrected “norms of academic life” and
  the pronoun in the final sentence.
- 2022: fixed “此人其人本身”.
- 2023: restored “music choices（音乐选择）” in Q46.
- 2025: removed parenthetical additions such as “（正式）”“（科研）”.
- 2026: removed “（1945 年的）” and “在这方面”.

These are the only intentional edits; the rest of the Chinese text is the
published reference answer. `referenceSegmentSources` makes the distinction
auditable, and `scripts/validate-bilingual-bank.ts` rejects malformed records or
undocumented fallbacks.

## Passage banks (完型 / 阅读长难句, cloze / reading)

On 2026-11-17 the site added two long-sentence banks next to the 2002–2026
translation bank:

- `cloze` — one 完型填空 article per year, from which 3–5 long sentences are
  selected as targets;
- `reading` — 阅读理解 Text 1–4 per year (four articles), 3–5 long sentences each.

Together they cover **2004–2025**: 22 years × (1 cloze + 4 reading texts) =
**110 practice units**. One article is one paper. The passage banks are
**English→Chinese only**: they intentionally store no `referencePassageMarkdown`,
so the Chinese→English projection is unavailable and no reversed prompts are
created from them.

### Source

**懒笔记·考研英语真题与解析** (https://english-exam.lazynote.cn) — the
「完形填空（四选一）」 and 「阅读理解（四选一）」 question-type pages. Each page
publishes the English passage with a **per-paragraph Chinese translation** and
per-question analysis. Accessed **2026-11-17**.

URL patterns (all under `/kaoyan/sections/`):

- Cloze: `{year}-english-one/section1/` for 2010–2025, `{year}/section1/` for
  2004–2009;
- Reading Text 1: `{year}-english-one/section2-part-a/` for 2010–2025,
  `{year}/section2-part-a/` for 2004–2009;
- Reading Text 2–4: the same prefix with `section2-part-a-{n}/`, where `n = 2..4`.

### Pipeline and stored fields

The fetched pages are a local working artifact, never committed (`data/` is
git-ignored). The committed bank is the source of truth.

1. `scripts/fetch-passage-source.mjs` fetches each section page once and writes
   `data/source/web/<examId>.json`:

   ```jsonc
   {
     "examId": "2004-reading-1",
     "year": 2004,
     "bank": "reading",            // or "cloze"
     "partIndex": 1,
     "url": "https://english-exam.lazynote.cn/kaoyan/sections/2004/section2-part-a-1/",
     "fetchedAt": "2026-11-17",
     "title": "…",
     "paragraphs": [{ "index": 1, "en": "…", "zh": "…" }],
     // cloze only:
     "clozeAnswers": { "1": { "letter": "C", "word": "centering" } },
     "pageText": "…"               // stripped page text, curator reference only
   }
   ```

   For cloze units the fetched paragraph object also keeps `enOriginal` (the
   passage as rendered, blank numbers still open) before the blanks are filled.
2. Curators turn each unit into `data/curated/<examId>.json` (also git-ignored),
   selecting the target sentences and pairing them with their Chinese references.
3. `scripts/build-passage-bank.mjs` merges the curated units into
   `src/shared/data/passage-bank.json`; `--check` validates without writing.
4. `scripts/validate-passage-bank.ts` (`pnpm validate:passage-bank`) is the
   strict gate: 110 units / unique examIds / full 2004–2025 matrix, 3–5 segments
   per unit, every target a verbatim substring of `contentMarkdown`, Chinese
   references with a Han-character ratio ≥ 0.25, complete source fields, and
   answer-field leakage checks on the public projection.

Each committed record uses the following fields (`referenceNotes` is present only
when a segment was adjusted):

```jsonc
{
  "examId": "2004-reading-2",
  "year": 2004,
  "bank": "reading",
  "partLabel": "阅读理解 Text 2",
  "title": "…",
  "contentMarkdown": "…",          // full English article
  "translationSegments": ["…"],    // 3–5 target long sentences (English)
  "referenceTranslations": ["…"],  // segment-level Chinese references
  "referenceSource": { "name": "…", "url": "…", "accessedAt": "2026-11-17" },
  "referenceSegmentSources": ["web", "web-completed", "…"],
  "referenceNotes": ["…"]          // only where a segment was adjusted
}
```

A paper's maximum score is `translationSegments.length × 2`, so a 3-sentence unit
is worth 6 points and a 5-sentence unit 10.

### Segment-level references (`web` / `web-completed`)

The published translation is **paragraph-level**. For each target sentence the
curator locates the corresponding clause or sentence inside that paragraph's
translation and uses it as the segment reference — the bank does not invent new
translations.

- `web` — the paragraph translation contains the target sentence directly.
- `web-completed` — minimal splitting or connective adjustment was needed when
  cutting the sentence out of the paragraph translation (for example when the
  published paragraph joins two sentences or uses a dash/colon instead of a full
  stop). The reason is recorded in `referenceNotes`.
- `reviewed-fallback` — the shared field definition inherited from the
  translation bank for hand-checked translations where no public translation
  exists for that exact sentence.

`referenceSegmentSources` keeps the distinction auditable per sentence.

### Cloze blanks

The cloze article on the source page shows blanks as bare numbers. The fetch
script fills each blank with the correct option published on the same page, so
`contentMarkdown` is a complete, readable article and the target sentences are
verbatim substrings. The blank-numbered original stays available as
`enOriginal`, and the mapping used for the fill is stored in `clozeAnswers`, so
the reconstruction can be traced back to the source.

### Scanned-book source not used

The original plan (user-specified) was to use the Baidu Netdisk set
《逐词逐句精讲册英语一（2004-2025）》 (22 volumes) for the passage-bank references.
That plan was abandoned on **2026-11-17** after verification:

- every volume is a pure scanned image PDF with **no text layer**; Baidu's
  server-side parse (`bdpan get-content`) returns no body text either;
- local OCR via `scripts/extract-pdf-source.mjs` (pdftoppm + tesseract
  `chi_sim+eng`) mangles the two-column layout: Chinese annotation columns are
  interleaved into the English, and lines contain garbled characters.

The books are therefore **not a source of this bank**; they are only kept aside
as later manual cross-check material. The public bilingual pages above provide
both the English original and an authoritative paragraph-level translation, which
is exactly what a training bank needs.

### Known limitations

- The English text is copied from rendered HTML; punctuation/spacing may differ
  from the printed paper (whitespace and HTML entities are normalised, wording is
  not rewritten).
- Target sentences are curator-selected long sentences, not official underlined
  questions — there is no official per-sentence answer key for them.
- Because segment references are cut out of paragraph translations, they can
  differ slightly from the published paragraph translation in sentence boundaries
  or connectives; every such adjustment is marked `web-completed` and documented
  in `referenceNotes`.
- The cloze article is reconstructed with the page's published answers; if a page
  publishes a different key later, the snapshot is not re-fetched automatically.
- Only the English passage and the Chinese translation are used for training. The
  source page's per-question analysis, vocabulary notes and other original
  editorial content are not copied into the bank.
- These two banks have no Chinese→English mode, by design.

## Copyright / attribution

The Chinese reference translations are publicly circulated exam-study answers;
the source URL and access date are stored with every exam. The app uses them for
non-commercial study/training and links back to the source in this document. The
English exam text remains the authoritative answer and is not replaced.

The passage-bank records follow the same rule: every unit stores its source name,
URL and access date, and every segment records whether its Chinese reference was
taken directly from the source (`web`) or minimally adjusted (`web-completed`).
The upstream pages' per-question analysis and other editorial content are not
redistributed; only the English passage and the Chinese translation needed for
personal study are used. See also `public/legal/copyright.html`.
