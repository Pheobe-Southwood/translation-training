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
} from 'lucide-react';
import type { HistorySessionRecord } from '../../shared/types.js';
import { getAuthToken, getLocalHistory, setLocalHistory, clearHistory } from '../utils/storage.js';
import { GradingCard } from '../components/GradingCard.js';

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

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs}秒`;
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-swiss-black pb-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-zinc-300 hover:border-swiss-black font-mono text-xs font-bold transition-colors bg-white"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回真题首页
        </button>

        <div className="flex items-center gap-3">
          {records.length > 0 && (
            <button
              onClick={handleClear}
              className="flex items-center gap-1 px-3 py-1.5 border border-zinc-300 hover:border-red-600 hover:text-red-600 font-mono text-xs transition-colors bg-white text-zinc-600"
            >
              <Trash2 className="w-3.5 h-3.5" />
              清空历史档案
            </button>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="border-4 border-swiss-black bg-white p-6 md:p-8 shadow-[8px_8px_0px_0px_#09090b]">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-3 h-3 bg-swiss-red"></span>
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-zinc-500">
            ARCHIVES // 线上历史档案
          </span>
        </div>
        <h1 className="text-3xl font-black uppercase text-swiss-black">
          练习与对战档案库
        </h1>
        <p className="font-mono text-xs text-zinc-600 mt-2">
          记录您的真题翻译与对战成绩，已安全持久化存储至线上云端数据库。
        </p>
      </div>

      {/* List */}
      {loading && records.length === 0 ? (
        <div className="border-2 border-dashed border-zinc-300 p-12 text-center bg-white font-mono text-xs text-zinc-500 space-y-2">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-swiss-red" />
          <div>正在从线上数据库同步历史作答档案...</div>
        </div>
      ) : records.length === 0 ? (
        <div className="border-2 border-dashed border-zinc-300 p-12 text-center bg-white font-mono text-xs text-zinc-500 space-y-3">
          <Trophy className="w-8 h-8 text-zinc-300 mx-auto" />
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
                className="border-2 border-swiss-black bg-white shadow-[4px_4px_0px_0px_#09090b] transition-all"
              >
                {/* Header Summary */}
                <div
                  onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                  className="p-5 flex flex-wrap items-center justify-between gap-4 cursor-pointer hover:bg-zinc-50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <span
                      className={`font-mono text-xs font-black uppercase px-2.5 py-1 border flex items-center gap-1.5 ${
                        rec.type === 'pvp'
                          ? 'bg-swiss-red text-white border-swiss-red'
                          : 'bg-zinc-900 text-white border-zinc-900'
                      }`}
                    >
                      {rec.type === 'pvp' ? <Swords className="w-3.5 h-3.5" /> : null}
                      {rec.type === 'pvp' ? 'PVP 对战' : '单人练习'}
                    </span>

                    <div>
                      <div className="font-black text-base text-swiss-black">
                        {rec.year} 年考研英语（一）翻译
                      </div>
                      <div className="font-mono text-xs text-zinc-500 flex items-center gap-3 mt-1">
                        <span>{dateStr}</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDuration(rec.timeSpentSeconds)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    {/* PVP Result Badge */}
                    {rec.type === 'pvp' && rec.pvpDetails && (
                      <div className="text-right font-mono text-xs">
                        <span
                          className={`font-black px-2 py-0.5 uppercase ${
                            rec.pvpDetails.outcome === 'win'
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : rec.pvpDetails.outcome === 'draw'
                              ? 'bg-zinc-100 text-zinc-700'
                              : 'bg-zinc-100 text-zinc-600'
                          }`}
                        >
                          {rec.pvpDetails.outcome === 'win'
                            ? 'VICTORY'
                            : rec.pvpDetails.outcome === 'draw'
                            ? 'DRAW'
                            : 'DEFEAT'}
                        </span>
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          VS {rec.pvpDetails.opponentNickname} ({rec.pvpDetails.opponentScore.toFixed(1)}分)
                        </div>
                      </div>
                    )}

                    {/* Total Score */}
                    <div className="flex items-baseline gap-1 bg-zinc-100 border border-swiss-black px-3.5 py-1">
                      <span className="font-mono text-xl font-black text-swiss-red">
                        {rec.totalScore.toFixed(1)}
                      </span>
                      <span className="font-mono text-xs text-zinc-500">/ 10.0</span>
                    </div>

                    <div className="text-zinc-400">
                      {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                    </div>
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t-2 border-swiss-black p-6 bg-zinc-50 space-y-6">
                    <div className="font-mono text-xs font-bold text-zinc-700 uppercase flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-swiss-red" />
                      全套 5 题作答与 AI 阅卷评定细则
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
    </div>
  );
};
