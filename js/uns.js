// UNS (Unified Namespace) — FacOS가 UNS 위에서 동작하도록, 공장 상태·결정·A2A·셀 OCS·명령을 ISA-95 계층 토픽 하나의 트리로 발행한다.
//   camtic/metafactory                               Enterprise / Site
//     _meta/namespace                                토픽 규칙 (retain · 탄생 메시지)
//     _facos/state                                   공장 오케스트레이터 상태 (retain)
//     _facos/order/{오더}                            오더 (ISA-95 Part 2 OperationsRequest 꼴 · retain)
//     _facos/decision/{종류}                         공장 결정 (이벤트)
//     _facos/a2a/{보낸 쪽}/{받는 쪽}                 Agent Gateway A2A 기록 (이벤트)
//     {존}/_zone/state | kpi | cmd…                  Area — 존 오케스트레이터 (retain) · OEE · 존 전체 명령
//     {존}/_zone/quality                           존 품질 표본 (제품 1개 판정마다 · 이벤트)
//     {존}/{셀}/state | telemetry | edge | cmd · cmd/ack · cmd/exec · cmd/done    Work Unit — 셀 OCS (retain) · 설비 요약 · Sparkplug 엣지 상태 · 명령 4단
//     {존}/{셀|_zone}/cmd/request                  외부 명령 요청 (operator · zone 계정 · 게이트웨이 대기열 → applyCommand)
//     {존}/_field/{로봇}/detect | clip | ack | status | track | done   현장 이벤트 — 감지 로봇 · 대응 로봇 · 추적 사족보행 업링크 (status만 retain)
// 원칙: 상태는 값이 바뀔 때만 발행(Report by Exception) + retain, 이벤트는 retain 없이 그때그때. 명령은 Correlation ID(correlationId)로 요청 → 접수 → 실행 → 완료를 묶는다.
// 전송 보장 (앱 — 서버 있음): 상태와 사건을 나눠 다룬다.
//   · 상태(retain · 설비 요약 · KPI)는 주기마다 새로 만든다 — 전송에 실패하면 rebirth()로 다음 주기에 전부 다시 발행하면 된다
//   · 사건(결정 · A2A · 명령 4단 · 현장 업링크 · 품질 표본 · 운영 이벤트)은 한 번만 생긴다 — 만들 때 중복 방지 키(key)와 실행 ID(run)를 붙여 대기함(outbox)에 넣고,
//     서버가 받았다고 응답(ACK)한 뒤에만 뺀다. 실패하면 그대로 남아 다음 주기에 같은 key로 다시 간다 (서버 · FacOS 저장소가 key로 한 번만 기록)
//   · 단계 전환 · 리셋: 이전 실행의 마지막 사건을 거둔 뒤(harvest) 대기함은 그대로 둔다 — 이전 실행의 run으로 마저 보낸다
//   · 대기함은 OUTBOX_MAX건까지 — 넘치면 오래된 것부터 버리고 무엇을 버렸는지(실행 · 종류별 건수 · key 범위) lost에 남긴다
// 렌더링과 분리 — 헤드리스에서도 같은 트리. 시뮬레이션 상태를 바꾸지 않는다(읽기만).
import { ZONE_ORCH_KEYS, ocsState, zoneOfEp } from './factoryos.js';
import { COMMANDS } from './commands.js';

