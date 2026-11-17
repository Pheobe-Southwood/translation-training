# CONTEXT.md

This document defines the core domain concepts, entities, and ubiquitous language for the **Translation-Training** platform. It contains no implementation details or technical framework specifics.

---

## Ubiquitous Language (Domain Glossary)

### 1. Examination & Content (考卷与题库)

- **Exam Bank (题库)**: The platform offers three question banks that coexist on the homepage: `translation` (the 2002–2026 翻译真题 translation-section papers), `cloze` (2004–2025 完型填空长难句) and `reading` (2004–2025 阅读理解长难句). The two passage banks are English→Chinese only; the translation bank additionally supports Chinese→English.
- **Practice Unit / Exam (练习单元 / 一套卷)**: One article is one paper. A paper is identified by `examId` — `${year}-translation`, `${year}-cloze` or `${year}-reading-<n>` (e.g. `2024-translation`, `2004-cloze`, `2004-reading-2`). A year alone is no longer unique: 2004 now holds six papers. The passage banks cover 22 years × (1 cloze + 4 reading texts) = 110 practice units.
- **Passage (短文全文)**: The complete source article in English that provides linguistic context, theme, and surrounding discourse for the highlighted translation sentences.
- **Translation Segment (目标句)**: A designated sentence within the passage, worth a maximum of 2.0 points. A translation paper has exactly 5 target sentences (10.0 points in total); a passage-bank unit has 3–5 target long sentences (6.0–10.0 points in total).
- **Variable Target Count (变长目标句)**: The number of target sentences is a property of the paper rather than a fixed platform constant: 5 for the translation bank and 3–5 for the passage banks. Every count shown to a user — progress, score maximum, match settlement — follows the paper.
- **Reference Translation (参考译文)**: The Chinese reference for a target sentence, used for review and scoring. In the translation bank it also serves as the Chinese prompt for Chinese→English; passage-bank references are never used as prompts.
- **Paragraph Translation (逐段译文)**: The published Chinese translation of a passage, paragraph by paragraph. It is the source of the passage banks' segment-level references.
- **Segment Reference Translation (单句参考译文)**: The clause or sentence located inside a paragraph translation for one target sentence. A direct match is marked `web`; a minimal splitting or connective adjustment is marked `web-completed` and explained in the paper's reference notes.
- **Translation Direction (翻译方向)**: `en-zh` (English source → Chinese answer, the original mode) or `zh-en` (Chinese source → English answer). Only the translation bank offers `zh-en`; the cloze and reading banks always run `en-zh`. Direction is a session/room setting; the solo and PVP rules are otherwise identical.
- **Reverse Prompt Bank (反向题干)**: For Chinese→English, the Chinese prompt is the researched reference translation of an existing English target; the existing English target is the standard answer. No new English questions are added, and the passage banks contribute no reversed prompts.
- **Reference Segment Source (译文来源标记)**: `web` (a published translation used as-is; for the passage banks, the paragraph translation that contains the target sentence directly), `web-completed` (a published translation minimally completed or corrected against the existing English, or minimally split/joined when a target sentence is cut out of a paragraph translation; recorded in `referenceNotes`), or `reviewed-fallback` (no public translation exists for that exact sentence; hand-checked translation).

### 2. Practice & Modes (练习与对战模式)

- **Solo Session (单人练习模式)**: A self-paced training session where a single student works through all target sentences of the chosen paper (5 for a translation paper, 3–5 for a passage unit). Upon submitting each segment, the student immediately advances to the next segment while AI scoring proceeds asynchronously in the background.
- **PVP Match (双人实时对战模式)**: A synchronized competition between two players on the same paper. Both players race against the clock and against each other to translate all target sentences of that paper.
- **PVP Room (对战房间)**: An ephemeral arena identified by a unique 6-character room code (e.g. `K9X2P4`) where a Host and an Opponent gather, configure match duration, signal readiness, and compete.
- **Single Active Room Binding (单房活跃绑定)**: A player belongs to exactly one active room at a time. Entering a new room releases the seat in every abandoned room; a player already inside a running match cannot enter a second one. Room membership is never guessed from identity alone, so a stale room can never speak for a live match.
- **Spectator (观战者)**: A non-competing observer seated outside the player slots. Spectators never appear in the player list, never signal readiness, and never influence the match clock, grading, or settlement.
- **Link Spectator (免登录观战者)**: A spectator who arrives through a shareable spectate link and holds no account. Their seat is strictly read-only: they may watch, and may not create rooms, take player seats, signal readiness, or submit translations.
- **Match Clock (对战计时器)**: A shared countdown timer (default 15 minutes) for the PVP match. The match concludes when both players finish all segments or when the clock reaches zero.
- **Player Progress (选手进度)**: The real-time status of a player within a match or session, including current segment index (0 to N−1, where N is the paper's target count), submission timestamps, individual segment grading statuses, and cumulative score.

### 3. Evaluation & Grading (采分与阅卷)

- **Grading Rubric (阅卷细则)**: The strict, official scoring standard applied to each translation segment:
  - **Single Sentence Score (单句得分)**: For English→Chinese, `Points Earned (0–2.0) - Distortion Deduction - Fluency Deduction`. For Chinese→English, `4 × 0.5 information points - distortion/omission - English language quality`, capped at 0.5 for serious distortion.
  - **Key Scoring Points (采分点)**: 3 to 4 grammatical structures, idiomatic phrases, or sense groups in the sentence, each worth 0.5 points.
  - **Distortion Deduction (意思扭曲扣分)**: A severe penalty applied when the core meaning of the original sentence is inverted, negated, or fatally misconstrued. If core meaning is distorted, the maximum possible sentence score is capped at 0.5 points.
  - **Fluency Deduction (通顺度扣分)**: A penalty of 0 to 0.5 points for rigid translationese, awkward phrasing, or non-idiomatic Chinese expressions. In Chinese→English it is the English grammar/expression deduction.
  - **Grade Critique (阅卷点评)**: Specific analytical feedback explaining which scoring points were hit, points missed, and reasons for any deductions.
  - **Paired Segment Evaluation (并列意群裁决)**: In PVP matches, both players' submissions for the same target sentence are forwarded together in a single prompt to DeepSeek. Under identical context and uniform strictness, AI grades both translations simultaneously via tool calling, outputting individual rubrics along with a comparative analysis to eliminate variance.

### 4. Interface & Ergonomics (界面与排版)

- **Compact Arena HUD (紧凑对战条)**: A high-density, single-line scoreboard optimized for narrow mobile viewports, displaying scores, segment indicators, and the match countdown without vertical page hogging.
- **Top-Prioritized Workspace (答题区置顶与抽屉折叠)**: On mobile viewports, the active target sentence, translation textarea, and submission button are prioritized at the top of the viewport, while the background passage is collapsed into a clean toggleable drawer to ensure sentence and input are always visible together.

### 5. Identity & Access (准入与凭据)

- **Access Pass (站点访问密码)**: A gatekeeper credential required to enter the platform and initiate AI grading sessions, protecting shared API resources.
- **Spectate Ticket (观战凭证)**: A signed, expiring credential bound to one room code and embedded in a spectate link. It authorises watching a single room without an account, and grants nothing else.
- **Player Profile (选手标识)**: A lightweight nickname chosen by the user for PVP representation and local session history tracking.
- **Session Record (练习档案)**: A historical log of completed solo sessions or PVP matches, recording the date, exam year, translation direction, individual segment translations, scores, and critiques.
