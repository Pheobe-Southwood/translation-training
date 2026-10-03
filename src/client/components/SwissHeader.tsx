import React from 'react';
import { History, LogOut, Swords, User, Sun, Moon } from 'lucide-react';

interface SwissHeaderProps {
  currentView: string;
  onNavigate: (view: 'home' | 'solo' | 'pvp-lobby' | 'history') => void;
  nickname: string;
  username?: string;
  onChangeNickname: () => void;
  onLogout: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export const SwissHeader: React.FC<SwissHeaderProps> = ({
  currentView,
  onNavigate,
  nickname,
  username,
  onChangeNickname,
  onLogout,
  theme,
  onToggleTheme,
}) => {
  return (
    <header className="border-b-2 border-swiss-black dark:border-zinc-800 bg-white dark:bg-zinc-900/95 backdrop-blur-sm sticky top-0 z-40 transition-colors duration-150">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-2">
        {/* Logo and Brand */}
        <div 
          onClick={() => onNavigate('home')} 
          className="flex items-center gap-2 sm:gap-3 cursor-pointer group shrink-0"
        >
          <div className="w-7 h-7 sm:w-8 sm:h-8 bg-swiss-red flex items-center justify-center font-bold text-white text-base sm:text-lg transition-transform group-hover:scale-105 shrink-0">
            +
          </div>
          <div>
            <div className="font-extrabold tracking-tighter text-sm sm:text-lg leading-tight uppercase font-mono text-swiss-black dark:text-zinc-100">
              TRANSLATION TRAINING
            </div>
            <div className="text-[9px] sm:text-[10px] uppercase tracking-widest text-swiss-subtle dark:text-zinc-400 font-mono">
              考研英语一 // 翻译竞技场
            </div>
          </div>
        </div>

        {/* Center navigation hints (Desktop) */}
        <div className="hidden md:flex items-center gap-4 lg:gap-6 font-mono text-xs uppercase font-semibold">
          <button
            onClick={() => onNavigate('home')}
            className={`px-3 py-1.5 border transition-all ${
              currentView === 'home'
                ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black border-swiss-black dark:border-zinc-100'
                : 'border-transparent hover:border-swiss-black dark:hover:border-zinc-700 text-swiss-black dark:text-zinc-300'
            }`}
          >
            首页导航
          </button>
          <button
            onClick={() => onNavigate('pvp-lobby')}
            className={`px-3 py-1.5 border flex items-center gap-1.5 transition-all ${
              currentView === 'pvp-lobby' || currentView === 'pvp-match'
                ? 'bg-swiss-red text-white border-swiss-red'
                : 'border-transparent hover:border-swiss-black dark:hover:border-zinc-700 text-swiss-black dark:text-zinc-300'
            }`}
          >
            <Swords className="w-3.5 h-3.5" />
            PVP 对战
          </button>
          <button
            onClick={() => onNavigate('history')}
            className={`px-3 py-1.5 border flex items-center gap-1.5 transition-all ${
              currentView === 'history'
                ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black border-swiss-black dark:border-zinc-100'
                : 'border-transparent hover:border-swiss-black dark:hover:border-zinc-700 text-swiss-black dark:text-zinc-300'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            练习档案
          </button>
        </div>

        {/* Right Action Bar */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 font-mono text-xs shrink-0">
          {/* Theme Toggle Button */}
          <button
            onClick={onToggleTheme}
            title={theme === 'dark' ? '切换为亮色模式' : '切换为深色模式'}
            aria-label="Toggle dark mode"
            className="p-1.5 sm:px-2.5 sm:py-1.5 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-500 transition-colors bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 flex items-center gap-1.5"
          >
            {theme === 'dark' ? (
              <Sun className="w-3.5 h-3.5 text-amber-400 stroke-[2.5]" />
            ) : (
              <Moon className="w-3.5 h-3.5 text-zinc-600 stroke-[2.5]" />
            )}
            <span className="hidden lg:inline text-[11px] font-bold">
              {theme === 'dark' ? '深色' : '浅色'}
            </span>
          </button>

          {/* User Nickname Button */}
          <button
            onClick={onChangeNickname}
            title={username ? `账号: @${username} (点击修改昵称)` : '修改昵称'}
            className="flex items-center gap-1 sm:gap-1.5 px-2 py-1.5 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-500 transition-colors bg-zinc-50 dark:bg-zinc-800 text-swiss-black dark:text-zinc-200"
          >
            <User className="w-3.5 h-3.5 text-swiss-subtle dark:text-zinc-400 shrink-0" />
            <span className="font-bold max-w-[65px] xs:max-w-[85px] sm:max-w-[110px] truncate text-[11px] sm:text-xs">
              {nickname}
            </span>
          </button>

          {/* Mobile History shortcut */}
          <button
            onClick={() => onNavigate('history')}
            title="历史记录"
            className={`p-1.5 border transition-colors md:hidden ${
              currentView === 'history'
                ? 'bg-swiss-black text-white border-swiss-black dark:bg-zinc-200 dark:text-black dark:border-zinc-200'
                : 'border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-500 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
            }`}
          >
            <History className="w-3.5 h-3.5" />
          </button>

          {/* Logout Button */}
          <button
            onClick={onLogout}
            title="退出登录"
            className="p-1.5 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-red dark:hover:border-swiss-red hover:text-swiss-red dark:hover:text-swiss-red transition-colors bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
