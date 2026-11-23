// 자동 녹화 비동기 읽기 경합 검증 — 검수보고서 R12: GPU 비동기 읽기가 끝났을 때 버퍼 · 해상도만 같으면 그려서,
// 구간을 바꾼 뒤 이전 구간 프레임이 새 구간 영상에 들어가고, 실행을 바꾼 뒤에는 새 실행의 시계로 이전 시각이 찍혔다.
// 지연 Promise(느린 GPU)로: 구간 1에서 읽기 → 구간 닫기 · 구간 전환 · 단계(실행) 변경 · 해상도 변경 → 읽기 완료 → 그리지 않음. 같은 구간이면 읽기를 건 시점의 구간 · 시각 · 시계로 그림. 실행: npm test
import fs from 'node:fs';
globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
globalThis.location = { origin: 'http://test' };
const { RobotVideoRecorder, RREC } = await import('../js/robotrec.js');
const { CCTVRecorder } = await import('../js/cctvrec.js');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const tick = async () => { for (let k = 0; k < 4; k++) await Promise.resolve(); };
const isoA = (t) => new Date(Date.UTC(2026, 0, 1) + t * 1000).toISOString(), isoB = (t) => new Date(Date.UTC(2030, 5, 1) + t * 1000).toISOString();
// 2D 캔버스 흉내: 머리 띠에 쓴 글자만 모은다
const fakeCtx = (texts) => new Proxy({}, { get: (o, k) => (k === 'fillText' ? (s) => texts.push(String(s)) : k in o ? o[k] : () => {}), set: (o, k, v) => ((o[k] = v), true) });

// 로봇 카메라 녹화기 — 렌더러 읽기는 시험이 직접 끝낸다 (reads: 걸린 읽기들)
function robotRec() {
  const reads = [], painted = [], rec = Object.create(RobotVideoRecorder.prototype), W = RREC.tw, H = RREC.th;
  Object.assign(rec, { cols: 1, rows: 1, tiles: [{ robot: 'R1', label: '손목' }], canvas: { width: W, height: H + RREC.head }, buf: new Uint8Array(W * H * 4), img: new ImageData(W, H),
    sim: { time: 7, mode: { key: 'dark', label: '피지컬AI' } }, iso: isoA, runId: 'runA', seq: 1, seg: { no: 1, t0: 0, iso0: isoA(0), real0: 0 },
    cw: { renderer: { readRenderTargetPixelsAsync: () => new Promise((res, rej) => reads.push({ res, rej })) } } });
  const real = rec.paint; rec.texts = []; rec.ctx = fakeCtx(rec.texts);
  rec.paint = function (...a) { painted.push({ t: a[2], no: a[3], label: a[4], cur: this.seg?.no ?? null }); return real.apply(this, a); };
  return { rec, reads, painted };
}
console.log('== 로봇 카메라 녹화 (js/robotrec.js)');
{ const { rec, reads, painted } = robotRec();
  rec.capture(); reads[0].res(); await tick();
  check('같은 구간: 읽기가 끝나면 그 구간 번호 · 읽기를 건 시각으로 그림', painted.length === 1 && painted[0].no === 1 && painted[0].t === 7 && rec.texts.some((s) => s.includes('2026-01-01 00:00:07') && s.includes('구간 #1')), rec.texts.at(-1)); }
{ const { rec, reads, painted } = robotRec();
  rec.capture(); rec.seg = { no: 2, t0: 7, iso0: isoA(7), real0: 0 }; reads[0].res(); await tick();   // 5분 구간 전환 (같은 해상도 · 같은 버퍼)
  check('구간 전환 뒤 끝난 읽기: 새 구간 캔버스에 그리지 않음 (R12 최소 재현)', painted.length === 0, JSON.stringify(painted));
  rec.capture(); check('앞 읽기가 끝났으므로 새 구간에서 다시 읽기를 건다', reads.length === 2);
  reads[1].res(); await tick(); check('새 구간 읽기는 새 구간 번호로 그림', painted.length === 1 && painted[0].no === 2 && painted[0].cur === 2); }
{ const { rec, reads, painted } = robotRec();
  rec.capture(); rec.seg = null; reads[0].res(); await tick();   // 구간 닫기 (AAS 저장 직전 flush · 창 가림)
  check('구간을 닫은 뒤 끝난 읽기: 그리지 않음', painted.length === 0); }
{ const { rec, reads, painted } = robotRec();
  rec.rec = { stop() {} }; rec.capture();
  rec.attach({ time: 0.3, mode: { key: 'smart', label: '자동화' } }, 'runB', isoB);   // 단계(실행) 변경 — 이전 구간을 닫고 새 시계를 붙임
  rec.seg = { no: 2, t0: 0, iso0: isoB(0), real0: 0 }; reads[0].res(); await tick();
  check('실행 변경 뒤 끝난 읽기: 그리지 않음 (새 실행 시계로 이전 시각을 찍지 않음)', painted.length === 0 && !rec.texts.some((s) => s.includes('2030')), JSON.stringify(rec.texts)); }
{ const { rec, reads, painted } = robotRec();
  rec.capture(); rec.iso = isoB; rec.sim = { time: 99, mode: { label: '다른 단계' } }; reads[0].res(); await tick();   // 구간 객체가 같더라도 시각 · 시계 · 단계 표시는 읽기를 건 시점 것
  check('시각 표시는 읽기를 건 시점의 시계 · 시각 · 단계', painted.length === 1 && rec.texts.some((s) => s.includes('2026-01-01 00:00:07')) && !rec.texts.some((s) => s.includes('2030')) && rec.texts.some((s) => s.includes('피지컬AI')), rec.texts.at(-1)); }
{ const { rec, reads, painted } = robotRec();
  rec.capture(); rec.buf = new Uint8Array(rec.buf.length); reads[0].res(); await tick();   // 카메라 수가 바뀌어 렌더 타깃 · 버퍼를 새로 만든 경우
  check('해상도(버퍼) 변경 뒤 끝난 읽기: 그리지 않음', painted.length === 0);
  rec.capture(); rec.canvas.width = 512; reads[1].res(); await tick();
  check('캔버스 크기 변경 뒤 끝난 읽기: 그리지 않음', painted.length === 0); }
{ const { rec, reads, painted } = robotRec();
  rec.capture(); rec.capture(); rec.capture();   // 느린 GPU: 앞 읽기가 아직이면 건너뜀
  check('느린 GPU: 읽기가 밀려도 한 번에 하나만 걸림', reads.length === 1);
  reads[0].rej(new Error('context lost')); await tick(); rec.capture();
  check('읽기 실패 뒤에도 다음 장을 다시 건다 (그리지는 않음)', reads.length === 2 && painted.length === 0); }

