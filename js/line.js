// 공정 라인 구성 — 공정 유형·로봇 카탈로그, 기본 라인, 검증, 비교.
// 브라우저(시뮬레이션·3D·편집기)와 서버(Claude 공정 설계)가 함께 쓴다. DOM 의존 없음.

export const STATION_TYPES = {
  cnc:      { label: 'CNC 가공',   effect: 'machine',  cycle: 9,  wear: 0.35, idleKW: 3,   busyKW: 15, task: '금속 소재 절삭 가공' },
  press:    { label: '프레스 성형', effect: 'machine',  cycle: 6,  wear: 0.4,  idleKW: 5,   busyKW: 22, task: '판재 프레스 성형' },
  laser:    { label: '레이저 가공', effect: 'machine',  cycle: 5,  wear: 0.2,  idleKW: 2,   busyKW: 8,  task: '레이저 절단·마킹' },
  weld:     { label: '용접',       effect: 'assemble', cycle: 12, wear: 0.3,  idleKW: 2,   busyKW: 10, task: '부품 용접' },
  assembly: { label: '조립',       effect: 'assemble', cycle: 8,  wear: 0.22, idleKW: 1.5, busyKW: 5,  task: '부품 체결·조립' },
  paint:    { label: '도장',       effect: 'paint',    cycle: 8,  wear: 0.28, idleKW: 4,   busyKW: 12, task: '자동 도장' },
  vision:   { label: '비전 검사',   effect: 'inspect',  cycle: 4,  wear: 0.12, idleKW: 0.4, busyKW: 1.5, task: '외관 결함 검사' },
  test:     { label: '기능 검사',   effect: 'inspect',  cycle: 5,  wear: 0.15, idleKW: 0.8, busyKW: 2.5, task: '전기·기능 시험' },
  pack:     { label: '포장',       effect: 'pack',     cycle: 6,  wear: 0.25, idleKW: 1.5, busyKW: 6,  task: '박스 포장', defectMul: 0.1 },   // 포장 손상은 드묾
  // 정밀조립 셀 — verify: 체결 토크·각도를 전수 판정해 불량을 걸러낸다(검사 겸용)
  sort:     { label: '부품 분류',   effect: 'sort',     cycle: 7,  wear: 0.14, idleKW: 0.8, busyKW: 3,  task: '비전 인식 기반 부품 피킹·분류·키팅' },
  pressfit: { label: '부품 압입',   effect: 'press',    cycle: 9,  wear: 0.3,  idleKW: 1.5, busyKW: 7,  task: '협동로봇 힘제어 압입 (하중-변위 모니터링)' },
  screw:    { label: '스크류 체결', effect: 'fasten',   cycle: 12, wear: 0.24, idleKW: 1,   busyKW: 4,  task: '스크류 자동 체결·토크 판정', verify: true },
  fasten:   { label: '부품 체결',   effect: 'fasten',   cycle: 12, wear: 0.28, idleKW: 1.5, busyKW: 6,  task: '다축 너트러너 볼트 체결·토크 판정', verify: true },
};

// factor: 사이클 배율(작을수록 빠름). 대수가 늘면 병렬 작업으로 사이클이 줄어든다.
export const ROBOT_KINDS = {
  none:        { label: '없음 (설비 단독)', short: '-',     factor: 1.0 },
  articulated: { label: '6축 다관절 로봇',  short: '6축',   factor: 1.0 },
  cobot:       { label: '협동로봇',         short: '협동',  factor: 1.25 },
  scara:       { label: 'SCARA 로봇',       short: 'SCARA', factor: 0.85 },
  // AMR 기반 양팔 로봇 (Autonomous Mobile Manipulator Robot) — 이동 플랫폼 위 양팔, 한 대가 두 팔로 동시 작업
  ammr:        { label: 'AMR 기반 양팔 로봇 (AMMR)', short: 'AMMR', factor: 0.9, darkOnly: true },   // 피지컬AI 단계 전용
  gantry:      { label: '갠트리 로봇',      short: '갠트리', factor: 0.9 },
  // 휴머노이드: 두 다리로 셀 작업 위치에 서서 양팔(각 6축)로 작업 — 사람 작업대 그대로 쓰는 범용성 대신 사이클은 협동로봇보다 조금 빠른 정도
  humanoid:    { label: '휴머노이드 로봇',  short: '휴머노이드', factor: 1.1, darkOnly: true },   // 피지컬AI 단계 전용
};

