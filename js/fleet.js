// AMR·AGV 관제 — 운반 AMR(대상물 운반·복귀)과 자재 공급 AGV의 공통 설정·상태, 상황별 속도 변화, 전체 속도 배율(50~150%)·
// 전체 정지/시작(AGV는 1초 간격 순차 재출발), 설정 변경 효과의 디지털트윈 예측(현재 설정 vs 기준 설정). 렌더링과 분리되어 헤드리스에서도 같은 동작.
import { ZONE_AMR } from './line.js';

export const FLEET_RANGE = { min: 0.5, max: 1.5, step: 0.1 };
export const FLEET_NAMES = { amr: '운반 AMR', agv: '자재 공급 AGV' };
// 사람·휴머노이드와 같은 공간을 다니는 무인 운반차의 권장 상한 (참고: ISO 3691-4 — 사람 감지 구역은 감속, 일반 운용 1.5~2.0 m/s)
export const SHARED_SPACE_LIMIT = 2.0;

export class FleetControl {
  constructor(sim) {
    this.sim = sim;
    this.amr = { scale: 1, paused: false };
    this.agv = { scale: 1, paused: false };
    this.events = [];   // 관제 조작 이력
    this.spd = new Map();   // 이동체 → 실제 속도(m/s, 지수 평활)
    this.last = new Map();
    sim.fleet = this;
  }
  get hasAMR() { return !!this.sim.useAMR && this.sim.carriers.length > 0; }
  get hasAGV() { return this.sim.mode.vehicleKind === 'agv' && this.sim.vehicles.length > 0; }
  list(f) { return f === 'amr' ? this.sim.carriers : f === 'agv' && this.hasAGV ? this.sim.vehicles : []; }
  base(f) { return f === 'amr' ? { line: ZONE_AMR.lineSpeed, drive: ZONE_AMR.returnSpeed } : { drive: this.sim.mode.vehicleSpeed }; }
  speeds(f) { const b = this.base(f), k = this[f].scale; return { line: b.line != null ? b.line * k : null, drive: b.drive * k }; }
  // 배율을 이동체·라인(셀 사이 운반 경로)에 반영
  apply() {
    const s = this.sim;
    if (this.hasAMR) {
      const v = this.speeds('amr');
      for (const c of s.conveyors) c.speed = v.line;
      for (const c of s.carriers) c.speed = v.drive;
      s.entryTime = 2 / v.line;
    }
    if (this.hasAGV) { const v = this.speeds('agv'); for (const m of s.vehicles) m.speed = v.drive; }
  }
  note(text, by) { this.events.unshift({ t: this.sim.time, text, by }); if (this.events.length > 30) this.events.pop(); this.sim.log('act', `🚚 AMR·AGV 관제 · ${text}`, { dec: by ?? '관제 운영자', act: text }); }
  setScale(f, k, by) {
    const fl = f === 'all' ? ['amr', 'agv'] : [f];
    k = Math.round(Math.max(FLEET_RANGE.min, Math.min(FLEET_RANGE.max, k)) * 10) / 10;
    for (const x of fl) this[x].scale = k;
    this.apply();
    this.note(`${f === 'all' ? 'AMR·AGV 전체' : FLEET_NAMES[f]} 속도 ${Math.round(k * 100)}% (${fl.map((x) => `${FLEET_NAMES[x]} ${this.speeds(x).drive.toFixed(2)} m/s`).join(' · ')})`, by);
  }
  pause(f, by) {
    for (const x of f === 'all' ? ['amr', 'agv'] : [f]) this[x].paused = true;
    this.note(`${f === 'all' ? 'AMR·AGV 전체' : FLEET_NAMES[f]} 정지`, by);
  }
  // 시작: AGV는 1초 간격으로 차례로 출발시켜 충전소·통로 동시 출발 혼잡을 줄인다 (AMR은 라인 간격 2m를 지키며 함께 재개)
  resume(f, by) {
    const s = this.sim;
    for (const x of f === 'all' ? ['amr', 'agv'] : [f]) {
      if (!this[x].paused) continue;
      this[x].paused = false;
      if (x === 'agv') s.vehicles.forEach((v, i) => { v.holdUntil = s.time + i * 1.0; });
    }
    this.note(`${f === 'all' ? 'AMR·AGV 전체' : FLEET_NAMES[f]} 시작${f !== 'amr' && this.hasAGV ? ' (AGV 1초 간격 순차 출발)' : ''}`, by);
  }
  agvHeld(v) { return this.agv.paused || (v.holdUntil != null && v.holdUntil > this.sim.time); }
  // 실제 속도 측정 (누적 주행 거리 변화 / 시간)
  sample(dt) {
    if (dt <= 0) return;
    for (const m of [...this.sim.carriers, ...(this.hasAGV ? this.sim.vehicles : [])]) {
      const p = this.last.get(m) ?? m.dist, v = (m.dist - p) / dt;
      this.spd.set(m, (this.spd.get(m) ?? 0) * 0.7 + v * 0.3); this.last.set(m, m.dist);
    }
  }
  speedOf(m) { return this.spd.get(m) ?? 0; }
  // 이동체 상태 분류 — 주행 · 대기(양보·간격·진입) · 현장 이벤트 정지 · 작업/정차 · 충전 · 관제 정지 · 명령 정지
  stateOf(m, f) {
    const s = this.sim, K = s.cmd;
    if (K.estopAll || K.pstopAll) return ['명령 정지', 'bad'];
    if (f === 'amr' ? this.amr.paused : this.agvHeld(m)) return [this[f].paused ? '관제 정지' : '순차 출발 대기', 'warn'];
    if (m.charging) return ['충전', 'act'];
    if (m.hzWait) return ['현장 이벤트 정지', 'bad'];
    if (m.state === 'line') { const L = m.lineInfo, w = L?.where === 'path' && /대기/.test(L.phase ?? '') && this.speedOf(m) < 0.15; return [L?.where === 'cell' ? '셀 안 정차·작업' : w ? (/입구/.test(L.phase) ? '셀 입구 대기' : '앞차 간격 대기') : '셀 사이 운반', w ? 'warn' : 'ok']; }
    if (m.blockedOn) return ['양보·교차 대기', 'warn'];
    if (this.speedOf(m) > 0.15) return ['주행', 'ok'];
    return [m.task && m.task !== '대기' ? '정차·대기' : '대기', 'idle'];
  }
  // 상황별 속도 변화 규칙과 지금 해당하는 대수
  rules() {
    const s = this.sim, K = s.cmd, all = [...s.carriers, ...(this.hasAGV ? s.vehicles : [])];
    const cnt = (fn) => all.filter(fn).length;
    const lineWait = s.carriers.filter((c) => c.state === 'line' && c.lineInfo?.where === 'path' && /대기/.test(c.lineInfo.phase ?? '') && this.speedOf(c) < 0.15).length;
    return [
      { k: '관제 속도 배율', eff: `AMR ${Math.round(this.amr.scale * 100)}% · AGV ${Math.round(this.agv.scale * 100)}%`, on: this.amr.scale !== 1 || this.agv.scale !== 1, n: null, src: 'AMR·AGV 관제 (이 창)' },
      { k: '관제 정지', eff: '0 m/s (해당 차종만)', on: this.amr.paused || this.agv.paused, n: (this.amr.paused ? s.carriers.length : 0) + (this.agv.paused ? s.vehicles.length : 0), src: 'AMR·AGV 관제' },
      { k: '비상정지 · 보호정지', eff: '0 m/s (모든 이동 로봇·라인)', on: K.estopAll || K.pstopAll, n: K.estopAll || K.pstopAll ? all.length : 0, src: '명령 센터 (긴급 명령)' },
      { k: '안전 감속', eff: '25% (AMR 운반 0.4 m/s)', on: K.lineSafe, n: K.lineSafe ? all.length : 0, src: '명령 센터 · 현장 이벤트(연기·무단 진입)' },
      { k: '속도 오버라이드', eff: `${Math.round(K.overrideAll * 100)}% (시간 비율 — 이동·작업 모두)`, on: K.overrideAll !== 1, n: null, src: '명령 센터 (제어 명령)' },
      { k: '진로 위 현장 이벤트', eff: '반경 앞 정지 대기 또는 우회', on: cnt((m) => m.hzWait) > 0, n: cnt((m) => m.hzWait), src: '현장 감지 → 오케스트레이터' },
      { k: '앞차 간격 유지 (AMR 2.0m)', eff: '간격이 좁으면 정지', on: lineWait > 0, n: lineWait, src: '라인 운반 규칙' },
      { k: '마주침 · 교차 양보', eff: '우선순위 낮은 쪽 비켜서기·물러나기 (AMR > AGV > 정비 > 작업자 > 사족)', on: cnt((m) => m.blockedOn) > 0, n: cnt((m) => m.blockedOn), src: '교통 규칙 (차로·양보)' },
      { k: '셀 진입 · 투입 진입 대기', eff: '게이트·셀이 빌 때까지 대기 (진입로 한 줄)', on: cnt((m) => m.atGate || /대기열|진입/.test(m.task ?? '')) > 0, n: cnt((m) => m.atGate || /대기열|진입/.test(m.task ?? '')), src: '투입 스테이션 진입 규칙' },
      { k: '충전', eff: 'AGV 기준 이하 → 충전 패드 복귀 · AMR 정차 중 기회 충전', on: cnt((m) => m.charging) > 0, n: cnt((m) => m.charging), src: '배터리 규칙' },
    ];
  }
  summary(f) {
    const L = this.list(f), mv = L.filter((m) => this.speedOf(m) > 0.15);
    return { n: L.length, moving: mv.length, avg: mv.length ? mv.reduce((a, m) => a + this.speedOf(m), 0) / mv.length : 0, max: Math.max(0, ...L.map((m) => this.speedOf(m))), blocked: L.filter((m) => m.blockedOn || m.hzWait).length, battery: L.length ? L.reduce((a, m) => a + (m.battery ?? 100), 0) / L.length : 100 };
  }
}

