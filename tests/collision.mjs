// 이동체 충돌 회피 회귀 검증 (검수보고서 R01 · R02 · R03) — 실행: npm test
//  R01 교통 관제 우선 통행권(passT) · 교착 해소(15초 막힘)가 상대를 지나쳐 들어가지 않는다: 정지 상대 · 우선권 동시 부여 · 지게차 포크 (통행권을 받는 틱 포함)
//  R02 대상물을 싣고 라인을 달리는 운반 AMR(state 'line')도 감지 대상: 다른 이동체가 그 앞에서 서고 돌아가며, 라인 AMR도 길 위의 이동체 앞에서 선다 · 셀 진입 도중 선 AMR 뒤 간격
//  R03 드론끼리 공간 분리: 같은 위치 인시던트 3건 · P1 선점 뒤 정지 비행 자리 · 자연 운전 최소 간격 (중심거리 1.6m = 기체 폭 0.8m × 2)
//  + 장시간 운전(8시간): 생산이 멈추지 않고(10분 넘게 조용한 구간 0), 모든 이동체 쌍의 차체 상자 겹침 0 · 정면 접근으로 반지름 합 안에 든 횟수 0
import { Simulation, Mover, moverRadius, moverWidth, FORK } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { zoneLine, pointAt } from '../js/line.js';
import * as DRONE from '../js/drone.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const SEP = DRONE.DRONE_SEP?.min ?? 1.6, SLOT = DRONE.DRONE_SEP?.slot ?? 2.4;   // 드론 간격 기준 (js/drone.js DRONE_SEP)

// 시험용 이동체 두 대만 서로 감지하게 한 작은 장면 (실제 Mover · Simulation.sense)
const scene = (list) => {
  const s = new Simulation('dark', 20261001, { quiet: true, line: zoneLine() });
  s.movers = list; s.senseList = list; s.docks = [];
  for (const [i, m] of list.entries()) { m.sense = s.sense; m.replan = s.replan; m.spotTaken = s.spotTaken; m.prio = 300 - i; }
  return s;
};
const walker = (id, x, z, to) => { const m = new Mover(id, 'humanoid', { x, z }, 1); if (to) { m.steps = [{ go: to }]; m.path = [{ x: to.x, z: to.z }]; } return m; };
// sec초 동안 움직이는 쪽만 갱신하며 두 이동체 중심거리 최소값 · 도착 여부
const drive = (movers, a, b, sec) => { let min = Infinity; for (let k = 0; k < sec * 10; k++) { for (const m of movers) m.update(0.1); min = Math.min(min, dist(a, b)); } return min; };

