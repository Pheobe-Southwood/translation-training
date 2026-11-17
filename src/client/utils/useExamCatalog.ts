import { useEffect, useState } from 'react';
import type { ExamBank, ExamCatalogEntry, TranslationDirection } from '../../shared/types.js';
import {
  entriesForYear,
  fetchAllExamCatalogs,
  inferBankFromExamId,
  isEnZhOnlyBank,
  pickUnitForYear,
  resolveInitialSelection,
  uniqueYears,
} from './exams.js';

const EMPTY_CATALOGS: Record<ExamBank, ExamCatalogEntry[]> = {
  translation: [],
  cloze: [],
  reading: [],
};

export interface ExamCatalogModel {
  catalogs: Record<ExamBank, ExamCatalogEntry[]>;
  bank: ExamBank;
  years: number[];
  selectedYear: number | null;
  unitEntries: ExamCatalogEntry[];
  selectedEntry: ExamCatalogEntry | null;
  enZhOnly: boolean;
  effectiveDirection: TranslationDirection;
  loading: boolean;
  selectBank: (nextBank: ExamBank) => void;
  selectYear: (year: number) => void;
  selectUnit: (examId: string) => void;
  selectRandom: () => void;
}

/**
 * Catalog fetch + paper-picker state shared by the homepage and the PVP lobby.
 *
 * `enabled` lets the lobby skip the fetch for read-only link spectators, who
 * never see the picker.
 */
export function useExamCatalog(
  initialExamId: string | undefined,
  direction: TranslationDirection,
  enabled = true
): ExamCatalogModel {
  const [catalogs, setCatalogs] = useState<Record<ExamBank, ExamCatalogEntry[]>>(EMPTY_CATALOGS);
  const [bank, setBank] = useState<ExamBank>(() => inferBankFromExamId(initialExamId));
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetchAllExamCatalogs().then((loaded) => {
      if (cancelled) return;
      setCatalogs(loaded);
      const selection = resolveInitialSelection(loaded, initialExamId);
      if (selection) {
        setBank(selection.bank);
        setSelectedYear(selection.year);
        setSelectedUnitId(selection.examId);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, initialExamId]);

  const bankEntries = catalogs[bank];
  const years = uniqueYears(bankEntries);
  const unitEntries = entriesForYear(bankEntries, selectedYear);
  const selectedEntry = pickUnitForYear(bankEntries, selectedYear, selectedUnitId);
  const enZhOnly = isEnZhOnlyBank(bank);
  const effectiveDirection: TranslationDirection = enZhOnly ? 'en-zh' : direction;

  const selectBank = (nextBank: ExamBank) => {
    setBank(nextBank);
    const nextEntries = catalogs[nextBank];
    const nextYears = uniqueYears(nextEntries);
    const nextYear =
      selectedYear !== null && nextYears.includes(selectedYear) ? selectedYear : nextYears[0] ?? null;
    setSelectedYear(nextYear);
    setSelectedUnitId(entriesForYear(nextEntries, nextYear)[0]?.examId ?? null);
  };

  const selectYear = (year: number) => {
    setSelectedYear(year);
    setSelectedUnitId(entriesForYear(bankEntries, year)[0]?.examId ?? null);
  };

  const selectUnit = (examId: string) => setSelectedUnitId(examId);

  const selectRandom = () => {
    if (bankEntries.length === 0) return;
    const random = bankEntries[Math.floor(Math.random() * bankEntries.length)];
    setSelectedYear(random.year);
    setSelectedUnitId(random.examId);
  };

  return {
    catalogs,
    bank,
    years,
    selectedYear,
    unitEntries,
    selectedEntry,
    enZhOnly,
    effectiveDirection,
    loading,
    selectBank,
    selectYear,
    selectUnit,
    selectRandom,
  };
}
