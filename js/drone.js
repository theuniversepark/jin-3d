// 순찰 드론 (피지컬AI 단계) — 공장 상공(약 6m)을 순회하며 셀마다 멈춰 내려다보고(짐벌·하방 카메라 영상은 로봇 비전 관제 화면으로),
// 현장 이벤트·설비 고장·결품·공급 차질이 생기면 순찰을 멈추고 그 현장으로 먼저 날아가 사고 현장을 중계·관찰 보고한다. 배터리가 떨어지면 이착륙장으로 돌아가 충전한다.
// 지상 이동체 교통(차로·양보)과는 높이가 달라 서로 피하지 않는다. 렌더링과 분리되어 헤드리스에서도 같은 동작.

export const DRONE_PAD = { x: 20.5, z: 14.2 };   // 이착륙·충전 패드 (앞쪽, 정비실 오른쪽) — 드론마다 오른쪽으로 3m씩
export const dronePad = (i) => ({ x: DRONE_PAD.x + i * 3, z: DRONE_PAD.z });
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
const HOVER = 4, DRAIN = 100 / (24 * 60), CHARGE = 100 / (4 * 60);   // 비행 24분 · 충전 4분

export class PatrolDrone {
  constructor(sim, i = 0, n = 1) {
    this.sim = sim; this.id = `순찰 드론-${i + 1}`; this.kind = 'drone'; this.idx = i; this.fleet = n;
    const pad = dronePad(i);
    this.x = pad.x; this.z = pad.z; this.y = 0.25; this.heading = Math.PI; this.battery = 100 - i * (60 / Math.max(1, n));   // 충전이 겹치지 않게 배터리를 엇갈려 시작
    this.home = { ...pad, aisle: 'F', name: `드론 이착륙장 ${i + 1}` };
    this.task = '이륙 준비'; this.mode = 'patrol'; this.wp = 0; this.hover = 0; this.moving = false; this.charging = false;
    this.target = null; this.mission = null; this.arrived = false; this.speedNow = 0; this.vy = 0;
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
    if (this.mode === 'return') { goal = this.home; alt = this.near(goal, 0.3) ? 0.25 : ALT; label = K?.evac ? '귀환 (대피)' : `귀환 · 배터리 ${this.battery.toFixed(0)}%`; }
    else if (this.mode === 'mission') { goal = this.mission.where; alt = LOW; label = this.arrived ? `사고 현장 중계 · ${this.mission.title}` : `사고 현장 우선 출동 · ${this.mission.title}`; }
    else {
      const pts = this.route(); this.wp %= pts.length; goal = pts[this.wp]; label = `순찰 · ${goal.name}`;
      if (this.y < 0.5) label = '이륙';
    }
    // 수직 이착륙: 패드 위에서는 먼저 오르내린다
    const dy = alt - this.y, climbing = Math.abs(dy) > 0.05;
    if (climbing) { this.y += Math.sign(dy) * Math.min(Math.abs(dy), CLIMB * dt); this.moving = true; }
    if (this.y > 3 || !climbing) {
      const dx = goal.x - this.x, dz = goal.z - this.z, d = Math.hypot(dx, dz);
      if (d > 0.15) {
        const want = Math.atan2(dx, dz);
        let dh = ((want - this.heading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        this.heading += Math.sign(dh) * Math.min(Math.abs(dh), YAW_RATE * dt);
        const v = Math.min(SPEED, d * 1.2) * (Math.abs(dh) > 1.2 ? 0.3 : 1);
        this.x += (dx / d) * v * dt; this.z += (dz / d) * v * dt; this.speedNow = v; this.moving = true;
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
    this.mission = inc; this.mode = 'mission'; this.arrived = false; inc.droneBy = this.id; inc.droneT = s.time;
    const eta = Math.hypot(inc.where.x - this.x, inc.where.z - this.z) / SPEED;
    if (inc.type === 'field') { this.evChecks = (this.evChecks ?? 0) + 1; if (inc.ev) inc.ev.droneBy = this.id; }
    s.orch.step(inc, 'exec', 'act', `${this.id} 우선 출동 — 사고 현장 상공으로 비행 (약 ${Math.max(1, Math.round(eta))}초)`);
    s.log('act', `${this.id} 사고 현장 우선 출동 · ${inc.title}`, { obs: `${inc.title} 발생`, dec: `드론 관제: 가장 가까운 가용 드론 (${s.drones.length}대 중)`, act: `순찰 중단 → 현장 상공 저고도 정지 비행 · 영상 중계 (도착 약 ${Math.max(1, Math.round(eta))}초)` });
  }
  near(p, r) { return Math.hypot(p.x - this.x, p.z - this.z) < r; }
  // 짐벌·하방 카메라가 보고 있는 지점
  get scanning() { return this.mode === 'patrol' && this.hover > 0 ? this.route()[this.wp % this.route().length]?.scan ?? null : null; }
}
