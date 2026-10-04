// Odoo ERP 연동 (ISA-95 레벨 4) — 1순위: 발주(Purchase) · 재고(Inventory) · 설비보전(Maintenance)
// 공장 운영(FACOS, 레벨 3)은 실시간 판단·제어를 그대로 하고, ERP 기록은 Odoo 데이터 모델로 남긴다.
//  · 발주: WMS가 재주문점 아래에서 트럭 1대분을 발주하면 구매오더(purchase.order, P0000n)를 만들고 확정 → 입고(WH/IN) 예정
//          트럭 하차 팔레트마다 입고 수량, 트럭이 떠나면 입고 확정(검수 완료) → 물류 선반 재고 증가
//  · 재고: 제품(product.product) 4종 · 로케이션(stock.location) — 물류 선반 원자재·부품, 라인 투입구·셀, 구분 적재장
//          AGV 출고(선반 → 투입구) · 휴머노이드 부품 출고(선반 → 셀)는 내부 이동(WH/INT), 생산 완료는 생산 입고(가상 → 구분 적재장),
//          출하 지게차 상차는 출고(WH/OUT, 트럭이 떠나면 확정). 내부 이동·생산은 10분(공장 시계)마다 한 전표로 묶는다
//          재주문 규칙(stock.warehouse.orderpoint)은 WMS 재주문점·목표와 같은 값
//  · 설비보전: 셀·셀 로봇·이동 로봇을 설비(maintenance.equipment, 일련번호 = 설비 고유 ID)로 등록하고,
//          설비 고장 → 긴급 정비요청(corrective), 예지·예방 정비 지시 → 예방 정비요청(preventive),
//          정비 인력 배정 → 진행 중, 수리·정비 완료 → 완료(소요 시간 기록)
// 두 가지 모드: ① 시뮬레이션 Odoo(내장 — 같은 모델·전표 번호·상태로 기록, 서버 없이 동작)
//              ② 실시간 Odoo(서버 /api/odoo/sync → server/odoo-gateway.mjs가 JSON-RPC로 실제 Odoo에 생성·확정)
// 렌더링과 분리되어 헤드리스 시뮬레이션에서도 같은 흐름으로 동작한다 (tests/odoo.mjs).
import { WH } from './receiving.js';

export const ODOO_PRODUCTS = {
  raw: { code: 'RM-BOX', name: '원자재 박스 (도어트림·e-axle 공용)', price: 12000 },
  parts: { code: 'PT-KIT', name: '조립 부품 (클립·볼트·스피커그릴 키트)', price: 800 },
  doortrim: { code: 'FG-DT', name: '도어트림 (완제품)', price: 185000 },
  eaxle: { code: 'FG-EA', name: 'e-axle (완제품)', price: 2400000 },
};
export const ODOO_LOCS = {
  vendor: { name: 'Partners/Vendors', usage: 'supplier' },
  customer: { name: 'Partners/Customers', usage: 'customer' },
  production: { name: 'Virtual Locations/Production', usage: 'production' },
  rackRaw: { name: 'WH/Stock/물류선반-원자재', usage: 'internal' },
  rackParts: { name: 'WH/Stock/물류선반-부품', usage: 'internal' },
  feeder: { name: 'WH/Line/투입구', usage: 'internal' },
  cells: { name: 'WH/Line/셀', usage: 'internal' },
  output: { name: 'WH/Output/구분적재장', usage: 'internal' },
};
export const SUPPLIER = '공급사 (원자재·부품)', CUSTOMER = '완성차 고객사 (서연인테크 · 쉐플러코리아)';
const WINDOW = 600;   // 내부 이동·생산 입고 묶음 (공장 시계 초)

