#!/usr/bin/env node
/**
 * One-off research helper: collect the publicly circulated Chinese reference
 * translations for the existing 2002–2026 English (I) translation bank.
 *
 * The English bank in src/shared/data/exams.json is the source of truth and is
 * never modified. Only server-side reference fields are added:
 *   - referencePassageMarkdown
 *   - referenceTranslations
 *   - referenceSource
 *   - referenceSegmentSources
 *   - referenceNotes
 *
 * Usage:
 *   node scripts/research-reference-bank.mjs          # dry run / audit
 *   node scripts/research-reference-bank.mjs --write  # update exams.json
 *
 * Network access is only needed when running this script. CI validates the
 * committed data and never fetches these pages.
 */
import fs from 'fs';
import path from 'path';

const EXAMS_PATH = path.resolve('src/shared/data/exams.json');
const PRIMARY_SOURCE_NAME = '懒笔记·考研英语英译汉真题在线对照';
const ACCESSED_AT = '2026-10-22';

/**
 * Known gaps between the published per-sentence answer and the existing English
 * bank. Every override is a minimal, manually reviewed completion:
 *  - web-completed: the published full-passage translation contains the missing
 *    clause, and the override uses that published wording.
 *  - reviewed-fallback: the existing English sentence is a non-underlined
 *    sentence from the same article and has no public per-sentence answer; the
 *    translation below was written/checked by hand against the existing English.
 *
 * Keys are 0-based segment indexes.
 */
/**
 * Minimal faithfulness corrections found by the bilingual audit. These are not
 * wholesale rewrites: each replaces a known parenthesis/addition, a missing
 * detail, or a clear mistranslation so the Chinese prompt matches the existing
 * English answer exactly enough to grade against it.
 *
 * Keys are 0-based segment indexes.
 */
