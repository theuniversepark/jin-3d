// 순찰 드론 (피지컬AI 단계) — 공장 상공(약 6m)을 순회하며 셀마다 멈춰 내려다보고(짐벌·하방 카메라 영상은 로봇 비전 관제 화면으로),
// 현장 이벤트·설비 고장·결품·공급 차질이 생기면 순찰을 멈추고 그 현장으로 먼저 날아가 사고 현장을 중계·관찰 보고한다. 배터리가 떨어지면 이착륙장으로 돌아가 충전한다.
// 지상 이동체 교통(차로·양보)과는 높이가 달라 서로 피하지 않는다. 렌더링과 분리되어 헤드리스에서도 같은 동작.
// 드론끼리는 공간을 나눠 쓴다 (DRONE_SEP): ① 정지 비행 자리 분산 — 같은 곳(같은 위치의 다른 인시던트 · 순찰 지점 위 임무)으로 가는 드론은 2.4m씩 떨어진 자리를 잡는다
// ② 간격 유지 — 다른 드론과 중심거리 1.6m(기체 폭 0.8m의 2배) 안으로 다가가는 이동은 하지 않는다(그 자리 정지 비행) ③ 항로 교차 — 길 위에 다른 드론이 있으면 옆으로 비켜 돌아간다(우선권이 낮은 쪽)

import { WH_RACK, MINILOAD } from './receiving.js';
// 이착륙·충전 패드: 오른쪽 AMR 복귀 전용로(세로 x 31.2) 왼쪽에 세로 한 줄 — 드론마다 앞쪽으로 1.7m씩 (H1 z 12.8 · H2 14.5 · H3 16.2)
// 패드(반지름 0.7m, 드론 폭 0.8m)는 앞쪽 통로 이동체(지게차 포함)·복귀로 AMR과 충돌 반경 기준 0.5m 이상 떨어진다 (운용 3대 기준 — 4대째 H4 z 17.9는 가로 복귀로에 닿는다)
export const DRONE_PAD = { x: 29.2, z: 12.8, pitch: 1.7, r: 0.7 };
export const dronePad = (i) => ({ x: DRONE_PAD.x, z: DRONE_PAD.z + i * DRONE_PAD.pitch });
export const MISSION_PRIO = { field: 4, equipment: 3, parts: 2, supply: 1 };   // 출동 우선순위 (현장 이벤트 > 설비 고장 > 부품 결품 > 공급 차질)
// 현장 중계 유지 시간: 안전·설비 문제는 해소될 때까지, 오래 끄는 물류 문제(결품·공급 차질)는 관찰 보고 후 90초만 중계하고 순찰로 돌아간다
export const RELAY_MAX = { field: 600, equipment: 600, parts: 90, supply: 90 };
// 드론 운용 대수 산정 (정밀조립Zone 76m × 40m + 입고·출하 도크, 순찰 지점 13곳, 비행 24분·충전 4분)
// 운영 시나리오: 자연 설비 고장·부품 결품 + 현장 이벤트 시간당 6건 + 90분마다 10분 공급 차질, 3시간 × 시드 3, 헤드리스 측정
// 기준: ① 순찰 재방문 p95 ≤ 120초  ② 20초 넘게 이어진 인시던트에 20초 안 도착 ≥ 95%  ③ 가용 드론 0대 시간 ≤ 1%
export const DRONE_SIZING = {
  chosen: 3,
  criteria: { revisitP95: 120, arrive20: 95, noneMax: 1 },
  rows: [   // 측정값 (README '드론 운용 대수 산정')
    { n: 1, revisit: 163, revisitP95: 356, arriveP95: 51.6, arrive20: 81.2, none: 28.0, util: 10.5 },
    { n: 2, revisit: 89, revisitP95: 274, arriveP95: 12.7, arrive20: 100, none: 5.0, util: 6.2 },
    { n: 3, revisit: 46, revisitP95: 91, arriveP95: 9.9, arrive20: 100, none: 0.5, util: 4.3 },
    { n: 4, revisit: 44, revisitP95: 75, arriveP95: 10.3, arrive20: 100, none: 0.0, util: 3.1 },
  ],
  stress: { rate: 12, n2: { revisitP95: 272, arrive20: 97.2, none: 8.7 }, n3: { revisitP95: 107, arrive20: 100, none: 1.1 } },   // 현장 이벤트 2배(시간당 12건)
};
const ALT = 6.0, LOW = 5.4, SPEED = 3.4, CLIMB = 1.4, YAW_RATE = 1.6;
// 미니로드 자동창고(선반 꼭대기 크라운 프레임 윗면 5.76m) 위는 6.35m로 넘는다 — 순찰 고도 6.0m에서는 기체 아래 짐벌 · 스키드(중심에서 0.26m 아래)가 크라운 프레임을 스치고, 사고 현장 고도 5.4m는 선반 속이다
// pad: 선반 둘레 이만큼 앞에서부터 오른다 (5.4 → 6.35m를 초속 1.4m로 오르는 0.7초 동안 초속 3.4m로 2.3m 간다) · 천장 설비(7.2m~)까지 0.8m 남는다
const RACK_OVER = { alt: MINILOAD.top + 0.65, pad: 2.4, hx: MINILOAD.half + 0.05, hz: 5.15 };
const overRack = (x, z) => Math.abs(x - WH_RACK.x) < RACK_OVER.hx + RACK_OVER.pad && Math.abs(z - WH_RACK.z) < RACK_OVER.hz + RACK_OVER.pad;
// 드론끼리 간격: min = 중심거리 하한(기체 폭 0.8m × 2 — 로터 끝 사이 0.5m 이상) · slot = 정지 비행 자리 사이 간격 · around = 비켜 돌아갈 때 더 두는 여유
// (천장 설비가 7.2m부터라 고도를 층으로 나눌 수 없다 — 5G 소형 셀 7.2m · CCTV 돔 7.5m. 그래서 같은 고도에서 수평 간격으로 분리한다. 이착륙 패드 간격 1.7m > min)
export const DRONE_SEP = { min: 1.6, slot: 2.4, around: 0.35 };
const HOVER = 4, DRAIN = 100 / (24 * 60), CHARGE = 100 / (4 * 60);   // 비행 24분 · 충전 4분