export const LAYOUTS = {
  straight: { label: '일자형 (I)', desc: '투입→적재가 한 줄로 흐르는 직선 라인' },
  u:        { label: 'U자형 (U)',  desc: '두 줄로 접어 투입·적재가 같은 쪽에 오는 U셀 라인 (회전 컨베이어 포함)' },
};
export const layoutLabel = (k) => (k === 'zone' ? '셀형 Zone (정밀조립)' : LAYOUTS[k]?.label ?? k);
export const MAX_STATIONS = 8;
export const MAX_ROBOTS = 4;
export const PARALLEL_GAIN = 0.7;   // 로봇(작업자) 1대 추가 시 처리능력 +70%

export const DEFAULT_LINE = {
  name: '자동차 부품 라인 (기본)',
  layout: 'straight',
  stations: [
    { id: 'CNC', type: 'cnc', name: 'CNC 가공', robot: { kind: 'none', count: 0 }, cycle: 9, task: '알루미늄 블록 절삭 가공' },
    { id: 'WELD', type: 'weld', name: '로봇 용접·조립', robot: { kind: 'articulated', count: 2 }, cycle: 12, task: '브래킷 용접 및 부품 조립' },
    { id: 'PAINT', type: 'paint', name: '자동 도장', robot: { kind: 'articulated', count: 1 }, cycle: 8, task: '방청 도장' },
    { id: 'VISION', type: 'vision', name: 'AI 비전 검사', robot: { kind: 'none', count: 0 }, cycle: 4, task: '외관 결함 자동 검출' },
    { id: 'PACK', type: 'pack', name: '로봇 포장', robot: { kind: 'articulated', count: 1 }, cycle: 6, task: '완제품 박스 포장' },
  ],
};

