// Private 5G 검증 — 음영지역 없는 기지국 배치(여러 라인 배치), PCI 고유·이웃 mod 3 분리, 이동 로봇 5G 모뎀 연결,
// 핸드오버 성공·무선 링크 실패 없음·업링크 유실 0 (핸드오버 중 버퍼 포워딩), 레거시 단계는 5G 없음. 실행: npm test
import { zoneLine, DEFAULT_LINE } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { plan5G, NR } from '../js/net5g.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 기지국 배치 · PCI');
for (const [nm, ln] of [['정밀조립Zone 1:1', zoneLine()], ['정밀조립Zone 2:1', zoneLine('2:1')], ['기본 라인', DEFAULT_LINE]]) {
  const s = new Simulation('dark', 1, { line: ln, quiet: true }), p = plan5G(s), S = p.stats;
  check(`${nm}: 음영지역 0곳 (모든 지점 RSRP ≥ ${NR.design}dBm 설계 기준)`, S.holes === 0 && S.design === 1, `기지국 ${p.cells.length}대 · 지점 ${S.points} · 최저 ${S.minRsrp.toFixed(1)}dBm · SINR≥0dB ${(S.sinrOk * 100).toFixed(0)}%`);
  const domes = s.cctv.cams.filter((c) => c.region === 'inside'), gap = Math.min(...p.cells.map((c) => Math.min(...domes.map((k) => Math.hypot(k.x - c.x, k.z - c.z)))));
  check(`${nm}: 기지국과 천장 CCTV가 겹치지 않음 (2.5m 이상 떨어짐)`, gap >= 2.5, `최소 간격 ${gap.toFixed(1)}m`);
  const pcis = p.cells.map((c) => c.pci);
  check(`${nm}: PCI 고유(0~1007)`, new Set(pcis).size === pcis.length && pcis.every((v) => v >= 0 && v <= 1007), pcis.join(','));
  const M = S.mod3, long = p.cells.every((c) => c.neighbors.every((n) => c.border[n] < 15 || p.cells[n].pci % 3 !== c.pci % 3));
  check(`${nm}: 이웃 셀 PCI mod 3 최적화 — 긴 경계(30m 이상)는 모두 다르고 같은 mod 3 경계 10% 이하`, long && M.conflictBorder / M.border <= 0.1, `같은 mod 3 경계 ${M.conflictBorder * 2}m / ${M.border * 2}m (${((M.conflictBorder / M.border) * 100).toFixed(1)}%) · ${M.pairs}쌍(모서리 접촉)`);
}
console.log('== 이동 로봇 5G · 핸드오버 · 무손실 (피지컬AI 1시간)');
{ const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  for (let t = 0; t < 3600; t += 0.1) { s.step(0.1); ag.update(0.1); }
  const N = s.net, Q = N.summary(), kinds = new Set(N.ues.map((u) => u.kind));
  check('이동 로봇 모두 5G 모뎀 (AMR·AGV·자율 지게차·휴머노이드·사족보행·드론·AMMR)', ['carrier', 'agv', 'forklift', 'humanoid', 'quadruped', 'drone', 'ammr'].every((k) => kinds.has(k)) && N.ues.every((u) => u.serv != null), `${Q.ues}대`);
  check('핸드오버가 일어나고 모두 성공 (A3 + TTT)', Q.ho > 100 && Q.hoFail === 0, `${Q.ho}회 · 평균 중단 ${Q.avgHoMs.toFixed(0)}ms · 핑퐁 ${Q.pingpong}`);
  check('무선 링크 실패 0 (음영지역 없음)', Q.rlf === 0 && N.ues.every((u) => u.rsrp >= NR.require));
  check('업링크 데이터 유실 0 (DAPS 핸드오버 — 실행 중에도 소스 셀로 계속 전송, 버퍼·끊김 없음)', Q.lost === 0 && Q.delivered + Q.inflight === Q.sent && Q.daps && Q.inflight === 0, `송신 ${Q.sent} · 도착 ${Q.delivered} · 버퍼 ${Q.fwd}`);
  const hos = N.ues.flatMap((u) => u.hos);
  check('핸드오버 기록: 다른 PCI로 · A3는 타깃 셀이 더 강함 (부하 분산은 신호 충분한 이웃 셀)', hos.length > 0 && hos.every((h) => h.from !== h.to && (h.reason === 'load' ? h.rsrpTo >= -96 : h.rsrpTo > h.rsrpFrom)), `${hos.length}건`);
}
{ const s = new Simulation('smart', 2, { line: zoneLine(), quiet: true }); for (let t = 0; t < 600; t += 0.1) s.step(0.1);
  check('자동화 단계: AMR·AGV 5G 연결, 유실 0', s.net.on && s.net.ues.length > 0 && s.net.ues.every((u) => ['carrier', 'agv'].includes(u.kind)) && s.net.summary().lost === 0, `${s.net.ues.length}대`); }
{ const s = new Simulation('traditional', 2, { line: zoneLine(), quiet: true }); check('레거시 단계: 5G 특화망 없음', !s.net.on && s.net.ues.length === 0); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
