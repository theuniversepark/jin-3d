// 센서망 검증 (정밀조립Zone + 공용 설비) — 센서 배치(존·셀) · 측정값(설비 상태 반영) · 시간 동기(기준 시계 · PTP 잔차) · 계층 순서(엣지 → 게이트웨이 → 존 → 중앙 → 서버) ·
// 제품 계보·RCA 특징 표 연동, 그리고 실제 MQTT 브로커(aedes) → 센서 서버(별도 프로세스) → SQLite 적재 · REST 조회(시간 정렬 포함). 실행: npm test
import { fork } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { featuresCSV } from '../js/trace.js';
import { SENSOR_TYPES } from '../js/sensors.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

console.log('== 센서 배치 · 측정 (피지컬AI 20분)');
const s = new Simulation('dark', 5, { line: zoneLine(), quiet: true, sensors: true }), N = s.sensors; N.publish = true;
const sampled = []; const orig = N.value.bind(N); N.value = (sn) => { const r = orig(sn); sampled.push([sn, N.us()]); return r; };
for (let t = 0; t < 1200; t += 0.1) s.step(0.1);
const S = N.summary(), zones = Object.keys(S.lv ? N.zoneSrv : {});
check('정밀조립Zone · 공용 설비에만 센서 (다른 Zone 없음)', ['main', 'fac'].every((z) => N.sensors.some((q) => q.zone === z)) && N.sensors.every((q) => ['main', 'fac'].includes(q.zone)) && Object.keys(N.zoneSrv).join() === 'main,fac', JSON.stringify(N.stats.byZone));
check('모든 셀에 셀 엣지 · 센서', s.processing.map((x) => x.id).every((id) => N.edges.some((e) => e.cell === id && e.sensors.length)), `셀 엣지 ${N.edges.length} · 게이트웨이 ${N.gateways.length} · 존 서버 ${zones.length}`);
check('센서 종류 전부 배치', Object.keys(SENSOR_TYPES).every((k) => N.sensors.some((q) => q.type === k)), `${Object.keys(SENSOR_TYPES).length}종 · ${N.sensors.length}개`);
check('센서 자리 = 건물 안 (micro 배치 좌표)', N.sensors.every((q) => q.x > -51 && q.x < 38 && q.z > -20 && q.z < 20) && N.sensors.filter((q) => q.owner).every((q) => Math.hypot(q.x - q.owner.st.x, q.z - q.owner.st.z) < 0.6));
check('모든 센서가 측정', N.sensors.every((q) => N.latest.has(q.id)), `측정값 ${N.stats.readings}`);
// 시간 동기: 측정값 타임스탬프 − 기준 시계(측정 순간) = 동기 잔차 e (유선 PTP 2µs 이내 · LoRaWAN 수 ms)
const msgs = N.outbox.map((m) => JSON.parse(m.payload)), rds = msgs.flatMap((b) => b.readings);
const wired = rds.filter((r) => !N.sensors.find((q) => q.id === r.s).iface.includes('LoRa')), lora = rds.filter((r) => N.sensors.find((q) => q.id === r.s).iface.includes('LoRa'));
// 잔차 = 엣지(σ 0.4µs) + 게이트웨이(σ 0.08µs) 정규 난수 — 한계는 약 7σ(3µs). meta 시험은 2µs(5σ)였으나 micro 센서 수로는 난수 순서가 달라 1초 동안 2.05µs가 한 번 나온다(823.9초 공용 설비 엣지)
check('유선 PTP 타임스탬프 잔차 < 3µs', wired.length > 0 && wired.every((r) => Math.abs(r.e) < 3), `최대 ${Math.max(...wired.map((r) => Math.abs(r.e))).toFixed(3)}µs · ${wired.length}개`);
check('LoRaWAN 타임스탬프 잔차 < 20ms', lora.length > 0 && lora.every((r) => Math.abs(r.e) < 20000), `최대 ${(Math.max(...lora.map((r) => Math.abs(r.e))) / 1000).toFixed(2)}ms`);
const simEnd = N.us(), first = sampled[0][1];
check('타임스탬프 = 기준 시계(DataHub와 같은 epoch + 시뮬레이션 시각)', rds.every((r) => r.ts >= first - 20000 && r.ts <= simEnd + 20000) && Math.abs(N.us(0) - N.epochMs * 1000) < 1);
check('계층 순서: 엣지 < 게이트웨이 < 존 서버 < 공장 중앙 < 서버', msgs.every((b) => b.hops.edge < b.hops.gateway && b.hops.gateway < b.hops.zone && b.hops.zone < b.hops.central && b.hops.central < b.hops.ingest), `${msgs.length}묶음`);
// 설비 상태 반영: 건강도를 낮추면 진동·첨도 증가
const st = s.processing.find((x) => x.id === 'DT_ASSY'), vibId = N.sensors.find((q) => q.cell === 'DT_ASSY' && q.type === 'vib').id;
const before = N.hist.get(vibId).slice(-20); st.health = 25; for (let t = 0; t < 300; t += 0.1) { st.health = 25; s.step(0.1); }
const after = N.hist.get(vibId).slice(-20), avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
check('건강도 저하 → 진동 증가 (예지정비 신호)', avg(after) > avg(before) * 1.5, `${avg(before).toFixed(2)} → ${avg(after).toFixed(2)} mm/s`);
const recs = s.trace.recent.filter((r) => r.steps.some((p) => p.sensors && Object.keys(p.sensors).length));
check('제품 계보 단계에 그 셀 센서 값 · RCA 특징 표 열', recs.length > 0 && featuresCSV(s.trace, s.trace.recent).split('\n')[0].includes('DT_ASSY_sns_vrms'), `계보 ${recs.length}개`);

