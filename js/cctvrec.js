// CCTV 영상 저장 — ① 자동 녹화(NVR): 설치된 CCTV 전체 분할 화면(전광판과 같은 배치 · AI 오버레이 · 시각)을 WebM 영상으로 계속 녹화해
//   5분 구간 파일로 저장한다. 맥 앱·node server.mjs는 서버(data/cctv/)에, 서버가 없으면 브라우저에 최근 2구간을 보관한다.
//   구간마다 카메라 배치 색인(JSON: 카메라 ID · 위치 · 영상 속 칸 좌표)을 같이 남겨, 칸을 잘라 카메라별 영상으로 나눌 수 있다.
// ② 개별 저장: CCTV 정보 창에서 그 카메라 영상을 녹화(WebM)하거나 스냅샷(JPEG)으로 로컬 파일에 저장한다.
// 영상은 시뮬레이션 장면을 CCTV 카메라 시점으로 렌더한 것이다 (MediaRecorder · canvas.captureStream).
import * as THREE from 'three';

export const REC = { fps: 2, segS: 300, keep: 2, width: 2592, bitrate: 1_100_000 };   // 2fps · 5분 구간 · 칸 288×162(9열 기준) · 구간 약 40MB
const FONT = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
// MP4 변환 요청 (서버 ffmpeg 큐): 최근 구간부터 · 기다리는 시간은 budgetMs까지 — 넘으면 기다리지 않고 돌려준다(서버는 이어서 변환, 다음 저장 때 MP4 링크)
// 돌려주는 값: { done(이번에 끝난 구간), ready(MP4 있는 구간), total(대상), pending(남은 구간) }
export async function convertSegs(kind, segs, { budgetMs = 20000, onProgress } = {}) {
  const list = segs.filter((s) => s.stored).reverse(), todo = list.filter((s) => !s.mp4), t0 = performance.now();
  let done = 0;
  for (const s of todo) {
    const left = budgetMs - (performance.now() - t0); if (left <= 0) break;
    onProgress?.(done, todo.length);
    const req = fetch(`/api/convert?kind=${kind}&id=${encodeURIComponent(s.id)}`).then(async (r) => { if (r.ok) s.mp4 = await r.json(); return r.ok; }).catch(() => false);
    const ok = await Promise.race([req, new Promise((res) => setTimeout(() => res('late'), left))]);
    if (ok === 'late') break;
    if (ok) done++;
  }
  const ready = list.filter((s) => s.mp4).length;
  return { done, ready, total: list.length, pending: list.length - ready };
}
const two = (n) => String(n).padStart(2, '0');
export const recSupported = () => typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
export const pickMime = () => ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';

// 로컬 파일 저장 (맥 앱은 저장 대화상자 · 브라우저는 다운로드)
export function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

