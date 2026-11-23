// Sparkplug B 엣지 노드 · 주 호스트(Primary Host) — 설비 데이터가 Sparkplug로 들어오고, 브리지가 ISA-95 UNS 트리로 옮긴다.
//   엣지 노드 = 존마다 하나 (jin-3d는 edge-main 하나) · 디바이스 = 셀(설비)
//     NBIRTH(bdSeq · Node Control/Rebirth) → DBIRTH(전체 메트릭 + alias) → DDATA(바뀐 메트릭만 · alias) · seq 0~255 순환
//     접속할 때 NDEATH(bdSeq)를 LWT로 걸어 둔다 — 갑자기 끊기면 브로커가 대신 알림. 정상 종료는 NDEATH를 직접 보내고 끊는다
//   주 호스트 = metafactory-uns-bridge
//     spBv1.0/STATE/{호스트} {online} retain (LWT offline) · spBv1.0/{group}/# 구독
//     seq가 건너뛰거나 모르는 alias면 NCMD Node Control/Rebirth=true → 엣지가 탄생 메시지를 다시 보냄
//     → camtic/metafactory/{존}/{셀}/telemetry (값 + _sparkplug 출처) · {존}/{셀}/edge {online} retain
// 데이터 원천: 앱 화면(시뮬레이션)이 2초마다 올리는 설비 요약(metafactory/telemetry/v1/{존}/{셀}) — 실장비라면 이 자리에 Node-RED·Neuron·PLC 게이트웨이가 온다.
import { connect } from 'mqtt';
import { encodePayload, decodePayload, parseTopic, topicOf, DT, SPB } from './sparkplug-b.mjs';

export const SP_GROUP = 'metafactory';
export const SP_HOST = 'metafactory-uns-bridge';
const UNS = 'camtic/metafactory';
// 설비 요약 → Sparkplug 메트릭 (이름 · 자료형)
export const SP_METRICS = [['health', DT.Double], ['rul_min', DT.Double], ['risk10', DT.Double], ['cpk', DT.Double], ['util', DT.Double], ['state', DT.String], ['busy', DT.Boolean], ['down', DT.Boolean]];
const conv = (type, v) => (v == null ? null : type === DT.Boolean ? !!v : type === DT.String ? String(v) : Number(v));

class EdgeNode {
  constructor(sp, zone) { this.sp = sp; this.zone = zone; this.id = `edge-${zone}`; this.devices = new Map(); this.bdSeq = -1; this.seq = 0; this.client = null; this.born = false; this.stats = { births: 0, dbirths: 0, ddata: 0, rebirths: 0 }; }
  t(type, dev) { return topicOf(SP_GROUP, type, this.id, dev); }
  nextSeq() { const s = this.seq; this.seq = (this.seq + 1) % 256; return s; }
  start() {
    if (this.client) return;
    this.bdSeq = (this.bdSeq + 1) % 256; this.born = false;
    const death = encodePayload({ timestamp: Date.now(), metrics: [{ name: 'bdSeq', type: DT.Int64, value: this.bdSeq }] });
    this.client = connect(this.sp.url(), { clientId: `${this.id}-${process.pid}`, clean: true, reconnectPeriod: 0, ...this.sp.creds('edge', this.id), will: { topic: this.t('NDEATH'), payload: death, qos: 1, retain: false } });
    this.client.on('connect', () => {
      this.client.subscribe([this.t('NCMD'), `${this.t('DCMD')}/+`]);
      this.birth();
    });
    this.client.on('message', (topic, buf) => {
      const p = decodePayload(buf); if (p.metrics.some((m) => m.name === 'Node Control/Rebirth' && m.value === true)) { this.stats.rebirths++; this.birth(); }
    });
    this.client.on('error', (e) => { this.sp.state.error = `${this.id}: ${e.message}`; });
    this.client.on('close', () => { this.born = false; });
  }
  birth() {
    if (!this.client?.connected) return;
    this.seq = 0;
    this.client.publish(this.t('NBIRTH'), encodePayload({ timestamp: Date.now(), seq: this.nextSeq(), metrics: [{ name: 'bdSeq', type: DT.Int64, value: this.bdSeq }, { name: 'Node Control/Rebirth', type: DT.Boolean, value: false }, { name: 'Properties/ISA-95 Area', type: DT.String, value: this.zone }] }), { qos: 0 });
    this.born = true; this.stats.births++;
    for (const [dev, d] of this.devices) this.dbirth(dev, d);
  }
  dbirth(dev, d) {
    d.sent = { ...d.values };
    this.client.publish(this.t('DBIRTH', dev), encodePayload({ timestamp: Date.now(), seq: this.nextSeq(), metrics: SP_METRICS.map(([name, type], i) => ({ name, alias: i + 1, type, value: conv(type, d.values[name]) })) }));
    d.born = true; this.stats.dbirths++;
  }
  ingest(dev, values) {
    let d = this.devices.get(dev);
    if (!d) { d = { values: {}, sent: null, born: false }; this.devices.set(dev, d); }
    d.values = values;
    if (!this.client) return this.start();
    if (!this.born || !this.client.connected) return;
    if (!d.born) return this.dbirth(dev, d);
    const changed = SP_METRICS.map(([name, type], i) => ({ name, alias: i + 1, type })).filter((m) => d.sent[m.name] !== d.values[m.name]);   // Report by Exception
    if (!changed.length) return;
    this.client.publish(this.t('DDATA', dev), encodePayload({ timestamp: Date.now(), seq: this.nextSeq(), metrics: changed.map(({ alias, type, name }) => ({ alias, type, value: conv(type, d.values[name]) })) }));
    d.sent = { ...d.values }; this.stats.ddata++;
  }
  // 정상 종료: NDEATH를 직접 보내고 끊는다 (다시 시작하면 bdSeq + 1)
  stop() {
    const c = this.client; if (!c) return; this.client = null; this.born = false;
    for (const d of this.devices.values()) d.born = false;
    if (c.connected) c.publish(this.t('NDEATH'), encodePayload({ timestamp: Date.now(), metrics: [{ name: 'bdSeq', type: DT.Int64, value: this.bdSeq }] }), { qos: 1 }, () => c.end());
    else c.end(true);
  }
  // 시험용: 연결을 끊어 LWT(NDEATH)가 나가게 한다
  crash() { const c = this.client; this.client = null; this.born = false; for (const d of this.devices.values()) d.born = false; c?.stream?.destroy(); }
}

