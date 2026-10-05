// 5G 지연 10ms 검증 — 기지국당 로봇 임계 대수(p99 ≤ 10ms) 계산, 일반 운전 지연, 임계를 넘을 때 부하 분산(이웃 기지국으로 핸드오버)·
// 접속 수락 제어·혼잡 셀로의 핸드오버 거절, DAPS 핸드오버(끊김 0ms). 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { LAT, UE_LOAD, maxRobots, cellLatency, specEff, ulSinr, NR } from '../js/net5g.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, T, each) => { for (let t = 0; t < T; t += 0.1) { s.step(0.1); ag.update(0.1); each?.(); } };
console.log('== 5G 지연 10ms · 기지국당 임계 대수');
check('고정 지연 = TDD 정렬 1 + 슬롯 0.5 + gNB 처리 1 + HARQ 1회 2.5 + 전달망 0.6 + UPF 0.3 = 5.9ms', Math.abs(LAT.fixedMs - 5.9) < 1e-9);
const tbl = Object.keys(UE_LOAD).map((k) => `${k} ${maxRobots(k)}`).join(' · ');
check('임계 대수 (설계 RSRP −80dBm): 그랜트 경쟁 한도 30대 · 휴머노이드·AMMR(영상 8.5Mbps) 24대', maxRobots('carrier') === 30 && maxRobots('humanoid') === 24 && maxRobots('ammr') === 24, tbl);
check('신호가 약하면 임계가 줄어듦 (휴머노이드 −110dBm 13대)', maxRobots('humanoid', -110) === 13 && maxRobots('humanoid', -110) < maxRobots('humanoid', -80));
const se = specEff(ulSinr(-80)), at = (n) => cellLatency(Array.from({ length: n }, () => ({ mbps: 8.5 + 0.0256, se }))).p99;
check('임계 대수에서 10ms 이하 · 한 대 더하면 초과', at(24) <= 10 && at(25) > 10, `24대 ${at(24).toFixed(2)}ms · 25대 ${at(25).toFixed(2)}ms`);
check('DAPS 핸드오버 (끊김 0ms)', NR.daps === true);

console.log('== 일반 운전 (피지컬AI 1시간)');
{ const s = new Simulation('dark', 3, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s); run(s, ag, 3600);
  const Q = s.net.summary();
  check('모든 로봇 지연 p99 ≤ 10ms (10ms 초과 0회)', Q.latViol === 0 && Q.maxLat <= 10, `측정 ${Q.latSamples}회 · 최대 ${Q.maxLat.toFixed(2)}ms · 최악 셀 ${Q.worstCellP99.toFixed(2)}ms`);
  check('핸드오버 중에도 버퍼 없이 전달 (DAPS, 유실 0)', Q.lost === 0 && Q.fwd === 0 && Q.inflight === 0, `핸드오버 ${Q.ho}회`); }

console.log('== 임계 초과: 휴머노이드 30대가 한 기지국 아래에서 영상을 한꺼번에 켬');
const surge = (lb) => {
  const s = new Simulation('dark', 3, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), N = s.net; N.lbOn = lb;
  run(s, ag, 60);
  const c0 = N.plan.cells[0], ms = [];
  for (let i = 0; i < 30; i++) { const m = { x: c0.x - 2 + (i % 6) * 0.8, z: c0.z - 2 + Math.floor(i / 6) * 0.8, moving: false }; ms.push(m); N.addUE(`추가-${i}`, `HX-${i}`, 'humanoid', () => ({ x: m.x, y: 1.5, z: m.z, m })); }
  run(s, ag, 5);   // 쉬는 중(영상 10%) — 같은 기지국에 접속
  const before = N.cellLoad(0).n, v0 = N.stats.latViol, h0 = N.stats.lbHo;
  for (const m of ms) m.moving = true;   // 영상 한꺼번에 켬 (8.5Mbps × 30)
  run(s, ag, 60);
  return { N, before, viol: N.stats.latViol - v0, lbHo: N.stats.lbHo - h0, Q: N.summary(), cells: N.cellLat };
};
const off = surge(false), on = surge(true);
check('부하 분산 없으면 10ms 초과', off.viol > 0 && off.Q.maxLat > 10, `초과 ${off.viol}회 · 최대 ${Number.isFinite(off.Q.maxLat) ? off.Q.maxLat.toFixed(1) + 'ms' : '포화'} · 셀1 ${off.cells[0].n}대`);
check('부하 분산: 이웃 기지국으로 핸드오버해 10ms 초과 0회', on.viol === 0 && on.Q.maxLat <= 10 && on.lbHo > 0, `셀1 ${on.before}대 → ${on.cells[0].n}대 · 부하 분산 핸드오버 ${on.lbHo}회 · 최대 ${on.Q.maxLat.toFixed(2)}ms`);
check('모든 셀 p99 ≤ 목표 9ms · 대수 ≤ 임계 30대', on.cells.every((l) => l.p99 <= 9 + 1e-9 && l.n <= 30), on.cells.map((l, i) => (l.n ? `${i + 1}:${l.n}대 ${l.p99.toFixed(1)}` : '')).filter(Boolean).join(' '));
const lbRecs = on.N.ues.flatMap((u) => u.hos).filter((h) => h.reason === 'load');
check('부하 분산 핸드오버: 신호 충분한 이웃 셀로(≥ −95dBm) · 실패·유실·무선 링크 실패 0', lbRecs.length > 0 && lbRecs.every((h) => h.rsrpTo >= -96 && h.ok) && on.Q.lost === 0 && on.Q.rlf === 0, `${lbRecs.length}건`);
check('혼잡 셀로의 핸드오버 거절 (수락 제어)', on.N.stats.lbBlock > 0, `${on.N.stats.lbBlock}회`);
console.log('== 접속 수락 제어: 이미 바쁜 기지국 아래에서 새 로봇 접속');
{ const s = new Simulation('dark', 3, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), N = s.net; run(s, ag, 30);
  const c0 = N.plan.cells[0]; for (let i = 0; i < 30; i++) { const m = { x: c0.x - 2 + (i % 6) * 0.8, z: c0.z - 2 + Math.floor(i / 6) * 0.8, moving: true }; N.addUE(`추가-${i}`, `HX-${i}`, 'humanoid', () => ({ x: m.x, y: 1.5, z: m.z, m })); }
  run(s, ag, 10);
  check('접속 때 여유 있는 이웃 기지국으로 연결 · 10ms 초과 0', (N.stats.lbAdmit ?? 0) > 0 && N.stats.latViol === 0, `다른 기지국 연결 ${N.stats.lbAdmit}대 · 셀1 ${N.cellLat[0].n}대`); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
