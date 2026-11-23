// FacOS 운영 경로 검증 — 운영 변경이 모두 FacOS 공장 결정을 거치는지(M1) · 인시던트가 A2A로 남는지(M2) · 이름 통일(M3) · FacOS 기록 서버 저장(A1)
// ① KPI 개선안 적용·되돌림 · AIOS 배포·롤백 · 대화 지시(혼류 비율 · 투입 간격) → 결정 요청 → 공장 결정(승인자 · 전/후) → 계획 버전 증가 → 적용
//    상위망 단절이면 적용하지 않음(사유) · 되돌림 · 롤백은 자율 조치로 적용하고 결정 요청은 Outbox에
// ② 설비 고장: 셀 OCS → 존 보고 · 존 → 셀/실행 자원 명령 · 존 → 공장 종료 보고 · P1 현장 이벤트: 공장 즉시 보고 · 차단 0 (micro는 Zone이 하나라 「다른 존 방송」은 0건 — 상위 meta-factory는 3곳)
// ③ 인시던트 오케스트레이터 이름 = 존 오케스트레이터
// ④ facos-store: 실행별 JSONL · 계획 버전 바뀔 때만 · 조회(events · decisions · orders · plans · export) · 같은 실행 이어 쓰기 · 보관 개수
//    게이트웨이 → 저장소 연결 (mqttPublish · 죽음 처리). 실행: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { applyAction } from '../js/dialog.js';
import { LANES } from '../js/orchestrator.js';
import { UnsNamespace } from '../js/uns.js';
import { makeFacosStore } from '../server/facos-store.mjs';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); } };

const s = new Simulation('dark', 7, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), F = s.fos;
run(s, ag, 1200);

console.log('== ① 운영 변경 → FacOS 결정 (M1)');
{ const A = s.impact.advisor, p = A.items.find((x) => x.lever && x.status !== 'applied') ?? (() => { A.analyze?.(); return A.items.find((x) => x.lever); })();
  if (!p) check('KPI 개선안이 만들어짐 (20분 운전)', false, `제안 ${A.items.length}개`);
  else {
    const v0 = F.planVersion, n0 = F.bus.seq;
    const ok = A.apply(p.id, '운영자 시험');
    const d = F.decisions[0], req = F.bus.log.find((m) => m.seq > n0 && m.type === 'decision.request');
    check('KPI 개선안 적용 → 결정 요청(Manufacturing Agent → 공장) → 결정(운영자 승인 · 전/후) → 계획 버전 +1', ok && p.status === 'applied' && req?.from === 'zone:main' && d.kind === 'kpi-lever' && d.approvedBy === '운영자 시험' && d.change?.before != null && F.planVersion !== v0 && p.version === F.planVersion, `${v0} → ${F.planVersion} · ${d.change?.before} → ${d.change?.after}`);
    const v1 = F.planVersion; A.revert(p.id, '운영자 시험');
    check('되돌림도 결정(kpi-revert) · 계획 버전 +1', p.status === 'reverted' && F.decisions[0].kind === 'kpi-revert' && F.planVersion !== v1);
    F.setOnline(false); p.status = 'verified'; const before = s.mode[p.lever] ?? null;
    const blocked = A.apply(p.id);
    check('상위망 단절이면 적용하지 않음 (사유 · 값 그대로 · 변경 이력에 보류)', !blocked && p.status === 'verified' && /상위망 단절/.test(p.blocked ?? '') && (s.mode[p.lever] ?? null) === before && F.changes[0].verdict === '보류', p.blocked);
    F.setOnline(true);
  }
  const v0 = F.planVersion, mixTo = s.line.mix === '1:1' ? '2:1' : '1:1';
  const r = applyAction({ type: 'mix', mix: mixTo }, s, { by: '운영자 대화 지시' });
  check('대화 지시(혼류 비율) → 결정(mix) · 지시한 사람이 승인자 · 계획 버전 +1', r.ok && s.line.mix === mixTo && F.decisions[0].kind === 'mix' && F.decisions[0].approvedBy === '운영자 대화 지시' && F.planVersion !== v0, r.text);
  const iv = applyAction({ type: 'interval', seconds: 9 }, s, { by: '운영자' });
  check('대화 지시(투입 간격) → 결정(interval)', iv.ok && F.decisions[0].kind === 'interval' && s.releaseInterval === 9);
  F.setOnline(false); const r2 = applyAction({ type: 'interval', seconds: 12 }, s, { by: '운영자' }); F.setOnline(true);
  check('상위망 단절 중 계획 변경 지시는 보류 (값 그대로)', !r2.ok && s.releaseInterval === 9 && /보류/.test(r2.text), r2.text);
  // AIOS: 섀도 모드가 끝난 후보를 배포 → 결정(aios-policy) · 실측 악화면 롤백(aios-rollback, 자율)
  const X = s.aios;
  if (!X?.on) check('AIOS 동작 (피지컬AI)', false);
  else {
    const prev = { ...X.policy }, cand = { ...X.policy, ecoWait: X.policy.ecoWait + 5 };
    X.job = { phase: 'shadow', t2: s.time - 61, label: 'v1.99', v: 99, prev, cand, why: ['시험'], result: { gain: 1 } };
    const v2 = F.planVersion; X.update(0.1);
    check('AIOS 배포 → 결정(aios-policy · 자율) · 계획 버전 +1 · 정책 적용', X.job?.phase === 'verify' && F.decisions[0].kind === 'aios-policy' && !F.decisions[0].approvedBy && F.planVersion !== v2 && X.policy.ecoWait === cand.ecoWait, `${v2} → ${F.planVersion}`);
    X.job.t3 = s.time - 601; X.job.base = { good: s.stats.good, uph: 1e6 }; F.setOnline(false); X.update(0.1); F.setOnline(true);
    const rb = F.decisions.filter((d) => d.kind === 'aios-rollback');
    check('실측 악화 → 자동 롤백: 상위망 단절이어도 적용(자율) · 복구 뒤 결정 요청 전달 → 공장 사후 확인', X.policy.ecoWait === prev.ecoWait && rb.some((d) => /자율/.test(d.verdict)) && rb.some((d) => d.verdict === '사후 확인') && F.bus.log.some((m) => m.body?.kind === 'aios-rollback' && m.tFlush != null), rb.map((d) => d.verdict).join(' · '));
  }
}

