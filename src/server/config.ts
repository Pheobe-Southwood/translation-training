import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

/**
 * Thinking-mode effort sent to DeepSeek. The grading rubric is strict and the
 * model is instructed to work through every scoring point, so `high` is the
 * required baseline (DeepSeek also maps `medium` to `high`; only `max` sits
 * above it). Kept in one place so both grading entry points, the startup log and
 * the deployed bundle can be verified against the same value.
 */
const DEEPSEEK_EFFORTS = ['low', 'high', 'max'] as const;
type DeepSeekEffort = (typeof DEEPSEEK_EFFORTS)[number];

function resolveDeepSeekEffort(): DeepSeekEffort {
  const raw = (process.env.DEEPSEEK_REASONING_EFFORT || '').trim().toLowerCase();
  return (DEEPSEEK_EFFORTS as readonly string[]).includes(raw) ? (raw as DeepSeekEffort) : 'high';
}

export const CONFIG = {
  port: parseInt(process.env.PORT || '8888', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  invitationCode: process.env.INVITATION_CODE || process.env.SITE_PASSWORD || 'tt8888',
  sitePassword: process.env.INVITATION_CODE || process.env.SITE_PASSWORD || 'tt8888', // Backwards compatibility
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekReasoningEffort: resolveDeepSeekEffort(),
  staticDir: path.resolve(process.cwd(), 'dist/client'),
};
