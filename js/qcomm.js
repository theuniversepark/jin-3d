// 불량 판정 리포트 전송 · RCA 서버 연동 (품질 통신) — 사례마다 메시지 흐름을 시뮬레이션하고 실제 패킷(pcap)으로 남긴다
//  ① 검사셀 엣지 → MQTT 브로커 → 메인 서버: 불량 판정 리포트 (MQTT 5 QoS 1 · Content Type application/cloudevents+json · CloudEvents 1.0 JSON)
//       토픽 metafactory/quality/v1/defect/{zone}/{검사셀}
//  ② 메인 서버(FacOS 품질 모듈) → RCA 서버: 같은 리포트 + 메인 서버 메타 (HTTP/1.1 POST /api/rca/v1/reports → 202 Accepted · 티켓)
//  ③ RCA 서버 분석 → 메인 서버: 원인 확정/재검토 · 우선순위 · 봉쇄 · 대책 (MQTT metafactory/quality/v1/rca/{사례}/result)
//  ④ 메인 서버 → 셀(Zone 오케스트레이터): 봉쇄 조치 지시 (MQTT …/action/{셀}) → 셀 수신 확인 (MQTT …/ack/{사례})
//  ⑤ 8D 종결 → 메인 서버 → RCA 서버: 종결 보고 (HTTP POST /api/rca/v1/reports/{티켓}/close → 200)
// 주소 계획(js/pcap.js와 같음): 브로커 10.20.0.10:1883 · 메인 서버 10.20.0.20 · RCA 서버 10.20.0.30:8080 · 검사셀 엣지 10.20.1.4x · 샘플 재검 판정기(검사·포장셀) 10.20.1.60
// RCA 서버 처리는 js/rcacore.js — 맥 앱·npm start에서는 실제 서버(server/rca-api.mjs)에도 같은 리포트를 보내 결과를 함께 보여 준다(live).
// 렌더링과 분리 — 헤드리스에서도 같은 흐름. 시뮬레이션 난수를 쓰지 않는다.
import { PacketCapture } from './pcap.js';
import { RcaCore, RCA_SCHEMA } from './rcacore.js';

export const QHOST = {
  broker: { name: 'MQTT 브로커', ip: [10, 20, 0, 10], port: 1883 },
  main: { name: '메인 서버 (FacOS 품질 모듈)', ip: [10, 20, 0, 20] },
  rca: { name: 'RCA 서버', ip: [10, 20, 0, 30], port: 8080 },
};
const EDGE_IP = { DT_FAST: [10, 20, 1, 41], EA_FAST: [10, 20, 1, 42], QIS: [10, 20, 1, 60] };
const T = 'metafactory/quality/v1';
export const QTOPIC = { defect: (z, st) => `${T}/defect/${z}/${st}`, result: (id) => `${T}/rca/${id}/result`, action: (st) => `${T}/action/${st}`, ack: (id) => `${T}/ack/${id}` };
const RCA_PROC = 3, HOP = 0.4;   // RCA 서버 분석 시간 · 메인 서버 전달 지연 (공장 시계 초)
const MAX_CASES = 200;
const ipStr = (ip) => ip.join('.');

