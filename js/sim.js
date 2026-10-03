// 제조 라인 시뮬레이션 엔진 — 렌더링과 분리되어 있어 헤드리스(고속 비교) 실행이 가능하다.
import { CommandCenter } from './commands.js';
import { TruckYard, planForklift } from './shipping.js';
import { PatrolDrone } from './drone.js';
import { VLAPipeline } from './vla.js';
import { AIOSPipeline } from './aios.js';
import { Orchestrator } from './orchestrator.js';
import { AMMR, PARALLEL_GAIN, DEFAULT_LINE, buildStationDefs, linkPath, lineEdges, pathLength, pointAt, toWorld, isZone, ZONE_AMR, ZONE_MIXES, ZONE_PRODUCTS, FG_ZONE_CAP, amrPark, AMR_DOCK, amrDockVia, amrReturnVia } from './line.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MODES = {
  traditional: {
    key: 'traditional', label: '레거시 공장', short: '레거시',
    cycleMul: 1.22, cycleVar: 0.22, defectBase: 0.028, catchRate: 0.85, wearMul: 1.15,
    repairTime: 160, pmTime: 0, pmEnabled: false, alarmDelay: 35,
    vehicles: 1, vehicleKind: 'forklift', vehicleSpeed: 1.7, batteryDrain: 0, vehicleCap: 24,
    techs: 2, techKind: 'human', techSpeed: 1.3,
    reorderPoint: 3, shipBatch: 24, dispatchDelay: 25, releaseInterval: 7.5,
    lightingKW: 32, hvacKW: 26, agentActive: false,
  },
  smart: {
    key: 'smart', label: '자동화 공장', short: '자동화',
    cycleMul: 1.0, cycleVar: 0.08, defectBase: 0.015, catchRate: 0.98, wearMul: 1.0,
    repairTime: 90, pmTime: 45, pmEnabled: true, pmThreshold: 50, alarmDelay: 0,
    vehicles: 3, vehicleKind: 'agv', vehicleSpeed: 2.3, batteryDrain: 0.22, vehicleCap: 16, chargeAt: 30,
    techs: 1, techKind: 'human', techSpeed: 1.5,
    reorderPoint: 12, shipBatch: 12, dispatchDelay: 0, releaseInterval: 9,
    lightingKW: 16, hvacKW: 18, agentActive: true,
  },
  dark: {
    key: 'dark', label: '피지컬AI 자율공장', short: '자율',
    cycleMul: 0.92, cycleVar: 0.04, defectBase: 0.008, catchRate: 0.995, wearMul: 0.9,
    repairTime: 60, pmTime: 28, pmEnabled: true, pmThreshold: 55, alarmDelay: 0,
    vehicles: 4, vehicleKind: 'agv', vehicleSpeed: 2.6, batteryDrain: 0.22, vehicleCap: 16, chargeAt: 55,
    techs: 2, techKind: 'humanoid', techSpeed: 1.6,
    // 사람 대신: 휴머노이드(정비 2·부품 보충 2) + 사족보행 순찰 로봇 2
    helpers: 2, quadrupeds: 2, partsCap: 40, partsReorder: 14, scanPm: 12,
    reorderPoint: 14, shipBatch: 12, dispatchDelay: 0, releaseInterval: 8.3,
    lightingKW: 6, hvacKW: 7, agentActive: true,   // 고효율 LED 구역 조명
  },
};

// 현장 이벤트 (피지컬AI 단계: 로봇 카메라 영상의 AI 추론으로 감지 → 자율 대응)
export const FIELD_EVENTS = {
  leak:      { label: '바닥 누유', cls: '누유', severity: 'alarm', response: 'clean', task: '누유 흡착·세척' },
  debris:    { label: '바닥 이물질', cls: '이물질', severity: 'warn', response: 'clean', task: '이물질 수거' },
  intrusion: { label: '안전구역 무단 진입', cls: '사람', severity: 'alarm', response: 'safety', task: '' },
  smoke:     { label: '연기 의심', cls: '연기', severity: 'alarm', response: 'inspect', task: '열화상 정밀 점검' },
};

export const ST_LABEL = {
  ESTOP: '비상정지', PSTOP: '보호정지', CSTOP: '사이클정지', CHECK: '자가진단',
  IDLE: '대기', BUSY: '가동', STARVED: '자재대기', BLOCKED: '배출대기',
  DOWN: '고장', MAINT: '정비중', HOLD: '투입보류', FULL: '적재만재', OFF: '미사용', NOAMR: 'AMR대기', NOPARTS: '부품결품', REFILL: '부품보충중',
};

export const BELT_Y = 0.9;
export const PALLET_RAW = 20, RAW_CAP = 40, FG_CAP = 36;

// ── 바닥 동선(AGV/작업자) ─────────────────────────────
export const AISLE = { F: 9, B: -9 };
// 사족보행 배터리 소모 (%/초): 보행 약 24분, 점검 중, 대기
const QUAD_DRAIN = { move: 0.07, scan: 0.03, idle: 0.004 };
const LEFT = -33, RIGHT = 35;
export const LOC = {
  WH: { x: -26, z: -13.5, aisle: 'B', name: '자재창고' },
  WH_PARTS: { x: -22.5, z: -13.5, aisle: 'B', name: '부품 랙' },   // 휴머노이드 부품 피킹 — AGV 팔레트 위치(x=-26)와 진입로 분리
  SRC: { x: -26, z: 4.2, aisle: 'F', name: '투입구' },
  SINK: { x: 29, z: 4.2, aisle: 'F', name: '완제품 적재장' },
  TECH: { x: 12, z: 13.5, aisle: 'F', name: '정비실' },
  CTRL: { x: -2, z: -12.5, aisle: 'B', name: '관제실' },
};
export const chgLoc = (i) => ({ x: -14 + i * 3.2, z: 13.5, aisle: 'F', name: '충전소' });
// 설비 앞면(로컬 +z) 기준 지점 → 동선 위치. 앞면이 향한 통로(F/B)를 쓴다.
export const localLoc = (def, lx, lz, name) => { const p = toWorld(def, lx, lz); return { ...p, aisle: p.z >= 0 ? 'F' : 'B', name }; };
// 설비 앞 작업 위치: 셀 앞 모서리(2.3m)와 통로 차로 사이, 지나가는 이동체와 겹치지 않는 거리
export const SVC_Z = 2.7;
export const svcLoc = (st) => localLoc(st.def, 0.9, SVC_Z, st.name);

// 통로(폭 2.6m)는 진행 방향별 차로로 나눈다 (+x 방향은 통로 중심 -0.7, -x 방향은 +0.7 / 세로 통로도 같은 방식)
// → 마주 오는 이동체끼리 정면으로 만나지 않고, AGV끼리도 0.3m 여유를 두고 엇갈린다
const LANE = 0.7;
const laneZ = (z, dir) => z + (dir >= 0 ? -LANE : LANE);
const laneX = (x, dir) => x + (dir >= 0 ? LANE : -LANE);
export function route(from, to, cur) {
  const fz = AISLE[from.aisle], tz = AISLE[to.aisle];
  const pts = [];
  if (cur && (Math.abs(cur.x - from.x) > 0.01 || Math.abs(cur.z - from.z) > 0.01)) pts.push({ x: from.x, z: from.z });
  if (from.aisle === to.aisle) {
    const z = laneZ(fz, Math.sign(to.x - from.x));
    pts.push({ x: from.x, z }, { x: to.x, z });
  } else {
    const viaL = Math.abs(from.x - LEFT) + Math.abs(to.x - LEFT);
    const viaR = Math.abs(from.x - RIGHT) + Math.abs(to.x - RIGHT);
    const sx = viaL <= viaR ? LEFT : RIGHT;
    const z1 = laneZ(fz, Math.sign(sx - from.x)), z2 = laneZ(tz, Math.sign(to.x - sx)), x = laneX(sx, Math.sign(tz - fz));
    pts.push({ x: from.x, z: z1 }, { x, z: z1 }, { x, z: z2 }, { x: to.x, z: z2 });
  }
  pts.push({ x: to.x, z: to.z });
  return pts;
}

// 이동체 크기(반지름, m) — 충돌 판정용
const RADIUS = { agv: 0.8, forklift: 1.0, carrier: 0.8, robot: 0.6, quadruped: 0.55, humanoid: 0.35, human: 0.35, worker: 0.35 };
export const moverRadius = (m) => RADIUS[m.kind] ?? 0.5;
// 차체 폭(m) — 진로 안에 있는지(옆으로 비껴 지나갈 수 있는지) 판정용
const WIDTH = { agv: 1.1, forklift: 1.2, carrier: 0.95, robot: 0.9, quadruped: 0.5, humanoid: 0.6, human: 0.6, worker: 0.6 };
export const moverWidth = (m) => WIDTH[m.kind] ?? 0.8;

