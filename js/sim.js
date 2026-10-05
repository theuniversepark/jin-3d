// 제조 라인 시뮬레이션 엔진 — 렌더링과 분리되어 있어 헤드리스(고속 비교) 실행이 가능하다.
import { ImpactTracker } from './impact.js';
import { CommandCenter } from './commands.js';
import { TruckYard, planForklift, YARD } from './shipping.js';
import { InboundYard, planReceiver, WH, INBOUND } from './receiving.js';
import { PatrolDrone, MISSION_PRIO } from './drone.js';
import { planCCTV, CCTVAgent } from './cctv.js';
import { Private5G } from './net5g.js';
import { OdooBridge } from './odoo.js';
import { VLAPipeline } from './vla.js';
import { AIOSPipeline } from './aios.js';
import { Orchestrator, PRIORITY, prioOf } from './orchestrator.js';
import { AMMR, AMMR_FETCH, PARALLEL_GAIN, DEFAULT_LINE, buildStationDefs, linkPath, lineEdges, pathLength, pointAt, toWorld, isZone, ZONE_AMR, ZONE_MIXES, ZONE_PRODUCTS, FG_ZONE_CAP, amrPark, AMR_DOCK, amrDockVia, amrReturnVia } from './line.js';

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
    repairTime: 160, pmTime: 0, pmEnabled: false, alarmDelay: 10, andon: true,   // 설비 알람 자동 호출(안돈): 고장 발견·호출 35초 → 10초 — KPI 영향·개선 제안 적용 (2시간 × 시드 3 고장 정지 −12% · WIP −7%)
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
    amrStage: 2,   // AMR 선행 배차 2대 — KPI 영향·개선 제안 트윈 검증(UPH 362 → 423 · kWh/개 −10%)으로 적용
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
    drones: 3,   // 순찰 드론 — 시설 크기(순찰 주기)·인시던트 출동률로 산정 (drone.js DRONE_SIZING)
    reorderPoint: 14, shipBatch: 12, dispatchDelay: 0, releaseInterval: 8.3,
    agentArch: 'hybrid',   // 자율운영 에이전트 구조: 혼합형 다중 에이전트 (반사 계층 + 정비·품질·흐름 에이전트 + 메인 조정자, js/multiagent.js)
    releaseMargin: 0.94,   // 투입 간격 = 병목 사이클 × 0.94 — KPI 영향·개선 제안(투입 간격 단축) 적용: 2시간 × 시드 3 UPH 473 → 475 · WIP 그대로
    lightingKW: 6, hvacKW: 7, agentActive: true,   // 고효율 LED 구역 조명
  },
};

// 현장 이벤트 (피지컬AI 단계: 로봇 카메라 영상의 AI 추론으로 감지 → 자율 대응)
export const FIELD_EVENTS = {
  leak:      { label: '바닥 누유', cls: '누유', severity: 'alarm', response: 'clean', task: '누유 흡착·세척', radius: 1.3, prio: 2 },
  debris:    { label: '바닥 이물질', cls: '이물질', severity: 'warn', response: 'clean', task: '이물질 수거', radius: 1.0, prio: 2 },
  intrusion: { label: '안전구역 무단 진입', cls: '사람', severity: 'alarm', response: 'safety', task: '', radius: 2.2, prio: 1 },
  smoke:     { label: '연기 의심', cls: '연기', severity: 'alarm', response: 'inspect', task: '열화상 정밀 점검', radius: 1.8, prio: 1 },
};

// 정비실 도구 세트 — 정비원·정비 휴머노이드가 상황에 맞는 도구를 정비실에서 챙겨 출동하고, 처리 후 반납한다
// at: 정비실 안 보관 위치(정비실 기준 로컬 x, 앞쪽 픽업 z) — 공구 카트·작업대 / 청소 코너 / 소화기
export const TOOL_KITS = {
  repair: { label: '수리 공구 세트', items: '공구함 · 토크렌치 · 멀티미터', vis: 'toolbox', at: -1.15 },
  pm:     { label: '예지정비 키트', items: '진동 분석기 · 그리스 건 · 교체 부품', vis: 'diag', at: 0.35 },
  cal:    { label: '보정 키트', items: '다이얼 게이지 · 보정 지그', vis: 'diag', at: 0.35 },
  leak:   { label: '누유 처리 키트', items: '흡착재 키트 · 대걸레 · 버킷', vis: 'mop', at: 4.35 },
  debris: { label: '이물질 수거 도구', items: '빗자루 · 쓰레받기 · 수거함', vis: 'broom', at: 4.35 },
  smoke:  { label: '소화기', items: '분말 소화기', vis: 'extinguisher', at: -1.3 },   // 왼쪽 끝 충전 스테이션과 떨어지게
};
const TECH_ROOM = { x: 12.8, z: 16.5 };   // 정비실 기준점 (factory.js 정비실 그룹과 같은 자리)
export const toolSpot = (kit) => ({ x: TECH_ROOM.x + TOOL_KITS[kit].at, z: 15.15, aisle: 'F', name: `정비실 ${TOOL_KITS[kit].label} 보관대` });
// 정비실 동선: 정비 휴머노이드 충전 스테이션은 정비실 양쪽 끝(서로 마주 봄), 도구 보관대는 안쪽 줄(z 15.15)
// 정비실에 드나들 때는 가운데 통로(x 14.1)를 지나고, 보관대는 안쪽 줄을 따라 옆으로 간다 — 충전 스테이션 앞을 지나지 않는다
const TECH_DOCKS = [{ x: 10.95, z: 14.0, heading: Math.PI / 2 }, { x: 17.25, z: 14.0, heading: -Math.PI / 2 }];
const ROOM_MID_X = TECH_ROOM.x + 1.3, ROOM_IN_Z = 15.15, ROOM_FRONT_Z = 12.5, ROOM_LANE_Z = 14.0;
const ROOM_IN_X = ROOM_MID_X - 0.5, ROOM_OUT_X = ROOM_MID_X + 0.5;   // 가운데 통로는 일방통행 두 줄 — 들어갈 때 서쪽 줄, 나올 때 동쪽 줄 (드나드는 동료와 정면으로 마주치지 않게)
const inTechRoom = (m) => m.z > 13.0 && m.z < 16.9 && m.x > TECH_ROOM.x - 2.6 && m.x < TECH_ROOM.x + 5.2;
const dockFront = (h) => ({ x: h.x + Math.sin(h.heading) * 1.1, z: h.z + Math.cos(h.heading) * 1.1 });
// 정비실 안에서 from → to: (스테이션이면 그 앞으로 나와) 가운데 통로 → 목적지 쪽 줄 → 목적지 (스테이션이면 그 앞에 선 뒤 들어감)
const roomWalk = (from, to) => {
  const P = (x, z) => ({ go: { x, z, aisle: 'F', name: '정비실 안' }, via: [] });
  const fromDock = TECH_DOCKS.find((d) => Math.hypot(from.x - d.x, from.z - d.z) < 0.5), toDock = to.heading != null && TECH_DOCKS.find((d) => Math.hypot(to.x - d.x, to.z - d.z) < 0.05);
  const s0 = fromDock ? dockFront(fromDock) : from, zt = toDock ? toDock.z : to.z;
  const lx = zt > s0.z ? ROOM_IN_X : ROOM_OUT_X;   // 안쪽(+z)으로 가면 들어가는 줄, 바깥쪽으로 가면 나오는 줄
  return [...(fromDock ? [P(s0.x, s0.z)] : []), P(lx, s0.z), P(lx, zt), ...(toDock ? [P(dockFront(toDock).x, zt)] : []), { go: to, via: [] }];
};
// 도구 챙기기 → (현장 작업) → 반납 단계
function toolSteps(sim, m, kit, inc) {
  const spot = toolSpot(kit), door = { x: ROOM_IN_X, z: ROOM_FRONT_Z, aisle: 'F', name: '정비실 앞 (들어가는 줄)' }, K = TOOL_KITS[kit];
  // 같은 보관대를 다른 사람이 쓰고 있거나 그리로 가는 중이면 들어가기 전 자리(충전 도크·정비실 앞)에서 기다린다 — 정비실 안쪽 줄에 서서 동료 길을 막지 않게
  const near = (o, p, r) => Math.hypot(o.x - p.x, o.z - p.z) < r;
  const free = () => !sim.movers.some((o) => o !== m && (o.kind === 'humanoid' || o.kind === 'human') && ((near(o, spot, 1.0) && !o.chgNow && !(o.idle && near(o, o.home, 0.3))) || (o.steps[0]?.go && near(o.steps[0].go, spot, 0.1))));   // 자기 충전 도크에 선 동료는 보관대를 쓰는 것이 아니다
  const wait = { until: free, task: `${K.label} 보관대 차례 대기` };
  const walkIn = inTechRoom(m) ? roomWalk(m, spot) : [{ go: door }, ...roomWalk(door, spot)];
  const exit = [{ go: { x: ROOM_OUT_X, z: ROOM_IN_Z, aisle: 'F', name: '정비실 안' }, via: [] }, { go: { x: ROOM_OUT_X, z: ROOM_FRONT_Z, aisle: 'F', name: '정비실 앞 (나오는 줄)' }, via: [] }];   // 보관대 → 나오는 줄 → 정비실 앞
  return {
    take: [...(inTechRoom(m) ? [wait] : [walkIn[0], wait]), ...walkIn.slice(inTechRoom(m) ? 0 : 1), { wait: 2, done: () => { m.tool = kit; if (inc) sim.orch.step(inc, 'exec', 'act', `${m.id} 정비실에서 ${K.label} 챙김 (${K.items})`); } }, ...exit],
    back: [{ go: door }, wait, ...roomWalk(door, spot), { wait: 1.5, done: () => { m.tool = null; } }],   // 차례 대기는 정비실 앞(들어가기 전)에서
    exit,
    home: (h) => (sim.techs.includes(m) ? roomWalk(spot, h) : [...exit, { go: h }]),   // 반납한 보관대에서 대기 자리(충전 도크)로 — 물류 휴머노이드는 자기 도크 진입 지점으로
  };
}

