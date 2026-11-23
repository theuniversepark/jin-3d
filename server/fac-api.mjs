// FAC API — FACOS 업무 기록(FAC: 발주 · 재고 · 설비보전)을 외부 시스템(MES·BI·사내 시스템)에 REST로 제공한다.
// 화면(js/fac.js · js/main.js)이 2초마다 쌓인 이벤트와 현황을 POST /api/fac/push로 올리면 서버 메모리에 보관하고,
// 외부에서는 조회(①)와 이벤트 이력(②)을 읽는다. 쓰기(외부 발주·정비요청 입력)는 아직 없다 — 읽기 전용.
//  ① 조회   GET /api/fac/status · /po · /moves · /stock · /mr · /equipment · /orderpoints · /master
//  ② 이벤트 GET /api/fac/events?since=<seq>&limit=<n>&type=<po.create,mr.stage…>
//          → { run, events: [{ seq, t, type, key, … }], next } — next를 다음 since로 넘기면 이어 받는다
//          이벤트 유형: master · po.create · receipt.done · internal.done · production.done · delivery.done · mr.create · mr.update · mr.stage · order.assign · order.close
// 새 운전(화면에서 단계·라인을 바꿔 run ID가 달라짐)이 올라오면 기록을 비우고 seq를 1부터 다시 센다.
const MAX_EVENTS = 20000;
let store = null;
const listeners = [];   // 새 이벤트를 받을 곳 (server/erpnext-bridge.mjs — ERPNext 연동)
export function facListen(fn) { listeners.push(fn); }

function fresh(run) { return { run, seq: 0, master: null, events: [], snapshot: null, pushes: 0, lastPush: null }; }
export function facReset() { store = null; }
export function facStatus() {
  if (!store) return { active: false, run: null, events: 0, seq: 0 };
  const S = store.snapshot;
  return { active: true, run: store.run, mode: S?.mode ?? null, t: S?.t ?? null, seq: store.seq, events: store.events.length + (store.master ? 1 : 0),
    first: store.events[0]?.seq ?? null, pushes: store.pushes, lastPush: store.lastPush, stats: S?.stats ?? null };
}
// 화면 → 서버: { run, events, snapshot }
export function facPush(body) {
  if (!body || typeof body.run !== 'string' || !body.run) throw new Error('run이 없습니다');
  if (!store || store.run !== body.run) store = fresh(body.run);
  let accepted = 0; const added = [];
  for (const ev of Array.isArray(body.events) ? body.events : []) {
    if (!ev || typeof ev.type !== 'string') continue;
    if (ev.type === 'master') { if (!store.master) { store.master = { seq: ++store.seq, ...ev }; added.push(store.master); } else continue; }
    else { const e = { seq: ++store.seq, ...ev }; store.events.push(e); added.push(e); }
    accepted++;
  }
  if (store.events.length > MAX_EVENTS) store.events.splice(0, store.events.length - MAX_EVENTS);
  if (body.snapshot && typeof body.snapshot === 'object') store.snapshot = body.snapshot;
  store.pushes++; store.lastPush = new Date().toISOString();
  if (listeners.length && added.length) for (const fn of listeners) { try { fn(store.run, added); } catch { /* 듣는 쪽 오류는 FAC API에 영향 없음 */ } }
  return { accepted, seq: store.seq };
}
export function facEvents({ since = 0, limit = 500, type = null } = {}) {
  if (!store) return { run: null, events: [], next: since };
  const types = type ? new Set(String(type).split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const all = store.master ? [store.master, ...store.events] : store.events;
  const out = all.filter((e) => e.seq > since && (!types || types.has(e.type))).slice(0, Math.max(1, Math.min(5000, limit)));
  return { run: store.run, events: out, next: out.length ? out.at(-1).seq : Math.max(since, 0) };
}
const VIEWS = {
  po: (S) => S.po, moves: (S) => S.moves, stock: (S) => ({ locations: S.locations, products: S.products, stock: S.stock }),
  mr: (S) => S.mr, equipment: (S) => S.equipment, orderpoints: (S) => S.orderpoints,
  master: (S) => ({ products: S.products, locations: S.locations, orderpoints: S.orderpoints, equipment: S.equipment }),
};
// HTTP 라우팅 — app-server가 /api/fac/로 시작하는 요청을 넘긴다. 처리하지 않는 경로면 null
export function facRoute(method, pathname, query, bodyText) {
  const name = pathname.replace(/^\/api\/fac\/?/, '');
  if (name === 'push') {
    if (method !== 'POST') return { code: 405, body: { error: 'POST만 받습니다' } };
    try { return { code: 200, body: facPush(JSON.parse(bodyText || '{}')) }; } catch (e) { return { code: 400, body: { error: e.message } }; }
  }
  if (method !== 'GET') return { code: 405, body: { error: 'GET만 받습니다 (FAC API는 읽기 전용)' } };
  if (name === '' || name === 'status') return { code: 200, body: facStatus() };
  if (name === 'events') return { code: 200, body: facEvents({ since: Number(query.get('since')) || 0, limit: Number(query.get('limit')) || 500, type: query.get('type') }) };
  if (VIEWS[name]) {
    if (!store?.snapshot) return { code: 503, body: { error: 'FAC 기록이 아직 없습니다 — 자동화·피지컬AI 단계로 화면을 실행하세요' } };
    return { code: 200, body: { run: store.run, t: store.snapshot.t, data: VIEWS[name](store.snapshot) } };
  }
  return null;
}
