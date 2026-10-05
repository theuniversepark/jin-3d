// 로봇 텔레메트리 — 선택한 로봇의 관절값을 3D 모델에서 매 프레임 읽고, 속도·가속도·TCP와
// 가상 센서값(토크·모터 온도·전류·힘/토크 센서·라이다·IMU 등)을 계산한다.
// 관절값과 위치는 화면에 그려지는 모델 값 그대로이고, 센서값은 움직임·부하·설비 상태로 계산한 시뮬레이션 값이다.
import * as THREE from 'three';
import { moverRadius, BATTERY } from './sim.js';
import { NR } from './net5g.js';
import { AMMR } from './line.js';
const AMMR_PHASE = { work: '작업 위치 (셀 도킹)', turnOut: '부품 선반 쪽으로 회전', driveOut: '부품 선반으로 주행', pick: '선반에서 양팔 피킹', turnIn: '셀 쪽으로 회전', driveIn: '부품을 들고 작업 위치로 복귀' };

const DEG = 180 / Math.PI;
const BATT_CHG = { agv: '충전 패드', carrier: '정차 위치 무선 충전', humanoid: '대기 구역 무선 충전', quadruped: '충전 스테이션 도킹', drone: '이착륙장 무선 충전', ammr: '작업 위치 도킹 접점' };
const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)}시간 ${Math.round(min % 60)}분` : `${Math.max(1, Math.round(min))}분`);
const HIST = 120;              // 차트에 남기는 샘플 수 (0.1초 간격 → 12초)
const AMBIENT = 24;            // 주변 온도 °C
export const REC_DT = 1;       // 정밀 기록 간격 (시뮬레이션 초)
const REC_MAX = 20000;         // 로봇당 정밀 기록 보관 수
const v3 = () => new THREE.Vector3();
const ema = (prev, x, k) => (prev == null ? x : prev + (x - prev) * k);

// 공정별 엔드이펙터 하중·작업 힘 프로파일 (작업 진행률 p, 0~1)
const TOOL = {
  sort:     { tool: '진공 흡착 패드', force: (p) => (p > 0.25 && p < 0.75 ? { label: '흡착 진공', value: -62 - 6 * Math.sin(p * 20), unit: 'kPa' } : { label: '흡착 진공', value: -2, unit: 'kPa' }) },
  assembly: { tool: '적응형 그리퍼 + 힘/토크 센서', force: (p) => ({ label: '삽입력 Fz', value: p > 0.3 && p < 0.7 ? 45 + 35 * Math.sin((p - 0.3) / 0.4 * Math.PI) : 3, unit: 'N' }) },
  pressfit: { tool: '압입 툴 + 힘/토크 센서', force: (p) => ({ label: '압입력 Fz', value: p > 0.2 && p < 0.8 ? 120 + 260 * Math.sin((p - 0.2) / 0.6 * Math.PI) : 4, unit: 'N' }) },
  screw:    { tool: '전동 스크류 드라이버', force: (p) => ({ label: '체결 토크', value: Math.max(0, Math.sin(p * Math.PI * 8)) * 2.4, unit: 'N·m' }) },
  fasten:   { tool: '그리퍼 (하우징 정렬)', force: (p) => ({ label: '정렬 반력 Fz', value: p > 0.1 && p < 0.25 ? 60 : 5, unit: 'N' }) },
  pack:     { tool: '진공 그리퍼', force: (p) => ({ label: '흡착 진공', value: p > 0.2 && p < 0.8 ? -55 : -2, unit: 'kPa' }) },
};

export class RobotTelemetry {
  constructor(view, ref) {
    this.view = view; this.ref = ref;
    this.prev = null; this.hist = []; this.histT = 0; this.temp = null; this.odo = 0;
    this.tcpPrev = null; this.posPrev = null; this.headPrev = null;
    this.recT = REC_DT;   // 선택 직후 바로 한 번 기록
  }

  // 로봇별 누적 기록 키 (데이터 허브의 AAS 자산 id와 같은 규칙)
  key() { return this.ref.type === 'cell' ? `${this.ref.stationId}_R${this.ref.idx + 1}` : this.ref.id; }
  log() {
    const logs = (this.view.robotLogs ??= new Map());
    let L = logs.get(this.key());
    if (!L) { L = { fields: null, rows: [], since: this.view.sim.time }; logs.set(this.key(), L); }
    return L;
  }
  // 정밀 기록 한 줄 (시뮬레이션 시각 + 숫자·문자 값). 항목 구성은 첫 기록에서 정해진다.
  record() {
    const R = this.R; if (!R) return;
    if (this.jointDefs(R) && !this.prev) return;   // 관절 있는 로봇은 첫 관절값을 읽은 뒤부터 (AMR·AGV는 바로)
    const raw = this.raw(R), L = this.log();
    L.fields ??= raw.map(({ value, ...f }) => f);
    L.rows.push({ simT: this.view.sim.time, v: L.fields.map((f) => raw.find((r) => r.idShort === f.idShort)?.value ?? null) });
    if (L.rows.length > REC_MAX) L.rows.shift();
  }

  // 정밀 기록용 원시 값 (표시 패널과 같은 계산, 단위는 SI·공학 단위)
  raw(R) {
    const out = [], put = (idShort, label, unit, value, type = 'double') => out.push({ idShort, label, unit, type, value: Number.isFinite(value) || typeof value !== 'number' ? value : null });
    const defs = this.jointDefs(R);
    if (defs && this.prev) defs.forEach((d, i) => {
      const deg = d.unit === 'deg', n = `Joint${i + 1}`;
      put(`${n}Position`, `${d.name} 위치`, deg ? 'deg' : 'mm', this.prev.q[i] * (deg ? DEG : 1000));
      put(`${n}Velocity`, `${d.name} 속도`, deg ? 'deg/s' : 'mm/s', this.prev.dq[i] * (deg ? DEG : 1000));
      put(`${n}Torque`, `${d.name} 토크 (정격 대비)`, '%', this.tq?.[i]);
      put(`${n}MotorTemperature`, `${d.name} 모터 온도`, 'degC', this.temp?.[i]);
    });
    if (R.kind === 'arm') {
      const st = R.st, busy = st.state === 'BUSY', p = st.progress ?? 0;
      const tool = TOOL[st.type];
      const force = tool ? tool.force(busy ? p : 0) : { label: '파지력', value: busy ? 30 : 0, unit: 'N' };
      put('State', '상태', null, busy ? 'Operating' : st.state === 'ESTOP' ? 'EmergencyStop' : st.state === 'PSTOP' ? 'ProtectiveStop' : st.state === 'DOWN' || st.state === 'MAINT' ? 'Stopped' : 'Idle', 'string');
      put('CycleProgress', '작업 진행률', '%', busy ? p * 100 : 0);
      put('TcpX', 'TCP X', 'mm', this.tcp?.x); put('TcpY', 'TCP Y', 'mm', this.tcp?.y); put('TcpZ', 'TCP Z', 'mm', this.tcp?.z);
      put('TcpSpeed', 'TCP 속도', 'mm/s', this.tcp?.speed);
      if (R.robot.tip2) { put('Tcp2X', '오른팔 TCP X', 'mm', this.tcp2?.x); put('Tcp2Y', '오른팔 TCP Y', 'mm', this.tcp2?.y); put('Tcp2Z', '오른팔 TCP Z', 'mm', this.tcp2?.z); put('Tcp2Speed', '오른팔 TCP 속도', 'mm/s', this.tcp2?.speed); }
      put('ProcessSensor', `${force.label}`, force.unit, force.value);
      put('MotorCurrentTotal', '모터 전류 합계', 'A', (this.tq ?? []).reduce((a, b) => a + b, 0) * 0.06);
      put('BaseVibrationRMS', '베이스 진동 RMS', 'mm/s', 0.6 + (100 - st.health) * 0.045 + (busy ? 0.4 : 0));
      const au = R.robot.dual ? st.ammr?.[this.ref.idx] : null;
      if (au) { put('Battery', '배터리', '%', au.battery); put('HoldingPart', '부품 파지', null, au.carry, 'bool'); put('PlatformPhase', '이동 플랫폼 상태', null, au.phase, 'string'); put('PlatformOffset', '작업 위치에서 이동 거리', 'm', au.pos * (au.travel ?? AMMR.pickZ - AMMR.slotZ)); put('RackStock', '부품 선반 재고', 'pcs', st.parts ?? null, 'int'); }
      if (R.robot.kind === 'cobot') put('NearestMoverDistance', '최근접 이동체 거리 (안전 감시)', 'm', this.nearestMover(R.robot.root.getWorldPosition(v3())));
      return out;
    }
    const m = R.mover;
    put('PositionX', '위치 X', 'm', m.x); put('PositionZ', '위치 Z', 'm', m.z);
    put('Heading', '방위', 'deg', ((m.heading * DEG) % 360 + 360) % 360);
    put('Speed', '주행 속도', 'm/s', this.speed ?? 0); put('YawRate', '회전 속도', 'deg/s', (this.yawRate ?? 0) * DEG);
    put('Odometer', '누적 주행 (선택 이후)', 'm', this.odo);
    put('LidarNearest', '라이다 최근접 장애물', 'm', this.lidar(m));
    put('Blocked', '진로 대기', null, !!m.blockedOn, 'boolean');
    put('Task', '작업', null, m.task ?? 'Idle', 'string');
    if (m.kind === 'agv') { put('Battery', '배터리', '%', m.battery); put('LoadCount', '적재 수량', 'pcs', m.load?.n ?? 0, 'int'); }
    if (m.kind === 'carrier') {
      const it = this.view.sim.itemOfCarrier?.(m);
      put('OperationState', '운행 상태', null, m.state, 'string');
      put('LinePhase', '현재 구간', null, m.state === 'line' ? m.lineInfo?.phase ?? '' : '', 'string');
      put('Payload', '탑재물', null, it ? (it.scrap ? 'empty(reject)' : `${it.product ?? 'part'}#${it.id}`) : 'empty', 'string');
      put('Battery', '배터리', '%', m.battery);
    }
    if (m.kind === 'humanoid') { put('CarryingBin', '부품 빈 운반', null, !!m.carry, 'boolean'); put('Battery', '배터리', '%', m.battery); }
    if (m.kind === 'drone') { put('Altitude', '비행 고도', 'm', m.y); put('Battery', '배터리', '%', m.battery); put('FlightMode', '비행 모드', null, m.mode, 'string'); }
    if (m.kind === 'quadruped') put('Battery', '배터리', '%', m.battery);
    if (m.kind === 'quadruped') {
      const st = m.scanning;
      put('InspectionTarget', '점검 대상', null, st?.id ?? '', 'string');
      put('ThermalMax', '열화상 최고온도', 'degC', st ? 34 + (100 - st.health) * 0.55 : null);
      put('VibrationRMS', '진동 RMS', 'mm/s', st ? 0.6 + (100 - st.health) * 0.045 : null);
      put('NoiseLevel', '소음', 'dB(A)', st ? 62 + (100 - st.health) * 0.18 : null);
    }
    return out;
  }

  // 선택 대상 찾기 (모드 전환·라인 변경 후에는 사라질 수 있다)
  resolve() {
    const { view, ref } = this;
    if (ref.type === 'cell') {
      const sv = view.stationViews.find((s) => s.st.id === ref.stationId);
      const r = sv?.parts.robots?.[ref.idx];
      return r ? { kind: 'arm', robot: r, st: sv.st, obj: r.root } : null;
    }
    const all = [...view.vehicleViews, ...view.carrierViews, ...view.techViews, ...view.helperViews, ...view.quadViews, ...(view.droneViews ?? [])];
    const mv = all.find((x) => x.v.id === ref.id);
    if (!mv) return null;
    // 라인 위 운반 AMR은 대상물 메시(아래쪽 AMR)로 그려진다
    let obj = mv.g;
    if (mv.v.kind === 'carrier' && mv.v.state === 'line') {
      const item = view.sim.itemOfCarrier?.(mv.v);
      obj = item ? view.itemMeshes.get(item.id) ?? mv.g : mv.g;
    }
    return { kind: mv.v.kind, mover: mv.v, view: mv, obj };
  }

  // 매 프레임 호출 — rdt: 실제 경과 시간, sdt: 시뮬레이션 경과 시간
  sample(rdt, sdt) {
    const R = this.resolve();
    this.R = R;
    if (!R || rdt <= 0) return;
    const sim = this.view.sim;
    const q = this.joints(R);
    const dt = Math.max(1e-3, rdt);
    // 속도·가속도는 1/30초 이상 구간으로 계산한다 (짧고 불규칙한 프레임 간격에서 값이 튀지 않게)
    this.accT = (this.accT ?? 0) + rdt;
    if (q && this.prev && this.accT < 1 / 30) { this.prev.q = q; }
    else if (q) {
      const win = this.prev ? this.accT : dt;
      this.accT = 0;
      const base = this.prevQ ?? q;
      const dq = this.prev ? q.map((x, i) => (x - base[i]) / win) : q.map(() => 0);
      const ddq = this.prev ? dq.map((x, i) => (x - this.prev.dq[i]) / win) : dq.map(() => 0);
      this.prevQ = q;
      this.prev = { q, dq: this.prev ? dq.map((x, i) => ema(this.prev.dq[i], x, 0.5)) : dq, ddq: this.prev ? ddq.map((x, i) => ema(this.prev.ddq[i], x, 0.3)) : ddq };
      // 모터 온도: 부하(토크 %)에 비례해 오르고 주변 온도로 식는다 (시정수 약 3분, 시뮬레이션 시간 기준)
      const tq = this.torques(R);
      this.temp ??= tq.map(() => AMBIENT + 6);
      this.temp = this.temp.map((T, i) => T + ((AMBIENT + 6 + tq[i] * 0.45) - T) * Math.min(1, sdt / 180));
      this.tq = tq;
    }
    // TCP (로봇 베이스 기준, mm)
    if (R.robot?.tip) {
      const w = R.robot.tip.getWorldPosition(v3());
      const base = R.robot.root.getWorldPosition(v3());
      const rel = w.clone().sub(base);
      const sp = this.tcpPrev ? w.distanceTo(this.tcpPrev) / dt : 0;
      this.tcp = { x: rel.x * 1000, y: -rel.z * 1000, z: rel.y * 1000, speed: ema(this.tcp?.speed, sp * 1000, 0.3) };
      this.tcpPrev = w;
      if (R.robot.tip2) {   // 양팔 로봇의 오른팔 TCP
        const w2 = R.robot.tip2.getWorldPosition(v3()), rel2 = w2.clone().sub(base);
        const sp2 = this.tcp2Prev ? w2.distanceTo(this.tcp2Prev) / dt : 0;
        this.tcp2 = { x: rel2.x * 1000, y: -rel2.z * 1000, z: rel2.y * 1000, speed: ema(this.tcp2?.speed, sp2 * 1000, 0.3) };
        this.tcp2Prev = w2;
      }
    }
    // 이동 로봇: 실제 속도(시뮬레이션 m/s)·회전 속도
    if (R.mover) {
      const m = R.mover, p = { x: m.x, z: m.z };
      const d = this.posPrev ? Math.hypot(p.x - this.posPrev.x, p.z - this.posPrev.z) : 0;
      this.odo += d;
      const v = sdt > 0 ? d / sdt : 0;
      let dh = this.headPrev == null ? 0 : m.heading - this.headPrev;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.speed = ema(this.speed, v, 0.3);
      this.yawRate = ema(this.yawRate, sdt > 0 ? dh / sdt : 0, 0.3);
      this.posPrev = p; this.headPrev = m.heading;
    }
    // 정밀 기록 (시뮬레이션 1초 간격)
    this.recT += sdt;
    if (this.recT >= REC_DT) { this.recT = 0; this.record(); }
    // 차트 기록 (0.1초 간격)
    this.histT += rdt;
    if (this.histT >= 0.1) {
      this.histT = 0;
      const defs = this.jointDefs(R);
      if (q && defs) this.hist.push(q.map((x, i) => (x - defs[i].min) / (defs[i].max - defs[i].min)));
      if (this.hist.length > HIST) this.hist.shift();
    }
  }

  jointDefs(R) {
    if (R.robot) return R.robot.jointDefs;
    if (R.kind === 'humanoid') return HUMANOID_JOINTS;
    if (R.kind === 'quadruped') return QUAD_JOINTS;
    if (R.kind === 'robot') return R.view.g.userData.arm ? MAINT_JOINTS : null;
    return null;
  }

  joints(R) {
    if (R.robot) return R.robot.joints();
    const ud = R.view?.g.userData;
    if (R.kind === 'humanoid') return [ud.waist?.rotation.y ?? 0, ud.head?.rotation.y ?? 0, ud.legL.rotation.x, ud.legR.rotation.x, ud.armL.rotation.x, ud.armR.rotation.x, ud.body.position.y];
    if (R.kind === 'quadruped') return ud.legs.flatMap((l) => [l.hip.rotation.x, l.knee.rotation.x]);
    if (R.kind === 'robot' && ud.arm) return ud.arm.joints();
    return null;
  }

  // 관절 토크 (정격 대비 %): 중력 + 관성 + 마찰, 작업 중이면 공구 하중 추가
  torques(R) {
    const q = this.prev.q, dq = this.prev.dq, ddq = this.prev.ddq;
    const busy = R.st ? R.st.state === 'BUSY' : !!R.mover?.moving;
    // 6축 팔: 중력(어깨·팔꿈치·손목 자세) + 관성 + 마찰. 양팔 로봇은 몸통 승강축 + 팔마다 같은 식
    const arm6 = (o) => {
      const s2 = Math.sin(q[o + 1]), s23 = Math.sin(q[o + 1] + q[o + 2]), s234 = Math.sin(q[o + 1] + q[o + 2] + q[o + 3]);
      const pl = busy ? 1.25 : 1;
      const g = [4, 38 * Math.abs(s2) * pl + 6, 24 * Math.abs(s23) * pl + 4, 10 * Math.abs(s234) * pl + 3, 4, 2];
      return g.map((x, i) => Math.min(100, x + Math.min(30, Math.abs(ddq[o + i]) * 2.2) + Math.min(20, Math.abs(dq[o + i]) * 3)));
    };
    if (R.robot?.dual) { const n0 = R.robot.jointDefs.length - 12; return [...Array.from({ length: n0 }, (_, i) => Math.min(100, (i ? 8 : 30) + Math.min(25, Math.abs(ddq[i]) * 1.2) + (busy ? 8 : 0))), ...arm6(n0), ...arm6(n0 + 6)]; }   // 몸통(승강 · 허리 회전 · 머리 회전) + 양팔
    if (R.robot && R.robot.jointDefs.length === 6) return arm6(0);
    // 보행 로봇(휴머노이드·사족보행)은 보행 주기가 빨라 가속 항을 작게, 체중 지지분을 기본 부하로 둔다
    if (R.kind === 'humanoid' || R.kind === 'quadruped') {
      return q.map((_, i) => Math.min(100, (R.kind === 'quadruped' && i % 2 ? 22 : 15) + Math.abs(ddq[i]) * 0.12 + Math.abs(dq[i]) * 1.6 + (R.mover?.carry ? 10 : 0)));
    }
    return q.map((_, i) => Math.min(100, 8 + Math.abs(ddq[i]) * 3 + Math.abs(dq[i]) * 6 + (busy ? 6 : 0)));
  }

  // 화면에 보여 줄 값 묶음
  // 배터리 상태 (이동하는 배터리 로봇): 잔량·충방전·속도·예상 가동/완충 시간·충전 방식·팩 사양
  batterySection(obj, kind, charging, moving) {
    const spec = BATTERY[kind]; if (!spec || obj?.battery == null) return null;
    const t = this.view.sim.time, b = obj.battery, p = (this.battPrev ??= new WeakMap()).get(obj);
    let rate = p?.rate ?? 0;   // %/초 (지수 평활)
    if (p && t - p.t > 0.05) rate = p.rate * 0.85 + ((b - p.b) / (t - p.t)) * 0.15;
    if (!p || t - p.t > 0.05) this.battPrev.set(obj, { t, b, rate });
    const cls = b < spec.low ? 'bad' : b < spec.low + 15 ? 'warn' : 'ok';
    const n = Math.round(b / 10), bar = '▰'.repeat(n) + '▱'.repeat(10 - n);
    const state = charging ? `충전 중 · ${BATT_CHG[kind]}` : obj.swapping ? '배터리 팩 교체 중' : moving ? '방전 중 · 주행' : '방전 중 · 대기·작업';
    const eta = charging ? (rate > 0.002 ? `완충까지 약 ${hm((100 - b) / rate / 60)}` : '완충 유지')
      : rate < -0.0005 ? `약 ${hm(Math.max(0, b - spec.low) / -rate / 60)} 뒤 저전압 (${spec.low}%)` : '소모 거의 없음';
    return { title: '배터리', rows: [
      ['잔량', `${b.toFixed(0)}%  ${bar}`, cls],
      ['상태', state, charging ? 'ok' : b < spec.low ? 'bad' : ''],
      ['충·방전 속도', `${rate >= 0 ? '+' : '−'}${Math.abs(rate * 60).toFixed(2)} %/분`],
      [charging ? '완충 예상' : '가동 예상', eta, !charging && b < spec.low + 15 ? 'warn' : ''],
      ['충전 방식', spec.charge], ['배터리 팩', spec.pack],
      ['저전압 기준', `${spec.low}% 이하${b < spec.low ? ' — 경고' : ''}`, b < spec.low ? 'bad' : ''],
    ] };
  }
  // 5G 통신 (이동 로봇 5G 모뎀): 서빙 셀 PCI·RSRP·SINR, 인접 셀, 핸드오버, 업링크 패킷(무손실), 전송 경로
  netSection(obj) {
    const net = this.view.sim.net, u = net?.ueOf(obj); if (!u) return null;
    const c = u.servCell, nb = net.plan.cells[u.nbr], h = u.hos[0], t = this.view.sim.time;
    const q = (v) => (v >= -75 ? 'ok' : v >= NR.design ? '' : v >= -95 ? 'warn' : 'bad');
    const topic = `opcua/json/data/jin3d/…/${u.uid ?? u.id}`;
    return { title: '5G 통신 (Private 5G)', rows: [
      ['서빙 셀', u.hoUntil >= 0 ? `핸드오버 중 → PCI ${net.plan.cells[u.hoTarget].pci}` : `${c.id} · PCI ${c.pci}`, u.hoUntil >= 0 ? 'warn' : 'ok'],
      ['RSRP / SINR', `${u.rsrp.toFixed(1)} dBm / ${u.sinr.toFixed(1)} dB`, q(u.rsrp)],
      ['인접 셀 (최강)', nb ? `${nb.id} · PCI ${nb.pci} · ${u.F[u.nbr].toFixed(1)} dBm (A3 기준 +${NR.a3}dB)` : '-'],
      ['핸드오버', `${u.hoN}회${h ? ` · 최근 ${Math.round(t - h.t)}초 전 PCI ${h.from} → ${h.to} (중단 ${h.ms}ms, 버퍼 포워딩 ${h.fwd}건)` : ''}`],
      ['업링크 MQTT', `송신 ${u.sent.toLocaleString('ko-KR')} · 도착 ${u.delivered.toLocaleString('ko-KR')} · 버퍼 ${u.buf} · 유실 ${u.sent - u.delivered - u.buf}`, u.sent - u.delivered - u.buf ? 'bad' : 'ok'],
      ['단말', `5G 모뎀 IMSI ${u.imsi} · ${NR.band} ${NR.fc}GHz`],
      ['전송 경로', `AAS → OPC UA PubSub JSON → MQTT QoS 1 → 5G NR → UPF → 브로커 (${topic})`],
    ] };
  }
  snapshot() {
    const R = this.R ?? this.resolve();
    if (!R) return null;
    const sim = this.view.sim;
    const out = { kind: R.kind, hist: this.hist, sections: [] };
    const defs = this.jointDefs(R);
    if (defs && this.prev) {
      out.joints = defs.map((d, i) => ({
        ...d, value: d.unit === 'deg' ? this.prev.q[i] * DEG : this.prev.q[i] * 1000,
        vel: d.unit === 'deg' ? this.prev.dq[i] * DEG : this.prev.dq[i] * 1000,
        frac: (this.prev.q[i] - d.min) / (d.max - d.min),
        torque: this.tq?.[i], temp: this.temp?.[i],
      }));
    }
    if (R.kind === 'arm') {
      const st = R.st, r = R.robot, busy = st.state === 'BUSY';
      const p = st.progress ?? 0;
      const tool = TOOL[st.type] ?? { tool: '그리퍼', force: () => ({ label: '파지력', value: busy ? 30 : 0, unit: 'N' }) };
      const f = tool.force(busy ? p : 0);
      const near = this.nearestMover(r.root.getWorldPosition(v3()));
      const cobot = r.kind === 'cobot';
      const safety = !cobot ? null : near < 1.0 ? ['보호 정지', 'bad'] : near < 2.0 ? ['협동 감속 50%', 'warn'] : ['정상 속도 100%', 'ok'];
      const vib = 0.6 + (100 - st.health) * 0.045 + (busy ? 0.4 : 0);
      out.title = `${st.robotUids?.[this.ref.idx] ? `[${st.robotUids[this.ref.idx]}] ` : ''}${st.name} · ${ROBOT_LABEL[r.kind]} ${R.view ? '' : `#${this.ref.idx + 1}`}`;
      out.status = [['상태', busy ? `가동 (진행 ${(p * 100).toFixed(0)}%)` : st.state === 'DOWN' ? '설비 고장 — 정지' : st.state === 'MAINT' ? '정비 중 — 정지' : st.state === 'ESTOP' ? '비상정지 — 동력 차단' : st.state === 'PSTOP' ? '보호정지 — 자세 유지' : st.state === 'CHECK' ? '자가진단 중' : st.state === 'CSTOP' ? '사이클 정지' : '대기'], ['정격 가반하중', `${r.payload} kg`]];
      if (st.vlaCell) { const uid = st.robotUids?.[this.ref.idx], n = this.view.epRec?.list(uid).length ?? 0, ps = this.view.sim.vla?.robotStats.get(uid); out.status.push(['VLA 추론 모델', this.view.sim.vla?.versionOf(uid) ?? 'v1.0'], ['VLA 에피소드', `보관 ${n} · 누적 ${ps?.n ?? 0}개${ps?.n ? ` · 성공률 ${Math.round((ps.ok / ps.n) * 100)}%` : ''}`]); }
      const xyz = (p) => `${p.x.toFixed(0)} / ${p.y.toFixed(0)} / ${p.z.toFixed(0)} mm`;
      out.sections.push({ title: 'TCP (툴 끝점, 베이스 기준)', rows: !this.tcp ? [] : this.tcp2 ? [
        ['왼팔 X / Y / Z', xyz(this.tcp)], ['왼팔 TCP 속도', `${this.tcp.speed.toFixed(0)} mm/s`],
        ['오른팔 X / Y / Z', xyz(this.tcp2)], ['오른팔 TCP 속도', `${this.tcp2.speed.toFixed(0)} mm/s`],
      ] : [['X / Y / Z', xyz(this.tcp)], ['TCP 속도', `${this.tcp.speed.toFixed(0)} mm/s`]] });
      const u = r.dual ? st.ammr?.[this.ref.idx] : null;
      if (u) { const bs = this.batterySection(u, 'ammr', u.chgNow, u.phase !== 'work'); if (bs) out.sections.unshift(bs); const ns = this.netSection(u); if (ns) out.sections.splice(1, 0, ns); }
      if (u) out.status.push(['이동 플랫폼', AMMR_PHASE[u.phase] ?? u.phase, u.phase === 'work' ? '' : 'ok'], ['배터리', `${u.battery.toFixed(0)}%${u.chgNow ? ' · 도킹 충전 중' : ''}`, u.battery < BATTERY.ammr.low ? 'bad' : ''],
        ['양팔', u.carry ? '선반에서 가져온 부품 파지' : u.phase === 'work' && st.state === 'BUSY' ? '조립·체결 작업' : '대기'],
        ['부품 선반 재고', st.parts != null ? `${st.parts}개` : '충분 (상시 보충)'], ['선반 왕복', `${u.trips}회`]);
      else if (r.kind === 'humanoid') out.status.push(['보행', '셀 작업 위치에 양발로 서서 작업']);
      else if (r.dual) out.status.push(['이동 플랫폼', '셀 도킹 (위치 고정)']);
      if (st.gate && st.item?.id === st.gate.id && st.gate.role) { const lead = this.view.sim.isLead(st, this.ref.idx); out.status.push(['게이트 결정', st.gate.text], ['이 로봇 역할', lead ? `주 작업 — ${st.gate.role.lead}` : `보조 — ${st.gate.role.support}`, lead ? 'ok' : '']); }
      out.sections.push({ title: '센서', rows: [
        ['엔드이펙터', tool.tool],
        [f.label, `${f.value.toFixed(f.unit === 'N·m' ? 2 : 0)} ${f.unit}`],
        ['모터 전류 합계', `${((this.tq ?? []).reduce((a, b) => a + b, 0) * 0.06).toFixed(1)} A`],
        ['베이스 진동 RMS', `${vib.toFixed(2)} mm/s`, vib > 3 ? 'warn' : ''],
        ...(safety ? [['안전 감시 (속도·간격)', `${safety[0]} · 최근접 ${near.toFixed(1)} m`, safety[1]]] : []),
      ] });
    } else {
      const m = R.mover;
      const kindLabel = { agv: 'AGV', forklift: '지게차', carrier: '운반 AMR', humanoid: '휴머노이드', quadruped: '사족보행 로봇', robot: '정비로봇', drone: '순찰 드론' }[m.kind] ?? m.kind;
      out.title = `${m.uid ? `[${m.uid}] ` : ''}${m.id} · ${kindLabel}`;
      const lidar = this.lidar(m);
      const field = m.blockedOn ? [`정지 — 전방 ${m.blockedOn.id}`, 'warn'] : !m.moving ? ['정지 (대기)', ''] : lidar < 0.5 ? ['보호 필드 침범', 'bad'] : lidar < 1.5 ? ['경고 필드 — 감속', 'warn'] : ['정상', 'ok'];
      out.status = [['작업', m.task ?? '대기'], ['위치', `x ${m.x.toFixed(2)} · z ${m.z.toFixed(2)} m`], ['방위', `${Math.round(((m.heading * DEG) % 360) + 360) % 360}°`]];
      const motion = [['주행 속도', `${(this.speed ?? 0).toFixed(2)} m/s`], ['회전 속도', `${(Math.abs((this.yawRate ?? 0) * DEG) < 0.5 ? 0 : (this.yawRate ?? 0) * DEG).toFixed(0)} °/s`], ['누적 주행', `${this.odo.toFixed(1)} m`]];
      if (m.kind === 'agv' || m.kind === 'carrier' || m.kind === 'forklift') {
        const v = this.speed ?? 0, w = this.yawRate ?? 0, track = 0.8, rw = 0.1;
        const rpm = (x) => ((x / (2 * Math.PI * rw)) * 60).toFixed(0);
        motion.push(['바퀴 속도 L / R', `${rpm(v - (w * track) / 2)} / ${rpm(v + (w * track) / 2)} rpm`]);
      }
      { const bk = m.kind === 'robot' && m.role !== 'supply' ? null : m.kind;   // 배터리로 움직이는 로봇: AGV·AMR·휴머노이드·사족보행·드론
        const bs = BATTERY[bk] && (bk !== 'agv' || this.view.sim.mode.batteryDrain) ? this.batterySection(m, bk, bk === 'carrier' || bk === 'humanoid' ? m.chgNow : m.charging, m.moving || (bk === 'drone' && m.y > 0.5)) : null;
        if (bs) { out.sections.unshift(bs); out.status.push(['배터리', `${m.battery.toFixed(0)}%${bs.rows[1][1].startsWith('충전') ? ' · 충전 중' : ''}`, bs.rows[0][2]]); } }
      { const ns = this.netSection(m); if (ns) { out.sections.splice(1, 0, ns); const uu = this.view.sim.net.ueOf(m); out.status.push(['5G', `PCI ${uu.servCell.pci} · ${uu.rsrp.toFixed(0)}dBm · 핸드오버 ${uu.hoN}회`, 'ok']); } }
      out.sections.push({ title: '주행', rows: motion });
      const sens = m.kind === 'drone'
        ? [['비행 고도', `${m.y.toFixed(2)} m`],
          ['로터 속도', `${m.y > 0.3 ? (5200 + (m.speedNow ?? 0) * 260).toFixed(0) : 0} rpm`], ['짐벌 카메라', m.mode === 'mission' ? (m.arrived ? `사고 현장 중계 · ${m.mission?.title ?? ''} (하방 −90°)` : '사고 현장으로 이동')  : m.hover > 0 ? '셀 점검 (하방 −70°)' : '전방 −30°'],
          ['비행 모드', { patrol: '순찰', event: '이벤트 확인', return: '귀환', charge: '착륙·충전' }[m.mode] ?? m.mode]]
        : [['라이다 최근접 장애물', `${lidar.toFixed(2)} m`], ['안전 필드', field[0], field[1]]];
      if (m.kind === 'agv') sens.push(['적재', m.load ? `${m.load.type === 'raw' ? '자재' : '완제품'} ${m.load.n}개` : '없음']);
      if (m.kind === 'carrier') {
        const item = sim.itemOfCarrier?.(m);
        sens.push(['리프트 높이', `${(0.9 * 1000).toFixed(0)} mm`], ['탑재물', item ? (item.scrap ? '없음 (불량 배출 후)' : `${item.product === 'doortrim' ? '도어트림' : 'e-axle'} #${item.id}`) : '없음'],
          ['운행 상태', m.state === 'line' ? (m.lineInfo?.where === 'cell' ? '셀 내부' : '셀 간 운반') : { park: '대기열', toSrc: '투입 위치로 이동', docking: '투입 위치 진입', atSrc: '적재 대기', return: '빈차 복귀' }[m.state] ?? m.state],
          ...(m.state === 'line' && m.lineInfo ? [['현재 구간', m.lineInfo.phase],
            ...(m.lineInfo.where === 'path' ? [['구간 진행', `${m.lineInfo.s.toFixed(1)} / ${m.lineInfo.len.toFixed(1)} m`]] : [])] : []));
      }
      if (m.kind === 'humanoid') {
        const phase = this.prev ? this.prev.q[0] : 0;
        const wkg = 72 + (m.carry ? 8 : 0);
        const share = m.moving ? 0.5 + Math.max(-0.45, Math.min(0.45, phase * 0.9)) : 0.5;
        sens.push(['발바닥 하중 L / R', `${(wkg * 9.8 * share).toFixed(0)} / ${(wkg * 9.8 * (1 - share)).toFixed(0)} N`], ['IMU 상하 가속', `${(Math.abs(this.prev?.dq[4] ?? 0) * 9.8).toFixed(2)} m/s²`], ['운반물', m.carry ? '부품 빈 (약 8 kg)' : '없음']);
      }
      if (m.kind === 'quadruped') {
        const st = m.scanning;
        const pitch = this.prev ? (this.prev.q[0] - this.prev.q[4]) * 0.08 * DEG : 0;
        sens.push(['IMU 피치', `${pitch.toFixed(1)}°`]);
        if (st) {
          const temp = 34 + (100 - st.health) * 0.55, vib = 0.6 + (100 - st.health) * 0.045, db = 62 + (100 - st.health) * 0.18;
          sens.push(['점검 대상', st.name], ['열화상 최고온도', `${temp.toFixed(1)} °C`, temp > 55 ? 'warn' : ''], ['진동 RMS', `${vib.toFixed(2)} mm/s`, vib > 3 ? 'warn' : ''], ['소음', `${db.toFixed(0)} dB(A)`]);
        } else sens.push(['점검 센서', '대기 (이동 중)']);
      }
      out.sections.push({ title: '센서', rows: sens });
    }
    return out;
  }

  nearestMover(p) {
    let best = Infinity;
    for (const m of this.view.sim.movers ?? []) {
      if (m.state === 'line') continue;
      best = Math.min(best, Math.hypot(m.x - p.x, m.z - p.z) - moverRadius(m));
    }
    return Math.max(0, best);
  }

  // 라이다: 다른 이동체와 설비 바닥 영역까지의 최소 거리 (자기 차체 반지름 제외)
  lidar(m) {
    const sim = this.view.sim;
    let best = 8;
    for (const o of sim.movers ?? []) {
      if (o === m || o.state === 'line') continue;
      best = Math.min(best, Math.hypot(o.x - m.x, o.z - m.z) - moverRadius(o) - moverRadius(m));
    }
    for (const st of sim.stations) {
      const hx = st.type === 'source' || st.type === 'sink' ? 1.8 : 2.3, hz = 2.3;
      const dx = Math.max(0, Math.abs(m.x - st.x) - hx), dz = Math.max(0, Math.abs(m.z - st.z) - hz);
      if (m.state === 'line' || (m.kind === 'carrier' && Math.abs(m.z - st.z) < 0.6)) continue;   // 셀 통로 출입은 제외
      best = Math.min(best, Math.hypot(dx, dz) - moverRadius(m));
    }
    return Math.max(0, best);
  }
}

