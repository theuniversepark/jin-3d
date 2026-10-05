// 문제 해결 우선순위 검증 — 화재·사람·시설 안전(P1·P2)을 먼저, 그다음 생산 정지(P3) · 생산 차질(P4) · 효율·품질(P5).
// 정비 휴머노이드가 모두 수리·예지정비 중일 때 연기(화재 의심)가 나면 하던 일을 멈추고 소화기를 챙겨 먼저 대응하고, 해소 뒤 수리를 이어 끝내는지,
// 판단 지연 · 드론 출동 · 예지정비 보류 · 인시던트 목록이 우선순위를 따르는지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { prioOf } from '../js/orchestrator.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, T, each) => { for (let t = 0; t < T; t += 0.1) { s.step(0.1); ag.update(0.1); each?.(); } };

console.log('== 문제 해결 우선순위 (피지컬AI)');
{
  const s = new Simulation('dark', 4, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  run(s, ag, 400);
  // 정비 휴머노이드 2대를 모두 생산 정지 수리에 묶는다
  const cells = s.processing.filter((st) => !st.standby && st.state !== 'DOWN' && st.state !== 'MAINT').slice(0, 2);
  for (const st of cells) s.fail(st);
  let onSite = false;
  for (let t = 0; t < 200 && !onSite; t += 0.1) { s.step(0.1); ag.update(0.1); onSite = cells.every((st) => st.techOnSite); }
  const busy = s.techs.filter((t) => t.job?.prio === 3).length;
  check('정비 휴머노이드가 모두 긴급수리(P3) 중', busy === s.techs.length, `${busy}/${s.techs.length}대 · 현장 도착 ${onSite}`);
  // 대응 로봇 선택: 덜 급한 일(부품 보충 P4·대기)을 하던 휴머노이드를 먼저 — 생산 정지 수리(P3)는 되도록 끊지 않는다
  const probe = { x: -6, z: -8.2 }, pick = s.pickResponder(probe, 1);
  check('대응 로봇 선택: 덜 급한 일을 하던 휴머노이드 먼저', !!pick && s.jobPrio(pick) > 3, `${pick?.id} (현재 일 P${s.jobPrio(pick) === 99 ? '대기' : s.jobPrio(pick)})`);
  // 물류 휴머노이드가 배터리 부족이면(대응 불가) 수리 중인 정비 휴머노이드를 선점해야 한다
  for (const h of s.helpers) h.battery = 10;
  // 동시에 바닥 이물질(P2)과 연기 의심(P1) — 연기가 먼저 판단·출동
  const leakEv = s.injectFieldEvent('debris', 4, 8.2), smokeEv = s.injectFieldEvent('smoke', -6, -8.2);
  s.detectFieldEvent(leakEv, 'CCTV-테스트', 0.9); s.detectFieldEvent(smokeEv, 'CCTV-테스트', 0.9);
  const iS = smokeEv.inc, iL = leakEv.inc;
  check('연기 의심 = P1 화재·인명 안전, 이물질 = P2 시설 안전, 설비 고장 = P3', prioOf(iS) === 1 && prioOf(iL) === 2 && prioOf(s.orch.find(`fail:${cells[0].id}`)) === 3);
  let tCmdS = null, tCmdL = null, fxId = null, deferredSeen = false;
  const repairBefore = cells.map((st) => st.repairRemaining);
  run(s, ag, 2, () => {
    tCmdS ??= iS.steps.find((x) => x.kind === 'command')?.t ?? null; tCmdL ??= iL.steps.find((x) => x.kind === 'command')?.t ?? null;
  });
  check('P1 판단·명령이 P2보다 먼저 (판단 지연 P1 25% · P2 50%)', tCmdS != null && tCmdL != null && tCmdS < tCmdL, `연기 ${(tCmdS - smokeEv.t0).toFixed(2)}초 · 이물질 ${(tCmdL - leakEv.t0).toFixed(2)}초`);
  const fx = s.movers.find((m) => m.job?.ev === smokeEv); fxId = fx?.id;
  check('수리 중이던 휴머노이드가 하던 일을 멈추고 소화기 대응 (선점)', !!fx && s.techs.includes(fx) && iS.steps.some((x) => /P1 우선 — .* 중단/.test(x.text)), fxId ?? '없음');
  const pausedCell = cells.find((st) => !st.techOnSite && st.state === 'DOWN');
  check('수리 진행률은 유지 (자리를 비운 동안 수리 멈춤)', !pausedCell || pausedCell.repairRemaining >= repairBefore[cells.indexOf(pausedCell)] - 0.5);
  // P1 진행 중에는 예지정비 요청을 보류
  const pmCell = s.processing.find((st) => !st.standby && !st.request && st.state !== 'DOWN');
  s.requestTech(pmCell, 'pm');
  run(s, ag, 3, () => { deferredSeen ||= !!pmCell.request?.deferred && !pmCell.request.tech; });
  check('P1 대응 중 예지정비(P5) 배정 보류', deferredSeen, pmCell.name);
  // 목록 순서: 진행 중인 인시던트는 P1 → P2 → P3
  const open = s.orch.incidents.filter((i) => i.status === 'open').sort((a, b) => prioOf(a) - prioOf(b) || a.t0 - b.t0);
  check('진행 중 인시던트 우선순위 순 (P1 먼저)', open.length >= 2 && prioOf(open[0]) === 1, open.map((i) => `P${prioOf(i)}`).join(' '));
  // 드론: P1 현장에 먼저
  const dS = s.drones.find((d) => d.mission === iS);
  check('순찰 드론이 P1 현장으로 출동', !!dS || iS.droneDone, dS?.id ?? '완료');
  // 끝까지 돌려 모두 해결 — 연기 해소 뒤 소화기 반납 · 수리 재개 · 완료, 예지정비도 이어서 배정
  let pmAssigned = false;
  run(s, ag, 300, () => { pmAssigned ||= !!pmCell.request?.tech || s.stats.pm > 0; });
  check('연기 해소 → 이물질 처리 → 수리 재개·완료', smokeEv.cleared && leakEv.cleared && cells.every((st) => st.state !== 'DOWN'), `연기 ${Math.round(smokeEv.tClear - smokeEv.t0)}초 · 이물질 ${Math.round(leakEv.tClear - leakEv.t0)}초`);
  check('P1 해소 뒤 보류했던 예지정비 배정', pmAssigned);
  check('선점된 휴머노이드가 원래 일로 복귀', !s.movers.find((m) => m.id === fxId)?.job?.ev, s.movers.find((m) => m.id === fxId)?.task ?? '대기');
}
console.log('== 우선순위 하에서도 운영 지속 (피지컬AI 2시간 · 10분마다 이벤트)');
{
  const s = new Simulation('dark', 6, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s); let next = 300;
  const evs = [];
  run(s, ag, 7200, () => { if (s.time > next) { next += 600; const k = Math.floor(s.time / 600); const p = [[4, 8.2], [-6, -8.2], [14, 8.4], [-20, 8.6], [22, -8.4]][k % 5]; evs.push(s.injectFieldEvent(['smoke', 'leak', 'debris', 'intrusion'][k % 4], p[0], p[1])); if (k % 3 === 0) s.fail(s.processing[k % s.processing.length]); } });
  const p1 = evs.filter((e) => ['smoke', 'intrusion'].includes(e.type) && e.detected), p2 = evs.filter((e) => ['leak', 'debris'].includes(e.type) && e.detected);
  // 감지 → 오케스트레이터 대응 명령까지 (처리 시간은 일의 종류가 달라 비교하지 않는다)
  const cmdT = (e) => (e.inc?.steps.find((x) => x.kind === 'command')?.t ?? e.tClear) - e.tDetect;
  const avg = (a) => a.reduce((x, e) => x + cmdT(e), 0) / Math.max(1, a.length);
  check('모든 현장 이벤트 해결', evs.every((e) => e.cleared), `${evs.filter((e) => e.cleared).length}/${evs.length}`);
  check('P1(화재·인명) 대응 명령이 P2보다 빠름', avg(p1) < avg(p2), `감지 → 명령 P1 ${avg(p1).toFixed(2)}초 · P2 ${avg(p2).toFixed(2)}초`);
  check('생산 계속 (출하)', s.stats.shipped > 400, `출하 ${s.stats.shipped} · 선점 ${s.stats.preempts ?? 0}회 · 보류 ${s.stats.deferred ?? 0}건`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
