// 화면 보간(js/stepinterp.js) — 그리는 동안만 값을 섞고 시뮬레이션 상태는 바꾸지 않는다
//  · x·z가 계산 속성(야드 좌표 → 월드 좌표)인 객체도 월드 위치가 두 간격 사이에 오고, 되돌린 뒤 야드 좌표가 그대로
//  · 화면 루프처럼 매 간격 capture → apply → restore를 해도 시뮬레이션 결과가 보간 없이 돌린 것과 같음 (트럭이 건물 안으로 들어가던 문제)
//  · 비율 0 경계 · 화면 루프가 0.1초 고정 간격(SIM_DT)으로만 진행 · 같은 시드 = 같은 결과 · 보조 난수 분리 · 에이전트 1초 주기
import { StepInterp } from '../js/stepinterp.js';
import { Truck, YARD } from '../js/shipping.js';
import fs from 'node:fs';
import { Simulation, SIM_DT } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { HybridAgent } from '../js/multiagent.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

console.log('== 계산 속성 좌표 (야드 좌표 lx·lz → 월드 좌표 x·z)');
{
  // micro의 트럭은 x·z를 그대로 저장하지만(야드를 돌려 놓지 않음), 좌표가 계산 속성인 객체가 들어와도 저장된 값(lx·lz)만 섞어야 한다
  class Rot { constructor(lx, lz) { this.lx = lx; this.lz = lz; } get x() { return 40 - this.lz; } set x(v) { this.lz = 40 - v; } get z() { return this.lx - 38; } set z(v) { this.lx = v + 38; } }
  const t = new Rot(0, -30), I = new StepInterp();
  I.capture([t]); const w0 = { x: t.x, z: t.z };
  t.lz += 2;   // 야드 좌표로 2m 이동
  const w1 = { x: t.x, z: t.z }, l1 = { x: t.lx, z: t.lz };
  I.apply([t], 0.5);
  const mid = { x: t.x, z: t.z };
  check('그리는 동안 월드 위치가 두 간격의 가운데', Math.abs(mid.x - (w0.x + w1.x) / 2) < 1e-9 && Math.abs(mid.z - (w0.z + w1.z) / 2) < 1e-9, `(${mid.x.toFixed(2)}, ${mid.z.toFixed(2)})`);
  I.restore();
  check('되돌린 뒤 야드 좌표·월드 좌표 그대로', t.lx === l1.x && t.lz === l1.z && t.x === w1.x && t.z === w1.z);
  const m = new Truck('화물트럭-1', 27, -30, Math.PI), J = new StepInterp();
  J.capture([m]); m.z += 1; J.apply([m], 0.25);
  check('트럭(저장된 x·z) — 그리는 동안 섞이고 되돌리면 그대로', Math.abs(m.z - (-30 + 0.25)) < 1e-9 && (J.restore(), m.z === -29));
  const far = { x: 0, z: 0, progress: 0.9 }, K = new StepInterp();
  K.capture([far]); far.x = 5; far.progress = 0.1; K.apply([far], 0.5);
  check('3m 넘게 뛴 위치 · 되돌아간 진행률(다음 사이클)은 섞지 않음', far.x === 5 && far.progress === 0.1);
}

