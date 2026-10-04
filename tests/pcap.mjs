// 패킷 덤프 검증 — DataHub가 만드는 AAS → OPC UA → MQTT 메시지를 pcap으로 기록하고, 만든 파일을 다시 읽어
// libpcap 헤더 · Ethernet/IPv4/TCP 체크섬 · TCP 순서번호 연속성 · MQTT 디코딩(토픽·QoS 1 PUBLISH ↔ PUBACK 짝) ·
// 양방향(클라이언트 → 브로커, 브로커 → 구독자) · 5G 이동 로봇 주소 · 상위 명령 다운링크 · 영상(JPEG) 분할 전송을 확인한다. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { DataHub } from '../js/datahub.js';
import { PacketCapture, MQTT } from '../js/pcap.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
globalThis.fetch = async () => { throw new Error('no server'); };   // 헤드리스: MQTT 서버 없이 패킷만 만든다

const s = new Simulation('dark', 2, { line: zoneLine() }), ag = new FactoryAgent(s), hub = new DataHub();   // 운영 로그 → Events 토픽도 나오도록 quiet 끔
hub.reset(s, null); hub.pcap = new PacketCapture(); hub.pcap.start(hub.epochMs + s.time * 1000);
// 개별 캡처 (정보 창): 운반 AMR 한 대(5G)와 셀 하나(LAN)
const amrA = hub.assets.find((a) => a.kind === 'AMR'), cellA = hub.assets.find((a) => a.kind === 'Station');
for (const a of [amrA, cellA]) { const P = new PacketCapture(); P.start(hub.epochMs + s.time * 1000, { only: hub.assetTarget(a) }); hub.assetPcaps.set(a.id, P); }
const step = (sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); hub.tick(0.1); } };
step(120);
s.cmd.issue('SAFE_SPEED', 'all'); step(5); s.cmd.issue('SAFE_SPEED_OFF', 'all'); step(60);
// 영상 프레임 (가짜 JPEG 12KB — CCTV 카메라가 OPC UA ua-data의 ByteString(base64)으로 발행)
const jpeg = new Uint8Array(12000); jpeg[0] = 0xff; jpeg[1] = 0xd8;
const b64 = Buffer.from(jpeg).toString('base64');
hub.pcap.publish({ key: 'CCTV-CC-01', kind: 'cam', topic: 'opcua/json/data/jin3d/video/CCTV_CC-01', payload: JSON.stringify({ MessageType: 'ua-data', Messages: [{ Payload: { Image: { Value: b64 } } }] }), tMs: hub.epochMs + s.time * 1000, video: true });
step(130);   // keep-alive (60초 넘게 조용한 클라이언트)
const P = hub.pcap, file = P.build();
if (process.env.PCAP_OUT) (await import('node:fs')).writeFileSync(process.env.PCAP_OUT, file);   // 확인용 파일 저장 (Wireshark·tcpdump)

