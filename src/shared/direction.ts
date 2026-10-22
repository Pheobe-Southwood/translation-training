import type { TranslationDirection } from './types.js';

export const DEFAULT_DIRECTION: TranslationDirection = 'en-zh';

export const TRANSLATION_DIRECTIONS: TranslationDirection[] = ['en-zh', 'zh-en'];

/** Strict parser for API/room payloads. Returns null for anything unrecognised. */
export function parseDirection(value: unknown): TranslationDirection | null {
  if (value === 'en-zh' || value === 'zh-en') return value;
  return null;
}

/** Client-side normalizer: old sessions and old records fall back to English→Chinese. */
export function normalizeDirection(value: unknown): TranslationDirection {
  return parseDirection(value) || DEFAULT_DIRECTION;
}

export function directionLabel(direction: TranslationDirection): string {
  return direction === 'zh-en' ? '中译英' : '英译中';
}

/** Compact badge used in the HUD and history list. */
export function directionShort(direction: TranslationDirection): string {
  return direction === 'zh-en' ? '中 → EN' : 'EN → 中';
}

export function sourceLanguageLabel(direction: TranslationDirection): string {
  return direction === 'zh-en' ? '中文' : '英文';
}

export function targetLanguageLabel(direction: TranslationDirection): string {
  return direction === 'zh-en' ? '英文' : '中文';
}

export function isZhEn(direction: TranslationDirection): boolean {
  return direction === 'zh-en';
}
