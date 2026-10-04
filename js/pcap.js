// 패킷 덤프 (pcap) — AAS → OPC UA PubSub JSON → MQTT 3.1.1 → TCP/IPv4 로 나가는 메시지를 실제 패킷 모양으로 만들어
// libpcap(.pcap, Ethernet) 파일로 저장한다. Wireshark에서 그대로 열면 MQTT(1883)로 디코딩된다.
// 캡처 지점: MQTT 브로커 NIC (10.20.0.10:1883) — 브로커가 보고 받는 양방향 패킷 전부
//  · 클라이언트 → 브로커: TCP 3-way 핸드셰이크, CONNECT, SUBSCRIBE, PUBLISH(QoS 1, 1460B MSS로 분할), PINGREQ
//  · 브로커 → 클라이언트: SYN/ACK, CONNACK, SUBACK, PUBACK, 구독자에게 PUBLISH 전달(QoS 1), PINGRESP, TCP ACK
// 주소 계획: 브로커 10.20.0.10 · FACOS(오케스트레이터·DataHub 구독) 10.20.0.20 · 설비·셀(유선 LAN) 10.20.1.x
//  · CCTV 10.20.2.x · 이동 로봇(Private 5G, UPF가 준 UE 주소) 10.45.x.x — 5G 단말 패킷은 UPF(N6)를 거쳐 오므로 출발 MAC이 UPF
// 시각: 공장 기준 시계(시뮬레이션 시각) 마이크로초. 5G 단말은 무선 지연(약 8ms, 핸드오버 중이면 버퍼 대기만큼 더)을 더한다.
// 렌더링과 분리되어 있어 헤드리스 시험(tests/pcap.mjs)에서도 같은 바이트를 만든다.

const MSS = 1460, BROKER = { ip: [10, 20, 0, 10], port: 1883 }, UPF_MAC = [0x02, 0x00, 0x0a, 0x2d, 0x00, 0x01];
const enc = new TextEncoder();
const macOf = (ip) => [0x02, 0x00, ...ip];
const ipStr = (ip) => ip.join('.');

function csum(buf, start, end, init = 0) {
  let s = init;
  for (let i = start; i < end; i += 2) s += (buf[i] << 8) + (i + 1 < end ? buf[i + 1] : 0);
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return s;
}
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
// MQTT 가변 길이 정수 (Remaining Length)
function varLen(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0); return out; }
const mstr = (s) => { const b = enc.encode(s); return [...u16(b.length), ...b]; };
function concat(parts) { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

// ── MQTT 3.1.1 제어 패킷 ─────────────────
export const MQTT = {
  connect: (clientId, keepAlive = 60) => { const vh = [...mstr('MQTT'), 4, 0x02, ...u16(keepAlive)], pl = mstr(clientId); return Uint8Array.from([0x10, ...varLen(vh.length + pl.length), ...vh, ...pl]); },
  connack: () => Uint8Array.from([0x20, 0x02, 0x00, 0x00]),
  publish: (topic, payload, id, retain = false, qos = 1) => {
    const t = mstr(topic), head = [...t, ...(qos ? u16(id) : [])], body = typeof payload === 'string' ? enc.encode(payload) : payload;
    return concat([Uint8Array.from([0x30 | (qos << 1) | (retain ? 1 : 0), ...varLen(head.length + body.length), ...head]), body]);
  },
  puback: (id) => Uint8Array.from([0x40, 0x02, ...u16(id)]),
  subscribe: (id, filters) => { const vh = u16(id), pl = filters.flatMap((f) => [...mstr(f), 1]); return Uint8Array.from([0x82, ...varLen(vh.length + pl.length), ...vh, ...pl]); },
  suback: (id, n) => Uint8Array.from([0x90, ...varLen(2 + n), ...u16(id), ...Array(n).fill(1)]),
  pingreq: () => Uint8Array.from([0xc0, 0x00]),
  pingresp: () => Uint8Array.from([0xd0, 0x00]),
};
// MQTT 토픽 필터 일치 (+ · #)
export function topicMatch(filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) { if (f[i] === '#') return true; if (f[i] !== '+' && f[i] !== t[i]) return false; }
  return f.length === t.length;
}

export class PacketCapture {
  constructor() { this.reset(); }
  reset() {
    this.on = false; this.recs = []; this.bytes = 24; this.clients = new Map(); this.ipId = 1; this.t0 = null; this.tEnd = null;
    this.n = { lan: 0, g5: 0, cam: 0 };
    this.stats = { packets: 0, up: 0, down: 0, publishUp: 0, publishDown: 0, puback: 0, connect: 0, subscribe: 0, ping: 0, video: 0, msgs: 0, segs: 0 };
    this.limit = 200e6; this.full = false;
  }
  // opts.only = { key, kind, subs, label }: 개별 캡처 — 그 자산 한 대의 MQTT 연결(발행·PUBACK·내려받는 명령·영상·keep-alive)만 기록
  start(nowMs, opts = {}) {
    this.reset(); this.on = true; this.video = opts.video !== false; this.t0 = nowMs; this.tEnd = nowMs; this.only = opts.only ?? null;
    if (this.only) this.client(this.only.key, this.only.kind, nowMs, this.only.subs ?? [], this.only.ip);
  }
  stop() { this.on = false; }
  get duration() { return this.t0 == null ? 0 : (this.tEnd - this.t0) / 1000; }

