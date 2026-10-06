// 데이터 보관 한도 검증 — 녹화 영상(CCTV·로봇 카메라: 원본 구간 수 · MP4 구간 수 · 전체 용량), VLA 에피소드(로봇별 개수 JIN3D_EPISODE_KEEP · 전체 용량 JIN3D_EPISODE_MAX_MB), AIOS 운영 데이터(묶음 수 JIN3D_AIOS_KEEP · 용량 JIN3D_AIOS_MAX_MB)를 넘으면 오래된 것부터 지우는지. 실행: npm test
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-ep-')); process.env.JIN3D_DATA_DIR = dir; process.env.JIN3D_EPISODE_KEEP = '5'; process.env.JIN3D_EPISODE_MAX_MB = '1'; process.env.JIN3D_AIOS_KEEP = '4'; process.env.JIN3D_AIOS_MAX_MB = '1';
const { startServer, pruneEpisodes, pruneVideos } = await import('../server/app-server.mjs');
const { port } = await startServer({ port: 0 }), base = `http://127.0.0.1:${port}`;
console.log('== VLA 에피소드 보관 한도');
const post = (robot, i, kb) => fetch(`${base}/api/episodes?robot=${robot}&id=run_ep_${String(i).padStart(3, '0')}`, { method: 'POST', body: new Uint8Array(kb * 1024) });
for (let i = 0; i < 8; i++) { await post('RB-01-1', i, 4); await new Promise((r) => setTimeout(r, 15)); }
const f1 = fs.readdirSync(path.join(dir, 'episodes', 'RB-01-1')).sort();
check('로봇별 최대 개수 — 넘으면 오래된 것부터 지움', f1.length === 5 && f1[0] === 'run_ep_003.zip' && f1[4] === 'run_ep_007.zip', f1.join(' '));
// 전체 용량: 로봇 3대 × 5개 × 100KB = 1.5MB > 1MB → 오래된 것부터 지워 1MB 이하
for (const r of ['HM-M1', 'HM-M2', 'RB-02-1']) for (let i = 0; i < 5; i++) { await post(r, i, 100); await new Promise((r2) => setTimeout(r2, 15)); }
pruneEpisodes(null, true);
fs.writeFileSync(path.join(dir, 'episodes', '.DS_Store'), 'x');   // 로봇 폴더가 아닌 파일이 섞여도 목록이 비지 않아야 함
const ls = await (await fetch(`${base}/api/episodes`)).json(), total = Object.values(ls.robots).reduce((a, r) => a + r.bytes, 0);
check('전체 용량 한도 — 넘으면 오래된 것부터 지움', total <= 1024 * 1024 && ls.robots['RB-02-1'].count === 5, `${(total / 1024).toFixed(0)}KB · ${JSON.stringify(Object.fromEntries(Object.entries(ls.robots).map(([k, v]) => [k, v.count])))}`);
check('목록에 보관 한도 표시 · 폴더가 아닌 파일이 섞여도 목록 정상', ls.keep === 5 && ls.maxBytes === 1024 * 1024 && Object.keys(ls.robots).length === 4);
console.log('== AIOS 운영 데이터 보관 한도');
for (let i = 0; i < 7; i++) { await fetch(`${base}/api/aios?id=run_aios_${String(i).padStart(4, '0')}`, { method: 'POST', body: new Uint8Array(8 * 1024) }); await new Promise((r) => setTimeout(r, 15)); }
const fa = fs.readdirSync(path.join(dir, 'aios')).sort();
check('AIOS 묶음 수 한도 — 넘으면 오래된 것부터 지움', fa.length === 4 && fa[0] === 'run_aios_0003.zip' && fa[3] === 'run_aios_0006.zip', fa.join(' '));
for (let i = 7; i < 10; i++) { await fetch(`${base}/api/aios?id=run_aios_${String(i).padStart(4, '0')}`, { method: 'POST', body: new Uint8Array(400 * 1024) }); await new Promise((r) => setTimeout(r, 15)); }
const la = await (await fetch(`${base}/api/aios`)).json();
check('AIOS 용량 한도 · 목록에 한도 표시', la.bytes <= 1024 * 1024 && la.keep === 4 && la.maxBytes === 1024 * 1024 && fs.existsSync(path.join(dir, 'aios', 'run_aios_0009.zip')), `${la.count}묶음 · ${(la.bytes / 1024).toFixed(0)}KB`);
console.log('== 녹화 영상 보관 한도 (CCTV · 로봇 카메라)');
process.env.JIN3D_CCTV_KEEP = '6'; process.env.JIN3D_MP4_KEEP = '3'; process.env.JIN3D_CCTV_MAX_MB = '2'; process.env.JIN3D_ROBOTCAM_KEEP = '9';
const vdir = path.join(dir, 'cctv'); fs.mkdirSync(vdir, { recursive: true });
const seg = (i, mp4kb) => { const id = `run_cctv_${String(i).padStart(4, '0')}`; fs.writeFileSync(path.join(vdir, `${id}.webm`), new Uint8Array(100 * 1024)); fs.writeFileSync(path.join(vdir, `${id}.json`), '{}');
  if (mp4kb) { fs.writeFileSync(path.join(vdir, `${id}.mp4`), new Uint8Array(mp4kb * 1024)); fs.writeFileSync(path.join(vdir, `${id}.mp4.json`), '{}'); fs.mkdirSync(path.join(vdir, id)); fs.writeFileSync(path.join(vdir, id, 'CC-01_view.mp4'), new Uint8Array(mp4kb * 1024)); }
  const t = Date.now() / 1000 - 100 + i; for (const f of fs.readdirSync(vdir).filter((x) => x.startsWith(id))) fs.utimesSync(path.join(vdir, f), t, t); };
