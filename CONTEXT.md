# CONTEXT.md

This document defines the core domain concepts, entities, and ubiquitous language for the **Translation-Training** platform. It contains no implementation details or technical framework specifics.

---

## Ubiquitous Language (Domain Glossary)

### 1. Examination & Content (考卷与题库)

- **Exam (考研真题套卷)**: A single year's master's entrance examination paper for English I (2002–2026), focused on the translation section. Each exam contains an overarching passage and a set of designated translation targets.
- **Passage (短文全文)**: The complete source article in English that provides linguistic context, theme, and surrounding discourse for the highlighted translation sentences.
- **Translation Segment (目标划线句)**: A designated sentence or clause within the passage identified with a question marker (such as `(61)` or `(1)`), worth a maximum of 2.0 points. Each exam contains exactly 5 translation segments (totaling 10.0 points).
- **Reference Translation (标准参考译文)**: A published, fluent Chinese translation of the target segment used for comparative review and study. It is the same sentence used as the Chinese→English prompt.
- **Translation Direction (翻译方向)**: `en-zh` (English source → Chinese answer, the original mode) or `zh-en` (Chinese source → English answer). Direction is a session/room setting; the solo and PVP rules are otherwise identical.
- **Reverse Prompt Bank (反向题干)**: For Chinese→English, the Chinese prompt is the researched reference translation of an existing English target; the existing English target is the standard answer. No new English questions are added.
- **Reference Segment Source (译文来源标记)**: `web` (published answer as-is), `web-completed` (published answer minimally completed/corrected against the existing English), or `reviewed-fallback` (no public answer exists for this exact non-underlined sentence; hand-checked translation).

### 2. Practice & Modes (练习与对战模式)

- **Solo Session (单人练习模式)**: A self-paced training session where a single student works through the 5 translation segments of a chosen exam. Upon submitting each segment, the student immediately advances to the next segment while AI scoring proceeds asynchronously in the background.
- **PVP Match (双人实时对战模式)**: A synchronized competition between two players on the same exam. Both players race against the clock and against each other to translate the 5 segments accurately.
- **PVP Room (对战房间)**: An ephemeral arena identified by a unique 6-character room code (e.g. `K9X2P4`) where a Host and an Opponent gather, configure match duration, signal readiness, and compete.
- **Single Active Room Binding (单房活跃绑定)**: A player belongs to exactly one active room at a time. Entering a new room releases the seat in every abandoned room; a player already inside a running match cannot enter a second one. Room membership is never guessed from identity alone, so a stale room can never speak for a live match.
- **Spectator (观战者)**: A non-competing observer seated outside the player slots. Spectators never appear in the player list, never signal readiness, and never influence the match clock, grading, or settlement.
- **Link Spectator (免登录观战者)**: A spectator who arrives through a shareable spectate link and holds no account. Their seat is strictly read-only: they may watch, and may not create rooms, take player seats, signal readiness, or submit translations.
- **Match Clock (对战计时器)**: A shared countdown timer (default 15 minutes) for the PVP match. The match concludes when both players finish all segments or when the clock reaches zero.
- **Player Progress (选手进度)**: The real-time status of a player within a match or session, including current segment index (0–4), submission timestamps, individual segment grading statuses, and cumulative score.

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
