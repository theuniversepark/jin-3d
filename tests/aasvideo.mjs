// AAS 영상 링크 검증 — 로봇 카메라 영상 파일 링크가 AAS VideoRecordings 서브모델(JSON·XML)에 들어가고, AASX에는 영상 링크 파일(.url)·목록(JSON)이 함께 담기는지,
// 서버가 로봇 카메라 영상 구간을 data/robotcam/에 저장하고 링크 주소(/videos/robotcam/…)로 내려주는지. 실행: npm test
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildRobotEnvironment, videoLinkFiles, toXML, SEM } from '../js/aas.js';
import { buildAASX } from '../js/aasx.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== AAS 영상 링크 (로봇 카메라 녹화)');
const asset = { id: 'HUM_MNT_1', kind: 'Humanoid', name: '휴머노이드-정비1', nameplate: { manufacturer: 'J', product: 'H', serial: 'S', year: '2026' }, tech: {}, fields: [{ idShort: 'Battery', label: '배터리', type: 'double', unit: '%' }] };
const videos = ['head', 'handL', 'handR', 'back'].map((c, i) => ({ segment: 'run-x_robotcam_0001', file: 'run-x_robotcam_0001.webm', camera: c, label: `${c} 카메라`, rect: [i * 256, 30, 256, 144], start: '2026-10-05T00:00:00Z', end: '2026-10-05T00:05:00Z', fps: 2,
  url: 'http://127.0.0.1:5000/videos/robotcam/run-x_robotcam_0001.webm', localPath: '/data/robotcam/run-x_robotcam_0001.webm', index: 'run-x_robotcam_0001.json' }));
const links = videoLinkFiles(asset.id, videos);
const env = buildRobotEnvironment({ asset, samples: [], detail: null, last: null, opts: { videos } });
const sm = env.submodels.find((s) => s.idShort === 'VideoRecordings');
check('VideoRecordings 서브모델 (자산 셸에 연결)', !!sm && sm.semanticId.keys[0].value === SEM.videos && env.assetAdministrationShells[0].submodels.some((r) => r.keys[0].value === sm.id));
const vs = sm.submodelElements.find((e) => e.idShort === 'Videos').value;
check('카메라마다 영상 항목 (머리 · 양손 · 등)', vs.length === 4 && vs.every((v) => v.value.some((e) => e.modelType === 'File' && e.idShort === 'Video' && e.contentType === 'video/webm' && /\/videos\/robotcam\//.test(e.value))), `${vs.length}개`);
check('칸 좌표 · 시각 · 로컬 경로 · 색인', vs.every((v) => ['CropRect', 'StartTime', 'EndTime', 'LocalPath', 'IndexFile'].every((k) => v.value.some((e) => e.idShort === k && e.value))));
check('AASX 링크 파일 경로를 File(LinkFile)로', vs.every((v) => v.value.some((e) => e.idShort === 'LinkFile' && e.value.startsWith('/aasx/HUM_MNT_1/files/videos/') && e.value.endsWith('.url'))));
check('링크 파일 내용 (.url 인터넷 바로가기)', links.filter((l) => l.path.endsWith('.url')).every((l) => /^\[InternetShortcut\]\r\nURL=http:\/\/127\.0\.0\.1:5000\/videos\/robotcam\//.test(l.data)) && links.some((l) => l.path.endsWith('video_links.json')));
const xml = toXML(env);
check('AAS XML에 영상 File 요소', /<idShort>Video<\/idShort>[\s\S]*?<contentType>video\/webm<\/contentType>/.test(xml));
const aasx = buildAASX(asset.id, xml, links), txt = new TextDecoder('latin1').decode(aasx);
check('AASX 패키지에 링크 파일 · 목록 · 관계(aas-suppl)', links.every((l) => txt.includes(l.path.slice(1))) && /aas-suppl[^>]*videos\/[^"]+\.url/.test(txt) && /Extension="url"/.test(txt));
// 서버: 로봇 카메라 영상 저장 · 링크 주소로 내려받기
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-rc-')); process.env.JIN3D_DATA_DIR = dir;
const { startServer } = await import('../server/app-server.mjs');
const { port } = await startServer({ port: 0 }), base = `http://127.0.0.1:${port}`;
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7]);
const up = await fetch(`${base}/api/robotcam?id=run-x_robotcam_0001&ext=webm`, { method: 'POST', body: webm });
const got = await fetch(`${base}/videos/robotcam/run-x_robotcam_0001.webm`), body = new Uint8Array(await got.arrayBuffer());
check('서버 저장 → 링크 주소로 영상 내려받기', up.ok && got.status === 200 && got.headers.get('content-type') === 'video/webm' && body.length === webm.length && fs.existsSync(path.join(dir, 'robotcam', 'run-x_robotcam_0001.webm')));
const st = await (await fetch(`${base}/api/status`)).json(), ls = await (await fetch(`${base}/api/robotcam`)).json();
check('상태 · 목록 (로봇 카메라 영상 저장 경로)', st.robotcam === true && st.dataDir === dir && ls.count === 1);
const bad = await fetch(`${base}/videos/robotcam/..%2F..%2Fetc.webm`), bad2 = await fetch(`${base}/videos/other/x.webm`);
check('링크 주소 경로 탈출 거부', bad.status === 404 && bad2.status === 404);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
