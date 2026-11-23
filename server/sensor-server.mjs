// 센서 서버 (별도 프로세스 · 별도 DB) — 공장 중앙 MQTT(UNS)의 센서 묶음을 구독해 SQLite(node:sqlite) 시계열 DB에 저장하고, 경보·1분 집계·시간 정렬 조회를 REST로 제공한다.
//   구독: metafactory/sensors/v1/{존}/{셀} (묶음) · …/birth (센서 메타, retain)
//   DB 테이블: sensor(메타) · reading(측정값 — 기준 시계 µs · 동기 잔차) · batch(계층별 시각 · 지연) · agg_1m(1분 집계) · alarm(경보 발생·해제) · meta
//   시간: 모든 시각은 공장 기준 시계(PTP Grandmaster = DataHub 기준 시계) µs — AAS·OPC UA·제품 계보·pcap과 같은 축이라 /align으로 같은 순간을 묶어 조회한다
//   REST (기본 127.0.0.1:8793 — meta-factory 센서 서버 8791과 겹치지 않게 · 앱에서는 앱 서버가 /api/sensors/v1/로 중계):
//     GET /api/sensors/v1/status · /sensors?zone= · /latest?zone=&cell= · /readings?sensor=&from=&to=&limit= · /agg?sensor=&from=&to=
//         /alarms?active=1 · /align?t=<ISO|µs>&window=<초> · /latency · /export.csv?from=&to=&zone=
// 실행: 앱 서버가 자식 프로세스로 띄운다(fork) · 단독: npm run sensor-server [--port 8793] [--db data/sensors/sensors.db] [--mqtt mqtt://127.0.0.1:1883]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mqtt from 'mqtt';
import { guard, isLoopbackHost } from './http-guard.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', process.env.SENSOR_PORT ?? 8793)), HOST = arg('host', process.env.SENSOR_HOST || '127.0.0.1');
const DB_PATH = path.resolve(arg('db', process.env.SENSOR_DB || 'data/sensors/sensors.db'));
const MQTT_URL = arg('mqtt', process.env.SENSOR_MQTT || 'mqtt://127.0.0.1:1883');
const RETAIN_US = 48 * 3600e6;      // 원시 측정값 보존 48시간(기준 시계) · 1분 집계는 30일
const AGG_RETAIN_US = 30 * 86400e6;
const TOPIC = 'metafactory/sensors/v1/#';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS sensor (id TEXT PRIMARY KEY, zone TEXT, cell TEXT, cell_name TEXT, edge TEXT, gateway TEXT, zone_server TEXT, type TEXT, cat TEXT, label TEXT, metric TEXT, unit TEXT, iface TEXT, rate REAL, x REAL, z REAL, spec TEXT, warn TEXT, alarm TEXT, birth_us INTEGER);
CREATE TABLE IF NOT EXISTS batch (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT, seq INTEGER, zone TEXT, cell TEXT, edge TEXT, gateway TEXT, zone_server TEXT, t_edge INTEGER, t_gateway INTEGER, t_zone INTEGER, t_central INTEGER, t_ingest INTEGER, recv_wall INTEGER, n INTEGER, edge_err_us REAL, gw_err_us REAL);
CREATE TABLE IF NOT EXISTS reading (ts INTEGER NOT NULL, sensor TEXT NOT NULL, v REAL, sync_err_us REAL, extra TEXT, batch INTEGER);
CREATE INDEX IF NOT EXISTS reading_s_ts ON reading(sensor, ts);
CREATE INDEX IF NOT EXISTS reading_ts ON reading(ts);
CREATE TABLE IF NOT EXISTS agg_1m (sensor TEXT, bucket INTEGER, n INTEGER, sum REAL, min REAL, max REAL, PRIMARY KEY (sensor, bucket));
CREATE TABLE IF NOT EXISTS alarm (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sensor TEXT, level TEXT, v REAL, rule TEXT, cleared_ts INTEGER);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
const Q = {
  sensor: db.prepare(`INSERT INTO sensor (id, zone, cell, cell_name, edge, gateway, zone_server, type, cat, label, metric, unit, iface, rate, x, z, spec, warn, alarm, birth_us) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET zone=excluded.zone, cell=excluded.cell, cell_name=excluded.cell_name, edge=excluded.edge, gateway=excluded.gateway, zone_server=excluded.zone_server, type=excluded.type, label=excluded.label, metric=excluded.metric, unit=excluded.unit, iface=excluded.iface, rate=excluded.rate, x=excluded.x, z=excluded.z, spec=excluded.spec, warn=excluded.warn, alarm=excluded.alarm, birth_us=excluded.birth_us`),
  batch: db.prepare('INSERT INTO batch (run, seq, zone, cell, edge, gateway, zone_server, t_edge, t_gateway, t_zone, t_central, t_ingest, recv_wall, n, edge_err_us, gw_err_us) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
  reading: db.prepare('INSERT INTO reading (ts, sensor, v, sync_err_us, extra, batch) VALUES (?,?,?,?,?,?)'),
  agg: db.prepare('INSERT INTO agg_1m (sensor, bucket, n, sum, min, max) VALUES (?,?,1,?,?,?) ON CONFLICT(sensor, bucket) DO UPDATE SET n=n+1, sum=sum+excluded.sum, min=MIN(min, excluded.min), max=MAX(max, excluded.max)'),
  alarmOpen: db.prepare('INSERT INTO alarm (ts, sensor, level, v, rule) VALUES (?,?,?,?,?)'),
  alarmClose: db.prepare('UPDATE alarm SET cleared_ts=? WHERE sensor=? AND cleared_ts IS NULL'),
  meta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
};
const rules = new Map(), level = new Map(), latest = new Map();
for (const r of db.prepare('SELECT id, warn, alarm, metric FROM sensor').all()) rules.set(r.id, { warn: JSON.parse(r.warn || 'null'), alarm: JSON.parse(r.alarm || 'null'), metric: r.metric });
for (const a of db.prepare('SELECT sensor, level FROM alarm WHERE cleared_ts IS NULL').all()) level.set(a.sensor, a.level);   // 다시 켤 때 열린 경보 상태 복원 — 없으면 정상값이 와도 이전 경보를 닫지 않는다
const stats = { msgs: 0, readings: 0, batches: 0, births: 0, errors: 0, started: new Date().toISOString(), lastUs: 0, recent: [] };
const lvOf = (R, v) => {
  const skip = R.metric === 'force' && v === 0;   // 하중 0 = 셀 대기 (경보 아님)
  if (R.alarm && ((R.alarm.hi != null && v > R.alarm.hi) || (R.alarm.lo != null && v < R.alarm.lo && !skip))) return 'alarm';
  if (R.warn && ((R.warn.hi != null && v > R.warn.hi) || (R.warn.lo != null && v < R.warn.lo && !skip))) return 'warn';
  return 'ok';
};

// ── 수집 ─────────────────
export function ingest(topic, text) {
  const msg = JSON.parse(text); stats.msgs++;
  if (topic.endsWith('/birth')) {
    for (const q of msg.sensors ?? []) {
      Q.sensor.run(q.id, msg.zone, msg.cell, msg.cellName ?? null, msg.edge, msg.gateway, msg.zoneServer, q.type, q.cat, q.label, q.metric, q.unit, q.iface, q.rate, q.x, q.z, q.spec ?? null, JSON.stringify(q.warn ?? null), JSON.stringify(q.alarm ?? null), Date.now() * 1000);
      rules.set(q.id, { warn: q.warn ?? null, alarm: q.alarm ?? null, metric: q.metric });
    }
    stats.births++; return;
  }
  if (msg.spec !== 'metafactory/sensor-batch/1.0') return;
  const H = msg.hops ?? {};
  const lvNext = new Map();   // 이번 묶음의 경보 수준 변화 — 커밋에 성공했을 때만 메모리에 반영 (실패하면 DB와 어긋나지 않게)
  db.exec('BEGIN');
  try {
    const b = Q.batch.run(msg.run ?? null, msg.seq, msg.zone, msg.cell, msg.edge, msg.gateway, msg.zoneServer, H.edge, H.gateway, H.zone, H.central, H.ingest, Date.now() * 1000, msg.readings.length, msg.clock?.edgeErrUs ?? null, msg.clock?.gatewayErrUs ?? null).lastInsertRowid;
    for (const r of msg.readings) {
      const { s, m, v, u, ts, e, ...extra } = r;
      Q.reading.run(ts, s, v, e ?? null, Object.keys(extra).length ? JSON.stringify(extra) : null, b);
      Q.agg.run(s, Math.floor(ts / 60e6) * 60e6, v, v, v);
      latest.set(s, { ts, v, u, e, extra });
      const R = rules.get(s);
      if (R) { const lv = lvOf(R, v), prev = lvNext.get(s) ?? level.get(s) ?? 'ok'; if (lv !== prev) { Q.alarmClose.run(ts, s); if (lv !== 'ok') Q.alarmOpen.run(ts, s, lv, v, JSON.stringify(lv === 'alarm' ? R.alarm : R.warn)); lvNext.set(s, lv); } }
      if (ts > stats.lastUs) stats.lastUs = ts;
      stats.readings++;
    }
    db.exec('COMMIT');
    for (const [s, lv] of lvNext) level.set(s, lv);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  stats.batches++; stats.recent.push([Date.now(), msg.readings.length]); if (stats.recent.length > 600) stats.recent.shift();
}
// 보존 기간 정리 (1분마다)
setInterval(() => {
  if (!stats.lastUs) return;
  db.prepare('DELETE FROM reading WHERE ts < ?').run(stats.lastUs - RETAIN_US);
  db.prepare('DELETE FROM agg_1m WHERE bucket < ?').run(stats.lastUs - AGG_RETAIN_US);
  db.prepare('DELETE FROM batch WHERE t_central < ?').run(stats.lastUs - RETAIN_US);
}, 60000).unref();

// ── 조회 ─────────────────
const toUs = (x) => (x == null || x === '' ? null : /^\d+$/.test(x) ? Number(x) : Date.parse(x) * 1000);
const iso = (us) => (us == null ? null : new Date(us / 1000).toISOString());
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
export function route(method, pathname, q) {
  if (method !== 'GET') return { code: 405, body: { error: 'GET만 받습니다 (수집은 MQTT 구독)' } };
  const p = pathname.replace(/^\/api\/sensors\/v1\/?/, '');
  if (p === '' || p === 'status') {
    const now = Date.now(), rate = stats.recent.filter(([t]) => now - t < 10000).reduce((a, [, n]) => a + n, 0) / 10;
    let size = 0; try { size = fs.statSync(DB_PATH).size + (fs.existsSync(DB_PATH + '-wal') ? fs.statSync(DB_PATH + '-wal').size : 0); } catch {}
    return { code: 200, body: { server: 'jin-3d sensor server 1.0', pid: process.pid, db: { engine: 'SQLite (node:sqlite)', path: DB_PATH, bytes: size, sensors: count('sensor'), readings: count('reading'), batches: count('batch'), agg1m: count('agg_1m'), alarmsActive: db.prepare('SELECT COUNT(*) AS n FROM alarm WHERE cleared_ts IS NULL').get().n }, ingest: { ...stats, recent: undefined, ratePerS: rate, last: iso(stats.lastUs) }, mqtt: { url: MQTT_URL, topic: TOPIC, connected: client?.connected ?? false }, retention: { rawHours: RETAIN_US / 3600e6, agg1mDays: AGG_RETAIN_US / 86400e6 } } };
  }
  if (p === 'sensors') { const z = q.get('zone'); return { code: 200, body: { sensors: z ? db.prepare('SELECT * FROM sensor WHERE zone=? ORDER BY id').all(z) : db.prepare('SELECT * FROM sensor ORDER BY zone, id').all() } }; }
  if (p === 'latest') {
    const z = q.get('zone'), c = q.get('cell'), meta = db.prepare('SELECT id, zone, cell, label, metric, unit FROM sensor').all();
    return { code: 200, body: { latest: meta.filter((m) => (!z || m.zone === z) && (!c || m.cell === c)).map((m) => { const L = latest.get(m.id); return { ...m, ts: iso(L?.ts), v: L?.v ?? null, level: level.get(m.id) ?? 'ok' }; }) } };
  }
  if (p === 'readings') {
    const s = q.get('sensor'); if (!s) return { code: 400, body: { error: 'sensor가 필요합니다' } };
    const from = toUs(q.get('from')) ?? 0, to = toUs(q.get('to')) ?? Number.MAX_SAFE_INTEGER, lim = Math.max(1, Math.min(20000, Number(q.get('limit')) || 1000));
    const rows = db.prepare('SELECT ts, v, sync_err_us, extra FROM reading WHERE sensor=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?').all(s, from, to, lim).reverse();
    return { code: 200, body: { sensor: s, readings: rows.map((r) => ({ t: iso(r.ts), ts: r.ts, v: r.v, syncErrUs: r.sync_err_us, ...(r.extra ? JSON.parse(r.extra) : {}) })) } };
  }
  if (p === 'agg') {
    const s = q.get('sensor'); if (!s) return { code: 400, body: { error: 'sensor가 필요합니다' } };
    const rows = db.prepare('SELECT bucket, n, sum, min, max FROM agg_1m WHERE sensor=? AND bucket BETWEEN ? AND ? ORDER BY bucket').all(s, toUs(q.get('from')) ?? 0, toUs(q.get('to')) ?? Number.MAX_SAFE_INTEGER);
    return { code: 200, body: { sensor: s, interval: '1m', rows: rows.map((r) => ({ t: iso(r.bucket), n: r.n, avg: r.sum / r.n, min: r.min, max: r.max })) } };
  }
  if (p === 'alarms') {
    const rows = q.get('active') ? db.prepare('SELECT * FROM alarm WHERE cleared_ts IS NULL ORDER BY ts DESC LIMIT 500').all() : db.prepare('SELECT * FROM alarm ORDER BY id DESC LIMIT ?').all(Math.min(2000, Number(q.get('limit')) || 200));
    return { code: 200, body: { alarms: rows.map((r) => ({ ...r, t: iso(r.ts), cleared: iso(r.cleared_ts) })) } };
  }
  if (p === 'align') {   // 같은 순간(기준 시계)의 센서 값 — 제품 계보·설비 이벤트·AAS 시각과 묶어 보기
    const t = toUs(q.get('t')); if (t == null || Number.isNaN(t)) return { code: 400, body: { error: 't(ISO 또는 µs)가 필요합니다' } };
    const w = (Number(q.get('window')) || 5) * 1e6, z = q.get('zone');
    const rows = db.prepare(`SELECT r.sensor, r.ts, r.v, r.sync_err_us, s.zone, s.cell, s.metric, s.unit, ABS(r.ts - ?) AS d FROM reading r LEFT JOIN sensor s ON s.id = r.sensor WHERE r.ts BETWEEN ? AND ? ${z ? 'AND s.zone = ?' : ''} ORDER BY r.sensor, d`).all(t, t - w, t + w, ...(z ? [z] : []));
    const seen = new Set(), out = []; for (const r of rows) if (!seen.has(r.sensor)) { seen.add(r.sensor); out.push({ sensor: r.sensor, zone: r.zone, cell: r.cell, metric: r.metric, unit: r.unit, v: r.v, t: iso(r.ts), dtMs: (r.ts - t) / 1000, syncErrUs: r.sync_err_us }); }
    return { code: 200, body: { t: iso(t), windowS: w / 1e6, values: out } };
  }
  if (p === 'latency') {
    const r = db.prepare('SELECT COUNT(*) AS n, AVG(t_gateway - t_edge) AS gw, AVG(t_zone - t_gateway) AS zone, AVG(t_central - t_zone) AS central, AVG(t_ingest - t_central) AS ingest, AVG(ABS(edge_err_us)) AS edgeErr, MAX(ABS(edge_err_us)) AS edgeErrMax, AVG(ABS(gw_err_us)) AS gwErr FROM (SELECT * FROM batch ORDER BY id DESC LIMIT 5000)').get();
    return { code: 200, body: { batches: r.n, hopMs: { edgeToGateway: r.gw / 1000, gatewayToZone: r.zone / 1000, zoneToCentral: r.central / 1000, centralToServer: r.ingest / 1000 }, clockUs: { edgeAvg: r.edgeErr, edgeMax: r.edgeErrMax, gatewayAvg: r.gwErr } } };
  }
  if (p === 'export.csv') {
    const z = q.get('zone'), rows = db.prepare(`SELECT r.ts, r.sensor, s.zone, s.cell, s.metric, r.v, s.unit, r.sync_err_us FROM reading r LEFT JOIN sensor s ON s.id = r.sensor WHERE r.ts BETWEEN ? AND ? ${z ? 'AND s.zone = ?' : ''} ORDER BY r.ts LIMIT 200000`).all(toUs(q.get('from')) ?? 0, toUs(q.get('to')) ?? Number.MAX_SAFE_INTEGER, ...(z ? [z] : []));
    return { code: 200, csv: ['time,ts_us,sensor,zone,cell,metric,value,unit,sync_err_us', ...rows.map((r) => [iso(r.ts), r.ts, r.sensor, r.zone, r.cell, r.metric, r.v, r.unit, r.sync_err_us].join(','))].join('\n') };
  }
  return { code: 404, body: { error: 'Not found' } };
}

// ── MQTT 구독 · HTTP ─────────────────
let client = null;
if (!process.env.SENSOR_NO_MQTT) {
  client = mqtt.connect(MQTT_URL, { clientId: `jin3d-sensor-server-${process.pid}`, reconnectPeriod: 3000 });
  client.on('connect', () => client.subscribe(TOPIC, { qos: 0 }));
  client.on('message', (topic, buf) => { try { ingest(topic, buf.toString('utf8')); } catch (e) { stats.errors++; stats.lastError = e.message; } });
  client.on('error', (e) => { stats.lastError = e.message; });
}
const server = http.createServer((req, res) => {
  if (guard(req, res, { loopback: isLoopbackHost(HOST) })) return;   // 다른 웹페이지가 보낸 요청 거부
  const url = new URL(req.url, 'http://localhost');
  let r; try { r = route(req.method, url.pathname, url.searchParams); } catch (e) { r = { code: 400, body: { error: e.message } }; }
  if (r.csv != null) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); return res.end(r.csv); }
  res.writeHead(r.code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r.body));
});
server.listen(PORT, HOST, () => {
  const port = server.address().port; Q.meta.run('started', new Date().toISOString());
  if (process.send) process.send({ ready: true, port, db: DB_PATH }); else console.log(`센서 서버 http://${HOST}:${port}/api/sensors/v1/status · DB ${DB_PATH} · MQTT ${MQTT_URL}`);
});
process.on('SIGTERM', () => { try { client?.end(true); db.close(); } catch {} process.exit(0); });
process.on('disconnect', () => { try { client?.end(true); db.close(); } catch {} process.exit(0); });   // 앱 서버(부모)가 끝나면 함께 끝난다
