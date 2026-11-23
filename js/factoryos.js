// FacOS (Factory OS) — 공장 · 존 · 셀 · 엣지 오케스트레이터 계층 (llm-wiki 「팩토리OS의 오케스트레이터·에이전트 공장·존·셀 분류」 10/15 · 「셀·존·공장 운영 계층」 Ver5 · V12)
// 정밀조립Zone 하나 (jin-3d) — 공장 ↔ 정밀조립 존 오케스트레이터 ↔ 셀 OCS ↔ 엣지. 존 ↔ 존 메시지는 상대 존이 없어 생기지 않는다(권한표는 그대로 — 가드레일 시험)
//  · 공장 오케스트레이터 (FacOS): 오더 배정·종료(존 증빙 확인) · 결정 요청 처리(납기 위험 · 정책 승인 · 운영 변경 · 응답 시간 초과) · 방송
//    Agent Gateway = 가드레일(계층 권한표) · 탐색(에이전트 등록부·역량) · 라우팅. 모든 에이전트 간 메시지를 A2A 기록으로 남긴다
//  · 존 오케스트레이터 — 정밀조립 = Manufacturing Agent (로컬 오케스트레이터, 정밀조립 v3): 존 에이전트(Field Logistics · 품질 · 정비 · 흐름) 제안 승인,
//    수량 정산(고유 투입 = 공정중 + 합격대기 + HOLD·재작업 + 인계완료 + 폐기), 오더 진행·납기 위험 감시, 공장 에스컬레이션
//  · 셀 오케스트레이터 = 셀 OCS: 셀 상태머신(IDLE · READY · RUN · DONE · HOLD · RECOVER · SAFE-STOP) · 명령 검증(정비·보정·현장 명령 승인/거부 사유)
//  · 엣지 = 스킬 (VLA 파지·장착 · 위치정합 · 체결 판정 · 압입 · 동작 감시 · 설비 LLM · 인터록 규칙)
// 원칙: 명령은 위 → 아래, 상태는 아래 → 위, 같은 계층(존 ↔ 존)은 핸드셰이크·알림만 — 결정이 필요한 일은 공장으로. 접수 ACK만으로 재개하지 않는다.
// 렌더링과 분리 — 헤드리스에서도 같은 흐름. 시뮬레이션 난수를 쓰지 않는다 (기록·정산·결정 경로만 더한다).
import { ZONE_LABEL } from './zonedefs.js';
import { ZONE_MIXES } from './line.js';

const clk = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ── 셀 OCS 상태머신 (V12) ─────────────────
export const OCS = {
  IDLE: { ko: '대기', tone: 'idle' }, READY: { ko: '준비 완료', tone: 'info' }, RUN: { ko: '실행', tone: 'good' }, DONE: { ko: '완료·인계 대기', tone: 'info' },
  HOLD: { ko: '보류', tone: 'warn' }, RECOVER: { ko: '복구', tone: 'bad' }, 'SAFE-STOP': { ko: '안전 정지', tone: 'bad' },
};
export function ocsState(st) {
  const s = st.state;
  if (s === 'ESTOP' || s === 'PSTOP') return 'SAFE-STOP';
  if (s === 'DOWN' || s === 'MAINT' || s === 'CHECK') return 'RECOVER';
  if (s === 'BUSY') return 'RUN';
  if (s === 'BLOCKED') return 'DONE';
  if (s === 'STARVED') return 'READY';
  if (['NOAMR', 'NOPARTS', 'HOLD', 'CSTOP', 'FULL', 'REFILL'].includes(s)) return 'HOLD';
  return 'IDLE';
}
// 셀 종류별 엣지 스킬 (WP8 2차 Edge Agent 10종 → 10/13 용어 기준 "스킬")
export const EDGE_SKILLS = {
  sort: ['비전 부품 인식·판별', '피킹·키팅 (VLA)'], assembly: ['협업 조립·압입 (Force)', '위치정합 (3D Vision–CAD)', '양팔·이기종 협업 결합'],
  pressfit: ['삽입·압입 (Force)'], screw: ['스크류 체결 판정 (토크·각도)'], fasten: ['너트러너 체결 판정 (토크·각도)'], pack: ['포장·라벨 (VLA)'],
  common: ['동작 감시 (두 번째 눈)', '설비 LLM (알람 해석 · 제어 안 함)', '인터록 (규칙 · AI 아님)', 'AMR 도킹·인계'],
};