// 설정 변경의 예상 문제점·기대효과 (규칙 기반) — 배율·정지 상태에 따라
export function fleetAdvice(F) {
  const out = [], sp = (f) => F.speeds(f);
  for (const f of ['amr', 'agv']) {
    if (f === 'amr' ? !F.hasAMR : !F.hasAGV) continue;
    const k = F[f].scale, v = sp(f), nm = FLEET_NAMES[f];
    if (F[f].paused) {
      out.push({ f, kind: 'risk', text: f === 'amr' ? `${nm} 정지 — 셀 사이 운반이 멈춰 다음 셀이 자재대기, 앞 셀은 배출대기로 막혀 UPH가 바로 떨어지고 재공(WIP)이 셀 안에 쌓입니다. 길게 세울 때는 투입 정지를 함께 거는 것이 좋습니다.` : `${nm} 정지 — 창고 → 투입구 자재 공급과 부품 보충이 멈춰, 투입 버퍼가 비는 시점부터 라인 전체가 결품 정지합니다.` });
      out.push({ f, kind: 'tip', text: `다시 시작할 때 ${f === 'agv' ? 'AGV는 1초 간격으로 순차 출발해' : 'AMR은 라인 간격 2m를 지키며'} 통로·진입로 동시 혼잡을 줄입니다.` });
      continue;
    }
    if (k > 1.001) {
      out.push({ f, kind: 'gain', text: `${nm} ${Math.round(k * 100)}% — 이동 시간이 약 ${Math.round((1 - 1 / k) * 100)}% 줄어, 운반·공급이 병목일 때 셀 자재대기가 줄고 UPH가 오를 수 있습니다 (병목이 셀 사이클이면 효과 작음).` });
      out.push({ f, kind: 'risk', text: `제동 거리는 속도 제곱에 비례해 약 ${Math.round((k * k - 1) * 100)}% 늘어 교차로·진입로에서 근접·양보 정지가 잦아질 수 있고, 배터리 소모·타이어 마모가 늘어납니다.` });
      if (v.drive > SHARED_SPACE_LIMIT) out.push({ f, kind: 'risk', text: `주행 ${v.drive.toFixed(2)} m/s는 사람·휴머노이드와 같은 공간의 권장 상한(약 ${SHARED_SPACE_LIMIT} m/s, ISO 3691-4 감속 구역 기준 참고)을 넘습니다 — 사람 감지 구역 자동 감속을 함께 두어야 합니다.` });
    } else if (k < 0.999) {
      out.push({ f, kind: 'gain', text: `${nm} ${Math.round(k * 100)}% — 근접·양보 정지와 제동 거리가 줄어 안전 여유가 커지고 배터리·에너지 소모가 줄어듭니다.` });
      out.push({ f, kind: 'risk', text: `이동 시간이 약 ${Math.round((1 / k - 1) * 100)}% 늘어 ${f === 'amr' ? '셀 사이 운반이 병목이 되면 자재대기·배출대기가 늘고' : '투입구 원자재 공급이 늦어지면 결품 정지가 생기고'} UPH가 떨어질 수 있습니다.` });
    }
  }
  if (!out.length) out.push({ f: null, kind: 'tip', text: '기준 설정(100%)으로 운용 중입니다. 배율을 바꾸면 예상 문제점·기대효과와 디지털트윈 예측을 볼 수 있습니다.' });
  return out;
}

