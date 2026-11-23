// 공장 환경·설비 상태 센서망 — 센서 → 셀 엣지 → 엣지 게이트웨이 → 존 서버 → 공장 중앙(MQTT UNS · PTP 기준 시계) → 센서 서버(별도 프로세스 · 별도 DB)
//  · 센서 목록(SENSOR_TYPES): 실내 환경 · 설비 상태(진동·소리·전류·전력) · 유틸리티 · 안전 — 사양 · 현장 연결(IO-Link · Modbus · LoRaWAN · 4–20mA) · 주기 · 경보 기준
//  · 배치(PLACE): 셀 종류마다 필요한 센서 + 정밀조립Zone 환경 노드 + 공용 설비(압축공기 · 수배전 · 충전소 · 창고) — 자리는 이 공장 배치(셀 · 창고 · 도크 · 충전소) 좌표
//  · 측정값: 시뮬레이션 상태에서 만든다 — 셀 가동·건강도·드리프트(진동·전류·전력·AE), 정밀조립 환경(trace.js 환경 센서), 현장 이벤트(연기·누유), 사람 위치(재실)
//  · 엣지: 고속 신호(진동·AE·음향)는 특징값(RMS · 피크 · 첨도)으로 줄여 보낸다 · 1초마다 묶어(batch) 게이트웨이로
//  · 시간 동기: 공장 중앙 서버 = 기준 시계(PTP Grandmaster, DataHub·AAS·OPC UA·제품 계보·pcap과 같은 시계) → 게이트웨이 = Boundary Clock → 셀 엣지 = Ordinary Clock(PTP)
//    배터리 무선 센서(LoRaWAN)는 게이트웨이 수신 시각으로 찍는다(NTP 동기 · 수 ms 오차). 측정값마다 기준 시계 타임스탬프와 동기 잔차를 함께 보낸다.
//  · 전송: 존 서버가 공장 중앙 MQTT로 metafactory/sensors/v1/{존}/{셀} 발행(묶음) · …/birth(센서 메타 · retain — Sparkplug B BIRTH 개념)
// 렌더링과 분리 — 헤드리스에서도 같은 흐름. 시뮬레이션 난수(sim.rand)를 쓰지 않는다 (별도 난수).
import { ZONE_LABEL, BUILDING } from './zonedefs.js';

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// ── 센서 목록 ─────────────────
// cat: env(실내 환경) · cond(설비 상태) · util(유틸리티) · safety(안전) · rate: 측정 주기(초) · warn/alarm: 경보 기준(hi 위 · lo 아래)
export const SENSOR_TYPES = {
  temp_rh:   { cat: 'env', label: '온습도', metric: 'temp', unit: '°C', extra: { rh: '%RH' }, spec: '−20~60°C ±0.3°C · 0~100%RH ±2%', iface: 'Modbus RTU', rate: 10, warn: { hi: 28 }, alarm: { hi: 32 } },
  pm:        { cat: 'env', label: '미세먼지 PM2.5', metric: 'pm25', unit: 'µg/m³', spec: '레이저 산란 0~1000µg/m³', iface: 'Modbus RTU', rate: 10, warn: { hi: 35 }, alarm: { hi: 75 } },
  lux:       { cat: 'env', label: '조도', metric: 'lux', unit: 'lx', spec: '0~20,000lx', iface: '4–20mA', rate: 10, warn: { lo: 560 }, alarm: { lo: 500 } },
  noise:     { cat: 'env', label: '소음', metric: 'laeq', unit: 'dB(A)', spec: 'IEC 61672 Class 2 · 30~130dB', iface: 'Modbus TCP', rate: 5, warn: { hi: 80 }, alarm: { hi: 85 } },
  co2:       { cat: 'env', label: 'CO₂', metric: 'co2', unit: 'ppm', spec: 'NDIR 0~5000ppm', iface: 'Modbus RTU', rate: 30, warn: { hi: 1000 }, alarm: { hi: 1500 } },
  vib:       { cat: 'cond', label: '진동 (MEMS 3축)', metric: 'vrms', unit: 'mm/s', feat: true, spec: '0~10kHz ±16g · ISO 20816 평가', iface: 'IO-Link', rate: 5, warn: { hi: 4.5 }, alarm: { hi: 7.1 } },
  floor_vib: { cat: 'cond', label: '바닥 진동', metric: 'vfloor', unit: 'mm/s', spec: '1~100Hz 저주파', iface: 'Modbus TCP', rate: 5, warn: { hi: 0.8 }, alarm: { hi: 2.8 } },
  acoustic:  { cat: 'cond', label: '음향 이상음 (마이크 어레이)', metric: 'anom', unit: '점수', feat: true, spec: '20Hz~20kHz MEMS · 엣지 AI 이상음 분류', iface: 'I²S → 엣지', rate: 5, warn: { hi: 0.6 }, alarm: { hi: 0.8 } },
  current:   { cat: 'cond', label: '전류 (CT)', metric: 'irms', unit: 'A', spec: '분할형 CT 0~200A · 1kHz 파형(MCSA)', iface: 'Modbus TCP', rate: 5, warn: { hi: 60 }, alarm: { hi: 80 } },
  power:     { cat: 'cond', label: '전력량계', metric: 'kw', unit: 'kW', extra: { kwh: 'kWh', pf: '' }, spec: '3상 4선 · IEC 62053 Class 0.5S', iface: 'Modbus TCP', rate: 5 },
  force:     { cat: 'cond', label: '압입 하중 (로드셀)', metric: 'force', unit: 'kN', spec: '스트레인 게이지 0~10kN', iface: '제어기 → OPC UA', rate: 5, warn: { lo: 2.2, hi: 3.4 }, alarm: { lo: 2.0, hi: 3.6 } },
  torque:    { cat: 'cond', label: '체결 토크 (너트러너)', metric: 'torque', unit: 'N·m', spec: '토크·각도 트랜스듀서', iface: '제어기 → OPC UA', rate: 5 },
  air:       { cat: 'util', label: '압축공기 유량·압력', metric: 'flow', unit: 'Nm³/h', extra: { bar: 'bar' }, spec: '열식 유량계 · 0~16bar', iface: 'IO-Link', rate: 5, warn: { hi: 160 }, alarm: { hi: 200 } },
  dewpoint:  { cat: 'util', label: '압축공기 이슬점', metric: 'tdew', unit: '°C td', spec: '−60~+20°C td', iface: 'Modbus RTU', rate: 30, warn: { hi: 3 }, alarm: { hi: 10 } },
  pq:        { cat: 'util', label: '전력 품질 (수배전반)', metric: 'thd', unit: '% THD', extra: { v: 'V' }, spec: 'IEC 61000-4-30 Class S', iface: 'Modbus TCP', rate: 5, warn: { hi: 5 }, alarm: { hi: 8 } },
  h2:        { cat: 'safety', label: '수소 가스 (충전소)', metric: 'lel', unit: '%LEL', spec: '촉매연소식 0~100%LEL', iface: '4–20mA', rate: 5, warn: { hi: 10 }, alarm: { hi: 25 } },
  smoke:     { cat: 'safety', label: '연기·열 감지기', metric: 'smoke', unit: '상태', spec: '광전식 · 소방 수신반 연동', iface: '디지털 입력', rate: 2, alarm: { hi: 0.5 } },
  leak:      { cat: 'safety', label: '누유·누수 감지', metric: 'leak', unit: '상태', spec: '케이블식 감지대', iface: 'LoRaWAN', rate: 10, alarm: { hi: 0.5 } },
  door:      { cat: 'safety', label: '출입문·셔터 개폐', metric: 'open', unit: '상태', spec: '자석 접점', iface: 'LoRaWAN', rate: 10, warn: { hi: 0.5 } },
  occupancy: { cat: 'safety', label: '재실·접근 (mmWave 레이더)', metric: 'people', unit: '명', spec: '60GHz 레이더 · 위치·인원', iface: 'Ethernet', rate: 2 },
};
export const SENSOR_CAT = { env: '실내 환경', cond: '설비 상태', util: '유틸리티', safety: '안전' };

