// 대화 기반 Agent 호출 경로 검증 — 실제 Claude API · 구독 호출 없이 가짜 응답을 넣어 본다. 실행: npm test
// ① 공용 코어(js/agentcore.js): 도구 호출 → 스냅샷 검증 → 승인/반려 · 비용 계산
// ② 서버 API 키 경로(server/llm-agent.mjs runAgentTurn) · ③ 구독 경로(runAgentTurnSub → claude-sub.mjs: 도구 → MCP 서버, API 키를 CLI에 넘기지 않음, 오류 상태 전달)
// ④ 웹 버전(서버 없음) 브라우저 직접 호출(js/llm.js: 키 저장 · 연결 방식 · 오류 문구) · ⑤ AIOS 업로드 재시도 · ⑥ 사용자 가이드 PDF 경로
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runAgentTurn as runCore, buildTools, validate, MODEL, PRICE } from '../js/agentcore.js';
import { buildAiosZip } from '../js/aios.js';
import { Simulation } from '../js/sim.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-webagent-'));

const snapshot = { stations: [{ id: 'SORT', state: 'BUSY', health: 90, request: null, inspect: false }, { id: 'PACK', state: 'BUSY', health: 40, request: null, inspect: true }], material: { supply_disrupted_remaining_s: 0, expedited: false }, product_mix: '1:1' };
const payload = { snapshot, trigger: '운영자 지시 해석', urgent: true, operatorMessage: '포장 쪽 조금 천천히', history: [{ t: '08:00:00', who: '운영자', text: '포장 쪽 조금 천천히' }] };
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
// 가짜 Messages API: 첫 응답에서 도구 3개(승인 1 · 반려 2), 둘째 응답에서 마무리 문장
const fakeCreate = (seen = []) => async (p) => {
  seen.push(p);
  const u = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (seen.length === 1) return { model: 'fake-model', stop_reason: 'tool_use', usage: u, content: [{ type: 'text', text: '확인 중' },
    use('t1', 'issue_command', { code: 'SPEED', target: 'PACK', arg: 75, reason: '운영자 지시' }), use('t2', 'issue_command', { code: 'SPEED', target: 'PACK', arg: 500, reason: '범위 밖' }), use('t3', 'expedite_supply', { reason: '차질 없음' })] };
  return { model: 'fake-model', stop_reason: 'end_turn', usage: u, content: [{ type: 'text', text: '포장셀 속도를 75%로 낮췄습니다.' }] };
};

console.log('== 공용 코어 (js/agentcore.js)');
{
  const seen = [], out = await runCore(fakeCreate(seen), payload);
  check('도구 승인 1 · 반려 2 · 마무리 문장', out.actions.length === 1 && out.actions[0].input.arg === 75 && out.rejected.length === 2 && out.text.includes('75%') && out.stopReason === 'end_turn', `${out.actions.length}/${out.rejected.length}`);
  const tr = seen[1].messages.at(-1).content;
  check('반려 사유를 도구 결과로 돌려줌', tr.length === 3 && !tr[0].is_error && tr[1].is_error && /30~120/.test(tr[1].content) && /차질이 없음/.test(tr[2].content));
  check('요청: 모델 · 설비 ID로 만든 도구 · 지시 문장', seen[0].model === MODEL && seen[0].tools.find((t) => t.name === 'issue_command').input_schema.properties.target.enum.join() === 'all,SORT,PACK' && seen[0].messages[0].content.includes('포장 쪽 조금 천천히'));
  check('비용 = 토큰 × 단가', Math.abs(out.costUSD - (2000 * PRICE.input + 200 * PRICE.output) / 1e6) < 1e-12, String(out.costUSD));
  check('다른 Zone 도구는 없음 (단일 Zone)', !buildTools(['PACK']).some((t) => t.name === 'zone_command') && validate('zone_command', {}, snapshot, new Set()) === '알 수 없는 도구');
}

