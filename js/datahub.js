// 데이터 허브 — 공장 운영 데이터를 하나의 기준 시계로 동기화해 수집하고,
// AAS 모델로 정의한 값을 OPC UA PubSub(Part 14, JSON 인코딩) NetworkMessage로 만들어 MQTT로 보내며,
// 수집 데이터를 JSON(AAS) · XML(AAS) · RDF(Turtle) · CSV · AutomationML로 저장한다.
import { ST_LABEL } from './sim.js';
import { ROBOT_KINDS, STATION_TYPES, ZONE_MIXES, isZone } from './line.js';
import { buildEnvironment, buildRobotEnvironment, detailCSV, toXML, toTurtle, toCSV, toAutomationML, aasId, smId, SEM, AAS_RECENT } from './aas.js';
import { buildAASX } from './aasx.js';

const DEG = 180 / Math.PI;
export const PUBLISHER_ID = 'jin3d';
export const WRITER_GROUP = 'MetaFactory';
const BUILTIN = { double: 11, int: 6, string: 12, boolean: 1, dateTime: 13 };   // OPC UA Built-in Type Id
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const f = (idShort, label, type, unit, get) => ({ idShort, label, type, unit, get });

// ── 자산 정의 (AAS 단위) ─────────────────
function buildAssets(sim, view) {
  const assets = [];
  const year = String(new Date().getFullYear());
  const plate = (id, product) => ({ manufacturer: 'Jin-3D 가상 자산 (시뮬레이션)', product, serial: `J3D-${id}`, year });
  const k = () => sim.kpi();
  assets.push({
    id: 'MetaFactory', kind: 'Factory', name: sim.line.name, nameplate: plate('MetaFactory', '메타팩토리 테스트베드 라인'),
    tech: { LineName: sim.line.name, Layout: sim.line.layout, ...(isZone(sim.line) ? { ProductMix: ZONE_MIXES[sim.line.mix]?.label ?? '' } : {}), Stations: sim.processing.length },
    fields: [
      f('OperationMode', '운영 단계', 'string', null, () => sim.mode.label),
      f('UnitsPerHour', '시간당 생산량', 'double', 'UPH', () => k().uphRecent),
      f('OEE', '설비종합효율', 'double', '%', () => k().OEE * 100),
      f('Availability', '가용률', 'double', '%', () => k().A * 100),
      f('Performance', '성능', 'double', '%', () => k().P * 100),
      f('Quality', '품질', 'double', '%', () => k().Q * 100),
      f('GoodParts', '양품 누적', 'int', 'pcs', () => sim.stats.good),
      f('GoodDoorTrim', '양품 도어트림', 'int', 'pcs', () => sim.stats.goodBy?.doortrim ?? 0),
      f('GoodEAxle', '양품 e-axle', 'int', 'pcs', () => sim.stats.goodBy?.eaxle ?? 0),
      f('RejectedParts', '불량 배출', 'int', 'pcs', () => sim.stats.rejected),
      f('EscapedPPM', '불량 유출', 'double', 'ppm', () => k().ppm),
      f('WorkInProcess', '재공', 'int', 'pcs', () => sim.wip()),
      f('PowerKW', '전력', 'double', 'kW', () => sim.powerKW),
      f('EnergyKWh', '누적 에너지', 'double', 'kWh', () => sim.stats.energy),
      f('RawMaterialStock', '자재 재고', 'int', 'pcs', () => sim.rawStock),
      f('FinishedGoodsStock', '완제품 적재', 'int', 'pcs', () => sim.fgStock),
      f('FinishedDoorTrim', '구분 적재 도어트림', 'int', 'pcs', () => sim.fgBy?.doortrim ?? 0),
      f('FinishedEAxle', '구분 적재 e-axle', 'int', 'pcs', () => sim.fgBy?.eaxle ?? 0),
      f('ReleaseInterval', '투입 간격', 'double', 's', () => sim.releaseInterval),
      f('PeopleOnSite', '현장 인원', 'int', 'persons', () => sim.peopleOnSite()),
    ],
  });
  for (const st of sim.processing) {
    const d = st.def, T = STATION_TYPES[st.type];
    assets.push({
      id: st.id, kind: 'Station', name: st.name, nameplate: plate(st.id, `${T.label} 셀`),
      tech: { StationType: T.label, Robot: d.robot.count ? `${ROBOT_KINDS[d.robot.kind].label} ${d.robot.count}대` : '없음', BaseCycleTime: d.baseCycle, Task: d.task, ...(d.product ? { ProductLine: d.product } : {}) },
      fields: [
        f('State', '상태', 'string', null, () => st.state),
        f('StateText', '상태(한글)', 'string', null, () => ST_LABEL[st.state] ?? st.state),
        f('Health', '건강도', 'double', '%', () => st.health),
        f('RemainingUsefulLife', '잔여수명', 'double', 'min', () => sim.assess(st).rul),
        f('FailureRisk10min', '10분 고장확률', 'double', '%', () => sim.assess(st).risk10 * 100),
        f('ProcessCapability', '공정능력 Cpk', 'double', null, () => sim.assess(st).cpk),
        f('Utilization', '가동률', 'double', '%', () => sim.assess(st).util * 100),
        f('CycleTime', '사이클', 'double', 's', () => d.cycle * sim.mode.cycleMul * st.speedMul),
        f('Processed', '처리 누적', 'int', 'pcs', () => st.c.processed),
        f('Defects', '불량 누적', 'int', 'pcs', () => st.c.defects),
        f('Failures', '고장 누적', 'int', 'count', () => st.c.fails),
        f('QueueLength', '대기열', 'int', 'pcs', () => sim.queueLen(st)),
        f('PartsStock', '부품 재고', 'int', 'pcs', () => st.parts ?? null),
        f('PowerKW', '전력', 'double', 'kW', () => (st.state === 'BUSY' ? d.busyKW : st.state === 'DOWN' || st.state === 'MAINT' ? d.idleKW * 0.5 : st.powerSave ? d.idleKW * 0.3 : d.idleKW)),
      ],
    });
    // 셀 로봇 (레거시 단계는 사람이 대신 작업하므로 제외)
    const sv = view?.stationViews.find((s) => s.st === st);
    if (sim.mode.key === 'traditional' || !sv?.parts.robots?.length) continue;
    sv.parts.robots.forEach((r, i) => {
      const id = `${st.id}_R${i + 1}`;
      const fields = [f('State', '상태', 'string', null, () => (st.state === 'BUSY' ? 'Operating' : st.state === 'DOWN' || st.state === 'MAINT' ? 'Stopped' : 'Idle'))];
      r.jointDefs.forEach((jd, j) => fields.push(f(`Joint${j + 1}`, jd.name, 'double', jd.unit === 'deg' ? 'deg' : 'mm', () => r.joints()[j] * (jd.unit === 'deg' ? DEG : 1000))));
      const tcp = () => { const w = r.tip.getWorldPosition(r.tip.position.clone()), b = r.root.getWorldPosition(r.root.position.clone()); return { x: (w.x - b.x) * 1000, y: -(w.z - b.z) * 1000, z: (w.y - b.y) * 1000 }; };
      fields.push(f('TcpX', 'TCP X', 'double', 'mm', () => tcp().x), f('TcpY', 'TCP Y', 'double', 'mm', () => tcp().y), f('TcpZ', 'TCP Z', 'double', 'mm', () => tcp().z));
      assets.push({ id, kind: 'CellRobot', parent: st.id, name: `${st.name} ${ROBOT_KINDS[r.kind].label} #${i + 1}`, nameplate: plate(id, ROBOT_KINDS[r.kind].label), tech: { RobotType: ROBOT_KINDS[r.kind].label, Axes: r.jointDefs.length, Payload: r.payload, Cell: st.id }, fields });
    });
  }
  // 이동 로봇 AAS id: 영문 ID(AMR-01·AGV-1)는 그대로, 한글 이름은 역할 접두어 + 번호 (HUM_MNT_1 등)
  const count = {};
  const mobile = (m, kind, label, prefix, extra = []) => {
    count[prefix] = (count[prefix] ?? 0) + 1;
    const assetIdStr = /^[A-Za-z0-9-]+$/.test(m.id) ? m.id.replace(/-/g, '_') : `${prefix}_${count[prefix]}`;
    assets.push({
      id: assetIdStr, kind, mover: m, name: `${m.id} (${label})`, nameplate: plate(assetIdStr, label), tech: { RobotType: label, DisplayName: m.id },
      fields: [
        f('PositionX', '위치 X', 'double', 'm', () => m.x), f('PositionZ', '위치 Z', 'double', 'm', () => m.z),
        f('Heading', '방위', 'double', 'deg', () => ((m.heading * DEG) % 360 + 360) % 360),
        f('Speed', '주행 속도', 'double', 'm/s', () => m._speed ?? 0),
        f('Task', '작업', 'string', null, () => m.task ?? 'Idle'),
        f('Blocked', '진로 대기', 'boolean', null, () => !!m.blockedOn),
        ...extra,
      ],
    });
  };
  for (const v of sim.vehicles) mobile(v, v.kind === 'agv' ? 'AGV' : 'Forklift', v.kind === 'agv' ? 'AGV' : '지게차', v.kind === 'agv' ? 'AGV' : 'FL',
    v.kind === 'agv' ? [f('Battery', '배터리', 'double', '%', () => v.battery), f('LoadCount', '적재 수량', 'int', 'pcs', () => v.load?.n ?? 0)] : []);
  for (const c of sim.carriers) mobile(c, 'AMR', '운반 AMR', 'AMR', [
    f('OperationState', '운행 상태', 'string', null, () => c.state),
    f('LineSegment', '라인 구간', 'string', null, () => (c.state === 'line' && c.lineInfo ? (c.lineInfo.where === 'cell' ? `cell:${c.lineInfo.station}` : `path:${c.lineInfo.from}>${c.lineInfo.to}`) : '')),
    f('LinePhase', '구간 상태', 'string', null, () => (c.state === 'line' ? c.lineInfo?.phase ?? '' : '')),
    f('Payload', '탑재물', 'string', null, () => { const it = sim.itemOfCarrier(c); return it ? (it.scrap ? 'empty(reject)' : `${it.product ?? 'part'}#${it.id}`) : 'empty'; }),
  ]);
  for (const t of sim.techs) if (t.kind !== 'human') mobile(t, t.kind === 'humanoid' ? 'Humanoid' : 'MaintenanceRobot', t.kind === 'humanoid' ? '휴머노이드 (정비)' : '정비로봇', t.kind === 'humanoid' ? 'HUM_MNT' : 'MBOT');
  for (const h of sim.helpers) mobile(h, 'Humanoid', '휴머노이드 (부품 보충)', 'HUM_SUP', [f('CarryingBin', '부품 빈 운반', 'boolean', null, () => !!h.carry)]);
  for (const q of sim.quads) mobile(q, 'Quadruped', '사족보행 순찰', 'QUAD', [f('InspectionTarget', '점검 대상', 'string', null, () => q.scanning?.id ?? '')]);
  return assets;
}

