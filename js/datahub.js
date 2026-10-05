// 데이터 허브 — 공장 운영 데이터를 하나의 기준 시계로 동기화해 수집하고,
// AAS 모델로 정의한 값을 OPC UA PubSub(Part 14, JSON 인코딩) NetworkMessage로 만들어 MQTT로 보내며,
// 수집 데이터를 JSON(AAS) · XML(AAS) · RDF(Turtle) · CSV · AutomationML로 저장한다.
import { COMMANDS, CMD_STATE } from './commands.js';
import { ST_LABEL } from './sim.js';
import { ROBOT_KINDS, STATION_TYPES, ZONE_MIXES, isZone } from './line.js';
import { buildEnvironment, buildRobotEnvironment, detailCSV, toXML, toTurtle, toCSV, toAutomationML, aasId, smId, SEM, AAS_RECENT, addVideos, videoLinkFiles } from './aas.js';
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
      tech: { EquipmentId: st.uid ?? st.id, StationType: T.label, Robot: d.robot.count ? `${ROBOT_KINDS[d.robot.kind].label} ${d.robot.count}대` : '없음', BaseCycleTime: d.baseCycle, Task: d.task, ...(d.product ? { ProductLine: d.product } : {}) },
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
        ...(d.type === 'sort' || d.type === 'pack' ? [f('GateDecision', '게이트 판별 결정', 'string', null, () => (st.item && st.gate?.id === st.item.id ? st.gate.text : '')), f('GateProduct', '게이트 판별 제품', 'string', null, () => (st.item && st.gate?.id === st.item.id ? st.gate.product ?? '' : ''))] : []),
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
      if (st.vlaCell) fields.push(f('VlaModelVersion', 'VLA 추론 모델', 'string', null, () => sim.vla?.versionOf(st.robotUids?.[i]) ?? ''));
      if (r.kind === 'ammr') fields.push(   // AMMR 이동 플랫폼·선반 부품 왕복
        f('HoldingPart', '부품 파지', 'bool', null, () => !!st.ammr?.[i]?.carry),
        f('PlatformPhase', '이동 플랫폼 상태', 'string', null, () => st.ammr?.[i]?.phase ?? ''),
        f('RackTrips', '부품 선반 왕복', 'int', 'count', () => st.ammr?.[i]?.trips ?? 0),
        f('Battery', '배터리', 'double', '%', () => st.ammr?.[i]?.battery ?? null));
      if (r.tip2) {   // 양팔 로봇(AMMR)의 오른팔 TCP
        const tcp2 = () => { const w = r.tip2.getWorldPosition(r.tip2.position.clone()), b = r.root.getWorldPosition(r.root.position.clone()); return { x: (w.x - b.x) * 1000, y: -(w.z - b.z) * 1000, z: (w.y - b.y) * 1000 }; };
        fields.push(f('Tcp2X', '오른팔 TCP X', 'double', 'mm', () => tcp2().x), f('Tcp2Y', '오른팔 TCP Y', 'double', 'mm', () => tcp2().y), f('Tcp2Z', '오른팔 TCP Z', 'double', 'mm', () => tcp2().z));
      }
      assets.push({ id, kind: 'CellRobot', parent: st.id, name: `${st.name} ${ROBOT_KINDS[r.kind].label} #${i + 1}`, nameplate: plate(id, ROBOT_KINDS[r.kind].label), tech: { EquipmentId: st.robotUids?.[i] ?? id, RobotType: ROBOT_KINDS[r.kind].label, Axes: r.jointDefs.length, Payload: r.payload, Cell: st.id }, fields });
    });
  }
  // 이동 로봇 AAS id: 영문 ID(AMR-01·AGV-1)는 그대로, 한글 이름은 역할 접두어 + 번호 (HUM_MNT_1 등)
  const count = {};
  const mobile = (m, kind, label, prefix, extra = []) => {
    count[prefix] = (count[prefix] ?? 0) + 1;
    const assetIdStr = /^[A-Za-z0-9-]+$/.test(m.id) ? m.id.replace(/-/g, '_') : `${prefix}_${count[prefix]}`;
    assets.push({
      id: assetIdStr, kind, mover: m, name: `${m.id} (${label})`, nameplate: plate(assetIdStr, label), tech: { EquipmentId: m.uid ?? m.id, RobotType: label, DisplayName: m.id },
      fields: [
        f('PositionX', '위치 X', 'double', 'm', () => m.x), f('PositionZ', '위치 Z', 'double', 'm', () => m.z),
        f('Heading', '방위', 'double', 'deg', () => ((m.heading * DEG) % 360 + 360) % 360),
        f('Speed', '주행 속도', 'double', 'm/s', () => m._speed ?? 0),
        f('Task', '작업', 'string', null, () => m.task ?? 'Idle'),
        f('Blocked', '진로 대기', 'boolean', null, () => !!m.blockedOn),
        ...(m.battery != null && !extra.some((x) => x.idShort === 'Battery') ? [f('Battery', '배터리', 'double', '%', () => m.battery)] : []),
        ...(sim.net?.ueOf(m) ? [f('ServingPCI', '5G 서빙 셀 PCI', 'int', null, () => sim.net.ueOf(m)?.servCell?.pci ?? null), f('RSRP', '5G RSRP', 'double', 'dBm', () => sim.net.ueOf(m)?.rsrp ?? null), f('Handovers', '5G 핸드오버', 'int', 'count', () => sim.net.ueOf(m)?.hoN ?? 0)] : []),
        ...extra,
      ],
    });
  };
  for (const v of [...sim.vehicles, ...(sim.forklifts ?? [])]) mobile(v, v.kind === 'agv' ? 'AGV' : 'Forklift', v.kind === 'agv' ? 'AGV' : '지게차', v.kind === 'agv' ? 'AGV' : 'FL',
    v.kind === 'agv' ? [f('Battery', '배터리', 'double', '%', () => v.battery), f('LoadCount', '적재 수량', 'int', 'pcs', () => v.load?.n ?? 0)] : []);
  for (const d of sim.drones ?? []) mobile(d, 'Drone', '순찰 드론', 'DRN', [f('Altitude', '비행 고도', 'double', 'm', () => d.y), f('Battery', '배터리', 'double', '%', () => d.battery), f('FlightMode', '비행 모드', 'string', null, () => d.mode)]);
  for (const c of sim.carriers) mobile(c, 'AMR', '운반 AMR', 'AMR', [
    f('OperationState', '운행 상태', 'string', null, () => c.state),
    f('LineSegment', '라인 구간', 'string', null, () => (c.state === 'line' && c.lineInfo ? (c.lineInfo.where === 'cell' ? `cell:${c.lineInfo.station}` : `path:${c.lineInfo.from}>${c.lineInfo.to}`) : '')),
    f('LinePhase', '구간 상태', 'string', null, () => (c.state === 'line' ? c.lineInfo?.phase ?? '' : '')),
    f('Payload', '탑재물', 'string', null, () => { const it = sim.itemOfCarrier(c); return it ? (it.scrap ? 'empty(reject)' : `${it.product ?? 'part'}#${it.id}`) : 'empty'; }),
  ]);
  for (const t of sim.techs) if (t.kind !== 'human') mobile(t, t.kind === 'humanoid' ? 'Humanoid' : 'MaintenanceRobot', t.kind === 'humanoid' ? '휴머노이드 (정비)' : '정비로봇', t.kind === 'humanoid' ? 'HUM_MNT' : 'MBOT');
  for (const h of sim.helpers) mobile(h, 'Humanoid', '휴머노이드 (부품 보충)', 'HUM_SUP', [f('CarryingBin', '부품 빈 운반', 'boolean', null, () => !!h.carry)]);
  for (const q of sim.quads) mobile(q, 'Quadruped', '사족보행 순찰', 'QUAD', [f('InspectionTarget', '점검 대상', 'string', null, () => q.scanning?.id ?? ''), f('Battery', '배터리', 'double', '%', () => q.battery)]);
  // Private 5G 기지국 (gNB): PCI · 접속 단말 · 업링크 수신 · 핸드오버
  if (sim.net?.on) sim.net.plan.cells.forEach((c, i) => {
    const cs = () => sim.net.cellStats[i];
    assets.push({ id: c.id.replace(/-/g, '_'), kind: 'Gnb5G', name: `5G 기지국 ${c.id} (PCI ${c.pci})`, nameplate: plate(c.id, '5G NR 소형 셀 (gNB)'), tech: { EquipmentId: c.id, PCI: c.pci, Band: 'n79 4.75GHz', Bandwidth: '100MHz', TxPower: '24dBm', PositionX: c.x, PositionZ: c.z },
      fields: [f('ConnectedUEs', '접속 단말', 'int', 'count', () => sim.net.ues.filter((u) => u.serv === i).length), f('UplinkMessages', '업링크 수신', 'int', 'count', () => cs().rx), f('UplinkBytes', '업링크 수신량', 'double', 'byte', () => cs().rxB), f('HandoverIn', '핸드오버 들어옴', 'int', 'count', () => cs().hoIn), f('HandoverOut', '핸드오버 나감', 'int', 'count', () => cs().hoOut)] });
  });
  return assets;
}