console.log('== 화면 루프와 같은 순서로 2시간 — 보간이 시뮬레이션을 바꾸지 않음');
{
  const targets = (s) => [s.vehicles, s.forklifts, s.carriers, s.techs, s.helpers, s.quads, s.drones, s.workers, s.yard?.trucks, s.inbound?.trucks, s.stations].flatMap((a) => a ?? []);
  const run = (interp) => {
    const s = new Simulation('dark', 21, { quiet: true }), ag = new HybridAgent(s), I = new StepInterp();
    let maxTruckZ = -Infinity;
    for (let i = 0; i < 72000; i++) {
      if (interp) I.capture(targets(s));
      s.step(0.1); ag.update(0.1);
      if (interp) { I.apply(targets(s), 0.37); I.restore(); }
      for (const t of s.yard?.trucks ?? []) maxTruckZ = Math.max(maxTruckZ, t.z);
    }
    const k = s.kpi();
    return { sig: JSON.stringify([s.stats.shipped, Math.round(k.uph * 1000), Math.round(k.oee * 1e6), (s.yard?.trucks ?? []).map((t) => [t.state, +t.x.toFixed(3), +t.z.toFixed(3)]), (s.inbound?.trucks ?? []).map((t) => [t.state, +t.x.toFixed(3), +t.z.toFixed(3)])]), maxTruckZ, shipped: s.stats.shipped };
  };
  const a = run(false), b = run(true);
  check('보간을 켜도 출하량·UPH·OEE·트럭 위치가 같음', a.sig === b.sig, `출하 ${a.shipped} / ${b.shipped}`);
  check('출하 트럭 차체가 뒷벽(z −20) 밖에만 있음', b.maxTruckZ + YARD.truckLen / 2 <= YARD.wallZ + 1e-6, `가장 안쪽 중심 z ${b.maxTruckZ.toFixed(2)}`);
}

console.log('== 비율 0 경계에서 뒤로 튀지 않음');
{
  for (const speed of [1, 3, 10]) {
    const I = new StepInterp(), m = { x: 0, z: 0 };
    let acc = 0, last = -Infinity, back = 0;
    for (let f = 0; f < 600; f++) {
      acc += (1 / 60) * speed;
      const n = Math.floor(acc / 0.1 + 1e-9);
      for (let i = 0; i < n; i++) { if (i === n - 1) I.capture([m]); m.x += 0.1; }
      acc = Math.max(0, acc - n * 0.1);
      I.apply([m], acc / 0.1);
      if (m.x < last - 1e-9) back++;
      last = m.x; I.restore();
    }
    check(`60fps · ${speed}배속 600프레임 뒤로 간 프레임 0`, back === 0, `${back}회`);
  }
}

console.log('== 화면 루프(js/main.js) — 고정 간격으로만 진행');
{
  const src = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8'), loop = src.slice(src.indexOf('function frame()'), src.indexOf('// Blender 모델을 먼저 불러온 뒤'));
  check('sim.step · agent.update는 SIM_DT로만 부름', /sim\.step\(SIM_DT\); agent\.update\(SIM_DT\)/.test(loop) && !/sim\.step\((?!SIM_DT)/.test(loop), '');
  check('프레임 시간으로 나눠 진행하던 코드가 남아 있지 않음', !/Math\.min\(0\.1, left\)/.test(src));
  check('그리기 전 apply · 그린 뒤 restore', loop.indexOf('interp.apply(') > 0 && loop.indexOf('interp.apply(') < loop.indexOf('view.update(') && loop.indexOf('view.update(') < loop.indexOf('interp.restore()'));
}

console.log('== 같은 시드 = 같은 결과 (0.1초 간격 두 번 운전) · 보조 난수는 생산 흐름과 따로');
{
  const run = (poke) => {
    const s = new Simulation('dark', 7, { quiet: true }), ag = new HybridAgent(s);
    for (let i = 0; i < 18000; i++) { s.step(SIM_DT); ag.update(SIM_DT); if (poke && i % 500 === 0) { s.aios.rng(); s.sec.rng(); s.evRand(); } }
    const k = s.kpi(); return JSON.stringify([s.stats.shipped, k.good, k.failures, k.OEE, ag.decisions]);
  };
  const a = run(false), b = run(false), c = run(true);
  check('두 번 운전 결과가 같음 (30분)', a === b, a);
  check('AIOS 학습 곡선 · 보안 사건 대상 · 현장 이벤트 난수를 뽑아도 생산 결과가 같음', a === c, c);
  const s = new Simulation('smart', 3, { quiet: true }), ag = new FactoryAgent(s); let thinks = 0; const think = ag.think.bind(ag); ag.think = () => { thinks++; think(); };
  for (let i = 0; i < 1000; i++) { s.step(SIM_DT); ag.update(SIM_DT); }
  check('에이전트 판단 주기 1초 (0.1초 × 10 — 100초에 100번)', thinks === 100, `${thinks}번`);
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
