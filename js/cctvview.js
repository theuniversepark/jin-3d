// CCTV 영상 (화면 쪽) — ① 뒷벽 CCTV 전광판(중앙 관제 화면 왼쪽, 로봇 디스플레이와 같은 12×4m, 설치된 CCTV 전체 분할)
// ② CCTV를 누르면 뜨는 실시간 영상 창.
// 영상: CCTV 카메라 시점으로 장면을 렌더 타깃에 그린다(전광판은 프레임마다 몇 칸씩 돌아가며 갱신, 이벤트 칸은 매 프레임).
// AI 오버레이(피지컬AI): 객체 검출 상자·클래스·신뢰도·트랙 ID(YOLO11 + ByteTrack), 바닥 이상 분할 마스크(YOLO11-seg),
// 연기 검출(D-Fire 학습 모델), 지오펜스 침입 경보 — 장면의 실제 위치·크기를 카메라로 투영해 모델 출력을 만든다.
import * as THREE from 'three';
import { moverRadius } from './sim.js';
import { AI_MODELS, EVENT_MODEL, blocked } from './cctv.js';

const FONT = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
// 뒷벽 디스플레이 3개: 왼쪽 두 번째 벽 기둥(x −36) ~ 오른쪽 네 번째 벽 기둥(x 9) 사이에 CCTV 전광판 → 중앙 관제 화면(x −13.5, 18×4) → 로봇 디스플레이(x 2.325)
// 기둥–화면–화면–화면–기둥 간격을 모두 같게(0.525m, 테두리 기준), 같은 높이(4m), 벽 기둥 앞에 설치
const BOARD = { x: -29.325, y: 5.1, z: -19.15, w: 12, h: 4 };
const TW = 384, TH = 216, PER_FRAME = 2;   // 칸 해상도, 프레임당 갱신 칸 수
// CCTV 대수에 맞춰 분할: 칸 비율이 16:9에 가깝게 행 수를 정한다 (45대 → 9×5, 48대 → 10×5)
const gridFor = (n) => { const rows = Math.max(1, Math.round(Math.sqrt(n * (BOARD.h / BOARD.w) * (16 / 9)))); return { cols: Math.ceil(n / rows), rows }; };
const CLS = {
  person: { ko: '사람', color: '#ff5a5a' }, humanoid: { ko: '휴머노이드', color: '#b89bff' }, forklift: { ko: '지게차', color: '#f5b82e' },
  agv: { ko: 'AGV/AMR', color: '#3ddc84' }, truck: { ko: '트럭', color: '#5aa9ff' }, quadruped: { ko: '사족보행', color: '#f5d36b' },
  drone: { ko: '드론', color: '#37e8ff' }, robot: { ko: '정비로봇', color: '#2bd4c6' },
  leak: { ko: '누유', color: '#ff7a3d' }, debris: { ko: '이물질', color: '#f5b82e' }, smoke: { ko: '연기', color: '#ff5a5a' }, intrusion: { ko: '침입', color: '#ff3b3b' },
};
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };
const clock = (t) => { const x = Math.floor(t) + 8 * 3600; return [x / 3600 % 24, x / 60 % 60, x % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };

export class CCTVView {
  constructor(scene, getRenderer, parent) {
    this.scene = scene; this.getRenderer = getRenderer; this.tracks = new Map(); this.trackSeq = 0; this.yaw = new Map(); this.t = 0; this.tile = 0;
    this.cols = 1; this.rows = 1;
    this.rt = new THREE.WebGLRenderTarget(TW, TH); this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.group = new THREE.Group(); this.group.position.set(BOARD.x, BOARD.y, BOARD.z); parent.add(this.group);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(BOARD.w + 0.3, BOARD.h + 0.3, 0.12), new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.6, metalness: 0.3 }));
    frame.position.z = -0.08; this.group.add(frame);
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(BOARD.w, BOARD.h), new THREE.MeshBasicMaterial({ map: this.rt.texture, toneMapped: false }));
    this.screen.userData.cctvBoard = true; this.group.add(this.screen);
    this.canvas = document.createElement('canvas'); this.canvas.width = TW; this.canvas.height = TH; this.ctx = this.canvas.getContext('2d');
    this.overTex = new THREE.CanvasTexture(this.canvas); this.overTex.colorSpace = THREE.SRGBColorSpace;
    const over = new THREE.Mesh(new THREE.PlaneGeometry(BOARD.w, BOARD.h), new THREE.MeshBasicMaterial({ map: this.overTex, transparent: true, depthWrite: false, toneMapped: false }));
    over.position.z = 0.01; over.userData.cctvBoard = true; this.group.add(over);
    this.cams = []; this.slots = [];
  }
  setup(sim, view) {
    this.sim = sim; this.view = view; this.tracks.clear(); this.slots = []; this.planRef = null;
    this.group.visible = sim.mode.key !== 'traditional';   // 레거시 공장에는 CCTV 전광판이 없다 (CCTV 녹화만, 영상 창은 그대로)
    this.layout();
  }
  // 전광판 분할: 설치된 CCTV 전체를 한 칸씩 (배치가 바뀌면 — 공정 설계로 라인이 바뀌면 — 다시 나눈다)
  layout() {
    const plan = this.plan(); if (plan === this.planRef) return; this.planRef = plan;
    this.slots = [...plan.cams]; const { cols, rows } = gridFor(this.slots.length); this.cols = cols; this.rows = rows;
    this.rt.setSize(cols * TW, rows * TH); this.canvas.width = cols * TW; this.canvas.height = rows * TH;
    this.overTex.dispose(); this.overTex.needsUpdate = true;
    while (this.cams.length < this.slots.length) this.cams.push(new THREE.PerspectiveCamera(78, TW / TH, 0.3, 90));
    this.tile = 0;
    const r = this.getRenderer(), prev = r.getRenderTarget(); r.setRenderTarget(this.rt); r.setClearColor(0x05080c, 1); r.clear(); r.setRenderTarget(prev);
  }
  get ai() { return this.sim?.mode.key === 'dark'; }
  plan() { return this.sim.cctv; }
  // 카메라 위치 이름 (가까운 설비·구역)
  place(c) {
    if (c.region === 'yardIn') return '입고 트럭 야드'; if (c.region === 'yardOut') return '출하 트럭 야드';
    const st = [...this.sim.stations].sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
    if (c.x < -38) return c.z < -5 ? '입고 도크 · 입고 지게차' : '물류존 · 물류 선반'; if (c.x > 16 && c.z < -12) return '출하 도크';
    if (c.z > 12) return c.x < -14 ? 'AMR 대기열' : c.x > 16 ? '드론 패드 · 정비' : '충전·정비 구역';
    return Math.hypot(st.x - c.x, st.z - c.z) < 9 ? st.name : c.z < 0 ? '뒤쪽 통로' : '앞쪽 통로';
  }
  // 카메라 시점: 천장 돔은 어안 영상 중 공장 안쪽을 향한 디워핑 뷰, 실외는 야드 중심을 향함. 영상 창에서 PTZ로 돌릴 수 있다
  pose(c) {
    let tx, tz;
    if (c.region === 'inside') { const d = Math.hypot(c.x, c.z * 1.8) || 1; tx = c.x - (c.x / d) * 6; tz = c.z - ((c.z * 1.8) / d) * 6; if (d < 3) tz = c.z + 6; }
    else { const cx = c.region === 'yardIn' ? -72 : 31, cz = c.region === 'yardIn' ? -24 : -34; const d = Math.hypot(cx - c.x, cz - c.z) || 1; tx = c.x + ((cx - c.x) / d) * 9; tz = c.z + ((cz - c.z) / d) * 9; }
    const yw = this.yaw.get(c.id) ?? 0, dx = tx - c.x, dz = tz - c.z, cs = Math.cos(yw), sn = Math.sin(yw);
    return { pos: new THREE.Vector3(c.x, c.y - 0.25, c.z), look: new THREE.Vector3(c.x + dx * cs - dz * sn, 0, c.z + dx * sn + dz * cs) };
  }
  setCam(cam, c) { const p = this.pose(c); cam.position.copy(p.pos); cam.lookAt(p.look); cam.updateMatrixWorld(); cam.updateProjectionMatrix(); }

  // ── 인식 대상 (월드 좌표 상자) ─────────────────
  targets() {
    const sim = this.sim, out = [];
    const cls = { carrier: 'agv', agv: 'agv', forklift: 'forklift', humanoid: 'humanoid', quadruped: 'quadruped', robot: 'robot', human: 'person', worker: 'person' };
    for (const m of sim.movers) {
      const k = cls[m.kind] ?? 'agv', tall = k === 'person' || k === 'humanoid' ? 0.9 : k === 'quadruped' ? 0.45 : k === 'forklift' ? 1.1 : 0.45;
      out.push({ key: `m${m.id}`, cls: k, c: [m.x, tall, m.z], h: [moverRadius(m) * 0.75, tall, moverRadius(m) * 0.75] });
    }
    for (const d of sim.drones ?? []) if (d.y > 0.5) out.push({ key: `d${d.id}`, cls: 'drone', c: [d.x, d.y, d.z], h: [0.45, 0.15, 0.45] });
    for (const t of [...(sim.yard?.trucks ?? []), ...(sim.inbound?.trucks ?? [])]) out.push({ key: `t${t.id}`, cls: 'truck', c: [t.x, 1.9, t.z], h: Math.abs(Math.sin(t.heading)) > 0.7 ? [5.2, 1.9, 1.3] : [1.3, 1.9, 5.2] });
    for (const ev of sim.fieldEvents ?? []) {
      if (ev.cleared) continue;
      const sz = { leak: [0.9, 0.04, 0.9], debris: [0.5, 0.25, 0.5], intrusion: [0.35, 0.9, 0.35], smoke: [0.9, 1.4, 0.9] }[ev.type];
      out.push({ key: `e${ev.id}`, cls: ev.type, c: [ev.x, ev.type === 'smoke' ? 2.2 : ev.type === 'intrusion' ? 0.9 : sz[1], ev.z], h: sz, ev });
    }
    return out;
  }
  // 카메라에 보이는 대상 → 검출 결과 (상자·클래스·신뢰도·트랙 ID·모델)
  detect(cam, c, tw, th, tg = null) {
    if (!this.ai) return [];
    const plan = this.plan(), v = new THREE.Vector3(), out = [];
    for (const t of tg ?? this.targets()) {
      const dist = Math.hypot(t.c[0] - c.x, t.c[2] - c.z);
      if (dist > c.R * 1.6) continue;
      if (c.region === 'inside' && blocked(c, { x: t.c[0], z: t.c[2] }, plan.obstacles)) continue;   // 설비에 가려 안 보임
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, front = 0;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        v.set(t.c[0] + sx * t.h[0], t.c[1] + sy * t.h[1], t.c[2] + sz * t.h[2]).project(cam);
        if (v.z > 1 || v.z < -1) continue; front++;
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      }
      if (front < 4 || x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) continue;
      const box = { x: ((Math.max(-1, x0) + 1) / 2) * tw, y: ((1 - Math.min(1, y1)) / 2) * th, w: ((Math.min(1, x1) - Math.max(-1, x0)) / 2) * tw, h: ((Math.min(1, y1) - Math.max(-1, y0)) / 2) * th };
      if (box.w < 6 || box.h < 5) continue;
      if (!this.tracks.has(t.key)) this.tracks.set(t.key, ++this.trackSeq);
      const conf = Math.max(0.42, Math.min(0.99, 0.95 - dist * 0.012 + (hash(t.key) - 0.5) * 0.08 + Math.sin(this.t * 2 + hash(t.key) * 9) * 0.015));
      const model = t.ev ? EVENT_MODEL[t.ev.type] ?? 'detect' : 'detect';
      out.push({ ...t, box, conf, id: this.tracks.get(t.key), model, alert: !!t.ev || t.cls === 'person' });
    }
    return out;
  }
  // 영상 칸 위 오버레이: 상자·라벨·마스크·경보
  drawOverlay(g, ox, oy, tw, th, c, dets, big = false) {
    const fs = big ? 13 : 10.5;
    g.save(); g.beginPath(); g.rect(ox, oy, tw, th); g.clip();
    for (const d of dets) {
      const C = CLS[d.cls] ?? CLS.agv, b = d.box, x = ox + b.x, y = oy + b.y;
      if (d.model === 'seg') {   // 분할 마스크 (타원)
        g.fillStyle = C.color + '55'; g.strokeStyle = C.color; g.lineWidth = big ? 2 : 1.5;
        g.beginPath(); g.ellipse(x + b.w / 2, y + b.h / 2, b.w / 2, Math.max(4, b.h / 2), 0, 0, Math.PI * 2); g.fill(); g.stroke();
      } else {
        g.strokeStyle = C.color; g.lineWidth = d.alert ? (big ? 2.6 : 2) : big ? 1.8 : 1.3;
        if (d.cls === 'smoke') { g.fillStyle = 'rgba(255,90,90,0.18)'; g.fillRect(x, y, b.w, b.h); }
        g.strokeRect(x, y, b.w, b.h);
      }
      const label = `${C.ko}${d.model === 'detect' ? ` #${d.id}` : ''} ${d.conf.toFixed(2)}`;
      g.font = `700 ${fs}px ${FONT}`; const lw = g.measureText(label).width + 6;
      g.fillStyle = C.color; g.fillRect(x, Math.max(oy, y - fs - 4), lw, fs + 4);
      g.fillStyle = '#05080c'; g.textBaseline = 'top'; g.fillText(label, x + 3, Math.max(oy, y - fs - 4) + 2);
    }
    const ev = dets.find((d) => d.ev);
    if (ev) {   // 이벤트 경보 테두리·배너
      g.strokeStyle = Math.sin(this.t * 6) > 0 ? '#ff3b3b' : '#ff9a3d'; g.lineWidth = big ? 5 : 3; g.strokeRect(ox + 2, oy + 2, tw - 4, th - 4);
      const txt = `⚠ ${ev.ev.label} · ${AI_MODELS[ev.model].name} ${ev.conf.toFixed(2)} · ${ev.ev.detected ? '오케스트레이터 보고됨' : '확인 중'}`;
      g.font = `800 ${big ? 15 : 11}px ${FONT}`; g.fillStyle = 'rgba(160,20,20,0.85)'; g.fillRect(ox, oy + th - (big ? 30 : 22), tw, big ? 30 : 22);
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(txt, ox + 8, oy + th - (big ? 15 : 11));
    }
    g.restore();
    // 머리 띠: REC · 카메라 ID · 위치 · 시각
    g.fillStyle = 'rgba(5,8,12,0.6)'; g.fillRect(ox, oy, tw, big ? 26 : 19);
    g.fillStyle = Math.sin(this.t * 4) > 0 ? '#ff4d4d' : '#7a2020'; g.beginPath(); g.arc(ox + 10, oy + (big ? 13 : 9.5), big ? 5 : 4, 0, Math.PI * 2); g.fill();
    g.font = `700 ${big ? 13 : 10.5}px ${FONT}`; g.fillStyle = '#e8edf2'; g.textBaseline = 'middle';
    g.fillText(`${c.id} · ${this.place(c)}${this.ai ? ' · AI' : ' · 녹화'}`, ox + 20, oy + (big ? 13 : 9.5));
    g.textAlign = 'right'; g.fillStyle = '#7fb8cc'; g.fillText(clock(this.sim.time), ox + tw - 6, oy + (big ? 13 : 9.5)); g.textAlign = 'left';
  }
  // 렌더: 전광판 칸 또는 영상 창 (CCTV 지도·전광판 자신·드론 빔은 영상에서 뺀다)
  render(cam, target, viewport) {
    const r = this.getRenderer(), v = this.view, hide = [this.group, v.cctvMap, v.selRing, ...(v.droneViews ?? []).map((d) => d.g.userData.beam)].filter(Boolean);
    const vis = hide.map((o) => o.visible); hide.forEach((o) => (o.visible = false));
    // 그림자 맵은 렌더러마다 한 번은 그려야 한다 (안 그린 맵을 샘플링하면 GL 형식 불일치 오류)
    const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = this.shadowR === r ? false : auto; this.shadowR = r; const prev = r.getRenderTarget();
    if (viewport) { target.viewport.copy(viewport); target.scissor.copy(viewport); target.scissorTest = true; }
    r.setRenderTarget(target); if (!viewport) r.clear(); r.render(this.scene, cam); r.setRenderTarget(prev);
    r.shadowMap.autoUpdate = auto; hide.forEach((o, i) => (o.visible = vis[i]));
  }
  renderTile(k) {
    const c = this.slots[k]; if (!c) return;
    const col = k % this.cols, row = Math.floor(k / this.cols);
    this.setCam(this.cams[k], c); this.render(this.cams[k], this.rt, new THREE.Vector4(col * TW, (this.rows - 1 - row) * TH, TW, TH));
  }
  update(rdt) {
    if (!this.sim || this.lost || (!this.group.visible && !this.recording)) return;   // 전광판이 없는 레거시 공장도 자동 녹화 중이면 영상을 그린다
    this.t += rdt; this.layout();
    const n = this.slots.length; if (!n) return;
    // 이벤트·인시던트를 잡고 있는 카메라 칸은 매 프레임, 나머지는 프레임마다 PER_FRAME칸씩 차례로 갱신
    const hot = new Set();
    for (const r of this.sim.cctvAgent?.history ?? []) if (r.status === 'open') { const k = this.slots.findIndex((x) => x.id === r.cam); if (k >= 0) hot.add(k); }
    const hl = [...hot]; this.hotI = (this.hotI ?? 0) + 1;   // 이벤트 칸이 많아도 프레임당 2칸까지 (나머지는 다음 프레임에)
    for (let m = 0; m < Math.min(2, hl.length); m++) this.renderTile(hl[(this.hotI * 2 + m) % hl.length]);
    for (let m = 0; m < PER_FRAME; m++) { const k = this.tile++ % n; if (!hot.has(k)) this.renderTile(k); }
    this.overT = (this.overT ?? 0) + rdt;
    if (this.overT > 0.25) {
      this.overT = 0; const g = this.ctx, W = this.cols * TW, H = this.rows * TH; g.clearRect(0, 0, W, H);
      const tg = this.ai ? this.targets() : [];
      this.slots.forEach((cc, k) => { const col = k % this.cols, row = Math.floor(k / this.cols); this.setCam(this.cams[k], cc); this.drawOverlay(g, col * TW, row * TH, TW, TH, cc, this.detect(this.cams[k], cc, TW, TH, tg)); });
      for (let k = n; k < this.cols * this.rows; k++) {   // 빈 칸
        const col = k % this.cols, row = Math.floor(k / this.cols); g.fillStyle = '#05080c'; g.fillRect(col * TW, row * TH, TW, TH);
        g.fillStyle = '#3a4654'; g.font = `700 16px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('CCTV ' + n + '대 전체', col * TW + TW / 2, row * TH + TH / 2); g.textAlign = 'left';
      }
      g.strokeStyle = '#0b0e12'; g.lineWidth = 4;
      for (let k = 1; k < this.cols; k++) { g.beginPath(); g.moveTo(k * TW, 0); g.lineTo(k * TW, H); g.stroke(); }
      for (let k = 1; k < this.rows; k++) { g.beginPath(); g.moveTo(0, k * TH); g.lineTo(W, k * TH); g.stroke(); }
      this.overTex.needsUpdate = true;
    }
  }
  // CCTV 영상 창: 선택한 카메라를 크게 (약 8fps) + 검출 목록 반환
  renderPanel(camId, canvas) {
    if (!this.sim || this.lost) return null;
    const c = this.plan().cams.find((x) => x.id === camId); if (!c) return null;
    const w = canvas.width, h = canvas.height;
    if (!this.pRT || this.pRT.width !== w || this.pRT.height !== h) { this.pRT?.dispose(); this.pRT = new THREE.WebGLRenderTarget(w, h); this.pRT.texture.colorSpace = THREE.SRGBColorSpace; this.pBuf = new Uint8Array(w * h * 4); this.pImg = new ImageData(w, h); }
    this.pCam ??= new THREE.PerspectiveCamera(78, w / h, 0.3, 90); this.pCam.aspect = w / h; this.setCam(this.pCam, c);
    this.render(this.pCam, this.pRT, null);
    const r = this.getRenderer(); r.readRenderTargetPixels(this.pRT, 0, 0, w, h, this.pBuf);
    const row = w * 4; for (let y = 0; y < h; y++) this.pImg.data.set(this.pBuf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    const g = canvas.getContext('2d'); g.putImageData(this.pImg, 0, 0);
    const dets = this.detect(this.pCam, c, w, h); this.drawOverlay(g, 0, 0, w, h, c, dets, true);
    return { cam: c, dets, place: this.place(c) };
  }
  pan(camId, d) { this.yaw.set(camId, (this.yaw.get(camId) ?? 0) + d); }
  boardCamAt(uv) { const col = Math.min(this.cols - 1, Math.floor(uv.x * this.cols)), row = Math.min(this.rows - 1, Math.floor((1 - uv.y) * this.rows)); return this.slots[row * this.cols + col]?.id ?? null; }
}
export { CLS as CCTV_CLASSES };