console.log('== 서버 API 키 경로 (server/llm-agent.mjs)');
{
  const { runAgentTurn } = await import('../server/llm-agent.mjs');
  const seen = [], create = fakeCreate(seen), out = await runAgentTurn({ beta: { messages: { create } } }, payload);
  check('SDK 클라이언트로 같은 결과', out.actions.length === 1 && out.rejected.length === 2 && seen.length === 2 && out.model === 'fake-model');
}

console.log('== 구독 경로 (CLAUDE_AUTH=subscription · claude CLI 대신 가짜 SDK)');
{
  // claude-agent-sdk 를 가짜로 바꾼다: query()가 넘겨받은 MCP 도구를 직접 불러 보고 결과를 낸다 (실제 CLI · 계정은 쓰지 않음)
  const fake = `export const tool = (name, description, shape, handler) => ({ name, description, shape, handler });
export const createSdkMcpServer = ({ name, tools }) => ({ type: 'sdk', name, tools });
export const query = (a) => globalThis.__fakeQuery(a);`;
  registerHooks({ resolve: (spec, ctx, next) => (spec === '@anthropic-ai/claude-agent-sdk' ? { url: 'data:text/javascript,' + encodeURIComponent(fake), shortCircuit: true } : next(spec, ctx)) });
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key'; process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
  process.env.CLAUDE_AUTH = 'subscription';
  let got = null, mode = 'ok';
  globalThis.__fakeQuery = async function* ({ prompt, options }) {
    got = { prompt, options };
    if (mode !== 'ok') { yield { type: 'result', is_error: true, subtype: 'error_during_execution', result: mode }; return; }
    const tools = options.mcpServers.factory.tools, call = async (name, input) => { const t = tools.find((x) => x.name === name); return t.handler(z.object(t.shape).parse(input)); };
    got.r1 = await call('issue_command', { code: 'SPEED', target: 'PACK', arg: 75, reason: '운영자 지시' });
    got.r2 = await call('issue_command', { code: 'MAINT', target: 'all', arg: null, reason: '셀 미지정' });
    got.r3 = await call('schedule_maintenance', { station_id: 'PACK', kind: 'cal', reason: '검사 공정' });
    yield { type: 'assistant', message: { model: 'fake-sub-model' } };
    yield { type: 'result', is_error: false, subtype: 'success', result: ' 포장셀 속도를 75%로 낮췄습니다. ', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const { runAgentTurnSub } = await import('../server/llm-agent.mjs');
  const out = await runAgentTurnSub(payload);
  check('도구 정의 → MCP 서버(factory) · 내장 도구 없음 · 묻지 않음', got.options.mcpServers.factory.name === 'factory' && got.options.allowedTools.join() === 'mcp__factory__*' && got.options.tools.length === 0 && got.options.permissionMode === 'dontAsk' && got.options.settingSources.length === 0 && got.options.maxTurns === 6);
  check('도구 목록 그대로 · 스키마 변환', got.options.mcpServers.factory.tools.map((t) => t.name).join() === buildTools(['SORT', 'PACK']).map((t) => t.name).join(), got.options.mcpServers.factory.tools.map((t) => t.name).join());
  check('승인 → 조치 · 반려 → isError와 사유', out.actions.length === 1 && out.actions[0].input.arg === 75 && out.rejected.length === 2 && !got.r1.isError && got.r2.isError && /셀을 지정/.test(got.r2.content[0].text) && /보정 대상이 아님/.test(got.r3.content[0].text));
  check('API 키 · 토큰을 CLI 환경에 넘기지 않음', !('ANTHROPIC_API_KEY' in got.options.env) && !('ANTHROPIC_AUTH_TOKEN' in got.options.env) && got.options.env.CLAUDE_AGENT_SDK_CLIENT_APP === 'jin-3d');
  check('결과 모양: 문장 · 모델 · 비용 0 · 사용량', out.text === '포장셀 속도를 75%로 낮췄습니다.' && out.model === 'fake-sub-model' && out.costUSD === 0 && out.usage.input_tokens === 10 && out.stopReason === 'end_turn');
  check('지침 · 입력 · 판단 강도', got.options.systemPrompt.includes('역할 분담') && got.prompt.includes('포장 쪽 조금 천천히') && got.options.effort === 'medium' && got.options.model === MODEL);

  // 실제 서버 /api/agent — 구독이면 키 없이 동작하고, 구독 오류 상태(429 · 401)를 그대로 돌려준다
  process.env.JIN3D_DATA_DIR = path.join(tmp, 'data');
  const { startServer, hasApiKey } = await import('../server/app-server.mjs');
  const { port, server } = await startServer({ port: 0 });
  const call = (p, method = 'GET', body = null) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, (res) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ code: res.statusCode, type: res.headers['content-type'], text: Buffer.concat(b).toString() })); });
    r.on('error', reject); r.end(body);
  });
  const log = console.log; console.log = () => {};
  try {
    const st = JSON.parse((await call('/api/status')).text);
    const ok = await call('/api/agent', 'POST', JSON.stringify(payload)), j = JSON.parse(ok.text);
    console.log = log;
    check('구독 모드: 키 없이 Agent 사용 가능 (/api/status llm)', hasApiKey() === true && st.llm === true);
    check('/api/agent → 구독 경로 결과', ok.code === 200 && j.actions.length === 1 && j.rejected.length === 2 && j.costUSD === 0 && j.latencyMs >= 0, `${ok.code}`);
    console.log = () => {};
    mode = 'Claude usage limit reached'; const lim = await call('/api/agent', 'POST', JSON.stringify(payload));
    mode = 'Invalid API key · Please run /login'; const auth = await call('/api/agent', 'POST', JSON.stringify(payload));
    mode = 'boom'; const etc = await call('/api/agent', 'POST', JSON.stringify(payload));
    console.log = log;
    check('사용 한도 → 429 · 로그인 필요 → 401 · 그 밖 → 502', lim.code === 429 && /한도/.test(JSON.parse(lim.text).error) && auth.code === 401 && /로그인/.test(JSON.parse(auth.text).error) && etc.code === 502, [lim.code, auth.code, etc.code].join(','));

    console.log('== 사용자 가이드 PDF 경로 (docs/USER_GUIDE.pdf 하나만 공개)');
    const has = fs.existsSync(path.join(root, 'docs/USER_GUIDE.pdf')), g = await call('/docs/USER_GUIDE.pdf', 'HEAD'), other = await call('/docs/AAS_SCHEMA.md'), up = await call('/docs/../.env.example');
    check(has ? '파일이 있음 → 200 · application/pdf' : '파일이 없음 → 404 (화면은 버튼을 숨김)', has ? g.code === 200 && g.type === 'application/pdf' : g.code === 404, `${g.code} ${g.type}`);
    check('docs의 다른 파일 · 상위 경로는 내주지 않음', other.code === 404 && up.code === 404, `${other.code},${up.code}`);
  } finally { console.log = log; server.close(); delete process.env.CLAUDE_AUTH; delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; }
}