// CCTV 녹화기
function cctvRec() {
  const reads = [], painted = [], rec = Object.create(CCTVRecorder.prototype);
  const mesh = () => ({ material: { map: null, needsUpdate: false } });
  Object.assign(rec, { cv: { cols: 3, rows: 2, slots: [{ id: 'CC-01' }], rt: { texture: {} }, overTex: {} }, base: mesh(), over: mesh(), scene: {}, cam: {},
    sim: { time: 7, mode: { key: 'dark', label: '피지컬AI' } }, iso: isoA, runId: 'runA', seq: 1, seg: { no: 1, t0: 0, iso0: isoA(0), real0: 0 } });
  const r = { shadowMap: { autoUpdate: true }, getRenderTarget: () => null, setRenderTarget() {}, setClearColor() {}, clear() {}, render() {}, readRenderTargetPixelsAsync: () => new Promise((res, rej) => reads.push({ res, rej })) };
  rec.getRenderer = () => r;
  const { w, h, head } = rec.size(); rec.canvas = { width: w, height: h + head };
  const real = rec.paint; rec.texts = []; rec.ctx = fakeCtx(rec.texts);
  rec.paint = function (...a) { painted.push({ t: a[3], no: a[4], cur: this.seg?.no ?? null }); return real.apply(this, a); };
  return { rec, reads, painted };
}
console.log('== CCTV 녹화 (js/cctvrec.js)');
{ const { rec, reads, painted } = cctvRec();
  rec.capture(); reads[0].res(); await tick();
  check('같은 구간: 읽기를 건 시각 · 구간 번호로 그림', painted.length === 1 && painted[0].no === 1 && rec.texts.some((s) => s.includes('2026-01-01 00:00:07') && s.includes('구간 #1')), rec.texts.at(-1)); }
{ const { rec, reads, painted } = cctvRec();
  rec.capture(); rec.seg = { no: 2, t0: 7, iso0: isoA(7), real0: 0 }; reads[0].res(); await tick();
  check('구간 전환 뒤 끝난 읽기: 그리지 않음', painted.length === 0, JSON.stringify(painted));
  rec.capture(); reads[1].res(); await tick(); check('새 구간 읽기는 새 구간 번호로 그림', painted.length === 1 && painted[0].no === 2); }
{ const { rec, reads, painted } = cctvRec();
  rec.capture(); rec.seg = null; reads[0].res(); await tick();
  check('구간을 닫은 뒤 끝난 읽기: 그리지 않음', painted.length === 0); }
{ const { rec, reads, painted } = cctvRec();
  rec.rec = { stop() {} }; rec.capture();
  rec.attach({ time: 0.3, mode: { key: 'smart', label: '자동화' } }, 'runB', isoB); rec.seg = { no: 2, t0: 0, iso0: isoB(0), real0: 0 }; reads[0].res(); await tick();
  check('실행 변경 뒤 끝난 읽기: 그리지 않음', painted.length === 0 && !rec.texts.some((s) => s.includes('2030'))); }
{ const { rec, reads, painted } = cctvRec();
  rec.capture(); rec.iso = isoB; rec.sim = { time: 99, mode: { label: '다른 단계' } }; reads[0].res(); await tick();
  check('시각 표시는 읽기를 건 시점의 시계 · 시각', painted.length === 1 && rec.texts.some((s) => s.includes('2026-01-01 00:00:07')) && !rec.texts.some((s) => s.includes('2030')), rec.texts.at(-1)); }
{ const { rec, reads, painted } = cctvRec();
  rec.capture(); rec.cv.cols = 4; rec.capture();   // 배치 변경(해상도 변경) 중 읽기가 밀려 있음 — 앞 읽기는 아직 이전 배치 구간 · 이전 캔버스 것
  reads[0].res(); await tick();
  check('해상도 변경 직전에 건 읽기: 아직 열려 있는 이전 구간에만 그림', painted.length === 1 && painted[0].no === 1 && painted[0].cur === 1 && rec.seg?.no === 1);
  rec.rec = { stop() {} }; rec.capture();
  check('해상도 변경: 다음 장에서 구간을 닫고 읽기를 걸지 않음', rec.seg === null && reads.length === 1);
  const { w, h, head } = rec.size(); rec.canvas = { width: w, height: h + head }; rec.seg = { no: 2, t0: 7, iso0: isoA(7), real0: 0 };   // 새 배치로 새 구간
  rec.capture(); rec.buf = new Uint8Array(8); reads[1].res(); await tick();
  check('렌더 타깃 · 버퍼를 새로 만든 뒤 끝난 읽기: 그리지 않음', reads.length === 2 && painted.length === 1); }

console.log('== 같은 패턴 점검 (에피소드 캡처 · 영상 프레임 발행)');
{ const src = (f) => fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
  const rc = src('robotcam.js'), cap = rc.slice(rc.indexOf('captureFrame(ref'), rc.indexOf('drawDetections(g, cam'));
  check('에피소드 캡처(captureFrame): 읽기마다 버퍼를 따로 잡는다 (다른 장과 섞이지 않음)', /const buf = new Uint8Array\(w \* h \* 4\), read = r\.readRenderTargetPixelsAsync/.test(cap));
  const vla = src('vla.js');
  check('에피소드 프레임은 요청 시점의 기록 · 시각에 붙는다', /rec\.frames\.push\(\{ file: fname, cam, t: q\.ct, data: this\.camWall\.captureFrame/.test(vla));
  const m = src('main.js'), p0 = m.indexOf('function pcapVideoTick'), pv = m.slice(p0, m.indexOf('\nfunction ', p0 + 10));
  check('영상 프레임 발행(pcapVideoTick): 실행이 바뀐 뒤 끝난 캡처는 버린다', (pv.match(/sim [!=]== s0/g) ?? []).length >= 3 && /\bs0 = sim\b/.test(pv)); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
