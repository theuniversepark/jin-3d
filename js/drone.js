// 순찰 드론 (피지컬AI 단계) — 공장 상공(약 6m)을 순회하며 셀마다 멈춰 내려다보고(짐벌·하방 카메라 영상은 로봇 비전 관제 화면으로),
// 현장 이벤트가 감지되면 그 위로 날아가 상공 확인 영상을 보낸다. 배터리가 떨어지면 이착륙장으로 돌아가 충전한다.
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
    this.target = null; this.targetEv = null; this.speedNow = 0; this.vy = 0;
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
    if (this.y > 0.5) this.battery = Math.max(0, this.battery - DRAIN * dt);
    // 대피 명령·배터리 부족 → 귀환
    if ((K?.evac || this.battery < 22) && this.mode !== 'return' && this.mode !== 'charge') { this.mode = 'return'; this.targetEv = null; }
    if (this.mode === 'charge') {
      this.charging = true; this.task = K?.evac ? '대기 (대피)' : `충전 중 ${this.battery.toFixed(0)}%`;
      this.battery = Math.min(100, this.battery + CHARGE * dt);
      if (this.battery >= 98 && !K?.evac) { this.mode = 'patrol'; s.log('info', `${this.id} 순찰 재개`, { obs: '배터리 충전 완료' }); }
      return;
    }
    // 현장 이벤트: 감지된 이벤트 위로 날아가 상공 확인 (해소될 때까지)
    if (this.mode !== 'return') {
      const ev = (s.fieldEvents ?? []).find((e) => e.detected && !e.cleared);
      if (ev && this.targetEv !== ev) {
        this.targetEv = ev; this.mode = 'event';
        s.orch.step(ev.inc, 'exec', 'act', `${this.id} 상공 확인 비행 — 실시간 영상 관제 송출`);
        s.log('info', `${this.id} 현장 이벤트 상공 확인`, { obs: `${ev.label} · x ${ev.x.toFixed(1)}, z ${ev.z.toFixed(1)}`, act: '하방 카메라 영상 관제 화면 송출' });
      }
      if (this.mode === 'event' && (!this.targetEv || this.targetEv.cleared)) { this.targetEv = null; this.mode = 'patrol'; }
    }
    let goal, alt = ALT, label;
    if (this.mode === 'return') { goal = this.home; alt = this.near(goal, 0.3) ? 0.25 : ALT; label = K?.evac ? '귀환 (대피)' : `귀환 · 배터리 ${this.battery.toFixed(0)}%`; }
    else if (this.mode === 'event') { goal = { x: this.targetEv.x, z: this.targetEv.z }; alt = LOW; label = `현장 이벤트 상공 확인 · ${this.targetEv.label}`; }
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
          if (this.hover >= HOVER) { this.hover = 0; this.wp++; }
        } else if (this.mode === 'event') { this.heading += 0.35 * dt; }
        else if (this.mode === 'return' && this.y <= 0.3) { this.mode = 'charge'; s.log('info', `${this.id} 착륙`, { obs: K?.evac ? '대피 명령' : `배터리 ${this.battery.toFixed(0)}%`, act: K?.evac ? '이착륙장 대기' : '무선 충전 시작' }); }
      }
    }
    this.task = label;
  }
  near(p, r) { return Math.hypot(p.x - this.x, p.z - this.z) < r; }
  // 짐벌·하방 카메라가 보고 있는 지점
  get scanning() { return this.mode === 'patrol' && this.hover > 0 ? this.route()[this.wp % this.route().length]?.scan ?? null : null; }
}