console.log('== 웹 버전 (서버 없음) — 브라우저에서 API 키로 직접 호출');
{
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size }; };
  globalThis.window = { JIN3D_NO_SERVER: true }; globalThis.sessionStorage = store(); globalThis.localStorage = store();
  const { LLMController, serverless, browserKey, browserKeyKept } = await import('../js/llm.js');
  const ctl = new LLMController();
  let fetched = 0; const realFetch = globalThis.fetch; globalThis.fetch = async () => { fetched++; throw new Error('서버 없음'); };
  try {
    await ctl.probe();
    check('키 없음 → 미연결 · 서버에 묻지 않음', serverless() && !ctl.available && ctl.provider === null && fetched === 0);
    const bad = await ctl.setBrowserKey('abc', false);
    check('키 형식 검사 (sk-ant-)', !bad.ok && /sk-ant-/.test(bad.error) && !browserKey());
    await ctl.setBrowserKey(' sk-ant-test-not-a-real-key ', false);
    check('탭에만 저장(sessionStorage) → 연결 방식 key · 공정 설계는 서버에서만', ctl.available && ctl.provider === 'key' && ctl.model === MODEL && !ctl.designAvailable && sessionStorage.getItem('jin3d.anthropicKey') === 'sk-ant-test-not-a-real-key' && !browserKeyKept() && /API 키/.test(ctl.providerLabel));
    await ctl.setBrowserKey('sk-ant-test-not-a-real-key', true);
    check('기억 선택 → localStorage로 옮김', browserKeyKept() && sessionStorage.size() === 0);
    // SDK는 CDN에서 불러오지 않고 가짜로 넣는다 (오류 종류 → 문구)
    class APIError extends Error { constructor(status) { super('api'); this.status = status; } }
    class AuthenticationError extends APIError {} class PermissionDeniedError extends APIError {} class RateLimitError extends APIError {} class APIConnectionError extends APIError {}
    ctl.SDK = { AuthenticationError, PermissionDeniedError, RateLimitError, APIConnectionError, APIError };
    const seen = []; ctl.client = { beta: { messages: { create: fakeCreate(seen) } } };
    const out = await ctl.runTurn(payload);
    check('브라우저 직접 호출 → 같은 결과 모양 (조치 · 반려 · 응답 시간)', out.actions.length === 1 && out.rejected.length === 2 && out.latencyMs >= 0 && fetched === 0);
    const msg = async (e) => { ctl.client = { beta: { messages: { create: async () => { throw e; } } } }; try { await ctl.runTurn(payload); return ''; } catch (x) { return x.message; } };
    check('오류 문구: 키 틀림 · 한도 · 연결 실패', /올바르지/.test(await msg(new AuthenticationError(401))) && /한도/.test(await msg(new RateLimitError(429))) && /연결하지 못했/.test(await msg(new APIConnectionError())) && /오류 500/.test(await msg(new APIError(500))));
    await ctl.setBrowserKey('', false);
    check('키 삭제 → 미연결 · 저장소 비움', !ctl.available && ctl.provider === null && !browserKey() && localStorage.size() === 0);
    // 지시가 Agent까지 가서 조치로 돌아오는 끝단 (서버 없음 · 가짜 클라이언트)
    await ctl.setBrowserKey('sk-ant-test-not-a-real-key', false);
    const { FactoryAgent } = await import('../js/agent.js'), { zoneLine } = await import('../js/line.js');
    const sim = new Simulation('dark', 7, { line: zoneLine(), quiet: true }), agent = new FactoryAgent(sim);
    ctl.attach(sim, agent); ctl.setEnabled(true); ctl.pauseWhileThinking = false;
    ctl.client = { beta: { messages: { create: fakeCreate([]) } } };
    ctl.chat('저기 끝에 있는 데 좀 살펴서 알맞게 해줘');
    for (let i = 0; i < 40 && (ctl.inFlight || !ctl.calls); i++) await new Promise((r) => setTimeout(r, 10));
    const rec = ctl.dialogs[0];
    check('모르는 문장 → Agent 해석 → 게이트 거쳐 포장셀 속도 75%', ctl.calls === 1 && rec.agentItems?.length === 1 && rec.agentItems[0].gate.verdict === 'approve' && rec.items[0].gate.verdict === 'delegated' && sim.cmd.list.some((c) => c.code === 'SPEED' && c.target === 'PACK' && c.arg === 75), `${rec.items[0].gate.verdict} · ${rec.agentItems?.[0]?.gate.verdict}`);
  } finally { globalThis.fetch = realFetch; delete globalThis.window; }
}