// ── A2A 메시지 · Agent Gateway ─────────────────
export const MSG = {
  'order.assign': { ko: '오더 배정', cls: 'command' }, 'order.ack': { ko: '오더 수락·계획', cls: 'event' }, 'order.evidence': { ko: '종료 증빙', cls: 'event' }, 'order.close': { ko: '오더 종료', cls: 'decision' },
  'decision.request': { ko: '결정 요청', cls: 'event' }, decision: { ko: '결정', cls: 'decision' }, broadcast: { ko: '방송', cls: 'command' }, command: { ko: '명령', cls: 'command' },
  'service.request': { ko: '서비스 요청', cls: 'handshake' }, 'service.accept': { ko: '수락', cls: 'handshake' }, 'service.result': { ko: '결과', cls: 'handshake' },
  'handover.ready': { ko: '인계 준비', cls: 'handshake' }, 'handover.ack': { ko: '인수 확인', cls: 'handshake' }, 'quality.alert': { ko: '품질 알림', cls: 'notify' },
  'quality.hold': { ko: '출하 보류·봉쇄', cls: 'event' }, 'quality.disposition': { ko: '처분 결과', cls: 'event' },
  status: { ko: '상태 보고', cls: 'event' }, ack: { ko: '수신 확인', cls: 'event' },
  'incident.report': { ko: '인시던트 보고', cls: 'event' }, 'incident.close': { ko: '인시던트 종료', cls: 'event' },
};
const layerOf = (ep) => (ep === 'factory' ? 0 : ep.startsWith('zone:') ? 1 : 2);
// 셀 → 존 (FactoryOS가 셀 OCS를 만들 때 채운다) · 실행 자원 끝점 res:{존} (정비 인력 · AGV · 이동 로봇)
const CELL_ZONE = new Map();
export const zoneOfEp = (ep) => (ep.startsWith('zone:') || ep.startsWith('res:') ? ep.slice(ep.indexOf(':') + 1) : ep.startsWith('cell:') ? (CELL_ZONE.get(ep.slice(5)) ?? 'main') : null);
// 가드레일: 계층 권한표 — 명령은 바로 아래 계층으로만, 같은 계층은 핸드셰이크·알림만
export function allowed(from, to, type) {
  const a = layerOf(from), b = layerOf(to), C = MSG[type]?.cls;
  if (type === 'ack') return true;
  if (a === b) return a === 1 && (C === 'handshake' || C === 'notify');   // 존 ↔ 존
  if (b === a + 1) return ['command', 'decision'].includes(C) || type === 'order.assign' || type === 'order.close';   // 위 → 바로 아래
  if (a === b + 1) return C === 'event';   // 아래 → 바로 위: 결정 요청·상태·증빙
  return false;   // 계층 건너뛰기 금지
}
const EP_NAME = (ep) => (ep === 'factory' ? '공장 오케스트레이터 (FacOS)' : ep === 'zone:main' ? 'Manufacturing Agent (정밀조립)' : ep.startsWith('zone:') ? `${ZONE_LABEL[ep.slice(5)] ?? ep.slice(5)} Zone 오케스트레이터` : ep.startsWith('res:') ? `${ZONE_LABEL[ep.slice(4)] ?? ep.slice(4)} 실행 자원 (정비 · AGV · 로봇)` : ep === 'cell:*' ? '정밀조립 셀 OCS 전체' : `셀 OCS ${ep.slice(5)}`);
export const epName = EP_NAME;