// ── 메타팩토리 테스트베드 정밀조립Zone (혼류 생산) ─────────────────
// 자재 투입 → 부품분류셀(공동)에서 부품 종류를 판별해 도어트림 라인 / e-axle 라인으로 분기
// → 각 라인의 조립셀 → 체결셀 → 포장셀(공동)로 합류 → 제품별 포장 후 구분 적재장의 제품별 구역에 적재.
// side -1: 설비 앞면(작업자·AGV 쪽)이 뒤쪽 통로를 향하도록 앞뒤 반전 배치
export const ZONE_NAME = '정밀조립Zone';
export const ZONE_PRODUCTS = {
  doortrim: { label: '도어트림', customer: '서연인테크' },
  eaxle: { label: 'e-axle', customer: '쉐플러코리아' },
};
export const ZONE_CELLS = {
  SORT:    { no: '1', type: 'sort',     label: '부품분류셀',      product: 'shared',   use: '공동 · 부품 종류 판별·분기', x: -18, z: 0 },
  DT_ASSY: { no: '2', type: 'assembly', label: '도어트림 조립셀', product: 'doortrim', use: '도어트림 라인', x: -5, z: 4.6 },
  DT_FAST: { no: '3', type: 'screw',    label: '도어트림 체결셀', product: 'doortrim', use: '도어트림 라인', x: 7, z: 4.6 },
  EA_ASSY: { no: '4', type: 'assembly', label: 'e-axle 조립셀',  product: 'eaxle',    use: 'e-axle 라인', x: -5, z: -4.6, side: -1 },
  EA_FAST: { no: '5', type: 'fasten',   label: 'e-axle 체결셀',  product: 'eaxle',    use: 'e-axle 라인', x: 7, z: -4.6, side: -1 },
  PACK:    { no: '6', type: 'pack',     label: '포장셀',          product: 'shared',   use: '공동 · 제품별 포장', x: 18, z: 0 },
};
const ZONE_SRC = { x: -28, z: 0 };
const ZONE_SINK = { x: 28, z: 0 };
// 제품별 경로 (투입·적재 제외)
export const ZONE_ROUTES = {
  doortrim: ['SORT', 'DT_ASSY', 'DT_FAST', 'PACK'],
  eaxle: ['SORT', 'EA_ASSY', 'EA_FAST', 'PACK'],
};
// 혼류 비율 (투입 순서는 비율에 맞춰 평준화)
export const ZONE_MIXES = {
  '1:1': { label: '1 : 1', w: { doortrim: 1, eaxle: 1 } },
  '2:1': { label: '2 : 1', w: { doortrim: 2, eaxle: 1 } },
  '1:2': { label: '1 : 2', w: { doortrim: 1, eaxle: 2 } },
  dt: { label: '도어트림만', w: { doortrim: 1, eaxle: 0 } },
  ea: { label: 'e-axle만', w: { doortrim: 0, eaxle: 1 } },
};
// 셀 사이 물류: 조립 대상물을 실은 AMR이 셀 중앙(양쪽 협동로봇 사이)으로 들어와 정차한다
// count: 대기열은 충전소 서쪽 빈 바닥에 16칸까지 — 더 늘리면 충전소와 겹치므로 대기열을 두 줄로 바꿔야 한다
export const ZONE_AMR = { count: 16, lineSpeed: 1.6, returnSpeed: 2.6, spacing: 2.0 };
// AMR 전용 동선 — AGV·정비 인력이 다니는 주 통로를 따라 달리지 않고, 두 곳에서 가로지르기만 한다.
//  · 복귀: 구분 적재장 → 오른쪽 끝(x=31.2)에서 북쪽으로 → 건물 앞쪽 AMR 전용 복귀로(z=18.8)를 서쪽으로 → 대기열
//  · 대기열: 앞쪽 왼편 빈 바닥(z=17, 충전소보다 서쪽)에 한 줄
//  · 출동: 대기열 남쪽 출동 차로(z=15.4) → 투입 스테이션 왼쪽 진입로(x=-30.6) → 투입 위치
export const AMR_LANES = { ret: 18.8, park: 17.0, out: 15.4, retX: 31.2, dockX: -30.6 };
export const amrPark = (i) => ({ x: -36.4 + i * 1.4, z: AMR_LANES.park, aisle: 'F', name: `AMR 대기 ${i + 1}` });
export const amrDockVia = (p) => [{ x: p.x, z: AMR_LANES.out }, { x: AMR_LANES.dockX, z: AMR_LANES.out }, { x: AMR_LANES.dockX, z: 0 }];
export const amrReturnVia = (from, slot) => [{ x: AMR_LANES.retX, z: from.z }, { x: AMR_LANES.retX, z: AMR_LANES.ret }, { x: slot.x, z: AMR_LANES.ret }];
export const AMR_DOCK = { ...ZONE_SRC, aisle: 'F', name: 'AMR 적재 위치' };
export const FG_ZONE_CAP = 24;
// AMMR 부품 보충: 셀 양쪽의 부품 선반(셀 중심에서 3.75m, AMMR 작업 위치에서 약 1m)을 오가며 로봇 부품 빈을 채운다
export const AMMR = { rackZ: 3.75, pickZ: 2.95, slotZ: 1.9 };
// AMMR 작업 사이클(진행률) 안의 부품 선반 왕복 구간 끝: 회전 → 주행 → 피킹 → 회전 → 복귀, 이후 작업 (place까지 부품을 들고 있음)
export const AMMR_FETCH = { turnOut: 0.06, driveOut: 0.14, pick: 0.24, turnIn: 0.3, driveIn: 0.38, place: 0.5 };   // 구분 적재장의 제품별 구역 용량

const ZONE_RECIPES = [
  { id: 'SORT', robot: { kind: 'ammr', count: 2 }, cycle: 7, task: 'AMMR 양팔로 옆 부품 선반에서 부품을 가져와 판별·분류·키팅' },
  { id: 'DT_ASSY', robot: { kind: 'cobot', count: 4 }, cycle: 14, task: '양쪽 협동로봇이 패널에 암레스트·스피커그릴·스위치 조립, 클립 압입' },
  { id: 'DT_FAST', robot: { kind: 'cobot', count: 2 }, cycle: 14, task: '스크류 자동 체결, 토크·각도 전수 판정' },
  { id: 'EA_ASSY', robot: { kind: 'cobot', count: 4 }, cycle: 16, task: '양쪽 협동로봇이 베어링 압입·로터·감속기어 삽입, 하우징 결합' },
  { id: 'EA_FAST', robot: { kind: 'articulated', count: 1 }, cycle: 12, task: '하우징 볼트 다축 너트러너 체결, 토크·각도 전수 판정' },
  { id: 'PACK', robot: { kind: 'ammr', count: 2 }, cycle: 8, task: 'AMMR 양팔로 옆 선반에서 포장재를 가져와 제품별 포장·라벨' },
];