const ROBOT_LABEL = { articulated: '6축 다관절 로봇', cobot: '협동로봇', scara: 'SCARA', gantry: '갠트리', ammr: 'AMR 기반 양팔 로봇 (AMMR)', humanoid: '휴머노이드 로봇' };
const HUMANOID_JOINTS = [
  { name: '허리 회전 (360°)', unit: 'deg', min: -Math.PI, max: Math.PI },   // Atlas형: 허리 연속 회전 · 머리 좌우 180°
  { name: '머리 회전 (±90°)', unit: 'deg', min: -Math.PI / 2, max: Math.PI / 2 },
  { name: '왼쪽 고관절', unit: 'deg', min: -0.8, max: 0.8 },
  { name: '오른쪽 고관절', unit: 'deg', min: -0.8, max: 0.8 },
  { name: '왼쪽 어깨', unit: 'deg', min: -1.5, max: 1.0 },
  { name: '오른쪽 어깨', unit: 'deg', min: -1.5, max: 1.0 },
  { name: '몸통 상하', unit: 'mm', min: 0, max: 0.08 },
];
const QUAD_JOINTS = ['앞왼', '앞오른', '뒤왼', '뒤오른'].flatMap((l) => [
  { name: `${l} 고관절`, unit: 'deg', min: -0.6, max: 0.6 },
  { name: `${l} 무릎`, unit: 'deg', min: 0, max: 0.9 },
]);
const MAINT_JOINTS = [
  { name: 'J1 베이스 회전', unit: 'deg', min: -Math.PI, max: Math.PI },
  { name: 'J2 어깨', unit: 'deg', min: -1.6, max: 2.6 },
  { name: 'J3 팔꿈치', unit: 'deg', min: -1, max: 3 },
  { name: 'J4 손목 굽힘', unit: 'deg', min: -2, max: 2 },
  { name: 'J5 손목 비틀기', unit: 'deg', min: -2, max: 2 },
  { name: 'J6 툴 플랜지', unit: 'deg', min: -6.3, max: 6.3 },
];
