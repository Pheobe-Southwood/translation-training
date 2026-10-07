import React, { useState, useEffect } from 'react';
import { ArrowRight, Dices, Swords, Trophy } from 'lucide-react';
import { getAuthToken } from '../utils/storage.js';

interface HomeViewProps {
  onStartSolo: (year: number) => void;
  onEnterPvpLobby: (selectedYear: number) => void;
  onViewHistory: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  onStartSolo,
  onEnterPvpLobby,
  onViewHistory,
}) => {
  const [years, setYears] = useState<number[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(2024);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchYears();
  }, []);

  const fetchYears = async () => {
    try {
      const token = getAuthToken();
      const res = await fetch('/api/exams/years', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setYears(data.years || []);
        if (data.years && data.years.length > 0) {
          setSelectedYear(data.years[0]); // Most recent
        }
      }
    } catch (err) {
      console.error('Failed to fetch years:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRandomYear = () => {
    if (years.length === 0) return;
    const random = years[Math.floor(Math.random() * years.length)];
    setSelectedYear(random);
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-6 sm:space-y-8">
      {/* Hero Poster Banner - Simplified & Pure Swiss */}
      <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 sm:p-10 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] space-y-3 sm:space-y-4">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 bg-swiss-red"></span>
          <span className="font-mono text-[10px] sm:text-xs font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-400">
            POSTGRADUATE ENTRANCE EXAM // ENGLISH (I)
          </span>
        </div>

        <h1 className="text-2xl sm:text-3xl md:text-5xl font-black uppercase tracking-tight text-swiss-black dark:text-zinc-100 leading-tight sm:leading-none">
          考研英语（一）<span className="text-swiss-red">翻译强化训练与对战</span>
        </h1>

        <p className="text-xs md:text-sm text-zinc-600 dark:text-zinc-400 font-mono leading-relaxed max-w-3xl">
          收录 2002–2026 全年 25 套真题长难句 · 接入官方 DeepSeek 深度高推理阅卷 · 支持 2–4 人实时对战与观战大屏
        </p>
      </div>

      {/* Grid: Year Selection & Mode Selection */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
        {/* Left Column: Year Selector directly at top (7 Cols) */}
        <div className="lg:col-span-7 space-y-6">
          <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 shadow-[5px_5px_0px_0px_#09090b] dark:shadow-[5px_5px_0px_0px_#000000]">
            <div className="flex items-center justify-between pb-3 sm:pb-4 border-b border-zinc-200 dark:border-zinc-800 mb-4">
              <div className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                真题年份选择 (SELECT YEAR)
              </div>
              <button
                onClick={handleRandomYear}
                className="flex items-center gap-1.5 px-2.5 py-1 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-500 font-mono text-xs font-bold transition-colors bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
              >
                <Dices className="w-3.5 h-3.5 text-swiss-red" />
                随机抽取
              </button>
            </div>

            {loading ? (
              <div className="py-10 text-center font-mono text-xs text-zinc-500 dark:text-zinc-400">
                加载真题题库中...
              </div>
            ) : (
              <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2">
                {years.map((y) => {
                  const isSelected = y === selectedYear;
                  return (
                    <button
                      key={y}
                      onClick={() => setSelectedYear(y)}
                      className={`py-2 px-1 text-center font-mono text-xs font-bold border transition-all ${
                        isSelected
                          ? 'bg-swiss-black text-white border-swiss-black dark:bg-zinc-100 dark:text-swiss-black dark:border-zinc-100 shadow-[2px_2px_0px_0px_#E11D48]'
                          : 'bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border-zinc-200 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-700/60'
                      }`}
                    >
                      {y}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between text-xs font-mono text-zinc-500 dark:text-zinc-400">
              <span>当前选中试卷：</span>
              <span className="font-bold text-swiss-black dark:text-zinc-100">{selectedYear} 年英语（一）翻译</span>
            </div>
          </div>
        </div>

        {/* Right Column: Modes (5 Cols) */}
        <div className="lg:col-span-5 space-y-5 sm:space-y-6">
          {/* Mode 1: Solo Training */}
          <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 sm:p-6 shadow-[5px_5px_0px_0px_#09090b] dark:shadow-[5px_5px_0px_0px_#000000] group hover:border-swiss-red dark:hover:border-swiss-red transition-all">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-200 dark:border-zinc-800 mb-3">
              <span className="font-mono text-xs font-bold text-zinc-400 uppercase tracking-wider">
                MODE 01 // 自主刷题
              </span>
              <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full"></span>
            </div>

            <h3 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-swiss-black dark:text-zinc-100 mb-1.5">
              单人练习模式
            </h3>
            <p className="text-xs font-mono text-zinc-600 dark:text-zinc-400 mb-5 leading-relaxed">
              逐句翻译 5 道真题长难句。确认提交上一句后系统后台异步评分，瞬时切换下一题。
            </p>

            <button
              onClick={() => onStartSolo(selectedYear)}
              className="w-full py-3.5 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 active:scale-[0.99]"
            >
              <span>开始 {selectedYear} 年练习</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {/* Mode 2: PVP Arena */}
          <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 sm:p-6 shadow-[5px_5px_0px_0px_#09090b] dark:shadow-[5px_5px_0px_0px_#000000] group hover:border-swiss-red dark:hover:border-swiss-red transition-all">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-200 dark:border-zinc-800 mb-3">
              <span className="font-mono text-xs font-bold text-swiss-red uppercase tracking-wider flex items-center gap-1">
                <Swords className="w-3.5 h-3.5" /> MODE 02 // 实时联机
              </span>
              <span className="w-2.5 h-2.5 bg-swiss-red rounded-full animate-ping"></span>
            </div>

            <h3 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-swiss-black dark:text-zinc-100 mb-1.5">
              PVP 多人竞技与观战大屏
            </h3>
            <p className="text-xs font-mono text-zinc-600 dark:text-zinc-400 mb-5 leading-relaxed">
              支持 2–4 人自定义房间人数同题竞速，并开放实时观战位大屏，实时追踪全场选手作答内容与 AI 判分。
            </p>

            <button
              onClick={() => onEnterPvpLobby(selectedYear)}
              className="w-full py-3.5 bg-swiss-red hover:bg-rose-700 text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 active:scale-[0.99]"
            >
              <span>进入 PVP 联机大厅</span>
              <Swords className="w-4 h-4" />
            </button>
          </div>

          {/* Quick History Link */}
          <div 
            onClick={onViewHistory}
            className="border-2 border-dashed border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 p-4 bg-zinc-50 dark:bg-zinc-800/50 cursor-pointer transition-colors flex items-center justify-between text-xs font-mono"
          >
            <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 font-bold">
              <Trophy className="w-4 h-4 text-amber-500" />
              <span>查看我的线上练习与对战档案</span>
            </div>
            <ArrowRight className="w-4 h-4 text-zinc-400" />
          </div>
        </div>
      </div>
    </div>
  );
};
