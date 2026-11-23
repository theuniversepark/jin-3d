// 제품 추적 · 불량 원인 분석 · 8D CAPA 검증 — 시리얼·계보가 빠짐없이 남는지, NG → 사례·AI 원인 분석·8D(Zone·총괄) → 정책 반영·효과 검증,
// 내려받기 묶음(EPCIS 2.0 · ISA-95 · 특징 표)이 올바른지, 환경 모델이 시뮬레이션 난수 흐름을 바꾸지 않는지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { caseFiles, allFiles, ENV_KEYS } from '../js/trace.js';
import { zipStore } from '../js/aasx.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); } };
const iso = (t) => new Date(Date.UTC(2026, 9, 15) + t * 1000).toISOString();
console.log('== 제품 추적 (자동화 · 3시간)');
const s = new Simulation('smart', 3, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), T = s.trace;
run(s, ag, 10800);   // 3시간 — 체결 셀 사이클이 실제 작업 시간(로봇당 2~4점)이라 라인 속도가 느려 NG 사례·CAPA가 2시간으로는 모자란다
{ const wips = T.recent.map((r) => r.wip), packed = T.recent.filter((r) => r.steps.some((p) => p.id === 'PACK' && p.tOut != null)), serials = packed.map((r) => r.serial);
  check('2단 ID: 투입 제품마다 고유 WIP ID (WIP-DT/EA-YYMMDD-일련번호)', new Set(wips).size === wips.length && T.recent.every((r) => /^WIP-(DT|EA)-\d{6}-\d{6}$/.test(r.wip)), `${wips.length}개`);
  check('2단 ID: 검사·포장셀 통과품만 제품 시리얼 · SGTIN EPC · QR (체결 NG품은 시리얼 없음)', packed.length > 150 &&   /* 실제 작업 시간(1.0.45): 3시간 약 230개 */ new Set(serials).size === serials.length && packed.every((r) => /^(DT|EA)-\d{6}-\d{6}$/.test(r.serial) && r.epc.startsWith('urn:epc:id:sgtin:') && r.mark?.symbol === 'QR' && r.mark.at === 'PACK') && T.recent.filter((r) => r.status === 'ng' && !r.recovered).every((r) => !r.serial), `${serials.length}개`);
  const done = T.recent.filter((r) => r.status === 'ok' || r.status === 'escaped');
  const route = { doortrim: ['SORT', 'DT_ASSY', 'DT_FAST', 'PACK'], eaxle: ['SORT', 'EA_ASSY', 'EA_FAST', 'PACK'] };
  check('완료 제품 계보 = 제품별 경로 셀 전부 (셀·로봇·AMR·건강도·환경)', done.length > 150 && done.every((r) => r.steps.map((p) => p.id).join() === route[r.product].join() && r.steps.every((p) => p.tOut != null && p.robots.length && p.amr && ENV_KEYS.every((k) => p.env[k] != null))), `${done.length}개`);
  check('양품 수 = 시뮬레이션 양품 수', T.stats.ok === s.stats.good && T.stats.ng - (T.stats.recovered ?? 0) === s.stats.rejected, `추적 ${T.stats.ok}·${T.stats.ng} / 시뮬레이션 ${s.stats.good}·${s.stats.rejected}`);
}
console.log('== 불량 사례 · AI 원인 분석');
{ const C = T.cases;
  // 봉쇄로 회수한 유출품(capa.js recovered)은 NG로 세지만 인라인 판정 사례는 만들지 않는다 — 위 양품 수 검사와 같은 기준
  check('NG마다 사례 (판정 토크·각도 규격 이탈 · 봉쇄 범위 · 판정 순간 설비 상태)', C.length === T.stats.ng - (T.stats.recovered ?? 0) && C.length >= 1 && C.every((c) => c.inspection.result === 'NG' && (c.inspection.torque < c.inspection.spec.torque[0] || c.inspection.angle > c.inspection.spec.angle[1]) && c.equipment.length === s.processing.length), `${C.length}건`);
  check('AI 원인 분석: 1순위 셀이 정답(불량이 생긴 셀)과 80% 이상 일치 · 3순위 안 95% 이상', T.stats.top1 / T.stats.cases >= 0.8 && T.stats.top3 / T.stats.cases >= 0.95, `1순위 ${T.stats.top1}/${T.stats.cases} · 3순위 ${T.stats.top3}`);
  check('원인 순위 비중 합 ≈ 1 · 근거 문장 · 5 Why', C.every((c) => Math.abs(c.rca.causes.reduce((a, x) => a + x.score, 0) - 1) < 0.05 || c.rca.causes.length === 8) && C.every((c) => c.rca.causes[0].evidence.length && c.rca.why.length >= 3));
}
console.log('== 8D CAPA (Zone · 총괄 오케스트레이터) → 정책 반영');
{ const K = s.capa, inc = s.orch.incidents.filter((i) => i.type === 'defect');
  check('불량 판정이 Zone 오케스트레이터 인시던트로 (감지 → 격리 → 상위 보고)', inc.length > 0 && inc.every((i) => i.steps.some((x) => x.kind === 'report')), `${inc.length}건`);
  const k = K.list.at(-1);
  check('8D: D0~D5 진행 · 총괄 오케스트레이터 Quality Alert · 정책 결정 대기', K.pending.length > 0 && ['D0', 'D1', 'D2', 'D3', 'D4', 'D5'].every((d) => k.steps.some((x) => x.d === d)) && k.steps.some((x) => x.lane === 'hq'), `${K.list.length}건 · 대기 ${K.pending.length}`);
  check('같은 원인 NG는 진행 중 8D에 묶음', K.list.reduce((a, x) => a + x.cases.length, 0) === T.cases.length);
  const pm0 = s.mode.pmThreshold, cpk0 = s.mode.cpkMin ?? 1.15;
  const approved = new Set(K.pending.map((x) => x.id));   // 승인한 8D만 종결을 본다 — 이후 새로 열린 8D는 아직 승인 대기
  for (const x of [...K.pending]) K.approve(x.id);
  run(s, ag, 2100);
  check('정책 반영 → 운영 값 변경 (예지정비 착수 건강도 · 재보정 Cpk)', K.policies.length > 0 && (s.mode.pmThreshold > pm0 || (s.mode.cpkMin ?? 1.15) > cpk0), `예지정비 ${pm0} → ${s.mode.pmThreshold} · Cpk ${cpk0} → ${s.mode.cpkMin}`);
  check('효과 검증 · FMEA AP 갱신 · D8 종결', K.list.filter((x) => x.cases.length && approved.has(x.id)).every((x) => x.status === 'closed' && x.effect && x.fmea?.AP?.length === 2 && x.steps.some((y) => y.d === 'D8')), K.list.map((x) => `${x.id}:${x.status}`).join(' '));
  const p = K.policies.find((x) => x.applied && x.status === 'applied'), env = p.lever.startsWith('envComp.') ? p.lever.split('.')[1] : null; const val = () => (env ? !!s.qpolicy.envComp[env] : s.mode[p.lever]), v = val();   // 환경 인터록 정책은 mode 값이 아니라 qpolicy.envComp
  check('정책 되돌리기', K.revert(p.id) && val() === p.from && p.status === 'reverted', `${p.lever} ${v} → ${val()}`);
}
console.log('== 내려받기 (AI 원인 분석 데이터)');
{ const c = T.cases[0], files = caseFiles(T, c, iso), by = Object.fromEntries(files.map((f) => [f.path, f.data]));
  let ok = true; for (const f of files) if (/\.json(ld)?$/.test(f.path)) try { JSON.parse(f.data); } catch { ok = false; }
  check('사례 묶음 11개 파일 · JSON 모두 파싱', files.length === 11 && ok, files.map((f) => f.path).join(' '));
  const E = JSON.parse(by['epcis_events.jsonld']), ev = E.epcisBody.eventList;
  check('EPCIS 2.0: @context · ObjectEvent · CBV bizStep · NG disposition non_conformant · sensorElementList', E.schemaVersion === '2.0' && E['@context'][0].includes('epcis-context') && ev.every((e) => e.type === 'ObjectEvent' && e.bizStep.startsWith('https://ref.gs1.org/cbv/BizStep-')) && ev.some((e) => e.disposition.endsWith('non_conformant')) && ev.some((e) => e.sensorElementList?.[0]?.sensorReport?.length >= 4), `이벤트 ${ev.length}개`);
  const G = JSON.parse(by['genealogy_isa95.json']);
  check('ISA-95 계보: 공정 구간마다 Equipment · Material Actual · 측정값 · 환경', G.segments.length >= 3 && G.segments.every((x) => x.equipmentActual.length && x.materialActual.length && x.environment));
  const rows = by['features.csv'].split('\n'), head = rows[0].split(',');
  check('특징 표: 제품 1행 · label_ng · label_root_cause_station · 셀별 특징', head.includes('label_ng') && head.includes('label_root_cause_station') && head.includes('SORT_health') && rows.length > 80 && rows.slice(1).some((r) => r.split(',')[head.indexOf('label_ng')] === '1'), `${rows.length - 1}행 · ${head.length}열`);
  check('사례 JSON에는 정답 라벨(불량이 생긴 셀)이 없음 (특징 표에만)', !/"defect":true|"truth":"/.test(by['case.json']));
  const z1 = zipStore(files), z2 = zipStore(allFiles(T, iso));
  check('zip 생성 (사례 · 전체)', z1.length > 1000 && z2.length > z1.length && z1[0] === 0x50 && z1[1] === 0x4b, `${(z1.length / 1024).toFixed(0)}KB · ${(z2.length / 1024).toFixed(0)}KB`);
}
console.log('== 환경 모델 · 난수 흐름');
{ check('공장 환경 이상(공조·진동·분진) 발생·기록', T.env.excLog.length > 0 && T.env.series.length > 600, T.env.excLog.map((e) => e.kind).join(' '));
  // 환경 모델·추적은 시뮬레이션 난수(sim.rand)를 쓰지 않는다: 같은 시드 두 벌에서 한쪽 환경을 끊임없이 흔들어도 투입 순서·셀 고장 시각이 같다
  const a = new Simulation('smart', 9, { line: zoneLine(), quiet: true }), b = new Simulation('smart', 9, { line: zoneLine(), quiet: true });
  for (let t = 0; t < 600; t += 0.1) { a.step(0.1); b.step(0.1); for (let k = 0; k < 3; k++) b.trace.env.r(); }
  check('환경 난수는 생산 난수와 분리 (같은 시드 → 같은 투입·고장)', a.stats.released === b.stats.released && a.stats.failures === b.stats.failures && a.rand() === b.rand(), `투입 ${a.stats.released}/${b.stats.released}`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
