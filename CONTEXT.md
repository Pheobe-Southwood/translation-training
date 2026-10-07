# CONTEXT.md

This document defines the core domain concepts, entities, and ubiquitous language for the **Translation-Training** platform. It contains no implementation details or technical framework specifics.

---

## Ubiquitous Language (Domain Glossary)

### 1. Examination & Content (考卷与题库)

- **Exam (考研真题套卷)**: A single year's master's entrance examination paper for English I (2002–2026), focused on the translation section. Each exam contains an overarching passage and a set of designated translation targets.
- **Passage (短文全文)**: The complete source article in English that provides linguistic context, theme, and surrounding discourse for the highlighted translation sentences.
- **Translation Segment (目标划线句)**: A designated sentence or clause within the passage identified with a question marker (such as `(61)` or `(1)`), worth a maximum of 2.0 points. Each exam contains exactly 5 translation segments (totaling 10.0 points).
- **Reference Translation (标准参考译文)**: An authoritative, fluent Chinese translation of the target segment used for comparative review and study.
- **Exam Pool (可选真题池)**: The set of exams a series may draw from, determined by the host's draw strategy: every year (2002–2026), a host-specified year range, or an explicit hand-picked, hand-ordered list. The pool size is the hard upper bound on the number of rounds.

### 2. Practice & Modes (练习与对战模式)

- **Solo Session (单人练习模式)**: A self-paced training session where a single student works through the 5 translation segments of a chosen exam. Upon submitting each segment, the student immediately advances to the next segment while AI scoring proceeds asynchronously in the background.
- **PVP Series (多轮对战系列赛)**: A competitive series between 2, 3 or 4 players spanning **N rounds**. Each round is a different exam drawn from the pool without repetition, and each player races their own countdown per round.
- **PVP Room (对战房间)**: An ephemeral arena identified by a unique 6-character room code (e.g. `K9X2P4`) where a Host and their opponents gather, configure the series, signal readiness, and compete.
- **Room Configuration (房间设置)**: The host-defined series parameters — round count N, per-round duration (10/15/20 minutes), player capacity (2/3/4), spectator access, and the draw strategy.
- **Draw Strategy (真题抽取策略)**: How the N exams are selected. Recorded in the room and revealed **one round at a time**, so no player can prepare for a future round.
  - **Full Random (全随机)**: Draw N distinct years from all 25.
  - **Year Range (年份区间)**: Draw N distinct years from an inclusive host-specified range.
  - **Custom Pick (手动指定)**: The host explicitly chooses the years *and their order*; the selection size caps N.
- **Round (轮次)**: One exam's worth of competition inside a series. A round is identified by its zero-based index and its exam year, and it ends for a player once all 5 segments are submitted or that player's round countdown expires.
- **Round Progression (流水推进)**: Players advance independently. Finishing round *k* moves **that player alone** straight into round *k+1* with a freshly reset countdown; nobody waits for the slowest player.
- **Free Segment Order (轮内自由跳题)**: Inside a single round the 5 segments may be answered in any order, and answered segments remain visible for review.
- **Per-Player Round Countdown (个人单轮倒计时)**: Each player's own countdown for the round they are currently on, initialised to the configured per-round duration the moment they enter that round. The server holds an absolute deadline; disconnecting does **not** pause it.
- **Round Settlement (轮次结算)**: The moment every player has finished the same round and all of its grading has resolved. Only then are that round's match points and small scores finalised. A round may therefore read as "待结算" for a fast player while the rest of the field catches up.
- **Withdrawal (中途退赛)**: A player quitting mid-series. Their remaining rounds are immediately filled with zero-score timeout submissions; those zeros still count in everyone else's baseline, and the leaver still receives an archived loss.
- **Overtime Decider (加赛决胜局)**: An extra round appended after the scheduled N when the series is dead level. Only the tied leaders play it; everybody else spectates.
- **Spectator (实时观战位)**: A non-competing participant who may switch freely between rounds, watching each player's independent progress, live match points and accumulated small scores. A player who has finished all N rounds is shown the spectator board while waiting.

### 3. Evaluation & Grading (采分与阅卷)

- **Grading Rubric (阅卷细则)**: The strict, official scoring standard applied to each translation segment:
  - **Single Sentence Score (单句得分)**: `Points Earned (0–2.0) - Distortion Deduction - Fluency Deduction`.
  - **Key Scoring Points (采分点)**: 3 to 4 grammatical structures, idiomatic phrases, or sense groups in the sentence, each worth 0.5 points.
  - **Distortion Deduction (意思扭曲扣分)**: A severe penalty applied when the core meaning of the original sentence is inverted, negated, or fatally misconstrued. If core meaning is distorted, the maximum possible sentence score is capped at 0.5 points.
  - **Fluency Deduction (通顺度扣分)**: A penalty of 0 to 0.5 points for rigid translationese, awkward phrasing, or non-idiomatic Chinese expressions.
  - **Grade Critique (阅卷点评)**: Specific analytical feedback explaining which scoring points were hit, points missed, and reasons for any deductions.
