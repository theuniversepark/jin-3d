// 내장 MQTT 5 브로커(Mosquitto) 검증 — server/mosquitto.mjs · server/mqtt-gateway.mjs (엔진 mosquitto)
// ① 앱 내장 실행 파일로 시작 · 버전 · MQTT 5 · 계정 파일($7$ PBKDF2)이 Mosquitto에서 실제로 통함
// ② UNS 발행 = MQTT 5 속성(Correlation Data · Response Topic · Message Expiry · Content Type · User Property)이 내장 브로커에서 그대로 · retain
// ③ ACL: 익명 발행은 브로커가 거부(QoS 1 PUBACK 사유 0x87, 연결 유지) · 비밀번호 오류 · zone-main은 자기 존만 · operator는 모든 존
// ④ 외부 명령 요청: MQTT 5 속성(상관 ID · 응답 토픽 · 만료 · User Property from) → 대기열 · 권한 밖 요청은 대기열에 안 들어옴
// ⑤ Sparkplug 엣지·주 호스트가 Mosquitto 계정으로 접속 · ⑥ 앱 서버 연결이 끊기면 LWT로 _facos/state online:false
// ⑦ 실행 파일이 없으면 aedes(MQTT 3.1.1)로 대비. 실행 파일이 없는 환경이면 ①~⑥ 건너뜀. 실행: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { unsTelemetry } from '../js/datahub.js';
import { UnsNamespace, UNS_ROOT } from '../js/uns.js';
import { findMosquitto, passwdLine, aclText } from '../server/mosquitto.mjs';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const v = net.createServer().listen(0, '127.0.0.1', () => { const p = v.address().port; v.close(() => r(p)); }); });
const R = (p) => `${UNS_ROOT}/${p}`;

