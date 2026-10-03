import { CONFIG } from './config.js';
import type { GradingResult } from '../shared/types.js';

const SYSTEM_PROMPT = `你是一位英语翻译题的阅卷老师
一、核心评分公式
单句得分 = 采分点得分（0-2分） - 整句扭曲扣分 - 通顺度扣分。
二、逐句评分细则（每句独立评分）
【采分点规则】每句切为3-4个采分点，每点0.5分。按意群给分，翻译正确一个得0.5分。
  常见采分点类型：定语从句结构、固定搭配、名词性从句、状语从句、并列结构、熟词僻义、
  被动语态转主动、非谓语动词、插入语、倒装结构、中文正确语序。
【满分（2分）条件】全部采分点正确 + 整句意思准确完整 + 表达通顺自然。
【意思扭曲扣分】若译文明显扭曲原文核心意义（主宾颠倒、肯定否定混淆、关键概念错误），
  整句最高只得0.5分（即使部分采分点正确）。
【通顺度扣分】译文生硬、翻译腔重、不符合中文表达习惯，酌情扣0-0.5分/句。
【错别字扣分（整篇累计）】整篇翻译中，错别字累计满3个扣0.5分，不满3个不扣分。
  无0.25分扣分。错别字不影响意思理解时不单独每句扣，只在篇末一次性扣除。
【多版本翻译】若一句提供两个以上译法，按得分最低的版本评分。
【漏译】重要信息漏译，对应采分点不得分。整句漏译得0分。
【卷面】书写潦草严重影响辨识，酌情扣0-0.5分。
三、得分等级参考（单句）
- 2分：全部采分点正确，意思准确，通顺。
- 1.5分：3个采分点正确，意思基本正确，较通顺。
- 1分：2个采分点正确，意思大致正确但有明显瑕疵。
- 0.5分：1个采分点正确，或写了中文但意思严重扭曲。
- 0分：空白，或完全乱译。

给分要极其严格。请通过调用指定工具返回评分结果。`;

const GRADE_TRANSLATION_TOOL = {
  type: 'function',
  function: {
    name: 'grade_translation',
    description: '提交单句翻译的阅卷打分结果',
    parameters: {
      type: 'object',
      properties: {
        score: {
          type: 'number',
          description: '最终单句得分（0, 0.5, 1.0, 1.5, 2.0），严格按照阅卷公式评定',
        },
        points_breakdown: {
          type: 'array',
          description: '3-4个采分点具体评价，每点0.5分',
          items: {
            type: 'object',
            properties: {
              point: { type: 'string', description: '采分点名称（如语法结构、固定搭配、关键词）' },
              score: { type: 'number', description: '该采分点得分（0或0.5）' },
              analysis: { type: 'string', description: '采分点评价分析' },
            },
            required: ['point', 'score', 'analysis'],
          },
        },
        distortion_deduction: {
          type: 'number',
          description: '意思扭曲扣分，未扣填0',
        },
        fluency_deduction: {
          type: 'number',
          description: '通顺度扣分（0或0.5），未扣填0',
        },
        critique: {
          type: 'string',
          description: '阅卷老师总体评价与改进建议',
        },
        reference_translation: {
          type: 'string',
          description: '官方推荐的准确流畅参考译文',
        },
      },
      required: [
        'score',
        'points_breakdown',
        'distortion_deduction',
        'fluency_deduction',
        'critique',
        'reference_translation',
      ],
    },
  },
};

const GRADE_PVP_PAIR_TOOL = {
  type: 'function',
  function: {
    name: 'grade_pvp_pair',
    description: '同时对学生A与学生B的同一句翻译进行并列评分与横向对比裁决',
    parameters: {
      type: 'object',
      properties: {
        student_a: {
          type: 'object',
          description: '学生A的评分结果',
          properties: {
            score: { type: 'number', description: '学生A单句得分（0, 0.5, 1.0, 1.5, 2.0）' },
            points_breakdown: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  point: { type: 'string' },
                  score: { type: 'number' },
                  analysis: { type: 'string' },
                },
                required: ['point', 'score', 'analysis'],
              },
            },
            distortion_deduction: { type: 'number' },
            fluency_deduction: { type: 'number' },
            critique: { type: 'string' },
          },
          required: ['score', 'points_breakdown', 'distortion_deduction', 'fluency_deduction', 'critique'],
        },
        student_b: {
          type: 'object',
          description: '学生B的评分结果',
          properties: {
            score: { type: 'number', description: '学生B单句得分（0, 0.5, 1.0, 1.5, 2.0）' },
            points_breakdown: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  point: { type: 'string' },
                  score: { type: 'number' },
                  analysis: { type: 'string' },
                },
                required: ['point', 'score', 'analysis'],
              },
            },
            distortion_deduction: { type: 'number' },
            fluency_deduction: { type: 'number' },
            critique: { type: 'string' },
          },
          required: ['score', 'points_breakdown', 'distortion_deduction', 'fluency_deduction', 'critique'],
        },
        comparative_analysis: {
          type: 'string',
          description: '双方译文横向对比与对决裁决说明（指出谁翻译更准、谁在何处有瑕疵）',
        },
        reference_translation: {
          type: 'string',
          description: '官方推荐的准确流畅参考译文',
        },
      },
      required: ['student_a', 'student_b', 'comparative_analysis', 'reference_translation'],
    },
  },
};

