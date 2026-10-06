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
import { ffmpegInfo, queueConvert, convertClip, readStoredZip, framesToMp4 } from './video-convert.mjs';
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
    const pruned = pruneEpisodes(robot);
    return send(res, 200, { ok: true, bytes: buf.length, pruned });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
// 에피소드 보관 한도: 로봇마다 최근 500개(JIN3D_EPISODE_KEEP), 전체 3GB(JIN3D_EPISODE_MAX_MB) — 넘으면 오래된 것부터 지운다
// 로봇별 정리는 저장할 때마다, 전체 용량 정리는 50번 저장마다(파일이 많으면 목록 읽기가 무거워서) 한다
export const EPISODE_KEEP = () => Number(process.env.JIN3D_EPISODE_KEEP) || 500;
export const EPISODE_MAX_BYTES = () => (Number(process.env.JIN3D_EPISODE_MAX_MB) || 3072) * 1024 * 1024;
let epSaves = 0;
export function pruneEpisodes(robot = null, force = false) {
  const base = path.join(DATA_DIR(), 'episodes'); let n = 0;
  const list = (r) => { try { return fs.readdirSync(path.join(base, r)).filter((f) => f.endsWith('.zip')).map((f) => { const st = fs.statSync(path.join(base, r, f)); return { r, f, t: st.mtimeMs, b: st.size }; }); } catch { return []; } };
  const drop = (x) => { fs.rmSync(path.join(base, x.r, x.f), { force: true }); n++; };
  if (robot) { const fs1 = list(robot).sort((a, b) => a.t - b.t); for (const x of fs1.slice(0, Math.max(0, fs1.length - EPISODE_KEEP()))) drop(x); }
  if (force || ++epSaves % 50 === 1) {
    let robots = []; try { robots = fs.readdirSync(base); } catch { return n; }
    const all = [];
    for (const r of robots) { const l = list(r).sort((a, b) => a.t - b.t); for (const x of l.slice(0, Math.max(0, l.length - EPISODE_KEEP()))) drop(x); all.push(...l.slice(Math.max(0, l.length - EPISODE_KEEP()))); }
    all.sort((a, b) => a.t - b.t);
    let total = all.reduce((a, x) => a + x.b, 0);
    for (const x of all) { if (total <= EPISODE_MAX_BYTES()) break; drop(x); total -= x.b; }
  }
  return n;
}
// GET /api/episodes → 로봇별 저장 에피소드 수·용량
function listEpisodes(res) {
  const base = path.join(DATA_DIR(), 'episodes'), robots = {};
  let names = []; try { names = fs.readdirSync(base); } catch { /* 아직 저장된 에피소드 없음 */ }
  for (const r of names) {   // 로봇 폴더만 (.DS_Store 같은 파일이 섞여 있어도 목록이 비지 않게)
    try {
      if (!fs.statSync(path.join(base, r)).isDirectory()) continue;
      const files = fs.readdirSync(path.join(base, r)).filter((f) => f.endsWith('.zip'));
      robots[r] = { count: files.length, bytes: files.reduce((a, f) => a + fs.statSync(path.join(base, r, f)).size, 0) };
    } catch { /* 읽을 수 없는 항목은 건너뜀 */ }
  }
  return send(res, 200, { dir: base, robots, keep: EPISODE_KEEP(), maxBytes: EPISODE_MAX_BYTES() });
}

