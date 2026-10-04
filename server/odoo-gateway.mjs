// Odoo 실시간 연동 게이트웨이 — 화면(js/odoo.js)이 보낸 ERP 이벤트를 Odoo 외부 API(JSON-RPC, /jsonrpc)로 실제 Odoo에 생성·확정한다.
// 설정: 환경변수(.env) ODOO_URL · ODOO_DB · ODOO_USER · ODOO_API_KEY, 또는 화면 설정(서버 메모리에만 보관 — API 키는 브라우저로 돌려보내지 않음)
// 필요한 Odoo 앱: Purchase(구매) · Inventory(재고) · Maintenance(설비보전) — 모두 Community(LGPL v3)에 포함. Odoo 16~18.
// 이벤트 → Odoo:
//  master          : product.product(제품 4종, default_code로 찾거나 생성) · res.partner(공급사·고객사) · stock.location(물류선반·라인·구분적재장)
//                    stock.warehouse.orderpoint(재주문 규칙) · maintenance.equipment(설비·로봇, serial_no) · 기초 재고(stock.quant 재고 조정)
//  po.create       : purchase.order + order_line 생성 → button_confirm (Odoo가 입고 전표를 만든다) — 시뮬레이션 전표 번호는 origin/partner_ref로 연결
//  receipt.done    : 그 구매오더의 입고 전표 수량 입력 → 목적지 로케이션(물류 선반) → button_validate
//  internal.done · production.done · delivery.done : stock.picking(내부 이동·입고·출고) 생성 → action_confirm → 수량 입력 → button_validate
//  mr.create · mr.update · mr.stage : maintenance.request 생성(유형 corrective/preventive) · 단계(진행 중 / 완료) · 소요 시간
const cfg = { url: process.env.ODOO_URL ?? '', db: process.env.ODOO_DB ?? '', user: process.env.ODOO_USER ?? '', key: process.env.ODOO_API_KEY ?? '' };
const st = { connected: false, uid: null, version: null, sent: 0, failed: 0, lastError: null, lastSync: null, created: {} };
const ids = new Map();        // 'product:raw' · 'loc:rackRaw' · 'po:P00001' · 'mr:MR/00001' … → Odoo id
let seq = 0, busy = Promise.resolve();