export const UNS_ROOT = 'camtic/metafactory';
export const UNS_VERSION = 'v1';
export const OUTBOX_MAX = 5000, OUTBOX_BATCH = 1000;   // 사건 대기함 한도 · 한 번에 보낼 사건 수
export const UNS_AREAS = { main: '정밀조립' };   // Area = 존 (jin-3d는 정밀조립 하나 — 토픽 뿌리는 상위 공장과 같게)
const seg = (s) => String(s ?? '').replace(/[^\w.-]/g, '_') || '_';   // MQTT 토픽 금지 문자(+ # /)와 공백 제거
const CMD_SUB = { sent: 'cmd', ack: 'cmd/ack', exec: 'cmd/exec', done: 'cmd/done', rejected: 'cmd/done' };
const ISA95 = [
  { level: 'Enterprise / Site', isa: 'L4 경계 · L3', facos: '공장 오케스트레이터 (FacOS) · Agent Gateway', topic: `${UNS_ROOT}/_facos/…` },
  { level: 'Area', isa: 'L3', facos: '존 오케스트레이터', topic: `${UNS_ROOT}/{존}/_zone/…` },
  { level: 'Work Unit', isa: 'L2', facos: '셀 OCS (상태머신 7종)', topic: `${UNS_ROOT}/{존}/{셀}/state · cmd` },
  { level: 'Equipment', isa: 'L1–L0', facos: '엣지 스킬 · 설비', topic: `${UNS_ROOT}/{존}/{셀}/telemetry` },
];
export const UNS_LEVELS = ISA95;
// 현장 로봇 업링크 토픽 — {존}/_field/{로봇}/{detect · clip · ack · status · track · done}
export const fieldTopic = (m, root = UNS_ROOT) => `${root}/${m.zone}/_field/${seg(m.uid ?? m.robot)}/${m.kind}`;

export class UnsNamespace {
  constructor(sim, { iso = null, root = UNS_ROOT, run = null, outboxMax = OUTBOX_MAX } = {}) {   // run: 실행 ID (데이터 허브 runId) — 서버 FacOS 기록이 실행별 파일로 나눈다
    this.root = root; this.iso = iso; this.runOf = run;
    // 사건 대기함 — reset(새 실행)해도 비우지 않는다. key = 실행 : 이 화면의 난수 : 일련번호 (다른 화면 · 다시 연 화면과 겹치지 않게)
    this.outbox = []; this.outboxMax = outboxMax; this.evSeq = 0; this.nonce = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    this.lost = { n: 0, kinds: {}, log: [] }; this.tx = { acked: 0, failed: 0, resent: 0, lastError: null, lastFailAt: null, lastOkAt: null };
    this.reset(sim);
  }
  reset(sim) {
    this.sim = sim; if (sim) sim.uns = this;
    this.run = this.runOf?.() ?? null;   // 이 실행의 ID — 리셋 뒤 늦게 나가는 사건도 생긴 실행의 ID를 달고 간다
    this.tree = new Map();      // 토픽 → { topic, payload, retain, n, t, bytes, kind }
    this.prev = new Map();      // retain 토픽의 직전 본문 (Report by Exception 비교용 · ts 제외)
    this.a2aSeq = 0; this.fieldSeq = 0; this.cmdSeen = new Map(); this.decSeen = new WeakSet();
    this.pending = [];          // 외부 명령 거부 응답 (다음 collect에 함께 나감)
    this.ext = { applied: 0, rejected: 0, last: null };
    this.born = false;
    this.stats = { msgs: 0, bytes: 0, suppressed: 0, births: 0, collects: 0 };
    this.broker = { on: null, published: 0, error: null, deaths: 0 };
  }
  // 브로커가 죽음 처리(공장 상태 offline)를 했거나 새로 붙은 경우 — 모든 retain 상태를 다시 발행 (Sparkplug Rebirth와 같은 뜻)
  rebirth() { this.prev.clear(); this.born = false; this.stats.births++; }
  ts(t = this.sim.time) { return this.iso ? this.iso(t) : Math.round(t * 1000) / 1000; }
  t(...parts) { return [this.root, ...parts].join('/'); }

