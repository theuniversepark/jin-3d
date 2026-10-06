// 데이터 보관 한도 검증 — VLA 에피소드(로봇별 개수 JIN3D_EPISODE_KEEP · 전체 용량 JIN3D_EPISODE_MAX_MB), AIOS 운영 데이터(묶음 수 JIN3D_AIOS_KEEP · 용량 JIN3D_AIOS_MAX_MB)를 넘으면 오래된 것부터 지우는지. 실행: npm test
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-ep-')); process.env.JIN3D_DATA_DIR = dir; process.env.JIN3D_EPISODE_KEEP = '5'; process.env.JIN3D_EPISODE_MAX_MB = '1'; process.env.JIN3D_AIOS_KEEP = '4'; process.env.JIN3D_AIOS_MAX_MB = '1';
const { startServer, pruneEpisodes } = await import('../server/app-server.mjs');
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
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