class PrimaryHost {
  constructor(sp) { this.sp = sp; this.nodes = new Map(); this.client = null; this.stats = { births: 0, dbirths: 0, ddata: 0, gaps: 0, rebirthReq: 0, ndeaths: 0, stale: 0 }; }
  start() {
    if (this.client) return;
    const st = (online) => JSON.stringify({ online, timestamp: Date.now() });
    this.client = connect(this.sp.url(), { clientId: `${SP_HOST}-${process.pid}`, clean: true, reconnectPeriod: 2000, ...this.sp.creds('host', SP_HOST), will: { topic: `${SPB}/STATE/${SP_HOST}`, payload: st(false), qos: 1, retain: true } });
    this.client.on('connect', () => {
      this.client.publish(`${SPB}/STATE/${SP_HOST}`, st(true), { qos: 1, retain: true });
      this.client.subscribe(`${SPB}/${SP_GROUP}/#`, { qos: 0 });
    });
    this.client.on('message', (topic, buf) => { try { this.onMessage(topic, buf); } catch (e) { this.sp.state.error = `host: ${e.message}`; } });
    this.client.on('error', (e) => { this.sp.state.error = `host: ${e.message}`; });
  }
  stop() { const c = this.client; this.client = null; if (c?.connected) c.publish(`${SPB}/STATE/${SP_HOST}`, JSON.stringify({ online: false, timestamp: Date.now() }), { qos: 1, retain: true }, () => c.end()); else c?.end(true); }
  node(edge) { let n = this.nodes.get(edge); if (!n) { n = { edge, zone: edge.replace(/^edge-/, ''), online: false, bdSeq: null, seq: null, devices: new Map() }; this.nodes.set(edge, n); } return n; }
  rebirth(n, why) { this.stats.rebirthReq++; n.lastRebirth = why; this.client.publish(topicOf(SP_GROUP, 'NCMD', n.edge), encodePayload({ timestamp: Date.now(), metrics: [{ name: 'Node Control/Rebirth', type: DT.Boolean, value: true }] })); }
  checkSeq(n, seq) {
    if (n.seq != null && seq !== (n.seq + 1) % 256) { this.stats.gaps++; n.seq = seq; this.rebirth(n, `seq ${seq} (기대 ${(n.seq + 1) % 256})`); return false; }
    n.seq = seq; return true;
  }
  edgeState(n, dev, online, why) { this.sp.uns([{ topic: `${UNS}/${n.zone}/${dev}/edge`, payload: JSON.stringify({ online, source: 'sparkplug', edge: n.edge, bdSeq: n.bdSeq, reason: why, ts: new Date().toISOString() }), retain: true }]); }
  onMessage(topic, buf) {
    const T = parseTopic(topic); if (!T || T.type === 'STATE' || T.group !== SP_GROUP) return;
    if (['NCMD', 'DCMD'].includes(T.type)) return;   // 자기가 보낸 명령
    const p = decodePayload(buf), n = this.node(T.edge);
    if (T.type === 'NBIRTH') { n.online = true; n.bdSeq = p.metrics.find((m) => m.name === 'bdSeq')?.value ?? null; n.seq = p.seq ?? 0; this.stats.births++; return; }
    if (T.type === 'NDEATH') {
      const bd = p.metrics.find((m) => m.name === 'bdSeq')?.value;
      if (bd !== n.bdSeq) { this.stats.stale++; return; }   // 이전 연결의 늦은 죽음 — 지금 연결과 무관
      n.online = false; n.seq = null; this.stats.ndeaths++;
      for (const [dev, d] of n.devices) { d.online = false; this.edgeState(n, dev, false, 'NDEATH'); }
      return;
    }
    if (!n.online) { this.rebirth(n, `탄생 전 ${T.type}`); return; }
    const okSeq = this.checkSeq(n, p.seq);
    if (T.type === 'DBIRTH') {
      const d = { aliases: new Map(), values: {}, online: true };
      for (const m of p.metrics) { if (m.alias != null) d.aliases.set(m.alias, m.name); d.values[m.name] = m.value; }
      n.devices.set(T.device, d); this.stats.dbirths++;
      this.edgeState(n, T.device, true, 'DBIRTH'); this.publish(n, T.device, d, p);
      return;
    }
    if (T.type === 'DDEATH') { const d = n.devices.get(T.device); if (d) { d.online = false; this.edgeState(n, T.device, false, 'DDEATH'); } return; }
    if (T.type === 'DDATA') {
      const d = n.devices.get(T.device);
      if (!d) { this.rebirth(n, `모르는 디바이스 ${T.device}`); return; }
      for (const m of p.metrics) { const name = m.name ?? d.aliases.get(m.alias); if (!name) { this.rebirth(n, `모르는 alias ${m.alias}`); return; } d.values[name] = m.value; }
      this.stats.ddata++;
      if (okSeq) this.publish(n, T.device, d, p);
    }
  }
  publish(n, dev, d, p) {
    this.sp.uns([{ topic: `${UNS}/${n.zone}/${dev}/telemetry`, payload: JSON.stringify({ asset: dev, zone: n.zone, ...d.values, _sparkplug: { edge: n.edge, device: dev, seq: p.seq, bdSeq: n.bdSeq, ts: p.timestamp } }) }]);
  }
}

