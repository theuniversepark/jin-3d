// 로봇 비전 관제 디스플레이 (피지컬AI 단계) — 로봇·드론에 달린 카메라 시점의 실시간 영상 8분할 + AI 추론 오버레이.
// 영상: 각 로봇 카메라 시점으로 장면을 렌더 타깃의 한 칸에 그린다(프레임마다 한 칸씩 돌아가며 갱신).
// 오버레이: 카메라로 투영한 객체 인식 박스·신뢰도, 추론 지연, 작업 상태, 현장 이벤트·알람 배너와 하단 알람 띠.
import * as THREE from 'three';
import { FIELD_EVENTS, ST_LABEL, moverRadius } from './sim.js';
import { makeAlarmFx, blinkAlarmFx, ALARM_COLOR, ROBOT_CAMS } from './factory.js';

export const COLS = 4, ROWS = 2;
const TW = 384, TH = 256, W = COLS * TW, H = ROWS * TH;   // 4×2 분할 (오른쪽 열: 순찰 드론 짐벌·하방 카메라)
const DISPLAY = { x: 2.325, y: 5.1, z: -19.15, w: 12, h: 4 };   // 뒷벽 왼쪽 두 번째 기둥(x −36) ~ 오른쪽 네 번째 기둥(x 9) 사이 CCTV 전광판·관제 화면·로봇 디스플레이를 같은 간격(0.525m)으로
const FONT = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
const CLS_COLOR = { 설비: '#37a0ff', 협동로봇: '#2bd4c6', AMR: '#3ddc84', AGV: '#3ddc84', 휴머노이드: '#b89bff', 사족보행: '#f5d36b', 사람: '#ff5a5a', 누유: '#ff7a3d', 이물질: '#f5b82e', 연기: '#ff5a5a' };
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };

