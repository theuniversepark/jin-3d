// UNS (ISA-95 통합 네임스페이스) 검증 — js/uns.js · server/mqtt-gateway.mjs (정밀조립Zone 하나 — 상위 meta-factory tests/uns.mjs에서 확장 Zone 셀 토픽 검사는 뺐다. 「다른 존」 권한 검사는 없는 존 토픽(flex)으로 그대로 본다)
// ① 트리: 토픽 규칙(_meta) · FacOS 상태 · 오더(OperationsRequest) · 결정 · A2A · 존 · 셀 OCS · 설비 요약이 ISA-95 경로에 있는지
// ② Report by Exception: 상태가 같으면 다시 보내지 않음 · rebirth면 모든 retain 상태를 다시 보냄
// ③ 명령 3단: 같은 correlationId로 cmd → cmd/ack → cmd/exec → cmd/done
// ④ 게이트웨이: retain 상태를 새 구독자가 받음 · 발행이 끊기면 _facos/state online:false(죽음 처리) · rebirth 요청
// ⑤ Sparkplug B: 인코딩(손으로 계산한 바이트) · 엣지 NBIRTH → DBIRTH → DDATA(바뀐 것만) · 주 호스트가 ISA-95 트리로 · seq 누락 → 재탄생 · LWT NDEATH
// ⑥ ACL: 익명 읽기 전용 · 존 계정은 자기 존만 · 비밀번호 오류 거부 · UNS 상태 위조 불가
// ⑦ 외부 명령 요청: cmd/request → FacOS 명령 4단(같은 correlationId · 응답 토픽) · 잘못된 요청 거부 · 만료
// ⑧ MQTT 5 브리지: Mosquitto(있으면)로 Correlation Data · Response Topic · Message Expiry 속성 확인 · MQTT 5 요청 수신. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { unsTelemetry } from '../js/datahub.js';
import { UnsNamespace, UNS_ROOT } from '../js/uns.js';
import { unsZoneKpi } from '../js/datahub.js';
import { encodePayload, decodePayload, DT } from '../server/sparkplug-b.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); } };
const R = (p) => `${UNS_ROOT}/${p}`;

