import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

dotenv.config();

/**
 * Thinking-mode effort sent to DeepSeek.
 *
 * `max` is the top tier of the documented effort ladder
 * (`minimal|low|medium|high|xhigh|max|ultra` -> `low|low|high|high|high|max|max`).
 * Grading is the product's core quality gate, so it runs at full reasoning depth;
 * `DEEPSEEK_REASONING_EFFORT` can lower it without a code change. Kept in one place
 * so both grading entry points, the startup log and the deployed bundle can be
 * verified against the same value.
 */
const DEEPSEEK_EFFORTS = ['low', 'high', 'max'] as const;
type DeepSeekEffort = (typeof DEEPSEEK_EFFORTS)[number];

function resolveDeepSeekEffort(): DeepSeekEffort {
  const raw = (process.env.DEEPSEEK_REASONING_EFFORT || '').trim().toLowerCase();
  return (DEEPSEEK_EFFORTS as readonly string[]).includes(raw) ? (raw as DeepSeekEffort) : 'max';
}

/**
 * Budget for a single grading request. Max-effort reasoning takes noticeably longer
 * than lower tiers, so this is deliberately generous; the PVP end-of-match guardrail
 * is derived from it below to keep the two in sync (previously they were unrelated
 * magic numbers, and a short request timeout could strand a finished match).
 */
const DEEPSEEK_REQUEST_TIMEOUT_MS = 150_000;

export const CONFIG = {
  port: parseInt(process.env.PORT || '8888', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  invitationCode: process.env.INVITATION_CODE || process.env.SITE_PASSWORD || 'tt8888',
  sitePassword: process.env.INVITATION_CODE || process.env.SITE_PASSWORD || 'tt8888', // Backwards compatibility
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekReasoningEffort: resolveDeepSeekEffort(),
  deepseekRequestTimeoutMs: DEEPSEEK_REQUEST_TIMEOUT_MS,
  /** Grace period after the last in-flight grading call before a match is force-closed. */
  pvpGradingGuardrailMs: DEEPSEEK_REQUEST_TIMEOUT_MS + 30_000,
  staticDir: path.resolve(process.cwd(), 'dist/client'),
  /** Public origin(s) allowed to call the API from a browser. Same-origin needs none. */
  allowedOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
  /**
   * HMAC secret for login and spectate tokens. Set AUTH_SECRET in production so
   * tokens survive restarts; the derived fallback only exists for local dev.
   */
  authSecret:
    (process.env.AUTH_SECRET || '').trim() ||
    crypto
      .createHash('sha256')
      .update(`translation-training:${process.env.SITE_PASSWORD || 'dev'}:token-v2`)
      .digest('hex'),
  /** Minimum password length for new registrations (existing accounts unaffected). */
  passwordMinLength: 8,
  /** Current user-agreement / privacy-policy version recorded on registration. */
  termsVersion: process.env.TERMS_VERSION || '2026-10-29',
  /** Trust X-Forwarded-* from the local nginx reverse proxy. */
  trustProxy: process.env.TRUST_PROXY === 'false' ? false : true,
  site: {
    name: (process.env.SITE_NAME || '翻译训练 · 考研英语翻译竞技场').trim(),
    /** Website ICP filing number — kept out of git, injected at runtime. */
    icpNumber: (process.env.SITE_ICP_NUMBER || '').trim(),
    icpUrl: (process.env.SITE_ICP_URL || 'https://beian.miit.gov.cn/').trim(),
    psbNumber: (process.env.SITE_PSB_NUMBER || '').trim(),
    psbCode: (process.env.SITE_PSB_CODE || '').trim(),
    operator: (process.env.SITE_OPERATOR || '').trim(),
    contactEmail: (process.env.SITE_CONTACT_EMAIL || '').trim(),
    policyUpdatedAt: (process.env.SITE_POLICY_UPDATED_AT || '2026-10-29').trim(),
    termsVersion: (process.env.TERMS_VERSION || '2026-10-29').trim(),
  },
};