console.log('== R01 우선 통행권 · 교착 해소가 상대를 지나치지 않음');
for (const [label, prep] of [['평소', () => {}], ['우선 통행 중(passT 4초)', (a) => { a.passT = 4; }], ['15초 넘게 막힘(blockT 16초 — 통행권 받는 틱)', (a) => { a.blockT = 16; }]]) {
  const a = walker('시험-A', 0, 0, { x: 4, z: 0 }), b = walker('시험-B', 1.6, 0); scene([a, b]); prep(a);
  const R = moverRadius(a) + moverRadius(b), min = drive([a], a, b, 40);
  check(`정지한 상대 — ${label}: 중심거리가 반지름 합(${R}m) 아래로 들지 않고 돌아서 도착`, min >= R - 1e-6 && a.idle && dist(a, { x: 4, z: 0 }) < 0.05, `최소 ${min.toFixed(2)}m · ${a.idle ? '도착' : `미도착 (${a.x.toFixed(1)}, ${a.z.toFixed(1)})`}`);
}
for (const [label, prep] of [['둘 다 우선 통행 중', (m) => { m.passT = 4; }], ['둘 다 15초 넘게 막힘', (m) => { m.blockT = 16; }]]) {
  const a = walker('시험-A', 0, 0, { x: 5, z: 0 }), b = walker('시험-B', 5, 0, { x: 0, z: 0 }); scene([a, b]); prep(a); prep(b);
  const R = moverRadius(a) + moverRadius(b), min = drive([a, b], a, b, 60);
  check(`마주 오는 두 대 — ${label}: 서로 지나치지 않고(반지름 합 ${R}m 이상) 한쪽이 비켜 둘 다 도착`, min >= R - 1e-6 && a.idle && b.idle, `최소 ${min.toFixed(2)}m · A ${a.idle ? '도착' : '미도착'} · B ${b.idle ? '도착' : '미도착'}`);
}
{ // 지게차: 포크를 이쪽으로 내밀고 선 지게차(차체·포크 선분 뒤 0.8 ~ 앞 1.45m, 반폭 0.55m) 앞에서 통행권을 받는 틱
  const segD = (f, p) => { const hx = Math.sin(f.heading), hz = Math.cos(f.heading), ax = f.x - hx * FORK.back, az = f.z - hz * FORK.back, vx = hx * (FORK.back + FORK.front), vz = hz * (FORK.back + FORK.front), t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.z - az) * vz) / (vx * vx + vz * vz))); return Math.hypot(p.x - ax - vx * t, p.z - az - vz * t); };
  const mk = () => { const a = walker('시험-A', 0.3, 0, { x: 7, z: 0 }), f = new Mover('시험 지게차', 'forklift', { x: 3, z: 0 }, 1.5); f.heading = -Math.PI / 2; scene([a, f]); return [a, f]; };
  { const [a, f] = mk(); a.blockT = 16; a.update(0.1);
    check('지게차 포크 앞 — 통행권을 받는 틱에도 감지 없이 나가지 않음', Math.abs(a.x - 0.3) < 1e-9 && Math.abs(a.z) < 1e-9, `(${a.x.toFixed(2)}, ${a.z.toFixed(2)})`);
    let min = segD(f, a); for (let k = 0; k < 600; k++) { a.update(0.1); min = Math.min(min, segD(f, a)); }
    check('지게차 포크 앞 — 차체·포크 자리(반폭 0.55m + 몸 반지름) 밖으로 돌아서 도착', min >= FORK.half + moverRadius(a) - 1e-6 && a.idle, `포크 선분까지 최소 ${min.toFixed(2)}m · ${a.idle ? '도착' : '미도착'}`); }
  { const [a, f] = mk(); a.passT = 4; let min = segD(f, a); for (let k = 0; k < 600; k++) { a.update(0.1); min = Math.min(min, segD(f, a)); }
    check('지게차 포크 앞 — 우선 통행 중에도 포크 자리에 들지 않음', min >= FORK.half + moverRadius(a) - 1e-6 && a.idle, `최소 ${min.toFixed(2)}m`); }
}