export class A2ABus {
  constructor(fos) { this.fos = fos; this.log = []; this.seq = 0; this.outbox = []; this.waits = []; this.stats = { sent: 0, blocked: 0, acked: 0, timeouts: 0, queued: 0, byType: {} }; }
  get sim() { return this.fos.sim; }
  // 메시지 계약: msgId · seq · corr · from · to · type · subject(serial·lot·order) · body · authority · planVersion · t · ack
  send(from, to, type, { subject = {}, body = {}, corr = null, text = '', expect = null, timeout = 0, onTimeout = null } = {}) {
    const m = { msgId: `A2A-${String(++this.seq).padStart(6, '0')}`, seq: this.seq, corr, from, to, type, subject, body, authority: layerOf(from) === 0 ? 'factory' : zoneOfEp(from) ?? from, planVersion: this.fos.planVersion, t: this.sim.time, text, status: 'sent' };
    this.stats.byType[type] = (this.stats.byType[type] ?? 0) + 1;
    if (!allowed(from, to, type)) { m.status = 'blocked'; m.why = layerOf(from) === layerOf(to) ? '같은 계층 명령 금지 (핸드셰이크·알림만)' : '계층 건너뛰기 금지'; this.stats.blocked++; this.push(m); return m; }
    if (!this.fos.online && (from === 'factory' || to === 'factory')) { m.status = 'queued'; this.outbox.push(m); this.stats.queued++; this.push(m); return m; }   // 상위망 단절: Edge Outbox에 쌓고 승인 범위 안에서 계속
    this.stats.sent++; this.push(m);
    if (expect) this.waits.push({ m, expect, until: this.sim.time + timeout, onTimeout });
    return m;
  }
  reply(m, type, opts = {}) { return this.send(m.to, m.from, type, { ...opts, corr: m.msgId, subject: opts.subject ?? m.subject }); }
  ack(m, text = '') { if (m.status === 'sent') { m.status = 'acked'; this.stats.acked++; } return this.send(m.to, m.from, 'ack', { corr: m.msgId, subject: m.subject, text }); }
  push(m) { this.log.unshift(m); if (this.log.length > 400) this.log.pop(); this.answer(m); }
  answer(m) { if (!m.corr) return; this.waits = this.waits.filter((w) => !(w.m.msgId === m.corr && w.expect.includes(m.type))); }
  flush() { const q = this.outbox.splice(0); for (const m of q) { m.status = 'sent'; m.tFlush = this.sim.time; this.stats.sent++; } return q.length; }
  update() {
    const t = this.sim.time, due = this.waits.filter((w) => t > w.until);
    if (!due.length) return;
    this.waits = this.waits.filter((w) => t <= w.until);
    for (const w of due) { w.m.status = 'timeout'; this.stats.timeouts++; w.onTimeout?.(w.m); }
  }
}

// ── 셀 OCS (정밀조립 셀마다) ─────────────────
export class CellOCS {
  constructor(st, fos) { this.st = st; this.fos = fos; this.checks = []; this.ok = 0; this.rej = 0; }
  get state() { return ocsState(this.st); }
  record(kind, ok, reason, by) { const c = { t: this.fos.sim.time, kind, ok, reason, by }; this.checks.unshift(c); if (this.checks.length > 12) this.checks.pop(); ok ? this.ok++ : this.rej++; return c; }
}
const KIND_KO = { repair: '긴급수리', pm: '예지정비', cal: '재보정', selfcal: '자율 보정', cmd: '현장 명령' };

// ── 존 오케스트레이터: 정밀조립 Manufacturing Agent ─────────────────
export class ManufacturingAgent {
  constructor(fos) { this.fos = fos; this.ep = 'zone:main'; this.esc = []; this.handled = 0; }
  get sim() { return this.fos.sim; }
  get name() { return 'Manufacturing Agent'; }
  // 존 에이전트 (제안) · 규칙 — 자율운영 에이전트 구조(단일 / 혼합형 다중)에 따라
  agents() {
    const s = this.sim, A = s.zoneAgent, H = s.agentHub, car = s.carriers ?? [];
    const fl = { key: 'logistics', name: 'Field Logistics Agent', role: `운반 AMR ${car.length}대 — 셀 간 이송·대기열·충전 · 선행 배차 ${s.mode.amrStage ?? 0}대`, stat: car.length ? `운반 ${car.filter((c) => c.state === 'line').length} · 복귀 ${car.filter((c) => c.state === 'return').length} · 대기 ${car.filter((c) => c.state === 'park' || c.state === 'atSrc').length} · 배터리 평균 ${Math.round(car.reduce((a, c) => a + c.battery, 0) / car.length)}%` : '컨베이어 (AMR 없음)' };
    if (H?.agents) return [fl, ...H.agents.map((a) => ({ key: a.key, name: { maint: '정비 에이전트', quality: '품질 에이전트', flow: '흐름 에이전트' }[a.key] ?? a.label, role: { maint: '예지정비 제안 (건강도·RUL·고장확률) · 사족보행 순찰 보고', quality: 'SPC Cpk 재보정 제안 · 8D 존 분석 (품질 추적)', flow: '투입 간격·병목 고속 운전·공급 차질 대응 제안' }[a.key] ?? '', stat: `제안 ${a.proposed} · 승인 ${a.approved} · 주기 ${a.period}초` })),
      { key: 'rules', name: '반사 규칙', role: '자재 배차 · 셀 절전 · AGV 충전 · 정지 설비 앞 투입 보류 (정상 반복 = 규칙)', stat: `대기 ${H.queue?.length ?? 0} · 보류 ${H.ma?.deferred ?? 0} · 거절 ${H.ma?.rejected ?? 0}`, rule: true }];
    return [fl, { key: 'single', name: A ? A.name : '작업반장 (수동 운영)', role: '정비·품질·흐름을 한 에이전트가 판단·실행 (단일 구조 — 혼합형 다중을 고르면 도메인 에이전트로 나뉨)', stat: A ? `의사결정 ${A.decisions}건` : '-' }];
  }
  // 수량 정산 — 시리얼 단위 (오더별 또는 전체)
  reconcile(orderId = null) {
    const T = this.sim.trace; if (!T) return null;
    const rs = orderId ? T.recent.filter((r) => r.order === orderId) : T.recent;
    const o = { input: rs.length, wip: 0, pass: 0, hold: 0, handed: 0, scrap: 0, good: 0 };
    for (const r of rs) {
      if (r.status === 'ng' || r.status === 'scrap') o.scrap++;   // 체결 NG 격리 · 처분 폐기 (js/serial.js)
      else if (r.hold) o.hold++;
      else if (r.status === 'ok' || r.status === 'escaped') { o.handed++; o.good++; }
      else if (r.inspection?.result === 'OK') o.pass++;
      else o.wip++;
    }
    o.err = o.input - (o.wip + o.pass + o.hold + o.handed + o.scrap);
    return o;
  }
  // 존 → 공장 에스컬레이션 (영향·증거·필요 결정)
  escalate(kind, title, body = {}, subject = {}) {
    const m = this.fos.bus.send(this.ep, 'factory', 'decision.request', { subject, body: { kind, ...body }, text: title, ...(kind === 'policy' ? {} : { expect: ['decision'], timeout: 120, onTimeout: (x) => this.fos.timeout(x) }) });   // 정책 승인은 사람 결정 — 시간 초과 없음
    this.esc.unshift({ t: this.sim.time, kind, title, msg: m.msgId }); if (this.esc.length > 30) this.esc.pop();
    if (m.status !== 'blocked') this.fos.receive(m);
    return m;
  }
  receive(m) { this.handled++; if (m.type !== 'ack') this.fos.bus.ack(m, `${this.name} 수신`); }
}