console.log('== 파일 형식');
check('비밀번호 줄 = $7$1000$<salt 64B>$<PBKDF2-SHA512 64B>', /^op:\$7\$1000\$[A-Za-z0-9+/=]{88}\$[A-Za-z0-9+/=]{88}$/.test(passwdLine('op', 'x')));
const A = aclText({ anonymous: 'observer', users: [{ name: 'zone-main', write: ['camtic/metafactory/main/+/cmd/request'] }, { name: '_admin-app', write: ['#'] }] });
check('ACL: 익명 읽기 · 사용자별 읽기 + 쓰기 패턴 · 관리 계정 readwrite', /^topic read #$/m.test(A.split('user ')[0]) && /user zone-main\ntopic read #\ntopic read \$SYS\/#\ntopic write camtic\/metafactory\/main\/\+\/cmd\/request/.test(A) && /user _admin-app[\s\S]*topic readwrite #/.test(A));

const found = findMosquitto();
console.log(`== Mosquitto 엔진 (${found ? found.bin : '실행 파일 없음'})`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-mosq-'));
process.env.UNS_DEAD_S = '30';
const G = await import('../server/mqtt-gateway.mjs');
const { connect } = await import('mqtt');
if (!found) console.log('  SKIP  실행 파일 없음');
else {
  const port = await freePort();
  await G.startMqtt({ host: '127.0.0.1', port, aclFile: path.join(tmp, 'acl.json'), engine: 'mosquitto' });
  const st = G.mqttStatus();
  check('Mosquitto로 시작 · MQTT 5 · 버전 · 앱 내장 실행 파일', st.engine === 'mosquitto' && st.mqtt5 && /^2\./.test(st.brokerVersion ?? '') && st.port === port && !st.engineError, `${st.brokerVersion} · ${st.brokerBin}`);
  check('설정 파일 0600 (passwd · acl · conf)', ['passwd', 'acl', 'mosquitto.conf'].every((f) => (fs.statSync(path.join(tmp, 'mosquitto', f)).mode & 0o777) === 0o600));
  const v5 = (opts = {}) => new Promise((res, rej) => { const c = connect(`mqtt://127.0.0.1:${port}`, { protocolVersion: 5, reconnectPeriod: 0, ...opts }); c.once('connect', () => res(c)); c.once('error', rej); });

  const sim = new Simulation('smart', 3, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(sim);
  for (let t = 0; t < 600; t += 0.1) { sim.step(0.1); ag.update(0.1); }
  const U = new UnsNamespace(sim, { run: () => 'run-MQ' });
  const seen = [], obs = await v5();
  obs.on('message', (t, p, pk) => seen.push({ t, p: p.toString(), props: pk.properties ?? {}, retain: pk.retain }));
  await new Promise((r) => obs.subscribe([`${UNS_ROOT}/#`, 'spBv1.0/#'], r));
  const c1 = sim.cmd.issue('SPEED', 'all', 75, { by: '시험' }); for (let t = 0; t < 20; t += 0.1) { sim.step(0.1); ag.update(0.1); }
  G.mqttPublish([...unsTelemetry(sim), ...U.collect({ telemetry: unsTelemetry(sim) })]); await wait(800);
  const cm = seen.find((x) => x.t === R('main/_zone/cmd') && JSON.parse(x.p).id === c1.id);
  check('내장 브로커에서 MQTT 5 속성 그대로: Correlation Data · Response Topic · Message Expiry · Content Type · User Property', cm && cm.props.correlationData?.toString() === `CMD-${c1.id}` && cm.props.responseTopic === R('main/_zone/cmd/ack') && cm.props.messageExpiryInterval === 60 && cm.props.contentType === 'application/json' && cm.props.userProperties?.isa95 === 'Area');
  const late = [], lc = await v5(); lc.on('message', (t, p, pk) => late.push({ t, retain: pk.retain })); await new Promise((r) => lc.subscribe(R('#'), r)); await wait(400);
  check('retain: 나중에 붙은 구독자가 _meta · facOS · 셀 상태를 받음 (retain 표시)', late.some((x) => x.t === R('_meta/namespace') && x.retain) && late.some((x) => x.t === R('_facos/state') && x.retain), `${late.length}개`);
  lc.end(true);

  console.log('== ACL (Mosquitto)');
  const before = seen.filter((x) => x.t === R('_facos/state')).length;
  const anon = await v5(); const pk = await new Promise((r) => anon.publish(R('_facos/state'), '{"spoof":1}', { qos: 1, retain: true }, (e, p) => r({ e, p }))); await wait(300);
  check('익명 발행 거부: PUBACK 사유 0x87(권한 없음) · 연결 유지 · 위조 메시지 전달 안 됨', (pk.p?.reasonCode === 135 || /135|Not authorized/i.test(String(pk.e?.message ?? pk.e?.code ?? ''))) && anon.connected && seen.filter((x) => x.t === R('_facos/state')).length === before, `reason ${pk.p?.reasonCode ?? pk.e?.code}`);
  anon.end(true);
  let bad = null; await v5({ username: 'operator', password: 'wrong' }).catch((e) => { bad = e; });
  check('비밀번호 오류는 접속 거부', !!bad, bad?.message);
  const zm = await v5({ username: 'zone-main', password: G.unsAclPassword('zone-main') });
  const okp = await new Promise((r) => zm.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'CYCLE_STOP' }), { qos: 1, properties: { correlationData: Buffer.from('ZM-1'), userProperties: { from: 'zone-main' } } }, (e, p) => r(p ?? e)));
  const nop = await new Promise((r) => zm.publish(R('flex/_zone/cmd/request'), JSON.stringify({ code: 'CYCLE_STOP' }), { qos: 1, properties: { correlationData: Buffer.from('ZM-2') } }, (e, p) => r(p ?? e)));
  await wait(400); const Q = G.unsTakeCommands();
  check('zone-main: 자기 존 요청은 받음 · 다른 존(flex)은 브로커가 거부(0x87) · 대기열에 안 들어옴', (okp?.reasonCode ?? 0) === 0 && (nop?.reasonCode === 135 || /135/.test(String(nop?.code))) && Q.some((q) => q.correlationId === 'ZM-1' && q.from === 'zone-main') && !Q.some((q) => q.correlationId === 'ZM-2'), Q.map((q) => q.correlationId).join(' '));
  zm.end(true);

  console.log('== 외부 명령 요청 (MQTT 5 속성)');
  const op = await v5({ username: 'operator', password: G.unsAclPassword('operator') });
  op.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'SPEED', arg: 110 }), { qos: 1, properties: { correlationData: Buffer.from('OP-M5'), responseTopic: 'mes/replies/9', messageExpiryInterval: 40, userProperties: { from: 'MES-01' } } });
  await wait(400); const q5 = G.unsTakeCommands().find((q) => q.correlationId === 'OP-M5');
  check('operator 요청: Correlation Data · Response Topic · Expiry · User Property from 을 속성에서', q5?.responseTopic === 'mes/replies/9' && q5.expirySec === 40 && q5.from === 'MES-01' && q5.via === 'embedded', JSON.stringify(q5));
  op.end(true);

  console.log('== Sparkplug · LWT');
  check('Sparkplug 엣지 NBIRTH · DBIRTH · 주 호스트 STATE (Mosquitto 계정)', seen.some((x) => /spBv1\.0\/metafactory\/NBIRTH\/edge-main$/.test(x.t)) && seen.some((x) => /DBIRTH\/edge-main\//.test(x.t)) && seen.some((x) => x.t === 'spBv1.0/STATE/metafactory-uns-bridge'), `${seen.filter((x) => x.t.startsWith('spBv1.0/')).length}건`);
  const n0 = seen.length; G._pubClient().stream.destroy(); await wait(1200);
  const lwt = seen.slice(n0).find((x) => x.t === R('_facos/state'));
  check('앱 서버 MQTT 연결이 끊기면 LWT → _facos/state online:false (retain)', lwt && JSON.parse(lwt.p).online === false && /LWT/.test(JSON.parse(lwt.p).reason), lwt?.p);
  await wait(1500); U.rebirth(); G.mqttPublish(U.collect()); await wait(400);
  check('다시 접속(자동) → rebirth 발행으로 online:true', JSON.parse(seen.filter((x) => x.t === R('_facos/state')).at(-1).p).online === true);
  obs.end(true);
  const pid = G.mqttStatus().port; await G.stopMqtt(); await wait(300);
  const closed = await new Promise((r) => { const s = net.connect(pid, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(false); }); s.once('error', () => r(true)); });
  check('정지하면 Mosquitto 프로세스도 끝남 (포트 닫힘)', closed);
}

console.log('== 대비 (aedes)');
{ const fake = path.join(tmp, process.platform === 'win32' ? 'fake.cmd' : 'fake-mosquitto');
  fs.writeFileSync(fake, process.platform === 'win32' ? '@exit /b 3\r\n' : '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  process.env.MOSQUITTO_BIN = fake;
  const port = await freePort();
  await G.startMqtt({ host: '127.0.0.1', port, aclFile: path.join(tmp, 'acl2.json'), engine: 'auto' });
  const st = G.mqttStatus();
  check('Mosquitto가 시작에 실패하면 aedes(MQTT 3.1.1)로 대비 · 사유 표시', st.engine === 'aedes' && st.mqtt5 === false && st.listening && /Mosquitto 시작 실패/.test(st.engineError ?? ''), st.engineError);
  const c = await new Promise((res, rej) => { const k = connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0 }); k.once('connect', () => res(k)); k.once('error', rej); });
  check('대비 브로커에도 접속 가능', c.connected); c.end(true);
  await G.stopMqtt(); delete process.env.MOSQUITTO_BIN;
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