// 구분 적재장 적재 로봇: 사이클 3.2초(접근 → 집기 → 들어 올림 → 이동 → 내려놓기 → 복귀), 집는 순간 = 시작 후 1.05초 (factory.js 적재 로봇 키프레임과 같다)
export const SINK_PICK = { cycle: 3.2, grab: 1.05, enter: 1.3 };   // enter: 컨베이어 끝(입구)에서 가운데 정지 구간까지 AMR이 들어가는 시간

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
// 배터리로 움직이는 로봇 — 상세 정보 창의 배터리 상태(잔량·충방전·예상 가동·충전 방식)에 쓴다 (%/초)
// AGV(자동 충전 패드 복귀)·사족보행(도킹 충전 스테이션)·드론(이착륙장 무선 충전)은 기존 운용 규칙, AMR·휴머노이드·AMMR은 기회 충전
export const BATTERY = {
  agv: { pack: '48V 리튬인산철 · 3.2kWh', charge: '물류 대기 자동 충전 패드 (기준 이하면 복귀)', low: 25 },
  carrier: { pack: '24V 리튬이온 · 1.2kWh', charge: '정차 위치 무선 충전 (대기열·투입 스테이션·셀 정차 중 기회 충전)', low: 25, move: 0.04, idle: 0.004, rate: 0.11 },
  humanoid: { pack: '72V 리튬이온 · 2.0kWh (교체식)', charge: '대기 구역 무선 충전 · 30% 이하면 배터리 팩 자동 교체 (40초)', low: 30, move: 0.012, work: 0.008, idle: 0.002, rate: 0.06, swap: 40 },
  quadruped: { pack: '58V 리튬이온 · 0.9kWh', charge: '사족보행 충전 스테이션 도킹 (30% 이하 복귀)', low: 30 },
  drone: { pack: '6S 리튬폴리머 · 0.2kWh', charge: '이착륙장 무선 충전 (22% 이하 귀환)', low: 25 },
  ammr: { pack: '48V 리튬이온 · 2.4kWh', charge: '셀 작업 위치 도킹 접점 (작업 중 충전)', low: 25, drive: 0.06, work: 0.015, rate: 0.032 },
};
const LEFT = -35.5, RIGHT = 35;   // 좌우 끝 세로 통로 — 왼쪽은 투입 스테이션 AMR 진입로(x −30.6)와 충분히 떨어지게
export const LOC = {
  // 물류존은 건물 왼쪽 확장동(x −51 ~ −38)에 있다. 물류 선반은 왼쪽 벽 입고 지게차 통로와 로봇 통로(x −35.5) 사이에 남북으로 선
  // 통과형 선반(남쪽 절반 원자재 · 북쪽 절반 부품): 입고 지게차는 통로 쪽 서쪽 면에 넣고, AGV·휴머노이드는 동쪽 면에서 꺼낸다.
  // AGV는 앞쪽 통로(z 9)를 확장동까지 연장한 차로에서 곧장 북쪽으로 들어와 원자재 칸 앞에 선다 (투입구도 앞쪽 통로라 세로 통로를 건너지 않는다)
  WH: { x: -43.2, z: 0.9, aisle: 'F', name: '자재창고' },
  WH_PARTS: { x: -43.5, z: -2.6, aisle: 'F', name: '부품 랙' },
  WH_IN: { x: -47.5, z: 0.9, aisle: 'F', name: '자재창고 입고' },        // 입고 지게차: 선반 서쪽 면 원자재 칸 (지게차 통로 안)
  WH_PARTS_IN: { x: -47.5, z: -4.1, aisle: 'F', name: '부품 입고' },    // 입고 지게차: 선반 서쪽 면 부품 칸
  WH_LANE: -41.2,   // 부품 보충 휴머노이드의 선반 앞 진출입 세로 줄 (AGV 상차 자리 x −43.2를 비켜)
  WH_LANE_IN: -41.6, WH_LANE_OUT: -40.8,   // 일방통행 두 줄 — 선반으로 갈 때 서쪽 줄, 나올 때 동쪽 줄 (두 휴머노이드가 마주쳐 비켜서다 충전 도크 쪽으로 밀리지 않게)
  SRC: { x: -26, z: 4.2, aisle: 'F', name: '투입구' },
  SINK: { x: 29, z: 4.2, aisle: 'F', name: '완제품 적재장' },
  TECH: { x: 12, z: 13.5, aisle: 'F', name: '정비실' },
  CTRL: { x: -13.5, z: -12.5, aisle: 'B', name: '관제실' },   // 중앙 관제 디스플레이(x −13.5) 가운데 앞
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
const RADIUS = { dock: 0.5, agv: 0.8, forklift: 1.0, carrier: 0.8, robot: 0.6, quadruped: 0.55, humanoid: 0.35, human: 0.35, worker: 0.35 };
export const moverRadius = (m) => RADIUS[m.kind] ?? 0.5;
// 차체 폭(m) — 진로 안에 있는지(옆으로 비껴 지나갈 수 있는지) 판정용
const WIDTH = { dock: 0.95, agv: 1.1, forklift: 1.2, carrier: 0.95, robot: 0.9, quadruped: 0.5, humanoid: 0.6, human: 0.6, worker: 0.6 };
export const moverWidth = (m) => WIDTH[m.kind] ?? 0.8;
// 지게차 포크: 차체 중심에서 앞으로 1.9m(포크 끝), 포크 폭 반 0.42m + 여유 — 차체·포크를 선분(뒤 0.8 ~ 앞 1.45m) + 반폭 0.55m로 본다
export const FORK = { reach: 1.9, half: 0.55, back: 0.8, front: 1.45 };

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
    // 비켜선 자리에서 대기: 길을 비켜 준 상대가 지나갈 때까지(최대 2.5초, 상대가 2m 넘게 멀어지거나 멈추면 끝) 서 있는다 — 비켜섰다 곧바로 다시 막는 반복(라이브락) 방지
    if (this.holdFor) {
      this.holdT = (this.holdT ?? 0) + dt; const h = this.holdFor;
      if (this.holdT < 2.5 && h.moving && Math.hypot(h.x - this.x, h.z - this.z) < 2.0 + moverRadius(h)) { this.blockedOn = null; return true; }
      this.holdFor = null; this.holdT = 0;
    }
    // 교통 관제 우선 통행권: 15초 넘게 막히거나 비켜서기를 30번 넘게 되풀이하면(교착·라이브락) 4초 동안 우선 통행 — 다른 이동체가 기다린다
    if (this.passT > 0) {   // 우선 통행 중에도 지게차 차체·포크 자리에는 들어가지 않는다 (포크 간섭 방지)
      const b = this.sense?.(this, dir);
      if (b && (b.kind === 'forklift' || this.kind === 'forklift')) { this.blockedOn = b; return true; }
      this.blockedOn = null; return false;
    }
    if (this.blockT > 15 || this.detourPts > 30) {
      this.passT = 4; this.blockT = 0; this.detourPts = 0; this.passes = (this.passes ?? 0) + 1;
      if (this.path?.length) { const keep = this.path.filter((p) => !p.detour); this.path = keep.length ? keep : this.path.slice(-1); }   // 쌓인 우회점만 버리고 원래 길(통로·도크 앞)은 그대로 — 목적지로 대각선 직진하지 않는다
      return false;
    }
    const b = this.sense?.(this, dir);
    if (!b) { this.blockedOn = null; this.blockT = 0; return false; }
    this.blockedOn = b; this.blockT += dt;
    const off = moverRadius(this) + moverRadius(b) + 0.35;
    const cross = dir.x * (b.z - this.z) - dir.z * (b.x - this.x);
    const sgn = cross > 0 ? 1 : -1;   // 상대가 있는 쪽의 반대편
    const sd = { x: -dir.z * sgn, z: dir.x * sgn };
    // 비켜서기·돌아가기 점이 충전 도크 위면 반대쪽으로, 양쪽 다 막히면 그 자리에서 기다린다 (도크 뒤로 밀려 들어가 갇히지 않게)
    const step = (pts) => {
      if (this.dockAt && pts.some((p) => this.dockAt(p, this))) {
        const flip = pts.map((p) => { const vx = p.x - this.x, vz = p.z - this.z, a = vx * dir.x + vz * dir.z; return { ...p, x: this.x + 2 * a * dir.x - vx, z: this.z + 2 * a * dir.z - vz }; });
        if (flip.some((p) => this.dockAt(p, this))) return true;
        pts = flip;
      }
      this.path.unshift(...pts.map((p) => ({ ...p, detour: true }))); this.detourPts += pts.length; this.blockT = 0; return false;
    };
    if (b.blockedOn === this) {
      const bd = b.wantDir ?? { x: Math.sin(b.heading), z: Math.cos(b.heading) };
      if (dir.x * bd.x + dir.z * bd.z < -0.7) {
        // 정면으로 마주침(좁은 진입로): 우선순위가 낮은 쪽이 옆으로 비켜선다
        if (this.prio < b.prio && this.blockT > 0.3) return step([{ x: this.x + sd.x * off, z: this.z + sd.z * off, hold: b }]);   // 비켜선 자리에서 상대가 지나갈 때까지 기다린다
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
    // 할 일 없이 섰거나, 제자리에서 일하는 중(점검·대기·작업 — 이동 단계가 아님)인 상대가 내 목적지가 아닌 길을 막으면 1.5초 뒤 옆으로 돌아간다
    const parked = b.idle || (!b.moving && !b.steps[0]?.go) || !!b.hzWait;   // 진로 이벤트로 멈춰 기다리는 이동체도 정지 장애물로 보고 돌아간다
    // 내 목적지에서 다른 이동체가 일하고 있으면(같은 현장에 함께 출동 등) 그 바로 옆에서 멈춘 것으로 본다
    if (parked && atDest && !b.idle && Math.hypot(this.x - end.x, this.z - end.z) < moverRadius(this) + moverRadius(b) + 0.9) { this.path = [{ x: this.x, z: this.z }]; this.blockedOn = null; this.blockT = 0; return false; }
    if (parked && !atDest && this.blockT > 1.5) {
      const ahead = Math.hypot(b.x - this.x, b.z - this.z) + moverRadius(b) + moverRadius(this) + 0.3;
      return step([{ x: this.x + sd.x * off, z: this.z + sd.z * off }, { x: this.x + sd.x * off + dir.x * ahead, z: this.z + sd.z * off + dir.z * ahead }]);
    }
    // 순환 대기(A→B→C→A, 4대까지): 고리 안에서 우선순위가 가장 낮은 이동체가 2초 뒤 옆으로 비켜서서 기다린다
    { const ring = [this]; let c = b; while (c && ring.length < 5 && !ring.includes(c)) { ring.push(c); c = c.blockedOn; }
      if (c === this && ring.length >= 3 && this.blockT > 2 && ring.every((r) => r === this || r.prio > this.prio)) return step([{ x: this.x + sd.x * off, z: this.z + sd.z * off, hold: b }]); }
    // 12초 넘게 풀리지 않으면 세 대 이상이 서로 기다리는 순환 대기로 보고, 우선순위가 낮은 쪽이 옆으로 비켜선다
    if (this.blockT > 12 && this.prio < b.prio) return step([{ x: this.x + sd.x * off, z: this.z + sd.z * off, hold: b }]);
    return true;
  }
  get idle() { return this.steps.length === 0; }
  setTask(name, steps) { this.task = name; this.steps = steps; this.path = null; this.detourPts = 0; }   // 이동 중 재지시되면 새 경로로
  update(dt) {
    this.moving = false; this.charging = false;
    if (this.passT > 0 && !this.instant) this.passT -= dt;
    const st = this.steps[0];
    if (!st || !st.go) this.wantDir = null;
    if (!st) {
      this.task = null;
      // 할 일 없이 선 지게차는 통로 반대쪽(벽 쪽)을 보고 주차한다 — 포크가 통로·순찰로로 나오지 않게 (입고 지게차는 정해진 주차 방향)
      // 충전소에서는 옆(+x)을 보고 선다 — 앞뒤(+z 충전 기둥 · −z 순찰로)로 포크가 나오지 않게
      if (this.kind === 'forklift' && !this.receiver && this.loc?.aisle && AISLE[this.loc.aisle] != null) this.heading = this.loc.name === '충전소' ? Math.PI / 2 : this.loc.z > AISLE[this.loc.aisle] ? 0 : Math.PI;
      return;
    }
    if (!st.go && this.hazardOut?.(this)) return this.update(dt);   // 서서 일하던 자리에 현장 이벤트가 나면 반경 밖으로 비켜섰다가 해결 뒤 돌아와 이어 한다
    if (st.go) {
      if (!this.path) {
        this.path = st.via ? [...st.via, st.go].map((p) => ({ x: p.x, z: p.z })) : route(this.loc, st.go, this);
        // 직선 이동(via: [])이 충전 도크를 가로지르면(하던 일을 다른 자리에서 이어 갈 때 등) 정비실 앞으로 돌아가는 길로 다시 잡는다
        if (st.via && !st.via.length && st.go.x > 9 && st.go.x < 19 && this.dockHit?.(this, st.go)) this.path = roomWalk(this, st.go).map((x) => ({ x: x.go.x, z: x.go.z }));
        // 충전 도크가 있는 휴머노이드: 도크에서 나갈 때는 보는 방향(앞)으로 1.1m 걸어 나온 뒤, 돌아올 때는 도크 앞 1.1m 지점에 선 뒤 곧게 들어간다 — 도크 기둥·옆 도크를 지나가지 않는다
        // crossX(물류 대기존 옆 세로 통로): 위쪽(B) 통로 쪽 일은 아래쪽(F) 통로까지 올라갔다 내려오지 않고 도크 앞에서 바로 세로 통로로 오간다
        const H = this.home;
        if (this.kind === 'humanoid' && H?.heading != null) {
          const front = { x: H.x + Math.sin(H.heading) * 1.1, z: H.z + Math.cos(H.heading) * 1.1 };
          const atHome = Math.hypot(this.x - H.x, this.z - H.z) < 0.5, toHome = Math.hypot(st.go.x - H.x, st.go.z - H.z) < 0.05;
          const side = { x: H.crossX, z: front.z };
          if (atHome && !toHome) {
            if (H.crossX != null && !st.via && st.go.aisle === 'B') this.path = [{ ...front }, side, ...route({ ...side, aisle: 'B' }, st.go)];
            else this.path.unshift({ ...front });
          } else if (toHome && !atHome) {
            if (H.crossX != null && !st.via && this.loc?.aisle === 'B') this.path = [...route(this.loc, { ...side, aisle: 'B', name: `${H.name} 옆 통로` }, this), { ...front }, { x: H.x, z: H.z }];
            else this.path.splice(this.path.length - 1, 0, { ...front });
          }
        }
      }
      if (this.hazard?.(this, st)) { this.wantDir = null; return; }   // 진로 위 현장 이벤트: 우회하거나 해결될 때까지 정지 대기 (sim.moverHazard)
      let rem = this.speed * dt, checked = false;
      while (rem > 0 && this.path.length) {
        const p = this.path[0];
        const dx = p.x - this.x, dz = p.z - this.z, d = Math.hypot(dx, dz);
        if (d < 1e-4) { this.path.shift(); continue; }
        if (!checked) { checked = true; this.wantDir = { x: dx / d, z: dz / d }; if (this.yieldTo(this.wantDir, dt)) break; if (this.path[0] !== p) continue; }
        if (!st.rev) this.heading = Math.atan2(dx, dz);   // rev: 후진 — 차체 방향을 그대로 두고 뒤로 (지게차가 포크를 적재함에서 반듯이 빼낼 때)
        if (d <= rem) { this.x = p.x; this.z = p.z; rem -= d; this.dist += d; this.path.shift(); if (this.detourPts > 0) this.detourPts--; if (this.kind === 'forklift') checked = false; if (p.hold) { this.holdFor = p.hold; this.holdT = 0; break; } }   // 지게차: 꺾기 전에 새 방향으로 다시 감지 (포크가 옆으로 휩쓸지 않게)
        else { this.x += (dx / d) * rem; this.z += (dz / d) * rem; this.dist += rem; rem = 0; }
        this.moving = true;
      }
      if (!this.path.length) { this.path = null; this.loc = st.go; this.steps.shift(); this.detourPts = 0; }
    } else if ('wait' in st) {
      st.wait -= dt;
      if (st.wait <= 0) { st.done?.(); this.steps.shift(); }
    } else if (st.until) {
      if (st.task && this.task !== st.task) { st.prev = this.task; this.task = st.task; }   // 기다리는 동안 작업 표시를 바꾼다
      if (st.until()) { if (st.prev) this.task = st.prev; this.steps.shift(); if (this.steps.length && (this.instant = (this.instant ?? 0) + 1) < 8) return this.update(dt); }   // 시간이 안 드는 단계는 같은 틱에 이어서
    } else if (st.do) {
      st.do(); this.steps.shift();
      if (this.steps.length && (this.instant = (this.instant ?? 0) + 1) < 8) return this.update(dt);
    } else if (st.charge) {
      this.charging = true;
      this.battery = Math.min(100, this.battery + dt * (this.chargeRate ?? 1.6));
      if (this.battery >= 99.5) this.steps.shift();
    }
    this.instant = 0;
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
    // 물류존 창고 재고 — 입고 트럭이 채우고 AGV(원자재 → 자재 투입)·휴머노이드(부품 → 셀)가 꺼내 쓴다
    this.partsTracked = !!m.partsCap; this.whRaw = 200; this.whParts = this.partsTracked ? 1200 : 0;
    this.supplyDisruptedUntil = 0;
    this.releaseTimer = 0; this.releaseHold = false; this.releaseInterval = m.releaseInterval;
    this.powerKW = 0;
    this.requests = [];
    this.orch = new Orchestrator(this); this.cmd = new CommandCenter(this);
    this.impact = new ImpactTracker(this);   // 이벤트·문제 → UPH·OEE·WIP·POWER 영향 분석 · 개선 제안 · 의사결정 지원 (impact.js)   // 공장 오케스트레이터 (인시던트 보고·판단·명령)

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
    // 출하 지게차: 구분 적재장 → 뒷벽 출하 도크 → 트럭 야드 화물트럭 (레거시·자동화는 사람이 운전, 피지컬AI만 자율 지게차)
    this.forklifts = [new Mover(m.key === 'dark' ? '자율 지게차' : '출하 지게차 (유인)', 'forklift', { x: YARD.waitX, z: YARD.wallZ + 2.4, aisle: 'B', name: '출하 지게차 대기 (출하 도크 사이)' }, m.key === 'traditional' ? 1.5 : m.key === 'smart' ? 1.9 : 2.1)];
    this.forklifts[0].shipper = true; this.forklifts[0].auto = m.key === 'dark';
    // 입고 지게차: 입고 도크(왼쪽 벽)에 접안한 공급사 트럭에서 팔레트를 내려 자재창고 랙에 넣는다 (피지컬AI만 자율)
    const rcv = new Mover(m.key === 'dark' ? '입고 자율 지게차' : '입고 지게차 (유인)', 'forklift', { ...INBOUND.park, aisle: 'B', name: '입고 지게차 대기 (뒷벽 쪽)' }, m.key === 'traditional' ? 1.5 : m.key === 'smart' ? 1.9 : 2.1);
    rcv.receiver = true; rcv.auto = m.key === 'dark'; rcv.heading = INBOUND.park.heading; this.forklifts.push(rcv);   // 주차 방향: 뒷벽 쪽(북쪽)을 향해
    this.inbound = new InboundYard(this);
    this.yard = new TruckYard(this);
    // 피지컬AI: 순찰 드론 (지상 교통과 높이가 달라 movers에는 넣지 않는다)
    // 순찰 드론 대수: 시설 크기(순찰 주기)와 인시던트 출동률로 산정한 값 (README '드론 운용 대수 산정', MODES.dark.drones)
    const nd = opts.drones ?? m.drones ?? 1;
    this.drones = m.key === 'dark' ? Array.from({ length: nd }, (_, i) => new PatrolDrone(this, i, nd)) : [];
    this.techs = [];
    for (let i = 0; i < m.techs; i++) {
      const home = { ...LOC.TECH, ...TECH_DOCKS[i % TECH_DOCKS.length] };   // 정비실 양쪽 끝 충전 스테이션 (서로 마주 봄)   // 정비실 오른쪽 앞 대기 자리 — 도구 보관대로 드나드는 길(x 11~13.2, 17.2)과 떨어져 있다
      this.techs.push(new Mover(m.techKind === 'humanoid' ? `휴머노이드-정비${i + 1}` : `정비원-${i + 1}`, m.techKind, home, m.techSpeed));
    }
    // 무인공장: 부품 보충 휴머노이드 + 사족보행 순찰 로봇
    this.helpers = []; this.quads = []; this.partsReq = [];
    for (let i = 0; i < (m.helpers ?? 0); i++) {
      const h = new Mover(`휴머노이드-물류${i + 1}`, 'humanoid', { x: -39.55 + i * 1.7, z: 0.8, aisle: 'F', name: '부품 보충 대기', heading: 0, crossX: LEFT }, 1.6);   // 물류존과 오른쪽 로봇 통로 사이 대기존 (x −40.4 ~ −37.0)
      h.role = 'supply'; h.carry = false; h.pick = { ...LOC.WH_PARTS, z: LOC.WH_PARTS.z - i * 1.4 };   // 휴머노이드마다 피킹 자리 분리 (부품 칸을 따라 북쪽으로)
      this.helpers.push(h);
    }
    for (let i = 0; i < (m.quadrupeds ?? 0); i++) {
      const q = new Mover(`사족보행-${i + 1}`, 'quadruped', { x: 6 + i * 2, z: 13.5, aisle: 'F', name: '사족보행 충전 스테이션' }, 1.2);
      q.round = i; q.scanning = null;
      q.battery = 55 + this.rand() * 40; q.chargeRate = 0.45;   // 도킹 충전 약 0.45%/초 (20→95% 약 3분)
      this.quads.push(q);
    }
    if (m.partsCap) for (const st of this.processing) { st.parts = m.partsCap; st.partsReq = null; }
    // AMMR 셀: 대상물 하나마다 옆 부품 선반에서 부품을 가져와 작업한다 (레거시 단계는 사람이 대신 작업)
    for (const st of this.processing) {
      if (st.def.robot.kind !== 'ammr' || modeKey === 'traditional') continue;
      st.ammr = Array.from({ length: st.def.robot.count }, (_, i) => ({ i, side: i % 2 ? 1 : -1, phase: 'work', t: 0, pos: 0, turn: 0, carry: false, trips: 0, lastItem: null, battery: 92 - i * 9 }));
      this.planAmmrRacks(st);
    }
    this.workers = [];
    this.setupWorkers();
    // 정밀조립Zone: 조립 대상물을 싣고 셀 사이를 오가는 AMR (컨베이어 대신)
    this.carriers = [];
    if (this.useAMR) {
      for (let i = 0; i < ZONE_AMR.count; i++) {
        const c = new Mover(`AMR-${String(i + 1).padStart(2, '0')}`, 'carrier', amrPark(i), ZONE_AMR.returnSpeed);
        c.state = 'park'; c.slot = i; c.heading = Math.PI; c.battery = 100 - ((i * 7) % 28);   // 대수마다 엇갈린 잔량으로 시작
        this.carriers.push(c);
      }
    }
    // 충돌 회피: 모든 이동체가 서로를 감지한다 (우선순위: 운반 중 AMR·AGV > 정비 > 기타)
    this.movers = [...this.carriers, ...this.vehicles, ...this.forklifts, ...this.techs, ...this.helpers, ...this.quads, ...this.workers];
    const prio = { carrier: 5, agv: 4, forklift: 4, humanoid: 3, human: 3, robot: 3, quadruped: 1, worker: 2 };
    this.movers.forEach((m, i) => { m.prio = (prio[m.kind] ?? 1) * 100 - i; m.sense = this.sense; m.hazard = this.moverHazard; m.hazardOut = this.hazardOut; });
    // 휴머노이드 충전 도크(대기 자리 뒤 기둥·바닥 판)는 움직이지 않는 장애물 — 다른 이동체는 서 있는 로봇처럼 돌아가고, 도크 주인은 자기 도크를 무시한다
    this.docks = this.movers.filter((m) => m.kind === 'humanoid' && m.home?.heading != null).map((m) => ({
      id: `${m.id} 충전 도크`, kind: 'dock', owner: m, x: m.home.x - Math.sin(m.home.heading) * 0.2, z: m.home.z - Math.cos(m.home.heading) * 0.2,
      idle: true, steps: [], moving: false, prio: 1e9, blockedOn: null, heading: m.home.heading,
    }));
    this.senseList = [...this.movers, ...this.docks];
    // 직선 구간이 충전 도크(바닥 판·기둥 + 여유 0.3m)를 지나는지 — 자기 도크에 앞에서 들어가거나 나오는 경우는 제외
    const dockHit = (m, to) => {
      for (const d of this.docks) {
        const H = d.owner.home, h = H.heading, c = Math.cos(h), sn = Math.sin(h);
        const own = d.owner === m && (Math.hypot(to.x - H.x, to.z - H.z) < 1.3 || Math.hypot(m.x - H.x, m.z - H.z) < 1.3);
        if (own) continue;
        for (let k = 0; k <= 20; k++) { const px = m.x + (to.x - m.x) * k / 20, pz = m.z + (to.z - m.z) * k / 20, rx = px - H.x, rz = pz - H.z, lx = rx * c - rz * sn, lz = rx * sn + rz * c;
          if (Math.abs(lx) < 0.78 && lz < 0.78 && lz > -0.82) return true; }
      }
      return false;
    };
    for (const m of this.movers) if (m.kind === 'humanoid' || m.kind === 'human') m.dockHit = dockHit;
    // 점이 충전 도크(바닥 판·기둥 + 여유 0.45m) 위인지 — 자기 도크 제외
    // 자기 도크는 앞쪽(서는 자리)만 허용 — 뒤(기둥 쪽)로 비켜서다 도크 뒤를 돌아 맴돌지 않게
    const dockAt = (p, m) => this.docks.some((d) => { const H = d.owner.home, c = Math.cos(H.heading), sn = Math.sin(H.heading), rx = p.x - H.x, rz = p.z - H.z, lx = rx * c - rz * sn, lz = rx * sn + rz * c; return d.owner === m ? Math.abs(lx) < 0.93 && lz < 0.1 && lz > -1.6 : Math.abs(lx) < 0.93 && lz < 0.93 && lz > -1.6; });   // 도크 뒤 1.6m까지 금지 — 비켜서다 도크 뒤로 들어가 맴돌지 않게
    for (const m of this.movers) m.dockAt = dockAt;
    this.assignIds();
    // 피지컬AI: VLA 셀(6축 협동·산업용 로봇, AMMR)과 VLA 학습·배포 파이프라인
    for (const st of this.processing) st.vlaCell = m.key === 'dark' && ['cobot', 'articulated', 'ammr', 'humanoid'].includes(st.def.robot?.kind);
    new VLAPipeline(this);
    new AIOSPipeline(this);
    this.cctvAgent = new CCTVAgent(this);   // 피지컬AI: CCTV 에이전트 (영상 감시 · 오케스트레이터 보고 · 이벤트 이력)
    this.net = new Private5G(this);   // Private 5G 특화망: 음영 없는 기지국 배치 · 이동 로봇 5G 모뎀 · 핸드오버 · 무손실 업링크 (자동화·피지컬AI)
    this.erp = new OdooBridge(this);   // Odoo ERP 연동: 발주·재고·설비보전 (자동화·피지컬AI)
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
    this.forklifts.forEach((m) => { m.uid = m.receiver ? 'FL-R1' : 'FL-S1'; });
    this.techs.filter((m) => m.kind !== 'human').forEach((m, i) => { m.uid = `${m.kind === 'humanoid' ? 'HM-M' : 'MR-'}${i + 1}`; });
    this.helpers.forEach((m, i) => { m.uid = `HM-L${i + 1}`; });
    this.quads.forEach((m, i) => { m.uid = `QD-${two(i + 1)}`; });
    this.drones.forEach((m, i) => { m.uid = `DR-${two(i + 1)}`; });
  }

  // 진행 방향 앞(차폭 안)에 있는 가장 가까운 이동체 — 셀 안을 달리는 운반 AMR(state 'line')은 전용 경로라 제외
  // 지게차는 원(반지름 1m)이 아니라 차체 + 앞으로 1.9m 나온 포크까지가 차지하는 자리 — 포크가 다른 로봇·사람과 겹치지 않게
  //  · 지게차가 감지할 때: 포크 끝(+1.9m)보다 0.5m 앞까지 포크 폭(±0.5m) 안을 본다
  //  · 다른 이동체가 감지할 때: 지게차 차체·포크 선분(뒤 0.8m ~ 앞 1.45m, 반폭 0.55m)에 내 앞길(반지름 + 0.5m)이 닿으면 멈춘다
  sense = (m, dir) => {
    let best = null, bd = Infinity;
    const rm = moverRadius(m);
    const segDist = (ax, az, bx, bz, px, pz) => { const vx = bx - ax, vz = bz - az, L = vx * vx + vz * vz || 1; const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / L)); return Math.hypot(px - ax - vx * t, pz - az - vz * t); };
    for (const o of this.senseList ?? this.movers) {
      if (o === m || o.state === 'line') continue;
      if (o.owner === m) { const e = m.path?.[m.path.length - 1]; if (!e || Math.hypot(e.x - m.home.x, e.z - m.home.z) < 1.3) continue; }   // 자기 도크는 들어가고 나올 때만 무시 — 그 밖에는 자기 도크 기둥도 피한다
      // 나란한 도크 앞 줄(도크 앞 1.1m)을 따라 옆 도크 앞을 지나는 것은 정해진 동선 — 옆 도크를 장애물로 보지 않는다
      if (o.kind === 'dock' && m.home?.heading != null && o.heading === m.home.heading && Math.abs(Math.sin(o.heading) * (m.x - o.owner.home.x) + Math.cos(o.heading) * (m.z - o.owner.home.z) - 1.1) < 0.4 && Math.abs(dir.x * Math.sin(o.heading) + dir.z * Math.cos(o.heading)) < 0.3) continue;
      const rx = o.x - m.x, rz = o.z - m.z;
      const along = rx * dir.x + rz * dir.z;
      const R = rm + moverRadius(o);
      const lateral = Math.abs(rx * dir.z - rz * dir.x);
      let hit = along > 0.15 && along < R + 0.5 && lateral < (moverWidth(m) + moverWidth(o)) / 2 + 0.1;
      if (!hit && m.kind === 'forklift' && along > 0.15) hit = along < FORK.reach + 0.5 + moverRadius(o) && lateral < FORK.half + moverRadius(o);
      if (!hit && o.kind === 'forklift') {
        const hx = Math.sin(o.heading), hz = Math.cos(o.heading);
        const ax = o.x - hx * FORK.back, az = o.z - hz * FORK.back, bx = o.x + hx * FORK.front, bz = o.z + hz * FORK.front;
        // 내 앞길 위 몇 점(지금 자리 → 앞으로 반지름 + 0.5m)에서 지게차 차체·포크 선분까지 거리
        // 다가가는 쪽으로만 막는다 — 이미 포크 가까이 있으면 멀어지는 쪽(비켜서기·물러나기)은 언제나 허용
        const d0 = segDist(ax, az, bx, bz, m.x, m.z);
        for (let k = 1; k <= 3 && !hit; k++) { const f = (k / 3) * (rm + 0.5), d = segDist(ax, az, bx, bz, m.x + dir.x * f, m.z + dir.z * f); hit = d < FORK.half + rm * 0.9 && d < d0 - 1e-3; }
      }
      if (hit && Math.max(along, 0.16) < bd) { bd = Math.max(along, 0.16); best = o; }
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
        // 진입로는 한 줄: 진입로 끝(게이트) 2.6m 뒤 대기 지점까지 와서, 게이트에 다른 AMR이 없을 때만 게이트로 들어간다
        // (두 AMR이 같은 게이트를 두고 비켜서기를 되풀이하는 교착을 막는다)
        const via = amrDockVia(c), gate = via.pop(), out = this.stations[0].out, queue = { x: gate.x, z: gate.z + 2.6, aisle: 'F' };
        c.setTask('투입 위치로', [
          { go: queue, via },
          { until: () => !cs.some((k) => k !== c && k.atGate), task: '투입 진입 대기열' },
          { do: () => { c.atGate = true; } },
          { go: { ...gate, aisle: 'F' }, via: [] },
          { until: () => (!out.items.length || out.items[out.items.length - 1].s > 3.4) && !cs.some((k) => k !== c && (k.state === 'docking' || k.state === 'atSrc')) },
          { do: () => { c.state = 'docking'; c.atGate = false; } },
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
    // 구분 적재장: AMR은 이미 가운데 정지 구간까지 들어가 적재 로봇이 박스를 집었다 — 그 자리(진행 방향 그대로)에서 바로 복귀 (입구로 되돌아갔다 다시 들어오지 않는다)
    const inside = item.enterT != null;
    if (inside) { const P = this.stations[this.stations.length - 1].ins[0]?.path, a = P?.[P.length - 2], b = P?.[P.length - 1]; c.x = dock.x; c.z = dock.z; if (a && b) c.heading = Math.atan2(b.x - a.x, b.z - a.z); }
    c.setTask('빈 AMR 복귀', [
      ...(inside ? [] : [{ go: { ...dock, aisle: 'F', name: '하역 위치' }, via: [] }, { wait: 2 }]),
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
      add('자재 담당', '작업자', -41.5, 3.4, -Math.PI / 2);
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
    const it = c.items, hz = this.useAMR && this.openHazards().length;
    for (let i = 0; i < it.length; i++) {
      let lim = i === 0 ? c.len : it[i - 1].s - c.spacing;
      // 운반 AMR(라인 위 고정 경로): 앞 2.5m에 현장 이벤트가 있으면 그 앞에서 정지 — 해결되면 이어서 간다 (처음 마주친 AMR이 상위 보고)
      if (hz) {
        const who = it[i].item.carrier?.id ?? `대상물 #${it[i].item.id}`;
        let stopAt = null;
        for (let d = 0.3; d <= 2.5 && it[i].s + d <= c.len + 1e-6 && stopAt == null; d += 0.25) { const p = pointAt(c.path, it[i].s + d); const ev = this.hazardAt(p.x, p.z, 0.55); if (ev) { stopAt = it[i].s; this.reportHazard(who, ev, 'wait'); } }
        if (stopAt != null) { lim = Math.min(lim, stopAt); it[i].hzWait = true; it[i].hzEv = this.hazardAt(pointAt(c.path, Math.min(c.len, it[i].s + 1)).x, pointAt(c.path, Math.min(c.len, it[i].s + 1)).z, 2.6) ?? it[i].hzEv; }
        else if (it[i].hzWait) { it[i].hzWait = false; this.hazardResumed(who); }
      }
      it[i].s = Math.min(it[i].s + c.speed * dt, Math.max(lim, it[i].s));
    }
  }

  // ── 진로 위 현장 이벤트 (해결 전): 이동체는 우회하거나 정지 대기하고, 처음 마주친 이동체가 오케스트레이터에 보고한다 ─────────────────
  openHazards() { return (this.fieldEvents ?? []).filter((e) => !e.cleared); }
  hazardAt(x, z, pad = 0) { for (const ev of this.openHazards()) if (Math.hypot(x - ev.x, z - ev.z) < (FIELD_EVENTS[ev.type]?.radius ?? 1.2) + pad) return ev; return null; }
  reportHazard(who, ev, mode) {
    (ev.affected ??= new Map());
    if (ev.affected.get(who) === mode) return;
    const first = !ev.affected.size; ev.affected.set(who, mode);
    if (!ev.detected) this.detectFieldEvent(ev, who, 0.88);   // 진로 센서·카메라로 처음 발견 → 인시던트 열림
    const inc = ev.inc ?? this.orch.find(`ev:${ev.id}`), L = FIELD_EVENTS[ev.type]?.label ?? '현장 이벤트';
    const text = `${who} 진로에 ${L} — ${mode === 'detour' ? '우회 경로로 돌아감' : '해결될 때까지 정지 대기'}`;
    if (inc?.status === 'open') ev.reported = (ev.reported ?? 0) + 1;
    if (inc) this.orch.step(inc, 'field', 'report', `${text} (상위 보고${first ? '' : ` · 영향 ${ev.affected.size}대`})`);
    this.log('warn', `진로 이벤트 · ${who}`, { obs: `${L} · x ${ev.x.toFixed(1)}, z ${ev.z.toFixed(1)}`, act: mode === 'detour' ? '우회' : '정지 대기 (해결 시 재개)' });
    this.stats.hazardReports = (this.stats.hazardReports ?? 0) + 1;
  }
  hazardResumed(who) { this.log('ok', `진로 정상화 · ${who}`, { act: '현장 이벤트 해결 확인 · 이동 재개' }); this.stats.hazardResumes = (this.stats.hazardResumes ?? 0) + 1; }
  hazardInvolved(m, ev) { return ev.responder === m.id || !!m.tool || !!m.scanning; }
  hazardOut = (m) => {
    if (m.state === 'line' || m.kind === 'carrier') return false;
    for (const ev of this.openHazards()) {
      const R = (FIELD_EVENTS[ev.type]?.radius ?? 1.2) + moverRadius(m) * 0.8, dx = m.x - ev.x, dz = m.z - ev.z, dd = Math.hypot(dx, dz);
      if (dd >= R || this.hazardInvolved(m, ev)) continue;
      const base = dd > 0.05 ? Math.atan2(dz, dx) : 0;
      for (const da of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, Math.PI]) {
        const r = R + 0.4, esc = { x: ev.x + Math.cos(base + da) * r, z: ev.z + Math.sin(base + da) * r };
        if (!(esc.x > -50.2 && esc.x < 36.8 && Math.abs(esc.z) < 19) || m.dockAt?.(esc, m)) continue;
        const aisle = m.loc?.aisle;
        m.steps.unshift({ go: { ...esc, aisle, name: '이벤트 반경 밖' }, via: [] }, { go: { x: m.x, z: m.z, aisle, name: m.loc?.name ?? '작업 자리' }, via: [] });
        this.reportHazard(m.id, ev, 'detour');
        return true;
      }
    }
    return false;
  };
  // 이동체: 앞 3m 경로가 해결 안 된 현장 이벤트 반경에 들면 — 우회 경로를 찾으면 돌아가고, 없으면 정지 대기(true)
  moverHazard = (m, st) => {
    const evs = this.openHazards();
    if (!evs.length) { if (m.hzWait) { m.hzWait = null; this.hazardResumed(m.id); } return false; }
    const R = (ev) => (FIELD_EVENTS[ev.type]?.radius ?? 1.2) + moverRadius(m) * 0.8;
    // 그 이벤트에 대응하러 가는 중(도구 챙긴 정비 휴머노이드·점검 사족보행)이면 피하지 않는다 — 목적지가 반경 안인 다른 일은 반경 밖에서 해결을 기다린다
    const goingTo = (ev) => this.hazardInvolved(m, ev) && Math.hypot(st.go.x - ev.x, st.go.z - ev.z) < R(ev) + 1.8;
    // 이미 반경 안(이벤트가 바로 옆에서 발생)이면 그 자리에서 기다리지 않고 반경 밖으로 먼저 빠져나온다
    if (m.hzEsc && m.path?.[0] === m.hzEsc) return false;
    m.hzEsc = null;
    const okPt = (p) => p.x > -50.2 && p.x < 36.8 && Math.abs(p.z) < 19 && !this.stations.some((s2) => Math.abs(p.x - s2.x) < 2.6 && Math.abs(p.z - (s2.z ?? 0)) < 2.6) && !m.dockAt?.(p, m);
    for (const ev of evs) {
      const dx = m.x - ev.x, dz = m.z - ev.z, dd = Math.hypot(dx, dz);
      if (goingTo(ev) || dd >= R(ev)) continue;
      const base = dd > 0.05 ? Math.atan2(dz, dx) : Math.atan2(-(m.z - (m.path?.[0]?.z ?? m.z)), m.x - (m.path?.[0]?.x ?? m.x) || 1);
      for (const da of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, Math.PI]) {
        const r = R(ev) + 0.4, esc = { x: ev.x + Math.cos(base + da) * r, z: ev.z + Math.sin(base + da) * r };
        if (!okPt(esc)) continue;
        m.hzEsc = esc; m.path = [esc, ...(m.path ?? [])];
        this.reportHazard(m.id, ev, 'detour');
        return false;
      }
    }
    const pts = [{ x: m.x, z: m.z }, ...(m.path ?? [])];
    let hit = null, acc = 0;
    for (let k = 0; k + 1 < pts.length && acc < 3 && !hit; k++) {
      const a = pts[k], b = pts[k + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      for (let t = 0; t <= L && acc + t <= 3; t += 0.25) { const x = a.x + (b.x - a.x) * (t / (L || 1)), z = a.z + (b.z - a.z) * (t / (L || 1)); for (const ev of evs) if (!goingTo(ev) && Math.hypot(x - ev.x, z - ev.z) < R(ev)) { hit = { ev, k, dir: { x: (b.x - a.x) / (L || 1), z: (b.z - a.z) / (L || 1) } }; break; } if (hit) break; }
      acc += L;
    }
    if (!hit) { if (m.hzWait) { m.hzWait = null; this.hazardResumed(m.id); } return false; }
    const ev = hit.ev;
    if (m.hzWait?.ev === ev) return true;
    // 우회: 이벤트 반경 밖 양옆 두 점(앞·뒤)으로 돌아 원래 길에 다시 오른다 — 셀·충전 도크·건물 밖이면 반대쪽, 둘 다 안 되면 대기
    if (m.kind !== 'carrier' || m.state === 'return') {
      m.hzTried ??= new Set();
      if (!m.hzTried.has(ev.id)) {
        m.hzTried.add(ev.id);
        const d = hit.dir, n = { x: -d.z, z: d.x }, r = R(ev) + 0.7, ok = okPt;
        for (const sg of [1, -1]) {
          const before = { x: ev.x - d.x * r + n.x * sg * r, z: ev.z - d.z * r + n.z * sg * r }, after = { x: ev.x + d.x * r + n.x * sg * r, z: ev.z + d.z * r + n.z * sg * r };
          if (!ok(before) || !ok(after)) continue;
          // 이벤트 반경 안에 있던 경유점은 버리고(목적지는 그대로) 우회 두 점을 앞에 넣는다
          const rest = (m.path ?? []).filter((p, i, arr) => i === arr.length - 1 || Math.hypot(p.x - ev.x, p.z - ev.z) > R(ev) + 0.3);
          const ahead = rest.findIndex((p) => (p.x - ev.x) * d.x + (p.z - ev.z) * d.z > 0);
          m.path = [before, after, ...(ahead >= 0 ? rest.slice(ahead) : rest.slice(-1))];
          this.reportHazard(m.id, ev, 'detour');
          return false;
        }
      }
    }
    m.hzWait = { ev }; this.reportHazard(m.id, ev, 'wait');
    return true;
  };

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
    this.dispatchDrones();
    for (const d of this.drones) d.update(dt);
    this.inbound.update(dt);   // 입고 트럭도 건물 밖이라 계속 움직인다
    if (mdt > 0) for (const f of this.forklifts) { if (f.idle && !K.evac) (f.receiver ? planReceiver : planForklift)(this, f); f.update(mdt); }
    if (mdt > 0) {
      for (const t of this.techs) t.update(mdt);
      if (this.helpers.length) this.assignHelpers();
      for (const h of this.helpers) h.update(mdt);
      for (const q of this.quads) {
        if (q.idle) this.planPatrol(q);
        q.update(mdt);
        if (!q.charging) q.battery = Math.max(0, q.battery - (q.moving ? QUAD_DRAIN.move : q.scanning ? QUAD_DRAIN.scan : QUAD_DRAIN.idle) * mdt);
      }
      this.updateBatteries(mdt);
    }
    for (const w of this.workers) {
      // 순찰 인원은 통로 바깥 보행로로 걷는다 (차량 차로를 쓰지 않음)
      if (w.patrol && w.idle) w.setTask('순찰', [{ go: w.patrol[0], via: [] }, { wait: 5 }, { go: w.patrol[1], via: [] }, { wait: 5 }]);
      w.update(dt);
    }
    this.net?.update(dt);
    this.erp?.update();
    this.cctvAgent?.update(dt);   // 피지컬AI: CCTV 에이전트 — 영상 감시·오케스트레이터 보고·이벤트 이력
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
    this.impact.tick(dt);
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
    if (this.cmd?.estopAll || this.cmd?.pstopAll) return;   // 비상·보호정지 중에는 적재 로봇 집기도 멈춘다 (시작한 집기는 재개 후 이어서)
    const c = sink.in;
    // 구분 적재장: 제품별 구역이 가득 차면 그 제품만 막힌다
    const head = c.items[0]?.item;
    if (this.zone ? head && !head.scrap && this.fgBy[head.product] >= FG_ZONE_CAP : this.fgStock >= FG_CAP) { sink.state = 'FULL'; sink.c.blocked += dt; return; }
    // 하역 위치에 앞서 내린 AMR이 아직 있으면 기다린다 (AMR끼리 겹치지 않게)
    const occupied = this.carriers.some((k) => k.state === 'return' && Math.hypot(k.x - sink.x, k.z - sink.z) < 1.7);
    if (this.frontReady(c) && !occupied && head?.scrap) {
      // 빈 AMR(불량품을 빼낸 AMR)도 가운데 정지 구간까지 들어간 뒤 그 자리에서 복귀한다 (입구로 되돌아갔다 다시 들어오지 않게)
      if (this.zone) { head.enterT = (head.enterT ?? 0) + dt; if (head.enterT < SINK_PICK.enter) { sink.state = 'BUSY'; return; } }
      const { item } = c.items.shift();
      this.releaseCarrier(item, sink.def);
    } else if (this.frontReady(c) && !occupied) {
      // 구분 적재장: 제품 쪽 적재 로봇이 AMR 위 박스를 집어 든 뒤에야 박스가 AMR에서 사라지고 AMR이 떠난다
      // (로봇 한 사이클 SINK_PICK.cycle초 — 앞 박스를 다 놓을 때까지 다음 집기는 기다림 · 집는 순간 = 사이클 시작 후 SINK_PICK.grab초)
      if (this.zone && head && !head.scrap) {
        const P = head.product, S = this.stats;
        if (head.pickT == null) {
          // AMR이 입구(경로 끝)에서 가운데 정지 구간까지 들어간 뒤에야 적재 로봇이 집기를 시작한다
          head.enterT = (head.enterT ?? 0) + dt;
          if (head.enterT < SINK_PICK.enter) { sink.state = 'BUSY'; sink.lastIn = this.time; return; }
          this.sinkFree ??= {};
          if (this.time < (this.sinkFree[P] ?? 0)) { sink.state = 'BUSY'; return; }
          head.pickT = 0; this.sinkFree[P] = this.time + SINK_PICK.cycle;
          S.pickStartBy ??= {}; S.pickStartBy[P] = (S.pickStartBy[P] ?? 0) + 1;
        }
        head.pickT += dt;
        if (head.pickT < SINK_PICK.grab) { sink.state = 'BUSY'; sink.lastIn = this.time; return; }
        S.grabBy ??= {}; S.grabBy[P] = (S.grabBy[P] ?? 0) + 1;
      }
      const { item } = c.items.shift();
      if (item.defect) this.stats.escaped++; else { this.stats.good++; if (item.product) this.stats.goodBy[item.product] = (this.stats.goodBy[item.product] ?? 0) + 1; }
      if (item.product) this.fgBy[item.product]++;
      this.erp?.produced(item.product ?? 'doortrim');   // Odoo: 생산 입고 (구분 적재장에 들어온 수량 — 유출 불량 포함)
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

  // ── 분류·포장 게이트 (혼류) ─────────────────
  // 셀 입구의 게이트가 들어오는 대상물을 비전·ID로 판별해 결정을 내리고, 그 결정에 맞는 로봇이 주 작업을 맡는다.
  // 분류셀: 도어트림/e-axle 판별 → 해당 제품 라인으로 분기 + 그 제품 쪽 로봇이 제품별 부품 키팅, 반대쪽 로봇은 작업물 고정·ID 태그
  // 포장셀: 도어트림 → 트레이 포장 / e-axle → 크레이트 포장 — 그 포장재 매거진 쪽 로봇이 포장, 반대쪽 로봇은 고정·라벨
  // 로봇 쪽: 도어트림 = +z(홀수 번째 로봇), e-axle = −z(짝수 번째 로봇). 같은 쪽 로봇이 없으면 첫 로봇이 맡는다
  gateDecide(st) {
    if (st.def.type !== 'sort' && st.def.type !== 'pack') return;
    const it = st.item, n = st.def.robot?.count ?? 0, all = [...Array(n).keys()];
    if (!it.product || it.scrap) {
      st.gate = { id: it.id, product: null, t: this.time, text: it.scrap ? '빈 AMR — 작업 없이 통과' : '판별 완료', lead: it.scrap ? [] : all, role: null };
      return;
    }
    const side = it.product === 'doortrim' ? 1 : -1, P = ZONE_PRODUCTS[it.product]?.label ?? it.product;
    let lead = all.filter((i) => (i % 2 ? 1 : -1) === side);
    if (!lead.length) lead = n ? [0] : [];
    const sort = st.def.type === 'sort', tray = it.product === 'doortrim';
    st.gate = {
      id: it.id, product: it.product, t: this.time, lead,
      text: sort ? `${P} → ${P} 라인 · ${P} 키트` : `${P} → ${tray ? '트레이' : '크레이트'} 포장`,
      role: sort ? { lead: `${P} 부품 키팅`, support: '작업물 고정 · ID 태그' } : { lead: `${P} ${tray ? '트레이' : '크레이트'} 포장`, support: '작업물 고정 · 라벨' },
    };
    st.gateCount ??= {}; st.gateCount[it.product] = (st.gateCount[it.product] ?? 0) + 1;
    // 결정 기록 (FACOS 셀·게이트 화면): 최근 40건 + 로봇별 주 작업 횟수
    st.leadCount ??= {}; for (const i of lead) { const u = st.robotUids?.[i] ?? `#${i + 1}`; st.leadCount[u] = (st.leadCount[u] ?? 0) + 1; }
    (st.gateLog ??= []).push({ t: this.time, item: it.id, product: it.product, text: st.gate.text, lead: lead.map((i) => st.robotUids?.[i] ?? `#${i + 1}`) });
    if (st.gateLog.length > 40) st.gateLog.shift();
  }
  // 게이트 결정에서 이 로봇이 주 작업을 맡는가 (게이트가 없는 셀은 모두 주 작업)
  isLead(st, i) { return !st.gate || !st.item || st.gate.id !== st.item.id || st.gate.lead.includes(i); }

  // ── AMMR: 대상물마다 부품 선반에서 부품을 가져와 작업 ─────────────────
  // 작업 사이클 앞부분에 선반 쪽으로 회전 → 주행 → 양팔 피킹 → 셀 쪽으로 회전 → 복귀 주행, 이어서 분류·조립·체결·포장.
  // 사이클 시간 안에 왕복이 들어 있어 처리량은 그대로이고, 부품은 대상물 하나에 한 세트씩 선반 재고에서 빠진다.
  // AMR·휴머노이드·AMMR 배터리: 움직이거나 작업하면 줄고, 대기 자리(충전 접점·무선 충전)에서는 찬다 (작업 흐름은 바꾸지 않는다)
  updateBatteries(dt) {
    const B = BATTERY, clamp = (v) => Math.max(0, Math.min(100, v));
    for (const c of this.carriers) {
      c.chgNow = !c.moving && ['park', 'atSrc', 'line'].includes(c.state);   // 정차 위치마다 무선 충전 코일
      c.battery = clamp(c.battery + (c.chgNow ? B.carrier.rate : -(c.moving ? B.carrier.move : B.carrier.idle)) * dt);
    }
    for (const h of [...this.helpers, ...this.techs.filter((t) => t.kind === 'humanoid')]) {
      h.chgNow = (h.idle || h.swapping) && !h.moving && Math.hypot(h.x - h.home.x, h.z - h.home.z) < 0.4;
      if (h.chgNow && h.home.heading != null) h.heading = h.home.heading;   // 대기 = 충전 도크에 등을 대고 통로 쪽을 본다
      // 교체식 배터리: 할 일이 없을 때 30% 아래면 대기 구역으로 가서 팩을 교체한다
      if (h.idle && h.battery < B.humanoid.low && !h.swapping && !this.cmd?.evac) h.setTask('배터리 팩 교체', [{ go: h.home }, { do: () => { h.swapping = true; } }, { wait: B.humanoid.swap, done: () => { h.battery = 100; h.swapping = false; h.swaps = (h.swaps ?? 0) + 1; } }]);
      h.battery = clamp(h.battery + (h.chgNow ? B.humanoid.rate : -(h.moving ? B.humanoid.move : h.task ? B.humanoid.work : B.humanoid.idle)) * dt);
    }
    for (const st of this.processing) for (const u of st.ammr ?? []) {
      const drive = u.phase !== 'work';
      u.chgNow = !drive;   // 작업 위치에 도킹해 있으면 접점 충전 (작업 소모보다 조금 많이)
      u.battery = clamp((u.battery ?? 100) + (drive ? -B.ammr.drive : B.ammr.rate - (st.state === 'BUSY' ? B.ammr.work : 0)) * dt);
    }
  }
  updateAMMR(st) {
    const work = st.item && !st.item.scrap && !st.done && ['BUSY', 'DOWN', 'MAINT', 'ESTOP', 'PSTOP', 'CHECK', 'CSTOP'].includes(st.state);
    for (const u of st.ammr) {
      if (!work || !this.isLead(st, u.i)) { if (!st.item || st.done || work) { u.phase = 'work'; u.pos = 0; u.turn = 0; u.carry = false; } continue; }   // 보조 역할은 자리에서 작업물 고정
      const q = Math.min(1, Math.max(0, (st.progress - u.i * 0.02) / (1 - u.i * 0.02)));   // 로봇마다 조금씩 어긋나게
      const seg = (a, b) => Math.min(1, Math.max(0, (q - a) / (b - a)));
      if (q < AMMR_FETCH.turnOut) { u.phase = 'turnOut'; u.turn = seg(0, AMMR_FETCH.turnOut); u.pos = 0; }
      else if (q < AMMR_FETCH.driveOut) { u.phase = 'driveOut'; u.turn = 1; u.pos = seg(AMMR_FETCH.turnOut, AMMR_FETCH.driveOut); }
      else if (q < AMMR_FETCH.pick) { u.phase = 'pick'; u.turn = 1; u.pos = 1; if (q > (AMMR_FETCH.driveOut + AMMR_FETCH.pick) / 2) u.carry = true; }
      else if (q < AMMR_FETCH.turnIn) { u.phase = 'turnIn'; u.turn = 1 - seg(AMMR_FETCH.pick, AMMR_FETCH.turnIn); u.pos = 1; u.carry = true; }
      else if (q < AMMR_FETCH.driveIn) { u.phase = 'driveIn'; u.turn = 0; u.pos = 1 - seg(AMMR_FETCH.turnIn, AMMR_FETCH.driveIn); u.carry = true; }
      else { u.phase = 'work'; u.turn = 0; u.pos = 0; u.carry = q < AMMR_FETCH.place; }
      if (u.phase === 'pick' && u.lastItem !== st.item.id) { u.lastItem = st.item.id; u.trips++; }
    }
  }

  updateStation(st, dt) {
    const m = this.mode;
    // 상위 명령으로 멈춘 셀 (비상정지·자가진단·보호정지): 작업물·로봇 자세를 그대로 두고 정지. 고장 수리·현장 정비는 계속
    const gate = this.cmd.stationGate(st);
    if (gate && st.state !== 'DOWN' && !(st.state === 'MAINT' && st.techOnSite)) {
      st.state = gate; st.c.stop = (st.c.stop ?? 0) + dt; st.ema += (0 - st.ema) * Math.min(1, dt / 90); return;
    }
    if (st.state === 'DOWN' || st.state === 'MAINT') {
      if (st.state === 'DOWN') st.c.down += dt; else st.c.maint += dt;
      if (st.techOnSite && !this.cmd.locked(st)) {   // 비상정지 중에는 수리도 멈춘다
        st.repairRemaining -= dt;
        if (st.repairRemaining <= 0) this.finishRepair(st);
      }
      st.ema += (0 - st.ema) * Math.min(1, dt / 90);
      return;
    }
    if (st.parts === 0 && !st.item && st.ammr) this.rackEmpty(st);
    if (st.parts === 0 && !st.item) { st.state = 'NOPARTS'; st.c.starved += dt; st.starvedFor += dt; st.ema += (0 - st.ema) * Math.min(1, dt / 90); return; }
    let inC = null;
    // AMR 운반: 앞서 나간 AMR이 셀 중앙에서 충분히(AMR 간격 이상) 빠져나간 뒤에 다음 AMR을 받는다
    const cleared = !this.useAMR || Object.values(st.outs).every((c) => !c.items.length || c.items[c.items.length - 1].s >= c.spacing + 0.4);
    const cycleStop = st.cmd?.hold === 'cycle';   // 사이클 정지: 하던 작업만 마치고 새 작업은 받지 않는다
    if (!st.item && cleared && !cycleStop) for (const c of st.ins) if (this.frontReady(c) && (!inC || c.items[0].item.id < inC.items[0].item.id)) inC = c;
    if (inC) {
      const e = inC.items.shift();
      st.itemFrom = inC.path[inC.path.length - 1];   // 들어온 경로의 끝점 (합류 대기 차로는 중심선에서 비켜 있음)
      st.item = e.item; st.progress = 0; st.done = false; st.itemT = 0;
      this.gateDecide(st);
      const base = st.def.cycle * m.cycleMul * st.speedMul * (this.vla?.cycleFactor(st) ?? 1);   // 배포된 VLA 모델 버전만큼 사이클 단축
      st.cycleTime = st.item.scrap ? 0.5 : Math.max(base * 0.6, base * (1 + m.cycleVar * gauss(this.rand)));
    }
    if (!st.item && cycleStop) { st.state = 'CSTOP'; st.c.stop = (st.c.stop ?? 0) + dt; }
    else if (!st.item) {
      st.state = 'STARVED'; st.c.starved += dt; st.starvedFor += dt;
    } else {
      st.starvedFor = 0; st.itemT += dt;
      if (!st.done) {
        st.state = 'BUSY'; st.c.busy += dt; st.powerSave = false;
        st.progress += (dt / st.cycleTime) * this.cmd.speedOf(st);
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
    if (st.ammr) this.updateAMMR(st);
    st.ema += ((st.state === 'BUSY' ? 1 : 0) - st.ema) * Math.min(1, dt / 90);
  }

  // AMMR 셀 부품 선반이 비었을 때: 경고 + 오케스트레이터 인시던트 (보충 휴머노이드가 채우면 닫힌다)
  rackEmpty(st) {
    const o = this.orch;
    if (o.find(`rack:${st.id}`)) return;
    this.log('warn', `${st.name} 부품 선반 재고 없음`, { obs: 'AMMR이 가져갈 부품이 없음 — 보충 대기', act: st.partsReq ? '보충 휴머노이드 배정됨' : '보충 요청' });
    const inc = o.open('parts', `rack:${st.id}`, `${st.name} 부품 선반 결품`, `${st.name} AMMR`, { where: { x: st.x, z: st.z } });
    o.step(inc, 'field', 'detect', 'AMMR 선반 카메라: 선반 재고 0 감지');
    o.step(inc, 'cell', 'self', '셀 자체 조치: 새 대상물 받지 않음 · 선반 앞 대기');
    o.later(0.5, () => o.step(inc, 'cell', 'report', '상위 보고: 선반 보충 필요'));
    o.later(o.latency, () => { o.step(inc, 'orch', 'decide', `판단(${o.name}): 선반 보충 우선 배정`); o.step(inc, 'orch', 'command', '명령: 부품 보충 휴머노이드 선반 보충'); });
  }

  completeCycle(st) {
    const m = this.mode, it = st.item;
    if (it.scrap) return;   // 빈 AMR(불량 배출 후)은 작업 없이 통과
    st.c.processed++;
    if (st.parts != null) {   // 대상물 하나에 부품 한 세트 (AMMR 셀은 로봇이 선반에서 가져간 만큼)
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
    const inc = o.open('equipment', `fail:${st.id}`, `${st.name} 설비 고장`, st.name, { where: { x: st.x, z: st.z } });
    o.step(inc, 'field', 'detect', m.agentActive ? `IoT 알람 — 건강도 ${st.health.toFixed(0)}%, 진동·전류 이상, 가동 정지` : (m.andon ? `설비 정지 — 안돈 알람 자동 호출 (경광등·호출 버저, 반장 확인까지 약 ${m.alarmDelay}초)` : `설비 정지 — 작업자가 이상을 발견하기까지 약 ${m.alarmDelay}초`));
    o.step(inc, 'cell', 'self', m.agentActive ? '셀 자체 조치: 비상 정지 · 작업물 보류 · 자가 진단 → 재가동 불가' : '셀 자체 조치 없음 (수동 설비)');
    const pending = !!st.request;
    if (pending) { st.request.kind = 'repair'; this.erp?.maintenance(st, 'repair'); }
    else if (!m.agentActive) this.requestTech(st, 'repair', m.alarmDelay + 5);   // 레거시: 발견 지연 → 반장 판단 후 정비반 호출
    o.later(m.agentActive ? 0.5 : m.alarmDelay, () => o.step(inc, 'cell', 'report', `${m.agentActive ? '상위 보고' : m.andon ? '안돈 → 반장 호출' : '작업자 → 반장 보고'}: 고장 · 예상 수리 ${Math.round(st.repairTotal)}초 · 하류 셀 자재대기 예상`));
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
        obs: m.andon ? `안돈 알람 자동 호출 — 반장 확인까지 약 ${m.alarmDelay}초` : `작업자가 이상을 발견하기까지 약 ${m.alarmDelay}초 지연`,
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
    this.erp?.maintenance(st, kind);   // Odoo: 정비요청 (긴급 / 예방)
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
    // 우선순위 순: 긴급수리(P3) → 재보정·예지정비(P5). 화재·인명(P1) 대응 중에는 예지정비·재보정을 보류해 정비 인력을 안전 대응에 남긴다
    const KP = { repair: 3, cal: 5, pm: 5 }, p1 = this.orch.urgentOpen(1).length > 0;
    const order = [...this.requests].sort((a, b) => KP[a.kind] - KP[b.kind] || a.readyAt - b.readyAt);
    for (const req of order) {
      if (req.tech || this.time < req.readyAt) continue;
      if (p1 && KP[req.kind] >= 5) { if (!req.deferred) { req.deferred = true; this.stats.deferred = (this.stats.deferred ?? 0) + 1; this.log('info', `${req.st.name} ${req.kind === 'pm' ? '예지정비' : '재보정'} 보류`, { obs: 'P1 화재·인명 안전 대응 중', act: '안전 확보 뒤 배정 (정비 인력 안전 대응 대기)' }); } continue; }
      const st = req.st;
      let best = null, bd = 1e9;
      for (const t of this.techs) {
        if (!t.idle) continue;
        const d = Math.abs(t.x - st.x) + Math.abs(t.z - st.z);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) continue;
      req.tech = best; best.job = { prio: KP[req.kind], st, req }; this.erp?.maintStart(st, best);
      if (req.kind === 'repair') this.orch.step(this.orch.find(`fail:${st.id}`), 'exec', 'act', `${best.id} 배정 · 출동`);
      const kindLabel = { repair: '긴급수리', pm: '예지정비', cal: '재보정' }[req.kind];
      const T = toolSteps(this, best, req.kind, req.kind === 'repair' ? this.orch.find(`fail:${st.id}`) : null);
      best.setTask(`${kindLabel} → ${st.name} (${TOOL_KITS[req.kind].label})`, [
        ...T.take,
        { go: svcLoc(st) },
        { do: () => this.techArrive(req) },
        { until: () => !st.request },
        { do: () => { if (best.job?.req === req) best.job = null; } },
        ...T.back,
        ...T.home(best.home),
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
    if (!st.request?.self) this.erp?.maintDone(st);   // Odoo: 정비 완료 (셀 자율 보정은 정비요청 없음)
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
      const h = this.helpers.find((k) => k.idle && k.battery >= BATTERY.humanoid.low); if (!h) return;
      const st = req.st; req.helper = h;
      h.setTask(`부품 보충 → ${st.name}`, [
        // 대기존에서 바로 옆 진출입 줄(AGV 상차 자리를 비킨 x −41.2)로 나가 부품 칸 앞으로 옆걸음, 나올 때도 같은 줄로
        { go: h.pick, via: [{ x: LOC.WH_LANE_IN, z: h.home.z + 1.1 }, { x: LOC.WH_LANE_IN, z: h.pick.z }] },   // 충전 도크 앞(+z 1.1m)으로 나와 서쪽(들어가는) 줄로
        { until: () => !this.partsTracked || this.whParts > 0, task: '부품 랙 재고 대기 (입고 트럭 대기)' },
        { wait: 4, done: () => { const n = this.partsTracked ? Math.min(this.mode.partsCap - (st.parts ?? 0), this.whParts) : this.mode.partsCap; this.whParts -= this.partsTracked ? n : 0; h.carry = n; if (this.partsTracked) this.erp?.consume('parts', n, st.name); } },
        { go: { x: LOC.WH_LANE_OUT, z: h.pick.z, aisle: 'F', name: '물류존 진출' }, via: [] },   // 나오는 줄(동쪽)로 북쪽 통로까지
        { go: st.ammr ? this.rackServiceLoc(st) : localLoc(st.def, -1.0, SVC_Z, st.name) },   // AMMR 셀은 부품 선반 옆
        { wait: 5, done: () => {
          const n = typeof h.carry === 'number' ? h.carry : this.mode.partsCap; h.carry = false; st.parts = Math.min(this.mode.partsCap, (st.parts ?? 0) + n); st.partsReq = null;
          { const inc = this.orch.find(`rack:${st.id}`); this.orch.step(inc, 'exec', 'act', `${h.id} 선반 보충 완료 (${st.parts}개)`); this.orch.close(inc, '선반 재고 회복 · 인시던트 종료'); }
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
    const rec = (result) => { (this.scanLog ??= []).push({ t: this.time, by: q.id, st: st.name, health: Math.round(st.health), drift: Math.round(st.drift * 100), result }); if (this.scanLog.length > 60) this.scanLog.shift(); if (result !== '정상' && result !== '점검 생략') this.stats['scan_' + result] = (this.stats['scan_' + result] ?? 0) + 1; };
    if (st.request || st.state === 'DOWN' || st.state === 'MAINT') return rec('점검 생략');
    // 혼합형 다중 에이전트: 순찰 보고는 정비·품질 에이전트 제안으로 메인 조정자에 올라간다 (agentHub) — 단일 에이전트는 바로 처리
    if (st.health < this.mode.pmThreshold + this.mode.scanPm && this.agentHub?.report({ kind: 'pm', st, prio: 5, critical: st.health <= this.mode.pmThreshold - 7, why: `${q.id} 열화상·진동 스캔 — 건강도 ${st.health.toFixed(0)}%`, by: 'maint', source: q.id })) {
      rec('예지정비');
    } else if (st.health < this.mode.pmThreshold + this.mode.scanPm) {
      rec('예지정비');
      if (this.requestTech(st, 'pm')) {
        this.log('plan', `${q.id} 순찰 이상 징후 · ${st.name}`, {
          obs: `열화상·진동 스캔 — 베어링 온도 상승, 진동 RMS 증가 (건강도 ${st.health.toFixed(0)}%)`,
          dec: 'IoT 임계치 도달 전 선제 정비',
          act: '정비 휴머노이드에 예지정비 배정',
        });
      }
    } else if (st.drift > 0.15 && !st.def.inspect && this.agentHub?.report({ kind: 'cal', st, prio: 5, why: `${q.id} 순찰 — 드리프트 ${(st.drift * 100).toFixed(0)}%`, by: 'quality', source: q.id })) {
      rec('재보정');
    } else if (st.drift > 0.15 && !st.def.inspect) {
      rec('재보정');
      if (this.selfCalibrate(st)) this.log('plan', `${q.id} 순찰 · ${st.name} 미세 편차`, { obs: `치수·토크 편차 드리프트 ${(st.drift * 100).toFixed(0)}%`, act: '셀 자율 재보정' });
    } else rec('정상');
  }

  // ── 드론 관제: 열린 인시던트(우선순위 순)마다 가장 가까운 가용 드론을 보낸다. 가용 드론이 없으면 더 낮은 우선순위 출동 중인 드론을 돌린다
  dispatchDrones() {
    if (!this.drones.length) return;
    const open = this.orch.incidents.filter((i) => i.status === 'open' && i.where && MISSION_PRIO[i.type] && !i.droneDone)
      .sort((a, b) => prioOf(a) - prioOf(b) || MISSION_PRIO[b.type] - MISSION_PRIO[a.type] || a.t0 - b.t0);   // 화재·인명(P1) → 시설 안전(P2) → 생산
    const dist = (d, w) => Math.hypot(d.x - w.x, d.z - w.z);
    for (const inc of open) {
      if (this.drones.some((d) => d.mission === inc)) continue;
      inc.droneWaitFrom ??= this.time;
      let d = this.drones.filter((x) => x.available).sort((a, b) => dist(a, inc.where) - dist(b, inc.where))[0];
      const lower = (x) => prioOf(x.mission) > prioOf(inc) || (prioOf(x.mission) === prioOf(inc) && MISSION_PRIO[x.mission.type] < MISSION_PRIO[inc.type]);
      if (!d) d = this.drones.filter((x) => x.mode === 'mission' && x.mission && lower(x)).sort((a, b) => prioOf(b.mission) - prioOf(a.mission) || MISSION_PRIO[a.mission.type] - MISSION_PRIO[b.mission.type] || dist(a, inc.where) - dist(b, inc.where))[0];
      if (d) { inc.droneWait = (inc.droneWait ?? 0) + (this.time - inc.droneWaitFrom); inc.droneWaitFrom = null; d.assign(inc); }
    }
  }

  // ── 드론 현장 관찰 → 오케스트레이터 대응 보강 ─────────────────
  // 드론이 사고 현장 상공에 도착하면 하방·짐벌 카메라 영상으로 현장 상황을 정리해 보고하고(관찰),
  // 공장 운영 SW(오케스트레이터·AI)가 그 정보를 대응 조치 수립 근거로 쓴다(판단 보강·조치 조정)
  droneObserve(inc) {
    const near = (x, z, r) => this.movers.filter((m) => Math.hypot(m.x - x, m.z - z) < r);
    const w = inc.where, ms = near(w.x, w.z, 5), carriers = ms.filter((m) => m.kind === 'carrier').length, people = ms.filter((m) => m.kind === 'worker' || m.kind === 'human').length;
    if (inc.type === 'equipment') {
      const st = this.processing.find((x) => `fail:${x.id}` === inc.key), tech = st?.request?.tech ?? this.techs.find((t) => t.task?.includes(st?.name ?? '#'));
      const d = tech ? Math.round(Math.hypot(tech.x - st.x, tech.z - st.z)) : null;
      return { text: `${st?.name ?? ''} 정지 · 연기·누유 없음 · 셀 주변 AMR ${carriers}대 정체${people ? ` · 사람 ${people}명` : ''}${d != null ? ` · 정비 로봇 ${d}m 거리` : ' · 정비 로봇 배정 대기'}`, carriers, people, st };
    }
    if (inc.type === 'field') {
      const ev = inc.ev, sz = ev?.type === 'leak' ? '약 1.5m 원형 확산' : ev?.type === 'debris' ? '통로 위 물체 1개' : ev?.type === 'smoke' ? '희미한 연기 · 화염 없음' : ev?.type === 'intrusion' ? '사람 1명 · 출입구 쪽으로 이동 중' : '이상 영역';
      return { text: `${ev?.label ?? '현장 이벤트'} · ${sz} · 주변 이동체 ${ms.length}대`, carriers, people };
    }
    if (inc.type === 'supply') return { text: `입고 도크 트럭 ${this.inbound?.docked ? '하차 중' : '없음'} · 창고 원자재 ${this.whRaw}박스 · 창고 앞 AGV 대기 ${this.vehicles.filter((v) => v.task?.includes('대기')).length}대`, carriers, people };
    if (inc.type === 'parts') { const st = this.processing.find((x) => `rack:${x.id}` === inc.key); return { text: `${st?.name ?? ''} 부품 선반 비어 있음 · 보충 휴머노이드 ${this.helpers.filter((h) => h.carry).length}대 운반 중`, carriers, people }; }
    return { text: '현장 이상 없음', carriers, people };
  }
  droneAssist(inc, d) {
    const o = this.orch, obs = this.droneObserve(inc);
    if (inc.drone) { inc.drone.tArrive = this.time; o.step(inc, 'field', 'detect', `🛸 ${d.id} 현장 중계 이어받음 — ${obs.text}`); return; }   // 교대 중계: 첫 도착·판단 보강은 한 번만
    inc.drone = { by: d.id, tArrive: this.time, dt: this.time - inc.t0, obs: obs.text };
    o.step(inc, 'field', 'detect', `🛸 ${d.id} 현장 도착 (+${(this.time - inc.t0).toFixed(1)}초) · 상공 영상 실시간 중계 — ${obs.text}`);
    let dec = '';
    if (inc.type === 'equipment' && obs.st) {
      const st = obs.st;
      if (st.state === 'DOWN' && !st.techOnSite && st.repairRemaining > 0) {   // 고장 부위·원인을 영상으로 먼저 파악 → 정비 로봇에 부품·공구 준비 지시
        const before = st.repairRemaining; st.repairRemaining *= 0.85; st.repairTotal *= 0.85;
        dec = `고장 부위 사전 파악 → 정비 로봇 부품·공구 준비 지시, 예상 수리 ${Math.round(before)}초 → ${Math.round(st.repairRemaining)}초`;
      } else dec = '정비 진행 상황 확인 · 현재 조치 유지';
      if (obs.carriers >= 2) dec += ` · 셀 앞 AMR ${obs.carriers}대 정체 → 투입 보류 유지`;
    } else if (inc.type === 'field') {
      const t = inc.ev?.type;
      dec = t === 'leak' ? '누유 범위 확정 → 청소 범위·우회 경로 확정, 대응 휴머노이드에 위치 전달' : t === 'smoke' ? '열·연기 확산 없음 확인 → 보호정지는 가장 가까운 셀만 유지' : t === 'intrusion' ? '진입자 위치 추적 → 감속 구역 유지 · 원격 관제 경보' : '물체 위치 확정 → 제거 경로 전달';
    } else if (inc.type === 'supply') dec = `입고 트럭 미도착 확인 → 공급 차질 확정 · 안전재고 운송 우선`;
    else if (inc.type === 'parts') dec = '선반 결품 확인 → 보충 우선순위 상향';
    o.step(inc, 'orch', 'decide', `판단 보강(${o.name} · 드론 영상): ${dec}`);
    this.log('info', `${d.id} 사고 현장 중계 · ${inc.title}`, { obs: obs.text, dec: '드론 영상·현장 정보를 대응 근거로 반영', act: dec });
    this.stats.droneMissions = (this.stats.droneMissions ?? 0) + 1;
  }

  // 순찰 지점별 재방문 간격 (어느 드론이든) — 드론 운용 대수 산정 기준(재방문 p95)을 운영 중에 확인
  dronePatrolStats() {
    const g = [...(this.patrolGaps ?? [])].sort((a, b) => a - b);
    return g.length ? { mean: g.reduce((a, b) => a + b, 0) / g.length, p95: g[Math.min(g.length - 1, Math.floor(g.length * 0.95))], n: g.length } : null;
  }
  droneLog(d, where) {
    this.patrolLast ??= new Map(); const last = this.patrolLast.get(where);
    if (last != null) { (this.patrolGaps ??= []).push(this.time - last); if (this.patrolGaps.length > 300) this.patrolGaps.shift(); }
    this.patrolLast.set(where, this.time); (this.droneVisits ??= []).push({ t: this.time, by: d.id, where, battery: Math.round(d.battery) }); if (this.droneVisits.length > 40) this.droneVisits.shift(); }

  // ── 현장 이벤트: 발생 → 로봇 카메라 AI 감지 → 자율 대응 ─────────────────
  injectFieldEvent(type, x, z) {
    const E = FIELD_EVENTS[type]; if (!E) return null;
    this.fieldEvents ??= []; this.fieldSeq = (this.fieldSeq ?? 0) + 1;
    const ev = { id: this.fieldSeq, type, label: E.label, cls: E.cls, severity: E.severity, x, z, t0: this.time, detected: false, cleared: false };
    this.fieldEvents.push(ev);
    (this.fieldLog ??= []).push(ev); if (this.fieldLog.length > 50) this.fieldLog.shift();   // 처리 끝난 것도 남긴다 (FACOS 현장 감지 화면)
    return ev;
  }
  // 로봇 카메라 영상에서 처음 인식했을 때 (by: 이동체·로봇 이름, conf: 추론 신뢰도)
  detectFieldEvent(ev, by, conf) {
    if (ev.detected || ev.cleared) return;
    ev.detected = true; ev.detectedBy = by; ev.conf = conf; ev.tDetect = this.time;
    const o = this.orch, inc = o.open('field', `ev:${ev.id}`, `현장 이벤트 · ${FIELD_EVENTS[ev.type].label}`, by, { where: { x: ev.x, z: ev.z }, prio: FIELD_EVENTS[ev.type].prio ?? 2 });
    inc.ev = ev;
    ev.inc = inc;
    o.step(inc, 'field', 'detect', `${by} 카메라 AI 추론 — ${FIELD_EVENTS[ev.type].cls} 신뢰도 ${conf.toFixed(2)}`);
    o.step(inc, 'cell', 'self', ev.type === 'intrusion' ? '자체 조치: 주변 로봇 협동 감속 · 접근 금지 구역 표시' : '자체 조치: 감지 로봇 감속·우회 · 해당 구역 표시');
    o.later(0.5, () => o.step(inc, 'cell', 'report', `상위 보고: ${FIELD_EVENTS[ev.type].label} · 위치 x ${ev.x.toFixed(1)}, z ${ev.z.toFixed(1)}`));
    const E = FIELD_EVENTS[ev.type], P = E.prio ?? 2, where = `x ${ev.x.toFixed(1)} · z ${ev.z.toFixed(1)}`;
    const near = this.processing.reduce((b, st) => (Math.hypot(st.x - ev.x, st.z - ev.z) < Math.hypot(b.x - ev.x, b.z - ev.z) ? st : b), this.processing[0]);
    const loc = { x: ev.x, z: ev.z + (ev.z >= 0 ? 1.0 : -1.0), aisle: ev.z >= 0 ? 'F' : 'B', name: E.label };
    let act = '';
    const dispatch = () => {
    if (E.response === 'clean') {
      // 정비실 휴머노이드(대기 중 우선)가 정비실에서 청소 도구를 챙겨 출동 — 없으면 다른 휴머노이드
      // 우선순위: 대기 중 정비 휴머노이드 → 더 낮은 우선순위 일(예지정비·생산 작업)을 하던 휴머노이드를 돌린다 (더 급한 안전 대응 중인 로봇은 건드리지 않음)
      const h = this.pickResponder(ev, P);
      if (!h) { o.step(inc, 'orch', 'decide', `대응 자원 대기 — 휴머노이드가 모두 같거나 더 높은 우선순위 대응 중 (3초 뒤 재배정)`); o.later(3, () => { if (!ev.cleared) dispatch(); }); return; }
      if (h) {
        const resume = this.preemptJob(h, inc, P);   // 하던 일은 처리 후 이어서 (현장 작업 중이었으면 그 셀로 돌아가 이어 한다)
        h.job = { prio: P, ev, label: E.label };
        const kit = TOOL_KITS[ev.type] ? ev.type : 'debris', T = toolSteps(this, h, kit, inc), K = TOOL_KITS[kit];
        h.setTask(`${E.task} → ${near.name} 앞 (${K.label})`, [...T.take, { go: loc }, { do: () => o.step(inc, 'exec', 'act', `${h.id} 현장 도착 · ${K.label}로 ${E.task} 시작`) },
          { wait: 8, done: () => { ev.cleared = true; ev.tClear = this.time; this.endJob(h, ev); this.log('ok', `${E.label} 처리 완료`, { obs: `${h.id}가 ${K.label}(${K.items})로 ${E.task} 완료`, act: '구역 정상화 · 도구 반납' }); o.step(inc, 'exec', 'act', `${E.task} 완료 — 도구 정비실 반납`); o.close(inc, '구역 정상화 확인 · 인시던트 종료'); } },
          ...T.back, ...(resume.length ? [...T.exit, ...resume] : T.home(h.home))]);
        ev.responder = h.id; act = `${h.id} 출동 — 정비실에서 ${K.label}(${K.items}) 챙겨 ${E.task} (작업 중이던 일은 처리 후 재개)`;
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
      // 화재 초기 대응 대비: 대기 중인 정비 휴머노이드가 정비실에서 소화기를 챙겨 현장 옆에서 대기 (점검 끝나면 반납)
      // 화재(P1)는 최우선: 대기 중인 휴머노이드가 없으면 예지정비·수리·부품 보충 중인 휴머노이드를 돌려 소화기를 챙긴다 (하던 일은 해소 후 이어서)
      const fx = this.pickResponder(ev, P);
      if (fx) {
        const was = fx.idle ? null : fx.task, resume = this.preemptJob(fx, inc, P); fx.job = { prio: P, ev, label: '소화 대기' };
        const T = toolSteps(this, fx, 'smoke', inc), side = { ...loc, x: loc.x + 1.4, name: `${E.label} 소화 대기` };
        fx.setTask(`소화기 대기 → ${near.name} 부근 (소화기)`, [...T.take, { go: side }, { do: () => o.step(inc, 'exec', 'act', `${fx.id} 소화기 들고 현장 대기`) }, { until: () => ev.cleared }, { do: () => this.endJob(fx, ev) }, ...T.back, ...(resume.length ? [...T.exit, ...resume] : T.home(fx.home))]);
        act += ` · ${fx.id} 소화기 챙겨 현장 대기${was ? ` (P1 화재 우선 — "${was}" 중단 후 재개)` : ''}`;
      }
    } else {
      ev.until = this.time + 60;
      act = '주변 셀 안전 감속 25% 긴급 명령 · 접근 금지 구역 설정, 원격 관제 요원 호출';
    }
    o.step(inc, 'orch', 'decide', `우선순위 ${PRIORITY[P].label}${P === 1 ? ' — 최우선 처리 (예지정비·재보정 보류, 대응 자원 선점)' : ' — 생산·효율 작업보다 먼저'} · 판단(${o.name}): ${E.response === 'clean' ? '작업 경로 안전 위협 — 즉시 제거' : E.response === 'inspect' ? '화재 초기 징후 가능성 — 근접 확인' : '무인 구역 사람 진입 — 안전 우선'}`);
    o.step(inc, 'orch', 'command', `명령: ${act || '대응 자원 없음 — 원격 관제 호출'}`);
    // 긴급 명령을 셀 현장으로 보낸다: 사람 진입 → 주변 셀 안전 감속, 연기 의심 → 가장 가까운 셀 보호정지 (해소되면 재개 명령)
    ev.cmdCells = E.response === 'safety' ? this.processing.filter((st) => !st.standby && Math.hypot(st.x - ev.x, st.z - ev.z) < 9).map((st) => st.id) : E.response === 'inspect' ? [near.id] : [];
    if (!ev.cmdCells.length && E.response === 'safety') ev.cmdCells = [near.id];
    for (const id of ev.cmdCells) this.cmd.issue(E.response === 'safety' ? 'SAFE_SPEED' : 'SAFE_STOP', id, null, { inc, why: E.label });
    this.log('alert', `오케스트레이터 명령 · ${E.label}`, { obs: `${by} 보고 수신`, dec: `${o.name} 판단`, act });
    };
    o.later(o.latencyFor(P), dispatch);   // 화재·인명(P1)은 판단 대기를 줄여 바로 명령
    this.log('alert', `AI 비전 감지 · ${E.label}`, {
      obs: `${by} 카메라 영상 추론 — ${E.cls} 신뢰도 ${conf.toFixed(2)} · ${near.name} 부근 (${where})`,
      dec: '셀·로봇 자체 조치 후 공장 오케스트레이터에 보고',
      act: `${PRIORITY[P].label} · 오케스트레이터 판단 대기 (약 ${o.latencyFor(P).toFixed(1)}초)`,
    });
  }
  // ── 문제 해결 우선순위 (orchestrator.js PRIORITY) ─────────────────
  // 이동 로봇이 하는 일의 우선순위: 대기 99 · 안전 대응 1~2 · 긴급수리 3 · 부품 보충 4 · 예지정비·재보정 5
  jobPrio(m) { return m.idle ? 99 : m.job?.prio ?? 4; }
  // 현장 이벤트 대응 휴머노이드: 대기 중인 정비 휴머노이드(가까운 순) → 우선순위가 더 낮은 일을 하던 휴머노이드(덜 급한 일 · 가까운 순)
  pickResponder(ev, P) {
    const dist = (a) => Math.hypot(a.x - ev.x, a.z - ev.z);
    const ok = (k) => k.kind === 'humanoid' && this.jobPrio(k) > P && !(k.tool === 'smoke' && k.job?.prio <= P) && k.battery > 15;
    const techs = this.techs.filter(ok), helpers = this.helpers.filter(ok);
    const order = (a, b) => (b.idle - a.idle) || (this.jobPrio(b) - this.jobPrio(a)) || (dist(a) - dist(b));
    return techs.filter((k) => k.idle).sort(order)[0] ?? [...techs, ...helpers].sort(order)[0] ?? null;
  }
  // 하던 일을 멈추고 이어 할 단계 — 셀 현장에서 수리·정비 중이었으면 작업을 잠시 멈추고(진행률 유지), 돌아와서 이어 한다
  preemptJob(m, inc, P) {
    if (m.idle) return [];
    const prev = m.job, steps = m.steps;
    m.prevJob = prev ?? { prio: 4 };
    const st = prev?.st;
    let rest = steps;
    if (st && st.techOnSite && st.request === prev.req) {
      st.techOnSite = false;
      rest = [{ go: svcLoc(st) }, { do: () => { if (st.request === prev.req) { st.techOnSite = true; this.orch.step(this.orch.find(`fail:${st.id}`), 'exec', 'act', `${m.id} 안전 대응 후 복귀 · 수리 재개`); } } }, ...steps];
    }
    this.stats.preempts = (this.stats.preempts ?? 0) + 1;
    if (prev?.prio) (this.preemptLog ??= []).push({ t: this.time, who: m.id, from: prev.prio, to: P });
    this.orch.step(inc, 'orch', 'command', `${PRIORITY[P].short} 우선 — ${m.id} "${m.task ?? '작업'}"(${PRIORITY[prev?.prio ?? 4].short}) 중단 → 안전 대응 후 재개`);
    if (st) { const fi = this.orch.find(`fail:${st.id}`); this.orch.step(fi, 'orch', 'decide', `${m.id} 상위 우선순위(${PRIORITY[P].label}) 대응으로 잠시 이탈 — 대응 후 복귀`); }
    return rest;
  }
  endJob(m, ev) { if (m.job?.ev === ev) { m.job = m.prevJob ?? null; m.prevJob = null; } }

  // 현장 이벤트로 멈추거나 감속한 셀에 재개 명령을 보내고, 셀 완료 보고를 받은 뒤 인시던트를 닫는다
  resumeCells(ev, inc, closeText) {
    const code = ev.type === 'intrusion' ? 'SAFE_SPEED_OFF' : 'RESUME';   // 감속은 감속 해제, 보호정지는 운전 재개
    const o = this.orch, cs = (ev.cmdCells ?? []).map((id) => this.cmd.issue(code, id, null, { inc, why: `${ev.label} 해소` })).filter(Boolean);
    if (!cs.length) return o.close(inc, closeText);
    const wait = () => (cs.every((c) => c.state === 'done' || c.state === 'rejected') ? o.close(inc, closeText) : o.later(0.3, wait));
    wait();
  }
  // CCTV 배치 (사각지대 없는 배치 — 라인 배치가 같으면 캐시)
  get cctv() { return (this._cctv ??= planCCTV(this)); }
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
      { until: () => this.whRaw > 0, task: '창고 재고 대기 (입고 트럭 대기)' },
      { wait: 4, done: () => { const n = Math.min(PALLET_RAW, this.whRaw); this.whRaw -= n; v.load = { type: 'raw', n }; this.erp?.consume('raw', n, '투입구 (AS/RS)'); } },
      { go: this.loc.SRC },
      { wait: 4, done: () => {
        const n = v.load?.n ?? PALLET_RAW;
        this.rawStock = Math.min(RAW_CAP, this.rawStock + n);
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
    const inc = o.open('supply', 'supply', '자재 공급 차질', '자재창고', { where: { x: -48, z: -6 } });   // 창고·입고 도크 상공
    o.step(inc, 'field', 'detect', `창고 출고 중단·공급사 납품 지연 감지 (WMS) — 입고 트럭 미도착, 복구 예상 ${Math.round(sec / 60)}분`);
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
      impact: this.impact?.report(0),   // 원인별 손실: UPH·OEE(%p)·WIP·전력 (impact.js)
    };
  }
}