// ── 공장 오케스트레이터 (FacOS) ─────────────────
export const ORDER_SIZE = 100;
export class FactoryOS {
  constructor(sim) {
    this.sim = sim; this.online = true; this.planVersion = 'P-1'; this.pv = 1; this.decisions = []; this.orders = []; this.oseq = 0; this.acc = 0;
    this.bus = new A2ABus(this);
    this.main = new ManufacturingAgent(this);
    this.zones = { main: this.main };   // 정밀조립Zone 하나
    this.ocs = new Map();
    for (const st of sim.processing) { this.ocs.set(st.id, new CellOCS(st, this)); CELL_ZONE.set(st.id, 'main'); }
    this.changes = [];   // 운영 변경 이력 (KPI 개선안 · AIOS 정책 · 운영자 지시) — 계획 버전마다
    this.judge = { n: 0, fast: 0, sum: 0, seen: new Set() };
    sim.fos = this;
    if (sim.trace) this.issueOrder();
  }
  get name() { return '공장 오케스트레이터 (FacOS)'; }
  bump() { this.planVersion = `P-${++this.pv}`; }
  // 에이전트 등록부 (Agent Gateway 탐색) — 계층 · 소속 · 역할
  registry() {
    const s = this.sim, R = [
      { layer: 'factory', name: '공장 오케스트레이터 (FacOS)', role: '오더·납기·우선순위 · Zone 간 자원 · 전역 계획 · 결정 요청 처리 · 오더 종료' },
      { layer: 'factory', name: 'Agent Gateway', role: '가드레일(계층 권한표) · 탐색(등록부·역량) · 라우팅 · A2A 기록' },
      { layer: 'factory', name: '생산·계획 PA Agent', role: '오더 배정안 · 납기 위험 판단안 (제안)' },
      { layer: 'factory', name: 'AIOS 운영 정책 모델', role: s.aios?.on ? `오케스트레이터 운영 정책 ${s.aios.version}` : '피지컬AI 단계에서 동작' },
      { layer: 'factory', name: 'CCTV 에이전트 (공용 인지)', role: s.cctvAgent?.on ? '영상 AI 감지 → 오케스트레이터 보고' : '녹화·관제 (AI 감지 없음)' },
      { layer: 'factory', name: '보안 계층 (가드레일)', role: s.sec?.on ? 'DID 서명 · VC 권한 · OTAC 인증' : '-' },
      { layer: 'zone', zone: 'main', name: 'Manufacturing Agent', role: '정밀조립 로컬 오케스트레이터 — 존 에이전트 제안 승인 · 수량 정산 · 오더 진행 · 에스컬레이션' },
      ...this.main.agents().map((a) => ({ layer: 'zone', zone: 'main', name: a.name, role: a.role, stat: a.stat, rule: a.rule })),
    ];
    return R;
  }