export class CCTVRecorder {
  constructor(cctvView, getRenderer) {
    this.cv = cctvView; this.getRenderer = getRenderer;
    this.on = false; this.server = false; this.segs = []; this.seq = 0; this.saved = 0; this.bytes = 0; this.failed = 0;
    this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    // 전광판 렌더 타깃 + 오버레이를 한 장으로 합성하는 작은 장면
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 2); this.cam.position.z = 1;
    this.base = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }));
    this.over = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, toneMapped: false }));
    this.over.position.z = 0.01; this.scene.add(this.base, this.over);
  }
  // 운전 시작·단계 전환 때: 지금 녹화 중인 구간을 닫고 새로 시작
  attach(sim, runId, iso) {
    if (this.rec) this.stopSegment();   // 이전 실행의 시계로 먼저 닫는다 (새 시뮬레이션을 붙인 뒤 닫으면 종료 시각이 0초 근처로 찍혀 길이가 음수가 됐다)
    this.sim = sim; this.runId = runId; this.iso = iso; this.gen = (this.gen ?? 0) + 1;   // 실행 세대 — 이전 실행에서 건 비동기 읽기를 가려낸다
    this.on = recSupported() && !globalThis.window?.JIN3D_SHARED;   // 공유 페이지(아티팩트)는 파일 저장이 막혀 있어 녹화하지 않는다
    this.cv.recording = this.on;
    this.acc = 1e9;
  }
  size() {
    const W = this.cv.cols * 384, H = this.cv.rows * 216, w = REC.width, h = Math.round((w * H) / W / 2) * 2;
    return { w, h, head: 34 };
  }
  // 카메라 배치 색인: 영상 속 칸 좌표(px)
  index() {
    const { w, h, head } = this.size(), cw = w / this.cv.cols, ch = (h) / this.cv.rows;
    return this.cv.slots.map((c, k) => ({ id: c.id, place: this.cv.place(c), region: c.region, x: c.x, z: c.z, rect: [Math.round((k % this.cv.cols) * cw), head + Math.round(Math.floor(k / this.cv.cols) * ch), Math.round(cw), Math.round(ch)] }));
  }
  startSegment() {
    const { w, h, head } = this.size();
    this.canvas.width = w; this.canvas.height = h + head;
    this.ctx.fillStyle = '#05080c'; this.ctx.fillRect(0, 0, w, h + head);
    const stream = this.canvas.captureStream(REC.fps);   // 고정 fps 스트림 (수동 requestFrame은 창이 가려지면 빈 프레임이 들어갈 수 있다)
    this.track = stream.getVideoTracks()[0];
    const mime = pickMime();
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: REC.bitrate });
    const seg = { no: ++this.seq, id: `${this.runId}_cctv_${String(this.seq).padStart(4, '0')}`, t0: this.sim.time, iso0: this.iso(this.sim.time), real0: performance.now(), chunks: [], mode: this.sim.mode.key, cams: this.cv.slots.length, index: this.index(), size: [w, h + head], mime: mime || 'video/webm' };
    rec.ondataavailable = (e) => { if (e.data?.size) seg.chunks.push(e.data); };
    seg.done = new Promise((res) => { seg.resolve = res; });
    rec.onstop = () => this.finish(seg).finally(() => seg.resolve());
    rec.start(10_000);   // 10초마다 버퍼를 받아 둔다 (구간 끝에 한 파일로 묶음)
    this.rec = rec; this.seg = seg;
  }
  // AAS 저장 직전: 진행 중 구간을 마감·저장 (링크가 최신 영상까지 가리키게)
  async flush() { const seg = this.seg; if (!seg) return null; this.stopSegment(); await seg.done; return seg; }
  // AAS(공장 자산)용 영상 링크: 구간마다 전체 분할 영상 하나 + 카메라 배치 색인
  videos() {
    const o = location.origin, out = [];
    for (const s of this.segs) {
      const base = { segment: s.id, file: `${s.id}.webm`, start: s.iso0, end: s.iso1, fps: REC.fps, stored: !!s.stored, index: `${s.id}.json`, blob: s.blob,
        url: s.stored ? `${o}/videos/cctv/${s.id}.webm` : null, localPath: s.stored && this.dir ? `${this.dir}/${s.id}.webm` : `${s.id}.webm` };
      out.push({ ...base, camera: 'cctv_all', label: `CCTV ${s.cams}대 전체 분할 (칸 = 카메라, 색인 JSON)`, rect: null, ...(s.mp4 ? { mp4Url: `${o}/videos/cctv/${s.id}.mp4`, mp4Path: this.dir ? `${this.dir}/${s.id}.mp4` : `${s.id}.mp4` } : {}) });
      // ffmpeg로 잘라 낸 카메라별 MP4
      for (const c of s.mp4?.cameras ?? []) out.push({ ...base, blob: null, camera: c.robot, label: `${c.robot} · ${c.label}`, rect: s.index.find((x) => x.id === c.robot)?.rect ?? null,
        mp4Url: `${o}/videos/cctv/${c.file}`, mp4Path: this.dir ? `${this.dir}/${c.file}` : c.file });
    }
    return out;
  }
  async convertAll(opts = {}) {   // 최근 구간부터 · budgetMs까지만 기다림 (convertSegs)
    if (!this.server || !this.ffmpeg) return { done: 0, ready: 0, total: 0, pending: 0 };
    return convertSegs('cctv', this.segs, opts);
  }
  // 가장 최근 구간 MP4(서버 ffmpeg) — 변환이 끝날 때까지 기다렸다가 로컬 파일로
  async saveLatestMp4() {
    const s = [...this.segs].reverse().find((x) => x.stored); if (!s || !this.ffmpeg) return false;
    const r = await fetch(`/api/convert?kind=cctv&id=${encodeURIComponent(s.id)}`); if (!r.ok) return false; s.mp4 = await r.json();
    const v = await fetch(`/videos/cctv/${s.id}.mp4`); if (!v.ok) return false;
    saveBlob(await v.blob(), `${s.id}.mp4`); saveBlob(new Blob([JSON.stringify({ ...s.meta, mp4: s.mp4 }, null, 1)], { type: 'application/json' }), `${s.id}.json`);
    return true;
  }
  stopSegment() {
    if (!this.rec) return;
    this.seg.t1 = this.sim.time; this.seg.iso1 = new Date(Date.parse(this.seg.iso0) + (this.seg.t1 - this.seg.t0) * 1000).toISOString(); this.seg.realS = (performance.now() - this.seg.real0) / 1000;
    try { this.rec.stop(); } catch { /* 이미 멈춤 */ }
    this.rec = null; this.seg = null; this.track = null;
  }
  async finish(seg) {
    const blob = new Blob(seg.chunks, { type: seg.mime.split(';')[0] }); seg.chunks = null;
    seg.blob = blob; seg.bytes = blob.size;
    const meta = { segment: seg.id, format: 'WebM (VP9/VP8) — CCTV 전체 분할 녹화 (NVR)', fps: REC.fps, size: seg.size, factory_mode: seg.mode, cameras: seg.cams,
      start: seg.iso0, end: seg.iso1, sim_seconds: Math.round((seg.t1 - seg.t0) * 10) / 10, real_seconds: Math.round(seg.realS * 10) / 10,
      note: '칸(rect = [x, y, 폭, 높이] px)을 잘라 카메라별 영상으로 나눌 수 있습니다 — 예: ffmpeg -i 파일.webm -filter:v "crop=w:h:x:y" 카메라.mp4', index: seg.index };
    seg.meta = meta;
    this.segs.push(seg); while (this.segs.length > REC.keep) this.segs.shift().blob = null;
    if (this.server && blob.size) {
      try {
        const r = await fetch(`/api/cctv?id=${encodeURIComponent(seg.id)}&ext=webm`, { method: 'POST', body: blob });
        const rj = await fetch(`/api/cctv?id=${encodeURIComponent(seg.id)}&ext=json`, { method: 'POST', body: JSON.stringify(meta, null, 1) });
        if (r.ok && rj.ok) { this.saved++; this.bytes += blob.size; seg.stored = true; } else this.failed++;
      } catch { this.failed++; }
    }
  }
  // 매 프레임: 녹화 fps마다 전광판을 합성해 한 장 넣고, 5분마다 구간을 바꾼다
  update(rdt) {
    if (!this.on || !this.sim || this.cv.lost || !this.cv.slots.length) return;
    if (document.hidden) return;
    if (!this.rec) this.startSegment();
    if ((performance.now() - this.seg.real0) / 1000 >= REC.segS) { this.stopSegment(); this.startSegment(); }
    // 녹화 주기는 실제 경과 시간으로 (프레임 시간 rdt는 0.1초로 잘려 들어와, 화면이 느리면 2장/초보다 훨씬 덜 찍혔다)
    const now = performance.now() / 1000; this.acc += Math.min(1, now - (this.lastNow ?? now)); this.lastNow = now;
    if (this.acc < 1 / REC.fps) return; this.acc = Math.min(this.acc - 1 / REC.fps, 1 / REC.fps);   // 남은 시간을 넘겨 평균 주기를 맞춤
    this.capture();
  }
  // 녹화 한 장: 전광판을 합성해 그린 뒤 비동기로 읽어(GPU를 멈추지 않음) 받으면 캔버스에 그린다. 시각·구간 표시는 읽기를 건 시점 값.
  // 앞 읽기가 아직이면 이번 장은 건너뛴다. 읽기를 건 구간 · 실행 세대 · 시계를 잡아 두고, 끝났을 때 그 구간이 그대로 열려 있을 때만 그린다
  // (버퍼 · 해상도만 보면 구간을 바꾼 뒤 이전 구간 프레임이 새 구간 영상에 들어가고, 실행을 바꾼 뒤에는 새 시계로 이전 시각이 찍혔다)
  capture() {
    if (this.reading || !this.seg) return;
    const r = this.getRenderer(), { w, h, head } = this.size(), cv = this.cv;
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) { this.rt?.dispose(); this.rt = new THREE.WebGLRenderTarget(w, h); this.rt.texture.colorSpace = THREE.SRGBColorSpace; this.buf = new Uint8Array(w * h * 4); this.img = new ImageData(w, h); }
    if (this.canvas.width !== w || this.canvas.height !== h + head) { this.stopSegment(); return; }   // 배치가 바뀌면(공정 설계) 새 구간
    if (this.base.material.map !== cv.rt.texture || this.over.material.map !== cv.overTex) { this.base.material.map = cv.rt.texture; this.over.material.map = cv.overTex; this.base.material.needsUpdate = this.over.material.needsUpdate = true; }
    const prev = r.getRenderTarget(), auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.rt); r.setClearColor(0x05080c, 1); r.clear(); r.render(this.scene, this.cam); r.setRenderTarget(prev); r.shadowMap.autoUpdate = auto;
    const buf = this.buf, seg = this.seg, gen = this.gen, iso = this.iso, t = this.sim.time, label = `REC · CCTV ${cv.slots.length}대 전체 · ${this.sim.mode.label} · 피지컬AI 실증 메타팩토리 NVR`;
    this.reading = true;
    r.readRenderTargetPixelsAsync(this.rt, 0, 0, w, h, buf).then(() => { this.reading = false; if (this.seg === seg && this.gen === gen && this.buf === buf && this.canvas.width === w && this.canvas.height === h + head) this.paint(w, h, head, t, seg.no, label, iso); }, () => { this.reading = false; });
  }
  paint(w, h, head, t, no, label, iso = this.iso) {
    const row = w * 4; for (let y = 0; y < h; y++) this.img.data.set(this.buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    const g = this.ctx; g.putImageData(this.img, 0, head);
    // 머리 띠: ● REC · 카메라 수 · 공장 단계 · 시각 · 구간
    g.fillStyle = '#05080c'; g.fillRect(0, 0, w, head);
    g.fillStyle = Math.floor(performance.now() / 600) % 2 ? '#ff4d4d' : '#7a2020'; g.beginPath(); g.arc(18, head / 2, 7, 0, Math.PI * 2); g.fill();
    g.font = `800 18px ${FONT}`; g.fillStyle = '#e8edf2'; g.textBaseline = 'middle';
    g.fillText(label, 34, head / 2);
    g.textAlign = 'right'; g.fillStyle = '#7fb8cc'; g.fillText(`${iso(t).replace('T', ' ').slice(0, 19)} UTC · 구간 #${no ?? '-'}`, w - 12, head / 2); g.textAlign = 'left';
  }
  stats() {
    const cur = this.seg ? (performance.now() - this.seg.real0) / 1000 : 0;
    return { on: this.on, server: this.server, seq: this.seq, saved: this.saved, bytes: this.bytes, failed: this.failed, cur, kept: this.segs.filter((s) => s.blob).length, last: this.segs.at(-1) ?? null };
  }
  // 브라우저에 보관한 가장 최근 구간을 파일로 (영상 + 색인)
  saveLatest() {
    const s = [...this.segs].reverse().find((x) => x.blob); if (!s) return false;
    saveBlob(s.blob, `${s.id}.webm`); saveBlob(new Blob([JSON.stringify(s.meta, null, 1)], { type: 'application/json' }), `${s.id}.json`);
    return true;
  }
}