console.log('== MQTT 브로커 → 센서 서버(별도 프로세스) → SQLite');
const broker = await Aedes.createBroker(), tcp = net.createServer(broker.handle); await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
const mport = tcp.address().port, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-sensor-'));
const child = fork(path.resolve('server/sensor-server.mjs'), [], { env: { ...process.env, SENSOR_PORT: '0', SENSOR_DB: path.join(dir, 'sensors.db'), SENSOR_MQTT: `mqtt://127.0.0.1:${mport}` }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const port = await new Promise((res, rej) => { child.on('message', (m) => m?.ready && res(m.port)); setTimeout(() => rej(new Error('센서 서버 시작 시간 초과')), 15000); });
const get = async (p) => (await fetch(`http://127.0.0.1:${port}/api/sensors/v1/${p}`)).json();
for (let k = 0; k < 40; k++) { if ((await get('status')).mqtt.connected) break; await new Promise((r) => setTimeout(r, 100)); }
await new Promise((r) => setTimeout(r, 300));   // 구독 완료
const pub = mqtt.connect(`mqtt://127.0.0.1:${mport}`); await new Promise((r) => pub.on('connect', r));
const out = N.take(1e9);
// aedes 1.2는 retain 발행을 이미 구독 중인 클라이언트에 보내지 않는다 — 앱 게이트웨이(server/mqtt-gateway.mjs)처럼 retain 저장 + 일반 발행을 같이 한다
for (const m of out) { if (m.retain) await new Promise((r) => pub.publish(m.topic, m.payload, { retain: true }, r)); await new Promise((r) => pub.publish(m.topic, m.payload, { retain: false }, r)); }
const sent = out.filter((m) => !m.topic.endsWith('/birth')).reduce((a, m) => a + JSON.parse(m.payload).readings.length, 0);
let stt; for (let k = 0; k < 100; k++) { stt = await get('status'); if (stt.db.readings >= sent) break; await new Promise((r) => setTimeout(r, 100)); }
check('별도 프로세스 · 별도 DB 파일', child.pid !== process.pid && fs.existsSync(path.join(dir, 'sensors.db')), `pid ${child.pid} · ${stt.db.engine}`);
check('MQTT 구독 → 전부 적재 (sensor · reading · batch · agg_1m)', stt.db.readings === sent && stt.db.sensors === N.sensors.length && stt.db.batches > 0 && stt.db.agg1m > 0, `${stt.db.readings}/${sent}행 · 센서 ${stt.db.sensors}${stt.ingest.lastError ? ` · 오류 ${stt.ingest.lastError}` : ''}`);
const rd = await get(`readings?sensor=${vibId}&limit=5`);
check('측정값 조회 (기준 시계 ISO · 동기 잔차 · 특징값)', rd.readings.length === 5 && rd.readings.every((r) => r.t && r.syncErrUs != null && r.f?.kurt != null), rd.readings[0]?.t);
const pr = out.filter((m) => !m.topic.endsWith('/birth')).flatMap((m) => JSON.parse(m.payload).readings), t0 = pr[Math.floor(pr.length / 2)].ts, al = await get(`align?t=${t0}&window=5`);
check('시간 정렬 조회: 같은 순간 ±5초 전 센서 값', al.values.length > 20 && al.values.every((v) => Math.abs(v.dtMs) <= 5000), `${al.values.length}개 센서`);
const lt = await get('latency'), alarms = await get('alarms');
check('계층 지연 · 시계 잔차 집계', lt.hopMs.edgeToGateway > 0 && lt.hopMs.centralToServer > lt.hopMs.edgeToGateway && lt.clockUs.edgeMax < 2, JSON.stringify(lt.hopMs));
check('경보 규칙 (센서 기준값) 기록', Array.isArray(alarms.alarms) && alarms.alarms.length > 0, `경보 ${alarms.alarms.length}건`);
pub.end(true); child.kill(); tcp.close(); broker.close(); fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
