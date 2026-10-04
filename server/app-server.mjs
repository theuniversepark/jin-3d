// 정적 파일 제공 + Claude 에이전트 프록시. CLI(server.mjs)와 맥 앱(electron/main.mjs)이 함께 쓴다.
// API 키는 서버 프로세스에만 두고 브라우저(렌더러)로는 절대 보내지 않는다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { runAgentTurn, MODEL } from './llm-agent.mjs';
import { designLine } from './line-designer.mjs';
import { startMqtt, mqttStatus, mqttPublish } from './mqtt-gateway.mjs';
import { odooStatus, odooConfig, odooSync, odooReset } from './odoo-gateway.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = ['index.html', 'css/', 'js/', 'vendor/', 'assets/'];

let client = null;

// VLA 에피소드 저장소 — 맥 앱은 사용자 데이터 폴더(JIN3D_DATA_DIR), CLI는 프로젝트의 data/
const DATA_DIR = () => process.env.JIN3D_DATA_DIR || path.join(ROOT, 'data');
const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// POST /api/episodes?robot=RB-02-1&id=ep_000012 (본문: 에피소드 zip) → data/episodes/<robot>/<id>.zip
async function saveEpisode(req, res, url) {
  const robot = url.searchParams.get('robot') ?? '', id = url.searchParams.get('id') ?? '';
  if (!SAFE.test(robot) || !SAFE.test(id)) return send(res, 400, { error: 'robot·id 형식 오류' });
  try {
    const buf = await readRaw(req, 8 * 1024 * 1024);
    const dir = path.join(DATA_DIR(), 'episodes', robot);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.zip`), buf);
    return send(res, 200, { ok: true, bytes: buf.length });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
// GET /api/episodes → 로봇별 저장 에피소드 수·용량
function listEpisodes(res) {
  const base = path.join(DATA_DIR(), 'episodes'), robots = {};
  try {
    for (const r of fs.readdirSync(base)) {
      const files = fs.readdirSync(path.join(base, r)).filter((f) => f.endsWith('.zip'));
      robots[r] = { count: files.length, bytes: files.reduce((a, f) => a + fs.statSync(path.join(base, r, f)).size, 0) };
    }
  } catch { /* 아직 저장된 에피소드 없음 */ }
  return send(res, 200, { dir: base, robots });
}

// AIOS 운영 데이터 묶음 저장소 — POST /api/aios?id=run-..._aios_0001 (본문: 운영 데이터셋 zip) → data/aios/<id>.zip
async function saveAios(req, res, url) {
  const id = url.searchParams.get('id') ?? '';
  if (!SAFE.test(id)) return send(res, 400, { error: 'id 형식 오류' });
  try {
    const buf = await readRaw(req, 16 * 1024 * 1024);
    const dir = path.join(DATA_DIR(), 'aios');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.zip`), buf);
    return send(res, 200, { ok: true, bytes: buf.length });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
// GET /api/aios → 저장된 운영 데이터 묶음 수·용량
function listAios(res) {
  const dir = path.join(DATA_DIR(), 'aios');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')); } catch { /* 아직 없음 */ }
  return send(res, 200, { dir, count: files.length, bytes: files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0) });
}

// 키를 바꾸면 클라이언트를 새로 만든다. 빈 값이면 환경변수(ANTHROPIC_API_KEY 등)로 되돌아간다.
export function setApiKey(key) {
  if (key) client = new Anthropic({ apiKey: key });
  else client = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;
  return Boolean(client);
}
export const hasApiKey = () => Boolean(client);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleAgent(req, res) {
  if (!client) return send(res, 503, { error: 'Claude API 키가 설정되어 있지 않습니다.' });
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: '잘못된 요청 본문' }); }
  if (!payload?.snapshot?.stations) return send(res, 400, { error: 'snapshot 누락' });
  const t0 = Date.now();
  try {
    const out = await runAgentTurn(client, payload);
    console.log(`[agent] ${payload.trigger?.slice(0, 40)} → 조치 ${out.actions.length}건, 거부 ${out.rejected.length}건, ${((Date.now() - t0) / 1000).toFixed(1)}s, $${out.costUSD.toFixed(4)}`);
    send(res, 200, { ...out, latencyMs: Date.now() - t0 });
  } catch (err) {
    sendApiError(res, err);
  }
}