console.log('== R02 라인 운행 AMR 감지');
{ // ① 라인 위에 선 AMR(state 'line') 앞: 다른 이동체가 멈추고 돌아간다
  const a = walker('시험-A', 0, 0, { x: 5, z: 0 }), s = scene([a]); const c = s.carriers[0]; c.x = 2.2; c.z = 0; c.state = 'line'; c.heading = Math.PI / 2; s.movers.push(c); s.senseList = s.movers;
  const R = moverRadius(a) + moverRadius(c), min = drive([a], a, c, 40);
  check(`라인 AMR 앞에서 멈추고 돌아감: 중심거리 ${R}m(반지름 합) 이상`, min >= R - 1e-6 && a.idle, `최소 ${min.toFixed(2)}m · ${a.idle ? '도착' : '미도착'}`);
}
{ // ② 라인 AMR도 길 위에 선 이동체 앞에서 선다 — 비키면 이어서 간다 (실제 운전 중인 라인)
  const s = new Simulation('smart', 5, { quiet: true, line: zoneLine() });
  let c = null, e = null;
  for (let k = 0; k < 6000 && !c; k++) { s.step(0.1); for (const cv of s.conveyors) { const it = cv.items.find((x) => x.item.carrier && x.s > 0.5 && x.s < cv.len - 5 && cv.items.indexOf(x) === 0); if (it && cv.to.type !== 'sink' && cv.len > 8) { c = cv; e = it; break; } } }
  const car = e?.item.carrier, at = c && pointAt(c.path, e.s + 3.2), ob = new Mover('시험 장애물', 'humanoid', at ?? { x: 0, z: 0 }, 1);
  ob.steps = [{ wait: 999 }]; s.movers.push(ob); s.senseList.push(ob);
  let min = Infinity, s0 = e?.s ?? 0; for (let k = 0; k < 150; k++) { s.step(0.1); if (car?.state === 'line') min = Math.min(min, dist(car, ob)); }
  const held = e ? e.s : 0, R = moverRadius(ob) + (car ? moverRadius(car) : 0.8);
  check(`라인 AMR이 길 위 이동체 앞에서 정지: 중심거리 ${R}m 이상 (15초)`, !!car && min >= R - 1e-6 && held < s0 + 3.2 - R + 1e-6, `최소 ${min.toFixed(2)}m · 경로 위치 ${s0.toFixed(1)} → ${held.toFixed(1)}m (장애물 ${(s0 + 3.2).toFixed(1)}m)`);
  s.movers.splice(s.movers.indexOf(ob), 1); s.senseList.splice(s.senseList.indexOf(ob), 1);
  const on = () => c.items.includes(e); let moved = false; for (let k = 0; k < 100 && !moved; k++) { s.step(0.1); moved = !on() || e.s > held + 1; }
  check('이동체가 비키면 라인 AMR이 이어서 감', moved, on() ? `경로 위치 ${e.s.toFixed(1)}m` : '다음 셀로 진입');
}
{ // ③ 셀 진입 도중 셀이 서면(고장) 그 AMR은 진입로 위에 선다 — 뒤 AMR이 대기 지점까지 붙지 않는다
  const s = new Simulation('smart', 5, { quiet: true, line: zoneLine() }), ag = new FactoryAgent(s);
  let st = null; for (let k = 0; k < 72000 && !st; k++) { s.step(0.1); ag.update(0.1);
    st = s.processing.find((x) => x.ins.length === 1 && x.item?.carrier && x.state === 'BUSY' && s.entryK(x) > 0.1 && s.entryK(x) < 0.35 && x.ins[0].items[0]?.item.carrier && x.ins[0].len - x.ins[0].items[0].s < 2.4) ?? null; }
  if (st) { const lead = st.item.carrier, next = st.ins[0].items[0].item.carrier; s.fail(st); let min = Infinity; for (let k = 0; k < 150; k++) { s.step(0.1); if (st.item?.carrier === lead && st.ins[0].items[0]?.item.carrier === next) min = Math.min(min, dist(lead, next)); }
    check('셀 진입 도중 선 AMR 뒤: 다음 AMR이 반지름 합(1.6m) 이상 떨어져 기다림', min >= 1.6 - 1e-6 && min < Infinity, `${st.name} · 최소 ${min.toFixed(2)}m`); }
  else check('셀 진입 도중 선 AMR 뒤: 다음 AMR이 반지름 합(1.6m) 이상 떨어져 기다림', false, '시험 상황(진입 중 + 바로 뒤 AMR)을 찾지 못함');
}