export class OdooBridge {
  constructor(sim) {
    this.sim = sim; this.on = sim.mode.key !== 'traditional' && !sim.twin;
    this.live = false;                       // 실시간 Odoo로도 보내기 (서버 연결 시 화면에서 켬)
    this.outbox = []; this.sent = 0;         // 실시간 Odoo로 보낼 이벤트
    this.seq = { po: 0, in: 0, int: 0, out: 0, mrp: 0, mr: 0 };
    this.db = { po: [], picking: [], mr: [], equipment: [] };
    this.quant = Object.fromEntries(Object.keys(ODOO_LOCS).map((k) => [k, { raw: 0, parts: 0, doortrim: 0, eaxle: 0 }]));
    this.byOrder = new Map(); this.byTruck = new Map(); this.byShip = new Map(); this.byStation = new Map();
    this.win = null; this.good = { doortrim: 0, eaxle: 0 }; this.log = [];
    if (!this.on) return;
    // 마스터 데이터: 제품 · 로케이션 · 거래처 · 재주문 규칙 · 설비
    this.orderpoints = [
      { product: 'raw', location: 'rackRaw', min: WH.rawReorder, max: WH.rawTarget },
      { product: 'parts', location: 'rackParts', min: WH.partsReorder, max: WH.partsTarget },
    ];
    for (const st of sim.processing) this.equip(st.uid ?? st.id, st.name, '생산 셀', st.id);
    for (const st of sim.processing) (st.robotUids ?? []).forEach((u, i) => this.equip(u, `${st.name} 로봇 #${i + 1}`, '셀 로봇', `${st.id}-${i + 1}`));
    for (const m of [...sim.carriers, ...sim.vehicles, ...(sim.forklifts ?? []), ...sim.techs.filter((t) => t.kind !== 'human'), ...sim.helpers, ...sim.quads]) this.equip(m.uid ?? m.id, m.id, m.kind === 'carrier' ? '운반 AMR' : m.kind === 'agv' ? 'AGV' : m.kind === 'forklift' ? '지게차' : m.kind === 'humanoid' ? '휴머노이드' : m.kind === 'quadruped' ? '사족보행' : '이동 로봇', m.id);
    for (const d of sim.drones ?? []) this.equip(d.uid ?? d.id, d.id, '순찰 드론', d.id);
    // 기초 재고 (재고 조정): 시작 시 물류 선반 재고
    this.quant.rackRaw.raw = sim.whRaw ?? 0; this.quant.rackParts.parts = sim.partsTracked ? sim.whParts : 0;
    this.emit({ type: 'master', products: ODOO_PRODUCTS, locations: ODOO_LOCS, supplier: SUPPLIER, customer: CUSTOMER, orderpoints: this.orderpoints, equipment: this.db.equipment.map((e) => ({ ...e })), inventory: [
      { product: 'raw', location: 'rackRaw', qty: this.quant.rackRaw.raw }, { product: 'parts', location: 'rackParts', qty: this.quant.rackParts.parts }] });
  }
  now() { return this.sim.time; }
  // 이벤트 대기열 — 마스터 데이터는 따로 두고(대기열이 넘쳐도 잃지 않게) 처음 보낼 때 맨 앞에 붙인다
  emit(ev) {
    if (!this.on) return;
    const e = { ...ev, t: Math.round(this.now() * 10) / 10 };
    if (ev.type === 'master') { this.master = e; this.masterSent = false; return; }
    this.outbox.push(e); if (this.outbox.length > 20000) this.outbox.splice(0, this.outbox.length - 20000);
  }
  pending() { return this.masterSent ? [...this.outbox] : [this.master, ...this.outbox]; }
  note(kind, text) { this.log.unshift({ t: this.now(), kind, text }); if (this.log.length > 60) this.log.pop(); }
  name(k) { this.seq[k]++; const p = { po: 'P', in: 'WH/IN/', int: 'WH/INT/', out: 'WH/OUT/', mrp: 'WH/MO/', mr: 'MR/' }[k]; return `${p}${String(this.seq[k]).padStart(5, '0')}`; }
  equip(serial, name, category, key) {
    const e = { id: this.db.equipment.length + 1, name, serial_no: serial, category, key, requests: 0, open: 0, downtime: 0 };
    this.db.equipment.push(e); return e;
  }
  equipmentOf(key) { return this.db.equipment.find((e) => e.key === key || e.serial_no === key); }
  move(lines, from, to) { for (const l of lines) { this.quant[from][l.product] -= l.qty; this.quant[to][l.product] += l.qty; } }

