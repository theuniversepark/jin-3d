// EPCIS 2.0 이벤트 변환 · 저장소 (GS1 EPCIS 2.0 / CBV 2.0 · JSON-LD)
//  · 변환: 시리얼 서비스(js/serial.js) 기록 → 표준 이벤트 — 시리얼 발행 이후만 (WIP 단계 계보는 FacOS 제품 추적에 남기고, WIP ID는 발행 이벤트의 mf:wip로 연결)
//      발행 commissioning → 적재 storing → 팔레트 묶음 packing(AggregationEvent · SSCC) → 출하 shipping(SSCC · 트럭 = bizTransaction bol)
//      출하 보류 holding · 보류 해제 inspecting · 재작업 repairing · 재검 inspecting · 격리 holding · 폐기 decommissioning(DELETE)
//      eventID = urn:uuid (재전송해도 같은 이벤트) · 위치 = SGLN(urn:epc:id:sgln:업체코드.00001.MAIN-PACK) · CBV 값은 짧은 이름 · 확장 필드는 mf: 접두
//  · 저장소: 캡처(문서 → 이벤트, eventID 중복 제거) · EPCIS 질의 일부(MATCH_anyEPC · EQ_bizStep · EQ_action · EQ_readPoint · GE/LT_eventTime · EQ_mf:… · perPage)
//      앱 서버(server/epcis-api.mjs — 파일에 계속 보관)와 웹 버전(브라우저 메모리 — 새로고침 시 비워짐)이 같은 코드를 쓴다
import { GS1_PREFIX, PRODUCTS } from './serial.js';

export const MF_NS = 'https://meta-factory.example/epcis/ext#';
export const EPCIS_CONTEXT = ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld', { mf: MF_NS }];
const TZ = '+09:00';
const ZONE_LOC = { main: 'MAIN' };
export const sgln = (ext) => `urn:epc:id:sgln:${GS1_PREFIX}.00001.${String(ext).replace(/[^A-Za-z0-9-]/g, '-').slice(0, 20)}`;
export const ssccEpc = (sscc) => `urn:epc:id:sscc:${GS1_PREFIX}.${sscc[0]}${sscc.slice(8, 17)}`;
const shipment = (truck) => `urn:mf:shipment:${encodeURIComponent(truck)}`;