// ── 배치 규칙: 셀 종류 → 센서 ─────────────────
const CELL_KIT = {   // 정밀조립Zone 셀 종류만 (다른 Zone 셀 · 가공기 센서는 없다)
  sort: ['lux', 'pm', 'vib', 'current', 'power'], assembly: ['temp_rh', 'force', 'vib', 'acoustic', 'current', 'power'], screw: ['torque', 'floor_vib', 'vib', 'current', 'power'],
  fasten: ['torque', 'floor_vib', 'vib', 'current', 'power'], pack: ['lux', 'vib', 'power'],
};
const ZONE_KIT = ['temp_rh', 'co2', 'noise', 'pm', 'smoke', 'leak', 'door', 'occupancy'];   // 존 환경 노드 (존 서버 옆)
const FAC_KIT = [['air', '압축기실'], ['dewpoint', '압축기실'], ['pq', '수배전반'], ['h2', 'AMR 충전소'], ['temp_rh', '자재 창고'], ['door', '입고 도크'], ['door', '출하 도크'], ['smoke', '자재 창고']];

// ── 계층 · 네트워크 · 오픈소스 ─────────────────
export const LAYERS = [
  { key: 'sensor', label: '센서', what: '측정 · 현장 연결', proto: 'IO-Link(IEC 61131-9) · Modbus RTU/TCP · 4–20mA · LoRaWAN · I²S/DAQ', oss: 'IODD(IO-Link 기기 기술) · libmodbus · ChirpStack(LoRaWAN 네트워크 서버)' },
  { key: 'edge', label: '셀 엣지', what: '수집 · 특징 추출(RMS·첨도·FFT) · 1초 묶음 · 버퍼 · PTP Ordinary Clock', proto: '필드버스 → MQTT 5 (셀 내부 LAN)', oss: 'Node-RED · Telegraf(입력 플러그인) · linuxptp(ptp4l)' },
  { key: 'gateway', label: '엣지 게이트웨이', what: '프로토콜 변환 · 저장 후 전달(store-and-forward) · 보안 경계 · PTP Boundary Clock', proto: 'MQTT(Sparkplug B 토픽·BIRTH 개념) · OPC UA PubSub', oss: 'Eclipse Mosquitto(브리지) · Eclipse Tahu(Sparkplug) · open62541 · linuxptp' },
  { key: 'zone', label: '존 서버', what: '존 UNS · 존 규칙(경보 1차) · 존 대시보드 · 공장 중앙으로 묶어 발행', proto: 'MQTT 브리지 → 공장 UNS', oss: 'Eclipse Mosquitto · Node-RED' },
  { key: 'central', label: '공장 중앙', what: 'MQTT 브로커(UNS) · PTP Grandmaster(기준 시계) · DataHub(AAS · OPC UA)', proto: 'MQTT · OPC UA · PTP(IEEE 1588-2019)', oss: 'Eclipse Mosquitto(앱 내장 브로커 · MQTT 5) · aedes(대비) · linuxptp · chrony' },
  { key: 'server', label: '센서 서버 (별도)', what: '수집(MQTT 구독) · 경보 규칙 · 1분 집계 · 시간 정렬 조회 API', proto: 'MQTT 구독 · REST(HTTP)', oss: 'MQTT.js · Telegraf(운영) · Grafana(대시보드)' },
  { key: 'db', label: '센서 DB (별도)', what: '시계열 저장 · 보존 기간 · 집계 테이블', proto: 'SQL', oss: 'SQLite(node:sqlite · 앱) · TimescaleDB/PostgreSQL(운영)' },
];
const LAT = { sensor: { 'IO-Link': 0.002, 'Modbus RTU': 0.05, 'Modbus TCP': 0.005, '4–20mA': 0.01, LoRaWAN: 1.2, Ethernet: 0.003, 'DAQ → 엣지': 0.001, 'I²S → 엣지': 0.001, '제어기 → OPC UA': 0.01, '용접기 → OPC UA': 0.01, '디지털 입력': 0.002 }, gw: 0.0012, zone: 0.002, central: 0.003, ingest: 0.006 };
const EDGE_FLUSH = 1;   // 셀 엣지 → 게이트웨이 묶음 주기 (초)
const ZONES = ['main', 'fac'];   // 정밀조립Zone + 공용 설비·물류
const ZLABEL = { ...ZONE_LABEL, fac: '공용·물류' };
export const SENSOR_TOPIC = (zone, cell) => `metafactory/sensors/v1/${zone}/${cell}`;

