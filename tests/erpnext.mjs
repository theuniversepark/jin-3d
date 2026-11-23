// ERPNext 연동 검증 (server/erpnext-bridge.mjs) — 실제 ERPNext v16에서 확인한 응답 꼴을 흉내 낸 가짜 Frappe 서버로:
// 「ERPNext 준비」(초기 설정 · mf_ref 필드 · 품목 · 창고 · 거래처 · BOM · 설비 자산 분류 · 정비팀), FAC 이벤트 → 문서 대응(구매오더 → 입고 · 재고 이동 · 생산 입고(작업지시 배분) ·
// 출하 · 작업지시 · 긴급 수리 · 예방정비 기록), 다시 보내도 한 번만(mf_ref), 완제품 재고 = FAC 구분 적재장, ERPNext가 꺼지면 대기 → 다시 연결되면 전송,
// 검증 오류 전표는 건너뛰고 사유, 오더 종료 때 계획보다 적게 만든 작업지시 중지, 키는 응답에 나오지 않음. 실행: npm test
// 공장 오더(order.assign · order.close)는 공장 오케스트레이터(FacOS)가 내는 이벤트 — FacOS가 없으면 같은 꼴의 오더 둘을 시험에서 넣는다 (sim.fac.order)
// 품질 절은 정밀조립 제품만 (상위 meta-factory 시험의 유연생산 후드 샘플 → e-axle) · 샘플 창고 = 샘플재검-보류
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { FAC_PRODUCTS } from '../js/fac.js';
import { makeErpBridge, BOMS, WH_NAME } from '../server/erpnext-bridge.mjs';
import { ssccOf } from '../js/serial.js';
import { ssccEpc } from '../js/epcis.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 ERPNext (Frappe REST) ─────────────────
const db = {}, seq = {}, F = { setup: 0, auth: null, reject: null, calls: 0 };
const PREFIX = { 'Quality Inspection': 'MAT-QA', 'Non Conformance': 'QA-NC', 'Quality Action': 'QA-ACT', 'Purchase Order': 'PUR-ORD', 'Purchase Receipt': 'MAT-PRE', 'Stock Entry': 'MAT-STE', 'Delivery Note': 'MAT-DN', 'Work Order': 'MFG-WO', BOM: 'BOM', Asset: 'ACC-ASS', 'Asset Repair': 'ACC-ASR', 'Asset Maintenance Log': 'ACC-AML' };
const coll = (dt) => (db[dt] ??= []);
const put = (dt, doc) => {
  const nameKey = { Item: 'item_code', 'Item Group': 'item_group_name', Supplier: 'supplier_name', Customer: 'customer_name', Workstation: 'workstation_name', Location: 'location_name', 'Asset Category': 'asset_category_name', 'Quality Procedure': 'quality_procedure_name', 'Quality Inspection Parameter': 'parameter', 'Asset Maintenance Team': 'maintenance_team_name', User: 'email' }[dt];
  const name = PREFIX[dt] ? `${PREFIX[dt]}-${String((seq[dt] = (seq[dt] ?? 0) + 1)).padStart(5, '0')}` : dt === 'Warehouse' ? `${doc.warehouse_name} - JM` : dt === 'Custom Field' ? `${doc.dt}-${doc.fieldname}` : dt === 'Asset Maintenance' ? doc.asset_name : doc[nameKey] ?? `${dt}-${coll(dt).length + 1}`;
  const d = { ...doc, name, doctype: dt, docstatus: doc.docstatus ?? 0 }; coll(dt).push(d); return d;
};
const match = (d, [f, op, v]) => op === '=' ? String(d[f] ?? '') === String(v) : op === 'like' ? new RegExp(`^${String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`).test(String(d[f] ?? '')) : op === 'in' ? v.includes(d[f]) : op === 'not in' ? !v.includes(d[f]) : true;
function seed() {
  for (const k of Object.keys(db)) delete db[k];
  put('Territory', { name: 'Korea, Republic of', is_group: 0 }).name = 'Korea, Republic of';
  coll('Customer Group').push({ name: 'All Customer Groups', is_group: 1 }, { name: 'Commercial', is_group: 0 }); coll('Supplier Group').push({ name: 'All Supplier Groups', is_group: 1 }, { name: 'Services', is_group: 0 });
}
const ERR = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ exc_type: 'ValidationError', _server_messages: JSON.stringify([JSON.stringify({ message: msg })]) })); };
const OK = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const handler = (req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  F.calls++; F.auth = req.headers.authorization; const u = new URL(req.url, 'http://x'), body = b ? JSON.parse(b) : {};
  if (!/^token \w+:\w+$/.test(F.auth ?? '')) return ERR(res, 401, '인증 실패');
  const m = u.pathname.match(/^\/api\/method\/(.+)$/);
  if (m) {
    const fn = m[1];
    if (fn === 'frappe.auth.get_logged_user') return OK(res, { message: 'Administrator' });
    if (fn === 'frappe.client.get_single_value') return OK(res, { message: F.setup });
    if (fn.endsWith('setup_wizard.setup_complete')) {
      F.setup = 1; coll('Company').push({ name: body.args.company_name, abbr: body.args.company_abbr }); put('Warehouse', { warehouse_name: 'All Warehouses', is_group: 1 }); put('User', { email: body.args.email, user_type: 'System User', enabled: 1 });
      for (const [n, t] of [['Plants and Machineries - JM', 'Fixed Asset'], ['Accumulated Depreciation - JM', 'Accumulated Depreciation'], ['Depreciation - JM', 'Depreciation']]) coll('Account').push({ name: n, account_type: t, company: body.args.company_name, is_group: 0 });
      return OK(res, { message: { status: 'ok' } });
    }
    if (fn === 'frappe.client.submit') { const d = coll(body.doc.doctype).find((x) => x.name === body.doc.name); Object.assign(d, body.doc, { docstatus: 1 }); afterSubmit(d); return OK(res, { message: d }); }
    if (fn.endsWith('make_purchase_receipt')) { const po = coll('Purchase Order').find((x) => x.name === body.source_name); return OK(res, { message: { doctype: 'Purchase Receipt', supplier: po.supplier, company: po.company, items: po.items.map((i) => ({ ...i, purchase_order: po.name })) } }); }
    if (fn.endsWith('work_order.make_stock_entry')) { const wo = coll('Work Order').find((x) => x.name === body.work_order_id), bom = coll('BOM').find((x) => x.name === wo.bom_no); return OK(res, { message: { doctype: 'Stock Entry', stock_entry_type: 'Manufacture', purpose: 'Manufacture', work_order: wo.name, company: wo.company, items: [...bom.items.map((i) => ({ item_code: i.item_code, qty: body.qty, s_warehouse: i.source_warehouse })), { item_code: wo.production_item, qty: body.qty, t_warehouse: wo.fg_warehouse, is_finished_item: 1 }] } }); }
    if (fn.endsWith('stop_unstop')) { const wo = coll('Work Order').find((x) => x.name === body.work_order); wo.status = body.status; return OK(res, { message: body.status }); }
    return ERR(res, 404, `없는 메서드 ${fn}`);
  }
  const r = u.pathname.match(/^\/api\/resource\/([^/]+)(?:\/(.+))?$/); if (!r) return ERR(res, 404, 'Not Found');
  const dt = decodeURIComponent(r[1]), nm = r[2] ? decodeURIComponent(r[2]) : null;
  if (req.method === 'GET' && nm) { const d = coll(dt).find((x) => x.name === nm); return d ? OK(res, { data: d }) : ERR(res, 404, `${dt} ${nm} not found`); }
  if (req.method === 'GET') { const fl = JSON.parse(u.searchParams.get('filters') ?? '[]'), fields = JSON.parse(u.searchParams.get('fields') ?? '["name"]'); return OK(res, { data: coll(dt).filter((d) => fl.every((f) => match(d, f))).map((d) => Object.fromEntries(fields.map((k) => [k, d[k]]))) }); }
  const qaStatus = (b2) => { if (dt === 'Quality Action' && Array.isArray(b2.resolutions)) b2.status = b2.resolutions.some((x) => x.status === 'Open') ? 'Open' : 'Completed'; };   // ERPNext: 해결 항목이 모두 완료면 Completed
  if (req.method === 'PUT') { qaStatus(body); let d = coll(dt).find((x) => x.name === nm); if (!d && dt.endsWith('Settings')) { d = { name: dt, doctype: dt }; coll(dt).push(d); } if (!d) return ERR(res, 404, `${dt} ${nm} not found`); Object.assign(d, body); return OK(res, { data: d }); }   // 설정 문서는 단일 문서 (항상 있음)
  if (F.reject === dt) return ERR(res, 417, `${dt} 검증 실패 (시험)`);
  if (dt === 'Quality Inspection' && coll(dt).some((x) => x.reference_name === body.reference_name && x.item_code === body.item_code)) return ERR(res, 417, `Every row of Item ${body.item_code} in Stock Entry ${body.reference_name} already has a Quality Inspection`);
  if ((dt === 'Non Conformance' || dt === 'Quality Action') && !coll('Quality Procedure').some((x) => x.name === body.procedure)) return ERR(res, 417, 'Procedure is required');
  qaStatus(body);
  if (dt === 'Asset' && !body.net_purchase_amount) return ERR(res, 417, 'Net Purchase Amount is mandatory');
  if (dt === 'Customer' && !coll('Customer Group').find((g) => g.name === body.customer_group && !g.is_group)) return ERR(res, 417, 'Cannot select a Group type Customer Group');
  if (dt === 'Asset Maintenance' && !body.maintenance_team) return ERR(res, 417, 'Maintenance Team missing');
  if (dt === 'Asset Maintenance') { const d = put(dt, body); coll('Asset Maintenance Task').push({ name: `T-${d.name}`, parent: d.name }); return OK(res, { data: d }); }
  const d = put(dt, body); if (d.docstatus === 1) afterSubmit(d); return OK(res, { data: d });
}); };
function afterSubmit(d) { if (d.doctype === 'Stock Entry' && d.work_order) { const wo = coll('Work Order').find((x) => x.name === d.work_order); wo.produced_qty = (wo.produced_qty ?? 0) + d.items.filter((i) => i.is_finished_item).reduce((a, i) => a + i.qty, 0); } }
let srv = http.createServer(handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port, URL0 = `http://127.0.0.1:${PORT}`;
seed();

console.log('== ERPNext 준비 (기준정보)');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-erp-t-')), B = makeErpBridge({ dir, interval: 100 }), q = new URLSearchParams();
const R = async (m, p, b) => (await B.route(m, `/api/erpnext/v1/${p}`, q, b ? JSON.stringify(b) : '')).body;
await R('POST', 'config', { url: URL0 + '/', apiKey: 'k1', apiSecret: 's1' });
const t1 = await R('POST', 'test');
check('연결 시험: 로그인 · 초기 설정 전 · 회사 없음', t1.ok && t1.user === 'Administrator' && !t1.setupComplete && t1.companies.length === 0 && F.auth === 'token k1:s1', JSON.stringify(t1));
await R('POST', 'prepare'); for (let i = 0; i < 100 && (await R('GET', 'status')).prepare.running; i++) await wait(50);
const P = (await R('GET', 'status')).prepare;
check('「ERPNext 준비」: 초기 설정(회사 · KRW) → mf_ref 필드 11종 · 품질 절차 3 · 검사 항목 · 품목 · 창고 · 거래처 · BOM 2 · 작업장 · 자산 분류 · 정비팀', P.ok && F.setup === 1 && coll('Custom Field').filter((c) => c.fieldname === 'mf_ref').length === 11 && coll('Quality Procedure').length === 3 && coll('Quality Inspection Parameter').length === 1 && Object.values(FAC_PRODUCTS).every((p) => coll('Item').some((i) => i.name === p.code)) && Object.values(WH_NAME).every((w) => coll('Warehouse').some((x) => x.name === `${w} - JM`)) && coll('BOM').filter((b) => b.docstatus === 1).length === Object.keys(BOMS).length && coll('Customer').length === 1 && coll('Asset Category').length === 1 && coll('Asset Maintenance Team').length === 1, `${P.step} · 요청 ${F.calls}회`);
const calls0 = F.calls; await R('POST', 'prepare'); for (let i = 0; i < 100 && (await R('GET', 'status')).prepare.running; i++) await wait(50);
check('다시 준비해도 이미 있는 것은 건너뜀 (중복 생성 없음)', coll('Item').length === Object.keys(FAC_PRODUCTS).length + 1 && coll('BOM').length === Object.keys(BOMS).length && coll('Custom Field').length === 13, `추가 요청 ${F.calls - calls0}회 · 품목 ${coll('Item').length}`);
const st0 = await R('GET', 'status');
check('키·비밀 키는 응답에 나오지 않음 (여부만)', st0.apiKey === true && st0.apiSecret === true && !JSON.stringify(st0).includes('s1') && !JSON.stringify(st0).includes('"k1"'));

console.log('== FAC 이벤트 → ERPNext 문서 (자동화 · 정밀조립 3시간)');
await R('POST', 'config', { enabled: true });
const s = new Simulation('smart', 6, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), E = s.fac, sent = [];   // 시드 6 — FacOS 오더가 5시간 안에 닫히는 시드 (8D 봉쇄 HOLD가 남은 오더는 사람 결정 전까지 열려 있다 · tests/factoryos.mjs와 같음)
let master = false; const push = () => { const ev = [...(master ? [] : [E.master]), ...E.outbox.splice(0)]; master = true; sent.push(...ev); B.enqueue(E.run, ev); };
// FacOS가 없을 때: 오더 1 = 양품 40(1시간 반이면 다 만든다 → 종료 때 그대로) · 오더 2 = 양품 2000(다 못 만든다 → 종료 때 중지)
const manual = !s.fos, O1 = { id: 'ORD-T1', target: 40, due: 5400 }, O2 = { id: 'ORD-T2', target: 2000, due: 28800 }, mix = { doortrim: 0.5, eaxle: 0.5 };
if (manual) E.order('order.assign', O1, { mix });
for (let t = 0; t < (manual ? 10800 : 18000); t += 0.1) {   // FacOS가 있으면 5시간 — 첫 오더(양품 100)가 2시간 넘어 끝난다
  s.step(0.1); ag.update(0.1); if (Math.round(t * 10) % 20 === 0) push();
  if (manual && Math.round(t * 10) === 54000) { E.closeWindow?.(); E.order('order.close', O1, { good: { ...s.stats.goodBy }, scrap: s.stats.rejected, input: s.stats.released }); E.order('order.assign', O2, { mix }); }
}
E.closeWindow?.(); if (manual) E.order('order.close', O2, { good: { ...s.stats.goodBy }, scrap: s.stats.rejected, input: s.stats.released }); push();
for (let i = 0; i < 600 && (await R('GET', 'status')).queued; i++) await wait(50);
const S1 = await R('GET', 'status'), ty = (t) => sent.filter((e) => e.type === t);
const ref = (dt) => coll(dt).filter((d) => String(d.mf_ref ?? '').startsWith(E.run));
check('보낸 전표 = FAC 이벤트 (건너뜀 0)', S1.queued === 0 && S1.skipped === 0 && S1.sent === sent.filter((e) => e.type !== 'master').length, `보냄 ${S1.sent}`);
check('구매오더 → Purchase Order · 입고 → Purchase Receipt(구매오더 연결) · 모두 제출', ref('Purchase Order').length === ty('po.create').length && ref('Purchase Receipt').length === ty('receipt.done').length && ref('Purchase Receipt').every((d) => d.docstatus === 1 && d.items.every((i) => i.purchase_order)), `PO ${ref('Purchase Order').length} · PR ${ref('Purchase Receipt').length}`);
const mt = ref('Stock Entry').filter((d) => d.stock_entry_type === 'Material Transfer' && d.mf_ref.includes('/INT/')), qmv = ref('Stock Entry').filter((d) => d.stock_entry_type === 'Material Transfer' && !d.mf_ref.includes('/INT/')), mf = ref('Stock Entry').filter((d) => d.stock_entry_type === 'Manufacture');
check('내부 이동 → Stock Entry(Material Transfer) · 생산 입고 → Stock Entry(Manufacture, BOM 소비 + 완제품)', mt.length === ty('internal.done').length && mf.length >= ty('production.done').length && mf.every((d) => d.items.filter((i) => i.is_finished_item).length === 1 && d.items.filter((i) => i.s_warehouse).length === 2), `이동 ${mt.length} · 생산 ${mf.length}`);
check('출하 전 샘플 재검(시뮬레이션이 낸 q.sample.req · q.sample) → 샘플 재검 보류 창고 이동 · 품질검사', ty('q.sample.req').length > 0 && qmv.filter((d) => d.mf_ref.endsWith(':out')).length === ty('q.sample.req').length && ref('Quality Inspection').length === ty('q.sample').length, `샘플 ${ty('q.sample.req').length} · 판정 ${ty('q.sample').length} · 품질검사 ${ref('Quality Inspection').length}`);
const wos = ref('Work Order'), orders = ty('order.assign').length;
check('공장 오더 → 제품별 Work Order (도어트림 · e-axle) · 생산 입고가 작업지시에 배분', orders > 0 && wos.length === orders * 2 && mf.filter((d) => d.work_order).length > 0 && wos.every((w) => w.bom_no && w.skip_transfer === 1), `오더 ${orders} · 작업지시 ${wos.length} · 작업지시 생산 입고 ${mf.filter((d) => d.work_order).length}`);
const closed = ty('order.close').map((e) => e.key), cw = wos.filter((w) => closed.some((k) => w.mf_ref.endsWith(`:${k}:doortrim`) || w.mf_ref.endsWith(`:${k}:eaxle`)));
check('오더 종료: 계획보다 적게 만든 작업지시는 중지(Stopped), 다 만든 것은 그대로', closed.length > 0 && cw.every((w) => (w.produced_qty ?? 0) >= w.qty ? w.status !== 'Stopped' : w.status === 'Stopped'), cw.map((w) => `${w.production_item} ${w.produced_qty}/${w.qty} ${w.status ?? ''}`).join(' · '));
check('출고 → Delivery Note (구분 적재장)', ref('Delivery Note').length === ty('delivery.done').length && ref('Delivery Note').every((d) => d.items.every((i) => i.warehouse === '구분적재장 - JM')), `${ref('Delivery Note').length}건`);
const fg = (code) => mf.flatMap((d) => d.items).filter((i) => i.is_finished_item && i.item_code === code).reduce((a, i) => a + i.qty, 0) - ref('Delivery Note').flatMap((d) => d.items).filter((i) => i.item_code === code).reduce((a, i) => a + i.qty, 0);
check('완제품 재고 (생산 입고 − 출하) = FAC 구분 적재장', ['doortrim', 'eaxle'].every((p) => fg(FAC_PRODUCTS[p].code) === E.quant.output[p]), ['doortrim', 'eaxle'].map((p) => `${p} ${fg(FAC_PRODUCTS[p].code)}/${E.quant.output[p]}`).join(' · '));
const cor = ty('mr.create').filter((e) => e.mtype === 'corrective').length, pre = ty('mr.create').filter((e) => e.mtype !== 'corrective').length;
check('정비요청: 설비 → Asset(처음이면 등록) · 긴급 → Asset Repair · 예방 → Asset Maintenance Log · 완료 단계 반영', ref('Asset Repair').length + coll('Asset Repair').filter((d) => !d.mf_ref.startsWith(E.run)).length >= cor && ref('Asset Maintenance Log').length === pre && coll('Asset').length > 0 && coll('Asset').every((a) => a.net_purchase_amount && a.docstatus === 1) && ref('Asset Maintenance Log').filter((d) => d.maintenance_status === 'Completed').length > 0, `설비 자산 ${coll('Asset').length} · 긴급 ${ref('Asset Repair').length} · 예방 ${ref('Asset Maintenance Log').length} (완료 ${ref('Asset Maintenance Log').filter((d) => d.maintenance_status === 'Completed').length})`);

console.log('== 품질: 출하 전 샘플 재검 · 처분(MRB) · 체결 NG · 8D');
{ const run = 'runQ', Q = (evs) => B.enqueue(run, evs), drain = async () => { for (let i = 0; i < 300 && (await R('GET', 'status')).queued; i++) await wait(50); };
  Q([{ type: 'q.sample.req', key: 'QS-1', zone: 'main', product: 'doortrim', serial: 'DT-1' }, { type: 'q.sample', key: 'QS-1', zone: 'main', product: 'doortrim', serial: 'DT-1', result: 'OK', lot: 4 },
     { type: 'q.sample.req', key: 'QS-2', zone: 'main', product: 'eaxle', serial: 'EA-9' }, { type: 'q.sample', key: 'QS-2', zone: 'main', product: 'eaxle', serial: 'EA-9', result: 'NG', lot: 10 }]);
  await drain();
  const qi = coll('Quality Inspection').filter((d) => d.mf_ref?.startsWith(run)), mv = (k) => coll('Stock Entry').find((d) => d.mf_ref === `${run}:${k}`);
  check('샘플 지정 → 샘플 재검 보류 창고 이동 · 품질검사(제출 · 그 이동 전표에 연결) · OK면 적재장으로 되돌림', qi.length === 2 && qi.every((d) => d.docstatus === 1 && d.reference_type === 'Stock Entry') && qi.find((d) => d.mf_ref === `${run}:QS-1`).status === 'Accepted' && qi.find((d) => d.mf_ref === `${run}:QS-2`).status === 'Rejected' && mv('QS-1:out')?.items[0].t_warehouse === '샘플재검-보류 - JM' && mv('QS-1:back')?.items[0].t_warehouse === '구분적재장 - JM' && !mv('QS-2:back'), qi.map((d) => `${d.mf_ref.split(':')[1]} ${d.status} ← ${d.reference_name}`).join(' · '));
  const nc = coll('Non Conformance').find((d) => d.mf_ref === `${run}:QS-2`), mrb = () => coll('Quality Action').find((d) => d.mf_ref === `${run}:QS-2:mrb`);
  check('샘플 NG → 부적합(Open · 샘플링 절차) + 처분 판정(MRB) 품질 조치', nc?.status === 'Open' && nc.procedure.startsWith('출하 전 샘플 재검') && mrb()?.procedure.startsWith('부적합품 처리'));
  Q([{ type: 'q.disp', key: 'EA-9', lot: 'QS-2', zone: 'main', product: 'eaxle', d: 'rework', why: '샘플 — 분해·부품 교체', sample: true }, { type: 'q.disp', key: 'EA-5', lot: 'QS-2', zone: 'main', product: 'eaxle', d: 'scrap', why: '선별검사 — 유출 불량 회수 (격리)', sample: false }]);
  await drain();
  check('처분: 재작업 → 미완료 항목(품질 조치 Open) · 폐기 → 재고 출고(Material Issue, 구분 적재장)', mrb().status === 'Open' && mrb().resolutions.some((x) => x.problem === 'EA-9 처분' && x.status === 'Open') && coll('Stock Entry').find((d) => d.mf_ref === `${run}:EA-5:scrap`)?.stock_entry_type === 'Material Issue');
  Q([{ type: 'q.lot', key: 'QS-2', zone: 'main', product: 'eaxle', sorted: { n: 12, ok: 10, bad: 2 }, extra: 3, recall: 1 }, { type: 'q.disp', key: 'EA-9', lot: 'QS-2', zone: 'main', product: 'eaxle', d: 'rework.done', why: '재검 합격', sample: true }]);
  await drain();
  check('로트 선별검사 끝 → 부적합 Resolved · 재작업 재검 합격 → 샘플 적재장 복귀 · MRB 품질 조치 Completed', nc.status === 'Resolved' && /선별검사 12개/.test(nc.corrective_action) && mv('EA-9:back')?.items[0].s_warehouse === '샘플재검-보류 - JM' && mrb().status === 'Completed', `MRB 항목 ${mrb().resolutions.length}`);
  Q([{ type: 'q.ng', key: 'NG-1', serial: 'WIP-EA-1', product: 'eaxle', station: 'e-axle 체결셀', mode: '체결 토크 하한 미달', torque: 74, angle: 41 },
     { type: 'q.capa', key: 'CAPA-1', kind: 'main', title: 'e-axle 체결셀 NG', status: 'approval', stage: 'D5', cases: ['NG-1'], steps: [{ d: 'D0', lane: 'field', text: 'NG 판정' }, { d: 'D5', lane: 'zone', text: '대책 선정' }] }]);
  await drain();
  const qa = () => coll('Quality Action').find((d) => d.mf_ref === `${run}:CAPA-1`), ncg = coll('Non Conformance').find((d) => d.mf_ref === `${run}:NG-1`);
  check('체결 NG → 부적합(8D 절차) · 진행 중 8D → 품질 조치 Open (현재 단계 미완료 항목)', ncg?.status === 'Open' && ncg.procedure.startsWith('8D') && qa()?.status === 'Open' && qa().resolutions.at(-1).problem.startsWith('진행 중'), qa()?.resolutions.map((x) => x.problem).join(' / '));
  Q([{ type: 'q.capa', key: 'CAPA-1', kind: 'main', title: 'e-axle 체결셀 NG', status: 'closed', stage: 'D8', cases: ['NG-1'], steps: [{ d: 'D0', lane: 'field', text: 'NG 판정' }, { d: 'D5', lane: 'zone', text: '대책 선정' }, { d: 'D8', lane: 'hq', text: '종결' }] }]);
  await drain();
  check('8D 종결 → 품질 조치 Completed(D0~D8 덮어쓰기) · 그 사례 부적합 Resolved', qa().status === 'Completed' && qa().resolutions.length === 3 && ncg.status === 'Resolved');
}

console.log('== 중복 방지 · 끊김 · 검증 오류');
{ const before = Object.fromEntries(Object.entries(db).map(([k, v]) => [k, v.length]));
  B.enqueue(E.run, sent.filter((e) => e.type !== 'master'));   // 같은 이벤트를 다시
  for (let i = 0; i < 600 && (await R('GET', 'status')).queued; i++) await wait(50);
  check('같은 FAC 이벤트를 다시 보내도 문서는 한 번만 (mf_ref)', ['Purchase Order', 'Purchase Receipt', 'Stock Entry', 'Delivery Note', 'Work Order', 'Asset Repair', 'Asset Maintenance Log'].every((k) => (db[k]?.length ?? 0) === (before[k] ?? 0)), Object.keys(db).filter((k) => (db[k]?.length ?? 0) !== (before[k] ?? 0)).map((k) => `${k} ${before[k]}→${db[k].length}`).join(' · '));
  await new Promise((r) => srv.close(r)); srv.closeAllConnections?.();
  B.enqueue(E.run, [{ type: 'internal.done', key: 'WH/INT/T0001', origin: '시험', lines: [{ product: 'raw', qty: 5, from: 'rackRaw', to: 'feeder' }] }]);
  await wait(800);
  const d1 = await R('GET', 'status');
  srv = http.createServer(handler); await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  for (let i = 0; i < 300 && (await R('GET', 'status')).queued; i++) await wait(100);
  const d2 = await R('GET', 'status');
  check('ERPNext가 꺼지면 대기 · 사유 → 다시 켜지면 전송', d1.queued === 1 && /연결 거부/.test(d1.lastError ?? '') && d2.queued === 0 && coll('Stock Entry').some((x) => x.mf_ref === `${E.run}:WH/INT/T0001`), `끊김: 대기 ${d1.queued} · ${d1.lastError}`);
  F.reject = 'Delivery Note';
  B.enqueue(E.run, [{ type: 'delivery.done', key: 'WH/OUT/T0001', origin: '출하 시험트럭', lines: [{ product: 'doortrim', qty: 8 }] }, { type: 'internal.done', key: 'WH/INT/T0002', origin: '시험', lines: [{ product: 'raw', qty: 2, from: 'rackRaw', to: 'feeder' }] }]);
  for (let i = 0; i < 100 && (await R('GET', 'status')).queued; i++) await wait(50);
  const d3 = await R('GET', 'status'); F.reject = null;
  check('검증 오류(417) 전표는 건너뛰고 사유 기록 → 다음 전표는 계속', d3.skipped === 1 && /Delivery Note 검증 실패/.test(d3.failures[0]?.error ?? '') && coll('Stock Entry').some((x) => x.mf_ref === `${E.run}:WH/INT/T0002`), d3.failures[0]?.error);
}
B.close();
console.log('== 다시 켜기 (설정 · 준비 상태 · 보낸 위치 기억)');
{ const B2 = makeErpBridge({ dir, interval: 100 }), s2 = (await B2.route('GET', '/api/erpnext/v1/status', q, '')).body;
  check('앱을 다시 켜도 준비 완료 · 연동 켜짐 · 대기 0 (보낸 것을 다시 보내지 않음)', !!s2.prepared && s2.enabled && s2.queued === 0 && s2.apiKey && s2.workOrders.length > 0);
  B2.close(); }
console.log('== 출하 전표에 시리얼 (선택 · EPCIS 저장소 트럭 리콜 범위)');
{ const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-erp-s-')), sscc = ssccOf(8), serial = 'urn:epc:id:sgtin:8800000.000001.DT-261022-000123';
  for (const f of ['state.json', 'config.json']) fs.copyFileSync(path.join(dir, f), path.join(d4, f));   // 준비 완료 상태 · 설정 그대로 (주소를 바꾸면 준비를 다시 해야 한다)
  const B4 = makeErpBridge({ dir: d4, interval: 100, serialsOf: (truck) => (truck === '화물트럭-9' ? { pallets: [ssccEpc(sscc)], serials: [serial] } : null) });
  await B4.route('POST', '/api/erpnext/v1/config', q, JSON.stringify({ enabled: true, serials: true }));
  B4.enqueue('runS', [{ type: 'delivery.done', key: 'WH/OUT/S0001', origin: '출하 화물트럭-9', lines: [{ product: 'doortrim', qty: 8 }] }]);
  for (let i = 0; i < 100 && (await B4.route('GET', '/api/erpnext/v1/status', q, '')).body.queued; i++) await wait(50);
  const dn = coll('Delivery Note').find((x) => x.mf_ref === 'runS:WH/OUT/S0001');
  check('출하 전표: 트럭 · 팔레트 SSCC(18자리, 검사 숫자) · 시리얼 목록', dn?.mf_shipment === `화물트럭-9 · SSCC (00)${sscc}` && dn.mf_serials === 'DT-261022-000123', `${dn?.mf_shipment} · ${dn?.mf_serials}`);
  B4.close(); fs.rmSync(d4, { recursive: true, force: true }); }
srv.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