export function zoneLine(mix = '1:1') {
  return {
    name: `${ZONE_NAME} · 도어트림 + e-axle 혼류`, layout: 'zone', mix,
    stations: ZONE_RECIPES.map((r) => ({ ...r, name: ZONE_CELLS[r.id].label, type: ZONE_CELLS[r.id].type, robot: { ...r.robot } })),
  };
}
export const isZone = (line) => line?.layout === 'zone';
export const defaultLineFor = (line) => cloneLine(isZone(line) ? zoneLine(line.mix) : DEFAULT_LINE);
// 혼류 비율에 따른 셀별 처리 비중 (공동 셀은 1)
export function zoneShare(line, id) {
  const w = ZONE_MIXES[line.mix]?.w ?? ZONE_MIXES['1:1'].w, tot = w.doortrim + w.eaxle;
  const p = ZONE_CELLS[id]?.product;
  return !p || p === 'shared' ? 1 : w[p] / tot;
}
// 설비 연결 (from, to, 해당 제품 — 공통이면 null)
export function lineEdges(line) {
  const ids = ['SRC', ...line.stations.map((s) => s.id), 'SINK'];
  if (!isZone(line)) return ids.slice(1).map((id, i) => [ids[i], id, null]);
  const edges = [['SRC', 'SORT', null]];
  for (const [p, r] of Object.entries(ZONE_ROUTES)) {
    r.slice(1).forEach((id, i) => {
      const from = r[i], shared = ZONE_CELLS[from].product === 'shared' && ZONE_CELLS[id].product === 'shared';
      if (!edges.some((e) => e[0] === from && e[1] === id)) edges.push([from, id, ZONE_CELLS[from].product === 'shared' ? (shared ? null : p) : null]);
    });
  }
  edges.push(['PACK', 'SINK', null]);
  return edges;
}

export const cloneLine = (l) => JSON.parse(JSON.stringify(l));

// 실효 사이클(초, 모드 배율 적용 전). 전통 모드는 로봇 대신 같은 수의 작업자가 수작업한다.
// AMMR(AMR 기반 양팔 로봇)은 피지컬AI 단계에서만 쓴다. 레거시·자동화 단계에서는 같은 대수의 양쪽 협동로봇 셀로 운영한다
// (라인 설정에는 AMMR로 남겨 두어 피지컬AI 단계로 가면 다시 AMMR이 된다)
export const AMMR_MODES = ['dark'];
export const ammrAllowed = (modeKey) => AMMR_MODES.includes(modeKey);
export const robotForMode = (robot, modeKey) => (ROBOT_KINDS[robot?.kind]?.darkOnly && !ammrAllowed(modeKey) ? { ...robot, kind: 'cobot' } : robot);   // 피지컬AI 전용 로봇(AMMR·휴머노이드)
const taskForMode = (s, modeKey) => (ROBOT_KINDS[s.robot?.kind]?.darkOnly && !ammrAllowed(modeKey) ? String(s.task ?? '').replace(/AMMR\s*양팔로\s*/, '양쪽 협동로봇이 ').replace(/옆\s*(부품\s*)?선반에서\s*\S+\s*가져와\s*/, '') : s.task);
export function effCycle(s, modeKey = 'smart') {
  const n = Math.max(1, s.robot?.count ?? 0);
  const kind = robotForMode(s.robot, modeKey)?.kind ?? 'none';
  const kf = modeKey === 'traditional' || kind === 'none' || !(s.robot?.count > 0) ? 1 : ROBOT_KINDS[kind].factor;
  return (s.cycle * kf) / (1 + PARALLEL_GAIN * (n - 1));
}

const TYPE_ALIASES = { 분류: 'sort', 압입: 'pressfit', 스크류: 'screw', 나사: 'screw', 체결: 'fasten', 가공: 'cnc', 절삭: 'cnc', 프레스: 'press', 레이저: 'laser', 용접: 'weld', 조립: 'assembly', 도장: 'paint', 비전: 'vision', 검사: 'vision', 시험: 'test', 포장: 'pack' };