export class DataHub {
  constructor() {
    this.interval = 10;         // 수집 주기 (시뮬레이션 초)
    this.maxTicks = 6000;       // 보관 수집 회차 (기본 10초 × 6000 = 16시간 40분)
    this.publishOn = true;
    this.shared = !!globalThis.window?.JIN3D_SHARED;   // 아티팩트 공유 페이지: 수집만 하고 발행·저장은 하지 않는다 (내려받기 차단)
    this.noServer = this.shared || !!globalThis.window?.JIN3D_NO_SERVER;   // 정적 웹(GitHub Pages): 발행만 못 하고 저장은 된다
    this.mqtt = { available: this.noServer ? false : null, status: null, sent: 0, failed: 0, lastError: null };
    this.queue = []; this.flushT = 0; this.lastMsg = null;
    this.pcap = null;   // 패킷 덤프 (js/pcap.js) — 켜져 있으면 발행하는 메시지를 MQTT/TCP/IP 패킷으로도 기록
    this.assetPcaps = new Map();   // 개별 캡처 (로봇·설비 정보 창): 자산 id → PacketCapture(only)
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
    this.msgs = 0; this.bytes = 0;   // 생성한 OPC UA·AAS 메시지 누적 건수·바이트 (관제 화면 누적 데이터량)
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
    // 상위 명령 상태 변화 (전송 → 수신 확인 → 실행 → 완료/거부) → 이벤트 + OPC UA 명령 메시지
    if (sim.cmd?.out.length) for (const x of sim.cmd.out.splice(0)) {
      const c = x.c, C = COMMANDS[c.code];
      const rec = { t: this.iso(x.t), simT: x.t, id: c.id, code: c.code, name: sim.cmd.label(c), group: C.group, target: c.target, targetName: sim.cmd.targetName(c.target), arg: c.arg, issuer: c.by, reason: c.why ?? '', state: x.state, note: x.text ?? '' };
      this.events.push({ t: rec.t, simT: x.t, source: rec.targetName, level: C.group === 'emergency' ? 'alert' : 'act', title: `명령 #${c.id} ${rec.name} · ${CMD_STATE[x.state]}`, text: [rec.issuer, rec.reason, rec.note].filter(Boolean).join(' / ') });
      if (this.publishOn) this.enqueueCommand(rec);
    }
    if (sim.time - this.lastT >= this.interval) this.sample();
    this.pcap?.tick(this.epochMs + sim.time * 1000);   // MQTT keep-alive (PINGREQ/PINGRESP)
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
  // 패킷 덤프로 보내기: 자산 메시지는 그 자산(이동 로봇은 5G 단말, 설비는 유선 LAN), 이벤트·명령은 FACOS가 발행
  // 구독: FACOS는 데이터·이벤트·메타데이터·AAS 전부(opcua/json/# · aas/#), 각 자산은 상위 명령 토픽
  tap(a, topic, body, simT, retain = false, ue = null) {
    const caps = [this.pcap, ...this.assetPcaps.values()].filter((P) => P?.on); if (!caps.length) return;
    const cmd = [this.topic('data', 'Commands')], tMs = this.epochMs + simT * 1000;
    const m = a ? { key: a.id, kind: a.mover ? (ue ? '5g' : 'lan') : 'lan', ip: this.ipOf(a), topic, payload: body, tMs, retain, subs: cmd, extraMs: ue && ue.hoUntil >= 0 ? (ue.hoUntil - this.sim.time) * 1000 : 0 }
      : { key: 'FACOS', kind: 'facos', topic, payload: body, tMs };
    for (const P of caps) {
      if (!P.only && !P.clients.has('FACOS')) P.client('FACOS', 'facos', tMs - 50, ['opcua/json/#', 'aas/#']);
      P.publish(m);
    }
  }
  // 개별 캡처 대상: 이동 로봇은 5G 단말, 셀 로봇·설비는 유선 LAN — 상위 명령 토픽을 구독
  assetTarget(a) { return a ? { key: a.id, kind: a.mover ? (this.sim.net?.ueOf(a.mover) ? '5g' : 'lan') : 'lan', ip: this.ipOf(a), subs: [this.topic('data', 'Commands')], label: a.name } : null; }
  // 자산 IP (자산 목록 순서로 고정): 5G 단말 로봇 10.45.0.n · 그 밖(설비·셀·셀 로봇·유인 장비) 10.20.1.n
  ipOf(a) {
    const g5 = (x) => x.mover && this.sim.net?.ueOf(x.mover), list = this.assets.filter((x) => !!g5(x) === !!g5(a)), k = list.indexOf(a) + 1;
    return g5(a) ? [10, 45, (k >> 8) & 0xff, k & 0xff] : [10, 20, 1 + (k >> 8), k & 0xff];
  }
  count(payload) { this.msgs++; this.bytes += payload.length; return payload; }
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
      const body = this.count(JSON.stringify(msg));
      this.queue.push({ topic: this.topic('data', a.id), payload: body });
      // 이동 로봇의 AAS·OPC UA 메시지는 그 로봇의 5G 모뎀 → Private 5G(업링크) → UPF → MQTT 브로커로 간다
      const ue = a.mover ? this.sim.net?.publish(a.mover, body.length + 60) : null;   // + MQTT 고정·가변 헤더·토픽
      this.tap(a, this.topic('data', a.id), body, s.simT, false, ue);
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
    const body = this.count(JSON.stringify(msg));
    this.queue.push({ topic: this.topic('data', 'Events'), payload: body });
    this.tap(null, this.topic('data', 'Events'), body, ev.simT ?? this.sim.time);
  }
  // 상위 명령 메시지: 명령 상태가 바뀔 때마다 한 건 (오케스트레이터 → 셀 컨트롤러 명령과 셀의 ACK·완료 보고)
  enqueueCommand(r) {
    const f = (v) => ({ Value: v, SourceTimestamp: r.t });
    const msg = {
      MessageId: uuid(), MessageType: 'ua-data', PublisherId: PUBLISHER_ID, WriterGroupName: WRITER_GROUP,
      Messages: [{
        DataSetWriterId: 0, DataSetWriterName: 'Commands', SequenceNumber: ++this.seq, Timestamp: r.t, MessageType: 'ua-keyframe',
        Payload: { CommandId: f(r.id), Code: f(r.code), Name: f(r.name), Group: f(r.group), Target: f(r.target), TargetName: f(r.targetName), Argument: f(r.arg), Issuer: f(r.issuer), Reason: f(r.reason), State: f(r.state), Note: f(r.note) },
      }],
    };
    this.lastCmd = { topic: this.topic('data', 'Commands'), msg };
    const body = this.count(JSON.stringify(msg));
    this.queue.push({ topic: this.topic('data', 'Commands'), payload: body });
    this.tap(null, this.topic('data', 'Commands'), body, r.simT ?? this.sim.time);
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
      this.queue.push({ topic: this.topic('metadata', a.id), payload: this.count(JSON.stringify(msg)), retain: true });
    }
    // AAS 셸·서브모델 구조(현재 값, 시계열 제외)도 retain으로 함께 둔다
    this.queue.push({ topic: `aas/${PUBLISHER_ID}/environment`, payload: this.count(JSON.stringify(buildEnvironment(this.assets, [], null))), retain: true });
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
    if (this.noServer) return this.mqtt;
    try { const r = await fetch('/api/mqtt/status'); this.mqtt.status = await r.json(); this.mqtt.available = !!this.mqtt.status.listening; }
    catch { this.mqtt.available = false; }
    return this.mqtt;
  }

  // ── 저장 ─────────────────
  fileBase() { return `jin3d_${this.runId}`; }
  // AAS 자산 → 영상 기록 키 (로봇 카메라 녹화 색인과 같은 키)
  videoKey(a) { return a.mover ? `m:${a.mover.id}` : a.kind === 'CellRobot' ? a.id : a.kind === 'Factory' ? 'cctv' : null; }
  // videosOf(asset) → 그 자산의 영상 파일 링크 목록 (main.js가 녹화기에서 넘겨준다)
  build(format, videosOf = null) {
    const base = this.fileBase();
    const env = () => { const e = buildEnvironment(this.assets, this.samples, this.last, { recent: AAS_RECENT, csvName: `${base}.csv` }); if (videosOf) for (const a of this.assets) addVideos(e, a.id, videosOf(a), a.kind === 'Factory' ? 'CCTV 영상 기록' : '로봇 카메라 영상 기록'); return e; };
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
  download(format, videosOf = null) {
    const out = this.build(format, videosOf); if (!out) return null;
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
  // videos: 이 로봇 카메라가 찍은 영상 파일 링크 — AAS VideoRecordings 서브모델, AASX에는 영상 링크 파일(.url)·목록(JSON)도 함께
  exportRobot(tele, format, videos = []) {
    const a = this.robotAsset(tele), L = tele.log();
    const detail = L.fields ? { fields: L.fields, rows: L.rows.map((r) => ({ t: this.iso(r.simT), simT: r.simT, v: r.v })) } : null;
    const base = `jin3d_${a.id}_${this.runId}`;
    const csvPath = `/aasx/${a.id}/files/${a.id}_telemetry.csv`;
    const vids = videos.map((v) => ({ ...v })), links = format === 'aasx' ? videoLinkFiles(a.id, vids) : [];
    const env = buildRobotEnvironment({ asset: a, samples: this.samples, detail, last: this.last, opts: { fileRef: format === 'aasx' && detail ? csvPath : null, videos: vids } });
    const out = format === 'aasx'
      ? { name: `${base}.aasx`, type: 'application/asset-administration-shell-package', data: buildAASX(a.id, toXML(env), [...(detail ? [{ path: csvPath, data: detailCSV(a.id, detail), contentType: 'text/csv' }] : []), ...links]) }
      : format === 'json' ? { name: `${base}.aas.json`, type: 'application/json', data: JSON.stringify(env, null, 1) }
      : format === 'xml' ? { name: `${base}.aas.xml`, type: 'application/xml', data: toXML(env) }
      : { name: `${base}.aas.ttl`, type: 'text/turtle', data: toTurtle(env) };
    return out;
  }
  downloadRobot(tele, format, videos = []) {
    const out = this.exportRobot(tele, format, videos);
    const blob = new Blob([out.data], { type: out.type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = out.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { name: out.name, bytes: blob.size, videos: videos.length };
  }

  stats() {
    const fields = this.assets.reduce((n, a) => n + a.fields.length, 0);
    return { assets: this.assets.length, fields, samples: this.samples.length, points: this.samples.length * fields, events: this.events.length,
      from: this.samples[0]?.t, to: this.samples[this.samples.length - 1]?.t };
  }
}