console.log('== UNS 트리 (자동화 1시간)');
const s = new Simulation('smart', 3, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
const U = new UnsNamespace(s);
run(s, ag, 3600);
const first = U.collect({ telemetry: unsTelemetry(s) }), T = U.tree, has = (p) => T.has(R(p)), json = (p) => JSON.parse(T.get(R(p)).payload);
check('탄생 메시지 _meta/namespace (retain · ISA-95 계층 4단)', has('_meta/namespace') && T.get(R('_meta/namespace')).retain && json('_meta/namespace').levels.length === 4);
check('FacOS 상태 _facos/state (retain · online · 계획 버전)', has('_facos/state') && json('_facos/state').online === true && /^P-\d+$/.test(json('_facos/state').planVersion));
const ords = [...T.keys()].filter((k) => k.startsWith(R('_facos/order/')));
check('오더 _facos/order/{id} = ISA-95 OperationsRequest · 정밀조립 Area 배정', ords.length >= 1 && ords.every((k) => { const p = JSON.parse(T.get(k).payload); return p.isa95 === 'OperationsRequest' && p.assignedTo === R('main') && T.get(k).retain; }), ords.map((k) => k.split('/').at(-1)).join(' · '));
const a2a = [...T.keys()].filter((k) => k.startsWith(R('_facos/a2a/')));
check('A2A 기록 _facos/a2a/{보낸 쪽}/{받는 쪽} — 오더 배정(factory → main) 포함 · 이벤트(retain 아님)', a2a.includes(R('_facos/a2a/factory/main')) && a2a.every((k) => !T.get(k).retain), `${a2a.length}개 경로`);
const nA2A = first.filter((m) => m.topic.includes('/_facos/a2a/')).length;
check('A2A 메시지 수 = Agent Gateway 기록 수 (보관 400건 안)', nA2A === Math.min(s.fos.bus.seq, s.fos.bus.log.length), `${nA2A}건`);
const cells = s.processing.filter((st) => !st.standby);
check('셀 OCS {존}/{셀}/state — 정밀조립 셀마다 · retain · 상태 7종 이름', cells.every((st) => has(`main/${st.uid ?? st.id}/state`)) && cells.every((st) => ['IDLE', 'READY', 'RUN', 'DONE', 'HOLD', 'RECOVER', 'SAFE-STOP'].includes(json(`main/${st.uid ?? st.id}/state`).ocs)), `${cells.length}셀`);
check('존 {존}/_zone/state — 오케스트레이터 · 셀 수 · 수량 정산', has('main/_zone/state') && json('main/_zone/state').cells === cells.length && json('main/_zone/state').recon?.err === 0);
check('설비 요약 = 기존 평면 토픽을 {존}/{셀}/telemetry로 (본문 동일)', cells.every((st) => has(`main/${String(st.uid ?? st.id).replace(/[^\w.-]/g, '_')}/telemetry`)));
check('토픽에 MQTT 금지 문자(+ # 공백) 없음', [...T.keys()].every((k) => !/[+#\s]/.test(k)));

console.log('== Report by Exception · rebirth');
const again = U.collect({ telemetry: [] });
check('바로 다시 모으면 retain 상태는 보내지 않음 (변화 없음)', again.filter((m) => m.retain).length === 0 && U.stats.suppressed > 0, `건너뜀 ${U.stats.suppressed}`);
U.rebirth();
const re = U.collect({ telemetry: [] });
check('rebirth → _meta · FacOS · 오더 · 존 · 셀 상태 전부 다시 (retain)', re[0].topic === R('_meta/namespace') && re.filter((m) => m.retain).length === [...T.values()].filter((e) => e.retain).length, `${re.length}건`);

console.log('== 명령 3단 (correlationId)');
const st = cells.find((x) => x.state !== 'DOWN'), c = s.cmd.issue('SPEED', st.id, 75, { by: '시험', why: 'UNS 명령 흐름' });
run(s, ag, 30);
const out = U.collect({ telemetry: [] }), base = R(`main/${st.uid ?? st.id}`), cm = out.filter((m) => m.topic.startsWith(`${base}/cmd`));
const subs = cm.map((m) => m.topic.slice(base.length + 1)), corr = new Set(cm.map((m) => JSON.parse(m.payload).correlationId));
check('셀 명령: cmd → cmd/ack → cmd/exec → cmd/done 순서 · 같은 correlationId', c && subs[0] === 'cmd' && subs.includes('cmd/ack') && subs.at(-1) === 'cmd/done' && corr.size === 1 && corr.has(`CMD-${c.id}`), `${subs.join(' → ')} · ${[...corr]}`);
check('명령 응답 토픽(responseTopic) = 같은 셀의 cmd/ack', cm.every((m) => JSON.parse(m.payload).responseTopic === `${base}/cmd/ack`));
const c2 = s.cmd.issue('CYCLE_STOP', 'all', null, { by: '시험' }); run(s, ag, 20); s.cmd.issue('RESUME', 'all', null, { by: '시험' }); run(s, ag, 20);
const o2 = U.collect({ telemetry: [] });
check('존 전체 명령은 main/_zone/cmd…', c2 && o2.some((m) => m.topic === R('main/_zone/cmd') && JSON.parse(m.payload).correlationId === `CMD-${c2.id}`));

console.log('== 품질 표본 → {존}/_zone/quality');
{ unsZoneKpi(s);   /* 표본 수집 켜기 (micro는 Zone 대시보드 추세가 30초마다 먼저 읽어 가므로, 켠 뒤에 판정된 제품부터 나온다) */ run(s, ag, 300); const q = U.collect({ telemetry: [], kpi: unsZoneKpi(s) }).filter((m) => m.topic === R('main/_zone/quality'));
  check('제품 판정마다 main/_zone/quality (이벤트 · 공정 변수 x_ · 품질 특성 y_)', q.length > 0 && q.every((m) => !m.retain) && Object.keys(JSON.parse(q[0].payload)).some((k) => k.startsWith('y_')), `${q.length}건`); }

console.log('== Sparkplug B 인코딩 (protobuf 규칙으로 손 계산한 바이트)');
{ const hex = (b) => Buffer.from(b).toString('hex');
  // Payload{timestamp=1, metrics=[{name:'a', datatype=10(Double), double_value=1.0}], seq=0}
  //  08 01 | 12 0e [0a 01 61 | 20 0a | 69 00000000 0000f03f] | 18 00
  check('Double 메트릭 바이트 일치', hex(encodePayload({ timestamp: 1, seq: 0, metrics: [{ name: 'a', type: DT.Double, value: 1 }] })) === '0801120e0a0161200a69000000000000f03f1800');
  // {timestamp=300, metrics=[{alias=2, datatype=11(Boolean), boolean_value=true}, {name:'s', datatype=12, string_value='가'}]} — 300 = ac 02 · '가' = ea b0 80
  check('varint 300 · alias · Boolean · UTF-8 String 바이트 일치', hex(encodePayload({ timestamp: 300, metrics: [{ alias: 2, type: DT.Boolean, value: true }, { name: 's', type: DT.String, value: '가' }] })) === '08ac0212061002200b7001120a0a0173200c7a03eab080');
  const big = Date.UTC(2026, 10, 3, 9, 0, 0, 123), back = decodePayload(encodePayload({ timestamp: big, seq: 255, metrics: [{ name: 'bdSeq', type: DT.Int64, value: 7 }, { name: 'n', type: DT.Int32, value: -5 }, { name: 'z', type: DT.Double, value: null }] }));
  check('왕복: 2^32 넘는 타임스탬프 · seq 255 · Int32 음수 · null', back.timestamp === big && back.seq === 255 && back.metrics[0].value === 7 && back.metrics[1].value === -5 && back.metrics[2].value === null, JSON.stringify(back.metrics.map((m) => m.value))); }

console.log('== 게이트웨이 (retain · 죽음 처리 · rebirth · Sparkplug · ACL · 외부 명령)');
process.env.UNS_DEAD_S = '3';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-uns-'));
const { connect } = await import('mqtt');
const net = await import('node:net');
const freePort = () => new Promise((r) => { const v = net.createServer().listen(0, '127.0.0.1', () => { const p = v.address().port; v.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// MQTT 5 외부 브로커 (Mosquitto가 설치돼 있으면)
const MOSQ = ['/opt/homebrew/sbin/mosquitto', '/usr/local/sbin/mosquitto', '/usr/sbin/mosquitto'].find((x) => fs.existsSync(x));
let mosq = null, mport = null;
if (MOSQ) {
  mport = await freePort(); const conf = path.join(tmp, 'mosquitto.conf'); fs.writeFileSync(conf, `listener ${mport} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
  mosq = spawn(MOSQ, ['-c', conf], { stdio: 'ignore' }); await wait(500);
}
const { startMqtt, mqttPublish, mqttStatus, unsTakeCommands, unsAclPassword, unsBridgeConfig, unsBridgeSave, _sparkplug } = await import('../server/mqtt-gateway.mjs');
const port = await freePort();
await startMqtt({ host: '127.0.0.1', port, aclFile: path.join(tmp, 'acl.json'), bridgeFile: path.join(tmp, 'bridge.json'), engine: 'aedes' });   // aedes 동작(거부 시 연결 끊김 · 거부 건수) 시험 — Mosquitto는 tests/mosquitto.mjs
const sub = (opts = {}) => new Promise((res, rej) => { const c = connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0, ...opts }); c.once('connect', () => res(c)); c.once('error', rej); });
check('시작 직후 rebirth 요청 (retain 저장소 비어 있음)', mqttStatus().uns.rebirth === true);
// 처음부터 지켜보는 구독자(라이브) — Sparkplug 탄생 메시지는 retain이 아니다
const got = new Map(), raw = [], cl = await sub();
cl.on('message', (t, p) => { raw.push([t, p]); if (!t.startsWith('spBv1.0/') || t.includes('/STATE/')) { try { got.set(t, JSON.parse(p.toString())); } catch { /* */ } } });
await new Promise((r) => cl.subscribe(['camtic/metafactory/#', 'spBv1.0/#'], r));
U.rebirth(); const birth = U.collect({ telemetry: unsTelemetry(s) });
mqttPublish([...unsTelemetry(s), ...birth]);
check('탄생 메시지를 받으면 rebirth 끝 · 살아 있음', mqttStatus().uns.rebirth === false && mqttStatus().uns.alive === true);
await wait(600);
const ret = new Map(), clr = await sub();
clr.on('message', (t, p) => { if (!t.startsWith('spBv1.0/') || t.includes('/STATE/')) { try { ret.set(t, JSON.parse(p.toString())); } catch { /* */ } } });
await new Promise((r) => clr.subscribe(['camtic/metafactory/#', 'spBv1.0/STATE/#'], r));
await wait(400);
check('나중에 붙은 구독자(익명 = 관찰)가 retain 상태를 바로 받음 (_meta · FacOS · 셀 OCS)', ret.has(R('_meta/namespace')) && ret.get(R('_facos/state'))?.online === true && cells.every((x) => ret.has(R(`main/${x.uid ?? x.id}/state`))), `${ret.size}개 토픽`);

console.log('== Sparkplug B 엣지 → 주 호스트 → ISA-95');
const beat = () => mqttPublish([...unsTelemetry(s), ...U.collect({ telemetry: [] })]);
await wait(800); beat(); await wait(600);
const SP = _sparkplug(), sps = () => raw.filter(([t]) => t.startsWith('spBv1.0/metafactory/'));
const types = new Set(sps().map(([t]) => t.split('/')[2]));
check('존마다 엣지 노드 NBIRTH · 셀마다 DBIRTH', types.has('NBIRTH') && types.has('DBIRTH') && sps().filter(([t]) => t.includes('/NBIRTH/')).length >= 1, [...types].join(' · '));
const db = sps().find(([t]) => t.includes('/DBIRTH/edge-main/')), dbp = db && decodePayload(db[1]);
check('DBIRTH: 메트릭 8종 이름 + alias · seq', dbp && dbp.metrics.length === 8 && dbp.metrics.every((m) => m.name && m.alias > 0) && Number.isInteger(dbp.seq), dbp?.metrics.map((m) => `${m.name}#${m.alias}`).join(' '));
check('주 호스트 STATE online (retain) · ISA-95 {존}/{셀}/telemetry에 _sparkplug 출처', ret.get('spBv1.0/STATE/metafactory-uns-bridge')?.online === true && cells.every((x) => got.get(R(`main/${String(x.uid ?? x.id).replace(/[^\w.-]/g, '_')}/telemetry`))?._sparkplug?.edge === 'edge-main'));
check('{존}/{셀}/edge online (retain)', cells.every((x) => got.get(R(`main/${String(x.uid ?? x.id).replace(/[^\w.-]/g, '_')}/edge`))?.online === true));
const n0 = sps().length; run(s, ag, 120); beat(); await wait(500);
const dd = sps().slice(n0).filter(([t]) => t.includes('/DDATA/')).map(([, p]) => decodePayload(p));
check('DDATA: 바뀐 메트릭만 · 이름 없이 alias', dd.length > 0 && dd.every((p) => p.metrics.length >= 1 && p.metrics.length <= 8 && p.metrics.every((m) => m.name == null && m.alias > 0)), `${dd.length}건 · 평균 ${(dd.reduce((a, p) => a + p.metrics.length, 0) / Math.max(1, dd.length)).toFixed(1)}개`);
const E = SP.edges.get('main'), H = SP.host, rb0 = E.stats.rebirths;
H.onMessage(`spBv1.0/metafactory/DDATA/edge-main/${[...E.devices.keys()][0]}`, encodePayload({ seq: (H.nodes.get('edge-main').seq + 5) % 256, metrics: [{ alias: 1, type: DT.Double, value: 1 }] }));
await wait(500);
check('seq 누락 → 주 호스트가 NCMD Rebirth → 엣지가 NBIRTH · DBIRTH 다시', H.stats.gaps >= 1 && E.stats.rebirths === rb0 + 1 && raw.some(([t]) => t === 'spBv1.0/metafactory/NCMD/edge-main'), `누락 ${H.stats.gaps} · 재탄생 ${E.stats.rebirths}`);
const dev0 = [...E.devices.keys()][0]; E.crash(); await wait(600);
check('엣지가 갑자기 끊기면 LWT NDEATH → {존}/{셀}/edge online:false (retain)', H.stats.ndeaths >= 1 && got.get(R(`main/${dev0}/edge`))?.online === false && raw.some(([t]) => t === 'spBv1.0/metafactory/NDEATH/edge-main'));
beat(); await wait(800);
check('데이터가 다시 오면 새 bdSeq로 다시 탄생 · edge online', E.client?.connected && E.bdSeq >= 1 && got.get(R(`main/${dev0}/edge`))?.online === true, `bdSeq ${E.bdSeq}`);

console.log('== 접근 권한 (ACL)');
{ const st0 = JSON.stringify(got.get(R('_facos/state')));
  const anon = await sub(); const closed = new Promise((r) => anon.once('close', r));
  anon.publish(R('_facos/state'), JSON.stringify({ online: true, spoof: 1 }), { retain: true }); await Promise.race([closed, wait(1000)]);
  check('익명(관찰)은 발행 거부 · 연결 끊김 · FacOS 상태 위조 안 됨', mqttStatus().acl.denied >= 1 && !anon.connected && JSON.stringify(got.get(R('_facos/state'))) === st0, mqttStatus().acl.lastDenied?.why);
  let badErr = null; await sub({ username: 'operator', password: 'wrong' }).catch((e) => { badErr = e; });
  check('비밀번호가 틀리면 접속 거부', !!badErr && mqttStatus().acl.authFail >= 1, badErr?.message);
  const zm = await sub({ username: 'zone-main', password: unsAclPassword('zone-main') }); const zc = new Promise((r) => zm.once('close', r));
  zm.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'CYCLE_STOP', correlationId: 'ZM-1' })); await wait(300);
  const okMain = zm.connected && unsTakeCommands().some((q) => q.correlationId === 'ZM-1' && q.from === 'zone-main');
  zm.publish(R('flex/_zone/cmd/request'), JSON.stringify({ code: 'CYCLE_STOP' })); await Promise.race([zc, wait(1000)]);
  check('존 계정: 자기 존 명령 요청은 받음 · 다른 존은 거부 (같은 계층 명령 금지)', okMain && !zm.connected && /flex/.test(mqttStatus().acl.lastDenied?.topic));
  const users = mqttStatus().acl.users.map((u) => u.name);
  check('계정 파일: operator · zone-main (존 하나) · 0600 · 비밀번호 평문 노출 없음(상태 API)', users.join() === 'operator,zone-main' && (fs.statSync(path.join(tmp, 'acl.json')).mode & 0o777) === 0o600 && !JSON.stringify(mqttStatus()).includes(unsAclPassword('operator'))); }

console.log('== 외부 명령 요청 → FacOS 명령 4단');
{ const op = await sub({ username: 'operator', password: unsAclPassword('operator') }), cst = cells.find((x) => x.state !== 'DOWN'), cid = String(cst.uid ?? cst.id).replace(/[^\w.-]/g, '_');
  op.publish(R(`main/${cid}/cmd/request`), JSON.stringify({ code: 'SPEED', arg: 75, reason: '운전자 시험', correlationId: 'OP-1', responseTopic: 'operator/replies' }));
  op.publish(R('flex/_zone/cmd/request'), JSON.stringify({ code: 'CYCLE_STOP', correlationId: 'OP-2' }));
  op.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'NOPE', correlationId: 'OP-3' }));
  op.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'SPEED', arg: 33, correlationId: 'OP-4' }));
  op.publish(R('main/_zone/cmd/request'), 'not json');
  op.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'RESUME', correlationId: 'OP-5', responseTopic: R('_facos/state') }));
  await wait(400);
  const Q = unsTakeCommands();
  check('요청 대기열: 정상 4건 · 본문 오류·예약 응답 토픽은 게이트웨이가 바로 거부', Q.length === 4 && got.get(R('main/_zone/cmd/done'))?.state === 'rejected' && mqttStatus().commands.rejected >= 2, Q.map((q) => q.correlationId).join(' '));
  for (const q of Q) U.applyCommand(q);
  run(s, ag, 30);
  const out = U.collect({ telemetry: [] }), base = R(`main/${cid}`);
  const st1 = out.filter((m) => m.topic.startsWith(`${base}/cmd`) && JSON.parse(m.payload).correlationId === 'OP-1').map((m) => m.topic.slice(base.length + 1));
  check('외부 요청 OP-1 → cmd → cmd/ack → cmd/exec → cmd/done (같은 correlationId · 출처 기록)', st1[0] === 'cmd' && st1.includes('cmd/ack') && st1.at(-1) === 'cmd/done' && JSON.parse(out.find((m) => m.topic === `${base}/cmd`).payload).origin?.from === 'operator', st1.join(' → '));
  const rep = out.filter((m) => m.topic === 'operator/replies').map((m) => JSON.parse(m.payload).state);
  check('요청자 응답 토픽(operator/replies)에도 접수 · 완료', rep.includes('ack') && rep.includes('done'), rep.join(' · '));
  const rj = out.filter((m) => m.topic.endsWith('/cmd/done') && ['OP-2', 'OP-3', 'OP-4'].includes(JSON.parse(m.payload).correlationId)).map((m) => JSON.parse(m.payload));
  check('잘못된 요청 거부: 다른 존 · 모르는 코드 · 허용 밖 인자 (사유 포함)', rj.length === 3 && rj.every((x) => x.result === 'rejected' && x.reason), rj.map((x) => `${x.correlationId}: ${x.reason}`).join(' / '));
  check('MQTT 5 속성 준비: 명령 메시지에 correlationData · responseTopic · 요청 단계 messageExpiryInterval', out.filter((m) => m.topic.startsWith(`${base}/cmd`)).every((m) => m.props?.correlationData === 'OP-1' && m.props.responseTopic === `${base}/cmd/ack`) && out.find((m) => m.topic === `${base}/cmd`)?.props.messageExpiryInterval === 60);
  op.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'RESUME', correlationId: 'OP-6', expirySec: 1 })); await wait(2600); beat();
  await wait(300);
  check('만료: 1초 안에 가져가지 않은 요청은 게이트웨이가 거부', mqttStatus().commands.expired >= 1 && got.get(R('main/_zone/cmd/done'))?.correlationId === 'OP-6');
  op.end(true); }

