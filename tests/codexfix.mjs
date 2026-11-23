// Codex 검수(2026-10-22) 지적 2~4 회귀 시험 — 검수 재현(outputs/claude-review-2026-10-22-repro.mjs)을 「고친 뒤 기대 동작」으로 뒤집었다.
// 2 실행을 바꿔도 팔레트 SSCC·출하 ID 재사용 없음(앱 재시작은 저장소에서 이어 받기) · 3 ERPNext 생산 입고 일부 성공 뒤 재시도 = 남은 배분만
// 4 FAC 출고 확정 이벤트에 SSCC·시리얼을 실어 EPCIS 업로드 순서와 무관하게 출하 전표에. (5 · 6은 tests/zonekpi.mjs · 1 설비 대시보드는 따로) 실행: npm test
// 상위 meta-factory tests/codexfix.mjs에서 제품만 정밀조립 것으로 (유연생산 후드 → 도어트림)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SerialHub } from '../js/serial.js';
import { EpcisStore, epcisEvent } from '../js/epcis.js';
import { makeEpcisApi } from '../server/epcis-api.mjs';
import { makeErpBridge } from '../server/erpnext-bridge.mjs';
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

console.log('== 2. 실행을 바꿔도 팔레트 SSCC · 출하 ID 재사용 없음');
{
  const serialSeq = {}, wipSeq = {}, ctr = { pal: 0, ship: 0 }, store = new EpcisStore();   // main.js처럼 실행 사이에 공유
  const run = (truckName) => {
    const sim = { time: 100, mode: { key: 'smart' }, quiet: true, trace: { ymd: '261022', byId: new Map() } };
    const h = new SerialHub(sim); h.serSeq = serialSeq; h.wipSeq = wipSeq; h.ctr = ctr; h.feedOn = true;
    const item = { id: 1, product: 'doortrim', wip: h.wipId('doortrim') }; h.adopt({ wip: item.wip, product: 'doortrim', item: 1, t0: 100, status: 'ok', steps: [] }, 'main');   // trace.js release와 같은 꼴 (계보 기록 = 단위)
    const u = h.issue(item, { cell: 'PACK' }); h.toFG(item);
    const truck = { id: truckName }, lot = h.take('doortrim', 1, 'F1'); h.ship(lot, truck);
    store.capture(h.drain().map((e) => epcisEvent(h, e, () => '2026-10-22T08:00:00+09:00')).filter(Boolean));
    return { epc: u.epc, sscc: lot.pal.sscc, shipment: u.ship.shipment, content: h.shipmentContent(u.ship.shipment), serial: u.serial };
  };
  const a = run('화물트럭-1'), b = run('화물트럭-1');   // 두 실행 모두 트럭 표시 이름이 같다 (실행마다 1부터)
  check('두 실행의 SSCC · 출하 ID가 다름', a.sscc !== b.sscc && a.shipment !== b.shipment, `${a.sscc}/${a.shipment} · ${b.sscc}/${b.shipment}`);
  const ships = store.trace(a.epc).filter((e) => e.bizStep.endsWith('shipping'));
  check('첫 제품 추적에 다른 실행의 출하가 섞이지 않음', ships.length === 1 && ships[0]['mf:shipment'] === a.shipment, ships.map((e) => e['mf:shipment']).join());
  const R = store.shipmentOf(a.shipment);
  check('출하 ID 리콜 범위 = 그 출하의 팔레트·시리얼만 · 트럭 표시 이름 함께', R.pallets.length === 1 && R.serials.length === 1 && R.serials[0] === a.epc && R.truck === '화물트럭-1');
  check('출하 내용(FAC 이벤트용) — SSCC · 시리얼', a.content.sscc.join() === a.sscc && a.content.serials.join() === a.serial);
  // 앱 재시작: 서버 저장소에서 마지막 SSCC · 오늘 출하 번호를 이어 받는다
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-codexfix-epcis-')), api = makeEpcisApi({ dir, interval: 1e9 });
  await api.route('POST', '/api/epcis/v1/capture', new URLSearchParams(), JSON.stringify({ '@context': [], type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '2026-10-22T08:00:00+09:00', epcisBody: { eventList: store.events } }));
  const base = (await api.route('GET', '/api/epcis/v1/serial-base', new URLSearchParams({ ymd: '261022' }))).body;
  check('serial-base — 팔레트 · 출하 마지막 번호', base.pal === 2 && base.ship === 2, JSON.stringify({ pal: base.pal, ship: base.ship }));
  const sh = (await api.route('GET', '/api/epcis/v1/shipment', new URLSearchParams({ id: b.shipment }))).body;
  check('shipment?id= 조회', sh.serials.length === 1 && sh.serials[0] === b.epc);
  api.close?.(); fs.rmSync(dir, { recursive: true, force: true });
}

console.log('== 2·4. 시뮬레이션 — FAC 출고 확정 이벤트에 실린 SSCC · 시리얼');
{
  const s = new Simulation('smart', 3, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), evs = [];
  const emit = s.fac.emit.bind(s.fac); s.fac.emit = (e) => { if (e.type === 'delivery.done') evs.push(e); return emit(e); };
  for (let t = 0; t < 7200 && !evs.length; t += 0.1) { s.step(0.1); ag.update(0.1); }
  const e = evs[0], H = s.serials, shipped = H?.units.filter((u) => u.ship?.shipment === e?.shipment) ?? [];
  check('delivery.done — 출하 ID · SSCC · 시리얼 = 시리얼 서비스의 그 출하 (마지막 팔레트 포함)', !!e && /^SHP-/.test(e.shipment) && e.serials.length > 0 && e.serials.length === shipped.length && shipped.every((u) => e.serials.includes(u.serial ?? u.wip)) && e.sscc.length === new Set(shipped.map((u) => u.ship.sscc)).size, e ? `${e.origin} ${e.shipment} · 팔레트 ${e.sscc.length} · 시리얼 ${e.serials.length} / ${shipped.length}` : '출하 없음');
}

