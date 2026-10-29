import React, { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Trash2,
  Trophy,
  Swords,
  ChevronDown,
  ChevronUp,
  Clock,
  Sparkles,
  Loader2,
  Download,
  UserX,
  ShieldCheck,
} from 'lucide-react';
import type { HistorySessionRecord } from '../../shared/types.js';
import {
  getAuthToken,
  getLocalHistory,
  setLocalHistory,
  clearHistory,
  removeAuthToken,
} from '../utils/storage.js';
import { GradingCard } from '../components/GradingCard.js';
import { directionLabel, directionShort } from '../../shared/direction.js';

interface HistoryViewProps {
  onBack: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({ onBack }) => {
  const [records, setRecords] = useState<HistorySessionRecord[]>(() => getLocalHistory());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchHistoryOnline();
  }, []);

  const fetchHistoryOnline = async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      const res = await fetch('/api/history', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.records) {
          setRecords(data.records);
          setLocalHistory(data.records);
        }
      }
    } catch (err) {
      console.error('Failed to load history online:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    if (confirm('确定清空所有线上练习与对战档案吗？此操作不可撤销。')) {
      try {
        const token = getAuthToken();
        await fetch('/api/history', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        console.error('Failed to clear online history:', err);
      }
      clearHistory();
      setRecords([]);
    }
  };

  /** PIPL art. 45: download a machine-readable copy of all stored account data. */
  const handleExportData = async () => {
    const token = getAuthToken();
    if (!token) {
      alert('请先登录后再导出数据');
      return;
    }
    try {
      const res = await fetch('/api/user/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'translation-training-account.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export account data:', err);
      alert('导出失败，请稍后重试或通过页面底部邮箱联系我们。');
    }
  };

  /** PIPL art. 47: irreversible account deletion after password re-authentication. */
  const handleDeleteAccount = async () => {
    if (
      !confirm(
        '注销账号将永久删除你的账号、昵称与全部练习/对战记录，且无法恢复。\n\n确定继续吗？'
      )
    ) {
      return;
    }
    const password = prompt('请输入当前账号的登录密码以确认注销：');
    if (!password) return;

    try {
      const res = await fetch('/api/user/account', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || '注销失败，请检查密码后重试');
        return;
      }
      removeAuthToken();
      clearHistory();
      alert('账号已注销，所有关联记录已删除。');
      window.location.hash = '';
      window.location.reload();
    } catch (err) {
      console.error('Failed to delete account:', err);
      alert('网络错误，注销未完成，请稍后重试。');
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs}秒`;
  };

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-6 sm:space-y-8">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-swiss-black dark:border-zinc-800 pb-3 sm:pb-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 font-mono text-xs font-bold transition-colors bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回真题首页
        </button>

        <div className="flex items-center gap-3">
          {records.length > 0 && (
            <button
              onClick={handleClear}
              className="flex items-center gap-1 px-3 py-1.5 border border-zinc-300 dark:border-zinc-700 hover:border-red-600 hover:text-red-600 font-mono text-xs transition-colors bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 active:scale-[0.98]"
            >
              <Trash2 className="w-3.5 h-3.5" />
              清空历史档案
            </button>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 sm:p-8 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000]">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-3 h-3 bg-swiss-red"></span>
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
            ARCHIVES // 线上历史档案
          </span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-black uppercase text-swiss-black dark:text-zinc-100">
          练习与对战档案库
        </h1>
        <p className="font-mono text-xs text-zinc-600 dark:text-zinc-400 mt-2">
          记录您的真题翻译与对战成绩，已安全持久化存储至线上云端数据库。
        </p>
      </div>

      {/* List */}
      {loading && records.length === 0 ? (
        <div className="border-2 border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center bg-white dark:bg-zinc-900 font-mono text-xs text-zinc-500 dark:text-zinc-400 space-y-2">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-swiss-red" />
          <div>正在从线上数据库同步历史作答档案...</div>
        </div>
      ) : records.length === 0 ? (
        <div className="border-2 border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center bg-white dark:bg-zinc-900 font-mono text-xs text-zinc-500 dark:text-zinc-400 space-y-3">
          <Trophy className="w-8 h-8 text-zinc-300 dark:text-zinc-700 mx-auto" />
          <div>暂无历史记录，快去首页开启一次单人刷题或 PVP 竞技吧！</div>
        </div>
      ) : (
        <div className="space-y-4">
          {records.map((rec) => {
            const isExpanded = expandedId === rec.id;
            const dateStr = new Date(rec.timestamp).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            });

            return (
              <div
                key={rec.id}
                className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] transition-all"
              >
                {/* Header Summary */}
                <div
                  onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                  className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 sm:gap-4 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors"
                >
                  <div className="flex items-center gap-3 sm:gap-4">
                    <span
                      className={`font-mono text-xs font-black uppercase px-2.5 py-1 border flex items-center gap-1.5 shrink-0 ${
                        rec.type === 'pvp'
                          ? 'bg-swiss-red text-white border-swiss-red'
                          : 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-swiss-black border-zinc-900 dark:border-zinc-100'
                      }`}
                    >
                      {rec.type === 'pvp' ? <Swords className="w-3.5 h-3.5" /> : null}
                      {rec.type === 'pvp' ? 'PVP 对战' : '单人练习'}
                    </span>

                    <span className={`font-mono text-[10px] font-black uppercase px-2 py-1 border shrink-0 ${
                      rec.direction === 'zh-en'
                        ? 'bg-rose-50 dark:bg-rose-950/40 text-swiss-red dark:text-rose-300 border-swiss-red/60'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700'
                    }`}>
                      {directionShort(rec.direction || 'en-zh')} · {directionLabel(rec.direction || 'en-zh')}
                    </span>

                    <div>
                      <div className="font-black text-sm sm:text-base text-swiss-black dark:text-zinc-100">
                        {rec.year} 年考研英语（一）翻译
                      </div>
                      <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-3 mt-0.5">
                        <span>{dateStr}</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDuration(rec.timeSpentSeconds)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 sm:gap-6">
                    {/* PVP Result Badge */}
                    {rec.type === 'pvp' && rec.pvpDetails && (
                      <div className="text-right font-mono text-xs">
                        <span
                          className={`font-black px-2 py-0.5 uppercase ${
                            rec.pvpDetails.outcome === 'win'
                              ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800'
                              : rec.pvpDetails.outcome === 'draw'
                              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                          }`}
                        >
                          {rec.pvpDetails.playerCount && rec.pvpDetails.playerCount > 2
                            ? `RANK #${rec.pvpDetails.rank || 1} / ${rec.pvpDetails.playerCount}人局`
                            : rec.pvpDetails.outcome === 'win'
                            ? 'VICTORY'
                            : rec.pvpDetails.outcome === 'draw'
                            ? 'DRAW'
                            : 'DEFEAT'}
                        </span>
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                          {rec.pvpDetails.leaderboard && rec.pvpDetails.leaderboard.length > 2
                            ? rec.pvpDetails.leaderboard
                                .map((item) => `#${item.rank} ${item.nickname}(${item.score.toFixed(1)})`)
                                .join(' · ')
                            : `VS ${rec.pvpDetails.opponentNickname} (${rec.pvpDetails.opponentScore.toFixed(1)}分)`}
                        </div>
                      </div>
                    )}

                    {/* Total Score */}
                    <div className="flex items-baseline gap-1 bg-zinc-100 dark:bg-zinc-800 border border-swiss-black dark:border-zinc-700 px-3 py-0.5 sm:px-3.5 sm:py-1">
                      <span className="font-mono text-lg sm:text-xl font-black text-swiss-red">
                        {rec.totalScore.toFixed(1)}
                      </span>
                      <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">/ 10.0</span>
                    </div>

                    <div className="text-zinc-400">
                      {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                    </div>
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t-2 border-swiss-black dark:border-zinc-700 p-4 sm:p-6 bg-zinc-50 dark:bg-zinc-800/40 space-y-5">
                    <div className="font-mono text-xs font-bold text-zinc-700 dark:text-zinc-300 uppercase flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-swiss-red" />
                      全套 5 题作答与程序阅卷评定细则
                    </div>

                    <div className="space-y-4">
                      {rec.submissions.map((sub, idx) => {
                        if (!sub.gradingResult) return null;
                        return (
                          <GradingCard
                            key={idx}
                            result={sub.gradingResult}
                            studentAnswer={sub.studentAnswer}
                            originalText={sub.originalText}
                            segmentIndex={idx}
                            direction={rec.direction || 'en-zh'}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Account & data controls — required by the privacy policy and PIPL. */}
      <section className="border-2 border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 space-y-3">
        <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-300">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          账号与个人数据
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed font-mono">
          你可以随时导出或删除自己的数据。导出文件包含账号资料与全部练习记录；
          注销后账号与记录将在 30 日内从备份中清除。依据
          <a href="/legal/privacy.html" target="_blank" rel="noopener noreferrer" className="mx-1 underline underline-offset-2">
            《隐私政策》
          </a>
          行使查阅、复制、删除与注销权利。
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={handleExportData}
            className="flex items-center gap-1.5 px-3 py-2 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 font-mono text-xs font-bold transition-colors bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
          >
            <Download className="w-3.5 h-3.5" />
            导出我的数据
          </button>
          <button
            onClick={handleDeleteAccount}
            className="flex items-center gap-1.5 px-3 py-2 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 font-mono text-xs font-bold transition-colors bg-white dark:bg-zinc-900"
          >
            <UserX className="w-3.5 h-3.5" />
            注销账号
          </button>
        </div>
      </section>
    </div>
  );
};