console.log('== MQTT 5 브리지 설정 (UNS 탭)');
{ const c0 = unsBridgeConfig();
  check('처음: 화면에서 설정 가능 · 꺼짐 · 기본 MQTT 5', c0.editable && c0.source === 'app' && !c0.enabled && c0.version === 5);
  const bad = await unsBridgeSave({ url: 'http://x', enabled: true }), self = await unsBridgeSave({ url: `mqtt://127.0.0.1:${port}`, enabled: true }), none = await unsBridgeSave({ url: '', enabled: true });
  check('잘못된 주소 · 내장 브로커 자신 · 빈 주소로 켜기는 거부', bad.code === 400 && self.code === 400 && /자신/.test(self.body.error) && none.code === 400, `${bad.body.error} / ${self.body.error}`);
  const sv = await unsBridgeSave({ url: 'mqtt://127.0.0.1:1', username: 'u1', password: 'secret-pw', version: 5, enabled: false });
  const fileTxt = fs.readFileSync(path.join(tmp, 'bridge.json'), 'utf8');
  check('저장: 응답에는 비밀번호 여부만 · 파일 0600', sv.code === 200 && sv.body.password === true && !JSON.stringify(sv.body).includes('secret-pw') && (fs.statSync(path.join(tmp, 'bridge.json')).mode & 0o777) === 0o600 && /"username": "u1"/.test(fileTxt));
  await unsBridgeSave({ url: 'mqtt://127.0.0.1:2' });
  check('주소를 바꾸면 저장한 비밀번호는 버림', unsBridgeConfig().password === false);
  const on = await unsBridgeSave({ url: 'mqtt://127.0.0.1:1', enabled: true }); await wait(800);
  check('없는 브로커에 켜면 오류 사유 표시 (연결 거부)', on.code === 200 && !mqttStatus().bridgeConnected && /연결 거부/.test(mqttStatus().bridgeError ?? ''), mqttStatus().bridgeError);
  await unsBridgeSave({ enabled: false });
  check('끄면 연결 해제 · 상태 비움', !mqttStatus().bridgeConnected && mqttStatus().bridgeUrl == null && !unsBridgeConfig().enabled); }