console.log('== ② 인시던트 → A2A (M2)');
{ const n0 = F.bus.seq, st = s.processing.find((x) => !x.standby && x.state !== 'DOWN'); s.injectFault(st); run(s, ag, 400);
  const L = F.bus.log.filter((m) => m.seq > n0 && m.subject?.incident != null && m.subject?.cell === st.id);
  const rep = L.find((m) => m.type === 'incident.report' && m.from === `cell:${st.id}` && m.to === 'zone:main'), cmd = L.find((m) => m.type === 'command' && m.from === 'zone:main'), close = L.find((m) => m.type === 'incident.close' && m.to === 'factory');
  check('설비 고장: 셀 OCS → 존 보고 · 존 → 셀/실행 자원 명령 · 존 → 공장 종료 보고 · 차단 0', !!rep && !!cmd && !!close && L.every((m) => m.status !== 'blocked'), L.map((m) => `${m.type} ${m.from}→${m.to}`).join(' | '));
  const n1 = F.bus.seq, ev = s.injectFieldEvent('smoke', 0, 9); s.detectFieldEvent(ev, '시험 카메라', 0.95); run(s, ag, 5);
  const P = F.bus.log.filter((m) => m.seq > n1 && m.subject?.incident === ev.inc?.id);
  const up = P.find((m) => m.type === 'incident.report' && m.to === 'factory'), bc = P.filter((m) => m.type === 'broadcast' && m.from === 'factory');
  check('P1 현장 이벤트: 존 → 공장 즉시 보고 · 차단 0 (방송 받을 다른 존이 없어 방송 0건)', !!up && bc.length === 0 && P.every((m) => m.status !== 'blocked'), `보고 ${up?.msgId ?? '-'} · 방송 ${bc.length}`);
  const U = new UnsNamespace(s), out = U.collect();
  check('UNS: 인시던트 A2A 경로 (main.{셀} → main · main → factory) · 결정에 승인자 · 전/후', out.some((m) => /_facos\/a2a\/main\.[^/]+\/main$/.test(m.topic)) && out.some((m) => m.topic.endsWith('_facos/a2a/main/factory')) && out.some((m) => m.topic.includes('_facos/decision/kpi-lever') && JSON.parse(m.payload).approvedBy));
}

console.log('== ③ 이름 (M3)');
check('인시던트 레인 · 오케스트레이터 이름 = 존 오케스트레이터', LANES.find((l) => l.key === 'orch').label === '존 오케스트레이터' && /존 오케스트레이터/.test(s.orch.name), s.orch.name);