// 입력(사용자 편집·Claude 응답)을 검증·보정한다. errors가 있으면 적용 불가.
export function normalizeLine(raw) {
  const errors = [], warnings = [];
  const src = Array.isArray(raw?.stations) ? raw.stations : [];
  if (!src.length) errors.push('공정이 하나 이상 있어야 합니다.');
  if (src.length > MAX_STATIONS) errors.push(`공정은 최대 ${MAX_STATIONS}개까지 배치할 수 있습니다 (현재 ${src.length}개).`);
  const used = new Set();
  const stations = src.slice(0, MAX_STATIONS).map((s, i) => {
    let type = String(s.type ?? '').toLowerCase();
    if (!STATION_TYPES[type]) {
      const alias = Object.keys(TYPE_ALIASES).find((k) => String(s.type ?? '').includes(k));
      if (alias) type = TYPE_ALIASES[alias];
      else { errors.push(`${i + 1}번 공정: 알 수 없는 유형 "${s.type}"`); type = 'assembly'; }
    }
    const T = STATION_TYPES[type];
    let kind = String(s.robot?.kind ?? s.robot_kind ?? 'none');
    if (!ROBOT_KINDS[kind]) { warnings.push(`${i + 1}번 공정: 알 수 없는 로봇 "${kind}" → 없음`); kind = 'none'; }
    let count = Math.round(Number(s.robot?.count ?? s.robot_count ?? 0)) || 0;
    if (kind === 'none') count = 0;
    else if (count < 1) count = 1;
    if (count > MAX_ROBOTS) { warnings.push(`${i + 1}번 공정: 로봇은 최대 ${MAX_ROBOTS}대 → ${MAX_ROBOTS}대로 조정`); count = MAX_ROBOTS; }
    let cycle = Number(s.cycle ?? s.cycle_s);
    if (!(cycle > 0)) cycle = T.cycle;
    if (cycle < 2 || cycle > 40) { warnings.push(`${i + 1}번 공정: 사이클 ${cycle}초 → 2~40초로 조정`); cycle = Math.min(40, Math.max(2, cycle)); }
    const name = String(s.name ?? '').trim().slice(0, 20) || T.label;
    const task = String(s.task ?? '').trim().slice(0, 60) || T.task;
    let id = String(s.id ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 10) || type.toUpperCase();
    if (['SRC', 'SINK'].includes(id)) id = type.toUpperCase();
    let uid = id, k = 2;
    while (used.has(uid)) uid = `${id}${k++}`;
    used.add(uid);
    return { id: uid, type, name, robot: { kind, count }, cycle: Math.round(cycle * 10) / 10, task };
  });
  if (!stations.some((s) => STATION_TYPES[s.type].effect === 'inspect' || STATION_TYPES[s.type].verify)) warnings.push('검사 공정이 없어 불량이 모두 출하됩니다.');
  let layout = String(raw?.layout ?? 'straight').toLowerCase();
  const out = { name: String(raw?.name ?? '').trim().slice(0, 40) || '사용자 정의 라인', layout, stations };
  if (layout === 'zone') {
    // 셀은 바닥에 고정 배치되어 있으므로 셀 구성·순서·유형은 바꿀 수 없고 레시피만 바꾼다
    out.mix = ZONE_MIXES[raw?.mix] ? raw.mix : '1:1';
    const want = Object.keys(ZONE_CELLS);
    if (want.join() !== stations.map((s) => s.id).join()) {
      errors.push(`${ZONE_NAME}의 셀 구성은 ${want.map((id) => `${ZONE_CELLS[id].no}.${ZONE_CELLS[id].label}`).join(', ')}로 고정입니다.`);
    }
    for (const s of stations) {
      const cell = ZONE_CELLS[s.id];
      if (cell && s.type !== cell.type) { warnings.push(`${cell.label}의 유형은 ${STATION_TYPES[cell.type].label}로 고정 → 되돌림`); s.type = cell.type; }
    }
  } else if (!LAYOUTS[layout]) { warnings.push(`알 수 없는 레이아웃 "${raw?.layout}" → 일자형`); out.layout = 'straight'; }
  return { line: out, errors, warnings };
}

