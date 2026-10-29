import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { getSiteInfo, psbQueryUrl, LEGAL_LINKS } from '../../shared/site.js';

/**
 * Filing footer.
 *
 * MIIT requires the website filing number to appear at the bottom of the homepage,
 * centred, and to link to the MIIT filing query system. The number is injected at
 * runtime (see src/shared/site.ts) so it never enters the public repository.
 */
export const SiteFooter: React.FC = () => {
  const site = getSiteInfo();
  const year = new Date().getFullYear();
  const operator = site.operator || '本站主办者';
  const hasIcp = site.icpNumber.length > 0;

  return (
    <footer className="border-t-2 border-swiss-black dark:border-zinc-800 bg-white dark:bg-zinc-900 mt-16 font-mono text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col items-center gap-3 text-center">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <span className="w-2.5 h-2.5 bg-swiss-red inline-block" aria-hidden="true" />
          <span className="font-bold uppercase tracking-wider text-swiss-black dark:text-zinc-100">
            TRANSLATION TRAINING // 2002–2026
          </span>
          <span className="hidden sm:inline text-zinc-300 dark:text-zinc-700">|</span>
          <span>{site.siteName}</span>
        </div>

        <p className="max-w-3xl text-zinc-500 dark:text-zinc-400">
          本站为个人非经营性学习交流站点，与教育部、教育考试院及各招生单位无隶属或合作关系；
          真题原文与参考译文均来自公开出版物及网络公开资料，仅供个人备考学习使用。
        </p>

        <p className="max-w-3xl text-zinc-500 dark:text-zinc-400">
          站内评分、采分点与点评均由评分程序自动生成，仅供参考，不构成官方阅卷结论。
        </p>

        <nav
          aria-label="站点合规信息"
          className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-1"
        >
          {LEGAL_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="underline decoration-zinc-300 dark:decoration-zinc-700 underline-offset-4 hover:text-swiss-red dark:hover:text-swiss-red transition-colors"
            >
              {link.label}
            </a>
          ))}
          <a
            href="https://www.12377.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-swiss-red hover:underline underline-offset-4"
          >
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            12377 举报
          </a>
        </nav>

        <div className="flex flex-col items-center gap-1 pt-1 text-[11px]">
          {/* ICP filing number — centred at the bottom, linked to beian.miit.gov.cn */}
          {hasIcp ? (
            <a
              href={site.icpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-swiss-red transition-colors"
            >
              {site.icpNumber}
            </a>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">ICP备案号待配置</span>
          )}

          {site.psbNumber && (
            <a
              href={psbQueryUrl(site.psbCode)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-swiss-red transition-colors"
            >
              {site.psbNumber}
            </a>
          )}

          <span>
            © {year} {operator} · 保留所有权利
          </span>

          {site.contactEmail && (
            <span>
              联系邮箱：{' '}
              <a
                href={`mailto:${site.contactEmail}`}
                className="underline underline-offset-4 hover:text-swiss-red"
              >
                {site.contactEmail}
              </a>
            </span>
          )}
        </div>
      </div>
    </footer>
  );
};