  // 클라이언트 접속 정보 (처음 보면 TCP 핸드셰이크 → CONNECT/CONNACK → SUBSCRIBE/SUBACK)
  client(key, kind, tMs, subs = [], fixedIp = null) {
    let c = this.clients.get(key);
    if (c) return c;
    let ip = fixedIp;   // 자산마다 정해진 주소 (전체·개별 캡처에서 같은 주소)
    if (ip) { /* 그대로 */ } else if (kind === 'facos') ip = [10, 20, 0, 20];
    else if (kind === '5g') { const k = ++this.n.g5; ip = [10, 45, (k >> 8) & 0xff, k & 0xff]; }
    else if (kind === 'cam') { const k = ++this.n.cam; ip = [10, 20, 2, k]; }
    else { const k = ++this.n.lan; ip = [10, 20, 1 + (k >> 8), k & 0xff]; }
    c = { key, kind, ip, mac: kind === '5g' ? UPF_MAC : macOf(ip), port: 49152 + this.clients.size, cseq: 1000 + this.clients.size * 7919, sseq: 500000 + this.clients.size * 104729, pid: 0, spid: 0, last: tMs, subs, clientId: `jin3d-${key}` };
    this.clients.set(key, c);
    const lat = this.lat(c);
    let t = tMs - 3 - lat * 3;   // 접속은 첫 메시지 직전에 끝나 있다
    this.seg(c, 'up', 0x02, null, t, true); c.cseq++;              // SYN (MSS 옵션)
    this.seg(c, 'down', 0x12, null, t += 0.05, true); c.sseq++;     // SYN/ACK
    this.seg(c, 'up', 0x10, null, t += lat);                        // ACK
    this.seg(c, 'up', 0x18, MQTT.connect(c.clientId), t += 0.02); this.stats.connect++;
    this.seg(c, 'down', 0x18, MQTT.connack(), t += 0.1);
    if (subs.length) { const id = ++c.pid; this.seg(c, 'up', 0x18, MQTT.subscribe(id, subs), t += lat); this.stats.subscribe++; this.seg(c, 'down', 0x18, MQTT.suback(id, subs.length), t += 0.1); }
    return c;
  }
  lat(c) { return c.kind === '5g' ? 8 + (c.extra ?? 0) : 0.3; }   // 브로커까지 편도 지연 (ms)
  // 메시지 한 건 발행: 클라이언트 → 브로커 PUBLISH(+분할) → 브로커 PUBACK → 구독자에게 PUBLISH → 구독자 PUBACK
  publish({ key, kind, topic, payload, tMs, retain = false, subs = [], extraMs = 0, video = false, ip = null }) {
    if (!this.on || this.full) return;
    if (this.only && key !== this.only.key) {   // 개별 캡처: 다른 클라이언트가 보낸 메시지는 이 자산이 구독한 것만(브로커 → 이 자산 전달)
      const s = this.clients.get(this.only.key);
      if (s && s.subs.some((f) => topicMatch(f, topic))) {
        this.keepalive(s, tMs);
        const sid = (s.spid = (s.spid % 65535) + 1), t = tMs + 0.4;
        this.data(s, 'down', MQTT.publish(topic, payload, sid, false), t); this.stats.publishDown++; this.stats.msgs++;
        this.seg(s, 'up', 0x18, MQTT.puback(sid), t + this.lat(s) * 2 + 0.1); this.stats.puback++; s.last = t;
      }
      if (this.bytes > this.limit) { this.full = true; this.on = false; }
      return;
    }
    const c = this.client(key, kind, tMs, subs, ip);
    c.extra = extraMs;
    this.keepalive(c, tMs);
    const id = (c.pid = (c.pid % 65535) + 1), pkt = MQTT.publish(topic, payload, id, retain);
    let t = tMs + this.lat(c);
    this.data(c, 'up', pkt, t); this.stats.publishUp++; this.stats.msgs++; if (video) this.stats.video++;
    this.seg(c, 'down', 0x18, MQTT.puback(id), t += 0.15); this.stats.puback++;
    // 구독자에게 전달 (보낸 클라이언트 자신은 제외)
    for (const s of this.clients.values()) {
      if (s === c || !s.subs.some((f) => topicMatch(f, topic))) continue;
      const sid = (s.spid = (s.spid % 65535) + 1), fwd = MQTT.publish(topic, payload, sid, false);
      const ts = t + 0.05;
      this.data(s, 'down', fwd, ts); this.stats.publishDown++;
      this.seg(s, 'up', 0x18, MQTT.puback(sid), ts + this.lat(s) * 2 + 0.1); this.stats.puback++;
      s.last = ts;
    }
    c.last = tMs; c.extra = 0;
    if (this.bytes > this.limit) { this.full = true; this.on = false; }
  }
  // 60초 동안 보낸 것이 없으면 PINGREQ/PINGRESP (keep-alive)
  keepalive(c, tMs) {
    while (tMs - c.last > 60000) { const t = c.last + 60000; this.seg(c, 'up', 0x18, MQTT.pingreq(), t); this.seg(c, 'down', 0x18, MQTT.pingresp(), t + 0.1 + this.lat(c)); this.stats.ping++; c.last = t; }
  }
  tick(tMs) { if (this.on) for (const c of this.clients.values()) this.keepalive(c, tMs); }
  // 긴 MQTT 패킷 → MSS 단위 TCP 세그먼트, 받는 쪽은 두 세그먼트마다 ACK (지연 ACK)
  data(c, dir, bytes, t) {
    const n = Math.ceil(bytes.length / MSS);
    for (let k = 0; k < n; k++) {
      this.seg(c, dir, k === n - 1 ? 0x18 : 0x10, bytes.subarray(k * MSS, (k + 1) * MSS), t + k * 0.012);
      if (n > 1 && k % 2 === 1 && k < n - 1) this.seg(c, dir === 'up' ? 'down' : 'up', 0x10, null, t + k * 0.012 + 0.03);
    }
  }
  // Ethernet + IPv4 + TCP 한 프레임
  seg(c, dir, flags, payload, tMs, syn = false) {
    const up = dir === 'up', src = up ? c.ip : BROKER.ip, dst = up ? BROKER.ip : c.ip, sp = up ? c.port : BROKER.port, dp = up ? BROKER.port : c.port;
    const smac = up ? c.mac : macOf(BROKER.ip), dmac = up ? macOf(BROKER.ip) : c.mac;
    const opt = syn ? [0x02, 0x04, ...u16(MSS)] : [], plen = payload ? payload.length : 0, tlen = 20 + opt.length, total = 20 + tlen + plen;
    const f = new Uint8Array(14 + total);
    f.set([...dmac, ...smac, 0x08, 0x00], 0);
    const ip = 14; f.set([0x45, 0x00, ...u16(total), ...u16(this.ipId++ & 0xffff), 0x40, 0x00, 64, 6, 0, 0, ...src, ...dst], ip);
    const ic = ~csum(f, ip, ip + 20) & 0xffff; f[ip + 10] = ic >> 8; f[ip + 11] = ic & 0xff;
    const seq = up ? c.cseq : c.sseq, ack = up ? c.sseq : c.cseq, tcp = ip + 20;
    f.set([...u16(sp), ...u16(dp), ...u32(seq >>> 0), ...u32(flags & 0x02 && !(flags & 0x10) ? 0 : ack >>> 0), (tlen / 4) << 4, flags, ...u16(65535), 0, 0, 0, 0, ...opt], tcp);
    if (payload) f.set(payload, tcp + tlen);
    const pseudo = csum(Uint8Array.from([...src, ...dst, 0, 6, ...u16(tlen + plen)]), 0, 12);
    const tc = ~csum(f, tcp, tcp + tlen + plen, pseudo) & 0xffff; f[tcp + 16] = tc >> 8; f[tcp + 17] = tc & 0xff;
    if (up) c.cseq = (c.cseq + plen) >>> 0; else c.sseq = (c.sseq + plen) >>> 0;
    // 같은 연결·방향에서는 시각이 거꾸로 가지 않게 (5G 지연 8ms · LAN 0.3ms가 섞여도 TCP 순서번호와 시각 순서가 같도록)
    const lk = up ? 'lu' : 'ld'; let us = Math.round(tMs * 1000); if (c[lk] != null && us <= c[lk]) us = c[lk] + 1; c[lk] = us;
    this.recs.push({ us, f }); this.bytes += 16 + f.length; this.stats.packets++; this.stats[up ? 'up' : 'down']++; if (plen) this.stats.segs++;
    this.tEnd = Math.max(this.tEnd ?? tMs, us / 1000);
  }
  // libpcap 파일 (마이크로초, Ethernet) — 시각 순 정렬
  build() {
    const recs = [...this.recs].sort((a, b) => a.us - b.us);
    const out = new Uint8Array(24 + recs.reduce((a, r) => a + 16 + r.f.length, 0)), dv = new DataView(out.buffer);
    dv.setUint32(0, 0xa1b2c3d4, true); dv.setUint16(4, 2, true); dv.setUint16(6, 4, true); dv.setInt32(8, 0, true); dv.setUint32(12, 0, true); dv.setUint32(16, 65535, true); dv.setUint32(20, 1, true);
    let o = 24;
    for (const r of recs) {
      dv.setUint32(o, Math.floor(r.us / 1e6), true); dv.setUint32(o + 4, r.us % 1e6, true); dv.setUint32(o + 8, r.f.length, true); dv.setUint32(o + 12, r.f.length, true);
      out.set(r.f, o + 16); o += 16 + r.f.length;
    }
    return out;
  }
  hosts() {
    const k = { facos: 0, lan: 0, '5g': 0, cam: 0 }; for (const c of this.clients.values()) k[c.kind]++;
    return k;
  }
}
export { ipStr };