// ── 파서 ──
const dv = new DataView(file.buffer);
console.log('== pcap 파일');
check('libpcap 헤더 (a1b2c3d4 · v2.4 · Ethernet)', dv.getUint32(0, true) === 0xa1b2c3d4 && dv.getUint16(4, true) === 2 && dv.getUint16(6, true) === 4 && dv.getUint32(20, true) === 1, `${(file.length / 1e6).toFixed(2)}MB`);
const pk = []; let o = 24, mono = true, prev = 0;
while (o < file.length) { const sec = dv.getUint32(o, true), us = dv.getUint32(o + 4, true), len = dv.getUint32(o + 8, true); const t = sec * 1e6 + us; if (t < prev) mono = false; prev = t; pk.push(file.subarray(o + 16, o + 16 + len)); o += 16 + len; }
check('패킷 수 · 시각 순 정렬', pk.length === P.stats.packets && mono, `${pk.length}개`);
const cs = (b, s0, e0, init = 0) => { let x = init; for (let i = s0; i < e0; i += 2) x += (b[i] << 8) + (i + 1 < e0 ? b[i + 1] : 0); while (x >> 16) x = (x & 0xffff) + (x >> 16); return x; };
let ipOk = 0, tcpOk = 0;
const flows = new Map(), mq = { pub: 0, ack: 0, conn: 0, connack: 0, sub: 0, suback: 0, ping: 0, pong: 0 }, pubIds = new Set(), ackIds = new Set(), topics = new Set();
let up = 0, down = 0, g5 = 0, cmdDown = 0, seqOk = true;
for (const f of pk) {
  const ip = 14, ihl = (f[ip] & 15) * 4, total = (f[ip + 2] << 8) | f[ip + 3];
  if ((cs(f, ip, ip + ihl) & 0xffff) === 0xffff) ipOk++;
  const src = f.subarray(ip + 12, ip + 16), dst = f.subarray(ip + 16, ip + 20), tcp = ip + ihl, toff = (f[tcp + 12] >> 4) * 4, plen = total - ihl - toff;
  const pseudo = cs(Uint8Array.from([...src, ...dst, 0, 6, (total - ihl) >> 8, (total - ihl) & 255]), 0, 12);
  if ((cs(f, tcp, ip + total, pseudo) & 0xffff) === 0xffff) tcpOk++;
  const sp = (f[tcp] << 8) | f[tcp + 1], dp = (f[tcp + 2] << 8) | f[tcp + 3], seq = new DataView(f.buffer, f.byteOffset + tcp + 4, 4).getUint32(0), flags = f[tcp + 13];
  const toBroker = dp === 1883; toBroker ? up++ : down++;
  if (toBroker && src[0] === 10 && src[1] === 45) g5++;
  const key = `${[...src].join('.')}:${sp}>${[...dst].join('.')}:${dp}`, fl = flows.get(key);
  if (fl && fl.next !== seq) seqOk = false;
  flows.set(key, { next: (seq + plen + (flags & 0x02 ? 1 : 0)) >>> 0, buf: [...(fl?.buf ?? []), ...(plen ? f.subarray(tcp + toff, tcp + toff + plen) : [])] });
}
// 흐름(방향)마다 TCP 페이로드를 이어 MQTT 패킷으로 나눈다
for (const [key, fl] of flows) {
  const b = fl.buf; let i = 0;
  while (i < b.length) {
    const type = b[i] >> 4; let mult = 1, len = 0, j = i + 1, c;
    do { c = b[j++]; len += (c & 127) * mult; mult *= 128; } while (c & 128);
    const body = b.slice(j, j + len);
    if (type === 3) { mq.pub++; const tl = (body[0] << 8) | body[1], topic = Buffer.from(body.slice(2, 2 + tl)).toString(); topics.add(topic); const qos = (b[i] >> 1) & 3, id = (body[2 + tl] << 8) | body[3 + tl]; if (qos === 1) pubIds.add(`${key}#${id}#${mq.pub}`.replace(/#\d+$/, '') + `#${[...pubIds].filter((x) => x.startsWith(`${key}#${id}#`)).length}`); if (key.includes(':1883>') && topic.endsWith('/Commands')) cmdDown++; }
    else if (type === 4) { mq.ack++; const id = (body[0] << 8) | body[1], [a, bb] = key.split('>'), k0 = `${bb}>${a}#${id}#`; ackIds.add(k0 + [...ackIds].filter((x) => x.startsWith(k0)).length); }
    else if (type === 1) mq.conn++; else if (type === 2) mq.connack++; else if (type === 8) mq.sub++; else if (type === 9) mq.suback++; else if (type === 12) mq.ping++; else if (type === 13) mq.pong++;
    i = j + len;
  }
}
console.log('== Ethernet · IPv4 · TCP');
check('IPv4 헤더 체크섬 모두 정상', ipOk === pk.length);
check('TCP 체크섬(의사 헤더 포함) 모두 정상', tcpOk === pk.length);
check('TCP 순서번호가 흐름마다 끊김 없이 이어짐 (SYN·분할 세그먼트 포함)', seqOk, `흐름 ${flows.size}개`);
console.log('== MQTT 3.1.1 (양방향)');
check('접속: CONNECT ↔ CONNACK, SUBSCRIBE ↔ SUBACK 짝', mq.conn === mq.connack && mq.conn === P.clients.size && mq.sub === mq.suback && mq.sub > 0, `클라이언트 ${P.clients.size} · 구독 ${mq.sub}`);
const unacked = [...pubIds].filter((x) => !ackIds.has(x)).length;
check('QoS 1 PUBLISH마다 같은 패킷 ID의 PUBACK이 반대 방향으로 (양방향, 미확인 0)', mq.pub > 0 && unacked === 0 && mq.ack === mq.pub, `PUBLISH ${mq.pub} · PUBACK ${mq.ack}`);
check('양방향: 클라이언트 → 브로커 · 브로커 → 구독자(FACOS) 전달', up > 0 && down > 0 && P.stats.publishDown > 0, `업 ${up} · 다운 ${down} · 전달 ${P.stats.publishDown}`);
check('AAS·OPC UA 토픽: 자산 데이터 · 이벤트 · 상위 명령', [...topics].some((t) => /opcua\/json\/data\/.+\/AM_|AMR/.test(t)) && [...topics].some((t) => t.endsWith('/Events')) && [...topics].some((t) => t.endsWith('/Commands')), `토픽 ${topics.size}종`);
check('상위 명령이 브로커 → 셀·로봇으로 다운링크', cmdDown > 0, `${cmdDown}건`);
check('이동 로봇은 5G 단말 주소(10.45.x.x)로 발행', g5 > 0, `${g5}패킷 · 5G 단말 ${P.hosts()['5g']}대`);
check('keep-alive: PINGREQ ↔ PINGRESP', mq.ping > 0 && mq.ping === mq.pong, `${mq.ping}회`);
check('영상(JPEG 12KB, base64) PUBLISH가 MSS 1460B로 분할 전송', P.stats.video === 1 && P.stats.segs > P.stats.publishUp + P.stats.publishDown, `세그먼트 ${P.stats.segs}`);
const conn = MQTT.connect('x'); check('CONNECT 인코딩 (MQTT · 레벨 4 · clean session)', conn[0] === 0x10 && Buffer.from(conn.slice(4, 8)).toString() === 'MQTT' && conn[8] === 4 && conn[9] === 2);
console.log('== 개별 캡처 (로봇·설비 정보 창)');
for (const a of [amrA, cellA]) {
  const AP = hub.assetPcaps.get(a.id), f2 = AP.build(), d2 = new DataView(f2.buffer), ip = AP.clients.get(a.id).ip.join('.');
  let o2 = 24, only = true, n2 = 0, pubUp = 0, cmd = 0;
  while (o2 < f2.length) { const len = d2.getUint32(o2 + 8, true), fr = f2.subarray(o2 + 16, o2 + 16 + len); const sIp = [...fr.subarray(26, 30)].join('.'), dIp = [...fr.subarray(30, 34)].join('.'); if (sIp !== ip && dIp !== ip) only = false; n2++; o2 += 16 + len; }
  pubUp = AP.stats.publishUp; cmd = AP.stats.publishDown;
  check(`${a.kind === 'AMR' ? '운반 AMR(5G)' : '설비·셀(LAN)'} ${a.id}: 이 자산의 연결 패킷만 (${ip} ↔ 브로커)`, n2 > 0 && only && AP.clients.size === 1, `${n2}패킷`);
  check(`${a.id}: 자기 데이터 발행 + 상위 명령 수신(다운링크) 양방향`, pubUp > 0 && cmd > 0 && AP.stats.puback === pubUp + cmd, `발행 ${pubUp} · 명령 ${cmd} · PUBACK ${AP.stats.puback}`);
}
check('같은 자산은 전체 캡처와 개별 캡처에서 같은 IP', [amrA, cellA].every((a) => hub.pcap.clients.get(a.id)?.ip.join('.') === hub.assetPcaps.get(a.id).clients.get(a.id).ip.join('.')));
check('개별 캡처 주소: AMR은 5G 단말(10.45.x.x), 설비는 LAN(10.20.1.x)', hub.assetPcaps.get(amrA.id).clients.get(amrA.id).ip[1] === 45 && hub.assetPcaps.get(cellA.id).clients.get(cellA.id).ip[1] === 20);
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