  // ── 메시지 받기 (공장) ─────────────────
  receive(m) {
    if (m.to !== 'factory') { (this.zones[zoneOfEp(m.to)] ?? null)?.receive(m); return; }
    if (m.type === 'decision.request') return this.decide(m);
    if (m.type === 'order.evidence') return this.closeOrder(m);
    if (m.type !== 'ack') this.bus.ack(m, '공장 오케스트레이터 수신');
  }
  // 결정: 대상 · 권한자 · 버전 · 제약 · 재개 조건 (결정 메시지 필수 필드)
  decision(req, verdict, text, { constraints = '', resume = '', target = null, approvedBy = null, change = null } = {}) {
    const d = { t: this.sim.time, kind: req.body.kind, verdict, text, target: target ?? req.subject, authority: '공장 오케스트레이터 (FacOS)', version: this.planVersion, constraints, resume, req: req.msgId, ...(approvedBy ? { approvedBy } : {}), ...(change ? { change } : {}) };
    this.decisions.unshift(d); if (this.decisions.length > 40) this.decisions.pop();
    const m = this.bus.reply(req, 'decision', { body: d, text: `${verdict} — ${text}` });
    if (m.status !== 'blocked') (this.zones[zoneOfEp(req.from)] ?? null)?.receive(m);
    return d;
  }
  decide(m) {
    const k = m.body.kind;
    if (m.body.change) return this.decision(m, '사후 확인', `${m.text} — 상위망 단절 중 승인 범위 안 자율 조치 (복구 뒤 공장 확인)`, { change: { ...m.body.change, by: m.body.by ?? null } });   // Outbox로 늦게 온 운영 변경 (되돌림 · 롤백 · 긴급 조달)
    if (k === 'policy') { m.pendingHuman = true; return null; }   // 사람 결정(HITL) — capa.approve/hold 때 결정 메시지
    if (k === 'due-risk') { const o = this.orders.find((x) => x.id === m.subject.order); const add = Math.ceil((m.body.lateBy ?? 0) / 60) + 2; if (o) o.due += add * 60; this.bump(); return this.decision(m, '승인', `${m.subject.order} 납기 ${add}분 조정 · 우선순위 유지 (고객 협의 대상 아님)`, { constraints: `조정 1회 · ${add}분 이내`, resume: '진행률 재평가' }); }
    if (k === 'timeout') return this.decision(m, '확인', `${m.body.what ?? '응답'} 시간 초과 — 대기 연장 · 재요청 1회`, { resume: '응답 수신' });
    return this.decision(m, '확인', '기록');
  }
  timeout(m) {
    if (m.type === 'decision.request') return;   // 결정 요청 자체가 늦으면 다시 묻지 않는다 (기록만)
    const z = this.zones[zoneOfEp(m.from)];
    if (z === this.main) this.main.escalate('timeout', `${MSG[m.type]?.ko ?? m.type} 응답 시간 초과 (${epName(m.to)})`, { what: MSG[m.type]?.ko, msg: m.msgId }, m.subject);
  }
  setOnline(on) {
    this.online = on;
    if (on) { const n = this.bus.flush(); for (const m of this.bus.log.filter((x) => x.tFlush === this.sim.time)) this.receive(m); return n; }
    return 0;
  }

