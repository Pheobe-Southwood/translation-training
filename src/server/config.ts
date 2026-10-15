import dotenv from 'dotenv';
import path from 'path';

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
};
