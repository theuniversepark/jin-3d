// 로봇 카메라 영상 자동 녹화 — 공장의 모든 로봇 카메라(셀 로봇 손목 · AMMR·휴머노이드 머리·양손·등 · AMR·AGV·지게차·사족보행 전방 · 드론 짐벌)를
// 한 분할 화면(칸 256×144)으로 렌더해 WebM 영상으로 계속 녹화하고 5분 구간 파일로 로컬(서버 data/robotcam/)에 저장한다.
// 구간마다 칸 색인(JSON: 로봇 · 카메라 · AAS 자산 · 칸 좌표)을 같이 남기고, AAS 파일을 만들 때 그 로봇이 찍힌 영상 파일 링크를 넣는다(aas.js videoSubmodel).
import * as THREE from 'three';
import { recSupported, pickMime, saveBlob } from './cctvrec.js';
// 카메라별 MP4 파일 이름 (server/video-convert.mjs camFile과 같은 규칙)
export const camFile = (t) => `${String(t.robot ?? t.id ?? 'cam').replace(/[^A-Za-z0-9_-]/g, '_')}_${String(t.camera ?? 'view').replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`;

export const RREC = { fps: 2, segS: 300, keep: 2, tw: 256, th: 144, cols: 9, perFrame: 3, bitrate: 1_200_000, head: 30 };
const FONT = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';