  // ── 셀 OCS 명령 검증 기록 (sim.requestTech · selfCalibrate · 명령 콘솔 수신) ─────────────────
  validate(st, kind, ok, reason, by) {
    const c = this.ocs.get(st.id); if (!c) return;
    c.record(kind, ok, ok ? '승인 — 권한·인터록·안전 상태 확인' : reason, by);
  }
  // ── 오더 (공장 → 정밀조립) ─────────────────
  issueOrder() {
    const s = this.sim, id = `ORD-${String(++this.oseq).padStart(3, '0')}`, cyc = s.idealCycle || 8;
    const o = { id, t0: s.time, target: ORDER_SIZE, due: s.time + ORDER_SIZE * cyc * 1.6 + 120, status: 'open', released: false, risk: false, carry: 0 };
    this.orders.unshift(o); if (this.orders.length > 20) this.orders.pop();
    const w = ZONE_MIXES[s.line?.mix]?.w ?? { doortrim: 1, eaxle: 1 }, tw = (w.doortrim + w.eaxle) || 1;
    s.fac?.order('order.assign', o, { mix: { doortrim: w.doortrim / tw, eaxle: w.eaxle / tw } });   // FAC 기록 → ERPNext 작업지시 (제품별)
    const m = this.bus.send('factory', 'zone:main', 'order.assign', { subject: { order: id }, body: { target: ORDER_SIZE, due: o.due }, text: `${id} 배정 — 양품 ${ORDER_SIZE}개 · 납기 ${clk(o.due)}` });
    this.bus.send('zone:main', 'factory', 'order.ack', { corr: m.msgId, subject: { order: id }, body: { plan: '셀 능력·자재·AMR·버퍼 확인 → 투입 순서 혼류 비율대로' }, text: `${id} 수락 · 실행 계획 (투입 순서 = 혼류 비율 · 불량 보충 투입 포함)` });
    return o;
  }
  get order() { return this.orders.find((o) => o.status === 'open' && !o.released) ?? null; }
  // 투입 순간 오더 지정 (trace.release) — 남은 필요량(목표 − 양품 − 진행 중)이 없으면 다음 오더를 연다 (불량 보충 투입은 같은 오더)
  orderFor(rec) {
    let o = this.order; if (!o) o = this.issueOrder();
    const R = this.main.reconcile(o.id);
    if (R.good + R.wip + R.pass + R.hold >= o.target) { o.released = true; o = this.issueOrder(); }
    rec.order = o.id;
    return o.id;
  }
  closeOrder(m) {
    const o = this.orders.find((x) => x.id === m.subject.order); if (!o || o.status !== 'open') return;
    const R = m.body.recon, ok = R.err === 0 && R.good >= o.target;
    if (!ok) { this.bus.reply(m, 'decision', { body: { verdict: '반려' }, text: `${o.id} 증빙 반려 — 정산 오차 ${R.err}` }); return; }
    o.status = 'closed'; o.tEnd = this.sim.time; o.recon = R; o.late = o.tEnd > o.due;
    // 남은 진행 중 제품(불량 보충으로 더 넣은 몫)은 다음 오더로 넘긴다
    const T = this.sim.trace, next = this.order ?? this.issueOrder(); let n = 0;
    for (const r of T.recent) if (r.order === o.id && r.status === 'wip') { r.order = next.id; n++; }
    o.carry = n;
    const by = {}; for (const r of T.recent) if (r.order === o.id && (r.status === 'ok' || r.status === 'escaped')) by[r.product] = (by[r.product] ?? 0) + 1;
    this.sim.fac?.order('order.close', o, { good: by, scrap: R.scrap, input: R.input, late: o.late });   // FAC 기록 → ERPNext 작업지시 마감
    this.bus.reply(m, 'order.close', { body: { recon: R, carry: n }, text: `${o.id} 종료 — 양품 ${R.good} · 폐기 ${R.scrap} · 고유 투입 ${R.input}${n ? ` · 잔여 ${n}개 ${next.id}로 이월` : ''}${o.late ? ' · 납기 초과' : ''}` });
    this.sim.log?.('ok', `오더 ${o.id} 종료`, { obs: `양품 ${R.good} · 폐기 ${R.scrap} · 투입 ${R.input} (정산 오차 0)`, act: `${this.name} 확인` });
  }

  // ── 운영 변경 (KPI 개선안 · AIOS 정책 · 운영자 지시) — 모두 공장 결정을 거친다 ─────────────────
  // 존(요청 주체)이 결정 요청 → 공장이 결정(사람 승인이면 승인자 기록) → 계획 버전을 올리고 → 적용. 8D 정책 승인과 같은 경로
  //   c = { kind, title, from, target, before, after, by, human, constraints, resume, plan(계획 버전 올림, 기본 true), autonomous(상위망 단절이어도 적용 — 롤백 같은 안전 쪽 변경) }
  //   상위망이 끊기면 공장 결정을 받을 수 없어 적용하지 않는다(autonomous 제외 — 그때는 승인 범위 안의 자율 조치로 적용하고 결정 요청은 Outbox에 쌓는다)
  change(c, apply) {
    const from = c.from ?? 'zone:main', body = { kind: c.kind, change: { before: c.before ?? null, after: c.after ?? null }, by: c.by ?? null, human: !!c.human };
    if (!this.online && !c.autonomous) {
      const r = { ok: false, reason: '상위망 단절 — 공장 결정을 받을 수 없어 적용하지 않음 (복구 뒤 다시 요청)' };
      this.changes.unshift({ t: this.sim.time, kind: c.kind, title: c.title, by: c.by, verdict: '보류', reason: r.reason, version: this.planVersion }); if (this.changes.length > 60) this.changes.pop();
      return r;
    }
    const req = this.bus.send(from, 'factory', 'decision.request', { subject: c.target ?? {}, body, text: c.title });
    if (req.status === 'blocked') return { ok: false, reason: req.why };
    if (c.plan !== false) this.bump();
    apply?.();
    const verdict = c.verdict ?? '승인', ch = { before: c.before ?? null, after: c.after ?? null, by: c.by ?? null };
    let d;
    if (req.status === 'queued') {   // 자율 조치 — 결정은 망 복구 뒤 공장이 확인
      d = { t: this.sim.time, kind: c.kind, verdict: `${verdict} (자율 · 상위망 단절)`, text: c.title, target: c.target ?? {}, authority: `${epName(from)} (승인 범위 안 자율 조치)`, version: this.planVersion, constraints: c.constraints ?? '', resume: c.resume ?? '', req: req.msgId, change: ch };
      this.decisions.unshift(d); if (this.decisions.length > 40) this.decisions.pop();
    } else d = this.decision(req, verdict, `${c.title}${c.human ? ` — ${c.by ?? '운영자'} 승인` : ''}`, { constraints: c.constraints ?? '', resume: c.resume ?? '', approvedBy: c.human ? (c.by ?? '운영자') : null, change: ch });
    this.changes.unshift({ t: this.sim.time, kind: c.kind, title: c.title, by: c.by, human: !!c.human, verdict: d.verdict, version: this.planVersion, before: ch.before, after: ch.after, msg: req.msgId }); if (this.changes.length > 60) this.changes.pop();
    return { ok: true, decision: d, msg: req };
  }