console.log('== MQTT 5 브리지 (Mosquitto)');
if (!mosq) console.log('  SKIP  Mosquitto 없음 — 브리지 시험 생략');
else {
  await unsBridgeSave({ url: `mqtt://127.0.0.1:${mport}`, version: 5, enabled: true });
  for (let i = 0; i < 20 && !mqttStatus().bridgeConnected; i++) await wait(200);
  const m5 = await new Promise((res, rej) => { const c = connect(`mqtt://127.0.0.1:${mport}`, { protocolVersion: 5, reconnectPeriod: 0 }); c.once('connect', () => res(c)); c.once('error', rej); });
  const seen = []; m5.on('message', (t, p, pk) => seen.push({ t, p: JSON.parse(p.toString()), props: pk.properties ?? {} }));
  await new Promise((r) => m5.subscribe(R('main/#'), r));
  check('브리지가 MQTT 5로 외부 브로커에 연결', mqttStatus().bridgeConnected && mqttStatus().bridgeVersion === 5);
  const c2 = s.cmd.issue('SPEED', 'all', 100, { by: '시험' }); run(s, ag, 20); mqttPublish(U.collect({ telemetry: [] })); await wait(500);
  const cm = seen.filter((x) => x.t === R('main/_zone/cmd') && x.p.id === c2.id)[0];
  check('외부 브로커 수신: Correlation Data · Response Topic · Message Expiry · Content Type · User Property', cm && cm.props.correlationData?.toString() === `CMD-${c2.id}` && cm.props.responseTopic === R('main/_zone/cmd/ack') && cm.props.messageExpiryInterval > 0 && cm.props.contentType === 'application/json' && cm.props.userProperties?.isa95 === 'Area', JSON.stringify({ ...cm?.props, correlationData: cm?.props.correlationData?.toString() }));
  m5.publish(R('main/_zone/cmd/request'), JSON.stringify({ code: 'SPEED', arg: 110 }), { properties: { correlationData: Buffer.from('M5-1'), responseTopic: 'mes/replies/1', messageExpiryInterval: 45 } });
  await wait(500);
  const q5 = unsTakeCommands().find((q) => q.via === 'bridge');
  check('외부 브로커의 MQTT 5 요청: Correlation Data · Response Topic · Expiry를 속성에서 읽음', q5?.correlationId === 'M5-1' && q5.responseTopic === 'mes/replies/1' && q5.expirySec === 45, JSON.stringify(q5));
  m5.end(true);
}

console.log('== 죽음 처리');
await wait(4500);
check('발행이 끊기면 _facos/state = online:false (죽음 처리) · rebirth 요청 · Sparkplug 엣지 NDEATH', got.get(R('_facos/state'))?.online === false && mqttStatus().uns.deaths >= 1 && mqttStatus().uns.rebirth === true && raw.filter(([t]) => t.includes('/NDEATH/')).length >= 2, got.get(R('_facos/state'))?.reason);
const late = new Map(), cl2 = await sub();
cl2.on('message', (t, p) => late.set(t, JSON.parse(p.toString())));
await new Promise((r) => cl2.subscribe(R('_facos/state'), r)); await wait(300);
check('죽음 처리도 retain — 나중에 붙은 구독자도 offline을 받음', late.get(R('_facos/state'))?.online === false);
U.rebirth(); mqttPublish(U.collect({ telemetry: [] })); await wait(300);
check('rebirth 발행 → 다시 online · 탄생 2회', got.get(R('_facos/state'))?.online === true && mqttStatus().uns.births === 2);
cl.end(true); cl2.end(true); clr.end(true); mosq?.kill();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
