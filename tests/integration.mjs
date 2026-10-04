// 기능 간 연동 검증 — 최근 추가된 기능(CCTV 에이전트 · Private 5G · 배터리 · Odoo ERP · 패킷/데이터)이
// 기존 기능(진화 컨셉 · 오케스트레이터 · Claude 에이전트 스냅샷 · AAS 데이터 연동 · 설비 현황판 · AIOS 운영 데이터)과 이어져 있는지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { DataHub } from '../js/datahub.js';
import { equipmentList } from '../js/assets.js';
import { LLMController } from '../js/llm.js';
import { renderConcept } from '../js/concept.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), hub = new DataHub();
hub.reset(s, null);
const run = (sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); } };
run(1800);
const st = s.processing.find((x) => x.id === 'EA_FAST'); s.injectFault(st); run(240);
s.disruptSupply?.(300); run(400);

console.log('== 진화 컨셉');
{ const el = { innerHTML: '' }; renderConcept(el, { current: 'dark', res: null, lineName: '정밀조립Zone', busy: false });
  const h = el.innerHTML;
  check('진화 컨셉에 현장 감시(CCTV) · 통신망(5G) · ERP · 입고·창고 · 이동 로봇 에너지 단계 비교', ['현장 감시 (CCTV)', 'CCTV 에이전트', '통신망', 'Private 5G', 'ERP (업무 기록)', 'Odoo', '입고·창고', '이동 로봇 에너지', '패킷 덤프'].every((k) => h.includes(k))); }

console.log('== 오케스트레이터 ↔ ERP(Odoo)');
{ const inc = s.orch.incidents.find((i) => i.key === `fail:${st.id}`);
  check('설비 고장 인시던트 타임라인에 Odoo 긴급 정비요청 번호', !!inc?.erp && inc.steps.some((x) => /ERP\(Odoo\) (긴급 정비요청|정비요청 .* 긴급으로 전환)/.test(x.text)), inc?.erp ?? '없음');
  const mr = s.erp.db.mr.find((m) => m.ref === inc?.erp);
  check('정비요청에 인시던트 번호 · 수리 완료 시 타임라인에 완료 기록', mr?.incident === inc?.id && (mr.stage !== 'done' || inc.steps.some((x) => x.text.includes(`${mr.ref} 완료`)) || inc.status !== 'open'), mr ? `${mr.ref} ${mr.stage}` : '');
  const sup = s.orch.incidents.find((i) => i.key === 'supply');
  check('자재 공급 차질 인시던트 기간에 발주가 나면 구매오더 번호 기록 (또는 차질 중 발주 없음)', !sup || sup.steps.some((x) => /ERP\(Odoo\) 구매오더 P\d{5}/.test(x.text)) || !s.erp.db.po.some((p) => p.date_order >= sup.t0 && p.date_order <= (sup.tEnd ?? s.time)), sup ? `인시던트 #${sup.id}` : '차질 없음'); }

console.log('== Claude 에이전트 스냅샷');
{ const L = new LLMController(); L.reset?.(s, ag); L.sim = s; L.agent = ag;
  const snap = L.snapshot();
  check('스냅샷에 cctv · network_5g · low_battery · erp', snap.cctv?.cameras > 0 && snap.network_5g?.cells > 0 && Array.isArray(snap.low_battery) && snap.erp && 'maintenance_requests_open' in snap.erp, `CCTV ${snap.cctv?.cameras} · gNB ${snap.network_5g?.cells} · 단말 ${snap.network_5g?.ues} · 진행 중 정비요청 ${snap.erp?.maintenance_requests_open.length}`);
  check('5G 스냅샷 값이 실제 망 상태와 같음 (유실·링크 실패)', snap.network_5g.uplink_lost === s.net.summary().lost && snap.network_5g.rlf === s.net.stats.rlf); }

console.log('== AAS 데이터 연동 · 설비 현황판 · AIOS');
{ hub.reset(s, null);
  const g = hub.assets.filter((a) => a.kind === 'Gnb5G'), amr = hub.assets.find((a) => a.kind === 'AMR'), ammr = hub.assets.find((a) => a.kind === 'CellRobot' && a.fields.some((f) => f.idShort === 'PlatformPhase'));
  check('AAS 자산: 5G 기지국(gNB) · PCI', g.length === s.net.plan.cells.length && g.every((a) => a.tech.PCI != null), `${g.length}개`);
  const fn = (a) => a.fields.map((f) => f.idShort);
  check('이동 로봇 AAS 필드: 배터리 · 5G 서빙 PCI · RSRP · 핸드오버', ['Battery', 'ServingPCI', 'RSRP', 'Handovers'].every((k) => fn(amr).includes(k)) && amr.fields.find((f) => f.idShort === 'ServingPCI').get() === s.net.ueOf(amr.mover).servCell.pci);
  // 셀 로봇 자산은 3D 로봇 모델(관절)이 있어야 만들어진다 — 헤드리스에서는 없음, 앱에서 확인 (README)
  if (ammr) check('AMMR(셀 로봇) AAS 필드: 배터리', fn(ammr).includes('Battery') && ammr.fields.find((f) => f.idShort === 'Battery').get() > 0);
  const L = equipmentList(s);
  check('설비 현황판에 5G 기지국 (통신)', L.filter((e) => e.group === '통신').length === s.net.plan.cells.length);
  const x = s.aios.snapshot();
  check('AIOS 운영 데이터 특징: AMR 배터리 · 5G 핸드오버·유실 · CCTV 이벤트 · ERP 구매오더·정비요청', ['amr_battery_min', 'net_ho', 'net_lost', 'cctv_open', 'erp_po_open', 'erp_mr_open'].every((k) => x[k] != null), `AMR 최저 ${x.amr_battery_min}% · 핸드오버 ${x.net_ho} · 정비요청 진행 ${x.erp_mr_open}`); }

{ const t = new Simulation('traditional', 2, { line: zoneLine(), quiet: true }), L = new LLMController(); L.sim = t; L.agent = new FactoryAgent(t);
  const snap = L.snapshot();
  check('레거시: 5G·ERP 없음 (스냅샷 null · 현황판 통신 없음)', snap.network_5g === null && snap.erp === null && !equipmentList(t).some((e) => e.group === '통신')); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