// 디지털트윈 예측: 같은 라인·단계·시드로 기준 설정(100%, 운행)과 현재 관제 설정을 각각 돌려 비교 (헤드리스)
export function predictFleet({ Simulation, Agent, mode, line, seed = 7, T = 900, amr, agv }) {
  const run = (cfg) => {
    const s = new Simulation(mode, seed, { line, quiet: true }), ag = new Agent(s), F = s.fleet;
    F.amr.scale = cfg.amr.scale; F.agv.scale = cfg.agv.scale; F.amr.paused = cfg.amr.paused; F.agv.paused = cfg.agv.paused; F.apply();
    const movers = [...s.carriers, ...(F.hasAGV ? s.vehicles : [])];
    let near = 0, blockT = 0;
    for (let t = 0; t < T; t += 0.1) {
      s.step(0.1); ag.update(0.1);
      if (Math.round(t * 10) % 5 === 0) for (let i = 0; i < movers.length; i++) for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i], b = movers[j]; if (a.state === 'line' && b.state === 'line') continue;
        if (Math.hypot(a.x - b.x, a.z - b.z) < 1.9 && (F.speedOf(a) > 0.3 || F.speedOf(b) > 0.3)) near++;
      }
      for (const m of movers) if (m.blockedOn || m.hzWait) blockT += 0.1;
    }
    const k = s.kpi(), agvs = F.hasAGV ? s.vehicles : [];
    return { uph: k.uph, oee: k.OEE, wip: k.avgWip, kwh: k.kwhPerUnit, near, blockT, agvBattery: agvs.length ? agvs.reduce((a, v) => a + v.battery, 0) / agvs.length : null, starve: s.processing.reduce((a, st) => a + (st.c.starved ?? 0), 0) };
  };
  return { T, base: run({ amr: { scale: 1, paused: false }, agv: { scale: 1, paused: false } }), cur: run({ amr, agv }) };
}