  // ── 발주 · 입고 ─────────────────
  // WMS 발주 (receiving.js) → 구매오더 확정 + 입고 예정 전표
  purchase(order) {
    if (!this.on) return;
    const n = { raw: order.pallets.filter((p) => p === 'raw').length, parts: order.pallets.filter((p) => p === 'parts').length };
    const lines = [];
    if (n.raw) lines.push({ product: 'raw', qty: n.raw * WH.rawPallet, price: ODOO_PRODUCTS.raw.price });
    if (n.parts) lines.push({ product: 'parts', qty: n.parts * WH.partsPallet, price: ODOO_PRODUCTS.parts.price });
    const po = { id: this.db.po.length + 1, name: this.name('po'), partner: SUPPLIER, date_order: this.now(), date_planned: order.due, state: 'purchase', lines: lines.map((l) => ({ ...l, received: 0 })), amount: lines.reduce((a, l) => a + l.qty * l.price, 0), receipt: null, truck: null };
    const pk = { id: this.db.picking.length + 1, name: this.name('in'), type: 'incoming', origin: po.name, partner: SUPPLIER, from: 'vendor', to: null, state: 'assigned', created: this.now(), done: null, lines: lines.map((l) => ({ product: l.product, qty: l.qty, done: 0, to: l.product === 'raw' ? 'rackRaw' : 'rackParts' })) };
    po.receipt = pk.name; this.db.po.unshift(po); this.db.picking.unshift(pk); this.byOrder.set(order, { po, pk });
    // 자재 공급 차질 인시던트가 열려 있으면 타임라인에 발주 번호를 남긴다
    const sup = this.sim.orch?.find('supply'); if (sup) this.sim.orch.step(sup, 'exec', 'act', `ERP(Odoo) 구매오더 ${po.name} 확정 (${lines.map((l) => `${ODOO_PRODUCTS[l.product].code} ${l.qty}`).join(' · ')}) — 납품 재개 시 입고`);
    this.emit({ type: 'po.create', key: po.name, partner: SUPPLIER, lines: lines.map(({ product, qty, price }) => ({ product, qty, price })), receipt: pk.name });
    this.note('po', `${po.name} 구매오더 확정 — ${lines.map((l) => `${ODOO_PRODUCTS[l.product].code} ${l.qty}`).join(' · ')} → 입고 예정 ${pk.name}`);
  }
  // 발주한 트럭이 출발 → 그 구매오더의 입고 전표에 트럭 연결
  dispatched(order, truck) { const r = this.byOrder.get(order); if (!r) return; r.po.truck = truck.id; r.pk.truck = truck.id; this.byTruck.set(truck, r); this.note('in', `${r.pk.name} 입고 트럭 ${truck.id} 출발 (${r.po.name})`); }
  // 하차한 팔레트 1개 → 입고 수량 (선반에 들어감)
  received(truck, type, qty) {
    const r = this.byTruck.get(truck); if (!r) return;
    const l = r.pk.lines.find((x) => x.product === type); if (l) l.done += qty;
    const pl = r.po.lines.find((x) => x.product === type); if (pl) pl.received += qty;
    if (r.departed) this.finishReceipt(r);
  }
  // 하차 완료(트럭 출차) → 마지막 팔레트가 선반에 들어가면 입고 확정 (재고 반영)
  receiptDone(truck) { const r = this.byTruck.get(truck); if (!r) return; r.departed = true; this.finishReceipt(r); }
  finishReceipt(r) {
    if (r.pk.state === 'done' || r.pk.lines.some((l) => l.done < l.qty)) return;   // 지게차가 아직 옮기는 팔레트가 있으면 기다린다
    r.pk.state = 'done'; r.pk.done = this.now();
    for (const l of r.pk.lines) this.quant[l.to][l.product] += l.done;
    r.po.received = true;
    this.emit({ type: 'receipt.done', key: r.pk.name, po: r.po.name, lines: r.pk.lines.map((l) => ({ product: l.product, qty: l.done, to: l.to })) });
    this.note('in', `${r.pk.name} 입고 확정 (검수 완료) — ${r.pk.lines.map((l) => `${ODOO_PRODUCTS[l.product].code} ${l.done}`).join(' · ')} → 물류 선반`);
  }