  // 하나 발행 — retain 상태는 본문이 바뀔 때만
  //   사건(한 번만 생기는 것 — retain 아닌 것 · 현장 업링크는 상태(retain)도 로그에서 한 번만 나온다)에는 중복 방지 키 · 실행 ID를 붙인다 (설비 요약 · KPI는 주기 데이터라 제외)
  put(out, topic, body, { retain = false, kind = 'event', t = this.sim.time, raw = null, props = null } = {}) {
    const core = raw ?? JSON.stringify(body);
    if (retain) { if (this.prev.get(topic) === core) { this.stats.suppressed++; return; } this.prev.set(topic, core); }
    const payload = raw ?? JSON.stringify({ ...body, ts: this.ts(t) });
    const e = this.tree.get(topic) ?? { topic, n: 0, kind };
    Object.assign(e, { payload, retain, t, bytes: payload.length, kind }); e.n++;
    this.tree.set(topic, e);
    this.stats.msgs++; this.stats.bytes += payload.length;
    const m = props ? { topic, payload, retain, props } : { topic, payload, retain };
    if (kind !== 'telemetry' && kind !== 'kpi' && (!retain || kind === 'field')) this.stamp(m, kind);
    out.push(m);
  }
  stamp(m, kind) { const run = this.run ?? this.runOf?.() ?? null; m.key = `${run ?? '-'}:${this.nonce}:${++this.evSeq}`; if (run) m.run = run; Object.defineProperty(m, 'kind', { value: kind, enumerable: false }); return m; }

  // ── 사건 대기함 (outbox) ─────────────────
  // 넣기 — 한도를 넘으면 오래된 것부터 버리고 기록한다 (무엇을: 실행 · 종류별 건수 · key 범위)
  enqueue(msgs, kind = 'event') {
    for (const m of msgs) this.outbox.push(m.key ? m : this.stamp({ ...m }, kind));
    const over = this.outbox.length - this.outboxMax; if (over <= 0) return;
    const D = this.outbox.splice(0, over), kinds = {};
    for (const m of D) { kinds[m.kind ?? 'event'] = (kinds[m.kind ?? 'event'] ?? 0) + 1; this.lost.kinds[m.kind ?? 'event'] = (this.lost.kinds[m.kind ?? 'event'] ?? 0) + 1; }
    this.lost.n += D.length; this.lost.log.unshift({ at: new Date().toISOString(), n: D.length, kinds, runs: [...new Set(D.map((m) => m.run ?? '-'))], first: D[0].key, last: D.at(-1).key, why: `대기함 한도 ${this.outboxMax}건 초과 — 서버 전송 실패가 이어짐` });
    if (this.lost.log.length > 20) this.lost.log.pop();
  }
  // 한 주기분 만들기 — 상태(이번 주기에만 유효)와 사건(대기함에 쌓인 것부터 max건)을 나눠 준다
  stage(extra = {}, max = OUTBOX_BATCH) {
    const states = [], fresh = [];
    for (const m of this.collect(extra)) (m.key ? fresh : states).push(m);
    this.enqueue(fresh);
    return { states, events: this.outbox.slice(0, max) };
  }
  // 서버가 받았다고 응답한 사건만 대기함에서 뺀다
  ack(events) { if (!events.length) return; const K = new Set(events.map((m) => m.key)), n = this.outbox.length; this.outbox = this.outbox.filter((m) => !K.has(m.key)); this.tx.acked += n - this.outbox.length; }
  // 새 실행으로 넘어가기 직전 — 이전 실행(this.sim)에서 아직 거두지 않은 사건을 대기함에 (상태는 버린다 · 새 실행이 탄생 메시지부터 다시 낸다)
  harvest(extra = {}) { if (!this.sim) return 0; const n = this.outbox.length; this.stage(extra, 0); return this.outbox.length - n; }
  // 한 주기 전송 — post(messages) → 서버 응답(JSON) · 실패(연결 · HTTP 오류 · JSON 오류 응답 · 브로커 꺼짐)는 던지거나 accepted:false
  //   성공: 보낸 사건 확정(ack) · 실패: 사건은 대기함에 그대로 + 상태만 rebirth로 다음 주기에 다시 (상태 재발행과 사건 재전송은 따로)
  //   periodic: 주기 데이터(평면 설비 요약 · OEE — 유실 허용) · keep: 상태 중 보낼 것만 고르는 함수 (Sparkplug가 켜져 있으면 {셀}/telemetry 제외)
  async send(post, { periodic = [], extra = {}, keep = null } = {}) {
    const S = this.stage(extra), states = keep ? S.states.filter(keep) : S.states, events = S.events, messages = [...periodic, ...states, ...events];
    if (!messages.length) return { ok: true, sent: 0, events: 0 };
    const again = events.filter((m) => m.tried).length; for (const m of events) Object.defineProperty(m, 'tried', { value: true, enumerable: false, configurable: true });
    try {
      const j = await post(messages);
      this.broker.status = j?.status ?? null; this.broker.facos = j?.facos ?? null; this.broker.on = !!j?.status?.listening;
      if (!(j?.accepted ?? this.broker.on)) throw new Error(`MQTT 브로커가 꺼져 있습니다${j?.status?.error ? ` — ${j.status.error}` : ''}`);
      this.ack(events); this.tx.resent += again; this.tx.lastError = null; this.tx.lastOkAt = Date.now();
      this.broker.published += states.length + events.length; this.broker.error = null;
      if (j.status?.uns?.rebirth) this.rebirth();   // 게이트웨이가 죽음 처리했거나 새로 시작 — 다음 주기에 모든 retain 상태를 다시 발행 (사건은 다시 보내지 않는다)
      return { ok: true, sent: messages.length, events: events.length, json: j };
    } catch (e) {
      const why = e?.message ?? String(e);
      this.broker.error = why; this.tx.failed++; this.tx.lastError = why; this.tx.lastFailAt = Date.now();
      this.rebirth();   // 이번 주기의 상태는 서버에 닿지 않았다 — 다음 주기에 다시 (사건은 대기함에 남아 있다)
      return { ok: false, error: why, events: events.length };
    }
  }

