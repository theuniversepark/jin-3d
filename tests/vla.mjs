// VLA 에피소드 파일 검증 — 휴머노이드·AMMR 에피소드는 카메라 4대(머리 · 왼손 · 오른손 · 등) 프레임을 같은 시각으로 함께 담는지,
// 스텝마다 observation.images.<카메라> 경로와 스키마(meta/info.json)가 맞는지, 6축 로봇은 손목 카메라 하나 그대로인지. 실행: npm test
import { buildEpisodesZip, EP_CAMS } from '../js/vla.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const files = (z) => { const t = new TextDecoder('latin1').decode(z); return [...new Set([...t.matchAll(/((?:videos|data|meta)\/[\w./-]+?\.(?:jpg|mp4|jsonl|json))/g)].map((m) => m[1]))]; };
const text = (z, path) => { const t = new TextDecoder().decode(z), i = t.indexOf(path); return t.slice(i + path.length, i + path.length + 6000); };
console.log('== VLA 에피소드 · 카메라 4대 (휴머노이드 · AMMR)');
check('카메라 키 = 머리 · 왼손 · 오른손 · 등', EP_CAMS.join() === 'head,handL,handR,back');
const steps = [0, 1, 2].map((i) => ({ i, t: i * 0.2, ts: `2026-10-05T00:00:0${i}Z`, state: [0.1 * i, 0, 0], action: [0, 0, 0], tcp_mm: [1, 2, 3], gripper: 0, phase: i ? 'manipulate' : 'navigate',
  frames: i === 1 ? null : Object.fromEntries(EP_CAMS.map((c) => [c, `${c}/frame_00${i ? 1 : 0}.jpg`])), frame: null }));
steps.forEach((s) => { if (!s.frames) delete s.frames; else s.frame = s.frames.head; });
const ep = { id: 'ep_000001', robot: 'HM-M1', cell: 'mobile', cell_name: '정비 휴머노이드', robot_kind: 'humanoid', instruction: '긴급수리', model_version: 'v1.0', start: 'a', end: 'b', duration_s: 0.4, length: 3, fps: 5, success: true, termination: '정상 완료',
  steps, frames: ['000', '001'].flatMap((n) => EP_CAMS.map((c) => ({ file: `${c}/frame_${n}.jpg`, cam: c, t: 0, data: jpg }))), jointNames: ['허리 회전', '머리 회전', '베이스 x'], jointUnits: ['rad', 'rad', 'mm'], cameras: EP_CAMS, mobile: true, task: '긴급수리' };
const z = await buildEpisodesZip('HM-M1', [ep], 'test'), fl = files(z);
check('카메라별 영상 폴더 (videos/<에피소드>/<카메라>/frame_*.jpg)', EP_CAMS.every((c) => fl.includes(`videos/ep_000001/${c}/frame_000.jpg`) && fl.includes(`videos/ep_000001/${c}/frame_001.jpg`)), `${fl.filter((f) => f.endsWith('.jpg')).length}장`);
const info = JSON.parse(new TextDecoder().decode(z).match(/\{\n  "dataset"[\s\S]*?\n\}/)[0]);
check('스키마: observation.images.head · handL · handR · back', EP_CAMS.every((c) => info.features[`observation.images.${c}`]?.dtype === 'jpeg') && !info.features['observation.image'], Object.keys(info.features).filter((k) => k.startsWith('observation.images')).join(' '));
check('로봇 카메라 목록 · Atlas 자유도 표기', info.robot.cameras.join() === EP_CAMS.join() && /360°/.test(info.robot.dof_note ?? ''));
const line0 = JSON.parse(text(z, 'data/ep_000001.jsonl').split('\n').find((l) => l.startsWith('{"step":0')));
check('스텝마다 네 카메라 같은 시각 프레임 경로', EP_CAMS.every((c) => line0[`observation.images.${c}`] === `videos/ep_000001/${c}/frame_000.jpg`));
const arm = { ...ep, id: 'ep_000002', robot: 'RB-02-1', robot_kind: 'cobot', cameras: ['wrist'], mobile: false, steps: [{ ...steps[0], frames: undefined, frame: 'frame_000.jpg' }], frames: [{ file: 'frame_000.jpg', t: 0, data: jpg }], length: 1 };
const z2 = await buildEpisodesZip('RB-02-1', [arm], 'test');
check('6축 로봇은 손목 카메라 하나 (observation.image)', files(z2).includes('videos/ep_000002/frame_000.jpg') && /"observation\.image"/.test(new TextDecoder().decode(z2)));
console.log('== VLA 에피소드 · 카메라 영상 MP4 (서버 ffmpeg가 있을 때)');
const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);   // ftyp
const vsteps = [0, 1, 2].map((i) => ({ i, t: i * 0.2, ts: `t${i}`, state: [i], action: [i], tcp_mm: [0, 0, 0], gripper: 0, phase: 'grasp', frame: null, video: Object.fromEntries(EP_CAMS.map((c) => [c, i * 0.2])) }));
const vep = { ...ep, id: 'ep_000003', steps: vsteps, length: 3, frames: [], frameCount: 12, videos: Object.fromEntries(EP_CAMS.map((c) => [c, { file: `${c}.mp4`, data: mp4, fps: 5, frames: 3, t0: 0, width: 160, height: 120 }])) };
const z3 = await buildEpisodesZip('HM-M1', [vep], 'test'), f3 = files(z3);
check('카메라별 MP4 영상 (videos/<에피소드>/<카메라>.mp4, 사진 없음)', EP_CAMS.every((c) => f3.includes(`videos/ep_000003/${c}.mp4`)) && !f3.some((f) => f.endsWith('.jpg')), f3.filter((f) => f.endsWith('.mp4')).join(' '));
const info3 = JSON.parse(new TextDecoder().decode(z3).match(/\{\n  "dataset"[\s\S]*?\n\}/)[0]);
check('스키마: dtype video · fps · h264 · yuv420p (LeRobot 형식)', EP_CAMS.every((c) => { const F = info3.features[`observation.images.${c}`]; return F?.dtype === 'video' && F.info['video.fps'] === 5 && F.info['video.codec'] === 'h264' && F.info['video.pix_fmt'] === 'yuv420p'; }) && /v2/.test(info3.format));
const l3 = text(z3, 'data/ep_000003.jsonl').split('\n').filter((l) => l.startsWith('{"step"')).map((l) => JSON.parse(l));
check('스텝마다 {영상 경로, 타임스탬프}로 프레임을 가리킴', l3.length === 3 && l3.every((r, k) => EP_CAMS.every((c) => r[`observation.images.${c}`]?.path === `videos/ep_000003/${c}.mp4` && Math.abs(r[`observation.images.${c}`].timestamp - k * 0.2) < 1e-9)), JSON.stringify(l3[2]['observation.images.head']));
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