  // ── 내부 이동 · 생산 입고 (10분 묶음) ─────────────────
  window() {
    if (!this.win) this.win = { t0: this.now(), int: [], prod: { doortrim: 0, eaxle: 0 } };
    return this.win;
  }
  consume(type, qty, toName) {   // 선반 → 투입구(원자재) / 셀(부품)
    if (!this.on || qty <= 0) return;
    this.window().int.push({ product: type, qty, from: type === 'raw' ? 'rackRaw' : 'rackParts', to: type === 'raw' ? 'feeder' : 'cells', ref: toName });
  }
  produced(product, n = 1) { if (this.on && product) this.window().prod[product] += n; }
  closeWindow() {
    const w = this.win; if (!w) return; this.win = null;
    const agg = new Map();
    for (const m of w.int) { const k = `${m.product}|${m.from}|${m.to}`; const a = agg.get(k) ?? { product: m.product, from: m.from, to: m.to, qty: 0, n: 0 }; a.qty += m.qty; a.n++; agg.set(k, a); }
    if (agg.size) {
      const lines = [...agg.values()], pk = { id: this.db.picking.length + 1, name: this.name('int'), type: 'internal', origin: '라인 공급 (AGV·휴머노이드)', from: lines[0].from, to: lines[0].to, state: 'done', created: w.t0, done: this.now(), lines: lines.map((l) => ({ product: l.product, qty: l.qty, done: l.qty, from: l.from, to: l.to, trips: l.n })) };
      for (const l of lines) { this.quant[l.from][l.product] -= l.qty; this.quant[l.to][l.product] += l.qty; }
      this.db.picking.unshift(pk);
      this.emit({ type: 'internal.done', key: pk.name, origin: pk.origin, lines: pk.lines.map(({ product, qty, from, to }) => ({ product, qty, from, to })) });
      this.note('int', `${pk.name} 내부 이동 확정 — ${lines.map((l) => `${ODOO_PRODUCTS[l.product].code} ${l.qty} (${l.n}회)`).join(' · ')}`);
    }
    const prod = Object.entries(w.prod).filter(([, v]) => v > 0);
    if (prod.length) {
      const pk = { id: this.db.picking.length + 1, name: this.name('mrp'), type: 'production', origin: '정밀조립Zone 생산 실적', from: 'production', to: 'output', state: 'done', created: w.t0, done: this.now(), lines: prod.map(([p, q]) => ({ product: p, qty: q, done: q, from: 'production', to: 'output' })) };
      for (const [p, q] of prod) this.quant.output[p] += q;
      this.db.picking.unshift(pk);
      this.emit({ type: 'production.done', key: pk.name, lines: pk.lines.map(({ product, qty }) => ({ product, qty, from: 'production', to: 'output' })) });
      this.note('mrp', `${pk.name} 생산 입고 — ${prod.map(([p, q]) => `${ODOO_PRODUCTS[p].code} ${q}`).join(' · ')}`);
    }
  }

  // ── 출고 (출하 트럭) ─────────────────
  ship(truck, qty, product) {
    if (!this.on || qty <= 0) return;
    let pk = this.byShip.get(truck);
    if (!pk) { pk = { id: this.db.picking.length + 1, name: this.name('out'), type: 'outgoing', origin: `출하 ${truck.id}`, partner: CUSTOMER, from: 'output', to: 'customer', state: 'assigned', created: this.now(), done: null, truck: truck.id, lines: [] }; this.byShip.set(truck, pk); this.db.picking.unshift(pk); }
    const p = product ?? 'doortrim', l = pk.lines.find((x) => x.product === p) ?? (pk.lines.push({ product: p, qty: 0, done: 0, from: 'output', to: 'customer' }), pk.lines.at(-1));
    l.qty += qty; l.done += qty;
  }
  shipDone(truck) {
    const pk = this.byShip.get(truck); if (!pk || pk.state === 'done') return;
    this.closeWindow();   // 생산 입고를 먼저 확정해야 출고할 재고가 있다
    pk.state = 'done'; pk.done = this.now();
    for (const l of pk.lines) { this.quant.output[l.product] -= l.done; this.quant.customer[l.product] += l.done; }
    this.emit({ type: 'delivery.done', key: pk.name, partner: CUSTOMER, origin: pk.origin, lines: pk.lines.map(({ product, done }) => ({ product, qty: done, from: 'output', to: 'customer' })) });
    this.note('out', `${pk.name} 출고 확정 — ${pk.lines.map((l) => `${ODOO_PRODUCTS[l.product].code} ${l.done}`).join(' · ')} → ${truck.id}`);
  }