async function handleLine(req, res) {
  if (!client) return send(res, 503, { error: 'Claude API 키가 설정되어 있지 않습니다.' });
  let payload;
  try { payload = JSON.parse(await readBody(req, 60 * 1024 * 1024)); } catch { return send(res, 400, { error: '요청 본문이 잘못되었거나 첨부 파일이 너무 큽니다 (합계 약 40MB 이하)' }); }
  const request = String(payload?.request ?? '').trim().slice(0, 2000);
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (!request || !payload?.line?.stations) return send(res, 400, { error: '요청 또는 현재 라인 누락' });
  const t0 = Date.now();
  try {
    const out = await designLine(client, { line: payload.line, request, attachments });
    console.log(`[line] "${request.slice(0, 40)}" 첨부 ${attachments.length}개 → 변경 ${out.diff.length}건, ${((Date.now() - t0) / 1000).toFixed(1)}s, $${out.costUSD.toFixed(4)}`);
    send(res, 200, { ...out, latencyMs: Date.now() - t0 });
  } catch (err) {
    sendApiError(res, err);
  }
}

function sendApiError(res, err) {
  let status = 502, msg = err.message;
  if (err instanceof Anthropic.AuthenticationError) { status = 401; msg = 'API 키 인증 실패 — 키를 확인하세요'; }
  else if (err instanceof Anthropic.RateLimitError) { status = 429; msg = '요청 한도 초과 — 잠시 후 재시도'; }
  else if (err instanceof Anthropic.BadRequestError) { status = 400; msg = `잘못된 API 요청: ${err.message}`; }
  else if (err instanceof Anthropic.APIConnectionError) { msg = 'Claude API 연결 실패 — 네트워크를 확인하세요'; }
  else if (err instanceof Anthropic.APIError) { status = err.status ?? 502; }
  console.error('[api] 오류:', status, err.message);
  send(res, status, { error: msg });
}

export async function startServer({ port = 8765, host = '127.0.0.1' } = {}) {
  if (!client) setApiKey(null);
  await startMqtt();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/status') return send(res, 200, { llm: hasApiKey(), model: MODEL, episodes: true, aios: true });
    if (url.pathname === '/api/episodes' && req.method === 'POST') return saveEpisode(req, res, url);
    if (url.pathname === '/api/episodes') return listEpisodes(res);
    if (url.pathname === '/api/aios' && req.method === 'POST') return saveAios(req, res, url);
    if (url.pathname === '/api/aios') return listAios(res);
    if (url.pathname === '/api/agent' && req.method === 'POST') return handleAgent(req, res);
    if (url.pathname === '/api/line' && req.method === 'POST') return handleLine(req, res);
    // OPC UA PubSub(JSON) over MQTT — 내장 브로커로 발행
    if (url.pathname === '/api/mqtt/status') return send(res, 200, mqttStatus());
    if (url.pathname === '/api/mqtt/publish' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req, 16 * 1024 * 1024));
        return send(res, 200, { published: mqttPublish(Array.isArray(body?.messages) ? body.messages : []), status: mqttStatus() });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // Odoo ERP 실시간 연동 (발주·재고·설비보전) — API 키는 서버 메모리에만, 응답에는 넣지 않는다
    if (url.pathname === '/api/odoo/status') return send(res, 200, odooStatus());
    if (url.pathname === '/api/odoo/config' && req.method === 'POST') {
      try { return send(res, 200, odooConfig(JSON.parse(await readBody(req)))); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/odoo/reset' && req.method === 'POST') { odooReset(); return send(res, 200, odooStatus()); }
    if (url.pathname === '/api/odoo/sync' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req, 8 * 1024 * 1024));
        return send(res, 200, await odooSync(Array.isArray(body?.events) ? body.events : []));
      } catch (e) { return send(res, 502, { error: e.message, status: odooStatus() }); }
    }

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!PUBLIC.some((p) => rel === p || rel.startsWith(p))) return send(res, 404, 'Not found', 'text/plain');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, data, MIME[path.extname(file)] ?? 'application/octet-stream');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port }));
  });
}