  cellUid(id) { const st = this.sim.processing?.find((x) => x.id === id); return seg(st?.uid ?? id); }
  epSeg(ep) { return ep === 'factory' ? 'factory' : ep.startsWith('zone:') ? seg(ep.slice(5)) : ep.startsWith('res:') ? `${seg(ep.slice(4))}.res` : ep === 'cell:*' ? 'main.cells' : ep.startsWith('cell:') ? `${seg(zoneOfEp(ep))}.${this.cellUid(ep.slice(5))}` : seg(ep); }

  // 2초마다 (main.js) — telemetry · kpi는 기존 평면 토픽(js/datahub.js unsTelemetry · unsZoneKpi)을 ISA-95 트리로 다시 싣는다
  collect({ telemetry = [], kpi = [] } = {}) {
    const s = this.sim, F = s?.fos, out = []; if (!s) return out;
    this.stats.collects++;
    out.push(...this.pending.splice(0));
    if (!this.born) { this.born = true; this.put(out, this.t('_meta', 'namespace'), this.meta(), { retain: true, kind: 'meta' }); }
    if (F) {
      const K = F.kpi(), B = F.bus.stats;
      this.put(out, this.t('_facos', 'state'), { name: F.name, online: true, upstream: F.online ? 'connected' : 'disconnected', planVersion: F.planVersion, openOrders: F.orders.filter((o) => o.status === 'open').length, closedOrders: K.orders, decisions: K.decisions, a2a: { sent: B.sent, blocked: B.blocked, timeouts: B.timeouts, outbox: F.bus.outbox.length } }, { retain: true, kind: 'state' });
      for (const o of [...F.orders].reverse()) {   // 오래된 것부터 · ISA-95 Part 2 OperationsRequest 꼴 (설계 단순화)
        const R = o.recon ?? F.main.reconcile(o.id);
        this.put(out, this.t('_facos', 'order', seg(o.id)), { isa95: 'OperationsRequest', id: o.id, assignedTo: `${this.root}/main`, status: o.status === 'closed' ? 'closed' : o.released ? 'released' : 'open', target: o.target, good: R?.good ?? 0, input: R?.input ?? 0, scrap: R?.scrap ?? 0, hold: R?.hold ?? 0, reconError: R?.err ?? null, due: this.ts(o.due), atRisk: !!o.risk, ...(o.tEnd != null ? { end: this.ts(o.tEnd), late: !!o.late, carriedOver: o.carry ?? 0 } : {}) }, { retain: true, kind: 'order' });
      }
      for (const d of [...F.decisions].reverse()) {
        if (this.decSeen.has(d)) continue; this.decSeen.add(d);
        this.put(out, this.t('_facos', 'decision', seg(d.kind)), { kind: d.kind, verdict: d.verdict, text: d.text, target: d.target, authority: d.authority, version: d.version, constraints: d.constraints, resume: d.resume, requestId: d.req, ...(d.approvedBy ? { approvedBy: d.approvedBy } : {}), ...(d.change ? { change: d.change } : {}) }, { kind: 'decision', t: d.t });
      }
      for (const m of [...F.bus.log].reverse()) {
        if (m.seq <= this.a2aSeq) continue; this.a2aSeq = m.seq;
        this.put(out, this.t('_facos', 'a2a', this.epSeg(m.from), this.epSeg(m.to)), { msgId: m.msgId, seq: m.seq, corr: m.corr, from: m.from, to: m.to, type: m.type, subject: m.subject, body: m.body, authority: m.authority, planVersion: m.planVersion, status: m.status, ...(m.why ? { why: m.why } : {}), text: m.text }, { kind: 'a2a', t: m.t, props: m.corr ? { correlationData: m.corr, userProperties: { a2aType: m.type } } : { userProperties: { a2aType: m.type } } });
      }
      for (const z of ZONE_ORCH_KEYS) {
        const O = F.zones[z], cells = (s.processing ?? []).filter((st) => !st.standby);
        if (!cells.length) continue;
        const st = {}; for (const c of cells) { const k = ocsState(c); st[k] = (st[k] ?? 0) + 1; }
        const R = O.reconcile();
        this.put(out, this.t(z, '_zone', 'state'), { area: UNS_AREAS[z], orchestrator: O.name, agents: O.agents().map((a) => a.name), cells: cells.length, ocs: st, recon: R }, { retain: true, kind: 'state' });
        for (const c of cells) {
          const k = ocsState(c), C = F.ocs.get(c.id), last = C?.checks[0];
          this.put(out, this.t(z, seg(c.uid ?? c.id), 'state'), { name: c.name, ocs: k, raw: c.state ?? 'OK', validated: { ok: C?.ok ?? 0, rejected: C?.rej ?? 0 }, ...(last ? { lastCheck: { kind: last.kind, ok: last.ok, reason: last.reason, by: last.by } } : {}) }, { retain: true, kind: 'state' });
        }
      }
    }
    // 명령: 요청 → 접수 → 실행 → 완료/거부 (Correlation ID = CMD-n 또는 외부 요청의 correlationId) — 접수 ACK만으로 재개하지 않는다
    //   MQTT 5 브리지: props → Correlation Data · Response Topic · Message Expiry(요청 단계) · User Property
    for (const c of s.cmd?.list ?? []) {
      const seen = this.cmdSeen.get(c.id) ?? 0; if (seen >= c.history.length) continue;
      const base = c.target === 'all' ? this.t('main', '_zone') : this.t('main', this.cellUid(c.target)), corr = c.unsCorr ?? `CMD-${c.id}`, resp = `${base}/cmd/ack`;
      for (const h of c.history.slice(seen)) {
        const end = h.state === 'done' || h.state === 'rejected';
        const body = { correlationId: corr, id: c.id, code: c.code, name: s.cmd.label(c), target: c.target, arg: c.arg, issuer: c.by, reason: c.why ?? '', state: h.state, ...(end ? { result: h.state, note: c.note ?? '' } : {}), responseTopic: resp, ...(c.unsFrom ? { origin: { from: c.unsFrom, via: c.unsVia, requestTopic: `${base}/cmd/request` } } : {}) };
        const props = { correlationData: corr, responseTopic: resp, userProperties: { isa95: c.target === 'all' ? 'Area' : 'WorkUnit', stage: h.state }, ...(h.state === 'sent' ? { messageExpiryInterval: 60 } : {}) };
        this.put(out, `${base}/${CMD_SUB[h.state] ?? 'cmd'}`, body, { kind: 'cmd', t: h.t, props });
        if (c.unsResp && (h.state === 'ack' || end)) this.put(out, c.unsResp, body, { kind: 'cmd', t: h.t, props: { correlationData: corr } });   // 요청자가 정한 응답 토픽에도 (접수 · 완료)
      }
      this.cmdSeen.set(c.id, c.history.length);
    }
    // 현장 로봇 업링크 (sim.fieldTx): 감지 · 영상 클립 · 배정 응답 · 상태(retain) · 추적 보고 · 종료 — 감지한 로봇 · 대응 로봇 · 추적 사족보행이 보낸 것
    for (const m of s.fieldTxLog ?? []) {
      if (m.seq <= this.fieldSeq) continue; this.fieldSeq = m.seq;
      this.put(out, fieldTopic(m, this.root), { event: m.ev, role: m.role, robot: m.robot, assetId: m.uid, ...m.body }, { kind: 'field', t: m.t, retain: m.kind === 'status' });
    }
    for (const m of telemetry) { const x = /^metafactory\/telemetry\/v1\/([^/]+)\/([^/]+)$/.exec(m.topic); if (x) this.put(out, this.t(x[1], x[2], 'telemetry'), null, { raw: m.payload, kind: 'telemetry' }); }
    for (const m of kpi) { const x = /^metafactory\/oee\/v1\/([^/]+)$/.exec(m.topic); if (x) this.put(out, this.t(x[1], '_zone', 'kpi'), null, { raw: m.payload, kind: 'kpi' }); }
    for (const m of kpi) { const x = /^metafactory\/quality\/v1\/([^/]+)$/.exec(m.topic); if (x) this.put(out, this.t(x[1], '_zone', 'quality'), null, { raw: m.payload, kind: 'quality' }); }   // 품질 표본 (제품 1개 판정마다)
    return out;
  }