export async function gradeTranslation(params: {
  fullArticle: string;
  targetSentence: string;
  studentAnswer: string;
  customApiKey?: string;
}): Promise<GradingResult> {
  const apiKey = params.customApiKey || CONFIG.deepseekApiKey;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured on server');
  }

  const userContent = `全文：${params.fullArticle}\n目标句：${params.targetSentence}\n学生答案：${params.studentAnswer || '（考生未作答，空白）'}`;

  const payload = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    tools: [GRADE_TRANSLATION_TOOL],
    stream: false,
  };

  const response = await fetch(`${CONFIG.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DeepSeek API request failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0]?.message;
  if (!choice) {
    throw new Error('Invalid response structure from DeepSeek API');
  }

  // Attempt 1: Extract from tool_calls
  if (choice.tool_calls && choice.tool_calls.length > 0) {
    for (const toolCall of choice.tool_calls) {
      if (toolCall.function?.name === 'grade_translation') {
        try {
          const parsed = JSON.parse(toolCall.function.arguments);
          return normalizeGradingResult(parsed);
        } catch (err) {
          console.error('Failed to parse tool call arguments:', toolCall.function.arguments, err);
        }
      }
    }
  }

  // Attempt 2: Fallback to parsing content if model returned JSON in text
  const content = choice.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeGradingResult(parsed);
    } catch {
      // ignore
    }
  }

  return {
    score: 0.5,
    points_breakdown: [
      {
        point: '整体译文完成度',
        score: 0.5,
        analysis: 'AI未能生成完整采分明细，已提供保底分',
      },
    ],
    distortion_deduction: 0,
    fluency_deduction: 0,
    critique: content || '未能解析阅卷评语',
    reference_translation: '未能获取参考译文',
    gradedAt: Date.now(),
  };
}

export interface PvpPairGradingResult {
  studentA: GradingResult;
  studentB: GradingResult;
  comparativeAnalysis: string;
  referenceTranslation: string;
}

export async function gradePvpPairTranslation(params: {
  fullArticle: string;
  targetSentence: string;
  studentAAnswer: string;
  studentBAnswer: string;
  studentAName?: string;
  studentBName?: string;
  customApiKey?: string;
}): Promise<PvpPairGradingResult> {
  const apiKey = params.customApiKey || CONFIG.deepseekApiKey;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured on server');
  }

  const nameA = params.studentAName || '学生A';
  const nameB = params.studentBName || '学生B';

  const userContent = `全文：${params.fullArticle}\n目标句：${params.targetSentence}\n【${nameA}】答案：${params.studentAAnswer || '（考生未作答，空白）'}\n【${nameB}】答案：${params.studentBAnswer || '（考生未作答，空白）'}\n\n请严格按照阅卷规则，对${nameA}和${nameB}的译文在完全一致的尺度下进行并列逐点采分，并通过调用 grade_pvp_pair 工具返回两人各自的采分结果、扣分明细与横向对比裁决。`;

  const payload = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    tools: [GRADE_PVP_PAIR_TOOL],
    stream: false,
  };

  const response = await fetch(`${CONFIG.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DeepSeek API PVP pair request failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0]?.message;
  if (!choice) {
    throw new Error('Invalid response structure from DeepSeek API');
  }

  if (choice.tool_calls && choice.tool_calls.length > 0) {
    for (const toolCall of choice.tool_calls) {
      if (toolCall.function?.name === 'grade_pvp_pair') {
        try {
          const parsed = JSON.parse(toolCall.function.arguments);
          const ref = String(parsed.reference_translation || '');
          const comparative = String(parsed.comparative_analysis || '');

          const resA = normalizeGradingResult({
            ...parsed.student_a,
            reference_translation: ref,
          });
          const resB = normalizeGradingResult({
            ...parsed.student_b,
            reference_translation: ref,
          });

          return {
            studentA: resA,
            studentB: resB,
            comparativeAnalysis: comparative,
            referenceTranslation: ref,
          };
        } catch (err) {
          console.error('Failed to parse grade_pvp_pair arguments:', toolCall.function.arguments, err);
        }
      }
    }
  }

  // Fallback to separate gradings if tool call missed
  console.warn('[PVP Pair] Tool call not detected, falling back to sequential grading');
  const [resA, resB] = await Promise.all([
    gradeTranslation({
      fullArticle: params.fullArticle,
      targetSentence: params.targetSentence,
      studentAnswer: params.studentAAnswer,
      customApiKey: apiKey,
    }),
    gradeTranslation({
      fullArticle: params.fullArticle,
      targetSentence: params.targetSentence,
      studentAnswer: params.studentBAnswer,
      customApiKey: apiKey,
    }),
  ]);

  return {
    studentA: resA,
    studentB: resB,
    comparativeAnalysis: '双方各自完成独立阅卷评分。',
    referenceTranslation: resA.reference_translation || resB.reference_translation || '',
  };
}

function normalizeGradingResult(raw: any): GradingResult {
  const score = Math.max(0, Math.min(2, typeof raw.score === 'number' ? raw.score : 0));
  const points = Array.isArray(raw.points_breakdown)
    ? raw.points_breakdown.map((p: any) => ({
        point: String(p.point || '采分点'),
        score: typeof p.score === 'number' ? Math.max(0, Math.min(0.5, p.score)) : 0,
        analysis: String(p.analysis || ''),
      }))
    : [];

  return {
    score: Math.round(score * 2) / 2, // Round to nearest 0.5
    points_breakdown: points,
    distortion_deduction: typeof raw.distortion_deduction === 'number' ? raw.distortion_deduction : 0,
    fluency_deduction: typeof raw.fluency_deduction === 'number' ? raw.fluency_deduction : 0,
    critique: String(raw.critique || '暂无评语'),
    reference_translation: String(raw.reference_translation || ''),
    gradedAt: Date.now(),
  };
}
