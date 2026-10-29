import fs from 'fs';

/**
 * Nickname moderation.
 *
 * Nicknames are the only user-authored text other players can see, so they are the
 * one place where the site could publish illegal or harmful content. The built-in
 * list deliberately covers impersonation, advertising, exam fraud, abuse and
 * obscenity; politically sensitive terms are *not* committed to this public
 * repository — operators add them through NICKNAME_BLOCKLIST_FILE instead.
 */

const BUILTIN_BLOCKLIST = [
  // Impersonation of the site, schools or exam authorities
  '官方',
  '管理员',
  '管理員',
  '客服',
  '系统',
  '系統',
  '版主',
  '超管',
  '教育部',
  '考试院',
  '考試院',
  '命题组',
  '閱卷組',
  '阅卷组',
  '招生办',
  'admin',
  'administrator',
  'moderator',
  'official',
  'support',
  // Exam fraud / score tampering
  '代考',
  '替考',
  '枪手',
  '槍手',
  '包过',
  '包過',
  '保过',
  '保過',
  '改分',
  '内部答案',
  '內部答案',
  '真题答案',
  '真題答案',
  '押题',
  '押題',
  '卖答案',
  '賣答案',
  '助考',
  // Advertising / drainage / fraud
  '加微信',
  '加qq',
  '加群',
  '进群',
  '私聊',
  '代练',
  '代練',
  '刷单',
  '刷單',
  '兼职',
  '兼職',
  '日赚',
  '贷款',
  '貸款',
  '办证',
  '辦證',
  '发票',
  '發票',
  '博彩',
  '赌博',
  '賭博',
  '六合彩',
  '棋牌',
  '私服',
  '外挂',
  '外掛',
  // Obscenity / abuse
  '色情',
  '约炮',
  '約炮',
  '裸聊',
  '一夜情',
  '嫖',
  '婊子',
  '傻逼',
  '傻b',
  '操你',
  '草你',
  '妈的',
  '媽的',
  'fuck',
  'shit',
  'bitch',
  'porn',
  // Weapons / drugs
  '冰毒',
  '毒品',
  '枪支',
  '槍支',
  '炸药',
  '炸藥',
];

function loadExternalBlocklist(): string[] {
  const file = (process.env.NICKNAME_BLOCKLIST_FILE || '').trim();
  if (!file) return [];
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

const EXTERNAL_BLOCKLIST = loadExternalBlocklist();

/** Full-width → half-width, strip invisible characters, collapse separators. */
function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\s._\-·•*~|/\\]+/g, '')
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't');
}

const NORMALIZED_TERMS = [...BUILTIN_BLOCKLIST, ...EXTERNAL_BLOCKLIST]
  .map((term) => normalize(term))
  .filter((term) => term.length > 0);

export interface NicknameCheck {
  ok: boolean;
  reason?: string;
  value?: string;
}

/**
 * Validate and normalise a nickname before it is stored or broadcast to opponents.
 * Returns the cleaned value so callers never persist raw control characters.
 */
export function checkNickname(raw: string): NicknameCheck {
  const cleaned = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .trim();

  const length = Array.from(cleaned).length;
  if (length < 1) return { ok: false, reason: '昵称不能为空' };
  if (length > 20) return { ok: false, reason: '昵称不能超过 20 个字符' };

  if (/https?:\/\/|www\.|\.(com|cn|net|top|xyz|cc)\b/i.test(cleaned)) {
    return { ok: false, reason: '昵称不能包含网址或推广信息' };
  }
  if (/(?:\+?86)?1[3-9]\d{9}/.test(cleaned.replace(/[\s-]/g, ''))) {
    return { ok: false, reason: '昵称不能包含手机号等联系方式' };
  }
  if (/(.)\1{5,}/u.test(cleaned)) {
    return { ok: false, reason: '昵称不能包含大量重复字符' };
  }

  const normalized = normalize(cleaned);
  for (const term of NORMALIZED_TERMS) {
    if (normalized.includes(term)) {
      // Deliberately generic: do not teach evaders which word tripped the filter.
      return { ok: false, reason: '昵称包含不允许使用的词语，请更换后重试' };
    }
  }

  return { ok: true, value: cleaned };
}

/** Lightweight output guard for AI text rendered back to the user. */
export function softenUnsafeOutput(text: string): string {
  if (!text) return text;
  let result = text;
  for (const term of ['<script', 'javascript:', 'onerror=']) {
    result = result.replace(new RegExp(term, 'gi'), '');
  }
  return result;
}
