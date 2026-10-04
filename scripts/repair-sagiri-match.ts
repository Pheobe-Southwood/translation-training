import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { getExamByYear } from '../src/server/examService.js';
import { gradePvpPairTranslation } from '../src/server/deepseek.js';
import type { HistorySessionRecord, SegmentSubmission } from '../src/shared/types.js';

async function repairSagiriMatch() {
  const dbArgIdx = process.argv.indexOf('--db-path');
  const dbPath =
    dbArgIdx !== -1 && process.argv[dbArgIdx + 1]
      ? path.resolve(process.argv[dbArgIdx + 1])
      : path.resolve(process.cwd(), 'data/app.db');

  console.log(`Connecting to SQLite DB at: ${dbPath}`);
  const db = new DatabaseSync(dbPath);

  // 1. Locate Sagiri's user and match record
  const sagiriUser = db
    .prepare("SELECT * FROM users WHERE username = 'sagiri' OR nickname = 'Sagiri' LIMIT 1")
    .get() as any;

  if (!sagiriUser) {
    throw new Error('Sagiri user not found in database');
  }

  console.log(`Found Sagiri user: ${sagiriUser.nickname} (${sagiriUser.id})`);

  // Find the 2005 PVP match record for Sagiri
  const sagiriRecord = db
    .prepare("SELECT * FROM history_records WHERE user_id = ? AND type = 'pvp' AND year = 2005 ORDER BY timestamp DESC LIMIT 1")
    .get(sagiriUser.id) as any;

  if (!sagiriRecord) {
    throw new Error('Sagiri 2005 PVP match record not found');
  }

  console.log(`Found Sagiri record ID: ${sagiriRecord.id}, current score: ${sagiriRecord.total_score}`);

  // Find Opponent's record for 2005 PVP match
  const opponentRecord = db
    .prepare("SELECT * FROM history_records WHERE user_id != ? AND type = 'pvp' AND year = 2005 ORDER BY timestamp DESC LIMIT 1")
    .get(sagiriUser.id) as any;

  if (!opponentRecord) {
    throw new Error('Opponent 2005 PVP match record not found');
  }

  console.log(`Found Opponent record ID: ${opponentRecord.id} (${opponentRecord.user_id}), current score: ${opponentRecord.total_score}`);

  const exam = getExamByYear(2005);
  if (!exam) {
    throw new Error('2005 translation exam not found');
  }

  const sagiriSubmissions: SegmentSubmission[] = JSON.parse(sagiriRecord.submissions_json || '[]');
  const oppSubmissions: SegmentSubmission[] = JSON.parse(opponentRecord.submissions_json || '[]');

  console.log(`Current submissions count: Sagiri=${sagiriSubmissions.length}, Opponent=${oppSubmissions.length}`);

  // Check segments 2 and 3
  const seg2Sagiri = sagiriSubmissions.find((s) => s.segmentIndex === 2);
  const seg2Opp = oppSubmissions.find((s) => s.segmentIndex === 2);

  const seg3Sagiri = sagiriSubmissions.find((s) => s.segmentIndex === 3);
  const seg3Opp = oppSubmissions.find((s) => s.segmentIndex === 3);

  console.log('\n--- Grading Segment 3 (Index 2) with DeepSeek ---');
  console.log(`Sagiri answer: ${seg2Sagiri?.studentAnswer}`);
  console.log(`Opponent answer: ${seg2Opp?.studentAnswer}`);

  const pairResult2 = await gradePvpPairTranslation({
    fullArticle: exam.contentMarkdown,
    targetSentence: exam.translationSegments[2],
    studentAAnswer: seg2Sagiri?.studentAnswer || '',
    studentBAnswer: seg2Opp?.studentAnswer || '',
    studentAName: 'Sagiri',
    studentBName: '18570456172',
  });

  console.log(`Segment 3 Scored -> Sagiri: ${pairResult2.studentA.score}p, Opponent: ${pairResult2.studentB.score}p`);

  console.log('\n--- Grading Segment 4 (Index 3) with DeepSeek ---');
  console.log(`Sagiri answer: ${seg3Sagiri?.studentAnswer}`);
  console.log(`Opponent answer: ${seg3Opp?.studentAnswer || '（超时未作答）'}`);

  const pairResult3 = await gradePvpPairTranslation({
    fullArticle: exam.contentMarkdown,
    targetSentence: exam.translationSegments[3],
    studentAAnswer: seg3Sagiri?.studentAnswer || '',
    studentBAnswer: seg3Opp?.studentAnswer || '（超时未作答）',
    studentAName: 'Sagiri',
    studentBName: '18570456172',
  });

  console.log(`Segment 4 Scored -> Sagiri: ${pairResult3.studentA.score}p, Opponent: ${pairResult3.studentB.score}p`);

  // Update Sagiri Submissions:
  const newSagiriSubmissions: SegmentSubmission[] = [];
  const newOppSubmissions: SegmentSubmission[] = [];

  for (let idx = 0; idx < 5; idx++) {
    if (idx === 0 || idx === 1) {
      newSagiriSubmissions.push(sagiriSubmissions[idx]);
      newOppSubmissions.push(oppSubmissions[idx]);
    } else if (idx === 2) {
      newSagiriSubmissions.push({
        segmentIndex: 2,
        originalText: exam.translationSegments[2],
        studentAnswer: seg2Sagiri?.studentAnswer || '',
        gradingStatus: 'graded',
        submittedAt: seg2Sagiri?.submittedAt || Date.now(),
        gradingResult: pairResult2.studentA,
        comparativeAnalysis: pairResult2.comparativeAnalysis,
      });
      newOppSubmissions.push({
        segmentIndex: 2,
        originalText: exam.translationSegments[2],
        studentAnswer: seg2Opp?.studentAnswer || '',
        gradingStatus: 'graded',
        submittedAt: seg2Opp?.submittedAt || Date.now(),
        gradingResult: pairResult2.studentB,
        comparativeAnalysis: pairResult2.comparativeAnalysis,
      });
    } else if (idx === 3) {
      newSagiriSubmissions.push({
        segmentIndex: 3,
        originalText: exam.translationSegments[3],
        studentAnswer: seg3Sagiri?.studentAnswer || '',
        gradingStatus: 'graded',
        submittedAt: seg3Sagiri?.submittedAt || Date.now(),
        gradingResult: pairResult3.studentA,
        comparativeAnalysis: pairResult3.comparativeAnalysis,
      });
      newOppSubmissions.push({
        segmentIndex: 3,
        originalText: exam.translationSegments[3],
        studentAnswer: seg3Opp?.studentAnswer || '（超时未作答）',
        gradingStatus: 'graded',
        submittedAt: seg3Opp?.submittedAt || Date.now(),
        gradingResult: pairResult3.studentB,
        comparativeAnalysis: pairResult3.comparativeAnalysis,
      });
    } else if (idx === 4) {
      // Both timed out on question 5
      newSagiriSubmissions.push({
        segmentIndex: 4,
        originalText: exam.translationSegments[4],
        studentAnswer: '（超时未作答）',
        gradingStatus: 'graded',
        submittedAt: Date.now(),
        gradingResult: {
          score: 0,
          points_breakdown: [],
          distortion_deduction: 0,
          fluency_deduction: 0,
          critique: '该题超时未作答，得 0 分。',
          reference_translation: '',
          gradedAt: Date.now(),
        },
      });
      newOppSubmissions.push({
        segmentIndex: 4,
        originalText: exam.translationSegments[4],
        studentAnswer: '（超时未作答）',
        gradingStatus: 'graded',
        submittedAt: Date.now(),
        gradingResult: {
          score: 0,
          points_breakdown: [],
          distortion_deduction: 0,
          fluency_deduction: 0,
          critique: '该题超时未作答，得 0 分。',
          reference_translation: '',
          gradedAt: Date.now(),
        },
      });
    }
  }

  const sagiriTotal = newSagiriSubmissions.reduce((sum, s) => sum + (s.gradingResult?.score || 0), 0);
  const oppTotal = newOppSubmissions.reduce((sum, s) => sum + (s.gradingResult?.score || 0), 0);

  console.log(`\nFinal Calculated Scores: Sagiri=${sagiriTotal}, Opponent=${oppTotal}`);

  const sagiriOutcome = sagiriTotal > oppTotal ? 'win' : sagiriTotal < oppTotal ? 'loss' : 'draw';
  const oppOutcome = oppTotal > sagiriTotal ? 'win' : oppTotal < sagiriTotal ? 'loss' : 'draw';

  // Update Sagiri Record in DB
  const updateStmt = db.prepare(`
    UPDATE history_records
    SET total_score = ?,
        submissions_json = ?,
        pvp_details_json = ?
    WHERE id = ?
  `);

  updateStmt.run(
    sagiriTotal,
    JSON.stringify(newSagiriSubmissions),
    JSON.stringify({
      opponentNickname: '18570456172',
      opponentScore: oppTotal,
      outcome: sagiriOutcome,
    }),
    sagiriRecord.id
  );

  updateStmt.run(
    oppTotal,
    JSON.stringify(newOppSubmissions),
    JSON.stringify({
      opponentNickname: 'Sagiri',
      opponentScore: sagiriTotal,
      outcome: oppOutcome,
    }),
    opponentRecord.id
  );

  console.log(`\nSuccessfully updated DB records for ${sagiriRecord.id} and ${opponentRecord.id}!`);
}

repairSagiriMatch().catch((err) => {
  console.error('Repair failed:', err);
  process.exit(1);
});