  // ── 인시던트 (js/orchestrator.js) → A2A 기록 ─────────────────
  // 존 오케스트레이터가 인시던트를 맡는다: 셀 → 존 보고(이상 이벤트) · 존 → 셀/실행 자원 명령 · 존 → 공장 종료 보고(상태는 아래 → 위)
  // 안전(P1)·보안(P2)은 열리는 즉시 공장에 보고하고, P1이면 공장이 다른 존 모두에 방송한다 (보고 정책)
  incidentStep(inc, lane, kind, text) {
    if (!inc || inc.type === 'command') return;   // 명령 인시던트는 명령 경로(commands.js)가 이미 A2A로 남긴다
    const z = this.zones[inc.zone] ? inc.zone : 'main', zep = `zone:${z}`, m = /^(?:fail|rack|cal):(.+)$/.exec(inc.key ?? ''), cell = m && this.ocs.has(m[1]) ? `cell:${m[1]}` : null;
    const subject = { incident: inc.id, type: inc.type, prio: inc.prio ?? null, ...(m ? { cell: m[1] } : {}) };
    const S = (inc.fos ??= {});
    if (!S.opened) {
      S.opened = true;
      if (cell) this.bus.send(cell, zep, 'incident.report', { subject, text: `${inc.title} — 셀 OCS → ${epName(zep)} 보고` });
      if ((inc.prio ?? 9) <= 2) {
        this.bus.send(zep, 'factory', 'incident.report', { subject, body: { prio: inc.prio }, text: `P${inc.prio} ${inc.title} — 모든 계층 즉시 통보` });
        if (inc.prio === 1) for (const k of Object.keys(this.zones)) if (k !== z) this.bus.send('factory', `zone:${k}`, 'broadcast', { subject, text: `P1 방송 — ${ZONE_LABEL[z]} ${inc.title} (안전 우선)` });
      }
    }
    if (kind === 'command') {
      const to = cell && lane !== 'exec' ? cell : `res:${z}`;
      this.bus.send(zep, to, 'command', { subject, body: { incident: inc.id }, text: String(text ?? '').slice(0, 160) });
    } else if (kind === 'done') {
      this.bus.send(zep, 'factory', 'incident.close', { subject, body: { dur: Math.round((this.sim.time - inc.t0) * 10) / 10, cellResolved: !!inc.cellResolved }, text: `${inc.title} 종료 — ${String(text ?? '').slice(0, 100)}` });
    }
  }