// CCTV 자동 녹화(NVR) 구간 저장소 — POST /api/cctv?id=run-..._cctv_0001&ext=webm|json → data/cctv/<id>.<ext>
// 보관 기간: 구간 파일이 576개(5분 구간 약 48시간)를 넘으면 오래된 것부터 지운다
// 녹화 영상 보관 한도 (종류별, 환경 변수로 변경):
//   원본 WebM 구간 수 — CCTV JIN3D_CCTV_KEEP · 로봇 카메라 JIN3D_ROBOTCAM_KEEP (기본 576구간 ≈ 5분 구간 48시간)
//   MP4(전체 + 카메라별) 구간 수 — JIN3D_MP4_KEEP (기본 144구간 ≈ 12시간)
//   전체 용량(WebM + MP4 + 색인) — CCTV JIN3D_CCTV_MAX_MB (기본 4GB) · 로봇 카메라 JIN3D_ROBOTCAM_MAX_MB (기본 8GB)
//   용량을 넘으면 오래된 구간의 MP4부터 지우고, 그래도 넘으면 오래된 구간을 통째로 지운다
export const VIDEO_LIMITS = () => ({
  cctv: { keep: Number(process.env.JIN3D_CCTV_KEEP) || 576, mp4Keep: Number(process.env.JIN3D_MP4_KEEP) || 144, maxBytes: (Number(process.env.JIN3D_CCTV_MAX_MB) || 4096) * 1048576 },
  robotcam: { keep: Number(process.env.JIN3D_ROBOTCAM_KEEP) || 576, mp4Keep: Number(process.env.JIN3D_MP4_KEEP) || 144, maxBytes: (Number(process.env.JIN3D_ROBOTCAM_MAX_MB) || 8192) * 1048576 },
});
const fsize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const dsize = (d) => { let n = 0, c = 0; try { for (const f of fs.readdirSync(d)) { n += fsize(path.join(d, f)); c++; } } catch { /* 없음 */ } return { n, c }; };
// 구간 목록 (오래된 순): 원본 · 전체 MP4 · 카메라별 MP4 크기
export function videoSegments(kind) {
  const dir = path.join(DATA_DIR(), kind); let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const ids = new Set(names.filter((f) => f.endsWith('.webm') || (f.endsWith('.json') && !f.endsWith('.mp4.json'))).map((f) => f.replace(/\.(webm|json)$/, '')));
  return [...ids].map((id) => {
    const w = path.join(dir, `${id}.webm`), cam = dsize(path.join(dir, id));
    let t = 0; try { t = fs.statSync(fs.existsSync(w) ? w : path.join(dir, `${id}.json`)).mtimeMs; } catch { /* 없음 */ }
    return { id, t, webm: fsize(w) + fsize(path.join(dir, `${id}.json`)), mp4: fsize(path.join(dir, `${id}.mp4`)) + fsize(path.join(dir, `${id}.mp4.json`)), cam: cam.n, camFiles: cam.c, hasMp4: fs.existsSync(path.join(dir, `${id}.mp4.json`)) };
  }).sort((a, b) => a.t - b.t);
}
function dropMp4(dir, id) { for (const f of [`${id}.mp4`, `${id}.mp4.json`]) fs.rmSync(path.join(dir, f), { force: true }); fs.rmSync(path.join(dir, id), { recursive: true, force: true }); }
export function pruneVideos(kind) {
  const L = VIDEO_LIMITS()[kind], dir = path.join(DATA_DIR(), kind), out = { segments: 0, mp4: 0 };
  let segs = videoSegments(kind);
  for (const s of segs.slice(0, Math.max(0, segs.length - L.keep))) { dropSegment(dir, s.id); out.segments++; }   // 원본 구간 수
  segs = segs.slice(Math.max(0, segs.length - L.keep));
  const withMp4 = segs.filter((s) => s.hasMp4 || s.cam);
  for (const s of withMp4.slice(0, Math.max(0, withMp4.length - L.mp4Keep))) { dropMp4(dir, s.id); s.mp4 = s.cam = 0; s.hasMp4 = false; out.mp4++; }   // MP4 구간 수
  let total = segs.reduce((a, s) => a + s.webm + s.mp4 + s.cam, 0);
  for (const s of segs) { if (total <= L.maxBytes) break; if (s.mp4 + s.cam > 0) { dropMp4(dir, s.id); total -= s.mp4 + s.cam; s.mp4 = s.cam = 0; out.mp4++; } }   // 용량: 오래된 MP4부터
  for (const s of segs) { if (total <= L.maxBytes) break; dropSegment(dir, s.id); total -= s.webm; out.segments++; }   // 그래도 넘으면 오래된 구간 통째로
  return out;
}
// GET /api/cctv · /api/robotcam → 실제 용량(원본 + MP4 + 카메라별) · 구간 수 · 한도
function videoStatus(kind) {
  const segs = videoSegments(kind), L = VIDEO_LIMITS()[kind];
  const webm = segs.reduce((a, s) => a + s.webm, 0), mp4 = segs.reduce((a, s) => a + s.mp4, 0), cam = segs.reduce((a, s) => a + s.cam, 0);
  return { dir: path.join(DATA_DIR(), kind), count: segs.length, mp4Count: segs.filter((s) => s.hasMp4).length, noMp4: segs.filter((s) => !s.hasMp4).length, camFiles: segs.reduce((a, s) => a + s.camFiles, 0),
    bytes: webm + mp4 + cam, webmBytes: webm, mp4Bytes: mp4, camBytes: cam, keep: L.keep, mp4Keep: L.mp4Keep, maxBytes: L.maxBytes, oldest: segs[0]?.t ?? null, newest: segs.at(-1)?.t ?? null };
}
// 시작 때: MP4가 없는 구간(변환 기능 이전 녹화 등)을 차례로 변환하고 한도 정리
export function backfillVideos() {
  for (const kind of ['cctv', 'robotcam']) {
    const dir = path.join(DATA_DIR(), kind);
    if (ffmpegInfo().available) for (const s of videoSegments(kind)) if (!s.hasMp4 && fs.existsSync(path.join(dir, `${s.id}.webm`)) && fs.existsSync(path.join(dir, `${s.id}.json`))) queueConvert(dir, s.id).then(() => pruneVideos(kind)).catch(() => {});
    pruneVideos(kind);
  }
}
function dropSegment(dir, id) {
  for (const f of [`${id}.webm`, `${id}.json`, `${id}.mp4`, `${id}.mp4.json`]) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(path.join(dir, id), { recursive: true, force: true });
}
// GET /api/convert?kind=robotcam|cctv&id=<구간> → MP4 변환(전체 + 카메라별)이 끝날 때까지 기다렸다가 결과
async function convertApi(res, url) {
  const kind = url.searchParams.get('kind'), id = url.searchParams.get('id') ?? '';
  if (!['robotcam', 'cctv'].includes(kind) || !SAFE.test(id)) return send(res, 400, { error: 'kind·id 형식 오류' });
  if (!ffmpegInfo().available) return send(res, 503, { error: 'ffmpeg 없음' });
  try { return send(res, 200, await queueConvert(path.join(DATA_DIR(), kind), id)); } catch (e) { return send(res, 500, { error: e.message }); }
}
// POST /api/frames-mp4?fps=5 (본문: 무압축 zip — frame_*.jpg + durations.json[초]) → MP4 (VLA 에피소드 카메라 영상)
async function framesMp4(req, res, url) {
  if (!ffmpegInfo().available) return send(res, 503, { error: 'ffmpeg 없음' });
  try {
    const z = readStoredZip(await readRaw(req, 64 * 1024 * 1024)), durs = JSON.parse(z.get('durations.json')?.toString() ?? '[]');
    const names = [...z.keys()].filter((n) => /^frame_\d+\.jpg$/.test(n)).sort();
    const mp4 = await framesToMp4(names.map((n, i) => ({ name: n, data: z.get(n), dur: durs[i] ?? 0.2 })), Math.min(30, Math.max(1, Number(url.searchParams.get('fps')) || 5)));
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length }); res.end(mp4);
  } catch (e) { return send(res, 500, { error: e.message }); }
}
// POST /api/clip-mp4?fps=8 (본문: WebM) → MP4 (CCTV 정보 창 개별 녹화)
async function clipMp4(req, res, url) {
  if (!ffmpegInfo().available) return send(res, 503, { error: 'ffmpeg 없음' });
  try {
    const buf = await readRaw(req, 200 * 1024 * 1024), mp4 = await convertClip(buf, Math.min(30, Math.max(1, Number(url.searchParams.get('fps')) || 8)));
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length }); res.end(mp4);
  } catch (e) { return send(res, 500, { error: e.message }); }
}
async function saveCctv(req, res, url) {
  const id = url.searchParams.get('id') ?? '', ext = url.searchParams.get('ext') ?? 'webm';
  if (!SAFE.test(id) || !['webm', 'json'].includes(ext)) return send(res, 400, { error: 'id·ext 형식 오류' });
  try {
    const buf = await readRaw(req, 96 * 1024 * 1024);
    const dir = path.join(DATA_DIR(), 'cctv');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.${ext}`), buf);
    pruneVideos('cctv');
    if (ext === 'json' && ffmpegInfo().available) queueConvert(dir, id).then(() => pruneVideos('cctv')).catch(() => {});   // 색인까지 받으면 MP4로 변환 (전체 + 카메라별) → 한도 정리
    return send(res, 200, { ok: true, bytes: buf.length });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
// 로봇 카메라 자동 녹화 구간 — POST /api/robotcam?id=..._robotcam_0001&ext=webm|json → data/robotcam/<id>.<ext>
async function saveRobotcam(req, res, url) {
  const id = url.searchParams.get('id') ?? '', ext = url.searchParams.get('ext') ?? 'webm';
  if (!SAFE.test(id) || !['webm', 'json'].includes(ext)) return send(res, 400, { error: 'id·ext 형식 오류' });
  try {
    const buf = await readRaw(req, 96 * 1024 * 1024), dir = path.join(DATA_DIR(), 'robotcam');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.${ext}`), buf);
    pruneVideos('robotcam');
    if (ext === 'json' && ffmpegInfo().available) queueConvert(dir, id).then(() => pruneVideos('robotcam')).catch(() => {});   // 색인까지 받으면 MP4로 변환 (전체 + 카메라별) → 한도 정리
    return send(res, 200, { ok: true, bytes: buf.length });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
