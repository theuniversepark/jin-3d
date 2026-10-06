// ffmpeg MP4 저장 검증 — 로봇 카메라·CCTV 녹화 구간(WebM)을 서버가 MP4(H.264)로 바꾸고, 칸 색인대로 잘라 카메라별 MP4를 만들며,
// 링크 주소(/videos/<종류>/<구간>/<로봇_카메라>.mp4)로 내려주는지, 개별 녹화를 MP4로 바꿔 돌려주는지. ffmpeg가 없으면 건너뛴다. 실행: npm test
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { findFfmpeg, camFile } from '../server/video-convert.mjs';
import { camFile as clientCamFile } from '../js/robotrec.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== ffmpeg MP4 저장 (로봇 카메라 · CCTV)');
const ff = findFfmpeg();
if (!ff) { console.log('  SKIP  ffmpeg 없음 — MP4 변환 시험 건너뜀'); console.log('\n결과: 0 PASS / 0 FAIL'); process.exit(0); }
check('ffmpeg 찾기', !!ff, ff);
check('카메라별 파일 이름 규칙 (서버 = 화면)', camFile({ robot: 'HM-M1', camera: 'handL' }) === clientCamFile({ robot: 'HM-M1', camera: 'handL' }) && camFile({ id: 'CC-01' }) === 'CC-01_view.mp4');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-mp4-')); process.env.JIN3D_DATA_DIR = dir;
// 시험 영상: 2×1 칸 분할(칸 256×144 + 머리 띠 30) WebM 6초 2fps
const src = path.join(dir, 'src.webm');
spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=512x174:rate=2:duration=6', '-c:v', 'libvpx-vp9', '-b:v', '200k', src]);
const { startServer } = await import('../server/app-server.mjs');
const { port } = await startServer({ port: 0 }), base = `http://127.0.0.1:${port}`;
const id = 'run-t_robotcam_0001', idx = { segment: id, fps: 2, index: [{ robot: 'HM-M1', camera: 'head', label: '머리', rect: [0, 30, 256, 144] }, { robot: 'AM-01', camera: 'front', label: '전방', rect: [256, 30, 256, 144] }] };
await fetch(`${base}/api/robotcam?id=${id}&ext=webm`, { method: 'POST', body: fs.readFileSync(src) });
await fetch(`${base}/api/robotcam?id=${id}&ext=json`, { method: 'POST', body: JSON.stringify(idx) });
const st = await (await fetch(`${base}/api/status`)).json();
check('상태에 ffmpeg 표시', st.ffmpeg?.available === true, st.ffmpeg?.version);
const t0 = Date.now(), r = await fetch(`${base}/api/convert?kind=robotcam&id=${id}`), res = await r.json();
check('구간 MP4 변환 (전체 + 카메라별)', r.ok && res.mp4 === `${id}.mp4` && res.cameras.length === 2, `${((Date.now() - t0) / 1000).toFixed(1)}초`);
const probe = (f) => JSON.parse(spawnSync(ff.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', f]).stdout?.toString() || '{}').streams?.[0];
const hasProbe = fs.existsSync(ff.replace(/ffmpeg$/, 'ffprobe'));
const whole = path.join(dir, 'robotcam', `${id}.mp4`), cam = path.join(dir, 'robotcam', id, 'HM-M1_head.mp4');
check('전체 분할 MP4 (H.264 · yuv420p)', fs.existsSync(whole) && (!hasProbe || (probe(whole)?.codec_name === 'h264' && probe(whole)?.pix_fmt === 'yuv420p')));
check('카메라별 MP4 = 칸 크기 (256×144)', fs.existsSync(cam) && (!hasProbe || (probe(cam)?.width === 256 && probe(cam)?.height === 144)));
const g = await fetch(`${base}/videos/robotcam/${id}/HM-M1_head.mp4`);
check('링크 주소로 카메라별 MP4 내려받기', g.status === 200 && g.headers.get('content-type') === 'video/mp4' && (await g.arrayBuffer()).byteLength > 1000);
const again = await (await fetch(`${base}/api/convert?kind=robotcam&id=${id}`)).json();
check('같은 구간은 다시 변환하지 않음 (결과 재사용)', again.at === res.at);
const clip = await fetch(`${base}/api/clip-mp4?fps=8`, { method: 'POST', body: fs.readFileSync(src) }), cb = new Uint8Array(await clip.arrayBuffer());
check('개별 녹화 WebM → MP4', clip.ok && clip.headers.get('content-type') === 'video/mp4' && String.fromCharCode(...cb.slice(4, 8)) === 'ftyp');
// VLA 에피소드: JPEG 프레임(시각 간격 제각각) → MP4 (concat · 고정 fps · yuv420p)
const { zipStore } = await import('../js/aasx.js');
spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5:duration=2', path.join(dir, 'fr_%02d.jpg')]);
const jpgs = fs.readdirSync(dir).filter((f) => /^fr_\d+\.jpg$/.test(f)).sort();
const durs = jpgs.map((_, i) => (i === 3 ? 0.6 : 0.2));   // 한 프레임은 캡처가 건너뛰어 0.6초 머묾
const fz = zipStore([...jpgs.map((f, i) => ({ path: `frame_${String(i).padStart(5, '0')}.jpg`, data: fs.readFileSync(path.join(dir, f)) })), { path: 'durations.json', data: JSON.stringify(durs) }]);
const fr = await fetch(`${base}/api/frames-mp4?fps=5`, { method: 'POST', body: fz }), fb = Buffer.from(await fr.arrayBuffer()); fs.writeFileSync(path.join(dir, 'ep.mp4'), fb);
const pe = hasProbe ? probe(path.join(dir, 'ep.mp4')) : null, nf = hasProbe ? Number(spawnSync(ff.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path.join(dir, 'ep.mp4')]).stdout.toString().trim()) : 0;
const expect = Math.round(durs.reduce((a, b) => a + b, 0) * 5);
check('VLA 에피소드 프레임 → MP4 (H.264 · yuv420p · 시각 간격 유지)', fr.ok && (!hasProbe || (pe.codec_name === 'h264' && pe.pix_fmt === 'yuv420p' && Math.abs(nf - expect) <= 1)), `${jpgs.length}장 → ${nf}프레임(5fps · 기대 ${expect}) · ${fb.length}B`);
const bad = await fetch(`${base}/videos/robotcam/${id}/..%2F..%2Fx.mp4`), bad2 = await fetch(`${base}/api/convert?kind=etc&id=${id}`);
check('잘못된 경로·종류 거부', bad.status === 404 && bad2.status === 400);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
