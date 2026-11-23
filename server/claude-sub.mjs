// Claude 구독(Pro/Max)으로 호출 — CLAUDE_AUTH=subscription.
// claude-agent-sdk 가 이 맥의 claude CLI(Claude Code)를 띄워 `claude` 로그인 계정의 구독 한도로 처리한다.
// API 키는 CLI 에 넘기지 않는다(키가 있으면 CLI 가 API 과금으로 돈다). 호출마다 CLI 를 띄우므로 약 3초 더 걸린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const useSubscription = () => process.env.CLAUDE_AUTH === 'subscription';

const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...baseEnv } = process.env;
let cwd = null; // 사용자 설정(~/.claude 의 CLAUDE.md·MCP·훅)을 읽지 않도록 빈 폴더에서 실행
const workDir = () => (cwd ??= fs.mkdtempSync(path.join(os.tmpdir(), 'jin-3d-claude-')));

// 이 프로젝트 도구 스키마에 쓰는 JSON Schema 부분집합 → zod (string/enum, number, boolean, anyOf, object)
function toZod(s) {
  if (s.anyOf) return z.union(s.anyOf.map(toZod));
  if (s.enum) return z.enum(s.enum);
  const base = { string: z.string(), number: z.number(), boolean: z.boolean(), null: z.null() }[s.type];
  if (!base) throw new Error(`지원하지 않는 스키마 형식: ${JSON.stringify(s)}`);
  return s.description ? base.describe(s.description) : base;
}
export const zodShape = (objSchema) => Object.fromEntries(Object.entries(objSchema.properties).map(([k, v]) => [k, toZod(v)]));

/** 앱 도구 목록 [{name, description, input_schema, run(input) → 결과 문자열 | {error}}] → 구독 호출용 MCP 서버 */
export function toolServer(name, tools) {
  return createSdkMcpServer({
    name,
    tools: tools.map((t) => tool(t.name, t.description, zodShape(t.input_schema), async (input) => {
      const out = await t.run(input);
      return typeof out === 'string'
        ? { content: [{ type: 'text', text: out }] }
        : { content: [{ type: 'text', text: out.error }], isError: true };
    })),
  });
}

/**
 * 한 번의 구독 호출. content: 문자열 또는 콘텐츠 블록 배열(text/image/document).
 * @returns {{ text, structured, model, stopReason, usage }}
 */
export async function runClaude({ system, content, model, effort, schema, servers = {}, maxTurns }) {
  const allowedTools = Object.keys(servers).map((n) => `mcp__${n}__*`);
  const prompt = typeof content === 'string' ? content : (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
  })();
  let result = null, modelUsed = model;
  for await (const m of query({
    prompt,
    options: {
      systemPrompt: system,
      model,
      effort,
      tools: [], // Claude Code 내장 도구(Bash·Read 등)는 쓰지 않는다
      mcpServers: servers,
      allowedTools,
      permissionMode: 'dontAsk',
      settingSources: [],
      maxTurns: maxTurns ?? (allowedTools.length ? 8 : 4),
      outputFormat: schema ? { type: 'json_schema', schema } : undefined,
      env: { ...baseEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'jin-3d' },
      cwd: workDir(),
    },
  })) {
    if (m.type === 'assistant' && m.message?.model) modelUsed = m.message.model;
    if (m.type === 'result') result = m;
  }
  if (!result) throw new Error('Claude 구독 호출이 결과 없이 끝났습니다');
  if (result.is_error && result.subtype !== 'error_max_turns') {
    const detail = result.result || (result.errors ?? []).join(', ') || result.subtype;
    if (/usage limit|rate limit/i.test(detail)) throw Object.assign(new Error(`Claude 구독 사용 한도 초과 — 한도가 풀린 뒤 재시도 (${detail})`), { status: 429 });
    if (/login|auth/i.test(detail)) throw Object.assign(new Error('Claude Code 로그인이 필요합니다 — 터미널에서 `claude` 실행 후 /login'), { status: 401 });
    throw new Error(`Claude 구독 호출 실패 (${result.subtype}): ${detail}`);
  }
  const u = result.usage ?? {};
  return {
    text: (result.result ?? '').trim(),
    structured: result.structured_output ?? null,
    model: modelUsed,
    stopReason: result.stop_reason ?? null,
    maxTurnsHit: result.subtype === 'error_max_turns',
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}