console.log('== R03 드론 공간 분리');
const gap3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fly = (s, sec, each) => { let min = Infinity; for (let k = 0; k < sec * 10; k++) { s.time += 0.1; for (const d of s.drones) d.update(0.1); for (let i = 0; i < s.drones.length; i++) for (let j = i + 1; j < s.drones.length; j++) min = Math.min(min, gap3(s.drones[i], s.drones[j])); each?.(); } return min; };
{ const s = new Simulation('dark', 20261001, { quiet: true, line: zoneLine() });
  for (const [i, d] of s.drones.entries()) d.assign(s.orch.open('parts', 'audit:' + i, '같은 위치 시험', 'audit', { where: { x: 0, z: 0 } }));
  const min = fly(s, 40), D = s.drones, hov = Math.min(gap3(D[0], D[1]), gap3(D[0], D[2]), gap3(D[1], D[2]));
  check(`같은 위치(0, 0)의 인시던트 3건: 세 드론 중심거리 ${SEP}m 이상 유지`, min >= SEP - 1e-6, `최소 ${min.toFixed(3)}m`);
  check(`세 드론 모두 현장 도착 · 정지 비행 자리 ${SLOT}m씩 분산 · 현장 4.8m 안`, D.every((d) => d.arrived && Math.hypot(d.x, d.z) < 2 * SLOT + 0.2) && hov >= SLOT - 0.35, `자리 사이 최소 ${hov.toFixed(2)}m · ${D.map((d) => `(${d.x.toFixed(1)}, ${d.z.toFixed(1)})`).join(' ')}`);
  // P1 선점: 같은 위치에 화재 의심(P1)이 열리면 낮은 우선순위 출동 드론을 돌린다 — 돌린 뒤에도 겹치지 않는다
  const p1 = s.orch.open('field', 'audit:p1', 'P1 같은 위치 시험', 'audit', { where: { x: 0, z: 0 }, prio: 1 }); s.dispatchDrones();
  const taken = D.find((d) => d.mission === p1), min2 = fly(s, 30), hov2 = Math.min(gap3(D[0], D[1]), gap3(D[0], D[2]), gap3(D[1], D[2]));
  check(`같은 위치 P1 선점 뒤: 중심거리 ${SEP}m 이상 · 돌린 드론도 떨어진 자리에서 정지 비행`, !!taken && taken.arrived && min2 >= SEP - 1e-6 && hov2 >= SEP - 1e-6, `${taken?.id ?? '선점 없음'} · 최소 ${min2.toFixed(3)}m · 정지 비행 중 ${hov2.toFixed(2)}m`);
}
{ // 귀환(대피): 세 대가 나란한 패드(1.7m 간격)로 함께 돌아와 내려앉는다
  const s = new Simulation('dark', 3, { quiet: true, line: zoneLine() }); for (let k = 0; k < 1200; k++) s.step(0.1);
  s.cmd.evac = true; let min = Infinity; for (let k = 0; k < 900; k++) { s.step(0.1); for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) min = Math.min(min, gap3(s.drones[i], s.drones[j])); }
  check(`대피 귀환: 세 드론이 간격 ${SEP}m 이상을 지키며 각자 패드에 착륙`, min >= SEP - 1e-6 && s.drones.every((d) => d.mode === 'charge' && dist(d, d.home) < 0.1), `최소 ${min.toFixed(3)}m · ${s.drones.map((d) => d.mode).join('/')}`);
}

console.log('== 장시간 운전: 생산 지속 · 이동체 쌍 최소 간격');
// 차체 상자(반길이 × 반폭 — 운반 AMR 0.74 × 0.475m 실제 차체, 지게차는 뒤 0.8 ~ 포크 앞 1.45m · 반폭 0.55m, 그 밖은 판정 반지름 × 폭/2) 겹침
const box = (m) => { const hx = Math.sin(m.heading), hz = Math.cos(m.heading);
  if (m.kind === 'forklift') { const c = (FORK.front - FORK.back) / 2; return { x: m.x + hx * c, z: m.z + hz * c, hx, hz, L: (FORK.front + FORK.back) / 2, W: FORK.half }; }
  return { x: m.x, z: m.z, hx, hz, L: m.kind === 'carrier' ? 0.74 : moverRadius(m), W: moverWidth(m) / 2 }; };
