#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible mock used by GitHub Actions E2E.
 * It never calls a real model and never needs an API key.
 */
import http from 'http';

const PORT = Number(process.env.MOCK_PORT || 8899);

function points() {
  return [
    { point: '主干命题与指代', score: 0.5, analysis: 'Mock: 主干信息完整。' },
    { point: '逻辑关系', score: 0.5, analysis: 'Mock: 逻辑关系准确。' },
    { point: '关键术语与搭配', score: 0.5, analysis: 'Mock: 术语处理正确。' },
    { point: '修饰、时态与范围', score: 0.5, analysis: 'Mock: 修饰与范围完整。' },
  ];
}

function single(reference = 'Mock reference translation') {
  return {
    score: 2,
    points_breakdown: points(),
    distortion_deduction: 0,
    fluency_deduction: 0,
    critique: 'Mock 阅卷：信息完整，语法正确，表达自然。',
    reference_translation: reference,
  };
}

function pair(reference = 'Mock reference translation') {
  return {
    student_a: single(reference),
    student_b: single(reference),
    comparative_analysis: 'Mock 并列评分：双方信息完整、表达准确，本句同分。',
    reference_translation: reference,
  };
}

function toolResponse(name, args) {
  return {
    id: `mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${Math.random().toString(36).slice(2, 10)}`,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 128, completion_tokens: 128, total_tokens: 256 },
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');
      const toolName = payload.tools?.[0]?.function?.name || 'grade_translation';
      const userContent = payload.messages?.find((m) => m.role === 'user')?.content || '';
      const reference =
        /英文参考译文（标准答案）：([^\n]+)/.exec(userContent)?.[1] ||
        /Mock reference translation/.exec(userContent)?.[0] ||
        'Mock reference translation';

      const args = toolName === 'grade_pvp_pair' ? pair(reference) : single(reference);
      const response = toolResponse(toolName, args);

      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      }, 150);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-deepseek] listening on http://127.0.0.1:${PORT}`);
});
