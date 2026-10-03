import React from 'react';
import { History, LogOut, Swords, User } from 'lucide-react';

interface SwissHeaderProps {
  currentView: string;
  onNavigate: (view: 'home' | 'solo' | 'pvp-lobby' | 'history') => void;
  nickname: string;
  username?: string;
  onChangeNickname: () => void;
  onLogout: () => void;
}

export const SwissHeader: React.FC<SwissHeaderProps> = ({
  currentView,
  onNavigate,
  nickname,
  username,
  onChangeNickname,
  onLogout,
}) => {
  return (
    <header className="border-b-2 border-swiss-black bg-white sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo and Brand */}
        <div 
          onClick={() => onNavigate('home')} 
          className="flex items-center gap-3 cursor-pointer group"
        >
          <div className="w-8 h-8 bg-swiss-red flex items-center justify-center font-bold text-white text-lg transition-transform group-hover:scale-105">
            +
          </div>
          <div>
            <div className="font-extrabold tracking-tighter text-lg leading-tight uppercase font-mono">
              TRANSLATION TRAINING
            </div>
            <div className="text-[10px] uppercase tracking-widest text-swiss-subtle font-mono">
              考研英语一 // 翻译竞技场
            </div>
          </div>
        </div>

        {/* Center navigation hints */}
        <div className="hidden md:flex items-center gap-6 font-mono text-xs uppercase font-semibold">
          <button
            onClick={() => onNavigate('home')}
            className={`px-3 py-1.5 border transition-all ${
              currentView === 'home'
                ? 'bg-swiss-black text-white border-swiss-black'
                : 'border-transparent hover:border-swiss-black text-swiss-black'
            }`}
          >
            首页导航
          </button>
          <button
            onClick={() => onNavigate('pvp-lobby')}
            className={`px-3 py-1.5 border flex items-center gap-1.5 transition-all ${
              currentView === 'pvp-lobby' || currentView === 'pvp-match'
                ? 'bg-swiss-red text-white border-swiss-red'
                : 'border-transparent hover:border-swiss-black text-swiss-black'
            }`}
          >
            <Swords className="w-3.5 h-3.5" />
            PVP 对战
          </button>
          <button
            onClick={() => onNavigate('history')}
            className={`px-3 py-1.5 border flex items-center gap-1.5 transition-all ${
              currentView === 'history'
                ? 'bg-swiss-black text-white border-swiss-black'
                : 'border-transparent hover:border-swiss-black text-swiss-black'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            练习档案
          </button>
        </div>

        {/* Right User Bar */}
        <div className="flex items-center gap-3 font-mono text-xs">
          <button
            onClick={onChangeNickname}
            title={username ? `账号: @${username} (点击修改昵称)` : '修改昵称'}
            className="flex items-center gap-1.5 px-2.5 py-1.5 border border-zinc-300 hover:border-swiss-black transition-colors bg-zinc-50"
          >
            <User className="w-3.5 h-3.5 text-swiss-subtle" />
            <span className="font-bold max-w-[100px] truncate">{nickname}</span>
          </button>

          <button
            onClick={() => onNavigate('history')}
            title="历史记录"
            className="p-1.5 border border-zinc-300 hover:border-swiss-black transition-colors md:hidden"
          >
            <History className="w-4 h-4" />
          </button>

          <button
            onClick={onLogout}
            title="退出登录"
            className="p-1.5 border border-zinc-300 hover:border-swiss-red hover:text-swiss-red transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