const QUALITY_PATCHES = {
  2002: {
    1: { text: '行为科学之所以变化缓慢，一方面是因为那些用来解释的因素似乎常常可以直接观察到，另一方面是因为其他种类的解释一直难以找到。', note: '2002 Q2：删去网络译文括号内“（行为）”的增补。' },
    2: { text: '自然选择在进化中的作用，仅在一百多年前才被提出；而环境在塑造和维持个体行为方面所起的选择作用，则刚刚开始为人们所认识和研究。', note: '2002 Q3：删去“系统地”这一英文未明示的增补。' },
    3: { text: '自由和尊严是传统理论中的自主（自治）之人所拥有的东西，而且对于这样一种做法不可或缺——在这种做法中，一个人要为自己的行为承担责任，并因自己的成就而获得赞誉。', note: '2002 Q4：将 possessions 由“特质”改为“所拥有的东西”，避免语义窄化。' },
  },
  2003: {
    2: { text: '对第一手收集的数据的重视，再加上将跨文化视角运用于对古今文化的分析，这两点使这项研究成为一门独特而尤为重要的社会科学。', note: '2003 Q48：删去“人类学”这一英文未明示的学科限定。' },
    4: { text: '因此，人类学中“文化”这一概念，就像数学中“集合”这一概念一样，是一个抽象概念，它使大量具体的研究与理解成为可能。', note: '2003 Q50：删去英文非限定关系从句中没有的转折词“但”。' },
  },
  2005: {
    0: { text: '电视是产生并传递这些感受的手段之一——而且，或许在此之前，它从未像在近来这场欧洲变局中那样，如此有力地把不同的民族和国家连接到一起。', note: '2005 Q1：删去网络译文括号内“（怀疑与乐观交织的）”的增补。' },
    4: { text: '在应对如此规模的一项挑战时，可以毫不夸张地说：“团结则存，分裂则亡。”——如果让我选择一句口号，那将是“我们多样性中的统一”，即一种目标统一、但同时尊重各国种种特性的统一。', note: '2005 Q50：补入 “our”，译为“我们多样性中的统一”。' },
  },
  2006: {
    0: { text: '我将把他定义为这样一种人：他选择以苏格拉底的方式思考道德问题这一活动，作为自己人生中首要的责任与乐趣。', note: '2006 Q46：修正“把这样的人定义为知识分子”的定义方向，去掉英文未明示的“知识分子”。' },
  },
  2007: {
    0: { text: '传统上，这类高等院校一直把法律学习视为律师独享的专属领域，而非一个受过教育的人在知识储备上必备的组成部分。', note: '2007 Q46：删去“（加拿大的）”这一英文未明示的限定。' },
    4: { text: '尽管来自律师的评论和反应可能为报道增色，但对记者而言，更可取的是依靠自己对新闻重要性的理解，并做出自己的判断。', note: '2007 Q50：将 notions of significance 改为“对新闻重要性的理解”，避免与“做出判断”重复。' },
  },
  2008: {
    0: { text: '他认为，正是这种困难，或许反而给他带来了一种弥补性的好处，即迫使他对每一个句子都进行长时间而专注的思考，从而使他能够察觉自己在推理中和观察中所犯的错误。', note: '2008 Q46：删去“（表达上的）”这一英文未明示的增补。' },
    4: { text: '达尔文确信，丧失这些爱好不仅是一种幸福的丧失，而且可能对智力有害，更有可能对道德品格有害。', note: '2008 Q50：删去“（对诗歌、绘画、音乐的）”这一英文未明示的增补。' },
  },
  2009: {
    3: { text: '由于我们对年青人所做的主要工作，在于使他们能够分享共同的生活，因此我们不能不考虑：自己是否正在形成能够保障他们获得这种能力的各种力量。', note: '2009 Q49：修正“一种……各种力量”的矛盾表达，并保留“形成各种力量”的原意。' },
    4: { text: '于是，在我们迄今为止一直在讨论的这一广义教育过程之中，我们被引导着区分出一种更为正式的教育——即直接讲授或学校教育。', note: '2009 Q50：将“就有必要区分出”改为“被引导着区分出”，去掉原文没有的必要性含义。' },
  },
  2010: {
    2: { text: '曾经有一段时间，生物学家对这样的证据有些言过其实：这些动物通过捕杀体弱的个体来维持猎物种群的健康，或者它们只捕食那些“无价值的”物种。', note: '2010 Q48：将 overworded evidence 改为“对这样的证据有些言过其实”，去掉“他们认为”的增译。' },
  },
  2011: {
    0: { text: '艾伦的贡献在于：他拿过我们所有人都共有的一个假设——即因为我们不是机器人，所以我们能够掌控自己的思想——并揭示了这一假设的错误本质。', note: '2011 Q46：删去“加以审视”这一英文未明示的增补。' },
    3: { text: '境遇似乎是有意安排来激发我们身上最好的一面的；而如果我们感到自己「受了委屈」，那么我们就不大会开始有意识地努力去摆脱自身当前的处境。', note: '2011 Q49：补入 begin 的“开始”义。' },
  },
  2012: {
    0: { text: '在物理学中，有一种研究路径把这种追求统一的冲动推向了极致，试图寻求一种万物理论——一个能生成我们所见到的一切的单一方程式。', note: '2012 Q46：补出 generative（生成）义，删去“（科学）”增补，将“解释”改为“生成”。' },
    1: { text: '在这里，达尔文主义似乎为此提供了依据；因为如果所有人类都有共同的起源，那么似乎有理由认为，文化的多样性也可以追溯到更为有限的开端。', note: '2012 Q47：将 Here 译为“在这里”，删去“在社会科学领域”；将 more constrained beginnings 改为“更为有限的开端”。' },
    2: { text: '把独有的部分从共有的部分里筛选出来，或许能让我们理解：复杂的文化行为是如何产生的，以及从进化或认知的角度来看，是什么在引导着它。', note: '2012 Q48：删去“（文化现象中）”增补。' },
    3: { text: '由 Joshua Greenberg 提出的第二种尝试，采取了一种更注重经验观察的方法来研究普遍性：它识别出（尤其在词序上）许多语言所共有的一些特征，而这些特征被认为代表了源自人类认知限制的偏差。', note: '2012 Q49：将“语言的普遍性”改为“普遍性”，将“（普遍）倾向”改为“偏差”。' },
    4: { text: '按照理论预期，乔姆斯基的语法应当显示出独立于谱系树或谱系树所追踪路径的语言变化模式；而格林伯格的普遍性理论则预测，特定类型的词序关系之间存在强烈的相互依赖。', note: '2012 Q50：清理括号增补，恢复“语法”“语言变化”“普遍性理论”的对应关系。' },
  },
  2017: {
    3: { text: 'David Graddol 所指出的这些变化，全都给英国那些向他国民众提供英语教学的提供者、以及更广泛的教育产业部门带来了明确而重大的挑战。', note: '2017 Q49：将 providers 译为“提供者”，避免窄化为“机构”或扩大为“从业者”。' },
    4: { text: '这项研究为所有致力于推广英语学习与使用的机构提供了一个依据，一个据以制定规划、从而应对可能截然不同的运营环境的各种可能性的依据。', note: '2017 Q50：删去“未来”“及其种种可能性”的增补，恢复 possibilities of the operating environment 的修饰关系。' },
  },
  2018: {
    2: { text: '但是，职业剧团在自己的常设剧场里日渐兴盛，怀有文学抱负的大学毕业生迅速转向这些剧场，因为剧场为他们提供了一种谋生的手段。', note: '2018 Q48：将“大学才子”“纷纷”改为“大学毕业生”“迅速”，更贴合原文。' },
  },
  2019: {
    4: { text: '如果我们真心想确保自己的科学既有意义又能被重复验证，我们就必须确保我们的科研机构鼓励的正是这种科学。', note: '2019 Q50：将 institutions 由“制度”改为“科研机构”。' },
  },
  2020: {
    1: { text: '在他们各自做出这些发现之前，当时许多思想家一直沿袭着更为古老的思维方式，其中就包括认为地球处于宇宙中心的地心说观点。', note: '2020 Q47：删去“哥白尼等人”这一英文未明示的人名增补。' },
    2: { text: '尽管教会试图压制这一代新兴的逻辑学家和理性主义者，但更多关于宇宙如何运行的解释仍被不断提出，其速度之快，人们再也无法忽视。', note: '2020 Q48：补出 more 的“更多”义，并将 at a rate 改为“其速度之快”。' },
    3: { text: '随着许多人承担起试图将推理与科学哲学融入世界的责任，文艺复兴宣告结束，一个新时代到来了——这就是理性时代。', note: '2020 Q49：补入 trying to 的“试图”义。' },
    4: { text: '在伊曼努尔·康德于《答复这个问题：“什么是启蒙？”》一文中使用这一短语之后，这些寻求知识、理解我们已经掌握的信息的行动，便被这一拉丁语短语 “sapere aude”（即 “dare to know”，意为“敢于求知”）所概括。', note: '2020 Q50：按英文 after 的时间关系重排句子，说明这些行动是在康德使用该短语之后被概括的。' },
  },
  2021: {
    0: { text: '在二战前的几十年里，这些社会的入学率一直大致稳定在适龄人口的 3%–5%，二战结束时仍维持着这一水平。', note: '2021 Q46：删去“（西方）”“高校”等英文未明示的增补，将 enrollment 译为“入学率”。' },
    3: { text: '而当这些新进教职员工绝大多数都是刚出研究生院的年轻男女时，他们就在很大程度上界定了该院系学术生活的规范。', note: '2021 Q49：将 norms of academic life 由“学风”改为“学术生活的规范”，将 define 改为“界定”。' },
    4: { text: '高增长率增加了学术革新的机会；这些高增长率也削弱了稳定或缓慢增长时期教师和学生被接纳进学者共同体的形式与流程。', note: '2021 Q50：删去“（旧有的）”“但”等增补，修正 they 的指代。' },
  },
  2022: {
    2: { text: '他无法仔细分析这位默默无闻的军官对那场民族间的大较量究竟做出过怎样的贡献、或是否做出过贡献，甚至也无法就他本人告诉我们多少情况。', note: '2022 Q48：修正“此人其人本身”的重复表达。' },
  },
  2023: {
    0: { text: '人工智能还可以用来识别客户在爱好、喜爱的名人、音乐选择和时尚潮流等方面的生活方式选择，从而为通过社交媒体发布的营销信息提供独特的内容。', note: '2023 Q46：补入 music choices（音乐选择），与现有英文列举一致。' },
  },
  2025: {
    0: { text: '近几十年来，科学已逐渐走入一种惯例：对科学领域的参与只能通过大学等机构来进行。', note: '2025 Q46：删去“（或：从事科学研究）”“（正式）”等英文未明示的增补。' },
    1: { text: '但是，通过利用普通公众与生俱来的好奇心，让非科学家直接参与到研究过程中，就有可能克服许多这样的难题。', note: '2025 Q47：删去“（科研）”增补。' },
    3: { text: '这些群体是一场正在迅速壮大的生物技术社会运动的一部分；参与其中的公民科学家和职业科学家力求把科学发现带出机构，将其交到任何有热情的人手中。', note: '2025 Q49：删去“（大学等正式）”增补。' },
    4: { text: '他们汇集资源、相互协作、跳出常规思维框框，并想方设法寻找解决方案、绕开各种障碍，去探索科学、为科学本身而探索——不再受制于在正规机构内做研究的传统束缚。', note: '2025 Q50：删去“必须”“做研究”等英文未明示的解释性增补。' },
  },
  2026: {
    1: { text: '回归科学素养的那个版本——它更注重教授科学是什么、如何运作，而不那么强调背诵科学事实——似乎正是当今社会迫切需要的东西。', note: '2026 Q47：删去“（1945 年的）”这一英文未明示的年份增补。' },
    4: { text: '美国之所以高度关注科学素养，最初源于二战期间科学技术所发挥的关键作用，以及人们所认为的美国士兵的不足。', note: '2026 Q50：删去“在这方面”这一英文未明示的范围限定。' },
  },
};