- **Batched Paired Evaluation (同轮同题并列评阅)**: In a live series, every player's submission for the **same (round, segment)** is forwarded in a single prompt to DeepSeek and graded together under one uniform standard. This is what makes cross-player score comparison — and therefore match points — meaningful. Because the verdict necessarily quotes the other side's translation, a player only sees the comparative analysis after their own series is over.
- **Grading Failure Policy (评分失败兜底)**: A batch is retried with backoff; if it still fails, that segment is scored 0 for **every** player in the batch and the round settles normally, so no player is penalised asymmetrically.
- **Answer Confidentiality (答案保密)**: While a player is still competing, the server strips every opponent's answer text, critique and comparative analysis from the payloads it sends them. Answers become visible once that player has finished all of their rounds.

### 4. Scoring (积分与排名)

Big scores are called **Match Points (大比分)**; per-round raw scores are **Small Scores (小分)**.

- **Round Small Score (单轮小分)**: The sum of a player's 5 segment scores in one round (0–10.0).
- **Accumulated Small Score (累计小分)**: The sum of a player's round small scores across the whole series. Breaks ties on match points.
- **Baseline (基准)**: For each player, the **mean of the other players'** small scores in that round. The compared player is excluded.
- **Score Advantage (ΔS = 小分优势)**: `own round small score − baseline`.
- **Score Points (小分部分)**: `0` when ΔS ≤ 0, otherwise ΔS truncated to the 0.5 grid — i.e. +0.5 for every full 0.5 the player sits above the rest of the field.
- **Time Bonus (时间加成)**: Only available to players who are ahead on score (ΔS > 0). Measured against the mean of the other players' remaining round time: a lead of 60–180 seconds adds **+0.5**, more than 180 seconds adds **+1.0**.
- **Final Round Double (末轮双倍)**: Every match point earned in the last scheduled round is doubled. Disabled when the series is a single round.
- **Round Match Points (单轮大比分增量)**: `(score points + time bonus) × final-round multiplier`.
- **Final Ranking (终局排名)**: Match points first, then accumulated small score.
- **Overtime Scoring (加赛计分)**: The decider uses no bands and no doubling — a single flat **+1.0** to its winner, decided by overtime small score, then by overtime elapsed time, then by whole-series elapsed time.
- **Overtime Vote (加赛投票)**: When match points *and* accumulated small scores are both level at the top, the tied leaders are asked to agree to a decider. Unanimous consent starts it; any refusal, or a 30-second expiry, ends the series as a draw.

### 5. Interface & Ergonomics (界面与排版)

- **Compact Arena HUD (紧凑对战条)**: A high-density, multi-row scoreboard optimised for narrow mobile viewports. It renders **one clock per player** (each driven by that player's own round deadline) alongside their `R{round}-Q{question}` position, live match points and accumulated small score.
- **Round Switcher (轮次切换标签)**: Tabs letting a spectator or a finished player jump between every round that has started, to compare submissions, scoring points and AI critiques round by round.
- **Round Board (全景答题矩阵)**: The round × question × player grid used by spectators.
- **Non-Blocking Round Report (轮次战报 Toast)**: Round results are announced with a lightweight toast that never interrupts typing; there is no blocking modal between rounds.
- **Top-Prioritized Workspace (答题区置顶与抽屉折叠)**: On mobile viewports, the active target sentence, translation textarea, and submission button are prioritized at the top of the viewport, while the background passage is collapsed into a clean toggleable drawer to ensure sentence and input are always visible together.

### 6. Identity & Access (准入与凭据)

- **Access Pass (站点访问密码)**: A gatekeeper credential required to enter the platform and initiate AI grading sessions, protecting shared API resources.
- **Player Profile (选手标识)**: A lightweight nickname chosen by the user for PVP representation and local session history tracking.
- **Socket Identity Binding (连接身份绑定)**: A realtime connection's claimed player id must match the authenticated user behind its token, so nobody can occupy another participant's seat or eavesdrop through a forged spectator identity.

### 7. Records & Persistence (档案与持久化)

- **Series Record (系列赛档案)**: A historical log of one completed series recording the total round count, each round's exam year, each round's match points and small score, every segment's translation and AI evaluation, the final outcome, and whether the series went to overtime.
- **Solo Record (练习档案)**: A historical log of a completed solo session.
- **Long-Match Snapshot (长局快照)**: A serialised copy of an in-flight room, written after each round settles **only** for series whose total scheduled time exceeds 90 minutes, so a server restart can restore the match instead of losing it.