console.log('== AIOS 업로드 — 실패한 묶음은 완료로 치지 않고 다시 · 같은 본문 · 원본이 없으면 복구 불가');
{
  const source = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
  const code = source.slice(source.indexOf('function aiosUpload()'), source.indexOf('function renderAios('));
  {
    const c = { id: 'aios_0001', t: 600 }, state = { busy: false, n: 0, bytes: 0, fail: 0, nextAt: 0, lastError: null, lost: 0 };
    let calls = 0, ok = false, now = 0;
    const ctx = { sim: { aios: { on: true, chunks: [c], samples: [{ t: 600 }] } }, epRec: { server: true, runId: 'test' }, aiosUp: state, performance: { now: () => now },
      hub: { iso: (t) => String(t) }, AIOS_CHUNK: 60, AIOS_SAMPLE_S: 10, zipStore: () => {}, buildAiosZip: () => new Uint8Array([1]),
      fetch: async () => { calls++; return ok ? { ok: true, status: 200 } : { ok: false, status: 503 }; } };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    const tick = async () => { vm.runInContext('aiosUpload()', ctx); for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
    await tick();
    check('503 → 완료 표시 안 함 · 실패 1회', !c.up && state.fail === 1 && state.n === 0);
    await tick(); check('다시 시도 간격 전에는 보내지 않음', calls === 1);
    now = 6000; ok = true; await tick();
    check('간격 뒤 다시 보내 성공 → 완료', calls === 2 && c.up === true && state.n === 1 && state.fail === 0);
  }
  {
    const sim = new Simulation('dark', 1, { quiet: true }), P = sim.aios;
    P.on = true; P.chunks = [{ id: 'aios_0001', t: 600 }, { id: 'aios_0002', t: 99999 }];
    P.samples = Array.from({ length: 60 }, (_, i) => ({ t: 10 * (i + 1) }));
    P.transitions = () => [];
    const c = P.chunks[0], sent = [], state = { busy: false, n: 0, bytes: 0, fail: 0, nextAt: 0, lastError: null, lost: 0 };
    let now = 0, ok = false;
    const ctx = { sim, epRec: { server: true, runId: 'run-test' }, aiosUp: state, performance: { now: () => now }, hub: { iso: (t) => String(t) }, AIOS_CHUNK: 60, AIOS_SAMPLE_S: 10, buildAiosZip,
      zipStore: (files) => new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'meta/info.json').data)).samples)),
      fetch: async (u, o) => { sent.push(new TextDecoder().decode(o.body)); return { ok, status: ok ? 200 : 503 }; } };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
    vm.runInContext('aiosUpload()', ctx); await flush();
    P.samples = [{ t: 22200 }]; now = 6000; ok = true;   // 장애 중 원본이 6시간 보관 범위 밖으로 밀려남
    vm.runInContext('aiosUpload()', ctx); await flush();
    check('재시도 본문 = 처음 본문 (샘플 60개) → 성공 뒤 완료', sent.length === 2 && sent[0] === '60' && sent[1] === '60' && c.up === true && !c.zip, sent.join(' / '));
    check('원본이 이미 없는 묶음은 보내지 않고 복구 불가로 셈', P.chunks[1].lost === true && !P.chunks[1].up && state.lost === 1);
  }
}

console.log('== 녹화 구간 — MP4 변환은 최근 구간부터 · 기다리는 시간 한도');
{
  const realFetch = globalThis.fetch; globalThis.fetch = async (u) => { await new Promise((r) => setTimeout(r, String(u).includes('slow') ? 300 : 5)); return { ok: true, json: async () => ({ all: 'x.mp4' }) }; };
  try {
    const { convertSegs } = await import('../js/cctvrec.js');
    const segs = [{ id: 'old', stored: true }, { id: 'slow', stored: true }, { id: 'new', stored: true }, { id: 'unsaved', stored: false }], prog = [];
    const r = await convertSegs('cctv', segs, { budgetMs: 80, onProgress: (d, n) => prog.push(`${d}/${n}`) });
    check('최근 구간 먼저 · 한도 넘으면 남기고 돌려줌', segs[2].mp4 && !segs[0].mp4 && r.done === 1 && r.total === 3 && r.pending >= 1 && prog[0] === '0/3', JSON.stringify(r));
  } finally { globalThis.fetch = realFetch; }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
