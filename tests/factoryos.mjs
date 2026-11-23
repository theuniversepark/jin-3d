// FacOS 계층 검증 (정밀조립Zone 하나) — 공장 오케스트레이터(FacOS) · Manufacturing Agent · 셀 OCS · A2A 메시지
// 가드레일(계층 권한표) · 오더·수량 정산 · 셀 OCS 상태머신·명령 검증 · 결정 메시지 필수 필드 · 상위망 단절(Outbox) · 이상 판단 10초. 실행: npm test
// (상위 meta-factory tests/factoryos.mjs에서 Zone 간 정비 지원 · 정밀검사 샘플 핸드셰이크 · 확장 Zone 오케스트레이터 검사는 뺐다 — Zone이 하나, 샘플 검사는 js/serial.js가 스스로)
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { HybridAgent } from '../js/multiagent.js';
import { allowed, ocsState, OCS } from '../js/factoryos.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); } };
console.log('== 가드레일 (계층 권한표)');
check('같은 계층(존 ↔ 존) 권한표: 핸드셰이크·품질 알림만 · 명령 금지 (상대 존이 없어도 규칙은 그대로)', allowed('zone:main', 'zone:x', 'service.request') && allowed('zone:x', 'zone:main', 'quality.alert') && !allowed('zone:main', 'zone:x', 'command'));
check('셀 → 공장 직접 보고 금지 (계층 건너뛰기) · 셀 ↔ 셀 명령 금지', !allowed('cell:SORT', 'factory', 'status') && !allowed('cell:SORT', 'cell:PACK', 'command'));
check('공장 → 셀 직접 명령 금지 (계층 건너뛰기) · 존 → 자기 셀 명령 허용 · 셀 → 존 상태 보고 허용', !allowed('factory', 'cell:SORT', 'command') && allowed('zone:main', 'cell:SORT', 'command') && allowed('cell:SORT', 'zone:main', 'status'));
check('존 → 공장 결정 요청 허용 · 존 → 공장 명령 금지', allowed('zone:main', 'factory', 'decision.request') && !allowed('zone:main', 'factory', 'command'));
console.log('== 자동화 3시간 (정밀조립)');
const s = new Simulation('smart', 6, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), F = s.fos;   // 시드 6 — 8D 봉쇄(HOLD)가 남은 오더는 사람 결정 전까지 닫히지 않는다(정산 원칙). 봉쇄가 풀린 오더가 5시간 안에 닫히는 시드
run(s, ag, 18000);   // 5시간 — 실제 작업 시간(1.0.48 · e-axle EOL 시험 포함 · 약 65대/시간)으로 오더(양품 100) 1건 이상 종료 (첫 종료 약 4.5시간)
{ const g = F.bus.send(`cell:${s.processing[0].id}`, 'factory', 'status', { text: '시험' });
  check('가드레일이 셀 → 공장 건너뛰기를 막고 기록', g.status === 'blocked' && F.bus.stats.blocked >= 1 && /건너뛰기/.test(g.why), g.why);
  check('존 오케스트레이터는 정밀조립 하나 · 존 → 존 메시지 없음', Object.keys(F.zones).join() === 'main' && !F.bus.log.some((m) => m.from.startsWith('zone:') && m.to.startsWith('zone:')));
  const C = F.orders.filter((o) => o.status === 'closed');
  check('오더 종료: 양품 100 · 정산 오차 0 · 고유 투입 = 양품 + 폐기 (불량 보충 투입)', C.length >= 1 && C.every((o) => o.recon.err === 0 && o.recon.good === 100 && o.recon.input === o.recon.good + o.recon.scrap + o.recon.wip + o.recon.pass + o.recon.hold), C.map((o) => `${o.id} ${o.recon.input}=${o.recon.good}+${o.recon.scrap}`).join(' · '));
  const flow = ['order.assign', 'order.ack', 'order.evidence', 'order.close'].every((t) => F.bus.stats.byType[t] > 0);
  check('오더 메시지: 배정 → 수락·계획 → 종료 증빙 → 종료', flow, JSON.stringify(F.bus.stats.byType));
  const R = F.main.reconcile();
  check('전체 수량 정산 오차 0 (공정중 + 합격대기 + HOLD + 인계 + 폐기 = 고유 투입)', R.err === 0 && R.input === s.trace.stats.released, JSON.stringify(R));
  check('셀 OCS: 정밀조립 셀마다 · 상태 7종 안', s.processing.every((st) => F.ocs.has(st.id)) && s.processing.every((st) => OCS[ocsState(st)]), s.processing.map((st) => `${st.id}:${ocsState(st)}`).join(' '));
  const ok = [...F.ocs.values()].reduce((a, c) => a + c.ok, 0);
  const st = s.processing.find((x) => !x.request && x.state !== 'DOWN'); s.requestTech(st, 'pm'); const before = F.ocs.get(st.id).rej; s.requestTech(st, 'cal');
  check('셀 OCS 명령 검증: 정비·보정 승인 기록 · 진행 중 다른 정비는 거부 사유와 함께', ok > 5 && F.ocs.get(st.id).rej === before + 1 && /거부/.test(F.ocs.get(st.id).checks[0].reason), F.ocs.get(st.id).checks[0].reason);
  check('이상 판단 10초 (자동화 MES)', F.judge.n >= 3 && F.judge.fast / F.judge.n >= 0.9, `${F.judge.fast}/${F.judge.n} · 평균 ${(F.judge.sum / F.judge.n).toFixed(1)}초`);
}
console.log('== 8D 정책 승인 → 공장 결정 (사람 결정)');
{ const K = s.capa, k = K.pending[0];
  check('8D D5 → Manufacturing Agent가 공장에 정책 승인 결정 요청 (시간 초과 없음)', !!k?.fosReq && k.fosReq.type === 'decision.request' && k.fosReq.status !== 'timeout');
  K.approve(k.id);
  const d = F.decisions.find((x) => x.kind === 'policy');
  check('정책 반영 → 공장 결정 메시지 (승인 · 버전 증가 · 재개 조건)', d?.verdict === '승인' && d.resume && F.bus.log.some((m) => m.type === 'decision' && m.corr === k.fosReq.msgId), d?.text);
  // 필수 필드는 결정이 하나 이상 있는 여기서 본다 — 납기 위험 판단이 가동 직후에는 미뤄져(js/factoryos.js rateInfo) 운전만으로는 결정이 안 생길 수 있다
  const D = F.decisions;
  check('공장 결정 메시지 필수 필드 (대상 · 권한자 · 버전 · 제약 · 재개 조건)', D.length > 0 && D.every((d) => d.target && d.authority && /^P-\d+$/.test(d.version) && 'constraints' in d && 'resume' in d), `${D.length}건 · ${[...new Set(D.map((d) => d.kind))].join(', ')}`);
}
console.log('== 상위망 단절 → Edge Outbox → 복구');
{ F.setOnline(false);
  const m = F.main.escalate('due-risk', '시험: 납기 위험', { lateBy: 60 }, { order: F.orders[0].id });
  check('단절 중 공장행 메시지는 Outbox에 쌓임 (존은 승인 범위 안에서 계속)', m.status === 'queued' && F.bus.outbox.length >= 1);
  run(s, ag, 30);
  const n = F.setOnline(true);
  check('복구하면 Outbox 전송 → 공장 결정', n >= 1 && F.bus.outbox.length === 0 && F.bus.log.some((x) => x.type === 'decision' && x.corr === m.msgId), `${n}건 전송`);
}
console.log('== 단계별 이상 판단 시간');
{ const L = new Simulation('traditional', 3, { line: zoneLine(), quiet: true }), la = new FactoryAgent(L); run(L, la, 3600);
  const D = new Simulation('dark', 3, { line: zoneLine(), quiet: true }), da = new HybridAgent(D); run(D, da, 3600);
  const r = (X) => (X.fos.judge.n ? X.fos.judge.fast / X.fos.judge.n : 1);
  check('피지컬AI 이상 판단 10초 이내 90%↑ · 레거시(작업반장)보다 빠름', r(D) >= 0.9 && (!L.fos.judge.n || D.fos.judge.sum / Math.max(1, D.fos.judge.n) < L.fos.judge.sum / Math.max(1, L.fos.judge.n)), `피지컬AI ${(r(D) * 100).toFixed(0)}% (${D.fos.judge.n}건) · 레거시 ${(r(L) * 100).toFixed(0)}% (${L.fos.judge.n}건)`);   // 레거시 1시간에 이상이 한 건도 없으면 비교하지 않는다 (시드·셀 배치에 따라)
  check('혼합형 다중: 존 에이전트(Field Logistics · 정비 · 품질 · 흐름 · 반사 규칙) 등록', D.fos.main.agents().length === 5 && D.fos.registry().some((x) => x.name === 'Agent Gateway'), D.fos.main.agents().map((a) => a.name).join(', '));
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