const OVERRIDES = {
  2005: {
    3: {
      text: '要打造这样一种“欧洲身份”——它既尊重各异的文化与传统，而这些文化与传统又正是把这块古老大陆联结在一起的纽带——绝非易事，还需要做出一项战略抉择，即在欧洲为欧洲制作节目。',
      source: 'web-completed',
      note: '2005 Q49：网络逐句译文省略了 “that of producing programs in Europe for Europe”，据同页全文译文补齐。',
    },
    4: {
      text: '在应对如此规模的一项挑战时，可以毫不夸张地说：“团结则存，分裂则亡。”——如果让我选择一句口号，那将是“多样性中的统一”，即一种目标统一、但同时尊重各国种种特性的统一。',
      source: 'web-completed',
      note: '2005 Q50：网络逐句译文省略了口号后半句，据同页全文译文补齐。',
    },
  },
  2011: {
    1: {
      text: '我们或许都会时不时地产生这样一种感觉：自己正被某种邪恶力量所控制，或者像一艘没有舵的船一样随波逐流，时而又凭自己的意志掌舵前行；而艾伦的研究凸显了意识思维所带来的那种掌控感。',
      source: 'reviewed-fallback',
      note: '2011 Q47：现有英文是同一文章的非划线句，网络无对应逐句译文；采用人工复核译文。',
    },
    4: {
      text: '积极的一面在于：当我们认识到一切都取决于自己时，其中所蕴含的种种可能性——以前我们是种种局限及其令人畏惧之处的专家，如今我们则成了一切可能之事的行家。',
      source: 'web-completed',
      note: '2011 Q50：网络逐句译文省略了 “and fearsomeness”，据现有英文补入“及其令人畏惧之处”。',
    },
  },
  2020: {
    4: {
      text: '这些寻求知识、理解我们已经掌握的信息的行动，被拉丁语短语 “sapere aude”（即 “dare to know”，意为“敢于求知”）所概括；伊曼努尔·康德曾在《答复这个问题：“什么是启蒙？”》一文中使用过这一短语。',
      source: 'web-completed',
      note: '2020 Q50：网络逐句译文在 Kant 处截断，据同页全文译文补齐。',
    },
  },
  2022: {
    4: {
      text: '此外，斯科维尔的故事远不止于情报工作。他在威灵顿勋爵总部中的地位，以及他因在那里工作而获得的认可，都反映在他逐步晋升的过程中。',
      source: 'reviewed-fallback',
      note: '2022 Q50：现有英文是同一文章的非划线句，网络无对应逐句译文；采用人工复核译文。',
    },
  },
};