export class RobotCamWall {
  constructor(scene, renderer) {
    this.scene = scene; this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(W, H, { samples: 0 });
    this.group = new THREE.Group(); scene.add(this.group);
    this.group.position.set(DISPLAY.x, DISPLAY.y, DISPLAY.z);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(DISPLAY.w + 0.3, DISPLAY.h + 0.3, 0.12), new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.6, metalness: 0.3 }));
    frame.position.z = -0.08; this.group.add(frame);
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(DISPLAY.w, DISPLAY.h), new THREE.MeshBasicMaterial({ map: this.rt.texture }));
    this.screen.userData.camWall = true; this.group.add(this.screen);
    this.canvas = document.createElement('canvas'); this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.overTex = new THREE.CanvasTexture(this.canvas); this.overTex.colorSpace = THREE.SRGBColorSpace;
    const over = new THREE.Mesh(new THREE.PlaneGeometry(DISPLAY.w, DISPLAY.h), new THREE.MeshBasicMaterial({ map: this.overTex, transparent: true, depthWrite: false, toneMapped: false }));
    over.position.z = 0.01; over.userData.camWall = true; this.overlay = over; this.group.add(over);
    this.cams = Array.from({ length: COLS * ROWS }, () => new THREE.PerspectiveCamera(70, TW / TH, 0.15, 60));
    this.tile = 0; this.overT = 0; this.evMeshes = new Map(); this.t = 0;
    this.evGroup = new THREE.Group(); scene.add(this.evGroup);
    this.group.visible = false;
  }

  setup(sim, view) {
    this.sim = sim; this.view = view;
    this.on = sim.mode.key === 'dark';
    this.group.visible = this.on;
    for (const m of this.evMeshes.values()) this.evGroup.remove(m, m.userData.fxRoot);
    this.evMeshes.clear();
    this.carrierPick = null;
    // 빈 화면 대신 첫 프레임부터 채우도록 렌더 타깃을 어둡게 비운다
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.rt); r.setClearColor(0x05080c, 1); r.clear(); r.setRenderTarget(prev);
  }

  // ── 영상 칸: 지금 이동·작업 중인 로봇 카메라를 5초마다 돌려 가며 (종류별로 섞어 8칸) ─────────────────
  // 후보: 이동·작업 중인 정비·물류 휴머노이드 · 사족보행 · 라인 위 운반 AMR · AGV·지게차, 가동 중인 셀의 로봇(6축 손목·AMMR·휴머노이드 머리), 비행 중인 드론
  // 카메라 시점은 로봇 정보 창과 같은 장착 위치(cameraFor). 움직이는 로봇이 없으면 기본 배치(fixedFeeds)
  // 문제·이벤트 현장을 보는 로봇은 해결될 때까지 그 칸을 지킨다(📌) — 새 문제가 생기면 곧바로 빈 칸에 들어가고, 나머지 칸만 5초마다 돌아간다
  feeds() {
    const ROT = 5, N = COLS * ROWS;
    const pins = this.pinnedFeeds().slice(0, N), pinIds = pins.map((f) => f.robot).join('|');
    const due = !this.rot || this.t - this.rot.t >= ROT || !this.rot.list.length;
    if (!due && pinIds === this.rot.pinIds) return this.rot.list;
    const prev = this.rot?.list ?? [], slots = new Array(N).fill(null);
    // 1) 고정: 이미 보이던 칸은 그대로, 새로 고정할 영상은 고정 안 된 칸에
    for (const f of pins) { const j = prev.findIndex((x) => x?.robot === f.robot); if (j >= 0 && j < N && !slots[j]) slots[j] = f; }
    for (const f of pins) if (!slots.includes(f)) { const j = slots.findIndex((x, k) => !x && !pins.some((p) => p.robot === prev[k]?.robot)); const jj = j >= 0 ? j : slots.indexOf(null); if (jj >= 0) slots[jj] = f; }
    // 2) 나머지 칸: 5초가 됐으면 이동·작업 중인 로봇으로 돌리고, 아니면 보이던 영상을 그대로
    const pool = this.activePool().filter((f) => !pins.some((p) => p.robot === f.robot));
    let cursor = this.rot?.cursor ?? 0; const shown = [];
    for (let k = 0; k < N; k++) {
      if (slots[k]) continue;
      const keep = !due && prev[k] && !pins.some((p) => p.robot === prev[k].robot) && !slots.some((x) => x?.robot === prev[k].robot) ? prev[k] : null;
      if (keep && !keep.pin) { slots[k] = keep; continue; }
      if (pool.length) { for (let t = 0; t < pool.length; t++) { const f = pool[cursor % pool.length]; cursor++; if (!slots.some((x) => x?.robot === f.robot)) { slots[k] = f; shown.push(f); break; } } }
    }
    // 3) 그래도 빈 칸은 기본 배치에서 겹치지 않는 영상으로
    for (const f of this.fixedFeeds()) { const j = slots.indexOf(null); if (j < 0) break; if (!slots.some((x) => x?.robot === f.robot)) slots[j] = f; }
    const list = slots.filter(Boolean);
    this.rot = { t: due ? this.t : this.rot.t, cursor: pool.length ? cursor % pool.length : 0, list, n: pool.length, pinIds };
    return list;
  }
  // 문제·이벤트 현장을 보는 로봇: 현장 이벤트 대응·점검·감지, 사고·고장 현장 중계 드론, 설비 고장 수리 출동
  pinnedFeeds() {
    const sim = this.sim, out = [], seen = new Set();
    const movers = [...sim.movers, ...(sim.drones ?? [])], byId = (id) => movers.find((m) => m.id === id);
    const pin = (m, why) => { if (!m || seen.has(m.id)) return; const c = this.cameraFor({ type: 'mover', id: m.id }); if (!c) return; seen.add(m.id); out.push({ ref: { type: 'mover', id: m.id }, robot: m.id, kind: m.kind, mover: m, label: c.label, pose: c.pose, pin: why }); };
    const open = (sim.fieldEvents ?? []).filter((e) => !e.cleared);
    for (const ev of open) {
      const L = FIELD_EVENTS[ev.type]?.label ?? '현장 이벤트';
      pin(byId(ev.responder), `${L} 대응`);
      for (const m of sim.techs) if (m.tool === 'smoke') pin(m, `${L} 소화 대기`);
      pin(byId(ev.detectedBy), `${L} 감지`);
    }
    for (const q of sim.quads) if (q.scanning) pin(q, '열화상 정밀 점검');
    for (const d of sim.drones ?? []) if (d.mission) pin(d, d.arrived ? '사고 현장 중계' : '현장 출동');
    for (const req of sim.requests ?? []) if (req.tech && req.kind === 'repair') pin(req.tech, `${req.st.name} 고장 수리`);   // 설비 고장 수리 (계획 정비·보정은 고정하지 않음)
    return out;
  }
  // 지금 이동·작업 중인 로봇 영상 후보 — 종류별로 번갈아 섞는다
  activePool() {
    const sim = this.sim, view = this.view, groups = new Map();
    const add = (cat, f) => { if (!f) return; (groups.get(cat) ?? groups.set(cat, []).get(cat)).push(f); };
    // 휴머노이드·AMMR은 카메라 4대(머리 · 왼손 · 오른손 · 등)를 순환마다 바꿔 보여 준다 (로봇마다 엇갈리게)
    const seq = ['head', 'handR', 'handL', 'back'], rn = Math.floor(this.t / 5);
    const feed = (ref, robot, kind, extra = {}) => {
      if ((kind === 'humanoid' || kind === 'ammr') && this.camsOf(ref).length) ref = { ...ref, cam: seq[(rn + Math.floor(hash(robot) * 4)) % 4] };
      const c = this.cameraFor(ref); return c ? { ref, robot, kind, label: c.label, pose: c.pose, ...extra } : null;
    };
    const busy = (m) => m.moving || (!m.idle && !m.chgNow && !m.charging);
    for (const m of [...sim.techs, ...sim.helpers]) if (m.kind === 'humanoid' && busy(m)) add('humanoid', feed({ type: 'mover', id: m.id }, m.id, m.kind, { mover: m }));
    for (const m of sim.quads) if (busy(m)) add('quadruped', feed({ type: 'mover', id: m.id }, m.id, m.kind, { mover: m }));
    { const cs = sim.carriers.filter((m) => m.state === 'line' || m.moving), off = Math.floor(this.t / 5) * 4;   // 운반 AMR은 한 번에 4대까지 — 순환마다 다른 AMR
      for (let k = 0; k < Math.min(4, cs.length); k++) { const m = cs[(off + k) % cs.length]; add('carrier', feed({ type: 'mover', id: m.id }, m.id, m.kind, { mover: m })); } }
    for (const m of [...sim.vehicles, ...(sim.forklifts ?? [])]) if (busy(m)) add('vehicle', feed({ type: 'mover', id: m.id }, m.id, m.kind, { mover: m }));
    for (const d of sim.drones ?? []) if (d.y > 0.5) add('drone', feed({ type: 'mover', id: d.id }, d.id, 'drone', { mover: d }));
    for (const sv of view?.stationViews ?? []) {
      const st = sv.st, rs = sv.parts.robots; if (!rs?.length || st.state !== 'BUSY') continue;
      rs.forEach((r, idx) => add('cell', feed({ type: 'cell', stationId: st.id, idx }, st.robotUids?.[idx] ?? `${st.name} 로봇 #${idx + 1}`, r.kind, { station: st })));
    }
    const cats = ['cell', 'humanoid', 'carrier', 'quadruped', 'drone', 'vehicle'].filter((c) => groups.get(c)?.length), out = [];
    for (let k = 0; out.length < [...groups.values()].reduce((a, g) => a + g.length, 0); k++) for (const c of cats) { const g = groups.get(c); if (k < g.length) out.push(g[k]); }
    return out;
  }

  // ── 기본 배치 (움직이는 로봇이 없을 때): 카메라를 단 로봇 6대 + 드론 ─────────────────
  fixedFeeds() {
    const sim = this.sim, view = this.view, out = [];
    // fwd: 카메라를 몸체 앞면으로 내민 거리 (자기 몸·머리가 화면을 가리지 않게)
    const mover = (m, label, h, fwd, ahead = 6, down = 0.28) => m && out.push({ ref: { type: 'mover', id: m.id }, robot: m.id, label, kind: m.kind, mover: m,
      pose: () => {
        const fx = Math.sin(m.heading), fz = Math.cos(m.heading);
        return { pos: new THREE.Vector3(m.x + fx * fwd, h, m.z + fz * fwd), dir: new THREE.Vector3(fx, -down, fz).normalize(), ahead };
      } });
    mover(sim.techs.find((t) => t.kind === 'humanoid'), '헤드 카메라', 1.85, 0.22);
    mover(sim.helpers[0], '헤드 카메라', 1.85, 0.22);
    mover(sim.quads[0], '전방 카메라', 0.62, 0.68, 6, 0.15);
    // 피지컬AI VLA: 6축 로봇 손목 카메라 (도구 방향) — 없으면 사족보행 2
    const vsv = view?.stationViews.find((x) => x.parts.robots?.some((r) => r.vla));
    const vr = vsv?.parts.robots.find((r) => r.vla);
    if (vr) {
      const idx = vsv.parts.robots.indexOf(vr), up = new THREE.Vector3();
      out.push({ ref: { type: 'cell', stationId: vsv.st.id, idx }, robot: vsv.st.robotUids?.[idx] ?? vsv.st.name, label: '손목 카메라 VLA', kind: vr.kind, station: vsv.st,
        pose: () => { const p = vr.tip.getWorldPosition(new THREE.Vector3()); up.set(0, 1, 0).transformDirection(vr.tip.parent.matrixWorld); return { pos: p.addScaledVector(up, -0.06), dir: up.clone(), ahead: 1.2 }; } });
    } else mover(sim.quads[1], '전방 카메라', 0.62, 0.68, 6, 0.15);
    // AMMR 머리 카메라 (부품분류셀) — 작업 영역을 내려다본다
    const sv = view?.stationViews.find((s) => s.parts.robots?.some((r) => r.kind === 'ammr'));
    const r = sv?.parts.robots.find((x) => x.kind === 'ammr');
    if (r) {
      const idx = sv.parts.robots.indexOf(r);
      const ref = { type: 'cell', stationId: sv.st.id, idx }, c = this.cameraFor(ref);
      if (c) out.push({ ref, robot: `${sv.st.name} AMMR #${idx + 1}`, label: c.label, kind: 'ammr', station: sv.st, pose: c.pose });
    }
    // 운반 AMR 전방 카메라 — 라인 위에서 움직이는 AMR을 20초마다 바꿔 가며
    if (sim.carriers.length) {
      if (!this.carrierPick || this.carrierPick.state !== 'line' || this.t - (this.carrierT ?? 0) > 20) {
        const moving = sim.carriers.filter((c) => c.state === 'line');
        this.carrierPick = moving[Math.floor(hash(Math.floor(this.t / 20)) * moving.length)] ?? sim.carriers[0];
        this.carrierT = this.t;
      }
      mover(this.carrierPick, '전방 카메라', 0.42, 0.82, 5, 0.12);
    } else mover(sim.vehicles[0], '전방 카메라', 0.45, 0.85, 5, 0.12);
    // 순찰 드론: 오른쪽 열 위 — 짐벌 전방 카메라, 아래 — 하방 매핑 카메라 (점검·이벤트 확인 중에는 짐벌도 아래를 본다)
    const ds = sim.drones ?? [];
    if (ds.length) {
      // 오른쪽 열 두 칸: 사고 현장을 중계 중인 드론을 먼저, 나머지는 순찰 드론 (1대면 짐벌·하방 매핑 카메라)
      const order = () => [...ds].sort((a, b) => (b.mission && b.arrived ? 1 : 0) - (a.mission && a.arrived ? 1 : 0) || (b.mission ? 1 : 0) - (a.mission ? 1 : 0));
      const drone = (slot, base, down, fwd, ahead) => { const D = () => order()[Math.min(slot, ds.length - 1)]; return {
        get ref() { return { type: 'mover', id: D().id }; }, get robot() { return D().id; }, get mover() { return D(); }, kind: 'drone',
        get label() { const d = D(); return d.mission && d.arrived ? `${base} · 🔴 사고 현장 중계` : base; },
        pose: () => { const d = D(), fx = Math.sin(d.heading), fz = Math.cos(d.heading), look = d.mode === 'mission' || d.hover > 0;
          return { pos: new THREE.Vector3(d.x + fx * fwd, d.y - 0.15, d.z + fz * fwd), dir: new THREE.Vector3(fx, typeof down === 'function' ? down(look) : down, fz).normalize(), ahead }; } }; };
      out.splice(3, 0, drone(0, '짐벌 카메라', (look) => (look ? -2.2 : -0.55), 0.3, 8));
      out.splice(7, 0, ds.length > 1 ? drone(1, '짐벌 카메라', (look) => (look ? -2.2 : -0.55), 0.3, 8) : drone(0, '하방 매핑 카메라', -12, 0.05, 6));
    }
    while (out.length < COLS * ROWS && sim.vehicles[out.length - 6]) mover(sim.vehicles[out.length - 6], '전방 카메라', 0.45, 0.85, 5, 0.12);
    return out.slice(0, COLS * ROWS);
  }

  // 로봇 정보 창용: 선택한 로봇의 카메라 시점 (없으면 null) — 벽 관제 영상과 같은 장착 위치
  cameraFor(ref) {
    const sim = this.sim, view = this.view; if (!sim || !ref) return null;
    const front = (m, label, h, fwd, ahead, down) => ({ label, pose: () => { const fx = Math.sin(m.heading), fz = Math.cos(m.heading); return { pos: new THREE.Vector3(m.x + fx * fwd, h, m.z + fz * fwd), dir: new THREE.Vector3(fx, -down, fz).normalize(), ahead }; } });
    if (ref.type === 'cell') {
      const sv = view?.stationViews.find((x) => x.st.id === ref.stationId), r = sv?.parts.robots?.[ref.idx];
      if (!r) return null;
      if (r.vla) { const up = new THREE.Vector3(); return { label: '손목 카메라 · VLA', pose: () => { const p = r.tip.getWorldPosition(new THREE.Vector3()); up.set(0, 1, 0).transformDirection(r.tip.parent.matrixWorld); return { pos: p.addScaledVector(up, -0.06), dir: up.clone(), ahead: 1.2 }; } }; }
      if ((r.kind === 'ammr' || r.kind === 'humanoid') && r.cams) return this.anchorCam(r.cams, ref.cam, r.kind === 'ammr' ? 'AMMR' : '휴머노이드');
      return { label: '셀 상부 카메라', pose: () => { const p = r.root.getWorldPosition(new THREE.Vector3()); const c = new THREE.Vector3(sv.st.x, 1.2, sv.st.z); return { pos: p.add(new THREE.Vector3(0, 2.6, 0)), dir: c.sub(p).normalize(), ahead: 3 }; } };
    }
    const m = [...sim.movers, ...(sim.drones ?? [])].find((x) => x.id === ref.id);
    if (!m) return null;
    if (m.kind === 'drone') return { label: '드론 짐벌 카메라', pose: () => { const fx = Math.sin(m.heading), fz = Math.cos(m.heading), look = m.mode === 'mission' || m.hover > 0; return { pos: new THREE.Vector3(m.x + fx * 0.3, m.y - 0.15, m.z + fz * 0.3), dir: new THREE.Vector3(fx, look ? -2.2 : -0.55, fz).normalize(), ahead: 8 }; } };
    if (m.kind === 'humanoid') {   // 3D 모델의 카메라 앵커(머리 · 양손 · 등) — 허리·머리 회전과 팔 동작을 따라간다
      const mv = [...(this.view?.techViews ?? []), ...(this.view?.helperViews ?? [])].find((x) => x.v === m);
      if (mv?.g.userData.cams) return this.anchorCam(mv.g.userData.cams, ref.cam, '휴머노이드');
      return front(m, '헤드 카메라', 1.85, 0.22, 6, 0.28);
    }
    if (m.kind === 'quadruped') return front(m, '전방 카메라', 0.62, 0.68, 6, 0.15);
    if (m.kind === 'carrier') return front(m, '전방 카메라', 0.42, 0.82, 5, 0.12);
    if (m.kind === 'agv') return front(m, '전방 카메라', 0.45, 0.85, 5, 0.12);
    if (m.kind === 'forklift') return front(m, m.auto ? '포크 카메라 (자율)' : '후방 카메라', 1.2, 1.4, 4, 0.35);
    if (m.kind === 'robot') return front(m, '정비 로봇 카메라', 1.1, 0.4, 4, 0.25);
    return null;   // 사람(작업자·정비원)은 카메라 없음
  }

  // 공장의 모든 로봇 카메라 (자동 녹화용): 셀 로봇(6축 손목 · AMMR·휴머노이드 4대) · 이동 로봇(AMR·AGV·지게차·사족보행·정비로봇 전방, 휴머노이드 4대) · 드론 짐벌
  // assetKey: 데이터 허브 AAS 자산과 맞추는 키 (셀 로봇 = <셀ID>_R<번호>, 이동 로봇·드론 = m:<ID>)
  allCameras() {
    const sim = this.sim, view = this.view, out = []; if (!sim || !view) return out;
    for (const sv of view.stationViews) (sv.parts.robots ?? []).forEach((r, idx) => {
      const ref = { type: 'cell', stationId: sv.st.id, idx }, uid = sv.st.robotUids?.[idx] ?? `${sv.st.id}-${idx + 1}`;
      const keys = r.cams ? ROBOT_CAMS.map(([k]) => k) : [null];
      for (const k of keys) { const c = this.cameraFor(k ? { ...ref, cam: k } : ref); if (c && (r.vla || r.cams || r.kind === 'ammr')) out.push({ ref: k ? { ...ref, cam: k } : ref, robot: uid, cam: k ?? 'wrist', label: c.label, assetKey: `${sv.st.id}_R${idx + 1}`, kind: r.kind }); }
    });
    for (const m of [...sim.movers, ...(sim.drones ?? [])]) {
      const ref = { type: 'mover', id: m.id };
      const hum = m.kind === 'humanoid' && this.camsOf(ref).length;
      for (const k of hum ? ROBOT_CAMS.map(([x]) => x) : [null]) { const c = this.cameraFor(k ? { ...ref, cam: k } : ref); if (c) out.push({ ref: k ? { ...ref, cam: k } : ref, robot: m.uid ?? m.id, name: m.id, cam: k ?? 'front', label: c.label, assetKey: `m:${m.id}`, kind: m.kind }); }
    }
    return out;
  }
  // 카메라 앵커(+z = 보는 방향) → 시점. cam: head · handL · handR · back (없으면 머리)
  anchorCam(cams, cam, who) {
    const key = cams[cam] ? cam : 'head', a = cams[key], label = ROBOT_CAMS.find(([k]) => k === key)[1];
    const ahead = key === 'head' ? 3 : key === 'back' ? 4 : 1.2;
    return { label, cam: key, who, pose: () => { a.updateWorldMatrix(true, false); const pos = a.getWorldPosition(new THREE.Vector3()); const dir = new THREE.Vector3(0, 0, 1).transformDirection(a.matrixWorld); return { pos: pos.addScaledVector(dir, 0.03), dir, ahead }; } };
  }
  // 로봇에 달린 카메라 목록 (휴머노이드·AMMR = 머리 · 왼손 · 오른손 · 등)
  camsOf(ref) {
    if (!ref || !this.view) return [];
    if (ref.type === 'cell') { const r = this.view.stationViews.find((x) => x.st.id === ref.stationId)?.parts.robots?.[ref.idx]; return r?.cams ? ROBOT_CAMS.filter(([k]) => r.cams[k]) : []; }
    const mv = [...(this.view.techViews ?? []), ...(this.view.helperViews ?? [])].find((x) => x.v.id === ref.id);
    return mv?.g.userData.cams ? ROBOT_CAMS : [];
  }

  // 선택한 로봇 카메라 영상을 2D 캔버스에 그린다 (렌더 타깃 → 픽셀 읽기, 약 10fps로 호출)
  renderRobotView(ref, canvas, clock) {
    if (this.lost) return null;   // GPU 컨텍스트 복구 중
    const f = this.cameraFor(ref); if (!f) return null;
    const w = canvas.width, h = canvas.height, r = this.renderer;
    if (!this.panelRT || this.panelRT.width !== w || this.panelRT.height !== h) {
      this.panelRT?.dispose(); this.panelRT = new THREE.WebGLRenderTarget(w, h); this.panelRT.texture.colorSpace = THREE.SRGBColorSpace;
      this.panelBuf = new Uint8Array(w * h * 4); this.panelImg = new ImageData(w, h);
    }
    this.panelCam ??= new THREE.PerspectiveCamera(70, w / h, 0.12, 60);
    this.panelCam.aspect = w / h; this.setCam(this.panelCam, f);
    const vis = [this.group.visible, this.view.selRing?.visible];
    this.group.visible = false; if (this.view.selRing) this.view.selRing.visible = false;
    const beams = (this.view.droneViews ?? []).map((dv) => { const b = dv.g.userData.beam, v = b.visible; b.visible = false; return [b, v]; });
    const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.panelRT); r.clear(); r.render(this.scene, this.panelCam);
    r.readRenderTargetPixels(this.panelRT, 0, 0, w, h, this.panelBuf);
    r.setRenderTarget(prev); r.shadowMap.autoUpdate = auto;
    this.group.visible = vis[0]; if (this.view.selRing) this.view.selRing.visible = vis[1];
    for (const [b, v] of beams) b.visible = v;
    // 위아래 뒤집어 옮기고 HUD를 덧그린다
    const src = this.panelBuf, dst = this.panelImg.data, row = w * 4;
    for (let y = 0; y < h; y++) dst.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    const g = canvas.getContext('2d'); g.putImageData(this.panelImg, 0, 0);
    g.fillStyle = 'rgba(5,8,12,0.65)'; g.fillRect(0, 0, w, 24);
    g.font = `700 13px ${FONT}`; g.textBaseline = 'middle';
    g.fillStyle = Math.sin(this.t * 4) > 0 ? '#ff4d4d' : '#7a2020'; g.beginPath(); g.arc(12, 12, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8edf2'; g.fillText(`LIVE · ${f.label}`, 24, 12);
    g.textAlign = 'right'; g.fillStyle = '#7fb8cc'; g.fillText(clock ?? '', w - 8, 12); g.textAlign = 'left';
    g.strokeStyle = 'rgba(55,232,255,0.55)'; g.lineWidth = 1.2;
    const cx = w / 2, cy = h / 2 + 12;
    g.beginPath(); g.moveTo(cx - 14, cy); g.lineTo(cx - 5, cy); g.moveTo(cx + 5, cy); g.lineTo(cx + 14, cy); g.moveTo(cx, cy - 14); g.lineTo(cx, cy - 5); g.moveTo(cx, cy + 5); g.lineTo(cx, cy + 14); g.stroke();
    for (const [x0, y0, dx, dy] of [[8, 32, 1, 1], [w - 8, 32, -1, 1], [8, h - 8, 1, -1], [w - 8, h - 8, -1, -1]]) { g.beginPath(); g.moveTo(x0, y0 + dy * 16); g.lineTo(x0, y0); g.lineTo(x0 + dx * 16, y0); g.stroke(); }
    return f.label;
  }

  // VLA 에피소드용 카메라 프레임: 로봇 카메라 시점을 작은 해상도로 렌더해 JPEG 바이트로 돌려준다 (비동기 인코딩)
  captureFrame(ref, w = 160, h = 120) {
    if (this.lost) return null;
    const f = this.cameraFor(ref); if (!f) return null;
    const r = this.renderer;
    if (!this.capRT || this.capRT.width !== w || this.capRT.height !== h) {
      this.capRT?.dispose(); this.capRT = new THREE.WebGLRenderTarget(w, h); this.capRT.texture.colorSpace = THREE.SRGBColorSpace;
      this.capBuf = new Uint8Array(w * h * 4); this.capCanvas = document.createElement('canvas'); this.capCanvas.width = w; this.capCanvas.height = h;
    }
    this.capCam ??= new THREE.PerspectiveCamera(70, w / h, 0.12, 60);
    this.capCam.aspect = w / h; this.setCam(this.capCam, f);
    const vis = [this.group.visible, this.view.selRing?.visible];
    this.group.visible = false; if (this.view.selRing) this.view.selRing.visible = false;
    const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.capRT); r.clear(); r.render(this.scene, this.capCam);
    r.readRenderTargetPixels(this.capRT, 0, 0, w, h, this.capBuf);
    r.setRenderTarget(prev); r.shadowMap.autoUpdate = auto;
    this.group.visible = vis[0]; if (this.view.selRing) this.view.selRing.visible = vis[1];
    const img = new ImageData(w, h), row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(this.capBuf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    this.capCanvas.getContext('2d').putImageData(img, 0, 0);
    return new Promise((res) => this.capCanvas.toBlob((b) => (b ? b.arrayBuffer().then((ab) => res(new Uint8Array(ab))) : res(null)), 'image/jpeg', 0.78));
  }

  setCam(cam, f) {
    const { pos, dir, ahead } = f.pose();
    cam.position.copy(pos);
    cam.lookAt(pos.x + dir.x * ahead, pos.y + dir.y * ahead, pos.z + dir.z * ahead);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  }

  update(rdt) {
    if (!this.on || !this.sim) return;
    this.t += rdt;
    this.list = this.feeds();
    this.syncEvents(rdt);
    // 1) 영상: 프레임마다 한 칸 렌더 (6칸이 약 10fps로 돌아가며 갱신)
    const i = this.tile % this.list.length, f = this.list[i];
    this.tile++;
    if (f) {
      const cam = this.cams[i], r = this.renderer;
      this.setCam(cam, f);
      const col = i % COLS, row = Math.floor(i / COLS);
      this.rt.viewport.set(col * TW, (ROWS - 1 - row) * TH, TW, TH);
      this.rt.scissor.copy(this.rt.viewport); this.rt.scissorTest = true;
      const vis = [this.group.visible, this.view.selRing?.visible];
      this.group.visible = false; if (this.view.selRing) this.view.selRing.visible = false;
      // 드론 하방 관찰 빔은 화면 연출용이라 카메라 영상에는 넣지 않는다
      const beams = (this.view.droneViews ?? []).map((dv) => { const b = dv.g.userData.beam, v = b.visible; b.visible = false; return [b, v]; });
      const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
      const prev = r.getRenderTarget();
      r.setRenderTarget(this.rt); r.render(this.scene, cam); r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = auto;
      this.group.visible = vis[0]; if (this.view.selRing) this.view.selRing.visible = vis[1];
      for (const [b, v] of beams) b.visible = v;
    }
    // 2) 오버레이 (약 8Hz)
    this.overT += rdt;
    if (this.overT > 0.12) { this.overT = 0; this.drawOverlay(); }
  }

  // ── 인식 대상 (월드 좌표 상자) ─────────────────
  targets() {
    const sim = this.sim, out = [];
    for (const st of sim.processing) out.push({ key: `st${st.id}`, cls: '설비', name: st.name.replace('셀', ''), c: [st.x, 1.3, st.z], h: [2.2, 1.3, 2.2], st });
    const kindCls = { carrier: 'AMR', agv: 'AGV', forklift: 'AGV', humanoid: '휴머노이드', quadruped: '사족보행', robot: '정비로봇', human: '사람', worker: '사람' };
    for (const m of sim.movers) {
      const cls = kindCls[m.kind] ?? 'AMR', tall = m.kind === 'humanoid' || m.kind === 'human' || m.kind === 'worker' ? 0.9 : m.kind === 'quadruped' ? 0.45 : m.kind === 'carrier' ? 0.7 : 0.4;
      const r = moverRadius(m) * 0.75;
      out.push({ key: `m${m.id}`, cls, name: m.id, c: [m.x, tall, m.z], h: [r, tall, r], m });
    }
    for (const ev of sim.fieldEvents ?? []) {
      if (ev.cleared) continue;
      const sz = { leak: [0.9, 0.05, 0.9], debris: [0.5, 0.25, 0.5], intrusion: [0.35, 0.9, 0.35], smoke: [0.9, 1.4, 0.9] }[ev.type];
      out.push({ key: `ev${ev.id}`, cls: ev.cls, name: ev.label, c: [ev.x, ev.type === 'smoke' ? 2.2 : ev.type === 'intrusion' ? 0.9 : sz[1], ev.z], h: sz, ev });
    }
    return out;
  }

  // 상자 8개 꼭짓점을 칸 좌표로 투영해 화면 안 사각형을 얻는다
  project(cam, t, col, row) {
    const v = new THREE.Vector3();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, front = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      v.set(t.c[0] + sx * t.h[0], t.c[1] + sy * t.h[1], t.c[2] + sz * t.h[2]).project(cam);
      if (v.z > 1 || v.z < -1) continue;
      front++;
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    if (front < 4 || x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return null;
    const cx = (a) => col * TW + ((Math.max(-1, Math.min(1, a)) + 1) / 2) * TW, cy = (a) => row * TH + ((1 - Math.max(-1, Math.min(1, a))) / 2) * TH;
    const box = { x: cx(x0), y: cy(y1), w: cx(x1) - cx(x0), h: cy(y0) - cy(y1) };
    return box.w > 18 && box.h > 12 && box.w < TW * 0.98 ? box : null;
  }

  // ── 현장 알람 (영상 배너·하단 알람 띠 공용) ─────────────────
  alarms() {
    const sim = this.sim, out = [];
    for (const st of sim.processing) {
      if (st.state === 'DOWN') out.push({ sev: 'alarm', text: `${st.name} 설비 정지`, at: st });
      else if (st.state === 'MAINT') out.push({ sev: 'warn', text: `${st.name} 정비 중`, at: st });
      else if (st.state === 'NOPARTS') out.push({ sev: 'warn', text: `${st.name} 부품 결품`, at: st });
    }
    for (const ev of sim.fieldEvents ?? []) if (ev.detected && !ev.cleared) out.push({ sev: ev.severity, text: `AI 감지 · ${ev.label} (${ev.detectedBy}${ev.responder ? ` → ${ev.responder} 대응 중` : ''})`, ev });
    for (const m of sim.movers) if (m.blockedOn && m.blockT > 4 && m.state !== 'line') out.push({ sev: 'warn', text: `${m.id} 진로 장애물 대기 (${m.blockedOn.id})`, m });
    for (const v of sim.vehicles) if (sim.mode.batteryDrain && v.battery < 25) out.push({ sev: 'warn', text: `${v.id} 배터리 ${v.battery.toFixed(0)}%`, m: v });
    for (const q of sim.quads) if (q.scanning && q.scanning.health < sim.mode.pmThreshold + 12) out.push({ sev: 'alarm', text: `${q.id} 열화상 이상 · ${q.scanning.name} ${(34 + (100 - q.scanning.health) * 0.55).toFixed(1)}°C`, m: q });
    if (sim.stations[0].state === 'NOAMR') out.push({ sev: 'info', text: '투입 대기 — 빈 AMR 도착 대기' });
    return out;
  }

  drawOverlay() {
    const g = this.ctx, sim = this.sim, tg = this.targets(), alarms = this.alarms();
    g.clearRect(0, 0, W, H);
    const clock = new Date(Date.now()).toTimeString().slice(0, 8);
    const simClock = (() => { const s = Math.floor(sim.time) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; })();
    this.list.forEach((f, i) => {
      const col = i % COLS, row = Math.floor(i / COLS), x0 = col * TW, y0 = row * TH, cam = this.cams[i];
      this.setCam(cam, f);
      g.save(); g.beginPath(); g.rect(x0, y0, TW, TH); g.clip();
      // 인식 박스 (가까운 순 최대 7개)
      const camPos = cam.position;
      const seen = tg.filter((t) => t.m !== f.mover && !(f.kind === 'ammr' && t.st === f.station && false))
        .map((t) => ({ t, d: Math.hypot(t.c[0] - camPos.x, t.c[2] - camPos.z) })).filter((o) => o.d < 22).sort((a, b) => a.d - b.d);
      let n = 0;
      const labels = [];   // 이미 그린 이름표 영역 — 겹치면 이름표는 생략
      for (const { t, d } of seen) {
        if (n >= 7) break;
        const b = this.project(cam, t, col, row); if (!b) continue;
        n++;
        const conf = Math.min(0.99, 0.86 + hash(t.key + f.robot) * 0.1 + Math.sin(this.t * 3 + d) * 0.015 - d * 0.002);
        const color = t.ev ? (t.ev.severity === 'alarm' ? '#ff4d4d' : '#f5b82e') : CLS_COLOR[t.cls] ?? '#37e8ff';
        g.strokeStyle = color; g.lineWidth = t.ev ? 3 : 2;
        if (t.ev && Math.sin(this.t * 8) > 0) g.lineWidth = 5;
        g.strokeRect(b.x, b.y, b.w, b.h);
        const lab = `${t.cls}${t.cls === '설비' ? ' ' + t.name : ''} ${conf.toFixed(2)}`;
        g.font = `600 13px ${FONT}`; const tw = g.measureText(lab).width + 8, ly = Math.max(y0 + 22, b.y - 17);
        const lr = { x: b.x, y: ly, w: tw, h: 17 };
        if (t.ev || !labels.some((o) => lr.x < o.x + o.w && o.x < lr.x + lr.w && lr.y < o.y + o.h && o.y < lr.y + lr.h)) {
          labels.push(lr);
          g.fillStyle = color; g.fillRect(lr.x, lr.y, tw, 17);
          g.fillStyle = '#05080c'; g.fillText(lab, b.x + 4, ly + 13);
        }
        // 현장 이벤트를 처음 본 카메라가 감지 처리한다
        if (t.ev && !t.ev.detected && d < 14) sim.detectFieldEvent(t.ev, f.robot, conf);
      }
      // 칸 머리: 녹화 표시·로봇·카메라·추론 정보
      g.fillStyle = 'rgba(5,8,12,0.72)'; g.fillRect(x0, y0, TW, 22);
      g.fillStyle = Math.sin(this.t * 4) > 0 ? '#ff4d4d' : '#7a2020'; g.beginPath(); g.arc(x0 + 11, y0 + 11, 5, 0, Math.PI * 2); g.fill();
      if (f.pin) { g.fillStyle = 'rgba(255,140,40,0.85)'; g.fillRect(x0, y0 + 22, TW, 18); g.fillStyle = '#05080c'; g.font = `700 12px ${FONT}`; g.fillText(`📌 모니터링 중 · ${f.pin} · 해결 시까지`, x0 + 8, y0 + 35); }
      g.fillStyle = '#e8edf2'; g.font = `600 13px ${FONT}`; g.fillText(`${f.robot} · ${f.label}`, x0 + 22, y0 + 15);
      const lat = 14 + Math.round(hash(f.robot + Math.floor(this.t * 2)) * 12);
      g.fillStyle = '#7ff3ff'; g.font = `12px ${FONT}`; const info = `AI 추론 ${lat}ms · 객체 ${n} · ${simClock}`;
      g.fillText(info, x0 + TW - g.measureText(info).width - 8, y0 + 15);
      // 칸 바닥: 로봇 작업
      const au = f.station?.ammr?.[f.ref.idx];
      const task = f.mover ? f.mover.task ?? '대기' : !f.station ? ''
        : f.kind === 'ammr' ? `${f.station.name} ${ST_LABEL[f.station.state] ?? ''} · ${au && au.phase !== 'work' ? '선반에서 부품 가져오기' : '양팔 작업'} · 선반 ${f.station.parts ?? '-'}개`
        : `${ST_LABEL[f.station.state] ?? ''} · VLA 선반 부품 인식→집기→조립 · 선반 ${f.station.parts ?? '-'}개`;
      const fy = y0 + TH - 20 - (row === ROWS - 1 ? 30 : 0);   // 아래 줄은 하단 알람 띠 위로
      g.fillStyle = 'rgba(5,8,12,0.6)'; g.fillRect(x0, fy, TW, 20);
      g.fillStyle = '#cfe6f0'; g.font = `12px ${FONT}`; g.fillText(`작업: ${task}`.slice(0, 48), x0 + 8, fy + 14);
      { // 칸 바닥 오른쪽: 고정(문제·이벤트 해결 시까지) 또는 5초 순환 남은 시간
        const tag = f.pin ? '📌 해결 시까지 유지' : this.rot?.n ? `🔄 ${Math.max(0, Math.ceil(5 - (this.t - this.rot.t)))}s · 순환 ${this.rot.n}대` : '';
        if (tag) { g.fillStyle = f.pin ? '#ffb35a' : '#7ff3ff'; g.font = `11px ${FONT}`; g.fillText(tag, x0 + TW - g.measureText(tag).width - 8, fy + 14); }
      }
      // 이 로봇과 관련된 알람 배너
      const mine = alarms.filter((a) => (a.m && a.m === f.mover) || (a.at && (a.at === f.station || (f.mover?.lineInfo?.station === a.at.id))) || (a.ev && (a.ev.detectedBy === f.robot || a.ev.responder === f.mover?.id)));
      mine.slice(0, 2).forEach((a, k) => {
        const txt = `${a.sev === 'alarm' ? '⛔' : '⚠'} ${a.text}`; g.font = `700 14px ${FONT}`;
        const w = Math.min(TW - 20, g.measureText(txt).width + 18);
        g.fillStyle = a.sev === 'alarm' ? (Math.sin(this.t * 6) > -0.3 ? 'rgba(220,40,40,0.9)' : 'rgba(150,20,20,0.9)') : 'rgba(225,160,30,0.92)';
        g.fillRect(x0 + (TW - w) / 2, y0 + 30 + k * 26, w, 22);
        g.fillStyle = '#fff'; g.fillText(txt, x0 + (TW - w) / 2 + 9, y0 + 46 + k * 26, w - 14);
      });
      // 칸 테두리
      g.restore();
      g.strokeStyle = mine.some((a) => a.sev === 'alarm') ? '#ff4d4d' : 'rgba(127,243,255,0.35)'; g.lineWidth = mine.some((a) => a.sev === 'alarm') ? 4 : 2;
      g.strokeRect(x0 + 1, y0 + 1, TW - 2, TH - 2);
    });
    // 하단 알람 띠 (현장 전체)
    const band = 30, y = H - band;
    g.fillStyle = 'rgba(5,8,12,0.85)'; g.fillRect(0, y, W, band);
    g.font = `700 14px ${FONT}`; g.fillStyle = alarms.some((a) => a.sev === 'alarm') ? '#ff6b6b' : alarms.length ? '#f5b82e' : '#3ddc84';
    const head = alarms.length ? `현장 알람 ${alarms.length}건` : '현장 알람 없음 · 정상 운영';
    g.fillText(head, 12, y + 20);
    g.font = `13px ${FONT}`; g.fillStyle = '#e8edf2';
    let x = 22 + g.measureText(head).width + 40;
    for (const a of alarms.slice(0, 6)) { const s = `${a.sev === 'alarm' ? '⛔' : a.sev === 'warn' ? '⚠' : 'ℹ'} ${a.text}`; g.fillText(s, x, y + 20); x += g.measureText(s).width + 28; if (x > W - 200) break; }
    g.fillStyle = '#7fb8cc'; g.font = `12px ${FONT}`; const tag = `ROBOT VISION · AI 추론 관제 · ${clock}`; g.fillText(tag, W - g.measureText(tag).width - 12, y + 20);
    this.overTex.needsUpdate = true;
  }

  // ── 현장 이벤트 3D 표시 ─────────────────
  syncEvents(rdt) {
    const evs = (this.sim.fieldEvents ?? []).filter((e) => !e.cleared);
    const live = new Set(evs.map((e) => e.id));
    for (const [id, m] of this.evMeshes) if (!live.has(id)) { this.evGroup.remove(m, m.userData.fxRoot); this.evMeshes.delete(id); }
    for (const ev of evs) {
      let m = this.evMeshes.get(ev.id);
      if (!m) {
        m = makeEventMesh(ev.type); m.position.set(ev.x, 0, ev.z); this.evGroup.add(m); this.evMeshes.set(ev.id, m);
        // 현장 이벤트 경보: 바닥 구역·경광등·빛기둥 + 퍼지는 파문 + 떠 있는 경고 표지 (해결되면 이벤트와 함께 사라짐)
        const color = ev.severity === 'alarm' ? ALARM_COLOR.fault : ALARM_COLOR.event;
        m.userData.alarm = makeAlarmFx(4.4, 4.4, 7); m.userData.color = color;
        m.userData.fx = makeEventFx(ev, color);
        const fx = new THREE.Group(); fx.position.copy(m.position); fx.add(m.userData.alarm, m.userData.fx);
        this.evGroup.add(fx); m.userData.fxRoot = fx;
      }
      m.userData.tick?.(rdt, this.t);
      blinkAlarmFx(m.userData.alarm, true, m.userData.color, this.t);
      m.userData.fx.userData.tick(this.t);
    }
  }

  // 로봇 카메라 앞 3~6m 바닥(설비 밖)에 현장 이벤트를 만든다 — 곧 그 로봇 영상에 잡힌다
  injectRandom(type) {
    const types = Object.keys(FIELD_EVENTS);
    type ??= types[Math.floor(Math.random() * types.length)];
    const cands = (this.list ?? this.feeds()).filter((f) => f.mover);
    for (let k = 0; k < 40; k++) {
      const f = cands[Math.floor(Math.random() * cands.length)]; if (!f) break;
      const { pos, dir } = f.pose(), d = 3 + Math.random() * 3, lat = (Math.random() - 0.5) * 2;
      const fx = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      const x = pos.x + fx.x * d - fx.z * lat, z = pos.z + fx.z * d + fx.x * lat;
      const inside = this.sim.stations.some((st) => Math.abs(x - st.x) < 3.2 && Math.abs(z - st.z) < 3.2);
      if (inside || Math.abs(x) > 34 || Math.abs(z) > 17) continue;
      return this.sim.injectFieldEvent(type, x, z);
    }
    return null;
  }
}