// GET /videos/(cctv|robotcam)/<파일>.webm|json → 저장한 영상 파일 (AAS 영상 링크가 가리키는 주소)
function serveVideo(res, url) {
  // /videos/<kind>/<구간>.(webm|mp4|json) 또는 카메라별 /videos/<kind>/<구간>/<로봇_카메라>.mp4
  const m = url.pathname.match(/^\/videos\/(cctv|robotcam)\/(?:([A-Za-z0-9_.-]{1,64})\/)?([A-Za-z0-9_.-]{1,80})\.(webm|json|mp4)$/);
  if (!m || (m[2] && !SAFE.test(m[2])) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(m[3]) || m[3].includes('..')) return send(res, 404, { error: 'not found' });
  const f = path.join(DATA_DIR(), m[1], ...(m[2] ? [m[2]] : []), `${m[3]}.${m[4]}`);
  if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': { webm: 'video/webm', mp4: 'video/mp4', json: 'application/json' }[m[4]], 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}
// GET /api/cctv → 저장된 녹화 구간 수·용량
function listCctv(res) { return send(res, 200, videoStatus('cctv')); }

// AIOS 운영 데이터 묶음 저장소 — POST /api/aios?id=run-..._aios_0001 (본문: 운영 데이터셋 zip) → data/aios/<id>.zip
async function saveAios(req, res, url) {
  const id = url.searchParams.get('id') ?? '';
  if (!SAFE.test(id)) return send(res, 400, { error: 'id 형식 오류' });
  try {
    const buf = await readRaw(req, 16 * 1024 * 1024);
    const dir = path.join(DATA_DIR(), 'aios');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.zip`), buf);
    return send(res, 200, { ok: true, bytes: buf.length, pruned: pruneAios() });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
// AIOS 운영 데이터 보관 한도: 최근 1,008묶음(10분 묶음 7일 · JIN3D_AIOS_KEEP), 전체 1GB(JIN3D_AIOS_MAX_MB) — 넘으면 오래된 것부터 지운다
export const AIOS_KEEP = () => Number(process.env.JIN3D_AIOS_KEEP) || 1008;
export const AIOS_MAX_BYTES = () => (Number(process.env.JIN3D_AIOS_MAX_MB) || 1024) * 1024 * 1024;
export function pruneAios() {
  const dir = path.join(DATA_DIR(), 'aios'); let n = 0, files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).map((f) => { const st = fs.statSync(path.join(dir, f)); return { f, t: st.mtimeMs, b: st.size }; }).sort((a, b) => a.t - b.t); } catch { return 0; }
  let total = files.reduce((a, x) => a + x.b, 0), left = files.length;
  for (const x of files) { if (left <= AIOS_KEEP() && total <= AIOS_MAX_BYTES()) break; fs.rmSync(path.join(dir, x.f), { force: true }); total -= x.b; left--; n++; }
  return n;
}
// GET /api/aios → 저장된 운영 데이터 묶음 수·용량
function listAios(res) {
  const dir = path.join(DATA_DIR(), 'aios');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')); } catch { /* 아직 없음 */ }
  return send(res, 200, { dir, count: files.length, bytes: files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0), keep: AIOS_KEEP(), maxBytes: AIOS_MAX_BYTES() });
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
    if (url.pathname === '/api/status') return send(res, 200, { llm: hasApiKey(), model: MODEL, episodes: true, aios: true, cctv: true, robotcam: true, dataDir: DATA_DIR(), ffmpeg: ffmpegInfo() });
    if (url.pathname === '/api/cctv' && req.method === 'POST') return saveCctv(req, res, url);
    if (url.pathname === '/api/cctv') return listCctv(res);
    if (url.pathname === '/api/robotcam' && req.method === 'POST') return saveRobotcam(req, res, url);
    if (url.pathname === '/api/robotcam') return send(res, 200, videoStatus('robotcam'));
    if (url.pathname.startsWith('/videos/')) return serveVideo(res, url);
    if (url.pathname === '/api/convert') return convertApi(res, url);
    if (url.pathname === '/api/clip-mp4' && req.method === 'POST') return clipMp4(req, res, url);
    if (url.pathname === '/api/frames-mp4' && req.method === 'POST') return framesMp4(req, res, url);
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
    server.listen(port, host, () => { setTimeout(() => { try { pruneEpisodes(null, true); pruneAios(); backfillVideos(); } catch { /* 무시 */ } }, 3000); resolve({ server, port: server.address().port }); });   // 시작 3초 뒤 쌓여 있던 에피소드·AIOS 데이터·녹화 영상 정리 (MP4 없는 구간 변환)
  });
}