// 이동체(AGV·지게차·정비 인력/로봇·작업자) — 단계(step) 목록을 순서대로 실행
export class Mover {
  constructor(id, kind, loc, speed) {
    this.id = id; this.kind = kind; this.loc = loc; this.home = loc;
    this.x = loc.x; this.z = loc.z; this.heading = Math.PI; this.speed = speed;
    this.steps = []; this.path = null; this.task = null; this.moving = false;
    this.battery = 100; this.charging = false; this.load = null; this.dist = 0;
    this.sense = null; this.prio = 0; this.blockedOn = null; this.blockT = 0; this.detourPts = 0;
  }
  // 진행 방향 앞에 다른 이동체가 있으면 멈춘다(true).
  // · 서로 막은 경우(좁은 진입로에서 마주침): 우선순위가 낮은 쪽이 옆으로 비켜선다
  // · 앞 이동체가 할 일 없이 서 있고 내 목적지가 아니면: 옆으로 돌아간다
  // · 그 밖(같은 방향 대기열, 작업 중인 이동체)은 기다린다
  yieldTo(dir, dt) {
    const b = this.sense?.(this, dir);
    if (!b) { this.blockedOn = null; this.blockT = 0; return false; }
    this.blockedOn = b; this.blockT += dt;
    const off = moverRadius(this) + moverRadius(b) + 0.35;
    const cross = dir.x * (b.z - this.z) - dir.z * (b.x - this.x);
    const sgn = cross > 0 ? 1 : -1;   // 상대가 있는 쪽의 반대편
    const sd = { x: -dir.z * sgn, z: dir.x * sgn };
    const step = (pts) => { this.path.unshift(...pts); this.detourPts += pts.length; this.blockT = 0; return false; };
    if (b.blockedOn === this) {
      const bd = b.wantDir ?? { x: Math.sin(b.heading), z: Math.cos(b.heading) };
      if (dir.x * bd.x + dir.z * bd.z < -0.7) {
        // 정면으로 마주침(좁은 진입로): 우선순위가 낮은 쪽이 옆으로 비켜선다
        if (this.prio < b.prio && this.blockT > 0.3) return step([{ x: this.x + sd.x * off, z: this.z + sd.z * off }]);
        return true;
      }
      // 교차로에서 서로 막음: 우선순위가 낮은 쪽이 들어온 길로 조금 물러나(이미 지나온 빈 공간) 길을 터 준다
      if (this.prio < b.prio && this.blockT > 0.3) return step([{ x: this.x - dir.x * off * 0.7, z: this.z - dir.z * off * 0.7 }]);
      return true;
    }
    const end = this.path[this.path.length - 1];
    const atDest = Math.hypot(b.x - end.x, b.z - end.z) < moverRadius(this) + moverRadius(b) + 0.4;
    // 할 일 없이 내 목적지를 막고 있으면 자기 자리(홈)로 비켜 달라고 한다
    if (b.idle && atDest && this.blockT > 0.8 && b.kind !== 'carrier' && b.home && Math.hypot(b.x - b.home.x, b.z - b.home.z) > 0.5) {
      b.setTask('자리 비켜주기', [{ go: b.home }]);
      return true;
    }
    if (b.idle && !atDest && this.blockT > 1.5) {
      const ahead = Math.hypot(b.x - this.x, b.z - this.z) + moverRadius(b) + moverRadius(this) + 0.3;
      return step([{ x: this.x + sd.x * off, z: this.z + sd.z * off }, { x: this.x + sd.x * off + dir.x * ahead, z: this.z + sd.z * off + dir.z * ahead }]);
    }
    // 12초 넘게 풀리지 않으면 세 대 이상이 서로 기다리는 순환 대기로 보고, 우선순위가 낮은 쪽이 옆으로 비켜선다
    if (this.blockT > 12 && this.prio < b.prio) return step([{ x: this.x + sd.x * off, z: this.z + sd.z * off }]);
    return true;
  }
  get idle() { return this.steps.length === 0; }
  setTask(name, steps) { this.task = name; this.steps = steps; this.path = null; this.detourPts = 0; }   // 이동 중 재지시되면 새 경로로
  update(dt) {
    this.moving = false; this.charging = false;
    const st = this.steps[0];
    if (!st || !st.go) this.wantDir = null;
    if (!st) { this.task = null; return; }
    if (st.go) {
      if (!this.path) this.path = st.via ? [...st.via, st.go].map((p) => ({ x: p.x, z: p.z })) : route(this.loc, st.go, this);
      let rem = this.speed * dt, checked = false;
      while (rem > 0 && this.path.length) {
        const p = this.path[0];
        const dx = p.x - this.x, dz = p.z - this.z, d = Math.hypot(dx, dz);
        if (d < 1e-4) { this.path.shift(); continue; }
        if (!checked) { checked = true; this.wantDir = { x: dx / d, z: dz / d }; if (this.yieldTo(this.wantDir, dt)) break; if (this.path[0] !== p) continue; }
        this.heading = Math.atan2(dx, dz);
        if (d <= rem) { this.x = p.x; this.z = p.z; rem -= d; this.dist += d; this.path.shift(); if (this.detourPts > 0) this.detourPts--; }
        else { this.x += (dx / d) * rem; this.z += (dz / d) * rem; this.dist += rem; rem = 0; }
        this.moving = true;
      }
      if (!this.path.length) { this.path = null; this.loc = st.go; this.steps.shift(); this.detourPts = 0; }
    } else if ('wait' in st) {
      st.wait -= dt;
      if (st.wait <= 0) { st.done?.(); this.steps.shift(); }
    } else if (st.until) {
      if (st.task && this.task !== st.task) { st.prev = this.task; this.task = st.task; }   // 기다리는 동안 작업 표시를 바꾼다
      if (st.until()) { if (st.prev) this.task = st.prev; this.steps.shift(); }
    } else if (st.do) {
      st.do(); this.steps.shift();
    } else if (st.charge) {
      this.charging = true;
      this.battery = Math.min(100, this.battery + dt * (this.chargeRate ?? 1.6));
      if (this.battery >= 99.5) this.steps.shift();
    }
  }
}

function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
}

export class Simulation {
  constructor(modeKey = 'smart', seed = 12345, opts = {}) {
    const m = (this.mode = { ...MODES[modeKey] });   // 시뮬레이션마다 복사 — AIOS가 운영 정책 값을 바꿔도 다른 시뮬레이션에 번지지 않게
    this.twin = !!opts.twin;                          // AIOS 트윈 검증용 시뮬레이션
    this.rand = mulberry32(seed);
    this.quiet = !!opts.quiet;
    this.time = 0;
    this.nextItemId = 1;
    this.logs = []; this.logSeq = 0; this.events = [];
    this.stats = { released: 0, good: 0, escaped: 0, rejected: 0, failures: 0, pm: 0, cal: 0, energy: 0, shipped: 0, wipInt: 0, supplyTrips: 0, goodBy: {} };
    this.history = []; this.lastHist = -999;
    this.rawStock = 24; this.inboundRaw = 0; this.fgStock = 0; this.safetyStock = 10;
    this.supplyDisruptedUntil = 0;
    this.releaseTimer = 0; this.releaseHold = false; this.releaseInterval = m.releaseInterval;
    this.powerKW = 0;
    this.requests = [];
    this.orch = new Orchestrator(this); this.cmd = new CommandCenter(this);   // 공장 오케스트레이터 (인시던트 보고·판단·명령)

    this.line = opts.line ?? DEFAULT_LINE;
    const defs = buildStationDefs(this.line, modeKey);
    // OEE 기준 사이클: 설계상 최고 속도(병목 실효 사이클의 90%)
    this.idealCycle = 0.9 * Math.max(...defs.filter((d) => d.cycle).map((d) => d.cycle * (d.share ?? 1)));
    this.stations = defs.map((d, i) => ({
      def: d, idx: i, id: d.id, type: d.type, x: d.x, z: d.z ?? 0, rot: d.rot ?? 0,
      name: d.name,
      state: 'IDLE', item: null, progress: 0, cycleTime: 0, done: false, itemT: 0,
      health: 55 + this.rand() * 45, drift: this.rand() * 0.2,
      speedMul: 1, powerSave: false, starvedFor: 0, ema: 0,
      repairRemaining: 0, repairTotal: 0, techOnSite: false, request: null, maintKind: null,
      c: { processed: 0, busy: 0, down: 0, maint: 0, starved: 0, blocked: 0, defects: 0, fails: 0 },
    }));
    this.processing = this.stations.filter((s) => s.def.cycle);
    this.zone = isZone(this.line);
    // 레거시 공장은 셀 사이를 고정 컨베이어로 잇고, 자동화·자율 공장은 AMR이 대상물을 싣고 다닌다
    this.useAMR = this.zone && modeKey !== 'traditional';
    // 입구 → 셀 중앙 진입 시간 (표시·텔레메트리용): AMR은 라인 주행 속도 그대로, 컨베이어는 0.5초
    this.entryTime = this.useAMR ? 2 / ZONE_AMR.lineSpeed : 0.5;
    this.standby = []; this.idleLinks = [];
    // 설비 연결: 직렬 라인은 앞뒤로, 정밀조립Zone은 분기(부품분류 → 제품별 라인)·합류(→ 포장) 그래프
    // st.ins: 들어오는 연결들, st.outs[제품]: 제품별 나가는 연결 (공통이면 '*')
    this.conveyors = [];
    for (const st of this.stations) { st.ins = []; st.outs = {}; }
    const byId = new Map(this.stations.map((st) => [st.id, st]));
    lineEdges(this.line).forEach(([fa, fb, prod], i) => {
      const a = byId.get(fa), b = byId.get(fb);
      const c = { idx: i, from: a, to: b, product: prod, path: linkPath(this.line, a.def, b.def), items: [], speed: this.useAMR ? ZONE_AMR.lineSpeed : 1.1, spacing: this.useAMR ? ZONE_AMR.spacing : 1.3 };
      c.len = pathLength(c.path);
      a.outs[prod ?? '*'] = c; b.ins.push(c);
      a.out ??= c; b.in ??= c;
      this.conveyors.push(c);
    });
    // 혼류 투입 순서 (평준화): 비율 대비 누적 투입이 가장 뒤처진 제품을 먼저 투입
    this.mix = this.zone ? (ZONE_MIXES[this.line.mix] ?? ZONE_MIXES['1:1']).w : null;
    this.releasedBy = { doortrim: 0, eaxle: 0 }; this.mixBase = { doortrim: 0, eaxle: 0 };
    this.fgBy = { doortrim: 0, eaxle: 0 };

    // 투입·적재 도크는 레이아웃에 따라 달라진다 (U자형이면 적재는 뒤쪽 통로)
    // 적재장 상차 위치: Zone 구분 적재장은 제품 구역(앞쪽 적재 팔레트)과 겹치지 않게 조금 더 앞에서 싣는다
    this.loc = { ...LOC, SRC: localLoc(this.stations[0].def, 0, 4.2, '투입구'), SINK: localLoc(this.stations[this.stations.length - 1].def, 0, isZone(this.line) ? 5.4 : 4.2, '완제품 적재장') };
    // 출하 지게차 상차 위치: 구분 적재장 앞쪽(도어트림 구역)·뒤쪽(e-axle 구역)
    const sinkDef = this.stations[this.stations.length - 1].def;
    this.loc.PICK_DT = { ...this.loc.SINK, name: isZone(this.line) ? '도어트림 적재 구역' : '완제품 적재장' };
    this.loc.PICK_EA = localLoc(sinkDef, 0, -5.4, 'e-axle 적재 구역');

    this.vehicles = [];
    for (let i = 0; i < m.vehicles; i++) {
      const v = new Mover(m.vehicleKind === 'agv' ? `AGV-${i + 1}` : `지게차-${i + 1}`, m.vehicleKind, chgLoc(i), m.vehicleSpeed);
      v.battery = 60 + this.rand() * 40;
      this.vehicles.push(v);
    }
    // 출하 지게차: 구분 적재장 → 뒷벽 출하 도크 → 트럭 야드 화물트럭 (레거시는 유인, 자동화·피지컬AI는 자율 지게차)
    this.forklifts = [new Mover(m.key === 'traditional' ? '지게차-출하' : '자율 지게차', 'forklift', { x: 19.5, z: -16.5, aisle: 'B', name: '출하 지게차 대기' }, m.key === 'traditional' ? 1.5 : m.key === 'smart' ? 1.9 : 2.1)];
    this.forklifts[0].shipper = true; this.forklifts[0].auto = m.key !== 'traditional';
    this.yard = new TruckYard(this);
    // 피지컬AI: 순찰 드론 (지상 교통과 높이가 달라 movers에는 넣지 않는다)
    this.drones = m.key === 'dark' ? [new PatrolDrone(this, 0)] : [];
    this.techs = [];
    for (let i = 0; i < m.techs; i++) {
      const home = { ...LOC.TECH, x: LOC.TECH.x + i * 1.6 };
      this.techs.push(new Mover(m.techKind === 'humanoid' ? `휴머노이드-정비${i + 1}` : `정비원-${i + 1}`, m.techKind, home, m.techSpeed));
    }
    // 무인공장: 부품 보충 휴머노이드 + 사족보행 순찰 로봇
    this.helpers = []; this.quads = []; this.partsReq = [];
    for (let i = 0; i < (m.helpers ?? 0); i++) {
      const h = new Mover(`휴머노이드-물류${i + 1}`, 'humanoid', { x: -19 + i * 1.6, z: -12.5, aisle: 'B', name: '부품 보충 대기' }, 1.6);
      h.role = 'supply'; h.carry = false; h.pick = { ...LOC.WH_PARTS, x: LOC.WH_PARTS.x + i * 1.5 };   // 휴머노이드마다 피킹 자리 분리
      this.helpers.push(h);
    }
    for (let i = 0; i < (m.quadrupeds ?? 0); i++) {
      const q = new Mover(`사족보행-${i + 1}`, 'quadruped', { x: 6 + i * 2, z: 13.5, aisle: 'F', name: '사족보행 충전 스테이션' }, 1.2);
      q.round = i; q.scanning = null;
      q.battery = 55 + this.rand() * 40; q.chargeRate = 0.45;   // 도킹 충전 약 0.45%/초 (20→95% 약 3분)
      this.quads.push(q);
    }
    if (m.partsCap) for (const st of this.processing) { st.parts = m.partsCap; st.partsReq = null; }
    // AMMR 셀: 로봇마다 부품 빈을 들고 작업하다 부족하면 옆 부품 선반을 다녀온다 (레거시 단계는 사람이 대신 작업)
    for (const st of this.processing) {
      if (st.def.robot.kind !== 'ammr' || modeKey === 'traditional') continue;
      st.ammr = Array.from({ length: st.def.robot.count }, (_, i) => ({ i, side: i % 2 ? 1 : -1, bin: AMMR.bin - (i % 2) * 4, phase: 'work', t: 0, pos: 0, turn: 0, carry: false, trips: 0 }));
      this.planAmmrRacks(st);
    }
    this.workers = [];
    this.setupWorkers();
    // 정밀조립Zone: 조립 대상물을 싣고 셀 사이를 오가는 AMR (컨베이어 대신)
    this.carriers = [];
    if (this.useAMR) {
      for (let i = 0; i < ZONE_AMR.count; i++) {
        const c = new Mover(`AMR-${String(i + 1).padStart(2, '0')}`, 'carrier', amrPark(i), ZONE_AMR.returnSpeed);
        c.state = 'park'; c.slot = i; c.heading = Math.PI;
        this.carriers.push(c);
      }
    }
    // 충돌 회피: 모든 이동체가 서로를 감지한다 (우선순위: 운반 중 AMR·AGV > 정비 > 기타)
    this.movers = [...this.carriers, ...this.vehicles, ...this.forklifts, ...this.techs, ...this.helpers, ...this.quads, ...this.workers];
    const prio = { carrier: 5, agv: 4, forklift: 4, humanoid: 3, human: 3, robot: 3, quadruped: 1, worker: 2 };
    this.movers.forEach((m, i) => { m.prio = (prio[m.kind] ?? 1) * 100 - i; m.sense = this.sense; });
    this.assignIds();
    // 피지컬AI: VLA 셀(6축 협동·산업용 로봇, AMMR)과 VLA 학습·배포 파이프라인
    for (const st of this.processing) st.vlaCell = m.key === 'dark' && ['cobot', 'articulated', 'ammr'].includes(st.def.robot?.kind);
    new VLAPipeline(this);
    new AIOSPipeline(this);   // 공장 운영 AI (데이터 수집 → 학습 → 트윈 검증 → 오케스트레이터 배포)
  }

