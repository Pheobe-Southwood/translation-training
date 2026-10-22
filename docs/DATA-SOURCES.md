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

## Copyright / attribution

The Chinese reference translations are publicly circulated exam-study answers;
the source URL and access date are stored with every exam. The app uses them for
non-commercial study/training and links back to the source in this document. The
English exam text remains the authoritative answer and is not replaced.