export function odooConfig(c = {}) {
  for (const k of ['url', 'db', 'user', 'key']) if (typeof c[k] === 'string' && c[k].trim()) cfg[k] = c[k].trim().replace(/\/+$/, '');
  st.connected = false; st.uid = null; ids.clear();
  return odooStatus();
}
export function odooStatus() {
  return { configured: !!(cfg.url && cfg.db && cfg.user && cfg.key), url: cfg.url, db: cfg.db, user: cfg.user, hasKey: !!cfg.key, ...st, created: { ...st.created } };
}
async function rpc(service, method, args) {
  const r = await fetch(`${cfg.url}/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: ++seq }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.data?.message ?? j.error.message ?? 'Odoo 오류');
  return j.result;
}
const kw = (model, method, args = [], kwargs = {}) => rpc('object', 'execute_kw', [cfg.db, st.uid, cfg.key, model, method, args, kwargs]);
async function connect() {
  if (st.connected) return;
  const v = await rpc('common', 'version', []);
  st.version = v?.server_version ?? null;
  const uid = await rpc('common', 'authenticate', [cfg.db, cfg.user, cfg.key, {}]);
  if (!uid) throw new Error('Odoo 로그인 실패 (DB·사용자·API 키 확인)');
  st.uid = uid; st.connected = true;
}
const major = () => parseInt(String(st.version ?? '17'), 10) || 17;
function count(model) { st.created[model] = (st.created[model] ?? 0) + 1; }
async function findOrCreate(key, model, domain, vals) {
  if (ids.has(key)) return ids.get(key);
  const found = await kw(model, 'search', [domain], { limit: 1 });
  const id = found?.[0] ?? (count(model), await kw(model, 'create', [vals]));
  ids.set(key, id); return id;
}
let wh = null;
async function warehouse() {
  if (wh) return wh;
  const [w] = await kw('stock.warehouse', 'search_read', [[]], { fields: ['id', 'lot_stock_id', 'in_type_id', 'int_type_id', 'out_type_id'], limit: 1 });
  if (!w) throw new Error('Odoo 창고가 없습니다 (재고 앱 설치 필요)');
  wh = { id: w.id, stock: w.lot_stock_id[0], in: w.in_type_id[0], int: w.int_type_id[0], out: w.out_type_id[0] };
  return wh;
}
async function locId(k, L) {
  if (ids.has(`loc:${k}`)) return ids.get(`loc:${k}`);
  const W = await warehouse();
  if (L.usage === 'supplier' || L.usage === 'customer' || L.usage === 'production') {
    const [l] = await kw('stock.location', 'search', [[['usage', '=', L.usage]]], { limit: 1 }); ids.set(`loc:${k}`, l); return l;
  }
  const name = L.name.split('/').pop();
  return findOrCreate(`loc:${k}`, 'stock.location', [['name', '=', name], ['location_id', '=', W.stock]], { name, location_id: W.stock, usage: 'internal' });
}
async function product(k, P) {
  const vals = { name: P.name, default_code: P.code, list_price: P.price, standard_price: P.price, purchase_ok: true, sale_ok: true };
  if (major() >= 18) Object.assign(vals, { type: 'consu', is_storable: true }); else vals.type = 'product';
  return findOrCreate(`product:${k}`, 'product.product', [['default_code', '=', P.code]], vals);
}
async function partner(k, name, supplier) { return findOrCreate(`partner:${k}`, 'res.partner', [['name', '=', name]], { name, is_company: true, ...(supplier ? { supplier_rank: 1 } : { customer_rank: 1 }) }); }

// 내부 이동·입고·출고 전표 한 장: 생성 → 확정 → 수량 입력 → 검증
async function picking(typeKey, ev, M, partnerId = null) {
  const W = await warehouse(), type = { in: W.in, int: W.int, out: W.out }[typeKey];
  const lines = ev.lines.filter((l) => l.qty > 0); if (!lines.length) return null;
  const from = await locId(lines[0].from, M.locations[lines[0].from]), to = await locId(lines[0].to, M.locations[lines[0].to]);
  const moves = [];
  for (const l of lines) moves.push([0, 0, { name: `${ev.key} ${M.products[l.product].code}`, product_id: await product(l.product, M.products[l.product]), product_uom_qty: l.qty, location_id: await locId(l.from, M.locations[l.from]), location_dest_id: await locId(l.to, M.locations[l.to]) }]);
  const id = await kw('stock.picking', 'create', [{ picking_type_id: type, location_id: from, location_dest_id: to, origin: `${ev.key} · ${ev.origin ?? 'Jin-3D'}`, ...(partnerId ? { partner_id: partnerId } : {}), move_ids: moves }]);
  count('stock.picking');
  await kw('stock.picking', 'action_confirm', [[id]]);
  await validate(id, lines);
  ids.set(`picking:${ev.key}`, id);
  return id;
}
// 이동 수량을 요청 수량 그대로 처리 표시 → 검증 (재고가 모자라도 강제 처리: 시뮬레이션이 실제 흐름의 원본)
async function validate(pickId, lines = null) {
  const moves = await kw('stock.move', 'search_read', [[['picking_id', '=', pickId]]], { fields: ['id', 'product_uom_qty', 'location_dest_id'] });
  for (const m of moves) {
    const vals = major() >= 17 ? { quantity: m.product_uom_qty, picked: true } : { quantity_done: m.product_uom_qty };
    await kw('stock.move', 'write', [[m.id], vals]);
  }
  void lines;
  const r = await kw('stock.picking', 'button_validate', [[pickId]], { context: { skip_backorder: true, skip_sms: true, skip_immediate: true } });
  if (r && typeof r === 'object' && r.res_model) {   // 마법사(즉시 이전·백오더)가 뜨면 확정 쪽으로 처리
    const wiz = await kw(r.res_model, 'create', [{ pick_ids: [[6, 0, [pickId]]] }], { context: r.context ?? {} }).catch(() => null);
    if (wiz) await kw(r.res_model, r.res_model.includes('backorder') ? 'process_cancel_backorder' : 'process', [[wiz]], { context: r.context ?? {} }).catch(() => null);
  }
}
async function stage(done) {
  const stages = await kw('maintenance.stage', 'search_read', [[]], { fields: ['id', 'done', 'sequence'], order: 'sequence asc' });
  return done ? stages.find((s) => s.done)?.id : stages.find((s, i) => i > 0 && !s.done)?.id;
}

let master = null;
async function apply(ev) {
  if (ev.type === 'master') {
    master = ev;
    for (const [k, P] of Object.entries(ev.products)) await product(k, P);
    for (const [k, L] of Object.entries(ev.locations)) await locId(k, L);
    await partner('supplier', ev.supplier, true); await partner('customer', ev.customer, false);
    for (const o of ev.orderpoints) await findOrCreate(`op:${o.product}`, 'stock.warehouse.orderpoint', [['product_id', '=', await product(o.product, ev.products[o.product])], ['location_id', '=', await locId(o.location, ev.locations[o.location])]],
      { product_id: await product(o.product, ev.products[o.product]), location_id: await locId(o.location, ev.locations[o.location]), product_min_qty: o.min, product_max_qty: o.max, warehouse_id: (await warehouse()).id });
    for (const e of ev.equipment) await findOrCreate(`eq:${e.serial_no}`, 'maintenance.equipment', [['serial_no', '=', e.serial_no]], { name: `${e.name} (${e.category})`, serial_no: e.serial_no, note: `Jin-3D 설비 고유 ID ${e.serial_no} · AAS 자산 ${e.key}` });
    if (ids.has('master:inventory')) return;   // 기초 재고는 한 번만 (같은 세션에 마스터를 다시 받아도 중복 조정하지 않음)
    ids.set('master:inventory', 1);
    for (const q of ev.inventory) {   // 기초 재고: 재고 조정 (inventory_quantity → action_apply_inventory)
      if (!q.qty) continue;
      const qid = await kw('stock.quant', 'create', [{ product_id: await product(q.product, ev.products[q.product]), location_id: await locId(q.location, ev.locations[q.location]), inventory_quantity: q.qty }], { context: { inventory_mode: true } });
      await kw('stock.quant', 'action_apply_inventory', [[qid]]).catch(() => null);
    }
    return;
  }
  if (!master) throw new Error('마스터 데이터 이벤트가 먼저 와야 합니다');
  const M = master;
  if (ev.type === 'po.create') {
    const lines = [];
    for (const l of ev.lines) lines.push([0, 0, { product_id: await product(l.product, M.products[l.product]), product_qty: l.qty, price_unit: l.price, name: `${M.products[l.product].code} ${M.products[l.product].name}` }]);
    const id = await kw('purchase.order', 'create', [{ partner_id: await partner('supplier', M.supplier, true), partner_ref: ev.key, origin: `Jin-3D WMS ${ev.key}`, order_line: lines }]);
    count('purchase.order');
    await kw('purchase.order', 'button_confirm', [[id]]);
    ids.set(`po:${ev.key}`, id);
  } else if (ev.type === 'receipt.done') {
    const poId = ids.get(`po:${ev.po}`); if (!poId) throw new Error(`${ev.po} 구매오더가 Odoo에 없습니다`);
    const [po] = await kw('purchase.order', 'read', [[poId]], { fields: ['picking_ids'] });
    const pick = po.picking_ids?.[0]; if (!pick) throw new Error(`${ev.po} 입고 전표 없음`);
    // 입고 목적지: 물류 선반 로케이션 (원자재·부품)
    const moves = await kw('stock.move', 'search_read', [[['picking_id', '=', pick]]], { fields: ['id', 'product_id'] });
    for (const m of moves) {
      const l = ev.lines.find((x) => ids.get(`product:${x.product}`) === m.product_id[0]);
      if (l) await kw('stock.move', 'write', [[m.id], { location_dest_id: await locId(l.to, M.locations[l.to]) }]);
    }
    await validate(pick);
    ids.set(`picking:${ev.key}`, pick);
  } else if (ev.type === 'internal.done') await picking('int', ev, M);
  else if (ev.type === 'production.done') await picking('in', { ...ev, origin: '생산 실적' }, M);
  else if (ev.type === 'delivery.done') await picking('out', ev, M, await partner('customer', M.customer, false));
  else if (ev.type === 'mr.create') {
    const id = await kw('maintenance.request', 'create', [{ name: `${ev.key} ${ev.name}`, equipment_id: ids.get(`eq:${ev.equipment}`) ?? false, maintenance_type: ev.mtype, description: ev.description }]);
    count('maintenance.request'); ids.set(`mr:${ev.key}`, id);
  } else if (ev.type === 'mr.update') {
    const id = ids.get(`mr:${ev.key}`); if (id) await kw('maintenance.request', 'write', [[id], { maintenance_type: ev.mtype, name: `${ev.key} ${ev.name}` }]);
  } else if (ev.type === 'mr.stage') {
    const id = ids.get(`mr:${ev.key}`); if (!id) return;
    const sid = await stage(ev.stage === 'done');
    await kw('maintenance.request', 'write', [[id], { ...(sid ? { stage_id: sid } : {}), ...(ev.duration != null ? { duration: ev.duration } : {}) }]);
  }
}
// 이벤트 묶음을 순서대로 적용 (동시에 두 묶음이 오면 차례로)
export function odooSync(events) {
  const run = busy.then(async () => {
    if (!odooStatus().configured) throw new Error('Odoo 서버 설정이 없습니다 (ODOO_URL · ODOO_DB · ODOO_USER · ODOO_API_KEY)');
    await connect();
    let done = 0;
    for (const ev of events) {
      try { await apply(ev); st.sent++; done++; }
      catch (e) { st.failed++; st.lastError = `${ev.type} ${ev.key ?? ''}: ${e.message}`; if (ev.type === 'master') throw e; }
    }
    st.lastSync = new Date().toISOString();
    return { applied: done, status: odooStatus() };
  });
  busy = run.catch(() => null);
  return run;
}
export function odooReset() { ids.clear(); master = null; wh = null; st.connected = false; }