for (let i = 0; i < 8; i++) seg(i, 50);
const r1 = pruneVideos('cctv'), left = fs.readdirSync(vdir).filter((f) => f.endsWith('.webm')).sort(), mp4left = fs.readdirSync(vdir).filter((f) => f.endsWith('.mp4.json')).sort();
check('원본 구간 수 한도(6) · MP4 구간 수 한도(3) — 오래된 것부터', left.length === 6 && left[0] === 'run_cctv_0002.webm' && mp4left.length === 3 && mp4left[0] === 'run_cctv_0005.mp4.json' && !fs.existsSync(path.join(vdir, 'run_cctv_0004')), `원본 ${left.length} · MP4 ${mp4left.length} · 정리 ${JSON.stringify(r1)}`);
for (let i = 8; i < 12; i++) seg(i, 400);   // 용량 초과 (MP4 큰 구간)
pruneVideos('cctv');
const st = await (await fetch(`${base}/api/cctv`)).json();
check('전체 용량 한도(2MB) — 오래된 MP4부터, 그래도 넘으면 오래된 구간', st.bytes <= 2 * 1048576 && st.count >= 1 && fs.existsSync(path.join(vdir, 'run_cctv_0011.webm')), `${st.count}구간 · ${(st.bytes / 1024).toFixed(0)}KB (원본 ${(st.webmBytes / 1024).toFixed(0)} · MP4 ${((st.mp4Bytes + st.camBytes) / 1024).toFixed(0)}KB, ${st.mp4Count}구간)`);
const rs = await (await fetch(`${base}/api/robotcam`)).json();
check('상태: 실제 용량 = 원본 + MP4 + 카메라별 · 종류별 한도 (로봇 카메라 따로)', st.bytes === st.webmBytes + st.mp4Bytes + st.camBytes && st.keep === 6 && st.mp4Keep === 3 && st.maxBytes === 2 * 1048576 && rs.keep === 9 && rs.maxBytes === 8192 * 1048576);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