  // ── 설비보전 ─────────────────
  maintenance(st, kind, reason = '') {
    if (!this.on) return;
    const e = this.equipmentOf(st.id) ?? this.equipmentOf(st.uid); if (!e) return;
    const open = this.byStation.get(st.id);
    if (open && open.stage !== 'done') {   // 진행 중 요청이 있으면 유형만 갱신 (예방 → 긴급)
      if (kind === 'repair' && open.type !== 'corrective') {
        open.type = 'corrective'; open.name = `${st.name} 설비 고장 (예방정비 중 전환)`; this.emit({ type: 'mr.update', key: open.ref, mtype: 'corrective', name: open.name });
        const inc = this.sim.orch?.find(`fail:${st.id}`); if (inc) { open.incident = inc.id; inc.erp = open.ref; this.sim.orch.step(inc, 'orch', 'act', `ERP(Odoo) 정비요청 ${open.ref} 긴급으로 전환`); }
      }
      return;
    }
    const type = kind === 'repair' ? 'corrective' : 'preventive';
    const mr = { id: this.db.mr.length + 1, ref: this.name('mr'), name: kind === 'repair' ? `${st.name} 설비 고장` : `${st.name} ${kind === 'pm' ? '예지·예방 정비' : kind === 'cal' ? '재보정' : '정비'}`, equipment: e.serial_no, equipmentName: e.name, type, stage: 'new', request_date: this.now(), start: null, close: null, duration: 0, tech: null, description: reason || (kind === 'repair' ? `건강도 ${st.health.toFixed(0)}% · 가동 정지` : `건강도 ${st.health.toFixed(0)}% · RUL 기반 정비 지시`) };
    this.db.mr.unshift(mr); this.byStation.set(st.id, mr); e.requests++; e.open++;
    // 오케스트레이터 인시던트와 연결: 고장 인시던트 타임라인에 ERP 정비요청 번호를 남긴다
    const inc = this.sim.orch?.find(`fail:${st.id}`);
    if (inc && type === 'corrective') { mr.incident = inc.id; inc.erp = mr.ref; this.sim.orch.step(inc, 'orch', 'act', `ERP(Odoo) 긴급 정비요청 ${mr.ref} 생성 — 설비 ${e.serial_no}`); }
    this.emit({ type: 'mr.create', key: mr.ref, name: mr.name, equipment: e.serial_no, mtype: type, description: mr.description });
    this.note('mr', `${mr.ref} ${type === 'corrective' ? '긴급' : '예방'} 정비요청 — ${mr.name}`);
  }
  maintStart(st, tech) {
    const mr = this.byStation.get(st.id); if (!mr || mr.stage !== 'new') return;
    mr.stage = 'progress'; mr.start = this.now(); mr.tech = tech?.id ?? '';
    this.emit({ type: 'mr.stage', key: mr.ref, stage: 'progress', tech: mr.tech });
  }
  maintDone(st) {
    const mr = this.byStation.get(st.id); if (!mr || mr.stage === 'done') return;
    mr.stage = 'done'; mr.close = this.now(); mr.duration = (mr.close - mr.request_date) / 3600;
    const e = this.equipmentOf(mr.equipment); if (e) { e.open = Math.max(0, e.open - 1); e.downtime += mr.duration; }
    this.emit({ type: 'mr.stage', key: mr.ref, stage: 'done', duration: Math.round(mr.duration * 1000) / 1000 });
    const inc = mr.incident ? this.sim.orch?.incidents.find((i) => i.id === mr.incident) : null;
    if (inc && inc.status === 'open') this.sim.orch.step(inc, 'exec', 'act', `ERP(Odoo) 정비요청 ${mr.ref} 완료 (${Math.round(mr.duration * 60)}분)`);
    this.note('mr', `${mr.ref} 정비 완료 — ${mr.name} (${Math.round(mr.duration * 60)}분)`);
  }

  update() { if (this.on && this.win && this.now() - this.win.t0 >= WINDOW) this.closeWindow(); }
  stats() {
    const P = this.db.picking;
    return { po: this.db.po.length, poOpen: this.db.po.filter((p) => !p.received).length, amount: this.db.po.reduce((a, p) => a + p.amount, 0),
      receipts: P.filter((p) => p.type === 'incoming' && p.state === 'done').length, internals: P.filter((p) => p.type === 'internal').length,
      deliveries: P.filter((p) => p.type === 'outgoing' && p.state === 'done').length, productions: P.filter((p) => p.type === 'production').length,
      mr: this.db.mr.length, mrOpen: this.db.mr.filter((m) => m.stage !== 'done').length, corrective: this.db.mr.filter((m) => m.type === 'corrective').length, preventive: this.db.mr.filter((m) => m.type === 'preventive').length,
      equipment: this.db.equipment.length, events: this.sent + this.outbox.length };
  }
}