export class RobotVideoRecorder {
  constructor(camWall) {
    this.cw = camWall; this.on = false; this.server = false; this.dir = null; this.origin = location.origin;
    this.segs = []; this.seq = 0; this.saved = 0; this.bytes = 0; this.failed = 0; this.tiles = []; this.cams = []; this.k = 0;
    this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d');
  }
  attach(sim, runId, iso) {
    this.sim = sim; this.runId = runId; this.iso = iso;
    if (this.rec) this.stopSegment();
    this.on = recSupported() && !globalThis.window?.JIN3D_SHARED;
    this.acc = 1e9;
  }
  layout() {
    this.tiles = this.cw.allCameras();
    const n = Math.max(1, this.tiles.length), cols = Math.min(RREC.cols, n), rows = Math.ceil(n / cols);
    this.cols = cols; this.rows = rows;
    const W = cols * RREC.tw, H = rows * RREC.th;
    if (!this.rt || this.rt.width !== W || this.rt.height !== H) { this.rt?.dispose(); this.rt = new THREE.WebGLRenderTarget(W, H); this.rt.texture.colorSpace = THREE.SRGBColorSpace; this.buf = new Uint8Array(W * H * 4); this.img = new ImageData(W, H); }
    while (this.cams.length < n) this.cams.push(new THREE.PerspectiveCamera(70, RREC.tw / RREC.th, 0.12, 60));
    const r = this.cw.renderer, prev = r.getRenderTarget(); r.setRenderTarget(this.rt); r.setClearColor(0x05080c, 1); r.clear(); r.setRenderTarget(prev);
    this.k = 0;
  }
  rect(i) { return [(i % this.cols) * RREC.tw, RREC.head + Math.floor(i / this.cols) * RREC.th, RREC.tw, RREC.th]; }
  index() { return this.tiles.map((t, i) => ({ robot: t.robot, name: t.name ?? t.robot, camera: t.cam, label: t.label, kind: t.kind, asset: t.assetKey, rect: this.rect(i) })); }
  startSegment() {
    this.layout();
    const W = this.cols * RREC.tw, H = this.rows * RREC.th + RREC.head;
    this.canvas.width = W; this.canvas.height = H; this.ctx.fillStyle = '#05080c'; this.ctx.fillRect(0, 0, W, H);
    const stream = this.canvas.captureStream(RREC.fps), mime = pickMime();
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: RREC.bitrate });
    const seg = { no: ++this.seq, id: `${this.runId}_robotcam_${String(this.seq).padStart(4, '0')}`, t0: this.sim.time, iso0: this.iso(this.sim.time), real0: performance.now(), chunks: [], mode: this.sim.mode.key, index: this.index(), size: [W, H], mime: mime || 'video/webm' };
    seg.done = new Promise((res) => { seg.resolve = res; });
    rec.ondataavailable = (e) => { if (e.data?.size) seg.chunks.push(e.data); };
    rec.onstop = () => this.finish(seg);
    rec.start(10_000);
    this.rec = rec; this.seg = seg;
  }
  stopSegment() {
    if (!this.rec) return null;
    const seg = this.seg; seg.t1 = this.sim.time; seg.iso1 = this.iso(this.sim.time); seg.realS = (performance.now() - seg.real0) / 1000;
    try { this.rec.stop(); } catch { seg.resolve(); }
    this.rec = null; this.seg = null;
    return seg;
  }
  async finish(seg) {
    const blob = new Blob(seg.chunks, { type: 'video/webm' }); seg.chunks = null; seg.blob = blob; seg.bytes = blob.size;
    seg.meta = { segment: seg.id, format: 'WebM (VP9/VP8) — 로봇 카메라 전체 분할 녹화', fps: RREC.fps, size: seg.size, factory_mode: seg.mode, cameras: seg.index.length,
      start: seg.iso0, end: seg.iso1, sim_seconds: Math.round((seg.t1 - seg.t0) * 10) / 10, real_seconds: Math.round(seg.realS * 10) / 10,
      note: '칸(rect = [x, y, 폭, 높이] px)이 로봇 카메라 하나 — 예: ffmpeg -i 파일.webm -filter:v "crop=256:144:x:y" 로봇_카메라.mp4', index: seg.index };
    this.segs.push(seg); while (this.segs.length > RREC.keep * 6) this.segs.shift();   // 색인은 더 오래 기억 (영상 링크용)
    let n = 0; for (let i = this.segs.length - 1; i >= 0; i--) if (this.segs[i].blob && ++n > RREC.keep) this.segs[i].blob = null;   // 브라우저 보관 영상은 최근 2구간
    if (this.server && blob.size) {
      try {
        const r = await fetch(`/api/robotcam?id=${encodeURIComponent(seg.id)}&ext=webm`, { method: 'POST', body: blob });
        await fetch(`/api/robotcam?id=${encodeURIComponent(seg.id)}&ext=json`, { method: 'POST', body: JSON.stringify(seg.meta, null, 1) });
        if (r.ok) { this.saved++; this.bytes += blob.size; seg.stored = true; } else this.failed++;
      } catch { this.failed++; }
    }
    seg.resolve();
  }
  // 지금까지 녹화한 영상을 바로 파일로 (AAS 저장 직전 — 링크가 최신 영상까지 가리키게): 진행 중 구간을 마감·저장하고 새 구간 시작
  async flush() {
    const seg = this.stopSegment(); if (!seg) return null;
    await seg.done;
    return seg;
  }
  update(rdt) {
    if (!this.on || !this.sim || this.cw.lost || document.hidden) return;
    if (!this.rec) this.startSegment();
    if ((performance.now() - this.seg.real0) / 1000 >= RREC.segS) { this.stopSegment(); this.startSegment(); }
    // 칸 렌더: 프레임마다 몇 칸씩 차례로
    const r = this.cw.renderer, n = this.tiles.length; if (!n) return;
    const view = this.cw.view, hide = [this.cw.group, view?.selRing, ...(view?.droneViews ?? []).map((d) => d.g.userData.beam)].filter(Boolean), vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false; const prev = r.getRenderTarget();
    for (let m = 0; m < Math.min(RREC.perFrame, n); m++) {
      const i = this.k++ % n, f = this.cw.cameraFor(this.tiles[i].ref); if (!f) continue;
      this.cw.setCam(this.cams[i], f);
      const H = this.rows * RREC.th, [x, y] = this.rect(i);
      this.rt.viewport.set(x, H - (y - RREC.head) - RREC.th, RREC.tw, RREC.th); this.rt.scissor.copy(this.rt.viewport); this.rt.scissorTest = true;
      r.setRenderTarget(this.rt); r.render(this.cw.scene, this.cams[i]);
    }
    r.setRenderTarget(prev); r.shadowMap.autoUpdate = auto; hide.forEach((o, i) => (o.visible = vis[i]));
    this.acc += rdt; if (this.acc < 1 / RREC.fps) return; this.acc = 0;
    this.capture();
  }
  capture() {
    const r = this.cw.renderer, W = this.cols * RREC.tw, H = this.rows * RREC.th, g = this.ctx;
    if (this.canvas.width !== W) return;
    r.readRenderTargetPixels(this.rt, 0, 0, W, H, this.buf);
    const row = W * 4; for (let y = 0; y < H; y++) this.img.data.set(this.buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    g.putImageData(this.img, 0, RREC.head);
    // 칸 라벨: 로봇 · 카메라
    g.font = `700 11px ${FONT}`; g.textBaseline = 'middle';
    this.tiles.forEach((t, i) => { const [x, y, w] = this.rect(i); g.fillStyle = 'rgba(5,8,12,0.62)'; g.fillRect(x, y, w, 15); g.fillStyle = '#e8edf2'; g.fillText(`${t.robot} · ${t.label}`, x + 4, y + 8); });
    g.strokeStyle = '#0b0e12'; g.lineWidth = 2;
    for (let k = 1; k < this.cols; k++) { g.beginPath(); g.moveTo(k * RREC.tw, RREC.head); g.lineTo(k * RREC.tw, RREC.head + H); g.stroke(); }
    for (let k = 1; k < this.rows; k++) { g.beginPath(); g.moveTo(0, RREC.head + k * RREC.th); g.lineTo(W, RREC.head + k * RREC.th); g.stroke(); }
    g.fillStyle = '#05080c'; g.fillRect(0, 0, W, RREC.head);
    g.fillStyle = Math.floor(performance.now() / 600) % 2 ? '#ff4d4d' : '#7a2020'; g.beginPath(); g.arc(16, RREC.head / 2, 6, 0, Math.PI * 2); g.fill();
    g.font = `800 16px ${FONT}`; g.fillStyle = '#e8edf2'; g.fillText(`REC · 로봇 카메라 ${this.tiles.length}대 전체 · ${this.sim.mode.label}`, 30, RREC.head / 2);
    g.textAlign = 'right'; g.fillStyle = '#7fb8cc'; g.fillText(`${this.iso(this.sim.time).replace('T', ' ').slice(0, 19)} UTC · 구간 #${this.seg?.no ?? '-'}`, W - 10, RREC.head / 2); g.textAlign = 'left';
  }
  // AAS 자산 하나가 찍힌 영상 목록 (끝난 구간): 파일 이름 · URL · 로컬 경로 · 카메라 · 칸 · 시각
  videosFor(assetKey) {
    const out = [];
    for (const s of this.segs) for (const t of s.index) if (t.asset === assetKey) out.push(this.entry(s, t));
    return out;
  }
  entry(s, t) {
    const file = `${s.id}.webm`, cf = camFile(t), mp4 = s.mp4?.cameras?.some((c) => c.file === `${s.id}/${cf}`);
    return { segment: s.id, file, camera: t.camera, label: t.label, robot: t.robot, rect: t.rect, start: s.iso0, end: s.iso1, fps: RREC.fps, stored: !!s.stored, bytes: s.bytes,
      url: s.stored ? `${this.origin}/videos/robotcam/${file}` : null, localPath: s.stored && this.dir ? `${this.dir}/${file}` : file, index: `${s.id}.json`, blob: s.blob,
      // ffmpeg MP4: 이 카메라만 잘라낸 영상 (칸 좌표 없이 바로 재생)
      ...(mp4 ? { mp4Url: `${this.origin}/videos/robotcam/${s.id}/${cf}`, mp4Path: this.dir ? `${this.dir}/${s.id}/${cf}` : `${s.id}/${cf}`, mosaicMp4: `${this.origin}/videos/robotcam/${s.id}.mp4` } : {}) };
  }
  // AAS 저장 전: 저장된 구간들의 MP4 변환(전체 + 카메라별)을 서버(ffmpeg)에 요청하고 끝날 때까지 기다린다
  async convertAll(kind = 'robotcam', segs = this.segs) {
    if (!this.server || !this.ffmpeg) return 0;
    let n = 0;
    for (const s of segs) {
      if (!s.stored || s.mp4) continue;
      try { const r = await fetch(`/api/convert?kind=${kind}&id=${encodeURIComponent(s.id)}`); if (r.ok) { s.mp4 = await r.json(); n++; } } catch { /* 변환 실패 — WebM 링크만 */ }
    }
    return n;
  }
  stats() { return { on: this.on, server: this.server, seq: this.seq, saved: this.saved, bytes: this.bytes, cams: this.tiles.length, cur: this.seg ? (performance.now() - this.seg.real0) / 1000 : 0 }; }
}

// 서버가 없을 때(웹 버전): AAS와 함께 영상 파일을 로컬로 내려받는다 (같은 구간은 한 번만)
export function downloadVideos(list) {
  const seen = new Set();
  for (const v of list) { if (!v.blob || seen.has(v.segment)) continue; seen.add(v.segment); saveBlob(v.blob, v.file); }
  return seen.size;
}