// sp = makeSparkplug({ url: () => 'mqtt://127.0.0.1:1883', creds: (role, id) => ({ username, password }), uns: (messages) => 브로커 발행 })
export function makeSparkplug({ url, creds, uns }) {
  const state = { on: true, error: null };
  const sp = { url, creds, uns, state };
  const host = new PrimaryHost(sp), edges = new Map();
  host.start();
  return {
    host, edges,
    ingest(zone, dev, values) { if (!state.on) return; let e = edges.get(zone); if (!e) { e = new EdgeNode(sp, zone); edges.set(zone, e); } e.ingest(dev, values); },
    pause() { for (const e of edges.values()) e.stop(); },   // 원천(화면)이 끊기면 엣지도 정상 종료 — 다시 데이터가 오면 새 bdSeq로 탄생
    stop() { for (const e of edges.values()) e.stop(); host.stop(); state.on = false; },
    status: () => ({ on: state.on, error: state.error, group: SP_GROUP, host: { id: SP_HOST, connected: !!host.client?.connected, ...host.stats, nodes: [...host.nodes.values()].map((n) => ({ edge: n.edge, online: n.online, bdSeq: n.bdSeq, seq: n.seq, devices: n.devices.size, lastRebirth: n.lastRebirth ?? null })) },
      edges: [...edges.values()].map((e) => ({ id: e.id, connected: !!e.client?.connected, born: e.born, bdSeq: e.bdSeq, seq: e.seq, devices: e.devices.size, ...e.stats })) }),
  };
}