  // ── 1초마다 ─────────────────
  update(dt) {
    this.acc += dt; if (this.acc < 1 - 1e-9) return; this.acc = 0;   // 0.1초 × 10 = 0.9999… (여유 없이 비교하면 1.1초마다)
    const s = this.sim;
    this.bus.update();
    if (!s.trace) return;
    // 오더 진행: 양품 목표 도달 → 존 종료 증빙 / 납기 위험 → 공장 결정 요청
    for (const o of this.orders.filter((x) => x.status === 'open')) {
      const R = this.main.reconcile(o.id);
      if (R.good >= o.target && !o.evidenced) { o.evidenced = true; const m = this.bus.send('zone:main', 'factory', 'order.evidence', { subject: { order: o.id }, body: { recon: R }, text: `${o.id} 종료 증빙 — 양품 ${R.good} · 폐기 ${R.scrap} · 진행 중 ${R.wip + R.pass} · HOLD ${R.hold} · 투입 ${R.input} (오차 ${R.err})` }); if (m.status === 'sent') this.closeOrder(m); else o.evidenced = false; continue; }
      if (!o.risk && s.time - o.t0 > 300) {
        const { rate, n } = this.rateInfo(); if (n < 5 && s.time - o.t0 < 1200) continue;   // 가동 직후(양품 5개 미만)는 속도를 믿을 수 없어 판단을 미룬다 — 20분이 지나도 5개가 안 나오면 그 속도로 판단
        if (rate <= 0) continue;
        const eta = s.time + (o.target - R.good) / rate;
        if (eta > o.due + 30) { o.risk = true; this.main.escalate('due-risk', `${o.id} 납기 위험 — 예상 완료 ${clk(eta)} > 납기 ${clk(o.due)}`, { eta, lateBy: eta - o.due, good: R.good, target: o.target }, { order: o.id }); }
      }
    }
    // 이상 판단 시간 (정밀조립 설비 고장·품질 불량 인시던트: 발생 → 판단 단계) — 운영 KPI 10초
    for (const inc of s.orch.incidents) {
      if ((inc.zone ?? 'main') !== 'main' || this.judge.seen.has(inc.id) || !['equipment', 'defect'].includes(inc.type)) continue;
      const d = inc.steps.find((x) => x.kind === 'decide'); if (!d) continue;
      this.judge.seen.add(inc.id); const dt0 = d.t - inc.t0; this.judge.n++; this.judge.sum += dt0; if (dt0 <= 10) this.judge.fast++;
    }
  }
  // 최근 15분 양품 속도(개/초). 5개 이상 나왔으면 완성 간격으로 잰다 — 가동 직후에는 첫 제품이 나오기까지의 빈 시간이 섞여 속도가 실제의 몇 분의 일로 잡히고, 납기 예상이 몇 시간씩 늦게 나온다
  // 마지막 완성 뒤 평균 간격의 3배 넘게 조용하면(라인이 섰으면) 지금 시각까지로 나눠 느려진 것을 반영한다
  rateInfo() {
    const T = this.sim.trace, t = this.sim.time, w = Math.min(900, t); const ok = T.recent.filter((r) => (r.status === 'ok' || r.status === 'escaped') && r.tEnd > t - w), n = ok.length;
    if (n >= 5) { let a = Infinity, b = -Infinity; for (const r of ok) { if (r.tEnd < a) a = r.tEnd; if (r.tEnd > b) b = r.tEnd; } if (b > a) { const gap = (b - a) / (n - 1); return { rate: (n - 1) / (t - b > 3 * gap ? t - a : b - a), n }; } }
    return { rate: n / Math.max(60, w), n };
  }
  rate() { return this.rateInfo().rate; }

  // ── 8D 정책 승인 (capa.js) ─────────────────
  policyRequest(k) {
    const m = this.main.escalate('policy', `${k.id} 대책 정책 반영 승인 요청 — ${k.proposal?.title ?? ''}`, { capa: k.id, proposal: k.proposal?.title }, { capa: k.id });
    k.fosReq = m;
  }
  policyDecision(k, verdict, by) {
    const m = k.fosReq; if (!m || m.status === 'blocked') return;
    this.bump();
    this.decision(m, verdict === 'approve' ? '승인' : '보류', `${k.id} ${verdict === 'approve' ? `정책 반영 — ${k.proposal?.title}` : '정책 미반영'} (${by})`, { constraints: verdict === 'approve' ? '반영 후 20분 효과 검증 · 되돌리기 가능' : '', resume: verdict === 'approve' ? 'D6 검증 결과 보고' : '' });
  }
  // KPI 요약
  kpi() {
    const R = this.main.reconcile(), J = this.judge, B = this.bus.stats, oc = [...this.ocs.values()];
    return { recon: R, judgeRate: J.n ? J.fast / J.n : null, judgeAvg: J.n ? J.sum / J.n : null, judgeN: J.n, ocsOk: oc.reduce((a, c) => a + c.ok, 0), ocsRej: oc.reduce((a, c) => a + c.rej, 0), msgs: B.sent, blocked: B.blocked, timeouts: B.timeouts, queued: this.bus.outbox.length, esc: this.main.esc.length, decisions: this.decisions.length, orders: this.orders.filter((o) => o.status === 'closed').length };
  }
}
export { KIND_KO, clk as fosClock };
export const ZONE_ORCH_KEYS = ['main'];   // 존 오케스트레이터 열쇠 (정밀조립 하나)