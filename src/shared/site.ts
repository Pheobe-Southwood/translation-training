/**
 * Site identity that is *not* hard-coded in the repository.
 *
 * Chinese ICP filing numbers must be displayed on the homepage, but they also
 * identify the filing entity. The operator asked that the number stay out of the
 * public git history, so it is injected at runtime by the server (`/site-info.js`)
 * from `/var/www/translation-training/.env` instead of being baked into the bundle.
 * In local dev the injected object is absent and the placeholders below are used.
 */
export interface SiteInfo {
  /** Human-readable site name used in legal pages and the footer. */
  siteName: string;
  /** Website ICP filing number, e.g. 湘ICP备********号-1. Empty => "待配置". */
  icpNumber: string;
  /** MIIT filing query system, linked directly under the number as required. */
  icpUrl: string;
  /** Public-security (公安) network filing number, e.g. 湘公网安备4301xxxxxxxxxx号. */
  psbNumber: string;
  /** Numeric code used by beian.mps.gov.cn deep links. */
  psbCode: string;
  /** Filing entity shown in the copyright line (individual or company). */
  operator: string;
  /** Contact mailbox for privacy / infringement / abuse requests. */
  contactEmail: string;
  /** Revision date of the user agreement and privacy policy. */
  policyUpdatedAt: string;
  /** Version string recorded when a user accepts the terms at registration. */
  termsVersion: string;
}

/** MIIT public filing query, mandated as the click target of the ICP number. */
export const ICP_QUERY_URL = 'https://beian.miit.gov.cn/';

/** Ministry of Public Security filing query entry point. */
export const PSB_QUERY_URL = 'https://beian.mps.gov.cn/#/query/webSearch';

/** Bump together with the legal pages whenever their substance changes. */
export const TERMS_VERSION = '2026-10-29';

const DEFAULT_SITE_INFO: SiteInfo = {
  siteName: '翻译训练 · 考研英语翻译竞技场',
  icpNumber: '',
  icpUrl: ICP_QUERY_URL,
  psbNumber: '',
  psbCode: '',
  operator: '',
  contactEmail: '',
  policyUpdatedAt: '2026-10-29',
  termsVersion: TERMS_VERSION,
};

declare global {
  interface Window {
    __SITE_INFO__?: Partial<SiteInfo>;
  }
}

/**
 * Read the runtime-injected site identity.
 *
 * Unknown/blank injected values fall back to the compiled defaults so a missing
 * environment variable can never produce `undefined` in the footer.
 */
export function getSiteInfo(): SiteInfo {
  const injected =
    typeof window !== 'undefined' ? window.__SITE_INFO__ : (globalThis as any).__SITE_INFO__;
  if (!injected || typeof injected !== 'object') return DEFAULT_SITE_INFO;

  const merged: SiteInfo = { ...DEFAULT_SITE_INFO };
  for (const key of Object.keys(DEFAULT_SITE_INFO) as Array<keyof SiteInfo>) {
    const value = injected[key];
    if (typeof value === 'string' && value.trim()) merged[key] = value.trim();
  }
  return merged;
}

/** Deep link into the MPS filing database for the displayed 公安备案号. */
export function psbQueryUrl(code: string): string {
  return code ? `${PSB_QUERY_URL}?code=${encodeURIComponent(code)}` : PSB_QUERY_URL;
}

/** Links shown in the footer; all of them must work without logging in. */
export const LEGAL_LINKS = [
  { href: '/legal/terms.html', label: '用户协议' },
  { href: '/legal/privacy.html', label: '隐私政策' },
  { href: '/legal/copyright.html', label: '版权与免责' },
  { href: '/legal/report.html', label: '违法和不良信息举报' },
] as const;