// 시리얼 서비스 기록 하나 → EPCIS 2.0 이벤트 (보낼 것이 없으면 null)
export function epcisEvent(H, e, iso) {
  const U = (id) => H.byId.get(id), epc = (id) => U(id)?.epc ?? null, epcs = (ids) => [...new Set((ids ?? []).map(epc).filter(Boolean))];
  const base = (type, extra) => ({ type, eventTime: iso(e.t), eventTimeZoneOffset: TZ, eventID: e.uid, ...extra });
  const zl = (z) => ZONE_LOC[z] ?? 'FAC';
  switch (e.type) {
    case 'commission': {
      const u = U(e.id); if (!u?.epc) return null;
      return base('ObjectEvent', { epcList: [u.epc], action: 'ADD', bizStep: 'commissioning', disposition: 'active', readPoint: { id: sgln(`${zl(e.zone)}-${e.cell}`) }, bizLocation: { id: sgln(`${zl(e.zone)}-ZONE`) },
        ilmd: { 'mf:lot': u.plot, 'mf:productionDate': u.pdate }, 'mf:wip': e.wip, 'mf:product': u.product, 'mf:gtin': u.gtin, 'mf:symbol': e.symbol === 'DM' ? 'GS1 DataMatrix (DPM)' : 'QR (GS1 Digital Link)', 'mf:verifyGrade': e.grade, 'mf:markTries': u.mark?.tries ?? 1 });
    }
    case 'store': { const id = epc(e.id); return id ? base('ObjectEvent', { epcList: [id], action: 'OBSERVE', bizStep: 'storing', disposition: 'sellable_not_accessible', readPoint: { id: sgln(`${zl(e.zone)}-FG`) }, bizLocation: { id: sgln(`${zl(e.zone)}-FG`) } }) : null; }
    case 'aggregate': { const ch = epcs(e.children); return ch.length ? base('AggregationEvent', { parentID: ssccEpc(e.id), childEPCs: ch, action: 'ADD', bizStep: 'packing', disposition: 'container_closed', readPoint: { id: sgln('SHIP-PICK') }, 'mf:sscc': e.id }) : null; }
    case 'ship': return base('ObjectEvent', { epcList: [ssccEpc(e.id)], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', readPoint: { id: sgln('SHIP-DOCK') }, bizTransactionList: [{ type: 'bol', bizTransaction: shipment(e.shipment ?? e.truck) }], 'mf:sscc': e.id, 'mf:truck': e.truck, 'mf:shipment': e.shipment ?? e.truck, 'mf:quantity': e.n });
    case 'hold': { const ids = epcs(e.ids); return ids.length ? base('ObjectEvent', { epcList: ids, action: 'OBSERVE', bizStep: 'holding', disposition: 'non_sellable_other', readPoint: { id: sgln(`${zl(e.zone)}-FG`) }, 'mf:lot': e.id, 'mf:reason': e.why ?? '출하 전 샘플 재검 판정 전 출하 보류' }) : null; }
    case 'release': { const ids = epcs(e.ids); return ids.length ? base('ObjectEvent', { epcList: ids, action: 'OBSERVE', bizStep: 'inspecting', disposition: 'sellable_not_accessible', readPoint: { id: sgln(`${zl(e.zone)}-FG`) }, 'mf:lot': e.id, 'mf:result': e.result ?? 'OK' }) : null; }
    case 'decommission': { const id = epc(e.id); return id ? base('ObjectEvent', { epcList: [id], action: 'DELETE', bizStep: 'decommissioning', disposition: 'destroyed', readPoint: { id: sgln('QIS-MRB') }, 'mf:reason': e.why }) : null; }
    case 'rework': { const id = epc(e.id); return id ? base('ObjectEvent', { epcList: [id], action: 'OBSERVE', bizStep: 'repairing', disposition: 'non_conformant', readPoint: { id: sgln('QIS-MRB') }, ...(e.lot ? { 'mf:lot': e.lot } : {}) }) : null; }
    case 'quarantine': { const id = epc(e.id); return id ? base('ObjectEvent', { epcList: [id], action: 'OBSERVE', bizStep: 'holding', disposition: 'non_conformant', readPoint: { id: sgln('QIS-MRB') }, ...(e.lot ? { 'mf:lot': e.lot } : {}) }) : null; }
    case 'recheck': { const id = epc(e.id); return id ? base('ObjectEvent', { epcList: [id], action: 'OBSERVE', bizStep: 'inspecting', disposition: 'conformant', readPoint: { id: sgln('QIS-MRB') } }) : null; }
    case 'relabel': { const id = epc(e.id); return id ? base('ObjectEvent', { epcList: [id], action: 'OBSERVE', bizStep: 'encoding', disposition: 'active', readPoint: { id: sgln('QIS-MRB') }, 'mf:note': '판독 불가 → 수작업 라벨 재부착' }) : null; }
    default: return null;
  }
}
export function epcisDocument(events, creationDate) {
  return { '@context': EPCIS_CONTEXT, type: 'EPCISDocument', schemaVersion: '2.0', creationDate, epcisBody: { eventList: events } };
}
// 시리얼 서비스 기록 전체 → 문서 (내려받기 serial_events.jsonld)
export function serialEpcis(H, iso) { return epcisDocument(H.events.slice(-3000).map((e) => epcisEvent(H, e, iso)).filter(Boolean), iso(H.now())); }

// ── 저장소 ─────────────────
const isUri = (s) => typeof s === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(s);
const TYPES = new Set(['ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent']);
// 받을 수 있는 이벤트인지 (필수 항목 · ID가 URI인지) — 전체 스키마 검증은 시험(tests/epcis.mjs)에서 공식 JSON 스키마로
export function lintEvent(ev) {
  if (!ev || !TYPES.has(ev.type)) return '알 수 없는 이벤트 유형';
  if (!ev.eventTime || Number.isNaN(Date.parse(ev.eventTime))) return 'eventTime 없음';
  if (!/^[+-]\d\d:\d\d$/.test(ev.eventTimeZoneOffset ?? '')) return 'eventTimeZoneOffset 없음';
  for (const k of ['epcList', 'childEPCs', 'inputEPCList', 'outputEPCList']) if (ev[k] && !(Array.isArray(ev[k]) && ev[k].every(isUri))) return `${k}에 URI가 아닌 값`;
  if (ev.parentID != null && !isUri(ev.parentID)) return 'parentID가 URI가 아님';
  if (ev.eventID != null && !isUri(ev.eventID)) return 'eventID가 URI가 아님';
  return null;
}
const epcsOf = (ev) => [...(ev.epcList ?? []), ...(ev.childEPCs ?? []), ...(ev.parentID ? [ev.parentID] : []), ...(ev.inputEPCList ?? []), ...(ev.outputEPCList ?? [])];
const short = (v) => String(v ?? '').replace(/^https?:\/\/ref\.gs1\.org\/cbv\/(BizStep|Disp)-/, '').replace(/^urn:epcglobal:cbv:(bizstep|disp):/, '');

export class EpcisStore {
  constructor({ max = 200000, onAdd = null } = {}) { this.events = []; this.ids = new Set(); this.max = max; this.onAdd = onAdd; this.seq = 0; this.captures = new Map(); this.capSeq = 0; this.stats = { captured: 0, duplicate: 0, rejected: 0 }; }
  get count() { return this.events.length; }
  // 문서 또는 이벤트 배열 → 접수 결과 (EPCIS 캡처 작업과 같은 꼴)
  capture(doc, now = new Date().toISOString()) {
    const list = Array.isArray(doc) ? doc : doc?.epcisBody?.eventList;
    if (!Array.isArray(list)) throw new Error('EPCISDocument(epcisBody.eventList)가 아닙니다');
    const errors = []; let accepted = 0, dup = 0;
    for (const ev of list) {
      const bad = lintEvent(ev); if (bad) { errors.push({ eventID: ev?.eventID ?? null, reason: bad }); this.stats.rejected++; continue; }
      if (ev.eventID && this.ids.has(ev.eventID)) { dup++; this.stats.duplicate++; continue; }
      const rec = { ...ev, recordTime: ev.recordTime ?? now, _seq: ++this.seq };
      this.add(rec); accepted++; this.stats.captured++; this.onAdd?.(rec);
    }
    const id = String(++this.capSeq), job = { captureID: id, createdAt: now, finishedAt: now, running: false, success: errors.length === 0, captureErrorBehaviour: 'proceed', accepted, duplicate: dup, errors };
    this.captures.set(id, job); if (this.captures.size > 500) this.captures.delete(this.captures.keys().next().value);
    return job;
  }
  add(rec) {
    this.events.push(rec); if (rec.eventID) this.ids.add(rec.eventID);
    if (this.events.length > this.max) { const o = this.events.shift(); if (o.eventID) this.ids.delete(o.eventID); }
  }
  // EPCIS 2.0 질의 매개변수 일부 (REST 질의와 같은 이름)
  query(params = {}) {
    const P = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
    const any = P.MATCH_anyEPC ? new Set(String(P.MATCH_anyEPC).split(',').map((s) => s.trim()).filter(Boolean)) : null;
    const step = P.EQ_bizStep ? new Set(String(P.EQ_bizStep).split(',').map(short)) : null, act = P.EQ_action ? new Set(String(P.EQ_action).split(',')) : null;
    const rp = P.EQ_readPoint ? new Set(String(P.EQ_readPoint).split(',')) : null, type = P.eventType ? new Set(String(P.eventType).split(',')) : null;
    const ge = P.GE_eventTime ? Date.parse(P.GE_eventTime) : null, lt = P.LT_eventTime ? Date.parse(P.LT_eventTime) : null;
    const ext = Object.entries(P).filter(([k]) => k.startsWith('EQ_mf:')).map(([k, v]) => [k.slice(3), String(v)]);
    const per = Math.max(1, Math.min(1000, Number(P.perPage) || 100)), after = Number(P.nextPageToken) || 0;
    const out = []; let next = null;
    for (const e of this.events) {
      if (e._seq <= after) continue;
      if (type && !type.has(e.type)) continue;
      if (any && !epcsOf(e).some((x) => any.has(x))) continue;
      if (step && !step.has(short(e.bizStep))) continue;
      if (act && !act.has(e.action)) continue;
      if (rp && !rp.has(e.readPoint?.id)) continue;
      if (ge != null || lt != null) { const t = Date.parse(e.eventTime); if ((ge != null && t < ge) || (lt != null && t >= lt)) continue; }
      if (ext.length && !ext.every(([k, v]) => String(e[k] ?? '') === v)) continue;
      if (out.length >= per) { next = String(out.at(-1)._seq); break; }
      out.push(e);
    }
    return { '@context': EPCIS_CONTEXT, type: 'EPCISQueryDocument', schemaVersion: '2.0', creationDate: new Date().toISOString(),
      epcisBody: { queryResults: { queryName: 'SimpleEventQuery', resultsBody: { eventList: out.map(({ _seq, ...e }) => e) } } }, ...(next ? { nextPageToken: next } : {}) };
  }
  // 추적 사슬: 시리얼(또는 SSCC) → 그 ID의 이벤트 + 묶인 팔레트(부모 SSCC)의 출하 이벤트 · SSCC면 묶인 시리얼까지 — 시간순
  trace(id) {
    const ids = new Set([id]);
    for (const e of this.events) if (e.type === 'AggregationEvent' && e.parentID && ((e.childEPCs ?? []).includes(id) || e.parentID === id)) { ids.add(e.parentID); if (e.parentID === id) for (const c of e.childEPCs ?? []) ids.add(c); }
    return this.events.filter((e) => epcsOf(e).some((x) => ids.has(x))).sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime)).map(({ _seq, ...e }) => e);
  }
  // 트럭(출하 bizTransaction) → 실린 팔레트 SSCC → 시리얼 (리콜 범위)
  // shipmentId = 출하 ID(SHP-…) — 예전 기록은 트럭 이름이 곧 출하 ID
  shipmentOf(shipmentId) {
    const bt = shipment(shipmentId), pals = new Set(); let truck = null;
    for (const e of this.events) if (short(e.bizStep) === 'shipping' && (e.bizTransactionList ?? []).some((b) => b.bizTransaction === bt)) { truck ??= e['mf:truck'] ?? null; for (const x of e.epcList ?? []) pals.add(x); }
    const serials = new Set(); for (const e of this.events) if (e.type === 'AggregationEvent' && pals.has(e.parentID)) for (const c of e.childEPCs ?? []) serials.add(c);
    return { shipment: shipmentId, truck: truck ?? shipmentId, pallets: [...pals], serials: [...serials] };
  }
  get(id) { return this.captures.get(String(id)) ?? null; }
}
export const productOfEpc = (epc) => { const m = /sgtin:\d+\.0(\d{5})\./.exec(epc ?? ''); return m ? Object.entries(PRODUCTS).find(([, v]) => v.ref === m[1])?.[0] ?? null : null; };