export class SensorNet {
  constructor(sim) {
    sim.sensors = this; this.sim = sim; this.rnd = mulberry(20261018); this.g = () => { let u = 0, v = 0; while (!u) u = this.rnd(); while (!v) v = this.rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    this.epochMs = Date.UTC(2026, 9, 18, 23, 0, 0);
    this.publish = false; this.outbox = []; this.birthQ = []; this.seq = 0; this.births = new Set();   // birthQ: 센서 메타(BIRTH) — 묶음이 밀려 버려져도 메타는 꼭 먼저 보낸다
    this.latest = new Map(); this.hist = new Map(); this.alarms = [];
    this.stats = { readings: 0, batches: 0, bytes: 0, dropped: 0, lat: { sensor: 0, edge: 0, gw: 0, zone: 0, central: 0, ingest: 0, n: 0 }, byZone: {} };
    this.build();
  }
  setEpoch(ms) { this.epochMs = ms; }
  us(t = this.sim.time) { return Math.round((this.epochMs + t * 1000) * 1000); }   // 기준 시계 µs (DataHub·제품 계보·pcap과 같은 시계)

  // 망 구성: 존 서버 · 게이트웨이(존마다 행 단위) · 셀 엣지 · 센서
  build() {
    const s = this.sim, cells = [];
    for (const st of s.processing) cells.push({ zone: 'main', id: st.id, name: st.name, type: st.type, x: st.x, z: st.z, owner: { kind: 'station', st } });
    this.zoneSrv = {}; this.gateways = []; this.edges = []; this.sensors = [];
    let gi = 0, ei = 0;
    const cen = (z) => { const cs = cells.filter((c) => c.zone === z); return cs.length ? { x: cs.reduce((a, c) => a + c.x, 0) / cs.length, z: cs.reduce((a, c) => a + c.z, 0) / cs.length } : { x: BUILDING.x0 + 6, z: BUILDING.z0 + 6 }; };
    ZONES.forEach((z, i) => { const p = cen(z); this.zoneSrv[z] = { id: `ZS-${z.toUpperCase()}`, zone: z, label: `${ZLABEL[z]} 존 서버`, ip: [10, 20, 5, 10 + i], x: p.x, z: p.z }; });
    const gwOf = (zone, row) => {
      let g = this.gateways.find((x) => x.zone === zone && x.row === row);
      if (!g) { g = { id: `GW-${zone.toUpperCase()}-${row}`, zone, row, ip: [10, 20, 4, 10 + gi++], clock: this.clock('BC'), edges: 0 }; this.gateways.push(g); }
      return g;
    };
    const addSensor = (type, edge, x, z, where, owner) => {
      const T = SENSOR_TYPES[type], n = this.sensors.filter((q) => q.edge === edge.id && q.type === type).length;
      const id = `SN-${edge.cell}-${type.toUpperCase().replace(/_/g, '')}${n ? n + 1 : ''}`.replace(/[^A-Z0-9-]/gi, '');
      const sn = { id, type, cat: T.cat, label: T.label, metric: T.metric, unit: T.unit, iface: T.iface, rate: T.rate, zone: edge.zone, cell: edge.cell, cellName: edge.cellName, edge: edge.id, gateway: edge.gateway, x, z, where, owner, next: this.rnd() * T.rate, kwh: 0 };
      this.sensors.push(sn); edge.sensors.push(sn);
    };
    const addEdge = (zone, cell, cellName, row, x, z, owner) => {
      const g = gwOf(zone, row); g.edges++;
      const e = { id: `EDGE-${zone.toUpperCase()}-${cell}`, zone, cell, cellName, gateway: g.id, gw: g, ip: [10, 20, 3, 10 + ei++], clock: this.clock('OC'), buf: [], t: this.rnd() * EDGE_FLUSH, sensors: [], x, z, owner };
      this.edges.push(e); return e;
    };
    for (const c of cells) {
      const row = c.z > 1 ? 'A' : c.z < -1 ? 'B' : 'C';   // 도어트림 줄(A) · e-axle 줄(B) · 가운데 공용 셀(C)
      const e = addEdge(c.zone, c.id, c.name, row, c.x, c.z, c.owner);
      (CELL_KIT[c.type] ?? ['power']).forEach((t, k) => addSensor(t, e, c.x + Math.cos(k * 1.3) * 0.5, c.z + Math.sin(k * 1.3) * 0.5, c.name, c.owner));
    }
    // 존 환경 노드 (값은 trace.js 환경 센서 ENV-01~04 중 가까운 노드 것 — 품질 쪽 envMul이 보는 환경과 같다)
    for (const z of ['main']) {
      const S = this.zoneSrv[z], e = addEdge(z, `ENV-${z.toUpperCase()}`, `${ZLABEL[z]} 환경 노드`, 'ENV', S.x, S.z + 3, null);
      ZONE_KIT.forEach((t, k) => addSensor(t, e, S.x + Math.cos(k * 0.8) * 1.2, S.z + 3 + Math.sin(k * 0.8) * 1.2, `${ZLABEL[z]} 환경 노드`, null));
    }
    // 공용 설비·물류
    // 공용 설비·물류 — 자리: 뒷벽 안쪽 유틸리티 구역(압축기 · 수배전) · 충전소(chgLoc) · 자재창고(LOC.WH) · 입고 도크(왼쪽 벽) · 출하 도크(뒷벽)
    const util = addEdge('fac', 'UTIL', '공용 설비·물류', 'U', -28, BUILDING.z0 + 1.5, null);
    const spot = { 압축기실: [-31, BUILDING.z0 + 1.5], 수배전반: [-25, BUILDING.z0 + 1.5], 'AMR 충전소': [-10.8, 13.5], '자재 창고': [-43.2, 0.9], '입고 도크': [BUILDING.x0 + 1, -14.5], '출하 도크': [22.5, BUILDING.z0 + 1] };
    for (const [t, w] of FAC_KIT) addSensor(t, util, spot[w][0], spot[w][1], w, null);
    for (const sn of this.sensors) this.stats.byZone[sn.zone] = (this.stats.byZone[sn.zone] ?? 0) + 1;
  }
  // 시계: GM(기준) · BC(게이트웨이 · PTP) · OC(셀 엣지 · PTP) — 잔차(µs)는 동기마다 다시 잡히고 그 사이 주파수 잔차만큼 흐른다
  clock(kind) { return { kind, method: 'PTP', sigma: kind === 'BC' ? 0.08 : 0.4, ppm: (this.rnd() - 0.5) * 0.04, err: 0, sync: 1, t: 0, offset0: (this.rnd() - 0.5) * 50000 }; }
  stepClock(c, dt) { c.t += dt; c.err += c.ppm * dt; if (c.t >= c.sync) { c.t = 0; c.err = this.g() * c.sigma; } }

  // 측정값 (기준 시계 시각 t에서)
  value(sn) {
    const s = this.sim, T = SENSOR_TYPES[sn.type], o = sn.owner, g = this.g, t = s.time;
    const st = o?.kind === 'station' ? o.st : null;
    const health = st?.health ?? 90, drift = st?.drift ?? 0;
    const busy = st ? st.state === 'BUSY' : false;
    const down = st?.state === 'DOWN' || st?.state === 'MAINT';
    const wear = (100 - health) / 100, day = Math.sin(((t + 8 * 3600) / 86400) * 2 * Math.PI - Math.PI / 2);
    const env = sn.zone === 'main' && s.trace?.env ? s.trace.env.at(sn.x, sn.z) : null;
    const base = { main: 24, fac: 21.5 }[sn.zone] ?? 23;
    const ev = (type) => (s.fieldEvents ?? []).some((e) => !e.cleared && e.type === type && Math.hypot(e.x - sn.x, e.z - sn.z) < 9);
    const kw = st ? (down ? st.def.idleKW * 0.5 : busy ? st.def.busyKW : st.def.idleKW) : 1.6;
    const out = {};
    switch (sn.type) {
      case 'temp_rh': { const tv = env ? env.temp : base + day * 0.8 + (busy ? 0.4 : 0) + g() * 0.08; out.v = tv; out.rh = env ? env.rh : 46 - day * 4 + g() * 0.6; break; }
      case 'pm': out.v = env ? env.pm : 9 + Math.abs(g()) * 2; break;
      case 'lux': out.v = env ? env.lux : 760 + g() * 12; break;
      case 'noise': out.v = env ? env.noise : 64 + (busy ? 9 : 0) + g() * 1.2; break;
      case 'co2': out.v = 520 + s.movers.filter((m) => (m.kind === 'worker' || m.kind === 'tech') && Math.hypot(m.x - sn.x, m.z - sn.z) < 15).length * 60 + day * 40 + g() * 8; break;
      case 'vib': { const rms = down ? 0.05 : (busy ? 1.1 + wear * 6.5 + drift * 2 : 0.25 + wear) + Math.abs(g()) * 0.08; out.v = rms; out.f = { pk: r2(rms * (2.9 + wear * 3), 2), kurt: r2(3 + wear * 6 + Math.abs(g()) * 0.3, 2) }; break; }
      case 'floor_vib': out.v = env ? env.vib : 0.18 + (busy ? 0.12 : 0) + Math.abs(g()) * 0.05; break;
      case 'acoustic': out.v = Math.min(1, (busy ? 0.15 + wear * 0.9 : 0.05) + Math.abs(g()) * 0.05); out.f = { spl: r2(70 + wear * 12, 1) }; break;
      case 'current': out.v = (kw * 1000) / (Math.sqrt(3) * 400 * 0.86) + g() * 0.15; break;
      case 'power': { out.v = kw + g() * 0.05; sn.kwh += (kw * sn.rate) / 3600; out.kwh = sn.kwh; out.pf = 0.86 + g() * 0.01; break; }
      case 'force': out.v = busy ? 2.8 - drift * 0.6 + g() * 0.08 : 0; break;
      case 'torque': { const insp = s.trace?.recent?.findLast?.((r) => r.inspection && r.inspection.st === (st?.uid ?? st?.id))?.inspection; out.v = insp?.torque ?? (sn.cell === 'EA_FAST' ? 85 : 4.5); break; }
      case 'air': out.v = 92 + s.processing.filter((x) => x.state === 'BUSY').length * 6 + g() * 3; out.bar = 6.3 - out.v / 400 + g() * 0.02; break;
      case 'dewpoint': out.v = -38 + g() * 0.6; break;
      case 'pq': out.v = 2.4 + s.processing.filter((x) => x.state === 'BUSY').length * 0.25 + g() * 0.1; out.vline = 400 + g() * 1.5; break;
      case 'h2': out.v = Math.abs(g()) * 0.6 + (s.techs ?? []).filter((m) => m.swapping).length * 0.8; break;
      case 'smoke': out.v = ev('smoke') ? 1 : 0; break;
      case 'leak': out.v = ev('leak') ? 1 : 0; break;
      case 'door': out.v = s.trace?.env?.exc?.kind === 'dust' && sn.where !== '출하 도크' ? 1 : (Math.sin(t / 300 + sn.x) > 0.97 ? 1 : 0); break;
      case 'occupancy': out.v = s.movers.filter((m) => ['worker', 'tech', 'humanoid'].includes(m.kind) && Math.hypot(m.x - sn.x, m.z - sn.z) < 8).length; break;
      default: out.v = 0;
    }
    out.v = r2(out.v, 3);
    for (const k of Object.keys(out)) if (k !== 'v' && k !== 'f' && typeof out[k] === 'number') out[k] = r2(out[k], 3);
    return out;
  }
  level(sn, v) {
    const T = SENSOR_TYPES[sn.type], A = T.alarm, W = T.warn;
    if (A && ((A.hi != null && v > A.hi) || (A.lo != null && v < A.lo && !(T.metric === 'force' && v === 0)))) return 'alarm';
    if (W && ((W.hi != null && v > W.hi) || (W.lo != null && v < W.lo && !(T.metric === 'force' && v === 0)))) return 'warn';
    return 'ok';
  }

  tick(dt) {
    if (dt <= 0) return;
    for (const g of this.gateways) this.stepClock(g.clock, dt);
    for (const e of this.edges) {
      this.stepClock(e.clock, dt);
      for (const sn of e.sensors) {
        sn.next -= dt; if (sn.next > 0) continue;
        sn.next += sn.rate;
        const r = this.value(sn), lat = LAT.sensor[sn.iface] ?? 0.005;
        // 타임스탬프: 엣지 PTP 시계(기준 시계 + 잔차) · LoRaWAN은 게이트웨이 수신 시각(NTP · 공중 전송 시간만큼 불확실)
        const lora = sn.iface === 'LoRaWAN', err = lora ? this.g() * 3000 + 600 : e.clock.err + e.gw.clock.err;   // 엣지(OC) 잔차 + 게이트웨이(BC) 잔차 = 기준 시계 대비 오차
        const rd = { s: sn.id, m: sn.metric, v: r.v, u: sn.unit, ts: this.us() + Math.round(err), e: r2(err, 2), ...(r.f ? { f: r.f } : {}) };
        for (const [k] of Object.entries(SENSOR_TYPES[sn.type].extra ?? {})) if (r[k] != null) rd[k] = r[k];
        if (r.rh != null) rd.rh = r2(r.rh, 1); if (r.kwh != null) rd.kwh = r2(r.kwh, 4); if (r.bar != null) rd.bar = r.bar; if (r.vline != null) rd.v_line = r.vline;
        e.buf.push(rd); this.stats.readings++;
        const lv = this.level(sn, r.v);
        this.latest.set(sn.id, { v: r.v, t: this.sim.time, lv, r: rd });
        const H = this.hist.get(sn.id) ?? []; H.push(r.v); if (H.length > 60) H.shift(); this.hist.set(sn.id, H);
        if (lv !== 'ok' && sn.lv === 'ok') this.alarms.unshift({ t: this.sim.time, sensor: sn.id, label: sn.label, where: sn.where, level: lv, v: r.v, unit: sn.unit }), this.alarms.length > 100 && this.alarms.pop();
        sn.lv = lv; this.stats.lat.sensor += lat;
      }
      e.t += dt; if (e.t < EDGE_FLUSH || !e.buf.length) continue;
      e.t = 0; this.flush(e);
    }
  }
  // 셀 엣지 묶음 → 게이트웨이 → 존 서버 → 공장 중앙 (계층별 기준 시계 시각)
  flush(e) {
    const L = this.stats.lat, j = () => 1 + Math.abs(this.g()) * 0.3, t0 = this.us();
    const hops = { edge: t0, gateway: t0 + Math.round(LAT.gw * j() * 1e6), zone: 0, central: 0, ingest: 0 };
    hops.zone = hops.gateway + Math.round(LAT.zone * j() * 1e6); hops.central = hops.zone + Math.round(LAT.central * j() * 1e6); hops.ingest = hops.central + Math.round(LAT.ingest * j() * 1e6);
    L.gw += (hops.gateway - hops.edge) / 1e6; L.zone += (hops.zone - hops.gateway) / 1e6; L.central += (hops.central - hops.zone) / 1e6; L.ingest += (hops.ingest - hops.central) / 1e6; L.n++;
    const g = this.gateways.find((x) => x.id === e.gateway), Z = this.zoneSrv[e.zone];
    const batch = { spec: 'metafactory/sensor-batch/1.0', run: this.run ?? null, zone: e.zone, cell: e.cell, edge: e.id, gateway: e.gateway, zoneServer: Z.id, seq: ++this.seq, clock: { reference: 'PTP IEEE 1588-2019 (공장 중앙 Grandmaster)', edgeErrUs: r2(e.clock.err, 3), gatewayErrUs: r2(g.clock.err, 3) }, hops, readings: e.buf };
    e.buf = []; this.stats.batches++;
    if (!this.publish) return batch;
    if (!this.births.has(e.id)) { this.births.add(e.id); this.birthQ.push({ topic: `${SENSOR_TOPIC(e.zone, e.cell)}/birth`, retain: true, payload: JSON.stringify({ spec: 'metafactory/sensor-birth/1.0', edge: e.id, gateway: e.gateway, zone: e.zone, zoneServer: Z.id, cell: e.cell, cellName: e.cellName, ip: e.ip.join('.'), sensors: e.sensors.map((q) => ({ id: q.id, type: q.type, cat: q.cat, label: q.label, metric: q.metric, unit: q.unit, iface: q.iface, rate: q.rate, x: r2(q.x, 2), z: r2(q.z, 2), where: q.where, spec: SENSOR_TYPES[q.type].spec, warn: SENSOR_TYPES[q.type].warn ?? null, alarm: SENSOR_TYPES[q.type].alarm ?? null })) }), src: Z }); }
    const payload = JSON.stringify(batch); this.stats.bytes += payload.length;
    this.outbox.push({ topic: SENSOR_TOPIC(e.zone, e.cell), payload, retain: false, src: Z, tMs: hops.central / 1000 });
    if (this.outbox.length > 4000) { this.stats.dropped += this.outbox.length - 4000; this.outbox.splice(0, this.outbox.length - 4000); }
    return batch;
  }
  take(n = 400) { return [...this.birthQ.splice(0), ...this.outbox.splice(0, n)]; }
  pending() { return this.birthQ.length + this.outbox.length; }
  // 제품 계보용: 그 셀 센서의 지금 값 (trace.js enter — 같은 기준 시계에서 제품 단계와 센서 값을 묶는다)
  cellSnapshot(cellId) { const out = {}; for (const sn of this.sensors) if (sn.cell === cellId && sn.zone === 'main') { const L = this.latest.get(sn.id); if (L) out[sn.metric] = L.v; } return out; }
  summary() {
    const lv = { ok: 0, warn: 0, alarm: 0 }; for (const sn of this.sensors) lv[sn.lv ?? 'ok']++;
    const L = this.stats.lat, n = Math.max(1, L.n), maxErr = Math.max(...this.edges.map((e) => Math.abs(e.clock.err)), ...this.gateways.map((g) => Math.abs(g.clock.err)));
    return { sensors: this.sensors.length, edges: this.edges.length, gateways: this.gateways.length, zones: Object.keys(this.zoneSrv).length, lv, maxErrUs: maxErr, lat: { gw: L.gw / n, zone: L.zone / n, central: L.central / n, ingest: L.ingest / n } };
  }
}
export { ZLABEL as SENSOR_ZONE_LABEL };