  // 설비·로봇 고유 ID — 현황판·라벨·텔레메트리·데이터 연동에 같은 ID를 쓴다 (사람은 제외)
  assignIds() {
    const two = (n) => String(n).padStart(2, '0');
    this.stations[0].uid = 'AS-01';                                     // 자재 투입 AS/RS
    this.stations[this.stations.length - 1].uid = 'PL-01';              // 완제품·구분 적재장
    this.processing.forEach((st, k) => {
      st.uid = `CL-${two(k + 1)}`;
      st.robotUids = Array.from({ length: st.def.robot?.count ?? 0 }, (_, i) => `RB-${two(k + 1)}-${i + 1}`);
    });
    (this.standby ?? []).forEach((st, k) => { st.uid = `CL-S${k + 1}`; });
    this.sinkRobotUids = this.zone ? ['RB-PL-1', 'RB-PL-2'] : [];
    this.carriers.forEach((m, i) => { m.uid = `AM-${two(i + 1)}`; });
    this.vehicles.forEach((m, i) => { m.uid = `${m.kind === 'agv' ? 'AG' : 'FL'}-${two(i + 1)}`; });
    this.forklifts.forEach((m, i) => { m.uid = `FL-S${i + 1}`; });
    this.techs.filter((m) => m.kind !== 'human').forEach((m, i) => { m.uid = `${m.kind === 'humanoid' ? 'HM-M' : 'MR-'}${i + 1}`; });
    this.helpers.forEach((m, i) => { m.uid = `HM-L${i + 1}`; });
    this.quads.forEach((m, i) => { m.uid = `QD-${two(i + 1)}`; });
    this.drones.forEach((m, i) => { m.uid = `DR-${two(i + 1)}`; });
  }

  // 진행 방향 앞(차폭 안)에 있는 가장 가까운 이동체 — 셀 안을 달리는 운반 AMR(state 'line')은 전용 경로라 제외
  sense = (m, dir) => {
    let best = null, bd = Infinity;
    const rm = moverRadius(m);
    for (const o of this.movers) {
      if (o === m || o.state === 'line') continue;
      const rx = o.x - m.x, rz = o.z - m.z;
      const along = rx * dir.x + rz * dir.z;
      if (along <= 0.15) continue;
      const R = rm + moverRadius(o);
      const lateral = Math.abs(rx * dir.z - rz * dir.x);
      if (along < R + 0.5 && lateral < (moverWidth(m) + moverWidth(o)) / 2 + 0.1 && along < bd) { bd = along; best = o; }
    }
    return best;
  };