  // 외부 명령 요청 (게이트웨이 대기열 → /api/uns/commands/take) → FacOS 명령 경로(sim.cmd.issue → 셀 OCS 검증 · A2A)로 실행.
  //   검증 실패는 바로 {셀}/cmd/done result:rejected (+ 요청자의 응답 토픽). 실행되면 위 명령 4단이 같은 correlationId로 나간다.
  applyCommand(q, now = Date.now()) {
    const s = this.sim, base = this.t(seg(q.zone), seg(q.cell)), corr = String(q.correlationId ?? '').slice(0, 80) || `EXT-${now}`;
    const reject = (why) => {
      this.ext.rejected++; this.ext.last = { at: s.time, correlationId: corr, result: 'rejected', why };
      const body = { correlationId: corr, code: q.code, state: 'rejected', result: 'rejected', reason: why, origin: { from: q.from, via: q.via } };
      this.put(this.pending, `${base}/cmd/done`, body, { kind: 'cmd', props: { correlationData: corr } });
      if (q.responseTopic) this.put(this.pending, q.responseTopic, body, { kind: 'cmd', props: { correlationData: corr } });
      return null;
    };
    if (!s?.cmd) return reject('명령 콘솔 없음');
    if (q.receivedAt && now - q.receivedAt > (q.expirySec ?? 30) * 1000) return reject(`만료 (${q.expirySec ?? 30}초)`);
    if (q.zone !== 'main') return reject(`명령은 정밀조립Zone(main)만 받습니다 — ${q.zone} 존은 없습니다`);
    const C = COMMANDS[q.code]; if (!C) return reject(`모르는 명령 코드 ${q.code}`);
    let target = 'all';
    if (q.cell !== '_zone') { const st = (s.processing ?? []).find((x) => !x.standby && (seg(x.uid ?? x.id) === q.cell || x.id === q.cell)); if (!st) return reject(`정밀조립Zone에 없는 셀 ${q.cell}`); target = st.id; }
    if (!C.scopes.includes(target === 'all' ? 'all' : 'cell')) return reject(`${C.label}은(는) ${target === 'all' ? '셀 단위' : '존 전체'} 명령입니다`);
    let arg = null;
    if (C.args) { arg = Number(q.arg); if (!C.args.includes(arg)) return reject(`인자 ${q.arg} — 허용 ${C.args.join(' · ')}${C.unit ?? ''}`); }
    const c = s.cmd.issue(q.code, target, arg, { by: `UNS ${q.from ?? '외부'}`, why: q.reason || `UNS 명령 요청 (${corr})` });
    if (!c) return reject('명령 발행 거부');
    Object.assign(c, { unsCorr: corr, unsResp: q.responseTopic ?? null, unsFrom: q.from ?? null, unsVia: q.via ?? null });
    this.ext.applied++; this.ext.last = { at: s.time, correlationId: corr, result: 'issued', id: c.id };
    return c;
  }

