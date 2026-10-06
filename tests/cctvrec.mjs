// CCTV 영상 저장 서버 검증 — 자동 녹화(NVR) 구간 영상(WebM)·카메라 배치 색인(JSON)을 data/cctv/에 저장하고, 목록·보관 개수 제한·잘못된 이름 거부.
// (브라우저 녹화 자체는 MediaRecorder라 맥 앱 화면에서 확인) 실행: npm test
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-cctv-')); process.env.JIN3D_DATA_DIR = dir;
const { startServer } = await import('../server/app-server.mjs');
const { port, server } = await startServer({ port: 0 });
const base = `http://127.0.0.1:${port}`;
console.log('== CCTV 영상 저장 (서버)');
const st = await (await fetch(`${base}/api/status`)).json();
check('상태에 CCTV 저장 지원 표시', st.cctv === true);
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const r1 = await fetch(`${base}/api/cctv?id=run-test_cctv_0001&ext=webm`, { method: 'POST', body: webm });
const r2 = await fetch(`${base}/api/cctv?id=run-test_cctv_0001&ext=json`, { method: 'POST', body: JSON.stringify({ segment: 'run-test_cctv_0001', index: [{ id: 'CC-01', rect: [0, 34, 288, 162] }] }) });
check('구간 영상·색인 저장', r1.ok && r2.ok && fs.existsSync(path.join(dir, 'cctv', 'run-test_cctv_0001.webm')) && fs.existsSync(path.join(dir, 'cctv', 'run-test_cctv_0001.json')));
check('저장한 영상 바이트 그대로', fs.readFileSync(path.join(dir, 'cctv', 'run-test_cctv_0001.webm')).equals(Buffer.from(webm)));
const ls = await (await fetch(`${base}/api/cctv`)).json();
check('목록 (구간 수 · 실제 용량 · 보관 한도)', ls.count === 1 && ls.webmBytes >= webm.length && ls.bytes === ls.webmBytes + ls.mp4Bytes + ls.camBytes && ls.keep > 0 && ls.maxBytes > 0, `${ls.count}구간 · 보관 ${ls.keep}구간 · 최대 ${(ls.maxBytes / 1073741824).toFixed(0)}GB`);
const bad = await fetch(`${base}/api/cctv?id=../../etc&ext=webm`, { method: 'POST', body: webm }), bad2 = await fetch(`${base}/api/cctv?id=ok_1&ext=exe`, { method: 'POST', body: webm });
check('잘못된 이름·확장자 거부 (경로 탈출 방지)', bad.status === 400 && bad2.status === 400);
server?.close?.(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);   // 서버(게이트웨이 타이머 포함)를 남기지 않고 끝낸다
