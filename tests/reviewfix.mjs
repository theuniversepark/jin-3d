// 코드 리뷰 지적 회귀 검증 — 정적 파일 경로 우회 차단 · 없는 영상 요청에도 서버 유지 · 보관 정리로 지운 MP4를 「변환 완료」로 돌려주지 않음
// · 카메라 칸 좌표 0 보존(첫 칸이 x=2부터 잘리지 않음) · 시작 때 보관 한도 밖 구간은 변환하지 않음. 실행: npm test
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-review-')); process.env.JIN3D_DATA_DIR = dir;
const { startServer } = await import('../server/app-server.mjs');
const { findFfmpeg } = await import('../server/video-convert.mjs');
const { port, server } = await startServer({ port: 0 }), base = `http://127.0.0.1:${port}`;
console.log('== 정적 파일 경로');
const code = async (p) => (await fetch(base + p)).status;
check('공개 파일은 그대로 (index.html · js/)', (await code('/')) === 200 && (await code('/js/pcap.js')) === 200);
const esc = await Promise.all(['/assets/..%2f.env', '/assets/..%2fpackage.json', '/js/..%2f..%2fetc%2fpasswd', '/assets/..%2fserver%2fapp-server.mjs', '/css/..%5cpackage.json', '/%E0%A4%A'].map(code));
check('공개 폴더 밖으로 풀리는 주소는 막음 (..%2f · 역슬래시 · 잘못된 인코딩)', esc.every((c) => c === 404 || c === 403 || c === 400), esc.join(','));
console.log('== 영상 제공');
check('없는 영상은 404, 서버는 계속 응답', (await code('/videos/robotcam/none_robotcam_0001.mp4')) === 404 && (await code('/api/status')) === 200);
// 읽기 직전에 문제가 생기는 경우: 이름은 영상인데 실제로는 폴더 → 존재 확인·크기 확인은 지나고 읽기에서 오류 (예전에는 처리 안 된 오류로 서버 프로세스가 죽었다)
fs.mkdirSync(path.join(dir, 'robotcam', 'run-x_robotcam_0009.mp4'), { recursive: true });
const rerr = await fetch(`${base}/videos/robotcam/run-x_robotcam_0009.mp4`).then((r) => r.arrayBuffer().then(() => 'ok'), () => 'reset');
check('읽기 오류가 나도 그 요청만 끊기고 서버는 계속 응답', (await code('/api/status')) === 200, `요청 결과 ${rerr}`);
console.log('== 변환 결과 캐시');
const rc = path.join(dir, 'robotcam'); fs.mkdirSync(rc, { recursive: true });
const id = 'run-x_robotcam_0001', done = path.join(rc, `${id}.mp4.json`);
fs.writeFileSync(done, JSON.stringify({ segment: id, mp4: `${id}.mp4`, cameras: [] }));
if (!findFfmpeg()) console.log('  SKIP  ffmpeg 없음 — 변환 캐시 시험 건너뜀');
else {
  const a = await fetch(`${base}/api/convert?kind=robotcam&id=${id}`);
  fs.rmSync(done);   // 보관 정리로 지워진 상태
  const b = await fetch(`${base}/api/convert?kind=robotcam&id=${id}`);
  check('지운 MP4는 다시 요청하면 「변환 완료」가 아니라 다시 변환 시도 (원본이 없어 실패)', a.status === 200 && b.status !== 200, `${a.status} → ${b.status}`);
  // 카메라 칸 좌표 0: 왼쪽 반은 흰색, 오른쪽 반은 검정 영상에서 x=0 칸을 자르면 첫 열이 흰색이어야 한다
  const ff = findFfmpeg(), cv = path.join(dir, 'cctv'); fs.mkdirSync(cv, { recursive: true });
  const cid = 'run-x_cctv_0001';
  spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=2x16:r=2:d=2', '-f', 'lavfi', '-i', 'color=c=black:s=62x16:r=2:d=2', '-filter_complex', 'hstack', '-c:v', 'libvpx-vp9', path.join(cv, `${cid}.webm`)]);
  fs.writeFileSync(path.join(cv, `${cid}.json`), JSON.stringify({ segment: cid, fps: 2, index: [{ id: 'CC-01', rect: [0, 0, 16, 16] }] }));
  const r = await fetch(`${base}/api/convert?kind=cctv&id=${cid}`), j = await r.json();
  const raw = spawnSync(ff, ['-v', 'error', '-i', path.join(cv, j.cameras?.[0]?.file ?? 'x'), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']).stdout ?? Buffer.alloc(0);
  check('카메라 칸 x=0은 0부터 자름 (흰색 2px가 첫 열에 — 2px 밀리면 검정)', r.ok && raw.length >= 16 && raw[0] > 128 && raw[4] < 128, `첫 픽셀 ${raw[0]} · 다섯째 ${raw[4]}`);
}
console.log('== 시작 때 변환 대상');
const { backfillTargets, pruneVideos } = await import('../server/app-server.mjs');
process.env.JIN3D_MP4_KEEP = '3';
const bd = path.join(dir, 'cctv'); fs.rmSync(bd, { recursive: true, force: true }); fs.mkdirSync(bd, { recursive: true });
const mk = (i, { mp4 = false, mark = false, kb = 1 } = {}) => { const id = `run-b_cctv_${String(i).padStart(4, '0')}`; fs.writeFileSync(path.join(bd, `${id}.webm`), new Uint8Array(kb * 1024)); fs.writeFileSync(path.join(bd, `${id}.json`), '{}');
  if (mp4) { fs.writeFileSync(path.join(bd, `${id}.mp4`), new Uint8Array(kb * 1024)); fs.writeFileSync(path.join(bd, `${id}.mp4.json`), '{}'); }
  if (mark) fs.writeFileSync(path.join(bd, `${id}.nomp4`), '');
  const t = Date.now() / 1000 - 100 + i; for (const f of fs.readdirSync(bd).filter((x) => x.startsWith(id))) fs.utimesSync(path.join(bd, f), t, t); return id; };
const ids = [0, 1, 2].map((i) => mk(i)).concat(mk(3), mk(4, { mp4: true }), mk(5, { mark: true }));
const tg = await backfillTargets('cctv');
check('MP4 보관 대상(최신 3구간) 중 MP4 없는 것만 — 한도 밖·MP4 있음·용량 표시 구간 제외', tg.length === 1 && tg[0] === ids[3], tg.join(','));
// 용량 한도로 MP4를 지우면 표시가 남아 다음 시작 때 변환 대상에서 빠진다
fs.rmSync(bd, { recursive: true, force: true }); fs.mkdirSync(bd, { recursive: true });
process.env.JIN3D_CCTV_MAX_MB = '1';
const big = [0, 1, 2].map((i) => mk(i, { mp4: true, kb: 400 }));
await pruneVideos('cctv');
const capped = big.filter((id) => fs.existsSync(path.join(bd, `${id}.nomp4`))), tg2 = await backfillTargets('cctv');
check('용량 한도로 지운 MP4는 표시 → 시작 때 다시 변환하지 않음', capped.length >= 1 && capped.every((id) => !tg2.includes(id)), `표시 ${capped.length} · 대상 ${tg2.join(',') || '없음'}`);
server?.close?.(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