function decodeEntities(input) {
  const map = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => map[m.toLowerCase()] ?? m);
}

function cleanHtml(input) {
  return decodeEntities(
    input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sourceUrl(year) {
  if (year >= 2010) {
    return `https://english-exam.lazynote.cn/kaoyan/sections/${year}-english-one/section2-part-c/`;
  }
  if (year >= 2005) {
    return `https://english-exam.lazynote.cn/kaoyan/sections/${year}/section2-part-c/`;
  }
  return `https://english-exam.lazynote.cn/kaoyan/sections/${year}/section2-part-b/`;
}

async function fetchHtml(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; translation-training-reference-audit/1.0)',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastError;
}

function extract(html) {
  const passageParagraphs = [...html.matchAll(/<p[^>]*class="[^"]*lt-zh[^"]*"[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => cleanHtml(m[1]))
    .filter(Boolean);
  const finals = [...html.matchAll(/<p[^>]*class="[^"]*tqp-final[^"]*"[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => cleanHtml(m[1]))
    .filter(Boolean);

  return {
    passage: passageParagraphs.join('\n\n'),
    translations: finals,
  };
}

function chineseRatio(text) {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length === 0) return 0;
  const han = chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length;
  return han / chars.length;
}

async function main() {
  const write = process.argv.includes('--write');
  const exams = JSON.parse(fs.readFileSync(EXAMS_PATH, 'utf8'));
  if (exams.length !== 25) throw new Error(`Expected 25 exams, found ${exams.length}`);

  const results = [];
  for (const exam of exams.sort((a, b) => a.year - b.year)) {
    const url = sourceUrl(exam.year);
    process.stdout.write(`[${exam.year}] ${url} ... `);
    const html = await fetchHtml(url);
    const { passage, translations } = extract(html);

    if (translations.length !== 5) {
      throw new Error(`${exam.year}: expected 5 final translations, found ${translations.length}`);
    }
    if (!passage) throw new Error(`${exam.year}: empty Chinese passage`);

    const segmentSources = ['web', 'web', 'web', 'web', 'web'];
    const notes = [];
    const overrides = OVERRIDES[exam.year] || {};
    for (const [rawIdx, override] of Object.entries(overrides)) {
      const idx = Number(rawIdx);
      translations[idx] = override.text;
      segmentSources[idx] = override.source;
      notes.push(override.note);
    }

    const qualityPatches = QUALITY_PATCHES[exam.year] || {};
    for (const [rawIdx, patch] of Object.entries(qualityPatches)) {
      const idx = Number(rawIdx);
      translations[idx] = patch.text;
      if (segmentSources[idx] !== 'reviewed-fallback') {
        segmentSources[idx] = 'web-completed';
      }
      notes.push(patch.note);
    }

    translations.forEach((text, idx) => {
      if (!text || chineseRatio(text) < 0.25) {
        throw new Error(`${exam.year} segment ${idx + 1}: translation is empty or not Chinese enough`);
      }
    });

    const next = {
      ...exam,
      referencePassageMarkdown: passage,
      referenceTranslations: translations,
      referenceSource: {
        name: PRIMARY_SOURCE_NAME,
        url,
        accessedAt: ACCESSED_AT,
      },
      referenceSegmentSources: segmentSources,
      ...(notes.length ? { referenceNotes: notes } : {}),
    };

    results.push(next);
    const fallback = segmentSources.filter((s) => s === 'reviewed-fallback').length;
    const completed = segmentSources.filter((s) => s === 'web-completed').length;
    console.log(`ok (${translations.length} segments, web-completed=${completed}, fallback=${fallback})`);
  }

  const fallbackTotal = results.reduce(
    (sum, e) => sum + e.referenceSegmentSources.filter((s) => s === 'reviewed-fallback').length,
    0
  );
  const completedTotal = results.reduce(
    (sum, e) => sum + e.referenceSegmentSources.filter((s) => s === 'web-completed').length,
    0
  );

  console.log(
    `\nCollected ${results.length} exams / ${results.length * 5} segments. ` +
      `web-completed=${completedTotal}, reviewed-fallback=${fallbackTotal}`
  );

  if (write) {
    fs.writeFileSync(EXAMS_PATH, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${EXAMS_PATH}`);
  } else {
    console.log('Dry run only. Re-run with --write to update exams.json.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