export class DataHub {
  constructor() {
    this.interval = 10;         // 수집 주기 (시뮬레이션 초)
    this.maxTicks = 6000;       // 보관 수집 회차 (기본 10초 × 6000 = 16시간 40분)
    this.publishOn = true;
    this.shared = !!globalThis.window?.JIN3D_SHARED;   // 서버 없는 공유 페이지: 수집만 하고 발행·저장은 하지 않는다
    this.mqtt = { available: this.shared ? false : null, status: null, sent: 0, failed: 0, lastError: null };
    this.queue = []; this.flushT = 0; this.lastMsg = null;
  }

  // 시뮬레이션 시작·재시작 시: 기준 시계와 자산 목록을 새로 만든다
  reset(sim, view) {
    this.sim = sim; this.view = view;
    const base = new Date(); base.setHours(8, 0, 0, 0);          // 화면 시계(08:00 시작)와 같은 기준
    this.epochMs = base.getTime();
    this.runId = `run-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
    this.assets = buildAssets(sim, view);
    this.writerIds = new Map(this.assets.map((a, i) => [a.id, i + 1]));
    this.samples = []; this.events = []; this.lastLogId = sim.logSeq; this.lastT = -Infinity; this.seq = 0;
    this.prevPos = new Map(); this.last = null;
    this.queue = [];
    this.enqueueMetadata();
  }

  // 기준 시계: 시뮬레이션 시각 → ISO 8601 UTC. 모든 레코드·이벤트·메시지가 이 하나의 시계를 쓴다.
  iso(simT = this.sim.time) { return new Date(this.epochMs + simT * 1000).toISOString(); }

  tick(rdt) {
    const sim = this.sim; if (!sim) return;
    // 운영 로그 → 이벤트 (발생 시각 그대로)
    if (sim.logSeq > this.lastLogId) {
      for (const l of sim.logs.filter((x) => x.id > this.lastLogId).reverse()) {
        const ev = { t: this.iso(l.t), simT: l.t, source: 'MetaFactory', level: l.level, title: l.title, text: [l.obs, l.dec, l.act].filter(Boolean).join(' / ') };
        this.events.push(ev);
        if (this.publishOn) this.enqueueEvent(ev);
      }
      this.lastLogId = sim.logSeq;
      if (this.events.length > 20000) this.events.splice(0, this.events.length - 20000);
    }
    if (sim.time - this.lastT >= this.interval) this.sample();
    this.flushT += rdt;
    if (this.flushT > 0.8) { this.flushT = 0; this.flush(); }
  }

  sample() {
    const sim = this.sim, t = this.iso(), dt = Number.isFinite(this.lastT) ? sim.time - this.lastT : 0;
    this.lastT = sim.time;
    const v = {};
    for (const a of this.assets) {
      if (a.mover) {   // 주행 속도 = 직전 수집 이후 이동 거리 / 경과 시간
        const p = this.prevPos.get(a.id);
        a.mover._speed = p && dt > 0 ? Math.hypot(a.mover.x - p.x, a.mover.z - p.z) / dt : 0;
        this.prevPos.set(a.id, { x: a.mover.x, z: a.mover.z });
      }
      v[a.id] = a.fields.map((fl) => { try { return fl.get(); } catch { return null; } });
    }
    const s = { t, simT: sim.time, v };
    this.samples.push(s); this.last = { t, ...v };
    if (this.samples.length > this.maxTicks) this.samples.shift();
    if (this.publishOn) this.enqueueData(s);
  }

  // ── OPC UA PubSub (Part 14) JSON NetworkMessage ─────────────────
  topic(kind, writer) { return `opcua/json/${kind}/${PUBLISHER_ID}/${WRITER_GROUP}/${writer}`; }
  enqueueData(s) {
    for (const a of this.assets) {
      const payload = {};
      a.fields.forEach((fl, i) => {
        const val = s.v[a.id][i];
        payload[fl.idShort] = { Value: typeof val === 'number' ? Math.round(val * 1000) / 1000 : val, SourceTimestamp: s.t };
      });
      const msg = {
        MessageId: uuid(), MessageType: 'ua-data', PublisherId: PUBLISHER_ID, WriterGroupName: WRITER_GROUP,
        Messages: [{
          DataSetWriterId: this.writerIds.get(a.id), DataSetWriterName: a.id, SequenceNumber: ++this.seq,
          MetaDataVersion: { MajorVersion: 1, MinorVersion: 0 }, Timestamp: s.t, MessageType: 'ua-keyframe', Payload: payload,
        }],
      };
      this.lastMsg = { topic: this.topic('data', a.id), msg };
      this.queue.push({ topic: this.topic('data', a.id), payload: JSON.stringify(msg) });
    }
  }
  enqueueEvent(ev) {
    const msg = {
      MessageId: uuid(), MessageType: 'ua-data', PublisherId: PUBLISHER_ID, WriterGroupName: WRITER_GROUP,
      Messages: [{
        DataSetWriterId: 0, DataSetWriterName: 'Events', SequenceNumber: ++this.seq, Timestamp: ev.t, MessageType: 'ua-event',
        Payload: { EventId: uuid(), EventType: `ns=1;s=Jin3D.${ev.level}`, SourceName: ev.source, Time: ev.t, Severity: { alert: 800, warn: 600, plan: 400, act: 300, ok: 200, info: 100, llm: 300, chat: 100 }[ev.level] ?? 100, Message: { Text: `${ev.title}${ev.text ? ' — ' + ev.text : ''}`, Locale: 'ko-KR' } },
      }],
    };
    this.queue.push({ topic: this.topic('data', 'Events'), payload: JSON.stringify(msg) });
  }
  // DataSetMetaData (retain): 필드 이름·타입·단위와 AAS 의미 정보(semanticId·서브모델 id·idShort 경로)
  enqueueMetadata() {
    for (const a of this.assets) {
      const msg = {
        MessageId: uuid(), MessageType: 'ua-metadata', PublisherId: PUBLISHER_ID, DataSetWriterId: this.writerIds.get(a.id),
        MetaData: {
          Name: a.id, Description: { Text: a.name, Locale: 'ko-KR' },
          Fields: a.fields.map((fl) => ({
            Name: fl.idShort, Description: { Text: fl.label, Locale: 'ko-KR' }, BuiltInType: BUILTIN[fl.type], DataType: { Id: BUILTIN[fl.type] }, ValueRank: -1,
            Properties: [
              { Key: { Name: 'AAS.AasId' }, Value: aasId(a.id) },
              { Key: { Name: 'AAS.SubmodelId' }, Value: smId(a.id, 'OperationalData') },
              { Key: { Name: 'AAS.IdShortPath' }, Value: fl.idShort },
              { Key: { Name: 'AAS.SemanticId' }, Value: SEM.cd(fl.idShort) },
              ...(fl.unit ? [{ Key: { Name: 'EngineeringUnits' }, Value: fl.unit }] : []),
            ],
          })),
          ConfigurationVersion: { MajorVersion: 1, MinorVersion: 0 },
        },
      };
      this.queue.push({ topic: this.topic('metadata', a.id), payload: JSON.stringify(msg), retain: true });
    }
    // AAS 셸·서브모델 구조(현재 값, 시계열 제외)도 retain으로 함께 둔다
    this.queue.push({ topic: `aas/${PUBLISHER_ID}/environment`, payload: JSON.stringify(buildEnvironment(this.assets, [], null)), retain: true });
  }

  async flush() {
    if (!this.queue.length) return;
    if (this.mqtt.available === false || this.flushing) { if (this.mqtt.available === false) this.queue = []; return; }
    const batch = this.queue.splice(0, 2000);
    this.flushing = true;
    try {
      const res = await fetch('/api/mqtt/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: batch }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      this.mqtt.available = !!out.status?.listening; this.mqtt.status = out.status; this.mqtt.sent += out.published;
      if (!out.status?.listening) this.queue = [];
    } catch (e) {
      this.mqtt.failed += batch.length; this.mqtt.lastError = e.message;
      this.mqtt.available = false;   // 서버 없는 환경(정적 공유 등): 수집·저장만 한다
    } finally { this.flushing = false; }
  }
  async refreshStatus() {
    if (this.shared) return this.mqtt;
    try { const r = await fetch('/api/mqtt/status'); this.mqtt.status = await r.json(); this.mqtt.available = !!this.mqtt.status.listening; }
    catch { this.mqtt.available = false; }
    return this.mqtt;
  }

  // ── 저장 ─────────────────
  fileBase() { return `jin3d_${this.runId}`; }
  build(format) {
    const base = this.fileBase();
    const env = () => buildEnvironment(this.assets, this.samples, this.last, { recent: AAS_RECENT, csvName: `${base}.csv` });
    switch (format) {
      case 'json': return { name: `${base}.aas.json`, type: 'application/json', data: JSON.stringify({ ...env(), $meta: this.meta() }, null, 1) };
      case 'xml': return { name: `${base}.aas.xml`, type: 'application/xml', data: toXML(env()) };
      case 'rdf': return { name: `${base}.aas.ttl`, type: 'text/turtle', data: toTurtle(env()) };
      case 'csv': return { name: `${base}.csv`, type: 'text/csv', data: toCSV(this.assets, this.samples, this.events, this.runId) };
      case 'aml': return { name: `${base}.aml`, type: 'application/automationml-aml+xml', data: toAutomationML(this.assets, this.last, { fileName: `${base}.aml`, csvName: `${base}.csv`, runId: this.runId, writtenAt: new Date().toISOString() }) };
    }
    return null;
  }
  meta() {
    return { generator: 'Jin-3D', runId: this.runId, referenceClock: { epochUtc: this.iso(0), description: '시뮬레이션 시각 0초 = 기준 시각. 모든 타임스탬프는 이 기준 시계 기반 ISO 8601 UTC' },
      samplingIntervalS: this.interval, samples: this.samples.length, events: this.events.length, mode: this.sim.mode.label, line: this.sim.line.name };
  }
  download(format) {
    const out = this.build(format); if (!out) return null;
    const blob = new Blob([out.data], { type: out.type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = out.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { name: out.name, bytes: blob.size };
  }
  // ── 로봇 한 대의 누적 데이터 → AAS 파일 (AASX 패키지 / JSON / XML / RDF) ─────────────────
  robotAsset(tele) {
    const ref = tele.ref;
    const a = ref.type === 'cell' ? this.assets.find((x) => x.id === tele.key()) : this.assets.find((x) => x.mover?.id === ref.id);
    if (a) return a;
    const id = tele.key().replace(/[^A-Za-z0-9_]/g, '') || 'Robot';
    return { id, kind: 'Robot', name: tele.key(), nameplate: { manufacturer: 'Jin-3D 가상 자산 (시뮬레이션)', product: '로봇', serial: `J3D-${id}`, year: String(new Date().getFullYear()) }, tech: {}, fields: [] };
  }
  robotCounts(tele) {
    if (!tele) return null;
    const a = this.robotAsset(tele);
    return { op: this.samples.filter((s) => s.v[a.id]).length, detail: tele.log().rows.length, assetId: a.id, interval: this.interval };
  }
  exportRobot(tele, format) {
    const a = this.robotAsset(tele), L = tele.log();
    const detail = L.fields ? { fields: L.fields, rows: L.rows.map((r) => ({ t: this.iso(r.simT), simT: r.simT, v: r.v })) } : null;
    const base = `jin3d_${a.id}_${this.runId}`;
    const csvPath = `/aasx/${a.id}/files/${a.id}_telemetry.csv`;
    const env = buildRobotEnvironment({ asset: a, samples: this.samples, detail, last: this.last, opts: { fileRef: format === 'aasx' && detail ? csvPath : null } });
    const out = format === 'aasx'
      ? { name: `${base}.aasx`, type: 'application/asset-administration-shell-package', data: buildAASX(a.id, toXML(env), detail ? [{ path: csvPath, data: detailCSV(a.id, detail), contentType: 'text/csv' }] : []) }
      : format === 'json' ? { name: `${base}.aas.json`, type: 'application/json', data: JSON.stringify(env, null, 1) }
      : format === 'xml' ? { name: `${base}.aas.xml`, type: 'application/xml', data: toXML(env) }
      : { name: `${base}.aas.ttl`, type: 'text/turtle', data: toTurtle(env) };
    return out;
  }
  downloadRobot(tele, format) {
    const out = this.exportRobot(tele, format);
    const blob = new Blob([out.data], { type: out.type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = out.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { name: out.name, bytes: blob.size };
  }

  stats() {
    const fields = this.assets.reduce((n, a) => n + a.fields.length, 0);
    return { assets: this.assets.length, fields, samples: this.samples.length, points: this.samples.length * fields, events: this.events.length,
      from: this.samples[0]?.t, to: this.samples[this.samples.length - 1]?.t };
  }
}