export class PatrolDrone {
  constructor(sim, i = 0, n = 1) {
    this.sim = sim; this.id = `순찰 드론-${i + 1}`; this.kind = 'drone'; this.idx = i; this.fleet = n;
    const pad = dronePad(i);
    this.x = pad.x; this.z = pad.z; this.y = 0.25; this.heading = Math.PI; this.battery = 100 - i * (60 / Math.max(1, n));   // 충전이 겹치지 않게 배터리를 엇갈려 시작
    this.home = { ...pad, aisle: 'F', name: `드론 이착륙장 ${i + 1}` };
    this.task = '이륙 준비'; this.mode = 'patrol'; this.wp = 0; this.hover = 0; this.moving = false; this.charging = false;
    this.target = null; this.mission = null; this.arrived = false; this.speedNow = 0; this.vy = 0;
    this.claim = null; this.claimBase = null; this.heldT = 0;
  }
  // 통행 우선권: 출동 > 귀환(배터리) > 순찰, 같으면 번호가 앞선 드론 — 낮은 쪽이 비켜 간다
  get rank() { return (this.mode === 'mission' ? 3 : this.mode === 'return' ? 2 : 1) * 10 - this.idx; }
  // 정지 비행 자리 배정: 가려는 곳(base)이 다른 드론이 잡은 자리 · 다른 드론 이착륙 패드에서 slot(2.4m) 안이면 base 둘레(반지름 2.4m 여섯 자리 → 4.8m 열두 자리)의 빈 자리를 잡는다.
  // 한번 잡은 자리는 그대로 둔다(다른 드론이 나중에 와도 먼저 잡은 쪽이 지킨다) — 드론은 번호순으로 갱신하므로 같은 틱에 같은 자리를 둘이 잡지 않는다
  // 둘레 자리는 지금 내 자리에서 가장 가까운 빈 자리(오는 쪽 자리 — 서로 길이 엇갈리지 않게). 가는 길이 정지 비행 중인 드론들에 막혀 2초 넘게 못 가면 그 자리를 버리고 다시 고른다(skip)
  hoverAt(base) {
    const S = DRONE_SEP.slot, others = this.sim.drones.filter((d) => d !== this), taken = [...others.map((d) => d.claim).filter(Boolean), ...others.map((d) => d.home)];
    const ok = (p) => taken.every((q) => Math.hypot(p.x - q.x, p.z - q.z) >= S - 1e-6);
    if (this.claim && this.claimBase && Math.hypot(this.claimBase.x - base.x, this.claimBase.z - base.z) < 1e-6 && ok(this.claim)) return this.claim;
    const skip = this.claimSkip, usable = (p) => ok(p) && !(skip && Math.hypot(p.x - skip.x, p.z - skip.z) < 0.1), near = (p) => Math.hypot(p.x - this.x, p.z - this.z);
    let pick = usable(base) ? { x: base.x, z: base.z } : null;
    for (const [r, n] of [[S, 6], [2 * S, 12]]) {   // 안쪽 둘레부터 — 그 둘레의 빈 자리 가운데 가장 가까운 곳
      if (pick) break;
      const ring = Array.from({ length: n }, (_, k) => { const a = (k / n) * 2 * Math.PI + Math.PI / 6; return { x: base.x + Math.sin(a) * r, z: base.z + Math.cos(a) * r }; }).filter(usable);
      pick = ring.sort((a, b) => near(a) - near(b))[0] ?? null;
    }
    this.claim = pick ?? { x: base.x, z: base.z }; this.claimBase = { x: base.x, z: base.z }; this.claimSkip = null;
    return this.claim;
  }
  // (x, y, z)로 옮겨도 되는가: 다른 드론과 중심거리 min 안으로 다가가는 이동은 안 된다 (이미 안쪽이면 멀어지는 이동만)
  clearAt(x, y, z) {
    for (const o of this.sim.drones) {
      if (o === this) continue;
      const d1 = Math.hypot(x - o.x, y - o.y, z - o.z);
      if (d1 < DRONE_SEP.min && d1 < Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) - 1e-9) return false;
    }
    return true;
  }
  // 목표로 곧게 가는 길 위(중심거리 min 안으로 스치는 길)에 다른 드론이 있으면 그 드론을 around만큼 비켜 도는 방향 — 없으면 그대로 (ux, uz)
  // 서 있는(정지 비행 · 이착륙 중) 드론은 누구든 비켜 가고, 움직이는 드론은 우선권이 낮은 쪽이 비켜 간다. 2초 넘게 막혀 있으면 우선권과 상관없이 비켜 간다
  steer(ux, uz, dGoal) {
    let best = null, bt = Infinity;
    for (const o of this.sim.drones) {
      if (o === this) continue;
      const dy = Math.abs(o.y - this.y); if (dy >= DRONE_SEP.min) continue;
      if ((o.speedNow ?? 0) > 0.05 && this.rank > o.rank && this.heldT < 2) continue;
      const rh = Math.sqrt(DRONE_SEP.min ** 2 - dy * dy), ox = o.x - this.x, oz = o.z - this.z, t = Math.max(0, Math.min(dGoal, ox * ux + oz * uz));
      if (t <= 0 || Math.hypot(ox - ux * t, oz - uz * t) >= rh + 0.1) continue;   // 지나친 뒤이거나, 목표까지 가는 길이 min + 0.1m 밖
      if (t < bt) { bt = t; best = { o, rh: rh + DRONE_SEP.around, ox, oz }; }
    }
    if (!best) return [ux, uz];
    const od = Math.hypot(best.ox, best.oz), ho = Math.atan2(best.ox, best.oz), hg = Math.atan2(ux, uz);
    const delta = ((hg - ho + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const a = od > best.rh ? Math.asin(best.rh / od) : Math.PI / 2 + 0.25;   // 비켜 갈 반경 안이면 옆으로 돌며 조금씩 벌린다
    const h = ho + (delta >= 0 ? a : -a);   // 목표 쪽으로 도는 방향 (정면이면 둘 다 같은 쪽으로 돌아 엇갈린다)
    return [Math.sin(h), Math.cos(h)];
  }
  // 순찰 경로: 셀 위를 라인 흐름 순서로, 끝나면 자재 투입·창고 쪽을 돌아 처음으로
  route() {
    const s = this.sim, pts = [];
    for (const st of s.processing.filter((x) => !x.standby)) pts.push({ x: st.x, z: st.z, name: `${st.name} 상공`, scan: st });
    const sink = s.stations[s.stations.length - 1], src = s.stations[0];
    pts.push({ x: sink.x, z: sink.z, name: '구분 적재장 상공', scan: sink });
    pts.push({ x: 26.5, z: -14.5, name: '출하 도크 상공' });
    pts.push({ x: -45, z: -1.6, name: '자재창고 상공' });
    pts.push({ x: src.x, z: src.z, name: '자재 투입 상공', scan: src });
    pts.push({ x: -48, z: -14.5, name: '입고 도크 상공' });
    // 여러 대면 순찰 경로를 이어진 구간으로 나눠 맡는다 (드론 i → i번째 구간)
    if (this.fleet <= 1) return pts;
    const k = Math.ceil(pts.length / this.fleet);
    return pts.slice(this.idx * k, this.idx * k + k).concat(this.idx * k >= pts.length ? pts.slice(-1) : []);
  }

  update(dt) {
    const s = this.sim, K = s.cmd;
    this.moving = false; this.charging = false;
    // 전체 비상정지·보호정지: 제자리 정지 비행 (착륙해 있으면 그대로)
    if (K?.estopAll || K?.pstopAll) { this.task = this.y > 0.5 ? '정지 비행 (비상정지)' : '대기 (비상정지)'; this.speedNow = 0; return; }
    if (this.y > 0.5) { this.battery = Math.max(0, this.battery - DRAIN * dt); this.flight = (this.flight ?? 0) + dt; }
    // 대피 명령·배터리 부족 → 귀환
    if ((K?.evac || this.battery < 22) && this.mode !== 'return' && this.mode !== 'charge') { if (this.mission) this.mission.droneBy = null; this.mode = 'return'; this.mission = null; }   // 출동 중이면 다른 드론이 이어받는다
    if (this.mode === 'charge') {
      this.charging = true; this.task = K?.evac ? '대기 (대피)' : `충전 중 ${this.battery.toFixed(0)}%`;
      this.battery = Math.min(100, this.battery + CHARGE * dt);
      if (this.battery >= 98 && !K?.evac) { this.mode = 'patrol'; s.log('info', `${this.id} 순찰 재개`, { obs: '배터리 충전 완료' }); }
      return;
    }
    // 문제 상황 우선 출동: 배정은 시뮬레이션의 드론 관제(sim.dispatchDrones — 가장 가까운 가용 드론, 없으면 낮은 우선순위 출동을 넘겨받음)가 하고,
    // 드론은 현장으로 날아가 저고도 정지 비행으로 중계·관찰 보고한다 (sim.droneAssist). 인시던트가 닫히면 순찰 복귀
    const relayOver = this.mission && this.arrived && s.time - this.mission.drone.tArrive > (RELAY_MAX[this.mission.type] ?? 600);
    if (this.mode === 'mission' && (!this.mission || this.mission.status !== 'open' || relayOver || s.time - this.mission.t0 > 900)) {
      if (this.mission && this.arrived) s.log('ok', `${this.id} 현장 중계 종료 · 순찰 복귀`, { obs: `${this.mission.title} ${this.mission.status === 'open' ? '관찰 보고 완료 — 오케스트레이터가 계속 대응' : '해소'}` });
      if (this.mission && relayOver && this.mission.status === 'open') s.orch.step(this.mission, 'exec', 'act', `${this.id} 관찰 보고 완료 · 순찰 복귀 (현장 상황은 오케스트레이터가 계속 추적)`);
      if (this.mission) this.mission.droneDone = true;
      this.mission = null; this.mode = 'patrol';
    }
    let goal, alt = ALT, label;
    // 패드로 돌아올 때는 패드 한가운데(6cm 안) 위에서만 내려간다 — 옆 패드(1.7m)의 드론과 간격(min 1.6m)이 남게
    if (this.mode === 'return') { goal = this.home; this.claim = { x: goal.x, z: goal.z }; this.claimBase = null; alt = this.near(goal, 0.06) || this.y < ALT - 0.1 && this.near(goal, 0.3) ? 0.25 : ALT; label = K?.evac ? '귀환 (대피)' : `귀환 · 배터리 ${this.battery.toFixed(0)}%`; }
    else if (this.mode === 'mission') { const w = this.mission.where, at = this.hoverAt(w); goal = at === w ? w : { ...w, x: at.x, z: at.z }; alt = LOW; label = this.arrived ? `사고 현장 중계 · ${this.mission.title}` : `사고 현장 우선 출동 · ${this.mission.title}`; }
    else {
      const pts = this.route(); this.wp %= pts.length; const w = pts[this.wp], at = this.hoverAt(w); goal = { ...w, x: at.x, z: at.z }; label = `순찰 · ${goal.name}`;
      if (this.y < 0.5) label = '이륙';
    }
    // 수직 이착륙: 패드 위에서는 먼저 오르내린다 (오르내릴 자리에 다른 드론이 있으면 그 고도에서 기다린다)
    if (alt > 1 && overRack(this.x, this.z)) alt = Math.max(alt, RACK_OVER.alt);   // 자동창고 선반 위 · 둘레: 넘는 고도
    const dy = alt - this.y, climbing = Math.abs(dy) > 0.05;
    if (climbing) { const ny = this.y + Math.sign(dy) * Math.min(Math.abs(dy), CLIMB * dt); if (this.clearAt(this.x, ny, this.z)) { this.y = ny; this.moving = true; } }
    if (this.y > 3 || !climbing) {
      const dx = goal.x - this.x, dz = goal.z - this.z, d = Math.hypot(dx, dz);
      if (d > (this.mode === 'return' ? 0.03 : 0.15)) {
        const want = Math.atan2(dx, dz);
        let dh = ((want - this.heading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        this.heading += Math.sign(dh) * Math.min(Math.abs(dh), YAW_RATE * dt);
        const v = Math.min(SPEED, Math.max(d * 1.2, Math.min(0.3, d / dt))) * (Math.abs(dh) > 1.2 ? 0.3 : 1);
        // 드론끼리 간격: 길 위의 다른 드론은 비켜 돌고(steer), 그래도 중심거리 min 안으로 다가가게 되면 이번 틱은 그 자리 정지 비행(clearAt)
        const [ux, uz] = this.steer(dx / d, dz / d, d), nx = this.x + ux * v * dt, nz = this.z + uz * v * dt;
        if (this.clearAt(nx, this.y, nz)) { this.x = nx; this.z = nz; this.speedNow = v; this.moving = true; this.heldT = 0; }
        else {
          this.speedNow = 0; this.heldT += dt; label += ' · 간격 유지 대기';
          if (this.heldT > 2) {
            // 2초 넘게 못 감(정지 비행 중인 드론들 사이에 낌): 정지 비행 자리는 다시 고르고, 패드로 돌아가는 길이면 옆으로 빠질 수 있는 쪽으로 비켜난다
            if (this.mode !== 'return') { this.claimSkip = this.claim; this.claim = null; this.heldT = 0; }
            else for (const a of [1.05, -1.05, 2.1, -2.1, Math.PI]) { const h = want + a, ex = this.x + Math.sin(h) * v * dt, ez = this.z + Math.cos(h) * v * dt; if (this.clearAt(ex, this.y, ez)) { this.x = ex; this.z = ez; this.speedNow = v; this.moving = true; break; } }
          }
        }
      } else {
        this.speedNow = 0;
        if (this.mode === 'patrol' && !climbing) {
          this.hover += dt; this.heading += 0.5 * dt;   // 제자리에서 천천히 돌며 내려다본다
          label = `순찰 · ${goal.name} 점검`;
          if (this.hover >= HOVER) { this.hover = 0; this.wp++; this.visits = (this.visits ?? 0) + 1; s.droneLog?.(this, goal.name); }
        } else if (this.mode === 'mission' && !climbing) {
          this.heading += 0.35 * dt;   // 현장 위에서 천천히 돌며 중계
          if (!this.arrived) { this.arrived = true; this.missions = (this.missions ?? 0) + 1; s.droneAssist(this.mission, this); }
        }
        else if (this.mode === 'return' && this.y <= 0.3) { this.mode = 'charge'; s.log('info', `${this.id} 착륙`, { obs: K?.evac ? '대피 명령' : `배터리 ${this.battery.toFixed(0)}%`, act: K?.evac ? '이착륙장 대기' : '무선 충전 시작' }); }
      }
    }
    this.task = label;
  }
  // 출동 가능: 순찰 중(또는 이륙 전)이고 배터리 여유가 있음
  get available() { const K = this.sim.cmd; return this.mode === 'patrol' && this.battery >= 25 && !K?.estopAll && !K?.pstopAll && !K?.evac; }
  assign(inc) {
    const s = this.sim;
    if (this.mission && this.mission !== inc) {   // 더 급한 출동으로 전환: 이미 관찰 보고한 현장은 다시 보내지 않고, 아직이면 다른 드론이 이어받는다
      if (this.mission.drone) this.mission.droneDone = true; else this.mission.droneBy = null;
      s.orch.step(this.mission, 'exec', 'act', `${this.id} 더 급한 인시던트로 전환${this.mission.drone ? ' (관찰 보고 완료)' : ' — 다른 드론 재배정'}`);
    }
    this.mission = inc; this.mode = 'mission'; this.arrived = false; this.claim = null; inc.droneBy = this.id; inc.droneT = s.time;   // 정지 비행 자리는 새로 잡는다 (hoverAt)
    const eta = Math.hypot(inc.where.x - this.x, inc.where.z - this.z) / SPEED;
    if (inc.type === 'field') { this.evChecks = (this.evChecks ?? 0) + 1; if (inc.ev) inc.ev.droneBy = this.id; }
    s.orch.step(inc, 'exec', 'act', `${this.id} 우선 출동 — 사고 현장 상공으로 비행 (약 ${Math.max(1, Math.round(eta))}초)`);
    s.log('act', `${this.id} 사고 현장 우선 출동 · ${inc.title}`, { obs: `${inc.title} 발생`, dec: `드론 관제: 가장 가까운 가용 드론 (${s.drones.length}대 중)`, act: `순찰 중단 → 현장 상공 저고도 정지 비행 · 영상 중계 (도착 약 ${Math.max(1, Math.round(eta))}초)` });
  }
  near(p, r) { return Math.hypot(p.x - this.x, p.z - this.z) < r; }
  // 짐벌·하방 카메라가 보고 있는 지점
  get scanning() { return this.mode === 'patrol' && this.hover > 0 ? this.route()[this.wp % this.route().length]?.scan ?? null : null; }
}