export class QualityComm {
  constructor(sim) {
    sim.qcomm = this; this.sim = sim; this.core = new RcaCore();
    this.epochMs = Date.UTC(2026, 9, 18, 23, 0, 0);   // 화면에서는 DataHub 기준 시계로 맞춘다 (setEpoch)
    this.cap = new PacketCapture(); this.cap.limit = 60e6; this.cap.start(this.epochMs);
    this.cases = new Map(); this.order = [];
    this.mirror = null;   // () => 전체 캡처(DataHub pcap)가 켜져 있으면 그 PacketCapture — 같은 패킷을 함께 기록
    this.runId = null;    // 이번 실행 ID (화면: DataHub runId) — 사례 번호 NG-날짜-0001은 실행마다 다시 시작하므로 RCA 서버는 (실행, 사례)로 같은 건을 가린다
    this.live = false;    // 실제 RCA 서버(앱 서버 /api/rca/v1)에 같은 리포트를 보낼지 (화면에서 서버가 있으면 true)
    this.stats = { reports: 0, mqtt: 0, http: 0, bytes: 0, results: 0, actions: 0, closed: 0, liveOk: 0, liveFail: 0 };
  }
  setEpoch(ms) { this.epochMs = ms; if (!this.cases.size) this.cap.start(this.ms()); }   // 화면 기준 시계(DataHub)로 — 아직 사례가 없으면 캡처도 그 시계로 다시 시작
  iso(t = this.sim.time) { return new Date(this.epochMs + t * 1000).toISOString(); }
  ms(t = this.sim.time) { return this.epochMs + t * 1000; }
  caps() { const m = this.mirror?.(); return m?.on ? [this.cap, m] : [this.cap]; }

  // 리포트 본문 (스키마 metafactory/quality-defect-report/1.0) — 계보 정답 라벨(불량이 생긴 셀)은 넣지 않는다
  reportOf(c) {
    const r = this.sim.trace?.byId.get(c.serial);
    return {
      schema: RCA_SCHEMA, runId: this.runId, caseId: c.id, kind: c.kind, serial: c.serial, product: c.product, order: c.order, mode: c.mode, detectedAt: c.detectedAt, detectedName: c.detectedName, time: this.iso(c.t),
      inspection: c.inspection, escaped: false,
      rca: { model: c.rca?.model, confidence: c.rca?.confidence, causes: (c.rca?.causes ?? []).slice(0, 5).map((x) => ({ station: x.station, factor: x.factor, label: x.label, score: x.score })), why: c.rca?.why },
      suspects: c.suspects, excursions: c.excursions, equipment: c.equipment,
      genealogy: r ? r.steps.map((p) => ({ station: p.st, name: p.name, start: this.iso(p.tIn), end: p.tOut != null ? this.iso(p.tOut) : null, health: p.health, drift: p.drift, cpk: p.cpk, params: p.params, env: p.env, carrier: p.amr, robots: p.robots })) : [],
    };
  }
  // 검사셀 엣지: 사례의 검사셀 uid(CL-03) → 셀 id(DT_FAST) · 출하 전 샘플 재검 NG는 검사·포장셀 샘플 재검 판정기
  edgeOf(c) { const k = c.kind === 'sample' ? 'QIS' : this.sim.processing.find((x) => (x.uid ?? x.id) === c.detectedAt)?.id ?? String(c.detectedAt); return { key: `EDGE-${k}`, ip: EDGE_IP[k] ?? [10, 20, 1, 49], st: k }; }
  log(cm, from, to, proto, ref, bytes, note) { cm.msgs.push({ t: this.sim.time, from, to, proto, ref, bytes, note }); this.stats.bytes += bytes; this.stats[proto === 'HTTP' ? 'http' : 'mqtt']++; }

  // MQTT 발행: 보낸 쪽 → 브로커 → 구독자 (모든 캡처에 같은 패킷)
  pub(cm, key, ip, topic, obj, subsOf) {
    const payload = JSON.stringify(obj), tMs = this.ms();
    for (const P of this.caps()) {
      P.tag = cm.id;
      // 구독자 먼저 접속 (메인 서버 · 검사셀 엣지가 품질 토픽을 구독)
      P.client('MES-QMS', 'facos', tMs, [`${T}/defect/#`, `${T}/rca/+/result`, `${T}/ack/#`], QHOST.main.ip);
      for (const [k, sip, subs] of subsOf ?? []) P.client(k, 'lan', tMs, subs, sip);
      P.publish({ key, kind: 'lan', ip, topic, payload, tMs, subs: [], props: { format: 1, contentType: 'application/cloudevents+json' } });
      P.tag = null;
    }
    return new TextEncoder().encode(payload).length;
  }
  // HTTP 요청 (메인 서버 → RCA 서버)
  post(cm, path, obj, res, status, reason) {
    const body = JSON.stringify(obj), resBody = JSON.stringify(res), tMs = this.ms();
    for (const P of this.caps()) { P.tag = cm.id; P.http({ key: 'MES-QMS', ip: QHOST.main.ip, server: QHOST.rca, method: 'POST', path, host: `rca.metafactory.local:${QHOST.rca.port}`, headers: { 'X-Correlation-Id': cm.id, 'User-Agent': 'FacOS-QMS/1.0' }, body, status, reason, resBody, tMs, srvMs: 4 }); P.tag = null; }
    return new TextEncoder().encode(body).length + new TextEncoder().encode(resBody).length;
  }

