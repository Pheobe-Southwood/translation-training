import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { TranslationExam } from '../shared/types.js';

let cachedExams: TranslationExam[] = [];

function loadExams(): TranslationExam[] {
  if (cachedExams.length > 0) return cachedExams;

  // Locate exams.json
  const possiblePaths = [
    path.resolve(process.cwd(), 'src/shared/data/exams.json'),
    path.resolve(process.cwd(), 'dist/shared/data/exams.json'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/data/exams.json'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        cachedExams = JSON.parse(raw);
        console.log(`Loaded ${cachedExams.length} translation exams from ${p}`);
        return cachedExams;
      } catch (err) {
        console.error(`Error parsing exams from ${p}:`, err);
      }
    }
  }

  throw new Error('Unable to find or load exams.json');
}

export function getAllExams(): TranslationExam[] {
  return loadExams();
}

export function getExamYears(): number[] {
  return loadExams().map((e) => e.year).sort((a, b) => b - a); // Newest first
}

export function getExamByYear(year: number): TranslationExam | undefined {
  return loadExams().find((e) => e.year === year);
}

export function getRandomExam(): TranslationExam {
  const exams = loadExams();
  const index = Math.floor(Math.random() * exams.length);
  return exams[index];
}
