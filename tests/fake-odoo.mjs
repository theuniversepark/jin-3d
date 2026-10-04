// 시험용 가짜 Odoo 서버 — Odoo 외부 API(/jsonrpc)의 common.version · common.authenticate · object.execute_kw 중
// 게이트웨이(server/odoo-gateway.mjs)가 쓰는 모델·메서드만 메모리로 흉내 낸다 (재고는 전표 검증 시 로케이션별로 옮긴다).
// 실제 Odoo의 모든 규칙을 재현하지는 않는다 — 호출 순서·인자·재고 흐름이 맞는지 확인하는 용도.
import http from 'node:http';

export function startFakeOdoo({ version = '17.0', db = 'jin3d', user = 'admin', key = 'test-key' } = {}) {
  const T = {}, calls = [];
  let nid = 1;
  const tab = (m) => (T[m] ??= new Map());
  const create = (m, v) => { const id = nid++; tab(m).set(id, { id, ...v }); return id; };
  const match = (r, dom) => dom.every(([f, op, val]) => { const x = Array.isArray(r[f]) ? r[f][0] : r[f]; return op === '=' ? x === val : true; });
  const read = (m, idsOrDom, fields) => { const rows = Array.isArray(idsOrDom[0]) || !idsOrDom.length ? [...tab(m).values()].filter((r) => match(r, idsOrDom)) : idsOrDom.map((i) => tab(m).get(i)).filter(Boolean); return rows.map((r) => (fields ? Object.fromEntries(['id', ...fields].map((f) => [f, r[f]])) : { ...r })); };
  const quant = (loc, prod, d) => { const k = `${loc}|${prod}`; const q = (T.__q ??= new Map()); q.set(k, (q.get(k) ?? 0) + d); };
  // 기본 데이터: 창고 1개, 가상 로케이션, 정비 단계
  const stock = create('stock.location', { name: 'Stock', usage: 'internal' });
  for (const u of ['supplier', 'customer', 'production', 'inventory']) create('stock.location', { name: u, usage: u });
  const types = { in: create('stock.picking.type', { code: 'incoming' }), int: create('stock.picking.type', { code: 'internal' }), out: create('stock.picking.type', { code: 'outgoing' }) };
  create('stock.warehouse', { name: 'WH', lot_stock_id: [stock, 'WH/Stock'], in_type_id: [types.in, 'R'], int_type_id: [types.int, 'I'], out_type_id: [types.out, 'D'] });
  [['New Request', false, 1], ['In Progress', false, 2], ['Repaired', true, 3], ['Scrap', false, 4]].forEach(([name, done, sequence]) => create('maintenance.stage', { name, done, sequence }));
  const locOf = (usage) => [...tab('stock.location').values()].find((l) => l.usage === usage).id;

  function exec(model, method, args, kwargs) {
    calls.push(`${model}.${method}`);
    if (method === 'search') return read(model, args[0]).map((r) => r.id).slice(0, kwargs.limit ?? 1e9);
    if (method === 'search_read') { let rows = read(model, args[0], kwargs.fields); if (kwargs.order?.startsWith('sequence')) rows.sort((a, b) => (tab(model).get(a.id).sequence ?? 0) - (tab(model).get(b.id).sequence ?? 0)); return rows.slice(0, kwargs.limit ?? 1e9); }
    if (method === 'read') return read(model, args[0], kwargs.fields);
    if (method === 'create') {
      const v = { ...args[0] };
      if (model === 'product.product') { if (version.startsWith('18') ? !(v.type === 'consu' && v.is_storable) : v.type !== 'product') throw new Error(`재고 관리 제품 유형 오류 (${version}): ${JSON.stringify({ type: v.type, is_storable: v.is_storable })}`); }
      const lines = v.order_line ?? v.move_ids; delete v.order_line; delete v.move_ids;
      const id = create(model, v);
      if (model === 'purchase.order') { tab(model).get(id).lines = lines.map((l) => l[2]); tab(model).get(id).state = 'draft'; }
      if (model === 'stock.picking') { for (const l of lines) create('stock.move', { ...l[2], picking_id: [id, ''], product_id: [l[2].product_id, ''], location_id: [l[2].location_id, ''], location_dest_id: [l[2].location_dest_id, ''] }); tab(model).get(id).state = 'draft'; }
      if (model === 'stock.quant') tab(model).get(id).inventory = true;
      return id;
    }
    if (method === 'write') { for (const i of args[0]) Object.assign(tab(model).get(i), Object.fromEntries(Object.entries(args[1]).map(([k, v]) => [k, (k.endsWith('_id') && typeof v === 'number') ? [v, ''] : v]))); return true; }
    if (model === 'purchase.order' && method === 'button_confirm') {
      for (const i of args[0]) {
        const po = tab(model).get(i); po.state = 'purchase';
        const pk = create('stock.picking', { picking_type_id: types.in, location_id: locOf('supplier'), location_dest_id: stock, origin: po.partner_ref, state: 'assigned' });
        for (const l of po.lines) create('stock.move', { picking_id: [pk, ''], product_id: [l.product_id, ''], product_uom_qty: l.product_qty, location_id: [locOf('supplier'), ''], location_dest_id: [stock, ''] });
        po.picking_ids = [pk];
      }
      return true;
    }
    if (model === 'stock.picking' && method === 'action_confirm') { for (const i of args[0]) tab(model).get(i).state = 'assigned'; return true; }
    if (model === 'stock.picking' && method === 'button_validate') {
      for (const i of args[0]) {
        const pk = tab(model).get(i); if (pk.state === 'done') throw new Error('이미 처리된 전표');
        for (const m of [...tab('stock.move').values()].filter((x) => x.picking_id[0] === i)) {
          const q = version.startsWith('16') ? m.quantity_done : m.picked ? m.quantity : 0;
          if (!q) throw new Error('처리 수량 없음');
          quant(m.location_id[0], m.product_id[0], -q); quant(m.location_dest_id[0], m.product_id[0], q);
        }
        pk.state = 'done';
      }
      return true;
    }
    if (model === 'stock.quant' && method === 'action_apply_inventory') { for (const i of args[0]) { const q = tab(model).get(i); quant(q.location_id, q.product_id, q.inventory_quantity); } return true; }
    throw new Error(`fake: 지원하지 않는 호출 ${model}.${method}`);
  }
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const { params, id } = JSON.parse(b); let result, error;
      try {
        if (params.service === 'common' && params.method === 'version') result = { server_version: version };
        else if (params.service === 'common' && params.method === 'authenticate') result = params.args[0] === db && params.args[1] === user && params.args[2] === key ? 2 : false;
        else if (params.service === 'object' && params.method === 'execute_kw') { const [d, uid, k, model, method, args, kwargs] = params.args; if (d !== db || uid !== 2 || k !== key) throw new Error('Access Denied'); result = exec(model, method, args, kwargs ?? {}); }
        else throw new Error('unknown');
      } catch (e) { error = { message: 'Odoo Server Error', data: { message: e.message } }; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, T, calls, close: () => server.close(),
    stockAt: (locName, code) => { const loc = [...tab('stock.location').values()].find((l) => l.name === locName), p = [...tab('product.product').values()].find((x) => x.default_code === code); return T.__q?.get(`${loc?.id}|${p?.id}`) ?? 0; } })));
}