  // 운반 AMR이 싣고 있는 대상물 (라인 위 AMR은 대상물과 함께 그려진다)
  itemOfCarrier(c) {
    for (const cv of this.conveyors) for (const e of cv.items) if (e.item.carrier === c) return e.item;
    for (const st of this.processing) if (st.item?.carrier === c) return st.item;
    return null;
  }
  outFor(st, item) { return st.outs[item?.product] ?? st.outs['*']; }
  queueLen(st) { return st.ins.reduce((n, c) => n + c.items.length, 0); }
  // AMMR 부품 선반 배치 — 기본은 셀 긴 쪽 바깥(로봇 작업 위치에서 약 1m), 그 자리가 통로·AMR 경로·다른 셀과 겹치면
  // 셀 옆쪽(진행 방향 앞/뒤, 로봇과 같은 줄)으로 옮긴다. 로봇마다 { mode, rack(셀 기준 중심), pick(피킹 위치), travel } 를 정한다.
  // 슬롯 배치는 factory.js placeRobots와 같다.
  planAmmrRacks(st) {
    const zone = this.zone, zr = 1.7;
    const slots = zone ? [[-0.75, -1], [-0.75, 1], [0.95, -1], [0.95, 1]] : [[-0.6, -1], [0.6, 1], [1.3, -1], [-1.3, 1]];
    const RW = 1.46, RD = 0.52, M = 0.35;   // 선반 폭·깊이, 여유
    const worldRect = (cx, cz, w, d) => {   // 셀 기준 사각형 → 월드 AABB
      const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([a, b]) => toWorld(st.def, cx + a, cz + b));
      return { x0: Math.min(...pts.map((p) => p.x)) - M, x1: Math.max(...pts.map((p) => p.x)) + M, z0: Math.min(...pts.map((p) => p.z)) - M, z1: Math.max(...pts.map((p) => p.z)) + M };
    };
    const segDist = (r, a, b) => {   // 선분과 사각형(AABB) 사이 최소 거리 (근사: 선분 위 샘플)
      let best = Infinity;
      for (let k = 0; k <= 20; k++) { const x = a.x + (b.x - a.x) * k / 20, z = a.z + (b.z - a.z) * k / 20; const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1); best = Math.min(best, Math.hypot(dx, dz)); }
      return best;
    };
    const conflicts = (r) => {
      const why = [];
      if (r.x0 < -37.5 || r.x1 > 37.5 || r.z0 < -19.5 || r.z1 > 19.5) why.push('바닥 밖');
      for (const az of [AISLE.F, AISLE.B]) if (r.z1 > az - 1.3 && r.z0 < az + 1.3) why.push('통로');
      for (const c of this.conveyors) for (let k = 1; k < c.path.length; k++) if (segDist(r, c.path[k - 1], c.path[k]) < 0.55) { why.push('AMR 경로'); break; }
      for (const o of this.stations) if (o !== st) { const h = o.type === 'source' || o.type === 'sink' ? 1.8 : 2.3; if (r.x1 > o.x - h && r.x0 < o.x + h && r.z1 > o.z - 2.3 && r.z0 < o.z + 2.3) why.push(`${o.name} 셀`); }
      return why;
    };
    const plan = st.ammr.map((u, i) => {
      const [sx, side] = slots[i] ?? slots[0];
      const zMode = { mode: 'z', rack: { x: slots.find((q) => q[1] === side)[0], z: side * AMMR.rackZ }, pick: { x: sx, z: side * AMMR.pickZ }, side, slot: { x: sx, z: side * AMMR.slotZ } };
      const dir = sx > 0 ? 1 : -1;
      const xMode = { mode: 'x', dir, rack: { x: dir * 3.6, z: side * AMMR.slotZ }, pick: { x: dir * 2.85, z: side * AMMR.slotZ }, side, slot: { x: sx, z: side * AMMR.slotZ } };
      const cz = conflicts(worldRect(zMode.rack.x, zMode.rack.z, RW, RD));
      if (!cz.length) return zMode;
      const cx = conflicts(worldRect(xMode.rack.x, xMode.rack.z, RD, RW));
      return cx.length <= cz.length ? { ...xMode, moved: cz } : { ...zMode, blocked: cz };
    });
    for (const [i, u] of st.ammr.entries()) { const p = plan[i]; u.rack = p; u.travel = Math.hypot(p.pick.x - p.slot.x, p.pick.z - p.slot.z); }
    st.ammrRacks = plan;
  }

  // 운전 중 혼류 비율 변경 (대화 지시) — 다음 투입부터 새 비율로 평준화한다
  setMix(key) {
    if (!this.zone || !ZONE_MIXES[key]) return false;
    this.line = { ...this.line, mix: key }; this.mix = ZONE_MIXES[key].w; this.mixBase = { ...this.releasedBy };
    return true;
  }
  nextProduct() {
    let best = null, bv = Infinity;
    for (const [p, w] of Object.entries(this.mix)) {
      if (!w) continue;
      const v = (this.releasedBy[p] - this.mixBase[p] + 1) / w;
      if (v < bv) { bv = v; best = p; }
    }
    return best;
  }

  // ── 운반 AMR ─────────────────────────────
  updateCarriers(dt) {
    const cs = this.carriers;
    if (!cs.length) return;
    // 투입 스테이션에 빈 AMR이 없으면 대기열에서 가장 가까운 AMR을 부른다
    // 선행 배차(amrStage): 운영 정책(AIOS)이 2 이상이면 다음 AMR을 미리 불러 진입로 끝에서 대기시킨다
    const stage = this.mode.amrStage ?? 1, coming = cs.filter((c) => c.state === 'toSrc' || c.state === 'docking' || c.state === 'atSrc').length;
    if (!this.releaseHold && coming < stage) {
      const c = cs.filter((c) => c.state === 'park').sort((a, b) => a.x - b.x)[0];
      if (c) {
        c.state = 'toSrc'; c.slot = null;
        // 앞서 출발한 AMR이 투입 위치를 충분히 벗어날 때까지 진입로 끝에서 기다렸다가 들어간다
        const via = amrDockVia(c), gate = via.pop(), out = this.stations[0].out;
        c.setTask('투입 위치로', [
          { go: { ...gate, aisle: 'F' }, via },
          { until: () => (!out.items.length || out.items[out.items.length - 1].s > 3.4) && !cs.some((k) => k !== c && (k.state === 'docking' || k.state === 'atSrc')) },
          { do: () => { c.state = 'docking'; } },
          { go: AMR_DOCK, via: [] },
          { do: () => { c.state = 'atSrc'; c.heading = Math.PI / 2; } },
        ]);
      }
    }
    for (const c of cs) if (c.state !== 'line') c.update(dt);
    this.syncLineCarriers(dt);
  }

  // 대상물을 싣고 라인 위(셀 사이 경로·셀 내부)에 있는 AMR의 위치·방위·주행 상태를 대상물 위치와 맞춘다.
  // (라인 위 AMR은 대상물과 함께 움직이므로, 텔레메트리·AAS 데이터가 멈추지 않게 매 스텝 갱신)
  syncLineCarriers(dt) {
    const place = (c, x, z, heading, info) => {
      const d = Math.hypot(x - c.x, z - c.z);
      c.moving = d > 1e-4; c.dist += d;
      if (c.moving) c.heading = heading;
      c.x = x; c.z = z; c.lineInfo = info; c.blockedOn = null;
    };
    for (const cv of this.conveyors) cv.items.forEach((e, i) => {
      const c = e.item.carrier; if (!c) return;
      const q = pointAt(cv.path, e.s), a = pointAt(cv.path, Math.max(0, e.s - 0.2)), b = pointAt(cv.path, Math.min(cv.len, e.s + 0.2));
      const atEnd = e.s >= cv.len - 1e-6;
      const ahead = i > 0 && cv.items[i - 1].s - e.s <= cv.spacing + 1e-3;
      place(c, q.x, q.z, Math.atan2(b.x - a.x, b.z - a.z), {
        where: 'path', from: cv.from.id, to: cv.to.id, s: e.s, len: cv.len,
        phase: atEnd ? `${cv.to.name} 입구 대기` : ahead ? '앞 AMR 간격 유지 대기' : `${cv.from.name} → ${cv.to.name} 이동`,
      });
    });
    for (const st of this.processing) {
      const c = st.item?.carrier; if (!c) continue;
      const k = Math.min(1, st.itemT / this.entryTime);   // 입구 → 셀 중앙 진입 (화면과 같은 시간)
      const from = st.itemFrom ?? toWorld(st.def, -2, 0);
      const p = { x: from.x + (st.x - from.x) * k, z: from.z + (st.z - from.z) * k };
      const dir = toWorld(st.def, 1, 0);
      place(c, p.x, p.z, Math.atan2(dir.x - st.x, dir.z - st.z), {
        where: 'cell', station: st.id,
        phase: k < 1 ? `${st.name} 진입 중` : st.state === 'BUSY' ? `${st.name} 정차 — 작업 중 (${Math.round(st.progress * 100)}%)`
          : st.state === 'BLOCKED' ? `${st.name} 정차 — 다음 구간 대기` : st.state === 'DOWN' ? `${st.name} 정차 — 설비 고장` : st.state === 'MAINT' ? `${st.name} 정차 — 정비 중` : `${st.name} 정차`,
      });
    }
  }
  // 적재장에서 제품을 내려놓은 AMR을 AMR 전용 복귀로로 빈 대기 자리에 돌려보낸다
  releaseCarrier(item, def) {
    const c = item.carrier; if (!c) return;
    item.carrier = null;
    const used = new Set(this.carriers.map((k) => k.slot).filter((k) => k != null));
    let slot = 0; while (used.has(slot)) slot++;
    const park = amrPark(slot);
    // 적재장 입구(현재 위치)에서 하역 위치(적재장 중앙)로 들어가 내려놓은 뒤 복귀한다
    const dock = { x: def.x, z: def.z ?? 0 };
    c.loc = { ...dock, aisle: 'F' };
    c.state = 'return'; c.slot = slot; c.path = null; c.detourPts = 0;
    c.setTask('빈 AMR 복귀', [
      { go: { ...dock, aisle: 'F', name: '하역 위치' }, via: [] },
      { wait: 2 },
      { go: park, via: amrReturnVia(dock, park) },
      { do: () => { c.state = 'park'; c.heading = Math.PI; } },
    ]);
  }


  setupWorkers() {
    const k = this.mode.key;
    const add = (id, role, x, z, heading = Math.PI, patrol = null) => {
      const w = new Mover(id, 'worker', { x, z, aisle: z > 0 ? 'F' : 'B' }, 1.15);
      w.role = role; w.heading = heading; w.patrol = patrol; w.station = null;
      this.workers.push(w); return w;
    };
    if (k === 'traditional') {
      for (const st of this.stations) {
        const edge = st.type === 'source' || st.type === 'sink';
        const op = toWorld(st.def, edge ? -2.3 : -1.0, edge ? 1.2 : 2.4);
        const w = add(`작업자-${st.id}`, st.def.inspect ? '검사원' : '작업자', op.x, op.z);
        w.station = st;
        // 로봇 대수만큼 수작업 인원 배치 (2번째부터는 라인 뒤편)
        for (let k = 1; k < (st.def.robot?.count ?? 0); k++) {
          const ep = toWorld(st.def, -1.2 + (k - 1) * 1.2, -2.4);
          const e = add(`작업자-${st.id}-${k + 1}`, '작업자', ep.x, ep.z, 0);
          e.station = st;
        }
      }
      add('자재 담당', '작업자', -23.5, -12.5, 0);
      add('출하 담당', '작업자', 26.5, -12.5, 0);
      // 순찰 반환점·보행로는 통로 바깥 보행로(z=±11.2, 가까운 차량 차로에서 1.5m) — 엇갈리는 차량을 막지 않는다
      add('작업반장', '반장', -20, 11.2, Math.PI / 2, [
        { x: -20, z: 11.2, aisle: 'F' }, { x: 24, z: 11.2, aisle: 'F' },
      ]);
    } else if (k === 'smart') {
      add('모니터링-1', '모니터링', -10, 11.2, Math.PI / 2, [
        { x: -24, z: 11.2, aisle: 'F' }, { x: 26, z: 11.2, aisle: 'F' },
      ]);
      add('모니터링-2', '모니터링', 10, -11.2, -Math.PI / 2, [
        { x: 20, z: -11.2, aisle: 'B' }, { x: -20, z: -11.2, aisle: 'B' },
      ]);
      add('관제 오퍼레이터', '관제', LOC.CTRL.x, LOC.CTRL.z, Math.PI);
    }
  }

  peopleOnSite() {
    return this.workers.length + this.techs.filter((t) => t.kind === 'human').length + (this.mode.vehicleKind === 'forklift' ? this.vehicles.length : 0) + this.forklifts.filter((f) => !f.auto).length;
  }

  log(level, title, body = {}) {
    this.aios?.onLog(level, title, body);   // 운영 의사결정 → AIOS 데이터
    if (this.quiet) return;
    this.logs.unshift({ id: ++this.logSeq, t: this.time, level, title, ...body });
    if (this.logs.length > 160) this.logs.pop();
  }

  emit(type, data) { if (!this.quiet) this.events.push({ type, ...data }); }

  // ── 컨베이어 ─────────────────────────────
  hasSpace(c) { return !c.items.length || c.items[c.items.length - 1].s >= c.spacing; }
  frontReady(c) { return c.items.length && c.items[0].s >= c.len - 1e-6; }
  updateConveyor(c, dt) {
    const it = c.items;
    for (let i = 0; i < it.length; i++) {
      const lim = i === 0 ? c.len : it[i - 1].s - c.spacing;
      it[i].s = Math.min(it[i].s + c.speed * dt, Math.max(lim, it[i].s));
    }
  }

  wip() {
    let n = 0;
    for (const c of this.conveyors) n += c.items.length;
    for (const s of this.processing) if (s.item) n++;
    return n;
  }

  // ── 메인 스텝 ─────────────────────────────
  step(dt) {
    const m = this.mode;
    this.time += dt;
    this.updateSink(dt);
    for (let i = this.processing.length - 1; i >= 0; i--) this.updateStation(this.processing[i], dt);
    this.updateSource(dt);
    // 상위 명령: 전체 비상정지·보호정지면 라인 이동(AMR·컨베이어)과 이동로봇을 세우고, 안전 감속·속도 오버라이드는 이동 속도에 반영
    const K = this.cmd, halt = K.estopAll || K.pstopAll, mdt = halt ? 0 : dt * K.lineSpeed;
    K.update(dt);
    if (mdt > 0) {
      for (const c of this.conveyors) this.updateConveyor(c, mdt);
      this.updateCarriers(mdt);
    }
    this.assignTechs();
    for (const v of this.vehicles) {
      if (!mdt) continue;
      v.update(mdt);
      if (m.batteryDrain) {
        if (v.moving) v.battery = Math.max(0, v.battery - m.batteryDrain * dt);
        else if (!v.charging) v.battery = Math.max(0, v.battery - 0.01 * dt);
      }
    }
    // 출하: 트럭은 건물 밖이라 계속 움직이고, 지게차는 Zone 명령(정지·감속·대피)을 따른다
    this.yard.update(dt);
    this.vla?.update(dt);
    this.aios?.update(dt);
    for (const d of this.drones) d.update(dt);
    if (mdt > 0) for (const f of this.forklifts) { if (f.idle && !K.evac) planForklift(this, f); f.update(mdt); }
    if (mdt > 0) {
      for (const t of this.techs) t.update(mdt);
      if (this.helpers.length) this.assignHelpers();
      for (const h of this.helpers) h.update(mdt);
      for (const q of this.quads) {
        if (q.idle) this.planPatrol(q);
        q.update(mdt);
        if (!q.charging) q.battery = Math.max(0, q.battery - (q.moving ? QUAD_DRAIN.move : q.scanning ? QUAD_DRAIN.scan : QUAD_DRAIN.idle) * mdt);
      }
    }
    for (const w of this.workers) {
      // 순찰 인원은 통로 바깥 보행로로 걷는다 (차량 차로를 쓰지 않음)
      if (w.patrol && w.idle) w.setTask('순찰', [{ go: w.patrol[0], via: [] }, { wait: 5 }, { go: w.patrol[1], via: [] }, { wait: 5 }]);
      w.update(dt);
    }
    this.updateFieldEvents();
    this.orch.update();
    // 자재 공급이 재개되면 공급 차질 인시던트를 닫는다
    const sup = this.orch.find('supply');
    // 차질 중 재고가 바닥나면 라인 정지를 기록하고, 출고 재개 후 자재가 투입구에 도착해야 인시던트를 닫는다
    if (sup) {
      if (this.supplyDisrupted && this.rawStock <= 0 && !sup.starved) { sup.starved = true; this.orch.step(sup, 'cell', 'report', '투입구 재고 소진 · 라인 자재 대기 (투입 중단)'); }
      if (!this.supplyDisrupted && !sup.resumed) { sup.resumed = true; this.orch.step(sup, 'exec', 'act', '창고 출고 재개 · 대기 AGV 자재 상차·운송'); }
      if (!this.supplyDisrupted && (this.rawStock > 0 || !sup.starved)) { this.orch.step(sup, 'exec', 'act', `자재 투입구 도착 · 투입 재개 (재고 ${this.rawStock}개)`); this.orch.close(sup, '공급 정상화 확인 · 인시던트 종료'); }
    }
    this.accountEnergy(dt);
    this.stats.wipInt += this.wip() * dt;
    if (this.time - this.lastHist >= 20) {
      this.lastHist = this.time;
      const k = this.kpi();
      this.history.push({ t: this.time, out: k.out, uph: k.uphRecent, oee: k.OEE });
      if (this.history.length > 400) this.history.shift();
    }
  }

  updateSource(dt) {
    const src = this.stations[0], K = this.cmd;
    if (K.estopAll || K.pstopAll) { src.state = K.estopAll ? 'ESTOP' : 'PSTOP'; return; }
    if (this.releaseHold || K.feedHold) { src.state = 'HOLD'; return; }
    if (this.rawStock <= 0) { src.state = 'STARVED'; src.c.starved += dt; return; }
    this.releaseTimer += dt * K.lineSpeed;
    if (this.releaseTimer >= this.releaseInterval) {
      const car = this.useAMR ? this.carriers.find((c) => c.state === 'atSrc') : null;
      if (this.useAMR && !car) { src.state = 'NOAMR'; src.c.blocked += dt; return; }
      if (this.hasSpace(src.out)) {
        const product = this.mix ? this.nextProduct() : null;
        if (product) this.releasedBy[product]++;
        const item = { id: this.nextItemId++, defect: false, defectBy: null, product, carrier: car };
        if (car) { car.state = 'line'; car.steps = []; car.task = '운반'; }
        src.out.items.push({ item, s: 0 });
        this.rawStock--; this.releaseTimer = 0; this.stats.released++;
        src.state = 'BUSY';
      } else { src.state = 'BLOCKED'; src.c.blocked += dt; }
    } else src.state = 'BUSY';
  }

  updateSink(dt) {
    const sink = this.stations[this.stations.length - 1];
    const c = sink.in;
    // 구분 적재장: 제품별 구역이 가득 차면 그 제품만 막힌다
    const head = c.items[0]?.item;
    if (this.zone ? head && !head.scrap && this.fgBy[head.product] >= FG_ZONE_CAP : this.fgStock >= FG_CAP) { sink.state = 'FULL'; sink.c.blocked += dt; return; }
    // 하역 위치에 앞서 내린 AMR이 아직 있으면 기다린다 (AMR끼리 겹치지 않게)
    const occupied = this.carriers.some((k) => k.state === 'return' && Math.hypot(k.x - sink.x, k.z - sink.z) < 1.7);
    if (this.frontReady(c) && !occupied && head?.scrap) {
      const { item } = c.items.shift();
      this.releaseCarrier(item, sink.def);
    } else if (this.frontReady(c) && !occupied) {
      const { item } = c.items.shift();
      if (item.defect) this.stats.escaped++; else { this.stats.good++; if (item.product) this.stats.goodBy[item.product] = (this.stats.goodBy[item.product] ?? 0) + 1; }
      if (item.product) this.fgBy[item.product]++;
      this.releaseCarrier(item, sink.def);
      this.fgStock++;
      sink.c.processed++;
      sink.lastIn = this.time;
    }
    sink.state = this.time - (sink.lastIn ?? -99) < 12 ? 'BUSY' : 'IDLE';
  }

  hazard(st) {
    return 0.00008 + 0.02 * Math.pow(Math.max(0, (60 - st.health) / 60), 2);
  }

  // ── AMMR: 작업 ↔ 부품 선반 왕복 ─────────────────
  // phase: work → turnOut → driveOut → pick(선반 재고가 없으면 waitRack) → turnIn → driveIn → work
  ammrWorking(st) { return st.ammr.filter((u) => u.phase === 'work' && u.bin > 0).length; }
  updateAMMR(st, dt) {
    const halted = st.state === 'DOWN' || st.state === 'MAINT';
    for (const u of st.ammr) {
      u.t += dt;
      if (u.phase === 'work') {
        const others = st.ammr.some((o) => o !== u && o.phase === 'work' && o.bin > 0);
        if (!halted && (u.bin <= 0 || (u.bin <= AMMR.reorder && (others || st.ammr.length === 1)))) { u.phase = 'turnOut'; u.t = 0; }
      } else if (u.phase === 'turnOut') { u.turn = Math.min(1, u.t / AMMR.turn); if (u.t >= AMMR.turn) { u.phase = 'driveOut'; u.t = 0; } }
      else if (u.phase === 'driveOut') { u.pos = Math.min(1, u.t / AMMR.drive); if (u.t >= AMMR.drive) { u.phase = 'pick'; u.t = 0; } }
      else if (u.phase === 'pick' || u.phase === 'waitRack') {
        if (st.parts != null && st.parts <= 0) {   // 선반이 비었으면 보충(휴머노이드)을 기다린다
          if (u.phase !== 'waitRack') {
            this.log('warn', `${st.name} AMMR #${u.i + 1} 선반 재고 없음`, { obs: '부품 선반 비어 있음 — 보충 대기', act: st.partsReq ? '보충 휴머노이드 배정됨' : '보충 요청' });
            const o = this.orch;
            if (!o.find(`rack:${st.id}`)) {
              const inc = o.open('parts', `rack:${st.id}`, `${st.name} 부품 선반 결품`, `${st.name} AMMR #${u.i + 1}`);
              o.step(inc, 'field', 'detect', `AMMR #${u.i + 1} 선반 재고 0 감지`);
              o.step(inc, 'cell', 'self', '셀 자체 조치: 다른 AMMR로 작업 지속 · 선반 앞 대기');
              o.later(0.5, () => o.step(inc, 'cell', 'report', '상위 보고: 선반 보충 필요'));
              o.later(o.latency, () => { o.step(inc, 'orch', 'decide', `판단(${o.name}): 선반 보충 우선 배정`); o.step(inc, 'orch', 'command', '명령: 부품 보충 휴머노이드 선반 보충'); });
            }
          }
          u.phase = 'waitRack'; u.t = 0; continue;
        }
        if (u.phase === 'waitRack') { u.phase = 'pick'; u.t = 0; }
        if (u.t >= AMMR.pick) {
          const take = Math.min(AMMR.bin - u.bin, st.parts ?? Infinity);
          u.bin += take; u.carry = true; u.trips++;
          if (st.parts != null) {
            st.parts -= take;
            if (st.parts <= this.mode.partsReorder && !st.partsReq) { st.partsReq = { st, helper: null }; this.partsReq.push(st.partsReq); }
          }
          u.phase = 'turnIn'; u.t = 0;
        }
      } else if (u.phase === 'turnIn') { u.turn = Math.max(0, 1 - u.t / AMMR.turn); if (u.t >= AMMR.turn) { u.phase = 'driveIn'; u.t = 0; } }
      else if (u.phase === 'driveIn') { u.pos = Math.max(0, 1 - u.t / AMMR.drive); if (u.t >= AMMR.drive) { u.phase = 'work'; u.t = 0; u.carry = false; } }
    }
  }

  updateStation(st, dt) {
    const m = this.mode;
    // 상위 명령으로 멈춘 셀 (비상정지·자가진단·보호정지): 작업물·로봇 자세를 그대로 두고 정지. 고장 수리·현장 정비는 계속
    const gate = this.cmd.stationGate(st);
    if (gate && st.state !== 'DOWN' && !(st.state === 'MAINT' && st.techOnSite)) {
      st.state = gate; st.c.stop = (st.c.stop ?? 0) + dt; st.ema += (0 - st.ema) * Math.min(1, dt / 90); return;
    }
    if (st.ammr) this.updateAMMR(st, dt * this.cmd.speedOf(st));
    if (st.state === 'DOWN' || st.state === 'MAINT') {
      if (st.state === 'DOWN') st.c.down += dt; else st.c.maint += dt;
      if (st.techOnSite && !this.cmd.locked(st)) {   // 비상정지 중에는 수리도 멈춘다
        st.repairRemaining -= dt;
        if (st.repairRemaining <= 0) this.finishRepair(st);
      }
      st.ema += (0 - st.ema) * Math.min(1, dt / 90);
      return;
    }
    if (st.parts === 0 && !st.item && !st.ammr) { st.state = 'NOPARTS'; st.c.starved += dt; st.starvedFor += dt; st.ema += (0 - st.ema) * Math.min(1, dt / 90); return; }
    let inC = null;
    // AMR 운반: 앞서 나간 AMR이 셀 중앙에서 충분히(AMR 간격 이상) 빠져나간 뒤에 다음 AMR을 받는다
    const cleared = !this.useAMR || Object.values(st.outs).every((c) => !c.items.length || c.items[c.items.length - 1].s >= c.spacing + 0.4);
    const cycleStop = st.cmd?.hold === 'cycle';   // 사이클 정지: 하던 작업만 마치고 새 작업은 받지 않는다
    if (!st.item && cleared && !cycleStop) for (const c of st.ins) if (this.frontReady(c) && (!inC || c.items[0].item.id < inC.items[0].item.id)) inC = c;
    if (inC) {
      const e = inC.items.shift();
      st.itemFrom = inC.path[inC.path.length - 1];   // 들어온 경로의 끝점 (합류 대기 차로는 중심선에서 비켜 있음)
      st.item = e.item; st.progress = 0; st.done = false; st.itemT = 0;
      const base = st.def.cycle * m.cycleMul * st.speedMul * (this.vla?.cycleFactor(st) ?? 1);   // 배포된 VLA 모델 버전만큼 사이클 단축
      st.cycleTime = st.item.scrap ? 0.5 : Math.max(base * 0.6, base * (1 + m.cycleVar * gauss(this.rand)));
    }
    if (!st.item && cycleStop) { st.state = 'CSTOP'; st.c.stop = (st.c.stop ?? 0) + dt; }
    else if (!st.item) {
      st.state = 'STARVED'; st.c.starved += dt; st.starvedFor += dt;
    } else {
      st.starvedFor = 0; st.itemT += dt;
      // AMMR 셀: 부품을 가지러 간 로봇만큼 작업 능력이 줄고, 모두 자리를 비우면 멈춘다
      const n = st.ammr?.length, nw = st.ammr ? this.ammrWorking(st) : 0;
      if (!st.done && st.ammr && nw === 0) { st.state = 'REFILL'; st.c.starved += dt; st.ema += (0 - st.ema) * Math.min(1, dt / 90); return; }
      if (!st.done) {
        st.state = 'BUSY'; st.c.busy += dt; st.powerSave = false;
        const cap = st.ammr ? (1 + PARALLEL_GAIN * (nw - 1)) / (1 + PARALLEL_GAIN * (n - 1)) : 1;
        st.progress += (dt / st.cycleTime) * cap * this.cmd.speedOf(st);
        if (this.rand() < this.hazard(st) * dt) { this.fail(st); return; }
        if (st.progress >= 1) { st.progress = 1; st.done = true; this.completeCycle(st); }
      }
      if (st.done && st.item) {
        const out = this.outFor(st, st.item);
        // 분기 셀(부품분류)은 출구 구간을 여러 연결이 함께 쓰므로, 모든 출구 앞이 비었을 때만 내보낸다
        if (this.hasSpace(out) && Object.values(st.outs).every((c) => this.hasSpace(c))) {
          out.items.push({ item: st.item, s: 0 });
          st.item = null; st.done = false; st.state = 'IDLE';
        } else { st.state = 'BLOCKED'; st.c.blocked += dt; }
      }
    }
    st.ema += ((st.state === 'BUSY' ? 1 : 0) - st.ema) * Math.min(1, dt / 90);
  }

  completeCycle(st) {
    const m = this.mode, it = st.item;
    if (it.scrap) return;   // 빈 AMR(불량 배출 후)은 작업 없이 통과
    st.c.processed++;
    if (st.ammr) {   // 작업 중인 AMMR이 번갈아 한 개씩 쓴다 (두 팔 로봇이 교대로 집어 조립)
      const ws = st.ammr.filter((k) => k.phase === 'work' && k.bin > 0);
      st.ammrRR = ((st.ammrRR ?? -1) + 1) % Math.max(1, st.ammr.length);
      const u = ws.find((k) => k.i >= st.ammrRR) ?? ws[0];
      if (u) { u.bin--; st.ammrRR = u.i; }
    } else if (st.parts != null) {
      st.parts = Math.max(0, st.parts - 1);
      if (st.parts <= m.partsReorder && !st.partsReq) { st.partsReq = { st, helper: null }; this.partsReq.push(st.partsReq); }
    }
    const wear = st.def.wear * m.wearMul * (st.speedMul < 1 ? 1.3 : 1) * ((st.cmd?.override ?? 1) > 1 ? 1.4 : 1) * (0.6 + this.rand() * 0.8);
    st.health = Math.max(0, st.health - wear);
    st.drift += this.rand() * 0.008 * m.wearMul;
    if (st.def.inspect) {
      it.inspected = true;
      if (it.defect && this.rand() < m.catchRate) {
        st.c.defects++;
        this.stats.rejected++;
        this.emit('reject', { item: { ...it, carrier: null }, st });
        if (it.carrier) {
          // AMR 운반: 불량품만 배출함으로 빼고, 빈 AMR은 정상 경로로 적재장까지 가서 복귀 흐름에 합류한다
          it.scrap = true; it.defect = false;
          return;
        }
        st.item = null; st.done = false;
        return;
      }
    } else {
      const p = (m.defectBase / 4) * (st.def.defectMul ?? 1) * (1 + (100 - st.health) / 50) * (1 + st.drift * 1.5) * (this.vla?.defectFactor(st) ?? 1);
      if (!it.defect && this.rand() < p) { it.defect = true; it.defectBy = st.id; st.c.defects++; }
    }
    if (st.def.effect === 'sort') it.sorted = true;
    else if (st.def.effect === 'press') it.pressed = true;
    else if (st.def.effect === 'fasten') it.fastened = true;
    else if (st.def.effect === 'machine') it.machined = true;
    else if (st.def.effect === 'assemble') it.assembled = true;
    else if (st.def.effect === 'paint') it.painted = true;
    else if (st.def.effect === 'pack') it.packed = true;
  }

  fail(st) {
    const m = this.mode;
    st.state = 'DOWN';
    st.repairRemaining = st.repairTotal = m.repairTime * (0.7 + this.rand() * 0.6);
    st.c.fails++; this.stats.failures++;
    // 인시던트: 현장 감지 → 셀 자체 조치 → 상위 보고 → (판단 지연 후) 판단·명령 → 정비 출동
    const o = this.orch, who = m.techKind === 'humanoid' ? '정비 휴머노이드' : '정비원';
    const inc = o.open('equipment', `fail:${st.id}`, `${st.name} 설비 고장`, st.name);
    o.step(inc, 'field', 'detect', m.agentActive ? `IoT 알람 — 건강도 ${st.health.toFixed(0)}%, 진동·전류 이상, 가동 정지` : `설비 정지 — 작업자가 이상을 발견하기까지 약 ${m.alarmDelay}초`);
    o.step(inc, 'cell', 'self', m.agentActive ? '셀 자체 조치: 비상 정지 · 작업물 보류 · 자가 진단 → 재가동 불가' : '셀 자체 조치 없음 (수동 설비)');
    const pending = !!st.request;
    if (pending) st.request.kind = 'repair';
    else if (!m.agentActive) this.requestTech(st, 'repair', m.alarmDelay + 5);   // 레거시: 발견 지연 → 반장 판단 후 정비반 호출
    o.later(m.agentActive ? 0.5 : m.alarmDelay, () => o.step(inc, 'cell', 'report', `${m.agentActive ? '상위 보고' : '작업자 → 반장 보고'}: 고장 · 예상 수리 ${Math.round(st.repairTotal)}초 · 하류 셀 자재대기 예상`));
    o.later(m.agentActive ? o.latency : m.alarmDelay + 5, () => {
      o.step(inc, 'orch', 'decide', `판단(${o.name}): 영향 분석 — 긴급수리 우선, 대기 중 투입 조정`);
      o.step(inc, 'orch', 'command', pending ? `명령: 진행 중이던 정비를 긴급수리로 전환` : `명령: ${who} 긴급수리 출동`);
      if (m.agentActive && !st.request && st.state === 'DOWN') this.requestTech(st, 'repair', 0);
    });
    this.emit('fail', { st });
    if (m.agentActive) {
      this.log('alert', `${st.name} 돌발 고장`, {
        obs: `IoT 알람 수신 — 건강도 ${st.health.toFixed(0)}%, 가동 정지`,
        act: `${m.techKind === 'humanoid' ? '정비 휴머노이드' : '정비원'} 즉시 호출 (예상 수리 ${Math.round(st.repairTotal)}초)`,
      });
    } else {
      this.log('alert', `${st.name} 설비 정지`, {
        obs: `작업자가 이상을 발견하기까지 약 ${m.alarmDelay}초 지연`,
        act: `정비반 호출 (사후보전, 예상 수리 ${Math.round(st.repairTotal)}초)`,
      });
    }
  }

  injectFault(st) {
    if (!st || !st.def.cycle || st.state === 'DOWN') return false;
    if (st.state === 'MAINT') return false;
    this.fail(st);
    return true;
  }

  requestTech(st, kind, delay = 0) {
    if (st.request) return false;
    if (kind !== 'repair' && this.cmd.stationGate(st)) return false;   // 명령으로 멈춘 셀에는 정비·보정을 새로 걸지 않는다 (수리 요청은 접수)
    st.request = { st, kind, readyAt: this.time + delay, tech: null };
    this.requests.push(st.request);
    return true;
  }

  selfCalibrate(st) {
    if (st.request || st.state === 'DOWN' || st.state === 'MAINT' || this.cmd.stationGate(st)) return false;
    st.request = { st, kind: 'cal', self: true };
    const o = this.orch, inc = o.open('quality', `cal:${st.id}`, `${st.name} 공정 편차`, st.name, { cellResolved: true });
    o.step(inc, 'field', 'detect', `SPC 공정능력 Cpk 저하 감지 (드리프트 ${(st.drift * 100).toFixed(0)}%)`);
    o.step(inc, 'cell', 'self', '셀 자체 조치: 폐루프 자율 보정 (10초) — 상위 보고 불필요');
    st.state = 'MAINT'; st.maintKind = 'cal'; st.techOnSite = true;
    st.repairRemaining = st.repairTotal = 10;
    return true;
  }

  assignTechs() {
    for (const req of this.requests) {
      if (req.tech || this.time < req.readyAt) continue;
      const st = req.st;
      let best = null, bd = 1e9;
      for (const t of this.techs) {
        if (!t.idle) continue;
        const d = Math.abs(t.x - st.x) + Math.abs(t.z - st.z);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) continue;
      req.tech = best;
      if (req.kind === 'repair') this.orch.step(this.orch.find(`fail:${st.id}`), 'exec', 'act', `${best.id} 배정 · 출동`);
      const kindLabel = { repair: '긴급수리', pm: '예지정비', cal: '재보정' }[req.kind];
      best.setTask(`${kindLabel} → ${st.name}`, [
        { go: svcLoc(st) },
        { do: () => this.techArrive(req) },
        { until: () => !st.request },
        { go: best.home },
      ]);
    }
  }

  techArrive(req) {
    const st = req.st, m = this.mode;
    if (req.kind === 'repair') this.orch.step(this.orch.find(`fail:${st.id}`), 'exec', 'act', `${req.tech?.id ?? '정비'} 현장 도착 · 수리 시작`);
    st.techOnSite = true;
    if (st.state !== 'DOWN') {
      st.state = 'MAINT'; st.maintKind = req.kind;
      st.repairRemaining = st.repairTotal = req.kind === 'pm' ? (m.pmTime || 90) * (0.8 + this.rand() * 0.4) : 15;
    }
  }

  finishRepair(st) {
    const kind = st.state === 'DOWN' ? 'repair' : st.maintKind;
    const o = this.orch;
    if (kind === 'repair') { const inc = o.find(`fail:${st.id}`); o.step(inc, 'exec', 'act', `수리 완료 — 건강도 회복`); o.later(0.5, () => o.close(inc, '복구 확인 · 생산 재개 · 인시던트 종료')); }
    else if (kind === 'cal' && st.request?.self) { const inc = o.find(`cal:${st.id}`); o.step(inc, 'cell', 'act', '자율 보정 완료 — 드리프트 0'); o.step(inc, 'orch', 'notify', '결과 통보 수신 (상위 조치 불필요)'); o.close(inc, '셀 자체 해결 · 종료'); }
    if (kind === 'repair') { st.health = 90 + this.rand() * 10; st.drift = 0; }
    else if (kind === 'pm') { st.health = 100; st.drift = 0; this.stats.pm++; }
    else { st.drift = 0; st.health = Math.min(100, st.health + 4); this.stats.cal++; }
    st.state = st.item ? (st.done ? 'BLOCKED' : 'BUSY') : 'STARVED';
    st.techOnSite = false; st.maintKind = null;
    this.requests = this.requests.filter((r) => r !== st.request);
    st.request = null;
    this.emit('repaired', { st, kind });
    const label = { repair: '수리 완료', pm: '예지정비 완료', cal: '재보정 완료' }[kind];
    this.log('ok', `${st.name} ${label}`, { obs: `건강도 ${st.health.toFixed(0)}% 회복, 라인 재가동` });
  }

  // 휴머노이드가 부품 선반을 채우는 자리: 선반 바깥쪽 (셀 옆쪽 선반이면 선반 뒤, 긴 쪽 선반이면 선반 옆)
  rackServiceLoc(st) {
    const p = st.ammrRacks?.[0];
    if (!p || p.mode === 'z') return localLoc(st.def, -2.4, AMMR.rackZ, `${st.name} 부품 선반`);
    return localLoc(st.def, p.rack.x + p.dir * 0.9, p.rack.z, `${st.name} 부품 선반`);   // 선반 뒤 (통로·AMR 경로와 떨어진 쪽)
  }

  // ── 무인공장: 휴머노이드 부품 보충 ─────────────────
  assignHelpers() {
    for (const req of this.partsReq) {
      if (req.helper) continue;
      const h = this.helpers.find((k) => k.idle); if (!h) return;
      const st = req.st; req.helper = h;
      h.setTask(`부품 보충 → ${st.name}`, [
        { go: h.pick },
        { wait: 4, done: () => { h.carry = true; } },
        { go: st.ammr ? this.rackServiceLoc(st) : localLoc(st.def, -1.0, SVC_Z, st.name) },   // AMMR 셀은 부품 선반 옆
        { wait: 5, done: () => {
          h.carry = false; st.parts = this.mode.partsCap; st.partsReq = null;
          { const inc = this.orch.find(`rack:${st.id}`); this.orch.step(inc, 'exec', 'act', `${h.id} 선반 보충 완료 (${this.mode.partsCap}개)`); this.orch.close(inc, '선반 재고 회복 · 인시던트 종료'); }
          this.partsReq = this.partsReq.filter((r) => r !== req);
          this.stats.refills = (this.stats.refills ?? 0) + 1;
        } },
        { go: h.home },
      ]);
    }
  }

  // ── 무인공장: 사족보행 순찰 점검 (열화상·진동·소음) ─────────────────
  planPatrol(q) {
    const list = this.processing;
    if (!list.length) return;
    // 배터리가 30% 아래면 순찰 전에 충전 스테이션으로 돌아가 가득 찰 때까지 도킹 충전
    if (q.battery < 30) {
      this.log('info', `${q.id} 충전 스테이션 복귀`, { obs: `배터리 ${q.battery.toFixed(0)}%`, act: '도킹 충전 후 순찰 재개' });
      q.target = null;
      q.setTask('충전 스테이션 복귀', [{ go: q.home }, { do: () => { q.heading = Math.PI; q.task = '도킹 충전'; } }, { charge: true }]);
      return;
    }
    // 다른 순찰 로봇이 향하는 설비는 건너뛴다 (같은 곳에 몰리지 않게)
    const taken = new Set(this.quads.filter((o) => o !== q).map((o) => o.target));
    let st = list[q.round % list.length];
    for (let k = 0; k < list.length && taken.has(st); k++) st = list[++q.round % list.length];
    q.round += 1; q.target = st;
    q.setTask(`순찰 점검 → ${st.name}`, [
      { go: localLoc(st.def, st.ammrRacks?.some((r) => r.mode === 'x' && r.dir > 0 && r.side > 0) ? 1.95 : 3.0, SVC_Z, st.name) },   // 정비 위치(0.9)와 떨어진 셀 옆 모서리에서 점검 (그 모서리에 AMMR 부품 선반이 있으면 안쪽으로)
      { do: () => { q.scanning = st; } },
      { wait: 4, done: () => { q.scanning = null; this.patrolScan(q, st); } },
    ]);
  }
  patrolScan(q, st) {
    st.lastScan = this.time;
    this.stats.scans = (this.stats.scans ?? 0) + 1;
    if (st.request || st.state === 'DOWN' || st.state === 'MAINT') return;
    if (st.health < this.mode.pmThreshold + this.mode.scanPm) {
      if (this.requestTech(st, 'pm')) {
        this.log('plan', `${q.id} 순찰 이상 징후 · ${st.name}`, {
          obs: `열화상·진동 스캔 — 베어링 온도 상승, 진동 RMS 증가 (건강도 ${st.health.toFixed(0)}%)`,
          dec: 'IoT 임계치 도달 전 선제 정비',
          act: '정비 휴머노이드에 예지정비 배정',
        });
      }
    } else if (st.drift > 0.15 && !st.def.inspect) {
      if (this.selfCalibrate(st)) this.log('plan', `${q.id} 순찰 · ${st.name} 미세 편차`, { obs: `치수·토크 편차 드리프트 ${(st.drift * 100).toFixed(0)}%`, act: '셀 자율 재보정' });
    }
  }

  // ── 현장 이벤트: 발생 → 로봇 카메라 AI 감지 → 자율 대응 ─────────────────
  injectFieldEvent(type, x, z) {
    const E = FIELD_EVENTS[type]; if (!E) return null;
    this.fieldEvents ??= []; this.fieldSeq = (this.fieldSeq ?? 0) + 1;
    const ev = { id: this.fieldSeq, type, label: E.label, cls: E.cls, severity: E.severity, x, z, t0: this.time, detected: false, cleared: false };
    this.fieldEvents.push(ev);
    return ev;
  }
  // 로봇 카메라 영상에서 처음 인식했을 때 (by: 이동체·로봇 이름, conf: 추론 신뢰도)
  detectFieldEvent(ev, by, conf) {
    if (ev.detected || ev.cleared) return;
    ev.detected = true; ev.detectedBy = by; ev.conf = conf; ev.tDetect = this.time;
    const o = this.orch, inc = o.open('field', `ev:${ev.id}`, `현장 이벤트 · ${FIELD_EVENTS[ev.type].label}`, by);
    ev.inc = inc;
    o.step(inc, 'field', 'detect', `${by} 카메라 AI 추론 — ${FIELD_EVENTS[ev.type].cls} 신뢰도 ${conf.toFixed(2)}`);
    o.step(inc, 'cell', 'self', ev.type === 'intrusion' ? '자체 조치: 주변 로봇 협동 감속 · 접근 금지 구역 표시' : '자체 조치: 감지 로봇 감속·우회 · 해당 구역 표시');
    o.later(0.5, () => o.step(inc, 'cell', 'report', `상위 보고: ${FIELD_EVENTS[ev.type].label} · 위치 x ${ev.x.toFixed(1)}, z ${ev.z.toFixed(1)}`));
    const E = FIELD_EVENTS[ev.type], where = `x ${ev.x.toFixed(1)} · z ${ev.z.toFixed(1)}`;
    const near = this.processing.reduce((b, st) => (Math.hypot(st.x - ev.x, st.z - ev.z) < Math.hypot(b.x - ev.x, b.z - ev.z) ? st : b), this.processing[0]);
    const loc = { x: ev.x, z: ev.z + (ev.z >= 0 ? 1.0 : -1.0), aisle: ev.z >= 0 ? 'F' : 'B', name: E.label };
    let act = '';
    const dispatch = () => {
    if (E.response === 'clean') {
      const h = [...this.helpers, ...this.techs].filter((k) => k.kind === 'humanoid').sort((a, b) => (b.idle - a.idle) || (Math.hypot(a.x - ev.x, a.z - ev.z) - Math.hypot(b.x - ev.x, b.z - ev.z)))[0];
      if (h) {
        const resume = h.idle ? [] : h.steps;   // 하던 일은 처리 후 이어서
        h.setTask(`${E.task} → ${near.name} 앞`, [{ go: loc }, { do: () => o.step(inc, 'exec', 'act', `${h.id} 현장 도착 · ${E.task} 시작`) },
          { wait: 8, done: () => { ev.cleared = true; ev.tClear = this.time; this.log('ok', `${E.label} 처리 완료`, { obs: `${h.id}가 ${E.task} 완료`, act: '구역 정상화' }); o.step(inc, 'exec', 'act', `${E.task} 완료`); o.close(inc, '구역 정상화 확인 · 인시던트 종료'); } }, ...resume, ...(resume.length ? [] : [{ go: h.home }])]);
        ev.responder = h.id; act = `${h.id} 출동 — ${E.task} (작업 중이던 일은 처리 후 재개)`;
      }
    } else if (E.response === 'inspect') {
      const q = this.quads.slice().sort((a, b) => Math.hypot(a.x - ev.x, a.z - ev.z) - Math.hypot(b.x - ev.x, b.z - ev.z))[0];
      if (q) {
        q.setTask(`${E.task} → ${near.name} 부근`, [{ go: loc }, { do: () => { q.scanning = near; o.step(inc, 'exec', 'act', `${q.id} 현장 도착 · 열화상·가스 센서 점검`); } }, { wait: 6, done: () => {
          q.scanning = null; ev.cleared = true; ev.tClear = this.time;
          this.log('ok', `${E.label} 확인 — 이상 없음`, { obs: `${q.id} 열화상·가스 센서 점검: 발열·연소 흔적 없음 (스팀 오인 추정)`, act: '알람 해제' });
          o.step(inc, 'exec', 'act', '점검 결과: 발열·연소 흔적 없음 (스팀 오인)');
          this.resumeCells(ev, inc, '오탐 확인 · 알람 해제 · 인시던트 종료');
        } }]);
        ev.responder = q.id; act = `${q.id} 출동 — 열화상·가스 센서 정밀 점검`;
      }
    } else {
      ev.until = this.time + 60;
      act = '주변 셀 안전 감속 25% 긴급 명령 · 접근 금지 구역 설정, 원격 관제 요원 호출';
    }
    o.step(inc, 'orch', 'decide', `판단(${o.name}): ${E.response === 'clean' ? '작업 경로 안전 위협 — 즉시 제거' : E.response === 'inspect' ? '화재 초기 징후 가능성 — 근접 확인' : '무인 구역 사람 진입 — 안전 우선'}`);
    o.step(inc, 'orch', 'command', `명령: ${act || '대응 자원 없음 — 원격 관제 호출'}`);
    // 긴급 명령을 셀 현장으로 보낸다: 사람 진입 → 주변 셀 안전 감속, 연기 의심 → 가장 가까운 셀 보호정지 (해소되면 재개 명령)
    ev.cmdCells = E.response === 'safety' ? this.processing.filter((st) => !st.standby && Math.hypot(st.x - ev.x, st.z - ev.z) < 9).map((st) => st.id) : E.response === 'inspect' ? [near.id] : [];
    if (!ev.cmdCells.length && E.response === 'safety') ev.cmdCells = [near.id];
    for (const id of ev.cmdCells) this.cmd.issue(E.response === 'safety' ? 'SAFE_SPEED' : 'SAFE_STOP', id, null, { inc, why: E.label });
    this.log('alert', `오케스트레이터 명령 · ${E.label}`, { obs: `${by} 보고 수신`, dec: `${o.name} 판단`, act });
    };
    o.later(o.latency, dispatch);
    this.log('alert', `AI 비전 감지 · ${E.label}`, {
      obs: `${by} 카메라 영상 추론 — ${E.cls} 신뢰도 ${conf.toFixed(2)} · ${near.name} 부근 (${where})`,
      dec: '셀·로봇 자체 조치 후 공장 오케스트레이터에 보고',
      act: `오케스트레이터 판단 대기 (약 ${o.latency}초)`,
    });
  }
  // 현장 이벤트로 멈추거나 감속한 셀에 재개 명령을 보내고, 셀 완료 보고를 받은 뒤 인시던트를 닫는다
  resumeCells(ev, inc, closeText) {
    const code = ev.type === 'intrusion' ? 'SAFE_SPEED_OFF' : 'RESUME';   // 감속은 감속 해제, 보호정지는 운전 재개
    const o = this.orch, cs = (ev.cmdCells ?? []).map((id) => this.cmd.issue(code, id, null, { inc, why: `${ev.label} 해소` })).filter(Boolean);
    if (!cs.length) return o.close(inc, closeText);
    const wait = () => (cs.every((c) => c.state === 'done' || c.state === 'rejected') ? o.close(inc, closeText) : o.later(0.3, wait));
    wait();
  }
  updateFieldEvents() {
    if (!this.fieldEvents?.length) return;
    for (const ev of this.fieldEvents) {
      if (!ev.cleared && ev.until && this.time >= ev.until) {
        ev.cleared = true; ev.tClear = this.time; this.log('ok', `${ev.label} 해소`, { obs: '진입자 구역 이탈 확인', act: '로봇 정상 속도 복귀' });
        this.orch.step(ev.inc, 'exec', 'act', '진입자 구역 이탈 확인');
        this.resumeCells(ev, ev.inc, '안전 확인 · 인시던트 종료');
      }
      if (!ev.cleared && !ev.detected && this.time - ev.t0 > 600) ev.cleared = true;   // 10분 동안 아무도 못 보면 정리
    }
    this.fieldEvents = this.fieldEvents.filter((e) => !e.cleared || this.time - e.tClear < 2);
  }

  // ── 물류 작업 ─────────────────────────────
  dispatchSupply(v) {
    this.inboundRaw += PALLET_RAW;
    v.setTask('자재 공급', [
      { go: LOC.WH },
      { until: () => this.time >= this.supplyDisruptedUntil, task: '출고 대기 (공급 차질)' },
      { wait: 4, done: () => { v.load = { type: 'raw', n: PALLET_RAW }; } },
      { go: this.loc.SRC },
      { wait: 4, done: () => {
        this.rawStock = Math.min(RAW_CAP, this.rawStock + PALLET_RAW);
        this.inboundRaw -= PALLET_RAW; v.load = null; this.stats.supplyTrips++;
      } },
    ]);
  }
  // 안전재고 긴급 운송 — 창고 내 별도 보관분이라 출고 중단과 무관하게 실을 수 있다
  dispatchSafety(v, n) {
    this.safetyStock -= n; this.inboundRaw += n;
    v.setTask('안전재고 긴급 운송', [
      { go: LOC.WH },
      { wait: 4, done: () => { v.load = { type: 'raw', n }; } },
      { go: this.loc.SRC },
      { wait: 4, done: () => {
        this.rawStock = Math.min(RAW_CAP, this.rawStock + n); this.inboundRaw -= n; v.load = null; this.stats.supplyTrips++;
        const inc = this.orch.find('supply'); this.orch.step(inc, 'exec', 'act', `${v.id} 안전재고 ${n}개 투입구 도착 (재고 ${this.rawStock}개)`);
      } },
    ]);
  }
  dispatchCharge(v) { v.setTask('충전', [{ go: v.home }, { charge: true }]); }

  disruptSupply(sec) {
    this.supplyDisruptedUntil = Math.max(this.supplyDisruptedUntil, this.time + sec);
    const o = this.orch;
    if (o.find('supply')) return;
    const inc = o.open('supply', 'supply', '자재 공급 차질', '자재창고');
    o.step(inc, 'field', 'detect', `창고 출고 중단 감지 (WMS) — 복구 예상 ${Math.round(sec / 60)}분`);
    o.step(inc, 'cell', 'self', `투입 스테이션 자체 조치: 버퍼 재고 ${this.rawStock}개로 투입 유지`);
    o.later(0.5, () => o.step(inc, 'cell', 'report', `상위 보고: 재고 소진 예상 ${Math.round(this.rawStock * this.releaseInterval / 60)}분 · 라인 정지 위험`));
    if (!this.mode.agentActive) o.later(o.latency, () => { o.step(inc, 'orch', 'decide', '판단(작업반장): 대체 자재 수배 필요'); o.step(inc, 'orch', 'command', '명령: 구매 담당 전화 수배 · 지게차 대기'); });
  }
  // 운영 에이전트가 공급 차질에 대응했을 때 (판단·명령 단계로 기록)
  supplyCommand(act) {
    const o = this.orch, inc = o.find('supply'); if (!inc) return;
    o.later(Math.max(0, o.latency - 0.5), () => {
      o.step(inc, 'orch', 'decide', `판단(${o.name}): 공급 복구 전 재고 소진 — 라인 정지 회피 필요`);
      o.step(inc, 'orch', 'command', `명령: ${act ?? 'SCM 대체 발주 · AGV 우선 배차'}`);
      o.step(inc, 'exec', 'act', 'AGV 안전재고 운송 출발 · 다른 AGV는 창고에서 출고 대기');
    });
  }
  get supplyDisrupted() { return this.time < this.supplyDisruptedUntil; }
  // 경보 표시용: 출고 재개 후에도 자재가 투입구에 도착할 때까지 공급 차질로 본다
  get supplyAlarm() { return this.supplyDisrupted || !!this.orch.find('supply'); }

  // ── 에너지 ─────────────────────────────
  accountEnergy(dt) {
    const m = this.mode;
    let kw = m.lightingKW + m.hvacKW + 2 + 2; // 조명 + 공조 + 투입/적재 설비
    for (const st of this.processing) {
      const d = st.def;
      if (st.state === 'BUSY') kw += d.busyKW;
      else if (st.state === 'DOWN' || st.state === 'MAINT') kw += d.idleKW * 0.5;
      else kw += st.powerSave ? d.idleKW * 0.3 : d.idleKW;
    }
    kw += this.conveyors.length * 0.5;
    for (const v of this.vehicles) {
      if (v.kind === 'forklift') kw += v.moving ? 6 : 0.3;
      else kw += v.charging ? 3 : v.moving ? 1.2 : 0.1;
    }
    for (const t of [...this.techs, ...this.helpers]) if (t.kind === 'humanoid') kw += t.moving ? 0.6 : 0.15;
    for (const q of this.quads) kw += q.moving ? 0.35 : q.scanning ? 0.2 : 0.05;
    for (const c of this.carriers) kw += c.state === 'line' || c.moving ? 0.6 : 0.1;
    this.powerKW = kw;
    this.stats.energy += (kw * dt) / 3600;
  }

  // ── 상태 평가 / KPI ─────────────────────────────
  assess(st) {
    const m = this.mode;
    const cyc = st.def.cycle * m.cycleMul;
    const rate = st.def.wear * m.wearMul * (60 / cyc) * Math.max(0.3, st.ema);   // 건강도 %/분
    const rul = Math.max(0, (st.health - 30) / Math.max(0.05, rate));
    const risk10 = 1 - Math.exp(-this.hazard(st) * 600 * Math.max(0.3, st.ema));
    const cpk = 1.67 / (1 + st.drift * 1.5);
    return { rul, risk10, cpk, util: st.c.busy / Math.max(1, this.time) };
  }

  kpi() {
    const t = Math.max(1, this.time), s = this.stats;
    const out = s.good + s.escaped;
    const inspected = out + s.rejected;
    const A = 1 - this.processing.reduce((a, st) => a + (st.c.down + st.c.maint) / t, 0) / this.processing.length;
    const Q = inspected ? s.good / inspected : 1;
    const OEE = Math.min(1, (s.good * this.idealCycle) / t);
    const P = A * Q > 0 ? Math.min(1, OEE / (A * Q)) : 0;
    let uphRecent = out / (t / 3600);
    const h = this.history;
    for (let i = 0; i < h.length; i++) {
      if (h[i].t >= this.time - 600) {
        const dtH = (this.time - h[i].t) / 3600;
        if (dtH > 60 / 3600) uphRecent = (out - h[i].out) / dtH;
        break;
      }
    }
    return {
      t, out, good: s.good, uph: out / (t / 3600), uphRecent, A, P, Q, OEE,
      wip: this.wip(), avgWip: s.wipInt / t, energy: s.energy, kwhPerUnit: out ? s.energy / out : 0,
      powerKW: this.powerKW, failures: s.failures, pm: s.pm, cal: s.cal, rejected: s.rejected, escaped: s.escaped,
      ppm: out ? (s.escaped / out) * 1e6 : 0, people: this.peopleOnSite(), shipped: s.shipped,
      raw: this.rawStock, fg: this.fgStock,
    };
  }
}
