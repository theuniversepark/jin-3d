// 시리얼·마킹·출하 추적 + 샘플 NG 봉쇄·처분 (MES 시리얼 서비스) — 2단 ID
//  · WIP ID: 투입 순간 부여 (WIP-DT-YYMMDD-000123) — 공정 이력은 이 ID로 쌓는다
//  · 제품 시리얼: 최종 검사 합격 순간 중앙 발행기가 GTIN별 순차 발행 (DT-YYMMDD-000045 · 재사용 없음 · GS1 AI 21)
//      발행 자리 = 검사·포장셀(PACK) — 정밀조립Zone 하나뿐인 이 시뮬레이터에서는 마킹도 판정도 이 셀에서 닫힌다
//  · 마킹: 라벨 = QR + GS1 Digital Link (ISO/IEC 18004) (금속 직접 각인용 GS1 DataMatrix 인코더는 js/codes.js에 있고 제품 마스터 symbol 'DM'이면 쓴다 — 지금 제품은 모두 라벨)
//      마킹 직후 100% 판독 검증 — 등급 C 이상 합격 (라벨 ISO/IEC 15415), 실패 시 1회 재마킹, 다시 실패하면 부적합
//      마킹 시간은 셀 사이클 안에서 병렬 처리 (판정 순간 출력 시작) — 재마킹만 사이클에 더해진다
//  · 출하: 팔레트마다 SSCC(AI 00 · GS1-128 · ISO 15394) — 팔레트 ↔ 시리얼 묶음(EPCIS AggregationEvent) · 트럭 · 출하 시각
//  · 출하 전 샘플 재검 (검사·포장셀 최종 검사대 — 상위 meta-factory의 정밀검사Zone 샘플링 자리): 적재 양품 N개마다 1개를 샘플로 지정하는 순간
//    그 로트(직전 샘플 이후 같은 제품) 출하 보류 → OK면 해제 · NG면 봉쇄(로트 + 같은 시간대 ±10분) →
//    부적합품 처리 판정(MRB: 재작업 → 재검 합격 시 시리얼 유지 · 폐기 → 시리얼 폐기 기록) · 로트 선별검사 · 샘플링 강화(ISO 2859-1 까다로운 검사 단순화) · 8D는 capa.js
// 렌더링과 분리 — 헤드리스 시험에서도 같은 흐름. 시뮬레이션 난수(sim.rand)를 쓰지 않는다 (자기 난수) — 생산 흐름이 그대로다.
import { qrMatrix, dataMatrix, FNC1, GS } from './codes.js';
import { SerialAllocator, reserveVia } from './serialalloc.js';

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export const GS1_PREFIX = '8800000';   // 가상 GS1 업체코드 (880 = 대한민국) — 시뮬레이션용
export const DL_HOST = 'https://id.meta-factory.example';   // GS1 Digital Link 도메인 (가상 — .example 예약 도메인)
// 제품 마스터: 코드 · 품목 참조(GTIN) · Zone · 마킹 방식 · 발행 셀
export const PRODUCTS = {
  doortrim: { code: 'DT', ref: '00001', zone: 'main', label: '도어트림', symbol: 'QR', cells: ['PACK'] },
  eaxle: { code: 'EA', ref: '00002', zone: 'main', label: 'e-axle', symbol: 'QR', cells: ['PACK'] },
};
export const ZONE_KO = { main: '정밀조립' };
export const MARK_CELL = { main: ['PACK'] };
export const MARK_INFO = {
  QR: { name: 'QR 코드 라벨 (GS1 Digital Link)', std: 'ISO/IEC 18004 · 인쇄 품질 ISO/IEC 15415', how: '라벨 출력·자동 부착', sec: 3 },
  DM: { name: 'GS1 DataMatrix 레이저 각인 (DPM)', std: 'ISO/IEC 16022 ECC200 · 각인 판독 ISO/IEC TR 29158 · AIAG B-17', how: '레이저 직접 각인', sec: 6 },
};
const VERIFY_SEC = 1;
const GRADES = ['A', 'B', 'C', 'D', 'F'];
// 운영 단계별 판단·작업 시간 (초): 샘플 재검(검사·포장셀 최종 검사대 — 레거시 수동 측정 · 자동화 비전·측정 · 피지컬AI AI 판정) · 처분 판정(MRB — 레거시 품질 회의 · 자동화 규칙 · 피지컬AI Quality & Recovery Agent) · 선별검사 1개 · 재작업
export const SAMPLE_N = 30;          // 적재 양품 N개마다 1개 샘플 (상위 meta-factory 정밀조립 샘플 주기와 같게)
export const SAMPLE_T = { traditional: 600, smart: 240, dark: 120 };
export const SAMPLE_NG = 0.04;       // 샘플 재검에서만 드러나는 결함(외관·라벨·치수) 확률 — 설계 가정 (체결 검사를 빠져나간 실제 유출 불량은 늘 NG)
export const MRB_T = { traditional: 1800, smart: 300, dark: 60 };
export const SORT_T = { traditional: 60, smart: 30, dark: 20 };
export const REWORK_T = { traditional: 900, smart: 600, dark: 480 };
export const REWORK_RATE = { main: 0.7 };   // 처분: 재작업 가능 비율 (조립품은 분해해 부품 교체) — 설계 가정
export const WINDOW_S = 600;         // 봉쇄 범위: 샘플과 같은 시간대 ±10분
export const TIGHT_N = 3;            // 샘플링 강화: NG 뒤 다음 샘플 3회 N/2 · 3회 연속 OK면 정상 복귀