const overlap = (a, b) => { const A = box(a), B = box(b), dx = B.x - A.x, dz = B.z - A.z;
  for (const [ux, uz] of [[A.hx, A.hz], [-A.hz, A.hx], [B.hx, B.hz], [-B.hz, B.hx]]) { const ra = A.L * Math.abs(A.hx * ux + A.hz * uz) + A.W * Math.abs(-A.hz * ux + A.hx * uz), rb = B.L * Math.abs(B.hx * ux + B.hz * uz) + B.W * Math.abs(-B.hz * ux + B.hx * uz); if (Math.abs(dx * ux + dz * uz) > ra + rb) return false; }
  return true; };
// 현장 이벤트 주입(10분마다 · 통로 · 라인 경로 · 셀 옆): 드론 출동 · 휴머노이드 대응 · 사족보행 추적 · 진로 우회가 겹치는 상황
const inject = (s, seed, n) => { const rnd = (i) => { const x = Math.sin((seed + n * 7 + i) * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const spots = [() => ({ x: -30 + rnd(1) * 60, z: rnd(2) < 0.5 ? 8.3 : 9.7 }), () => ({ x: -30 + rnd(1) * 60, z: rnd(2) < 0.5 ? -8.3 : -9.7 }), () => { const c = s.conveyors[Math.floor(rnd(3) * s.conveyors.length)], q = c.path[0], e = c.path[c.path.length - 1]; return { x: (q.x + e.x) / 2, z: (q.z + e.z) / 2 }; }, () => { const st = s.processing[Math.floor(rnd(4) * s.processing.length)]; return { x: st.x + 2, z: st.z + 3 }; }];
  const p = spots[n % 4](); s.injectFieldEvent(['leak', 'debris', 'smoke', 'intrusion'][n % 4], p.x, p.z); };
const longRun = (mode, seed, line, hours, events) => {
  const s = new Simulation(mode, seed, { quiet: true, ...(line ? { line } : {}) }), ag = new FactoryAgent(s);
  const R = { good: 0, stalls: 0, body: 0, bodyEx: '', frontal: 0, frontalEx: '', lane: Infinity, side: Infinity, drone: Infinity, events: 0, open: 0, passes: 0 };
  const prev = new Map(), prevD = new Map(); let last = 0, tLast = 0, quiet = false;
  for (let k = 0; k < hours * 36000; k++) {
    if (events && k % 6000 === 3000) { inject(s, seed, k / 6000 | 0); R.events++; }
    s.step(0.1); ag.update(0.1);
    if (s.stats.good !== last) { last = s.stats.good; tLast = s.time; quiet = false; } else if (s.time - tLast > 600 && !quiet) { quiet = true; R.stalls++; }
    const M = s.movers;
    for (let i = 0; i < M.length; i++) for (let j = i + 1; j < M.length; j++) {
      const a = M[i], b = M[j], dx = a.x - b.x, dz = a.z - b.z; if (Math.abs(dx) > 3.2 || Math.abs(dz) > 3.2) continue;
      const d = Math.hypot(dx, dz), key = i * 1000 + j, pd = prevD.get(key); prevD.set(key, d);
      if (overlap(a, b)) { R.body++; R.bodyEx ||= `t=${s.time.toFixed(1)} ${a.id}(${a.x.toFixed(1)}, ${a.z.toFixed(1)}) ↔ ${b.id}(${b.x.toFixed(1)}, ${b.z.toFixed(1)}) ${d.toFixed(2)}m`; }
      if (d >= moverRadius(a) + moverRadius(b)) continue;
      if (a.state === 'line' && b.state === 'line') { R.lane = Math.min(R.lane, d); continue; }   // 합류 대기 차로(0.75m씩 비킨 두 줄 · 차로 간격 1.5m)에 나란히 — 차체 상자 겹침으로 본다
      // 정면 접근: 이번 틱에 움직인 쪽의 진행 방향 차폭 안(옆 < 폭 합/2)에 상대 중심이 있고 거리가 줄었다 — 그 밖은 옆으로 지나가기 · 나란히 서기(차로 1.4m · 대기 자리 1.4m · 작업 자리)
      let frontal = false;
      for (const [m, o] of [[a, b], [b, a]]) { const pp = prev.get(m); if (!pp) continue; const mx = m.x - pp.x, mz = m.z - pp.z, L = Math.hypot(mx, mz); if (L < 1e-4) continue;
        const rx = o.x - m.x, rz = o.z - m.z; if ((rx * mx + rz * mz) / L > 0.15 && Math.abs(rx * mz - rz * mx) / L < (moverWidth(m) + moverWidth(o)) / 2 && pd != null && d < pd - 1e-9) frontal = true; }
      if (frontal) { R.frontal++; R.frontalEx ||= `t=${s.time.toFixed(1)} ${a.id} ↔ ${b.id} ${d.toFixed(2)}m (반지름 합 ${(moverRadius(a) + moverRadius(b)).toFixed(2)}m)`; } else R.side = Math.min(R.side, d);
    }
    for (const m of M) { const pp = prev.get(m); if (pp) { pp.x = m.x; pp.z = m.z; } else prev.set(m, { x: m.x, z: m.z }); }
    const D = s.drones; for (let i = 0; i < D.length; i++) for (let j = i + 1; j < D.length; j++) if (D[i].y > 0.5 || D[j].y > 0.5) R.drone = Math.min(R.drone, gap3(D[i], D[j]));
  }
  R.good = s.stats.good; R.open = (s.fieldEvents ?? []).filter((e) => !e.cleared).length; R.passes = s.movers.reduce((n, m) => n + (m.passes ?? 0), 0);
  return R;
};
// 기준(고치기 전 같은 조건 8시간 양품): 피지컬AI 혼류 · 이벤트 516 / 자동화 혼류 524 / 피지컬AI 기본 라인 · 이벤트 4시간 1,631 — 3% 넘게 줄지 않아야 한다
for (const [label, mode, seed, line, hours, events, base] of [['피지컬AI 정밀조립 혼류 · 현장 이벤트 48건', 'dark', 12345, zoneLine(), 8, true, 516], ['자동화 정밀조립 혼류', 'smart', 3, zoneLine(), 8, false, 524], ['피지컬AI 기본 라인 · 현장 이벤트 24건', 'dark', 12345, null, 4, true, 1631]]) {
  const r = longRun(mode, seed, line, hours, events);
  check(`${label} ${hours}시간: 생산이 멈추지 않음 (10분 넘게 조용한 구간 0 · 양품 기준의 97% 이상)`, r.stalls === 0 && r.good >= base * 0.97, `양품 ${r.good}개 (기준 ${base}) · 멈춤 ${r.stalls}회 · 우선 통행권 ${r.passes}회${events ? ` · 이벤트 ${r.events}건 중 미해결 ${r.open}건` : ''}`);
  if (events) check(`${label}: 현장 이벤트가 모두 해결됨 (대응 로봇이 길에 갇히지 않음)`, r.open <= 1, `미해결 ${r.open}건`);
  check(`${label}: 지상 이동체 쌍 차체 상자 겹침 0`, r.body === 0, r.body ? `${r.body}틱 · 예 ${r.bodyEx}` : `옆으로 지나가기 · 나란히 서기 최소 중심거리 ${r.side === Infinity ? '-' : r.side.toFixed(2) + 'm'}${r.lane < Infinity ? ` · 합류 차로 ${r.lane.toFixed(2)}m` : ''}`);
  check(`${label}: 정면 접근으로 반지름 합 안에 든 횟수 0`, r.frontal === 0, r.frontal ? `${r.frontal}틱 · 예 ${r.frontalEx}` : '');
  if (mode === 'dark') check(`${label}: 드론끼리 중심거리 ${SEP}m 이상`, r.drone >= SEP - 1e-6, `최소 ${r.drone.toFixed(3)}m`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