  meta() {
    return { version: UNS_VERSION, root: this.root, run: this.runOf?.() ?? null, standard: 'ISA-95 Part 1 장비 계층 (Enterprise/Site → Area → Work Unit → Equipment)', levels: ISA95, areas: UNS_AREAS,
      namespaces: { _meta: '토픽 규칙', _facos: '공장 오케스트레이터 · Agent Gateway (상태·오더·결정·A2A)', _zone: '존 오케스트레이터 (상태·KPI·품질 표본·존 전체 명령)' },
      commandRequest: { topic: `${this.root}/{존}/{셀|_zone}/cmd/request`, body: { code: 'COMMANDS 코드 (SPEED · CYCLE_STOP · RESUME …)', arg: '인자 (SPEED는 50·75·100·110)', reason: '사유', correlationId: 'Correlation ID (MQTT 5는 Correlation Data)', responseTopic: '응답 토픽 (선택 · MQTT 5는 Response Topic)', expirySec: '만료 초 (기본 30 · 최대 300 · MQTT 5는 Message Expiry)' }, accounts: 'operator(모든 존) · zone-{존}(자기 존만) — 익명은 읽기 전용' },
      sparkplug: { group: 'metafactory', edges: 'edge-{존}', devices: '셀', host: 'metafactory-uns-bridge', bridgeTo: `${this.root}/{존}/{셀}/telemetry · edge` },
      rules: ['상태(state · order)는 retain + 값이 바뀔 때만 발행 (Report by Exception)', '이벤트(decision · a2a · cmd)는 retain 없음', '명령은 correlationId로 cmd → cmd/ack → cmd/exec → cmd/done을 묶음 — 접수 ACK만으로 재개하지 않음', '읽기(구독)는 모두 허용 · 쓰기(발행)는 역할·존별 ACL — UNS 상태 토픽은 앱만 발행', '발행이 끊기면 게이트웨이가 _facos/state를 online:false로 바꾸고 다시 붙으면 rebirth로 모든 상태를 다시 발행'],
      legacy: ['opcua/json/# (OPC UA PubSub Part 14)', 'aas/metafactory/# (AAS)', 'metafactory/{telemetry|events|oee|quality|sensors}/v1/# (평면 · 대시보드용) — 그대로 병행 발행'] };
  }

  // 트리 보기용 요약
  summary() {
    const E = [...this.tree.values()];
    return { topics: E.length, retained: E.filter((e) => e.retain).length, ...this.stats, outbox: this.outbox.length, lost: this.lost.n, acked: this.tx.acked, sendFailed: this.tx.failed };
  }
}
// 화면에서 쓰는 전송 함수 — HTTP 오류(r.ok === false)와 JSON 오류 응답({ error })도 실패로 던진다 (JSON 본문이 있다고 성공으로 치지 않는다)
export const unsPostVia = (fetchImpl, url = '/api/mqtt/publish') => async (messages) => {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
  let j = null; try { j = await r.json(); } catch { /* JSON이 아닌 응답 */ }
  if (!r.ok || !j || j.error) throw new Error(j?.error ? String(j.error) : `HTTP ${r.status}`);
  return j;
};