// GS1 모듈러스 10 검사 숫자
export function gs1Check(d) { let s = 0; for (let i = d.length - 1, w = 3; i >= 0; i--, w = 4 - w) s += Number(d[i]) * w; return String((10 - (s % 10)) % 10); }
export const gtinOf = (p) => { const b = `0${GS1_PREFIX}${PRODUCTS[p]?.ref ?? '00009'}`; return b + gs1Check(b); };
export const ssccOf = (n) => { const b = `0${GS1_PREFIX}${String(n).padStart(9, '0')}`; return b + gs1Check(b); };
// 내용: QR = GS1 Digital Link (경로 01 → 10 → 21 · 생산일 11은 쿼리) · DataMatrix = FNC1 + 고정 길이 AI(01·11) 먼저, 가변 길이(21) 뒤 GS, 마지막 10
export function payloadOf(u) {
  const P = PRODUCTS[u.product], gtin = gtinOf(u.product), hri = `(01)${gtin}(11)${u.pdate}(21)${u.serial}(10)${u.plot}`;
  const data = P?.symbol === 'DM' ? `${FNC1}01${gtin}11${u.pdate}21${u.serial}${GS}10${u.plot}` : `${DL_HOST}/01/${gtin}/10/${encodeURIComponent(u.plot)}/21/${encodeURIComponent(u.serial)}?11=${u.pdate}`;
  return { symbol: P?.symbol ?? 'QR', data, hri, gtin };
}
export function matrixOf(u) { const p = payloadOf(u); return p.symbol === 'DM' ? dataMatrix(p.data) : qrMatrix(p.data); }
// SVG (어두운 모듈 = 한 경로) — 화면 창에 그대로 넣는다 (캔버스 없이 · 헤드리스에서도 만든다)
export function codeSVG(m, px = 3, quiet = 2) {
  const n = m.length, W = (n + quiet * 2) * px; let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${n + quiet * 2} ${n + quiet * 2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export class SerialHub {
  constructor(sim, seed = 1) {
    this.sim = sim; this.r = mulberry((seed * 69069 + 17) >>> 0);
    this.ymd = sim.trace?.ymd ?? (() => { const d = new Date(); return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; })();
    this.wipSeq = {}; this.serSeq = {}; this.lotSeq = 0; this.sampleSeq = 0; this.sinceSample = 0; this.unsampled = {};
    this.ctr = { pal: 0, ship: 0 };   // 팔레트 SSCC · 출하 ID 일련번호 — 웹 버전(main.js)이 실행 사이에 공유하는 객체로 바꿔 끼운다 (단계 전환·리셋해도 재사용 금지)
    this.alloc = null; this.waitIssue = []; this.shipFree = [];   // 앱(서버 있음): 서버가 예약해 준 번호 범위 배정기 (js/serialalloc.js) · 번호를 기다리는 발행 보류 · 잡아 두고 안 쓴 출하 번호
    this.units = []; this.byId = new Map(); this.fg = {}; this.lots = []; this.pallets = []; this.events = []; this.jobs = [];
    this.byCell = {}; this.tight = {}; this.lastSample = {}; this.feed = []; this.feedOn = false;
    this.stats = { wip: 0, issued: 0, byZone: { main: 0 }, relabel: 0, markNg: 0, shipped: 0, pallets: 0, lots: 0, held: 0, released: 0, sorted: 0, caught: 0, rework: 0, scrap: 0, recall: 0, samples: 0, sampleNg: 0, deferred: 0 };
    sim.serials = this;
  }
  get mode() { return this.sim.mode?.key ?? 'smart'; }
  now() { return this.sim.time ?? 0; }
  later(dt, fn) { this.jobs.push({ at: this.now() + dt, fn }); }
  update() { if (this.alloc) { this.alloc.pump(); if (this.waitIssue.length) this.issueWaiting(); } if (!this.jobs.length) return; const t = this.now(), due = this.jobs.filter((j) => j.at <= t); if (!due.length) return; this.jobs = this.jobs.filter((j) => j.at > t); for (const j of due) j.fn(); }
  // 기록 하나 (EPCIS 이벤트 ID urn:uuid 포함) — feed: 화면이 가져가 EPCIS 저장소(앱 내장 · 브라우저 메모리)로 보낸다 (js/epcis.js)
  ev(e) { const r = { t: this.now(), uid: uid(), ...e }; this.events.push(r); if (this.events.length > 4000) this.events.shift(); if (this.feedOn) { this.feed.push(r); if (this.feed.length > 20000) this.feed.shift(); } }
  drain() { const f = this.feed; this.feed = []; return f; }
  log(lv, title, x) { if (!this.sim.quiet) this.sim.log?.(lv, title, x); }
  idOf(u) { return u.serial ?? u.wip; }
  q(type, payload) { this.sim.fac?.qual?.(type, payload); }   // 품질 기록 → FAC 이벤트 → (앱) ERPNext 품질 모듈 (server/erpnext-bridge.mjs)

  // ── 번호 배정 (앱 — 서버 있음) ─────────────────
  // 서버가 예약해 준 범위 안에서만 번호를 쓴다 — 응답 전 · 실패 중에는 발행을 보류한다(생산은 그대로 흐름). 웹 버전 · 헤드리스는 배정기 없이 자체 카운터
  serverAllocator(fetchImpl, opt) { return new SerialAllocator(reserveVia(fetchImpl), opt); }
  useAllocator(a) { this.alloc = a; a.setYmd(this.ymd); a.prime([...new Set(Object.values(PRODUCTS).map((p) => `ser:${p.code}`)), 'pal', 'ship']); return a; }
  allocState() { return allocState(this); }
  nextNo(kind, code) { return this.alloc ? this.alloc.next(kind, code) : kind === 'ser' ? (this.serSeq[code] = (this.serSeq[code] ?? 0) + 1) : ++this.ctr[kind]; }
  // 번호를 기다리던 제품 — 합격 순서대로 이어서 발행 (번호가 없는 제품코드는 이번에는 건너뜀)
  issueWaiting() {
    const dry = new Set();
    this.waitIssue = this.waitIssue.filter((u) => {
      if (u.serial || this.byId.get(u.wip) !== u) return false;
      const c = PRODUCTS[u.product]?.code ?? 'WP'; if (dry.has(c)) return true;
      this.issue(u, u.serialWait); if (!u.serial) dry.add(c);
      return !u.serial;
    });
  }

  // ── 1단: WIP ID (투입) ─────────────────
  wipId(product) { const c = PRODUCTS[product]?.code ?? 'WP', n = (this.wipSeq[c] = (this.wipSeq[c] ?? 0) + 1); this.stats.wip++; return `WIP-${c}-${this.ymd}-${String(n).padStart(6, '0')}`; }
  // trace.js 계보 기록(r)을 그대로 단위로 쓴다
  adopt(r, zone = 'main') { Object.assign(r, { zone, serial: null, epc: null, loc: 'line', hold: r.hold ?? null, mark: null, ship: null, disp: null }); this.add(r); return r; }
  add(u) {
    this.units.push(u); this.byId.set(u.wip, u);
    if (this.units.length > 6000) {   // 오래된 것부터 — 출하·폐기·격리가 끝난 것만 지운다 (재고·보류·공정 중은 남김)
      const i = this.units.findIndex((o) => (o.loc === 'shipped' || o.loc === 'scrap' || o.loc === 'quarantine') && !o.hold);
      if (i >= 0) { const [o] = this.units.splice(i, 1); this.byId.delete(o.wip); if (o.serial) this.byId.delete(o.serial); }
    }
  }
  unitOf(item) { return item ? this.byId.get(item.wip ?? item.serial) ?? null : null; }

  // ── 2단: 제품 시리얼 (최종 검사 합격) + 마킹·판독 검증 ─────────────────
  isMarkCell(zone, cellId) { return (MARK_CELL[zone] ?? []).includes(cellId); }
  // 셀 작업 시작 때 마킹·판독 결과를 미리 정한다 (재마킹 시간만 사이클에 더함 — 첫 마킹은 판정과 병렬)
  plan(item) {
    const u = this.unitOf(item); if (!u || u.serial || u.mplan) return 0;
    const sym = PRODUCTS[u.product]?.symbol ?? 'QR', fail1 = this.r() < 0.005, fail2 = fail1 && this.r() < 0.1;
    const grade = (bad) => (bad ? (this.r() < 0.5 ? 'D' : 'F') : this.r() < 0.72 ? 'A' : this.r() < 0.8 ? 'B' : 'C');
    u.mplan = { sym, tries: fail1 ? 2 : 1, grades: fail1 ? [grade(true), grade(fail2)] : [grade(false)], ng: fail2 };
    return fail1 ? MARK_INFO[sym].sec + VERIFY_SEC : 0;
  }
  issue(item, at) {
    const u = this.unitOf(item); if (!u || u.serial) return u;
    if (!u.mplan) this.plan(item);
    const P = PRODUCTS[u.product], c = P?.code ?? 'WP', n = this.nextNo('ser', c), t = this.now();
    if (n == null) { if (!u.serialWait) { u.serialWait = { cell: at.cell, name: at.name }; this.waitIssue.push(u); this.stats.deferred++; } return u; }   // 서버 번호 범위가 아직 없음 — 발행 보류 (issueWaiting이 이어서 발행 · 그동안 출하 대상에서 뺀다)
    const late = !!u.serialWait; delete u.serialWait;
    u.serial = `${c}-${this.ymd}-${String(n).padStart(6, '0')}`;
    u.pdate = this.ymd; u.plot = `${this.ymd}${c}`; u.gtin = gtinOf(u.product);
    u.epc = `urn:epc:id:sgtin:${GS1_PREFIX}.0${P?.ref ?? '00009'}.${u.serial}`;
    u.tSerial = t; this.byId.set(u.serial, u); if (u.zone === 'main') this.sim.trace?.byId.set(u.serial, u);
    const pl = u.mplan, g = pl.grades.at(-1), sym = pl.sym;
    u.mark = { symbol: sym, at: at.cell, atName: at.name ?? at.cell, zone: u.zone, t, tries: pl.tries, grades: pl.grades, grade: g, ok: !pl.ng, ...(({ data, hri }) => ({ data, hri }))(payloadOf(u)) };
    delete u.mplan;
    this.stats.issued++; this.stats.byZone[u.zone] = (this.stats.byZone[u.zone] ?? 0) + 1; if (pl.tries > 1) this.stats.relabel++;
    const bc = (this.byCell[`${u.zone}:${at.cell}`] ??= { n: 0, relabel: 0, ng: 0, last: null, grades: {} }); bc.n++; if (pl.tries > 1) bc.relabel++; bc.last = u; bc.grades[g] = (bc.grades[g] ?? 0) + 1;
    this.ev({ type: 'commission', id: u.serial, wip: u.wip, zone: u.zone, cell: at.cell, symbol: sym, grade: g });
    if (pl.tries > 1) this.log('warn', `${ZONE_KO[u.zone]} ${at.name ?? at.cell} 판독 등급 ${pl.grades[0]} — ${sym === 'DM' ? '재각인' : '라벨 재부착'}`, { obs: `${u.serial} 첫 판독 ${pl.grades[0]} (합격 C 이상)`, act: pl.ng ? `재${sym === 'DM' ? '각인' : '부착'} 후에도 ${g} — 부적합 처리` : `재마킹 후 ${g} 합격` });
    if (pl.ng) this.markNg(u, bc);
    if (late && u.loc === 'fg') { this.ev({ type: 'store', id: u.serial, zone: u.zone }); this.sampleTick(u); }   // 보류된 사이 이미 적재됨 — 적재 기록 · 샘플 계수를 지금
    return u;
  }
  // 재마킹 후에도 판독 불가 — 라벨은 수작업 재부착 후 해제, 금속 각인은 재각인 불가(표면 손상) → 폐기
  markNg(u, bc) {
    this.stats.markNg++; bc.ng++; u.hold = 'mark'; u.mark.ok = false;
    this.later(MRB_T[this.mode] / 3, () => {
      if (u.hold !== 'mark') return;
      if (u.mark.symbol === 'QR') { u.hold = null; u.mark.grades.push('B'); u.mark.grade = 'B'; u.mark.ok = true; u.mark.manual = true; this.ev({ type: 'relabel', id: u.serial }); }
      else if (u.loc === 'line') u.scrapPending = '각인 판독 불가 — 재각인 시 표면 손상';   // 아직 운반 중 — 적재장에 닿으면 폐기 (재고로 잡히지 않게)
      else this.scrap(u, '각인 판독 불가 — 재각인 시 표면 손상');
    });
  }
  // 완제품 적재 (적재장·포장 팔레트 도착)
  toFG(item) {
    const u = item?.wip || item?.serial ? this.unitOf(item) : item; if (!u || u.loc === 'fg') return u;
    u.loc = 'fg'; (this.fg[u.product] ??= []).push(u);
    if (u.serial) this.ev({ type: 'store', id: u.serial, zone: u.zone });
    if (u.scrapPending) { const why = u.scrapPending; delete u.scrapPending; this.later(0, () => this.scrap(u, why)); }   // 다음 갱신에 (적재 수량이 먼저 올라간 뒤 뺀다)
    this.sampleTick(u);
    return u;
  }

  // ── 출하 (shipping.js): 보류 아닌 것만 · 팔레트 SSCC ─────────────────
  // 앱: 팔레트 SSCC · 출하 ID 번호가 없으면(서버 범위 대기) 출하도 보류 · 시리얼 발행을 기다리는 제품은 싣지 않는다
  shippableUnits(p) {
    if (this.alloc && !(this.alloc.left('pal') > 0 && (this.shipFree.length || this.alloc.left('ship') > 0))) { this.alloc.pump(); return []; }
    return (this.fg[p] ?? []).filter((u) => !u.hold && !u.serialWait && u.loc === 'fg' && u.status !== 'scrap' && u.status !== 'ng');
  }
  shippable(p) { return this.shippableUnits(p).length; }
  heldIn(p) { return (this.fg[p] ?? []).filter((u) => u.hold).length; }
  take(p, k, by) {
    const us = this.shippableUnits(p).slice(0, k); if (!us.length) return null;
    const pal = { sscc: ssccOf(this.nextNo('pal')), product: p, units: us.map((u) => this.idOf(u)), t: this.now(), by, truck: null };
    if (this.alloc) pal.shipNo = this.shipFree.shift() ?? this.alloc.next('ship');   // 출하 번호도 지금 잡아 둔다 — 도크에서 번호가 없어 출하 기록이 멈추지 않게
    for (const u of us) { u.loc = 'loading'; this.unFG(u); u.ship = { sscc: pal.sscc }; }
    this.pallets.unshift(pal); if (this.pallets.length > 300) this.pallets.pop();
    this.ev({ type: 'aggregate', id: pal.sscc, children: pal.units });
    return { pal, units: us };
  }
  // 출하 ID: 트럭 한 번 출발 = 출하 1건. 트럭 표시 이름(화물트럭-N)은 실행마다 다시 시작하므로 거래 식별자로 쓰지 않는다
  shipmentId(t, pal = null) {
    if (!t.shipId) {
      const n = this.alloc ? pal?.shipNo ?? this.shipFree.shift() ?? this.alloc.next('ship') : ++this.ctr.ship; if (n == null) return null;
      if (pal && n === pal.shipNo) pal.shipNo = null;
      t.shipId = `SHP-${this.ymd}-${String(n).padStart(5, '0')}`;
    }
    if (pal?.shipNo != null) { this.shipFree.push(pal.shipNo); pal.shipNo = null; }   // 트럭에 이미 출하 ID가 있음 — 잡아 둔 번호는 다음 팔레트가 쓴다
    return t.shipId;
  }
  ship(lot, t) {
    if (!lot) return; const truck = t?.id ?? String(t), shipment = typeof t === 'object' ? this.shipmentId(t, lot.pal) : truck;
    Object.assign(lot.pal, { truck, shipment, tShip: this.now() }); this.stats.pallets++;
    for (const u of lot.units) { u.loc = 'shipped'; u.ship = { sscc: lot.pal.sscc, truck, shipment, t: this.now() }; this.stats.shipped++; }
    this.ev({ type: 'ship', id: lot.pal.sscc, truck, shipment, n: lot.units.length });
  }
  // 출하 1건에 실린 팔레트 SSCC · 시리얼 — FAC 출고 확정 이벤트에 그대로 싣는다 (EPCIS 업로드 순서와 무관하게 ERPNext 출하 전표에)
  shipmentContent(shipment) {
    const P = this.pallets.filter((p) => p.shipment === shipment);
    return { shipment, truck: P[0]?.truck ?? null, sscc: P.map((p) => p.sscc), serials: P.flatMap((p) => p.units) };
  }
  unload(lot) { if (!lot) return; if (lot.pal.shipNo != null) { this.shipFree.push(lot.pal.shipNo); lot.pal.shipNo = null; } for (const u of lot.units) { u.loc = 'fg'; u.ship = null; (this.fg[u.product] ??= []).unshift(u); } this.pallets = this.pallets.filter((x) => x !== lot.pal); }
  unFG(u) { const q = this.fg[u.product]; if (!q) return; const i = q.indexOf(u); if (i >= 0) q.splice(i, 1); }
  // 완제품 수량에서 빼기 (폐기·격리) — 구분 적재장
  dropStock(u) {
    if (u.loc !== 'fg') return;
    this.unFG(u); const s = this.sim;
    if (s.fgBy?.[u.product] > 0) s.fgBy[u.product]--; if (s.fgStock > 0) s.fgStock--;
  }

  // ── 출하 전 샘플 재검 (검사·포장셀 최종 검사대) ─────────────────
  // 상위 meta-factory에서는 정밀검사Zone이 AMR로 샘플을 가져가 판정한다. 이 시뮬레이터에는 그 Zone이 없어 시리얼 서비스가 직접 닫는다:
  // 적재 양품 N개마다 샘플 지정(로트 출하 보류) → 재검 시간 뒤 판정 → OK 해제 / NG 봉쇄·처분·8D. 샘플은 적재장에 보류 상태로 남는다(운반 없음)
  sampleEvery(zone, base = SAMPLE_N) { return this.tight[zone] > 0 ? Math.max(1, Math.round(base / 2)) : base; }
  sampleTick(u) {
    if (u.zone !== 'main' || !u.serial) return;
    this.sinceSample++; this.unsampled[u.product] = (this.unsampled[u.product] ?? 0) + 1;
    if (this.sinceSample < this.sampleEvery('main')) return;
    const U = this.unsampled, q = Object.keys(U).reduce((a, b) => (U[b] > U[a] ? b : a));   // 마지막 샘플 뒤로 가장 많이 만든 제품 (혼류 비율대로 고르게)
    const req = { id: `QS-${String(this.sampleSeq + 1).padStart(4, '0')}`, zone: 'main', product: q, t0: this.now() };
    if (!this.sample(req)) return;   // 지정할 재고가 없으면(모두 보류·출하) 다음 적재 때 다시
    this.sampleSeq++; this.sinceSample = 0; U[q] = 0; this.stats.samples++;
    this.later(SAMPLE_T[this.mode], () => this.judge(req));
  }
  // 판정: 체결 전수 검사를 빠져나간 실제 유출 불량이면 NG · 그 밖에 재검에서만 드러나는 결함(설계 가정 확률)
  judge(req) {
    const lot = this.lotOf(req.id), s = lot ? this.byId.get(lot.sample) : null; if (!lot || lot.result) return;
    const res = s?.status === 'escaped' || this.r() < SAMPLE_NG ? 'ng' : 'ok';
    this.result(req, res);
    if (res !== 'ng') return;
    this.stats.sampleNg++;
    this.log('warn', `출하 전 샘플 재검 NG — ${PRODUCTS[lot.product]?.label} ${lot.sample}`, { obs: `검사·포장셀 최종 검사대 재검 · 샘플 ${lot.id}`, dec: '로트 봉쇄(출하 보류) · 처분 판정(MRB)', act: `로트 ${lot.members.length + 1}개 + 같은 시간대 ±10분 ${lot.extra.length}개 보류 · 유출 의심 ${lot.recall.length}개 회수 대상 · 샘플링 강화` });
    if (s) this.sim.trace?.openSampleCase?.(s, req);   // 계보로 원인 분석 · 8D CAPA (js/trace.js · js/capa.js)
  }
  // 샘플 지정 + 로트 출하 보류 (요청 순간 · 판정 전 출하 금지)
  sample(req) {
    const key = `${req.zone}:${req.product}`, q = this.fg[req.product] ?? [];
    const s = q.findLast((u) => !u.hold && !u.sampled && u.zone === req.zone && (u.status === 'ok' || u.status === 'escaped'));
    if (!s) return null;
    s.sampled = req.id; s.hold = 'sample';
    const t0 = this.lastSample[key] ?? -Infinity; this.lastSample[key] = this.now();
    const lotU = q.filter((u) => u !== s && u.zone === req.zone && !u.hold && (u.tSerial ?? u.tEnd ?? 0) > t0);
    for (const u of lotU) u.hold = `lot:${req.id}`;
    const shipped = this.units.filter((u) => u.zone === req.zone && u.product === req.product && u.loc === 'shipped' && (u.tSerial ?? 0) > t0).length;
    const lot = { id: req.id, zone: req.zone, product: req.product, sample: this.idOf(s), members: lotU.map((u) => this.idOf(u)), shippedBefore: shipped, t: this.now(), status: 'hold', result: null, tEnd: null, extra: [], recall: [], sorted: null };
    this.lots.unshift(lot); if (this.lots.length > 200) this.lots.pop();
    this.stats.lots++; this.stats.held += lotU.length + 1;
    this.ev({ type: 'hold', id: req.id, zone: req.zone, n: lotU.length + 1, ids: [s, ...lotU].map((u) => this.idOf(u)) });
    this.q('q.sample.req', { key: req.id, zone: req.zone, product: req.product, serial: this.idOf(s) });   // 샘플 지정 (구분 적재장 · 재검 대기)
    this.fosNote(req.zone, 'quality.hold', `샘플 ${req.id} 로트 출하 보류 ${lotU.length + 1}개 — ${PRODUCTS[req.product]?.label} (판정 전 출하 금지)`, { lot: req.id, n: lotU.length + 1 });
    return s;
  }
  lotOf(id) { return this.lots.find((l) => l.id === id) ?? null; }
  // 판정 결과
  result(req, res) {
    const lot = this.lotOf(req.id), s = lot ? this.byId.get(lot.sample) : null; if (!lot || lot.result) return;
    lot.result = res; const T = this.tight[lot.zone] ?? 0;
    this.q('q.sample', { key: lot.id, zone: lot.zone, product: lot.product, serial: lot.sample, result: res === 'ng' ? 'NG' : 'OK', lot: lot.members.length + 1 });
    if (res !== 'ng') {
      const n = this.releaseLot(lot); if (s && s.hold === 'sample') s.hold = null;
      lot.status = 'released'; lot.tEnd = this.now(); this.stats.released += n + (s ? 1 : 0);
      this.ev({ type: 'release', id: lot.id, zone: lot.zone, result: 'OK', ids: [lot.sample, ...lot.members] });
      if (T > 0) { this.tight[lot.zone] = T - 1; if (T === 1) this.log('info', `${ZONE_KO[lot.zone]} 샘플링 정상 복귀`, { obs: `강화 검사 ${TIGHT_N}회 연속 OK`, act: '샘플링 주기 원래대로' }); }
      return;
    }
    // NG: 샘플 격리 · 봉쇄 범위 확대(같은 시간대 ±10분) · 출하된 것 = 유출 의심(회수 대상) · 샘플링 강화
    lot.status = 'contain'; this.tight[lot.zone] = TIGHT_N;
    if (s) s.hold = 'sample-ng';
    const ts = s?.tSerial ?? this.now();
    for (const u of this.fg[lot.product] ?? []) if (!u.hold && u.zone === lot.zone && Math.abs((u.tSerial ?? 0) - ts) <= WINDOW_S) { u.hold = `lot:${lot.id}`; lot.extra.push(this.idOf(u)); }
    lot.recall = this.units.filter((u) => u.zone === lot.zone && u.product === lot.product && u.loc === 'shipped' && (u.tSerial ?? 0) > ts - WINDOW_S && (u.tSerial ?? 0) <= ts + WINDOW_S).map((u) => this.idOf(u));
    for (const id of lot.recall) { const u = this.byId.get(id); if (u && !u.recall) { u.recall = lot.id; this.stats.recall++; } }
    this.stats.held += lot.extra.length;
    if (lot.extra.length) this.ev({ type: 'hold', id: lot.id, zone: lot.zone, n: lot.extra.length, ids: lot.extra, why: `샘플 ${lot.sample} NG — 같은 시간대 ±10분 봉쇄` });
    this.fosNote(lot.zone, 'quality.hold', `샘플 ${lot.id} NG — 봉쇄 ${lot.members.length + lot.extra.length + 1}개 (±10분 ${lot.extra.length}개 추가) · 유출 의심 ${lot.recall.length}개 회수 대상`, { lot: lot.id, n: lot.members.length + lot.extra.length + 1, recall: lot.recall.length });
    // 처분 판정(MRB) → 샘플 처분 · 로트 선별검사
    const mrb = MRB_T[this.mode];
    this.later(mrb, () => { if (s) this.dispose(s, lot, '샘플'); this.sortLot(lot); });
  }
  releaseLot(lot) { let n = 0; for (const u of this.units) if (u.hold === `lot:${lot.id}`) { u.hold = null; n++; } return n; }
  // 선별검사(전수): 실제 유출 불량(체결 검사를 빠져나간 것)을 잡는다
  sortLot(lot) {
    const us = this.units.filter((u) => u.hold === `lot:${lot.id}`), dt = us.length * SORT_T[this.mode];
    lot.status = 'sorting'; lot.sortEnd = this.now() + dt;
    this.later(dt, () => {
      let ok = 0, bad = 0; const okIds = [];
      for (const u of us) {
        if (u.hold !== `lot:${lot.id}`) continue;
        const defect = u.status === 'escaped';
        if (!defect) { u.hold = null; ok++; okIds.push(this.idOf(u)); continue; }
        bad++; this.stats.caught++;
        this.catchEscaped(u, lot);
      }
      this.stats.sorted += us.length; this.stats.released += ok;
      if (okIds.length) this.ev({ type: 'release', id: lot.id, zone: lot.zone, result: '선별검사 양품', ids: okIds });
      lot.sorted = { n: us.length, ok, bad, t: this.now() }; lot.status = 'done'; lot.tEnd = this.now();
      this.q('q.lot', { key: lot.id, zone: lot.zone, product: lot.product, sorted: lot.sorted, extra: lot.extra.length, recall: lot.recall.length });
      this.fosNote(lot.zone, 'quality.disposition', `로트 ${lot.id} 선별검사 ${us.length}개 — 양품 ${ok} 해제 · 불량 ${bad}`, { lot: lot.id, ok, bad });
    });
  }
  // 유출 불량 회수 (capa.js recheck와 같은 정산 — 회수품은 NG로)
  catchEscaped(u, lot) {
    const T = this.sim.trace; this.dropStock(u);
    u.status = 'ng'; u.recovered = lot.id; u.hold = null; u.loc = 'quarantine';
    if (T) { T.stats.escaped--; T.stats.ng++; T.stats.recovered = (T.stats.recovered ?? 0) + 1; }
    this.ev({ type: 'quarantine', id: this.idOf(u), lot: lot.id });
    this.q('q.disp', { key: this.idOf(u), lot: lot.id, zone: u.zone, product: u.product, d: 'scrap', why: '선별검사 — 유출 불량 회수 (격리)', sample: false });
  }
  // 처분 판정 (MRB): 재작업 → 재검 합격 시 시리얼 유지 · 폐기 → 시리얼 폐기(재사용 금지)
  dispose(u, lot, why) {
    const rw = this.r() < (REWORK_RATE[u.zone] ?? 0.5), how = '분해·부품 교체';
    const isSample = lot?.sample === this.idOf(u);
    if (!rw) { this.scrap(u, `${why} — 재작업 불가`, lot, isSample); return; }
    u.hold = 'rework'; u.disp = { d: 'rework', why, t: this.now() }; this.stats.rework++;
    this.q('q.disp', { key: this.idOf(u), lot: lot?.id ?? null, zone: u.zone, product: u.product, d: 'rework', why: `${why} — ${how}`, sample: isSample });
    this.ev({ type: 'rework', id: this.idOf(u), lot: lot?.id });
    this.later(REWORK_T[this.mode], () => {
      if (u.hold !== 'rework') return;
      u.hold = null; u.disp.done = this.now();
      if (u.status === 'escaped') { u.status = 'ok'; }   // 재작업으로 고쳤다 (정답 라벨 유지 — RCA 통계는 그대로)
      this.ev({ type: 'recheck', id: this.idOf(u), result: 'OK' });
      this.q('q.disp', { key: this.idOf(u), lot: lot?.id ?? null, zone: u.zone, product: u.product, d: 'rework.done', why: `재작업(${how}) → 재검 합격 · 시리얼 유지`, sample: isSample });
      this.fosNote(u.zone, 'quality.disposition', `재작업 ${this.idOf(u)} (${how}) → 재검 합격 · 시리얼 유지 · 출하 보류 해제`, { id: this.idOf(u), d: 'rework' });
    });
  }
  scrap(u, why, lot = null, isSample = false) {
    if (u.loc === 'fg') this.q('q.disp', { key: this.idOf(u), lot: lot?.id ?? null, zone: u.zone, product: u.product, d: 'scrap', why, sample: isSample });   // 구분 적재장에 있던 것만 ERPNext 재고 출고
    this.dropStock(u); if (u.loc !== 'shipped') u.loc = 'scrap';
    u.status = 'scrap'; u.hold = null; u.disp = { d: 'scrap', why, t: this.now() }; this.stats.scrap++;
    this.ev({ type: 'decommission', id: this.idOf(u), why });
    this.fosNote(u.zone, 'quality.disposition', `폐기 ${this.idOf(u)} — ${why} · 시리얼 폐기 기록 (재사용 금지)`, { id: this.idOf(u), d: 'scrap' });
  }
  // 오케스트레이터 메시지 (존 → 공장 · 상태 보고 이벤트) — 공장 오케스트레이터(FacOS)가 있을 때만
  fosNote(zone, type, text, body = {}) { const F = this.sim.fos; if (!F?.bus) return; F.bus.send(`zone:${zone}`, 'factory', type, { body, text }); }

  // ── 집계 ─────────────────
  zoneCounts(zone) {
    const k = Math.floor(this.now() * 2), C = (this.zcCache ??= {});   // 화면이 자주 부른다 — 시뮬레이션 0.5초 단위로 한 번만 센다
    if (C[zone]?.k === k && C[zone].n === this.units.length) return C[zone].v;
    let hold = 0, scrap = 0, rework = 0, shipped = 0;
    for (const u of this.units) { if (u.zone !== zone) continue; if (u.status === 'scrap') scrap++; else if (u.hold && u.loc !== 'line') hold++; if (u.disp?.d === 'rework') rework++; if (u.loc === 'shipped') shipped++; }
    const v = { hold, scrap, rework, shipped }; C[zone] = { k, n: this.units.length, v };
    return v;
  }
  cellSummary(zone, cell) { return this.byCell[`${zone}:${cell}`] ?? null; }
}
const uid = () => (globalThis.crypto?.randomUUID ? `urn:uuid:${globalThis.crypto.randomUUID()}` : `urn:uuid:${'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16))}`);   // EPCIS eventID — 시뮬레이션 난수와 무관

// 화면 표시 — 번호 배정 상태 (데이터 연동 창 EPCIS 칸 · 품질 추적 창 시리얼·출하 탭). 배정기가 없으면(웹 버전 · 헤드리스) null
export function allocState(H) {
  const A = H?.alloc; if (!A) return null;
  const S = A.status(), wait = H.waitIssue.length, KO = (k) => (k === 'pal' ? '팔레트 SSCC' : k === 'ship' ? '출하 ID' : `시리얼 ${k.slice(4)}`);
  const text = S.state === 'retry' ? `서버 번호 예약 실패 ${S.fails}회 (${S.lastError}) — ${Math.ceil(S.retryInMs / 1000)}초 뒤 다시 요청 · 그동안 발행 보류 (1번부터 발행하지 않음)`
    : S.state === 'wait' ? `서버에서 번호 범위를 받는 중 (${S.dry.map(KO).join(' · ') || '요청 중'}) — 받을 때까지 발행 보류`
    : `서버가 예약해 준 범위에서 발행 · 남은 번호 ${Object.entries(S.left).map(([k, n]) => `${KO(k)} ${n}`).join(' · ')}`;
  return { state: S.state, ok: S.state === 'ok', wait, text: `${text}${wait ? ` · 시리얼 발행 대기 ${wait}개` : ''}`, used: S.used, reserved: S.reserved };
}

export function serialsCSV(H) {
  const head = ['wip_id', 'serial', 'zone', 'product', 'gtin', 'lot', 'status', 'location', 'hold', 'symbol', 'mark_cell', 'verify_grade', 'mark_tries', 'serial_time_s', 'sscc', 'truck', 'disposition'];
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [head, ...H.units.map((u) => [u.wip, u.serial ?? '', u.zone, u.product, u.gtin ?? '', u.plot ?? '', u.status, u.loc, u.hold ?? '', u.mark?.symbol ?? '', u.mark?.at ?? '', u.mark?.grade ?? '', u.mark?.tries ?? '', u.tSerial != null ? Math.round(u.tSerial) : '', u.ship?.sscc ?? '', u.ship?.truck ?? '', u.disp?.d ?? ''])].map((r) => r.map(cell).join(',')).join('\n');
}