console.log('== ④ FacOS 기록 서버 저장 (A1)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-facos-'));
{ const S = makeFacosStore({ dir: tmp, keep: 3 }), R = 'camtic/metafactory';
  const pub = (t, d) => S.tap(`${R}/${t}`, JSON.stringify(d));
  pub('_facos/decision/x', { kind: 'x' });
  check('실행 시작 전 메시지는 버림', S.status().written === 0);
  pub('_meta/namespace', { run: 'run-A', version: 'v1' });
  pub('_facos/state', { planVersion: 'P-1', online: true, upstream: 'connected', a2a: { sent: 1 } });
  pub('_facos/state', { planVersion: 'P-1', online: true, upstream: 'connected', a2a: { sent: 9 } });
  pub('_facos/state', { planVersion: 'P-2', online: true, upstream: 'connected' });
  pub('_facos/order/ORD-001', { id: 'ORD-001', good: 1 }); pub('_facos/order/ORD-001', { id: 'ORD-001', good: 2 });
  pub('_facos/decision/kpi-lever', { kind: 'kpi-lever', approvedBy: '운영자' });
  pub('_facos/a2a/main/factory', { msgId: 'A2A-1', type: 'incident.close' });
  pub('main/_zone/kpi', { oee: 1 });
  const st = S.status(), q = (p) => S.route('GET', `/api/facos/v1/${p.split('?')[0]}`, new URLSearchParams(p.split('?')[1] ?? ''));
  check('실행별 파일 · 계획 버전 바뀔 때만 plan · 오더 · 결정 · A2A만 (KPI 토픽 제외)', st.run === 'run-A' && st.counts.plan === 2 && st.counts.order === 2 && st.counts.decision === 1 && st.counts.a2a === 1 && st.counts.run === 1 && fs.existsSync(path.join(tmp, 'run-A.jsonl')), JSON.stringify(st.counts));
  check('조회: orders = 오더마다 마지막 · plans · decisions · events(type · since)', q('orders').body.orders[0].good === 2 && q('plans').body.plans.map((p) => p.planVersion).join() === 'P-1,P-2' && q('decisions').body.decisions[0].approvedBy === '운영자' && q('events?type=a2a').body.events.length === 1 && q('events?since=3').body.events.every((e) => e.seq > 3));
  const ex = q('export');
  check('내려받기 = JSONL 그대로 · 잘못된 run 거부 · 쓰기 거부', ex.raw.trim().split('\n').length === st.seq && q('events?run=../x').code === 400 && S.route('POST', '/api/facos/v1/events', new URLSearchParams()).code === 405);
  const S2 = makeFacosStore({ dir: tmp, keep: 3 }); S2.tap(`${R}/_meta/namespace`, JSON.stringify({ run: 'run-A' })); S2.tap(`${R}/_facos/decision/y`, JSON.stringify({ kind: 'y' }));
  check('앱 서버가 다시 떠도 같은 실행은 번호를 이어 씀', S2.status().seq === st.seq + 1);
  for (const r of ['run-B', 'run-C', 'run-D', 'run-E']) S2.tap(`${R}/_meta/namespace`, JSON.stringify({ run: r }));
  check('보관 개수(3) 넘는 오래된 실행 파일은 지움', S2.route('GET', '/api/facos/v1/runs', new URLSearchParams()).body.runs.length === 3);
}
{ process.env.UNS_DEAD_S = '1';
  const net = await import('node:net'), port = await new Promise((r) => { const v = net.createServer().listen(0, '127.0.0.1', () => { const p = v.address().port; v.close(() => r(p)); }); });
  const G = await import('../server/mqtt-gateway.mjs'), dir = path.join(tmp, 'gw'), S = makeFacosStore({ dir });
  await G.startMqtt({ host: '127.0.0.1', port, aclFile: path.join(tmp, 'acl.json'), sparkplug: false, engine: 'aedes' }); G.setUnsTap(S.tap);
  const U = new UnsNamespace(s, { run: () => 'run-GW' }); G.mqttPublish(U.collect());
  check('게이트웨이 → 저장소: 탄생 메시지로 실행 파일 · 결정 · A2A 기록', S.status().run === 'run-GW' && S.status().counts.decision > 0 && S.status().counts.a2a > 0, JSON.stringify(S.status().counts));
  await new Promise((r) => setTimeout(r, 3500));
  check('게이트웨이 죽음 처리(online:false)도 계획 기록에', S.route('GET', '/api/facos/v1/plans', new URLSearchParams()).body.plans.at(-1)?.online === false);
  await G.stopMqtt();
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