// 혼류 Zone은 셀별 처리 비중을 곱한 부하(투입 1개당 점유 시간)로 병목을 잡는다
export function lineMetrics(line, modeKey = 'smart') {
  let bott = null, bc = 0, robots = 0;
  for (const s of line.stations) {
    const c = effCycle(s, modeKey) * (isZone(line) ? zoneShare(line, s.id) : 1);
    if (c > bc) { bc = c; bott = s; }
    robots += s.robot.count;
  }
  return { stations: line.stations.length, robots, bottleneck: bott, bottleneckCycle: bc, uph: bc ? 3600 / bc : 0 };
}

const robotText = (r) => (r.count ? `${ROBOT_KINDS[r.kind].label} ${r.count}대` : '로봇 없음');

// 현재 라인과 초안의 차이를 사람이 읽을 수 있는 목록으로
export function diffLines(a, b) {
  const out = [];
  const ai = new Map(a.stations.map((s, i) => [s.id, { s, i }]));
  const bi = new Map(b.stations.map((s, i) => [s.id, { s, i }]));
  for (const [id, { s }] of ai) if (!bi.has(id)) out.push({ kind: 'del', id, text: `삭제: ${s.name}` });
  b.stations.forEach((s, i) => {
    const prev = ai.get(s.id);
    if (!prev) { out.push({ kind: 'add', id: s.id, text: `추가: ${i + 1}번째에 ${s.name} (${STATION_TYPES[s.type].label}, ${robotText(s.robot)}, ${s.cycle}초)` }); return; }
    const p = prev.s, ch = [];
    if (p.name !== s.name) ch.push(`이름 ${p.name}→${s.name}`);
    if (p.type !== s.type) ch.push(`유형 ${STATION_TYPES[p.type].label}→${STATION_TYPES[s.type].label}`);
    if (p.robot.kind !== s.robot.kind || p.robot.count !== s.robot.count) ch.push(`로봇 ${robotText(p.robot)}→${robotText(s.robot)}`);
    if (p.cycle !== s.cycle) ch.push(`사이클 ${p.cycle}→${s.cycle}초`);
    if (p.task !== s.task) ch.push(`작업 "${s.task}"`);
    if (ch.length) out.push({ kind: 'mod', id: s.id, text: `변경: ${s.name} — ${ch.join(', ')}` });
  });
  const orderA = a.stations.map((s) => s.id).filter((id) => bi.has(id));
  const orderB = b.stations.map((s) => s.id).filter((id) => ai.has(id));
  if (orderA.join() !== orderB.join()) out.push({ kind: 'mod', id: null, text: `공정 순서 변경: ${b.stations.map((s) => s.name).join(' → ')}` });
  if (a.name !== b.name) out.push({ kind: 'mod', id: null, text: `라인 이름: ${b.name}` });
  if ((a.layout ?? 'straight') !== (b.layout ?? 'straight')) out.push({ kind: 'mod', id: null, text: `레이아웃: ${layoutLabel(a.layout ?? 'straight')} → ${layoutLabel(b.layout)}` });
  return out;
}

// ── 배치 기하 ─────────────────
// rot은 three.js rotation.y — 설비 로컬 +x가 흐름 방향, 로컬 +z가 작업자·AGV 쪽(앞면)
// side -1이면 앞뒤(로컬 z)를 뒤집는다 (3D 모델은 scale.z = -1로 같이 반전)
export function toWorld(def, lx, lz) {
  const c = Math.cos(def.rot ?? 0), sn = Math.sin(def.rot ?? 0);
  lz *= def.side ?? 1;
  return { x: def.x + lx * c + lz * sn, z: (def.z ?? 0) - lx * sn + lz * c };
}
const flowDir = (def) => ({ x: Math.cos(def.rot ?? 0), z: -Math.sin(def.rot ?? 0) });

function placeNodes(m, layout, line) {
  if (layout === 'zone') {
    return [ZONE_SRC, ...line.stations.map((s) => ZONE_CELLS[s.id]), ZONE_SINK].map((p) => ({ x: p.x, z: p.z, rot: 0, side: p.side ?? 1 }));
  }
  if (layout === 'u' && m >= 4) {
    const k1 = Math.ceil(m / 2), xs = [];
    for (let i = 0; i < k1; i++) xs.push(-26 + (50 * i) / (k1 - 1));
    const nodes = [];
    for (let i = 0; i < m; i++) {
      if (i < k1) nodes.push({ x: xs[i], z: 3.2, rot: 0 });
      else nodes.push({ x: xs[k1 - 1 - (i - k1)], z: -3.2, rot: Math.PI });
    }
    return nodes;
  }
  const sp = 55 / (m - 1);
  return Array.from({ length: m }, (_, i) => ({ x: -26 + sp * i, z: 0, rot: 0 }));
}