// 개별 CCTV 녹화: CCTV 정보 창 영상 캔버스를 그대로 녹화해 로컬 파일로
export class CameraClip {
  constructor() { this.rec = null; }
  get active() { return !!this.rec; }
  start(canvas, camId, label) {
    if (this.rec || !recSupported()) return false;
    const stream = canvas.captureStream(8), mime = pickMime(), chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 1_500_000 });
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const t0 = new Date(), name = `CCTV_${camId}_${t0.getFullYear()}${two(t0.getMonth() + 1)}${two(t0.getDate())}_${two(t0.getHours())}${two(t0.getMinutes())}${two(t0.getSeconds())}.webm`;
    rec.onstop = async () => {
      const b = new Blob(chunks, { type: 'video/webm' }); if (!b.size) return;
      // 서버에 ffmpeg가 있으면 MP4(H.264)로 바꿔 저장, 없으면 WebM 그대로
      if (this.mp4?.()) {
        this.converting = true;
        try { const r = await fetch('/api/clip-mp4?fps=8', { method: 'POST', body: b }); if (r.ok) { const m = await r.blob(); const n2 = name.replace(/\.webm$/, '.mp4'); saveBlob(m, n2); this.last = { name: n2, bytes: m.size, label }; this.converting = false; return; } } catch { /* WebM으로 */ }
        this.converting = false;
      }
      saveBlob(b, name); this.last = { name, bytes: b.size, label };
    };
    rec.start(1000);
    this.rec = rec; this.cam = camId; this.t0 = performance.now(); this.name = name;
    return true;
  }
  stop() { if (!this.rec) return; try { this.rec.stop(); } catch { /* 무시 */ } this.rec = null; }
  get secs() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }
}
// 스냅샷: 지금 화면(오버레이 포함)을 JPEG로
export function saveSnapshot(canvas, camId) {
  const t = new Date(), name = `CCTV_${camId}_${t.getFullYear()}${two(t.getMonth() + 1)}${two(t.getDate())}_${two(t.getHours())}${two(t.getMinutes())}${two(t.getSeconds())}.jpg`;
  canvas.toBlob((b) => b && saveBlob(b, name), 'image/jpeg', 0.92);
  return name;
}
