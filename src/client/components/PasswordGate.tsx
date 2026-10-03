import React, { useState, useRef, useEffect } from 'react';
import { Lock, ArrowRight, ShieldCheck, User, KeyRound, Sparkles, AlertCircle } from 'lucide-react';
import type { AuthUser } from '../../shared/types.js';
import { setAuthToken, setStoredUser } from '../utils/storage.js';

interface PasswordGateProps {
  onSuccess: (user: AuthUser) => void;
}

export const PasswordGate: React.FC<PasswordGateProps> = ({ onSuccess }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const usernameInputRef = useRef<HTMLInputElement>(null);
  const invitationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'login') {
      usernameInputRef.current?.focus();
    } else if (mode === 'register' && infoMessage) {
      invitationInputRef.current?.focus();
    }
  }, [mode, infoMessage]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入账号和密码');
      return;
    }

    setLoading(true);
    setError(null);
    setInfoMessage(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success && data.token) {
        setAuthToken(data.token);
        if (data.user) {
          setStoredUser(data.user);
        }
        onSuccess(data.user);
        return;
      }

      // Check if user was not found -> Automatically switch to registration mode!
      if (res.status === 404 || data.code === 'USER_NOT_FOUND') {
        setMode('register');
        setInfoMessage(`未查询到账号「${username.trim()}」，已自动为您切换至注册。请输入邀请码完成激活。`);
        setError(null);
        setTimeout(() => {
          invitationInputRef.current?.focus();
        }, 50);
        return;
      }

      setError(data.error || '登录失败，请检查账号密码');
    } catch {
      setError('网络连接错误，请检查服务端连接');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入账号和密码');
      return;
    }
    if (!invitationCode.trim()) {
      setError('请输入系统邀请码以激活账号');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
          invitationCode: invitationCode.trim(),
          nickname: nickname.trim() || username.trim(),
        }),
      });

      const data = await res.json();

      if (res.ok && data.success && data.token) {
        setAuthToken(data.token);
        if (data.user) {
          setStoredUser(data.user);
        }
        onSuccess(data.user);
      } else {
        setError(data.error || '注册失败，请检查填写内容');
      }
    } catch {
      setError('网络连接错误，请检查服务端连接');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-swiss-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-white border-2 border-swiss-black shadow-[8px_8px_0px_0px_#09090b] p-6 sm:p-8">
        {/* Top Header */}
        <div className="flex items-center justify-between pb-4 border-b-2 border-swiss-black mb-5">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-swiss-red text-white flex items-center justify-center font-bold text-sm">
              +
            </div>
            <span className="font-mono text-xs uppercase tracking-widest font-bold">
              AUTH GATE // 账号通行证
            </span>
          </div>
          <span className="px-2 py-0.5 bg-zinc-100 border border-zinc-300 font-mono text-[10px] text-zinc-600">
            PORT:8888
          </span>
        </div>

        {/* Tab Switcher */}
        <div className="grid grid-cols-2 gap-2 mb-5 font-mono text-xs">
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
              setInfoMessage(null);
            }}
            className={`py-2 text-center font-bold border transition-colors ${
              mode === 'login'
                ? 'bg-swiss-black text-white border-swiss-black'
                : 'bg-zinc-50 text-zinc-600 border-zinc-300 hover:border-swiss-black'
            }`}
          >
            账号登录
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setError(null);
            }}
            className={`py-2 text-center font-bold border transition-colors ${
              mode === 'register'
                ? 'bg-swiss-black text-white border-swiss-black'
                : 'bg-zinc-50 text-zinc-600 border-zinc-300 hover:border-swiss-black'
            }`}
          >
            注册新账号
          </button>
        </div>

        {/* Auto-Jump Notice Banner */}
        {infoMessage && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-300 text-amber-900 text-xs font-mono flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <span className="leading-relaxed">{infoMessage}</span>
          </div>
        )}

        {/* Form Container */}
        {mode === 'login' ? (
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1 text-zinc-700">
                账号 (USERNAME)
              </label>
              <div className="relative">
                <input
                  type="text"
                  ref={usernameInputRef}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="请输入您的账号"
                  autoFocus
                  className="w-full border-2 border-swiss-black px-3 py-2 font-mono text-sm focus:outline-none focus:bg-zinc-50 transition-colors placeholder:text-zinc-400"
                />
                <div className="absolute right-3 top-2.5 text-zinc-400">
                  <User className="w-4 h-4" />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1 text-zinc-700">
                密码 (PASSWORD)
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  className="w-full border-2 border-swiss-black px-3 py-2 font-mono text-sm focus:outline-none focus:bg-zinc-50 transition-colors placeholder:text-zinc-400"
                />
                <div className="absolute right-3 top-2.5 text-zinc-400">
                  <Lock className="w-4 h-4" />
                </div>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-300 text-red-700 text-xs font-mono">
                [ERROR] {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-swiss-black hover:bg-swiss-red text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <span>正在验证登录...</span>
              ) : (
                <>
                  <span>登录系统</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
            <p className="text-[11px] font-mono text-zinc-400 text-center">
              * 若输入未注册账号，系统将自动跳转至注册并保留输入
            </p>
          </form>
        ) : (
          <form onSubmit={handleRegisterSubmit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1 text-zinc-700">
                账号 (USERNAME)
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="设置账号 (2-24字符)"
                className="w-full border-2 border-swiss-black px-3 py-2 font-mono text-sm focus:outline-none focus:bg-zinc-50 transition-colors placeholder:text-zinc-400"
              />
            </div>

            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1 text-zinc-700">
                设置密码 (PASSWORD)
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="设置密码 (不少于4位)"
                className="w-full border-2 border-swiss-black px-3 py-2 font-mono text-sm focus:outline-none focus:bg-zinc-50 transition-colors placeholder:text-zinc-400"
              />
            </div>

            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1 text-zinc-700 flex items-center justify-between">
                <span>系统邀请码 (INVITATION CODE)</span>
                <span className="text-swiss-red font-bold text-[10px]">* 必填以激活</span>
              </label>
              <div className="relative">
                <input
                  type="password"
                  ref={invitationInputRef}
                  value={invitationCode}
                  onChange={(e) => setInvitationCode(e.target.value)}
                  placeholder="请输入系统邀请码"
                  className="w-full border-2 border-swiss-black px-3 py-2 font-mono text-sm focus:outline-none focus:bg-zinc-50 transition-colors placeholder:text-zinc-400"
                />
                <div className="absolute right-3 top-2.5 text-zinc-400">
                  <KeyRound className="w-4 h-4" />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1 text-zinc-700">
                对战昵称 (NICKNAME - 选填)
              </label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="默认为您的账号名"
                className="w-full border-2 border-swiss-black px-3 py-2 font-mono text-sm focus:outline-none focus:bg-zinc-50 transition-colors placeholder:text-zinc-400"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-300 text-red-700 text-xs font-mono">
                [ERROR] {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-swiss-red hover:bg-rose-700 text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <span>正在注册激活...</span>
              ) : (
                <>
                  <span>立即激活并登录</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
            <p className="text-[11px] font-mono text-zinc-500 text-center">
              无有效邀请码无法激活，以此杜绝未经许可的额度消耗
            </p>
          </form>
        )}

        {/* Footer info */}
        <div className="mt-6 pt-4 border-t border-zinc-200 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
          <span className="flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> 线上数据持久加密
          </span>
          <span>DEEPSEEK HIGH REASONING</span>
        </div>
      </div>
    </div>
  );
};