// 설비 중심 → 다음 설비 입구(중심에서 흐름 반대 방향 2m)까지의 컨베이어 경로.
// 같은 줄이면 직선, 같은 방향의 다른 줄이면 분기(ㄱ자 꺾임), 방향이 반대면 U턴.
export function conveyorPath(a, b) {
  const d = flowDir(b);
  const entry = { x: b.x - d.x * 2, z: (b.z ?? 0) - d.z * 2 };
  const az = a.z ?? 0, bz = b.z ?? 0;
  if (Math.abs(az - bz) < 0.01) return [{ x: a.x, z: az }, entry];
  if (Math.abs((a.rot ?? 0) - (b.rot ?? 0)) < 0.01) {
    const mx = (a.x + 2.1 + entry.x) / 2;
    return [{ x: a.x, z: az }, { x: mx, z: az }, { x: mx, z: bz }, entry];
  }
  const turnX = 31.5;
  return [{ x: a.x, z: az }, { x: turnX, z: az }, { x: turnX, z: bz }, entry];
}
// 정밀조립Zone 경로: 셀 중앙 → 셀 출구 → (대각 이동) → 다음 셀 입구. 포장셀로 합류하는 두 줄은
// 입구 앞에서 좌우로 0.75m 떨어진 별도 대기 차로를 쓴다
export function zonePath(a, b) {
  const az = a.z ?? 0, bz = b.z ?? 0;
  const merge = Math.abs(az - bz) > 0.01 && Math.abs(bz) < 0.01;
  const entry = { x: b.x - 2, z: merge ? Math.sign(az - bz) * 0.75 : bz };
  if (Math.abs(az - entry.z) < 0.01) return [{ x: a.x, z: az }, entry];
  return [{ x: a.x, z: az }, { x: a.x + 2.3, z: az }, { x: entry.x - 3, z: entry.z }, entry];
}
export function linkPath(line, a, b) { return isZone(line) ? zonePath(a, b) : conveyorPath(a, b); }

export function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}
export function pointAt(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (s <= L || i === pts.length - 1) { const k = L ? Math.min(1, s / L) : 0; return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }; }
    s -= L;
  }
  return { ...pts[pts.length - 1] };
}

// 시뮬레이션용 설비 정의 (투입·적재 포함, 레이아웃에 따라 자동 배치)
export function buildStationDefs(line, modeKey) {
  const n = line.stations.length;
  const nodes = placeNodes(n + 2, line.layout ?? 'straight', line);
  const defs = [{ id: 'SRC', type: 'source', ...nodes[0], name: modeKey === 'traditional' ? '자재 투입 (수작업)' : '자재 투입 (AS/RS)' }];
  line.stations.forEach((s, i) => {
    const T = STATION_TYPES[s.type];
    const manual = modeKey === 'traditional' && s.robot.count > 0;
    const p = nodes[i + 1];
    defs.push({
      id: s.id, type: s.type, x: +p.x.toFixed(2), z: p.z, rot: p.rot, side: p.side,
      name: modeKey !== 'traditional' ? s.name
        : T.effect === 'inspect' ? `${s.name.replace(/^(AI|자동|로봇)\s*/, '')} (육안)`
        : manual ? `${s.name.replace(/^(협동로봇|로봇|AI|자동)\s*/, '')} (수작업)` : s.name,
      robot: { ...robotForMode(s.robot, modeKey) }, task: taskForMode(s, modeKey), baseCycle: s.cycle, cycle: effCycle(s, modeKey),
      wear: T.wear, idleKW: T.idleKW, busyKW: T.busyKW, effect: T.effect, inspect: T.effect === 'inspect' || !!T.verify,
      defectMul: T.defectMul ?? 1, share: isZone(line) ? zoneShare(line, s.id) : 1, product: ZONE_CELLS[s.id] && isZone(line) ? ZONE_CELLS[s.id].product : null,
    });
  });
  defs.push({ id: 'SINK', type: 'sink', ...nodes[n + 1], name: isZone(line) ? '구분 적재장 (제품별)' : '완제품 적재' });
  return defs;
}
