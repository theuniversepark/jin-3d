// 순찰 드론 (피지컬AI 단계) — 공장 상공(약 6m)을 순회하며 셀마다 멈춰 내려다보고(짐벌·하방 카메라 영상은 로봇 비전 관제 화면으로),
// 현장 이벤트·설비 고장·결품·공급 차질이 생기면 순찰을 멈추고 그 현장으로 먼저 날아가 사고 현장을 중계·관찰 보고한다. 배터리가 떨어지면 이착륙장으로 돌아가 충전한다.
// 지상 이동체 교통(차로·양보)과는 높이가 달라 서로 피하지 않는다. 렌더링과 분리되어 헤드리스에서도 같은 동작.

export const DRONE_PAD = { x: 20.5, z: 14.2 };   // 이착륙·충전 패드 (앞쪽, 정비실 오른쪽)
const ALT = 6.0, LOW = 5.4, SPEED = 3.4, CLIMB = 1.4, YAW_RATE = 1.6;
const HOVER = 4, DRAIN = 100 / (24 * 60), CHARGE = 100 / (4 * 60);   // 비행 24분 · 충전 4분

export class PatrolDrone {
  constructor(sim, i = 0) {
    this.sim = sim; this.id = `순찰 드론-${i + 1}`; this.kind = 'drone';
    this.x = DRONE_PAD.x; this.z = DRONE_PAD.z; this.y = 0.25; this.heading = Math.PI; this.battery = 100;
    this.home = { ...DRONE_PAD, aisle: 'F', name: '드론 이착륙장' };
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
    pts.push({ x: -26, z: -12.5, name: '자재창고 상공' });
    pts.push({ x: src.x, z: src.z, name: '자재 투입 상공', scan: src });
    return pts;
  }

  update(dt) {
    const s = this.sim, K = s.cmd;
    this.moving = false; this.charging = false;
    // 전체 비상정지·보호정지: 제자리 정지 비행 (착륙해 있으면 그대로)
    if (K?.estopAll || K?.pstopAll) { this.task = this.y > 0.5 ? '정지 비행 (비상정지)' : '대기 (비상정지)'; this.speedNow = 0; return; }
    if (this.y > 0.5) { this.battery = Math.max(0, this.battery - DRAIN * dt); this.flight = (this.flight ?? 0) + dt; }
    // 대피 명령·배터리 부족 → 귀환
    if ((K?.evac || this.battery < 22) && this.mode !== 'return' && this.mode !== 'charge') { this.mode = 'return'; this.mission = null; }
    if (this.mode === 'charge') {
      this.charging = true; this.task = K?.evac ? '대기 (대피)' : `충전 중 ${this.battery.toFixed(0)}%`;
      this.battery = Math.min(100, this.battery + CHARGE * dt);
      if (this.battery >= 98 && !K?.evac) { this.mode = 'patrol'; s.log('info', `${this.id} 순찰 재개`, { obs: '배터리 충전 완료' }); }
      return;
    }
    // 문제 상황 우선 출동: 인시던트(현장 이벤트 > 설비 고장 > 부품 결품 > 공급 차질)가 열리면 순찰을 멈추고 현장으로 먼저 날아가
    // 저고도 정지 비행으로 사고 현장을 중계하고 관찰 정보를 오케스트레이터에 보고한다 (sim.droneAssist). 인시던트가 닫히면 순찰 복귀
    if (this.mode !== 'return') {
      const m = this.pickMission();
      if (m && m !== this.mission && (!this.mission || this.prio(m) > this.prio(this.mission) || this.mission.status !== 'open')) {
        this.mission = m; this.mode = 'mission'; this.arrived = false;
        const eta = Math.hypot(m.where.x - this.x, m.where.z - this.z) / SPEED;
        if (m.type === 'field') { this.evChecks = (this.evChecks ?? 0) + 1; if (m.ev) m.ev.droneBy = this.id; }
        s.orch.step(m, 'exec', 'act', `${this.id} 우선 출동 — 사고 현장 상공으로 비행 (약 ${Math.max(1, Math.round(eta))}초)`);
        s.log('act', `${this.id} 사고 현장 우선 출동 · ${m.title}`, { obs: `${m.title} 발생`, act: `순찰 중단 → 현장 상공 저고도 정지 비행 · 영상 중계 (도착 약 ${Math.max(1, Math.round(eta))}초)` });
      }
      if (this.mode === 'mission' && (!this.mission || this.mission.status !== 'open' || s.time - this.mission.t0 > 600)) {
        if (this.mission?.status !== 'open' && this.arrived) s.log('ok', `${this.id} 현장 중계 종료 · 순찰 복귀`, { obs: `${this.mission.title} 해소` });
        this.mission = null; this.mode = 'patrol';
      }
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
  // 출동할 인시던트: 위치가 있는 열린 인시던트 중 우선순위가 가장 높고 먼저 난 것
  prio(inc) { return { field: 4, equipment: 3, parts: 2, supply: 1 }[inc?.type] ?? 0; }
  pickMission() {
    return this.sim.orch.incidents.filter((i) => i.status === 'open' && i.where && this.prio(i) > 0)
      .sort((a, b) => this.prio(b) - this.prio(a) || a.t0 - b.t0)[0] ?? null;
  }
  near(p, r) { return Math.hypot(p.x - this.x, p.z - this.z) < r; }
  // 짐벌·하방 카메라가 보고 있는 지점
  get scanning() { return this.mode === 'patrol' && this.hover > 0 ? this.route()[this.wp % this.route().length]?.scan ?? null : null; }
}