  // ① ~ ④ 불량 사례 하나 (capa.js onDefect에서 호출)
  report(c) {
    if (this.cases.has(c.id)) return this.cases.get(c.id);
    const e = this.edgeOf(c), zone = 'main', rep = this.reportOf(c);
    const cm = { id: c.id, serial: c.serial, edge: e, t0: this.sim.time, status: 'sent', ticket: null, result: null, msgs: [], report: rep, live: null };
    this.cases.set(c.id, cm); this.order.push(c.id); this.stats.reports++;
    if (this.order.length > MAX_CASES) { const old = this.order.shift(); this.cases.delete(old); this.cap.recs = this.cap.recs.filter((x) => x.tag !== old); }
    const edgeSubs = [[e.key, e.ip, [QTOPIC.action(e.st)]]];
    // ① 검사셀 엣지 → 브로커 → 메인 서버
    const ev = { specversion: '1.0', type: 'kr.metafactory.quality.defect.v1', source: `urn:metafactory:edge:${e.st}`, id: c.id, time: this.iso(c.t), subject: c.serial, datacontenttype: 'application/json', dataschema: RCA_SCHEMA, data: rep };
    const n1 = this.pub(cm, e.key, e.ip, QTOPIC.defect(zone, e.st), ev, edgeSubs);
    this.log(cm, `검사셀 엣지 ${e.st} (${ipStr(e.ip)})`, '메인 서버 (브로커 경유)', 'MQTT', QTOPIC.defect(zone, e.st), n1, `불량 판정 리포트 · QoS 1 · ${c.inspection?.mode ?? 'NG'}`);
    // ② 메인 서버 → RCA 서버 (HTTP)
    this.later(HOP, () => {
      const R = this.core.receive({ ...rep, receivedBy: 'FacOS-QMS', forwardedAt: this.iso() }, this.iso());
      cm.ticket = R.body.ticket; cm.status = 'received';
      const n2 = this.post(cm, '/api/rca/v1/reports', { ...rep, receivedBy: 'FacOS-QMS', forwardedAt: this.iso() }, R.body, R.code, R.code === 202 ? 'Accepted' : 'OK');
      this.log(cm, `메인 서버 (${ipStr(QHOST.main.ip)})`, `RCA 서버 (${ipStr(QHOST.rca.ip)}:${QHOST.rca.port})`, 'HTTP', 'POST /api/rca/v1/reports', n2, `${R.code} · 티켓 ${R.body.ticket}`);
      this.sendLive(cm, rep);
      // ③ RCA 서버 분석 → 결과 발행
      this.later(RCA_PROC, () => {
        const V = this.core.analyze(cm.ticket, this.iso()); cm.result = V.result; cm.status = 'analyzed'; this.stats.results++;
        const n3 = this.pub(cm, 'RCA-SRV', QHOST.rca.ip, QTOPIC.result(c.id), V.result, edgeSubs);
        this.log(cm, `RCA 서버 (${ipStr(QHOST.rca.ip)})`, '메인 서버 (브로커 경유)', 'MQTT', QTOPIC.result(c.id), n3, `분석 결과 · ${V.result.priority} · ${V.result.rootCause?.status ?? '-'} ${V.result.rootCause?.label ?? ''}`);
        // ④ 메인 서버 → 셀 봉쇄 지시 → 셀 수신 확인
        this.later(HOP, () => {
          const act = { caseId: c.id, ticket: cm.ticket, priority: V.result.priority, containment: V.result.containment, hold: (c.suspects ?? []).map((x) => x.serial), issuedBy: 'FacOS-QMS', time: this.iso() };
          const n4 = this.pub(cm, 'MES-QMS', QHOST.main.ip, QTOPIC.action(e.st), act, edgeSubs);
          this.log(cm, '메인 서버', `검사셀 엣지 ${e.st} · Zone 오케스트레이터`, 'MQTT', QTOPIC.action(e.st), n4, `봉쇄 조치 지시 ${act.containment.length}건 · 출하 보류 ${act.hold.length}개`);
          this.later(HOP, () => {
            const ack = { caseId: c.id, ticket: cm.ticket, accepted: true, by: `EDGE-${e.st}`, time: this.iso() };
            const n5 = this.pub(cm, e.key, e.ip, QTOPIC.ack(c.id), ack, edgeSubs);
            this.log(cm, `검사셀 엣지 ${e.st}`, '메인 서버 (브로커 경유)', 'MQTT', QTOPIC.ack(c.id), n5, '조치 수신 확인');
            this.core.action(cm.ticket, this.iso(), { hold: act.hold.length }); cm.status = 'actioned'; this.stats.actions++;
          });
        });
      });
    });
    return cm;
  }
  // ⑤ 8D 종결 (capa.js D8) — 묶인 사례마다 종결 보고
  close(k) {
    for (const id of k.cases ?? []) {
      const cm = this.cases.get(id); if (!cm?.ticket || cm.status === 'closed') continue;
      const sum = { capa: k.id, status: k.status, cause: k.cause?.label, proposal: k.proposal?.title ?? null, cases: k.cases.length, fmea: k.fmea ?? null };
      const R = this.core.close(cm.ticket, sum, this.iso());
      const n = this.post(cm, `/api/rca/v1/reports/${cm.ticket}/close`, sum, R.body, R.code, R.code === 200 ? 'OK' : 'Not Found');
      this.log(cm, '메인 서버', 'RCA 서버', 'HTTP', `POST /api/rca/v1/reports/${cm.ticket}/close`, n, `8D 종결 보고 · ${k.id} ${k.status === 'held' ? '보류 종결' : '종결'}`);
      cm.status = 'closed'; this.stats.closed++;
      if (this.live && cm.live?.ticket) fetch(`/api/rca/v1/reports/${cm.live.ticket}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sum) }).catch(() => {});
    }
  }
  // 실제 RCA 서버(맥 앱·npm start): 같은 리포트를 보내고 결과를 받아 둔다
  sendLive(cm, rep) {
    if (!this.live || typeof fetch !== 'function') return;
    fetch('/api/rca/v1/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': cm.id }, body: JSON.stringify(rep) })
      .then((r) => r.json()).then((b) => {
        cm.live = { ticket: b.ticket, status: b.status }; this.stats.liveOk++;
        const poll = (n) => setTimeout(() => fetch(`/api/rca/v1/reports/${b.ticket}`).then((r) => r.json()).then((v) => { cm.live = { ticket: v.ticket, status: v.status, result: v.result }; if (!v.result && n > 0) poll(n - 1); }).catch(() => {}), 1500);
        poll(4);
      }).catch(() => { this.stats.liveFail++; cm.live = { error: 'RCA 서버 연결 실패' }; });
  }
  later(dt, fn) { this.sim.orch ? this.sim.orch.later(dt, fn) : fn(); }
  pcap(caseId = null) { return this.cap.build(caseId); }
}