// 가짜 ERPNext — 이름·mf_ref로 찾기 · 지정한 요청 한 번 실패
const fakeErp = (opt = {}) => {
  const docs = []; let failed = false;
  const fetchImpl = async (url, o = {}) => {
    const u = new URL(url), body = o.body ? JSON.parse(o.body) : {}, json = (j, status = 200) => new Response(JSON.stringify(j), { status });
    if ((o.method ?? 'GET') === 'GET') {
      const f = JSON.parse(u.searchParams.get('filters') ?? '[]'), fields = JSON.parse(u.searchParams.get('fields') ?? '["name"]'), dt = decodeURIComponent(u.pathname.split('/').pop());
      const hit = docs.filter((d) => d.doctype === dt && f.every(([k, op, v]) => (op === 'like' ? String(d[k] ?? '').startsWith(v.replace(/%$/, '')) : String(d[k] ?? '') === String(v))));
      return json({ data: hit.map((d) => Object.fromEntries(fields.map((k) => [k, d[k]]))) });
    }
    if (u.pathname.includes('/api/method/frappe.client.submit')) return json({ message: { ...body.doc, docstatus: 1 } });
    if (u.pathname.includes('/api/method/')) return json({ message: { work_order: body.work_order_id, qty: body.qty } });
    if (opt.failWo && body.work_order === opt.failWo && !failed) { failed = true; return json({ exception: 'Temporary outage' }, 503); }
    const dt = decodeURIComponent(u.pathname.split('/').pop()), doc = { ...body, doctype: dt, name: `${dt}-${docs.length + 1}` }; docs.push(doc); return json({ data: doc });
  };
  return { docs, fetchImpl };
};
const bridgeDir = (st, cfg = {}) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-codexfix-erp-')); fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ url: 'http://fake.invalid', apiKey: 'k', apiSecret: 's', enabled: true, ...cfg })); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ prepared: { at: 'yes', company: 'JM', abbr: 'JM' }, ...st })); return d; };

console.log('== 3. ERPNext 생산 입고 — 일부 성공 뒤 재시도');
{
  const wo = { one: { run: 'R', product: 'doortrim', name: 'WO-1', qty: 1, produced: 0, stopped: false }, two: { run: 'R', product: 'doortrim', name: 'WO-2', qty: 2, produced: 0, stopped: false } };
  const dir = bridgeDir({ wo }), E = fakeErp({ failWo: 'WO-2' }), br = makeErpBridge({ dir, fetchImpl: E.fetchImpl, interval: 1e9 });
  br.enqueue('R', [{ type: 'production.done', key: 'P1', lines: [{ product: 'doortrim', qty: 3 }] }]);
  await br.pump(); const s1 = br.status();
  await br.route('POST', '/api/erpnext/v1/config', new URLSearchParams(), JSON.stringify({ enabled: true })); await br.pump();
  const ste = E.docs.filter((d) => d.doctype === 'Stock Entry'), qty = ste.reduce((a, d) => a + d.qty, 0), st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  check('첫 시도: WO-1 1개만 성공 · 대기 1', s1.queued === 1 && ste.length >= 1);
  check('재시도: 남은 WO-2 2개만 → 합계 3 · 전표 2건(작업지시별) · 대기 0', qty === 3 && ste.length === 2 && ste.map((d) => d.work_order).sort().join() === 'WO-1,WO-2' && br.status().queued === 0, `생산 ${qty} · 전표 ${ste.length}`);
  check('작업지시 생산 수량은 한 번만 반영 (1 · 2)', st.wo.one.produced === 1 && st.wo.two.produced === 2);
  br.enqueue('R', [{ type: 'production.done', key: 'P1', lines: [{ product: 'doortrim', qty: 3 }] }]); await br.pump();
  check('같은 이벤트를 다시 받아도 전표가 늘지 않음', E.docs.filter((d) => d.doctype === 'Stock Entry').length === 2);
  br.close?.(); fs.rmSync(dir, { recursive: true, force: true });
}

console.log('== 4. 출하 전표 — EPCIS 업로드보다 먼저 와도 시리얼 포함');
{
  const dir = bridgeDir({}, { serials: true }), E = fakeErp();
  let asked = 0; const br = makeErpBridge({ dir, fetchImpl: E.fetchImpl, interval: 1e9, serialsOf: () => { asked++; return { pallets: [], serials: [] }; } });   // EPCIS는 아직 비어 있음
  br.enqueue('R', [{ type: 'delivery.done', key: 'D1', origin: '출하 화물트럭-1', shipment: 'SHP-261022-00007', sscc: ['088000000000000015'], serials: ['DT-261022-000001', 'DT-261022-000002'], lines: [{ product: 'doortrim', qty: 2 }] }]);
  await br.pump();
  const dn = E.docs.find((d) => d.doctype === 'Delivery Note');
  check('전표에 시리얼 · SSCC · 출하 ID (EPCIS 조회 안 함)', dn?.mf_serials === 'DT-261022-000001\nDT-261022-000002' && /SHP-261022-00007/.test(dn.mf_shipment) && /\(00\)088000000000000015/.test(dn.mf_shipment) && asked === 0, dn?.mf_shipment);
  br.close?.(); fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
