// 로봇 비전 관제 디스플레이 (피지컬AI 단계) — 로봇·드론에 달린 카메라 시점의 실시간 영상 8분할 + AI 추론 오버레이.
// 영상: 각 로봇 카메라 시점으로 장면을 렌더 타깃의 한 칸에 그린다(프레임마다 한 칸씩 돌아가며 갱신).
// 오버레이: 카메라로 투영한 객체 인식 박스·신뢰도, 추론 지연, 작업 상태, 현장 이벤트·알람 배너와 하단 알람 띠.
import * as THREE from 'three';
import { FIELD_EVENTS, ST_LABEL, moverRadius } from './sim.js';
import { makeAlarmFx, blinkAlarmFx, ALARM_COLOR } from './factory.js';

export const COLS = 4, ROWS = 2;
const TW = 384, TH = 256, W = COLS * TW, H = ROWS * TH;   // 4×2 분할 (오른쪽 열: 순찰 드론 짐벌·하방 카메라)
const DISPLAY = { x: 10.6, y: 5.1, z: -19.15, w: 12, h: 4 };   // 중앙 관제 화면(x -2, 12×4) 바로 오른쪽(테두리 사이 0.3m), 같은 높이·크기로 벽 기둥 앞에 설치
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

  // ── 카메라를 단 로봇 6대 ─────────────────
  feeds() {
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
    mover(sim.quads[1], '전방 카메라', 0.62, 0.68, 6, 0.15);
    // AMMR 머리 카메라 (부품분류셀) — 작업 영역을 내려다본다
    const sv = view?.stationViews.find((s) => s.parts.robots?.some((r) => r.kind === 'ammr'));
    const r = sv?.parts.robots.find((x) => x.kind === 'ammr');
    if (r) {
      const idx = sv.parts.robots.indexOf(r);
      out.push({ ref: { type: 'cell', stationId: sv.st.id, idx }, robot: `${sv.st.name} AMMR #${idx + 1}`, label: '머리 스테레오 카메라', kind: 'ammr', station: sv.st,
        pose: () => { const p = r.head.getWorldPosition(new THREE.Vector3()); const d = r.root.getWorldDirection(new THREE.Vector3()); d.y = -0.75; return { pos: p, dir: d.normalize(), ahead: 3 }; } });
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
    const d = sim.drones?.[0];
    if (d) {
      const drone = (label, down, fwd, ahead) => ({ ref: { type: 'mover', id: d.id }, robot: d.id, label, kind: 'drone', mover: d,
        pose: () => { const fx = Math.sin(d.heading), fz = Math.cos(d.heading), look = d.mode === 'event' || d.hover > 0;
          return { pos: new THREE.Vector3(d.x + fx * fwd, d.y - 0.15, d.z + fz * fwd), dir: new THREE.Vector3(fx, typeof down === 'function' ? down(look) : down, fz).normalize(), ahead }; } });
      out.splice(3, 0, drone('짐벌 카메라', (look) => (look ? -2.2 : -0.55), 0.3, 8));
      out.splice(7, 0, drone('하방 매핑 카메라', -12, 0.05, 6));
    }
    while (out.length < COLS * ROWS && sim.vehicles[out.length - 6]) mover(sim.vehicles[out.length - 6], '전방 카메라', 0.45, 0.85, 5, 0.12);
    return out.slice(0, COLS * ROWS);
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
      g.fillStyle = '#e8edf2'; g.font = `600 13px ${FONT}`; g.fillText(`${f.robot} · ${f.label}`, x0 + 22, y0 + 15);
      const lat = 14 + Math.round(hash(f.robot + Math.floor(this.t * 2)) * 12);
      g.fillStyle = '#7ff3ff'; g.font = `12px ${FONT}`; const info = `AI 추론 ${lat}ms · 객체 ${n} · ${simClock}`;
      g.fillText(info, x0 + TW - g.measureText(info).width - 8, y0 + 15);
      // 칸 바닥: 로봇 작업
      const au = f.station?.ammr?.[f.ref.idx];
      const task = f.mover ? f.mover.task ?? '대기' : (f.station ? `${f.station.name} ${ST_LABEL[f.station.state] ?? ''} · ${au && au.phase !== 'work' ? '부품 선반 왕복 (보충)' : '양팔 작업'} · 빈 ${au?.bin ?? '-'}/10` : '');
      const fy = y0 + TH - 20 - (row === ROWS - 1 ? 30 : 0);   // 아래 줄은 하단 알람 띠 위로
      g.fillStyle = 'rgba(5,8,12,0.6)'; g.fillRect(x0, fy, TW, 20);
      g.fillStyle = '#cfe6f0'; g.font = `12px ${FONT}`; g.fillText(`작업: ${task}`.slice(0, 48), x0 + 8, fy + 14);
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