// 현장 이벤트 위치 강조: 바깥으로 퍼지는 파문 3겹 + 설비에 가려지지 않는 경고 표지 (0.9초 주기로 깜빡임)
const REDUCED = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function makeEventFx(ev, color) {
  const g = new THREE.Group();
  const rings = [0, 1, 2].map((i) => {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    r.rotation.x = -Math.PI / 2; r.position.y = 0.04 + i * 0.002; r.userData.ph = i / 3; g.add(r); return r;
  });
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const x = c.getContext('2d'), hex = '#' + color.toString(16).padStart(6, '0');
  x.fillStyle = 'rgba(12,14,18,0.88)'; x.beginPath(); x.roundRect(4, 4, 504, 120, 26); x.fill();
  x.lineWidth = 8; x.strokeStyle = hex; x.stroke();
  x.fillStyle = hex; x.font = `800 58px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(`${ev.severity === 'alarm' ? '⛔' : '⚠'} ${ev.label}`, 256, 68);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
  tag.scale.set(6, 1.5, 1); tag.position.y = 8.6; tag.renderOrder = 10; g.add(tag);
  g.userData.tick = (t) => {
    const on = REDUCED || Math.sin(t * Math.PI * 2 / 0.9) > 0;
    tag.material.opacity = on ? 1 : 0.35;
    tag.position.y = 8.6 + (REDUCED ? 0 : Math.sin(t * 2.4) * 0.15);
    for (const r of rings) {
      const k = REDUCED ? 0.6 : (t / 1.8 + r.userData.ph) % 1;
      r.scale.setScalar(1 + k * 4.2); r.material.opacity = 0.75 * (1 - k);
    }
  };
  return g;
}

function makeEventMesh(type) {
  const g = new THREE.Group();
  if (type === 'leak') {
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.85, 28), new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.85 }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.02; m.scale.set(1, 0.7, 1); g.add(m);
    const m2 = m.clone(); m2.scale.set(0.45, 0.4, 1); m2.position.set(0.7, 0.021, 0.4); g.add(m2);
  } else if (type === 'debris') {
    const mat = [new THREE.MeshStandardMaterial({ color: 0xc49a6c, roughness: 0.9 }), new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.7, roughness: 0.3 })];
    [[0, 0.12, 0, 0.5, 0.24, 0.35, 0], [0.45, 0.05, 0.3, 0.3, 0.1, 0.12, 1], [-0.35, 0.04, -0.25, 0.22, 0.08, 0.22, 1]].forEach(([x, y, z, w, h, d, k]) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat[k]); b.position.set(x, y, z); b.rotation.y = x * 2; b.castShadow = true; g.add(b);
    });
  } else if (type === 'intrusion') {
    const vest = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0x330000 }), pants = new THREE.MeshStandardMaterial({ color: 0x2b2f36 }), skin = new THREE.MeshStandardMaterial({ color: 0xe0b48c });
    for (const x of [-0.11, 0.11]) { const l = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.7, 4, 8), pants); l.position.set(x, 0.45, 0); g.add(l); }
    const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.55, 4, 10), vest); b.position.y = 1.25; g.add(b);
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), skin); h.position.y = 1.78; g.add(h);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.userData.tick = (dt, t) => { g.rotation.y = Math.sin(t * 0.6) * 0.8; };
  } else if (type === 'smoke') {
    const puffs = Array.from({ length: 14 }, (_, i) => {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.35 + (i % 3) * 0.12, 10, 8), new THREE.MeshStandardMaterial({ color: 0x8a8f96, transparent: true, opacity: 0.35, depthWrite: false, roughness: 1 }));
      p.userData.ph = i / 14; g.add(p); return p;
    });
    g.userData.tick = (dt, t) => puffs.forEach((p) => {
      const k = (t * 0.25 + p.userData.ph) % 1;
      p.position.set(Math.sin(p.userData.ph * 20) * 0.5 * k, 0.4 + k * 3.2, Math.cos(p.userData.ph * 17) * 0.5 * k);
      p.scale.setScalar(0.6 + k * 1.4); p.material.opacity = 0.4 * (1 - k);
    });
  }
  return g;
}
