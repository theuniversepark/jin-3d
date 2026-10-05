// KPI 영향 분석 · 개선 제안 · 의사결정 지원 검증 — 이벤트·문제를 원인별로 나눠 UPH·OEE·WIP·POWER 손실에 반영하는지,
// 손실이 큰 원인에 개선 제안을 만들고 디지털트윈으로 검증하며, 적용 · 보류 · 실측 · 되돌리기가 실제 운영값에 반영되는지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { LEVERS, impactMarkdown } from '../js/impact.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (mode, seed, T, events) => {
  const s = new Simulation(mode, seed, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s); let next = 300;
  for (let t = 0; t < T; t += 0.1) { s.step(0.1); ag.update(0.1);
    if (events && t > next) { next += 600; const k = Math.floor(t / 600); const p = [[4, 8.2], [-6, -8.2], [14, 8.4], [-20, 8.6], [22, -8.4]][k % 5]; s.injectFieldEvent(['leak', 'debris', 'smoke'][k % 3], p[0], p[1]); } }
  return { s, ag };
};

console.log('== 원인별 손실 분해 (피지컬AI 1시간 · 10분마다 진로 이벤트)');
const { s } = run('dark', 3, 3600, true);
const R = s.impact.report(0), K = R.kpi, sumPts = R.rows.reduce((a, r) => a + r.oeePts, 0), by = Object.fromEntries(R.rows.map((r) => [r.key, r]));
check('OEE + 원인별 OEE 손실 = 100%', Math.abs(K.oee + sumPts - 1) < 0.005, `OEE ${(K.oee * 100).toFixed(1)}% + 손실 ${(sumPts * 100).toFixed(1)}%p`);
check('OEE·UPH가 kpi()와 같음', Math.abs(K.oee - s.kpi().OEE) < 0.01 && Math.abs(K.uph - s.kpi().good / (s.time / 3600)) < 3, `${(K.oee * 100).toFixed(1)}% · UPH ${Math.round(K.uph)}`);
check('kpi()에 원인별 영향 반영 (impact)', !!s.kpi().impact?.rows?.length);
check('예지정비·재보정 정지가 원인별 손실로 잡힘', by.pm.units + by.cal.units > 0 && by.pm.count + by.cal.count > 0, `예지정비 ${by.pm.count}건 · 재보정 ${by.cal.count}건`);
check('품질 불량 = 검출 + 유출', Math.abs(by.quality.units - Math.min(R.loss, s.stats.rejected + s.stats.escaped)) < 1e-6, `${by.quality.units}개`);
check('진로 현장 이벤트 영향 (건수 · 정지 대기)', by.hazard.count > 0 && R.hazardMoverSec >= 0, `${by.hazard.count}건 · 로봇 정지 대기 ${Math.round(R.hazardMoverSec)}대·초`);
check('전력 낭비 ≤ 전체 에너지, kWh/개 영향 ≥ 0', K.wasteKwh <= K.energy && R.rows.every((r) => r.kwhUnitGain >= -1e-9), `낭비 ${K.wasteKwh.toFixed(2)} / ${K.energy.toFixed(1)}kWh`);
check('이벤트별 영향 목록', R.events.length > 0 && R.events.every((e) => e.units >= 0 && e.dur >= 0), `${R.events.length}건`);
const R10 = s.impact.report(600);
check('최근 10분 구간 분석', Math.abs(R10.T - 600) < 31 && Math.abs(R10.kpi.oee + R10.rows.reduce((a, r) => a + r.oeePts, 0) - 1) < 0.01, `구간 ${Math.round(R10.T)}초`);
const md = impactMarkdown(s, 0);
check('리포트 (UPH · OEE · WIP · POWER · 원인 · 이벤트 · 제안)', ['UPH', 'OEE', 'WIP', 'POWER', '원인별 영향', '이벤트별 영향', '개선 방법'].every((w) => md.includes(w)), `${md.length}자`);

console.log('== 개선 제안 · 의사결정 (자동화 1시간)');
const B = run('smart', 3, 3600, false).s, A = B.impact.advisor;
check('손실이 큰 원인에 개선 제안', A.items.length > 0 && A.items.every((p) => p.why && p.expect && p.kpi.length), A.items.map((p) => p.title).join(' · '));
const p = A.items.find((x) => x.lever === 'amrStage') ?? A.items.find((x) => x.lever);
A.verify(p.id); A.work();
check('디지털트윈 검증 (현재 vs 제안)', p.status === 'verified' && p.twin && p.twin.uphCur > 0 && ['apply', 'neutral', 'hold'].includes(p.twin.recommend), `${p.title}: UPH ${Math.round(p.twin.uphCur)} → ${Math.round(p.twin.uphCand)} · ${p.twin.recommend}`);
const from = LEVERS[p.lever].get(B);
A.apply(p.id);
check('적용 → 운영값 변경 · 오케스트레이터 로그', LEVERS[p.lever].get(B) === p.to && p.status === 'applied' && A.log[0].act === '적용', `${LEVERS[p.lever].label} ${from} → ${LEVERS[p.lever].get(B)}`);
const ag2 = new FactoryAgent(B); for (let t = 0; t < 620; t += 0.1) { B.step(0.1); ag2.update(0.1); }
check('적용 후 10분 실측 효과', p.measured && p.after && p.before, p.after ? `UPH ${Math.round(p.before.uph)} → ${Math.round(p.after.uph)}` : '');
A.revert(p.id);
check('되돌리기 → 원래 운영값', LEVERS[p.lever].get(B) === from && p.status === 'reverted', `${LEVERS[p.lever].get(B)}`);
const q = A.items.find((x) => x.status === 'new' || x.status === 'verified');
if (q) { A.hold(q.id); A.refresh(); check('보류 → 30분 동안 같은 제안을 다시 묻지 않음', !A.items.some((x) => x !== q && (x.lever ?? x.title) === (q.lever ?? q.title) && x.status === 'new')); }
else check('보류', true, '남은 제안 없음');
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
