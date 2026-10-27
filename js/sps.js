// 정밀조립Zone 서열 키팅(SPS, Set Parts Supply) · 라인사이드 칸반 — DOM 없음 (헤드리스 시험 가능)
//  · 부품분류셀 양옆 키팅 구역: 흐름 랙 3대(바깥 통로 쪽에서 보충 · 셀 쪽에서 꺼냄) → 피킹 로봇이 생산 순서대로 한 대분 키트를 담음 → 검증대(영상 + 무게) → 서열 버퍼(키트 3개)
//    도어트림(+z): 좌/우 · 색상 변형 부품 · 플렉시블 피더(스위치) / e-axle(−z): 클린 부스(커튼 + FFU) · 포장째 보관한 베어링·오일씰 개봉 · 로트 스캔
//  · 1. 키트는 AMR에 함께 실려 간다 — AMR 앞뒤 끝 키트 포켓(상판 아래 · 차체 크기 그대로). 부품분류셀 로봇이 버퍼에서 꺼내 싣고, 조립셀 로봇은 첫 점에서 키트 부품을 집는다
//  · 2. 공용 부품(클립 · 스크류 · 볼트 · 와셔)은 조립·체결셀 선반에 두고 투빈 칸반으로 보충 — 피지컬AI는 물류 휴머노이드(sim.js 부품 보충) · 자동화는 정해진 경로 순회(밀크런) · 레거시는 작업자가 빈 상자를 보고
//  · 피지컬AI(dark): ① 범용 파지(VLA — 새 부품·사양 무교시) ② 빈 피킹(섞인 스위치·씰 — 집기 실패를 스스로 다시) ③ 키트 검증 AI(영상 + 무게 — 좌/우·색상·수량)
//                    ④ 로트 추적(집으면서 베어링·오일씰 로트 판독 → 제품 계보) ⑤ 힘 제어 개봉 · 클린 부스 안 이물 없는 취급 ⑥ 결품·막힘 예측(생산 순서로 미리 보충 · 막힌 라인 키트는 덜 담음)
//    자동화(smart): 레일 협동로봇 표시등 피킹 · 무게 검증(같은 무게의 좌/우는 못 잡음 → 조립셀에서 발견) · 검증대 고정 스캐너 · 작업자 개봉 · 칸반 카드
//    레거시: 작업자 키팅 · 육안 확인 · 수기 로트 기록 · 빈 칸이 보여야 보충
//  · 데이터: 키트 기록 · 보충·칸반 이벤트 · 센서 샘플 묶음(outbox — 최근 200건) · 토픽 jin3d/sps/v1/main/SORT
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export const SPS_CELL = 'SORT';
export const SPS_TOPIC = 'jin3d/sps/v1/main/SORT';
// 키트 부품 (한 대분 4개 — 조립셀 로봇 i가 첫 점에서 i번째를 집는다 · 조립셀 부품 순서와 같음): [이름, 3D 부품, 흐름 랙 번호, 무게 g, 변형, 로트 추적]
export const SPS_KITS = {
  doortrim: [['컵홀더', 'P_CupHolder', 1, 140, '색상'], ['암레스트', 'P_Armrest', 0, 620, '좌/우 · 색상'], ['스피커 그릴', 'P_Grille', 1, 180, '좌/우'], ['윈도 스위치', 'P_Switch', 2, 90, '사양']],
  eaxle: [['헬리컬 기어 세트', 'P_Gear', 0, 1850, '감속비'], ['출력 샤프트', 'P_Shaft', 0, 1200, '차종'], ['베어링', 'P_Bearing', 1, 420, '로트', true], ['오일씰', 'P_Seal', 2, 60, '로트', true]],
};
export const SPS_RACKS = {
  doortrim: ['암레스트 (좌/우 · 색상)', '컵홀더 · 스피커 그릴', '윈도 스위치 (플렉시블 피더)'],
  eaxle: ['기어 세트 · 샤프트', '베어링 (포장째)', '오일씰 (포장째)'],
};
export const SPS_SIDE = { doortrim: 1, eaxle: -1 };   // 키팅 구역 쪽 (셀 로컬 z 부호) — 게이트 결정의 주 작업 로봇 쪽과 같다
const COLORS = ['블랙', '그레이', '베이지'], RATIOS = ['9.1', '10.5'];
// 라인사이드 공용 부품 (투빈 칸반) — 조립·체결셀마다
export const SPS_LINE = {
  DT_ASSY: '트림 클립', DT_FAST: '스크류 · 와셔', EA_ASSY: '압입 핀 · 스냅링', EA_FAST: '플랜지 볼트 · 와셔',
};
export const SPS_SPEC = {
  model: '서열 키팅 구역 2곳 (흐름 랙 3대 · 피킹 로봇 · 검증대 · 서열 버퍼) + AMR 키트 포켓 · 라인사이드 투빈 칸반', asset: 'PA-SORT-SPS',
  bufCap: 3,                                                   // 서열 버퍼 키트 수 (제품마다)
  kitT: { dark: 6.5, smart: 7.5, traditional: 10 },            // 키트 1개 담기 + 검증 (초)
  rackCap: 48, reorder: { dark: 0.35, smart: 0.25, traditional: 0 }, lead: { dark: 200, smart: 150, traditional: 120 },   // 흐름 랙 칸(키트 수) · 보충 요청 문턱 · 보충까지
  pickErr: { dark: 0.003, smart: 0.012, traditional: 0.025 },  // 키트 1개당 잘못 담을 확률 (누락 · 좌/우 · 색상)
  sameWeight: 0.6,                                             // 잘못 담은 것 중 무게로 못 잡는 비율 (좌/우 · 색상은 무게가 같다)
  missDelay: 25,                                               // 조립셀에서 발견 → 키팅 구역에서 맞는 부품을 가져옴 (초)
  graspFail: 0.02, scanFail: { smart: 0.015, traditional: 0.02 }, rescan: 5,   // ② 빈 피킹 집기 실패(다시 집음) · ④ 로트 라벨 판독 실패(자동화: 다시 스캔 · 레거시: 기록 누락)
  fod: { smart: 0.002, traditional: 0.006 },                   // ⑤ e-axle 키트 이물 노출 (작업자 개봉)
  binCap: 40, milkRun: 300, legacyNotice: [180, 720], rush: 45, // 라인사이드 투빈 칸반: 상자 1개 용량(대) · 자동화 순회 주기 · 레거시 빈 상자 발견까지 · 결품 시 급히 가져오는 시간
};
export const SPS_SENSORS = [
  { key: 'weight', label: '키트 무게', unit: 'g', dev: '검증대 로드셀' },
  { key: 'vision', label: '키트 영상 판정 신뢰도', unit: '%', dev: '검증대 카메라 (부품 종류 · 좌/우 · 색상)', warn: { lo: 90 }, alarm: { lo: 80 } },
  { key: 'bufDT', label: '도어트림 서열 버퍼', unit: '개', dev: '버퍼 컨베이어 센서', warn: { lo: 1 }, alarm: { lo: 0 } },
  { key: 'bufEA', label: 'e-axle 서열 버퍼', unit: '개', dev: '버퍼 컨베이어 센서', warn: { lo: 1 }, alarm: { lo: 0 } },
  { key: 'stock', label: '흐름 랙 최소 재고', unit: '%', dev: '랙 비전 계수 (피지컬AI) · 칸반 카드 (자동화)', warn: { lo: 25 }, alarm: { lo: 10 } },
  { key: 'particle', label: '클린 부스 입자 (0.5µm)', unit: '개/ft³', dev: 'e-axle 클린 부스 파티클 카운터', warn: { hi: 8000 }, alarm: { hi: 10000 } },
  { key: 'line', label: '라인사이드 최소 재고', unit: '%', dev: '조립·체결셀 투빈 (칸반)', warn: { lo: 20 }, alarm: { lo: 5 } },
  { key: 'grasp', label: '피킹 성공률', unit: '%', dev: '피킹 로봇 그리퍼 센서', warn: { lo: 97 }, alarm: { lo: 94 } },
];
// 키트 1개 담기 진행 구간 (0~1): 부품 4개 피킹 (0 ~ 0.8, 부품마다 0.2) · 검증 (0.8 ~ 1)
export const SPS_T = { pick: 0.8, verify: 1 };
export const SPS_PHASE_KO = { pick: '흐름 랙에서 피킹', verify: '검증 (영상 · 무게)', full: '서열 버퍼 가득 — 대기', stockout: '흐름 랙 결품 — 보충 대기', idle: '대기' };
// 키팅 구역 배치 (부품분류셀 로컬 m — x: 흐름 방향, z: 쪽 부호 × 값) · 셀(±2.3) 밖 셀 앞뒤 · 동쪽 분기 차로(z ±3 높이에서 x 4.2~)와 서쪽 정비 자리(x −3.0)를 비킨다
//  · 키트 컨베이어 z 3.05: 동쪽 끝 담기·검증 자리(x 2.0) → 서쪽으로 서열 버퍼 4칸(x 1.5 · 1.0 · 0.5 · 0 = 꺼내는 자리 — 부품분류셀 로봇이 AMR 가운데 맞은편에 서므로 그 앞)
//    꺼내는 자리 서쪽 끝에 빈 트레이 회수 슈트(x −0.7) → 컨베이어 아래 회수 레인(y 0.4)으로 담기 자리까지 돌아감
//  · 피킹 길 z 4.1 (레일 · AMMR · 작업자 — 랙 끝 칸까지 x −2.15 ~ 2.05) · 흐름 랙 z 5.4 (셀 쪽 z 4.95에서 꺼내고 바깥 z 5.85에서 보충)
//  · e-axle 쪽: 개봉대(x −1.65 · 컨베이어 줄) · 클린 부스(피킹 길·흐름 랙을 덮고 컨베이어 쪽은 트였다)
export const SPS_GEO = {
  conv: { z: 3.05, x0: -0.4, x1: 2.35, y: 0.86, w: 0.5 }, buf: [0, 0.5, 1.0, 1.5], build: 2.0, pickZ: 2.4,
  chute: { x: -0.62, y: 0.66, x0: -0.95, x1: -0.35, top: 0.8 }, ret: { y: 0.4 },   // 회수 슈트(서쪽이 높고 동쪽으로 내려가 컨베이어 아래 회수 레인으로) · 빈 트레이를 놓는 자리
  armZ: 1.6,   // 부품분류셀 협동로봇·6축 자리 (셀 중심에서) — 컨베이어 맨 앞 트레이(1.45m)와 키트 포켓 먼 칸(1.69m)에 모두 닿는다 (UR20 리치 1.75m)
  lane: 4.1, laneX: [-2.15, 2.05], racks: [-1.75, -0.2, 1.3], rackZ: 5.4, rackW: 1.3, rackD: 0.9, depack: -1.65,
  booth: { x0: -2.85, x1: 2.6, z0: 3.62, z1: 6.15, h: 2.55 },   // 동쪽 끝은 피킹 로봇이 담기 자리(x 2.0)·셋째 랙 끝 칸(x 1.7)에 팔을 뻗어도 모서리 기둥에 닿지 않게
};
// AMR 키트 포켓 칸 (대상물 그룹 좌표 · 칸 바닥): 지그 상판 뒤끝(x −0.67) · 앞끝(x 0.62) 트레이 — 제품마다 자기 쪽 절반(도어트림 +z · e-axle −z)에 칸 4개
// 부품분류셀의 그 제품 쪽 로봇이 자기 앞쪽 절반에 부품 j(SPS_KITS 순서)를 칸 j에 넣고, 조립셀 로봇은 자기 자리 쪽 칸에서 집는다
export const kitSlot = (product, j) => [j < 2 ? -0.67 : 0.62, 0.02, (SPS_SIDE[product] ?? 1) * (j % 2 ? 0.3 : 0.1)];
// 부품분류셀 키트 옮겨 싣기 진행 구간 — 그 제품 쪽 로봇 1대가 한다 (셀 사이클 = 실제 작업 시간 line.js ZONE_T.SORT · 화면 factory.js sortAMMR · sortArm)
//  · AMMR(피지컬AI): 셀 쪽 → 컨베이어 쪽으로 돎 → 컨베이어 앞으로 → (지난번 빈 트레이를 회수 슈트에) → 맨 앞 키트 트레이를 두 손으로 집음 → 셀 쪽으로 돎 → AMR 앞으로 다가섬
//    → 뒤 포켓 쪽으로 옆걸음 → 한 손으로 트레이를 들고 다른 손으로 부품 2개를 하나씩 집어 뒤 포켓 칸에 → 앞 포켓 쪽으로 옆걸음(트레이를 두 손으로) → 부품 2개를 앞 포켓 칸에 → 대기 자리로 (빈 트레이는 든 채)
//  · 협동로봇·6축(자동화): 컨베이어 맨 앞 트레이의 부품 4개를 하나씩 집어 키트 포켓 칸에 넣음 → 빈 트레이를 회수 슈트에
export const SORT_AMMR = {
  turnOut: [0.05, 0.1], driveOut: [0.1, 0.17], drop: [0.17, 0.25], pick: [0.25, 0.36], turnIn: [0.36, 0.4], driveIn: [0.4, 0.48],
  shiftR: [0.48, 0.52], parts: [[0.52, 0.61], [0.61, 0.7], [0.75, 0.84], [0.84, 0.93]], shiftF: [0.7, 0.75], place: [0.48, 0.93], back: [0.93, 1],
};
export const SORT_ARM = { parts: [0.05, 0.85], ret: [0.85, 0.96] };
// 부품마다 구간 안에서 집는 순간 · 놓는 순간 (구간 비율)
export const SORT_GRAB = { ammr: 0.42, arm: 0.36 }, SORT_DROP = { ammr: 0.86, arm: 0.8 };
const partWins = (ammr) => (ammr ? SORT_AMMR.parts : [0, 1, 2, 3].map((k) => { const [a, b] = SORT_ARM.parts, w = (b - a) / 4; return [a + w * k, a + w * (k + 1)]; }));
const countAt = (ammr, p, at) => partWins(ammr).filter(([a, b]) => p >= a + (b - a) * at).length;
// 지금까지 키트 포켓에 넣은 부품 수 · 트레이에서 집어 간 부품 수
export const sortPlaced = (ammr, p) => countAt(ammr, p, SORT_DROP[ammr ? 'ammr' : 'arm']);
export const sortGrabbed = (ammr, p) => countAt(ammr, p, SORT_GRAB[ammr ? 'ammr' : 'arm']);
export const sortPartWin = (ammr, k) => partWins(ammr)[k];
// AMMR이 맨 앞 트레이를 집어 드는 순간 · 협동로봇이 빈 트레이를 슈트에 놓는 순간
export const SORT_TAKE = { ammr: SORT_AMMR.pick[0] + (SORT_AMMR.pick[1] - SORT_AMMR.pick[0]) * 0.45, arm: SORT_ARM.ret[0] + (SORT_ARM.ret[1] - SORT_ARM.ret[0]) * 0.8 };

export class SpsMonitor {
  constructor(sim) {
    this.sim = sim; this.rnd = mulberry(20261025); this.acc = 0; this.seq = 0;
    this.latest = {}; this.levels = {}; this.hist = []; this.records = []; this.events = [];
    this.side = Object.fromEntries(Object.keys(SPS_KITS).map((p) => [p, { queue: [], prog: 0, kit: null, phase: 'idle', stock: SPS_RACKS[p].map(() => SPS_SPEC.rackCap), reqd: [false, false, false], restockAt: [], built: 0 }]));
    this.line = Object.fromEntries(Object.keys(SPS_LINE).map((id) => [id, { bins: [SPS_SPEC.binCap, SPS_SPEC.binCap], card: null, stockouts: 0, refills: 0 }]));
    this.stats = { kits: 0, loaded: 0, errors: 0, caught: 0, missed: 0, repick: 0, graspRetry: 0, lots: 0, traceGap: 0, rescans: 0, fod: 0, waits: 0, waitS: 0, replenish: 0, stockouts: 0, kanban: 0, lineStockouts: 0, throttled: 0 };
    sim.sps = this;
  }
  get mode() { return this.sim.mode?.key ?? 'smart'; }
  get on() { return !!this.sim.zone; }
  get ai() { return this.mode === 'dark'; }
  g() { const u = 1 - this.rnd(), v = this.rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  st(id) { return this.sim.processing?.find((s) => s.id === id) ?? null; }

  // 한 대분 키트 만들기 (변형 · 로트 · 오류) — 담기가 끝나는 순간 정한다
  makeKit(p) {
    const S = SPS_SPEC, m = this.mode, ai = m === 'dark', n = this.side[p].built;
    const variant = p === 'doortrim' ? `${n % 2 ? 'RH' : 'LH'} · ${COLORS[Math.floor(n / 2) % COLORS.length]}` : `감속비 ${RATIOS[Math.floor(n / 3) % RATIOS.length]}`;
    const lots = p === 'eaxle' ? { bearing: `B2610-${String(Math.floor(n / 60) + 1).padStart(2, '0')}`, seal: `S2610-${String(Math.floor(n / 80) + 1).padStart(2, '0')}` } : null;
    const parts = SPS_KITS[p].map(([name, mesh, rack, g, vary, lot]) => ({ name, mesh, rack, g, vary, lot: !!lot }));
    let err = this.rnd() < S.pickErr[m], caught = false, missed = false, repick = 0, retry = 0, gap = 0, rescan = 0, fod = false;
    if (err) {
      this.stats.errors++;
      const same = this.rnd() < S.sameWeight;
      caught = ai || (m === 'smart' ? !same : this.rnd() < 0.5);
      if (caught) { this.stats.caught++; this.stats.repick++; repick = 1; } else { this.stats.missed++; missed = true; }
    }
    if (ai) for (let k = 0; k < parts.length; k++) if (this.rnd() < S.graspFail) { retry++; this.stats.graspRetry++; }   // ② 집기 실패 → 그 자리에서 다시 집음
    if (lots) {
      this.stats.lots++;
      if (!ai && this.rnd() < S.scanFail[m]) { if (m === 'smart') { rescan = 1; this.stats.rescans++; } else { gap = 1; this.stats.traceGap++; } }
      if (!ai && this.rnd() < S.fod[m]) { fod = true; this.stats.fod++; this.event('fod', `e-axle 키트 이물 노출 — 작업자 개봉 중 포장 조각 (${m === 'smart' ? '검증대 영상에서 발견 · 다시 담음' : '육안으로 못 봄'})`); if (m === 'smart') { repick = 1; this.stats.repick++; } }
    }
    const w = parts.reduce((a, q) => a + q.g, 0);
    return {
      id: `SPS-${p === 'doortrim' ? 'DT' : 'EA'}-${String(n + 1).padStart(5, '0')}`, product: p, variant, lots, parts: parts.map((q) => q.name), meshes: parts.map((q) => q.mesh), weight: r2(w + this.g() * 4, 0),
      pick: ai ? { method: 'VLA 범용 파지 · 빈 피킹', conf: r2(0.95 + this.rnd() * 0.045, 3) } : m === 'smart' ? { method: '레일 협동로봇 · 표시등 피킹', conf: 1 } : { method: '작업자 키팅', conf: null },
      verify: ai ? { method: '영상 + 무게 AI', conf: r2(0.96 + this.rnd() * 0.035, 3) } : m === 'smart' ? { method: '무게', conf: null } : { method: '육안', conf: null },
      trace: lots ? (ai ? '집으면서 판독' : m === 'smart' ? (rescan ? '검증대 스캐너 · 다시 스캔' : '검증대 스캐너') : gap ? '수기 기록 누락' : '수기 기록') : null,
      err, caught, missed, repick, retry, rescan, gap, fod,
    };
  }
  // 키트 1개 담는 시간 (집기 실패 · 다시 스캔 · 다시 담기 포함)
  kitTime(k) { const S = SPS_SPEC; return S.kitT[this.mode] * (1 + 0.2 * (k?.retry ?? 0) + 0.6 * (k?.repick ?? 0)) + (k?.rescan ? S.rescan : 0); }
  // ⑥ 막힌 라인의 키트는 덜 담는다 (피지컬AI) — 그 제품 조립셀이 막혔거나 고장이면 버퍼 목표 1개
  target(p) {
    if (!this.ai) return SPS_SPEC.bufCap;
    const ids = p === 'doortrim' ? ['DT_ASSY', 'DT_FAST'] : ['EA_ASSY', 'EA_FAST'];
    return ids.some((id) => { const s = this.st(id); return s && (s.state === 'DOWN' || s.state === 'MAINT' || s.state === 'BLOCKED'); }) ? 1 : SPS_SPEC.bufCap;
  }
  stocked(p) { return this.side[p].stock.every((n, k) => n > 0 || !SPS_KITS[p].some((q) => q[2] === k)); }
  consume(p) {
    const S = SPS_SPEC, m = this.mode, sd = this.side[p];
    for (const k of new Set(SPS_KITS[p].map((q) => q[2]))) {
      sd.stock[k] = Math.max(0, sd.stock[k] - 1);
      if (!sd.reqd[k] && (m === 'traditional' ? sd.stock[k] === 0 : sd.stock[k] <= S.rackCap * S.reorder[m])) {
        sd.reqd[k] = true; sd.restockAt[k] = this.sim.time + S.lead[m]; this.stats.replenish++;
        this.event('replenish', `${p === 'doortrim' ? '도어트림' : 'e-axle'} 흐름 랙 ${k + 1} (${SPS_RACKS[p][k]}) 보충 요청 — 남은 ${sd.stock[k]}칸 · ${this.ai ? '랙 비전 계수 · 생산 순서 반영' : m === 'smart' ? '칸반 카드' : '빈 칸 확인'}`);
      }
    }
  }
  // 키팅 구역: 피킹 로봇이 버퍼가 찰 때까지 다음 키트를 담는다 (흐름 랙이 비면 보충까지 멈춤)
  build(dt) {
    for (const [p, sd] of Object.entries(this.side)) {
      sd.stock.forEach((n, k) => { if (sd.reqd[k] && this.sim.time >= (sd.restockAt[k] ?? Infinity)) { sd.stock[k] = SPS_SPEC.rackCap; sd.reqd[k] = false; this.event('restocked', `${p === 'doortrim' ? '도어트림' : 'e-axle'} 흐름 랙 ${k + 1} 보충 완료 (바깥 통로 쪽)`); } });
      const want = this.target(p);
      if (sd.queue.length >= want) {
        if (want < SPS_SPEC.bufCap && !sd.thr) { this.stats.throttled++; this.event('throttle', `${p === 'doortrim' ? '도어트림' : 'e-axle'} 라인 막힘 예측 — 키트 버퍼 1개로 줄여 담음`); }
        sd.thr = want < SPS_SPEC.bufCap; sd.phase = 'full'; continue;
      }
      sd.thr = false;
      if (!sd.kit) {
        if (!this.stocked(p)) { if (sd.phase !== 'stockout') { this.stats.stockouts++; this.event('stockout', `${p === 'doortrim' ? '도어트림' : 'e-axle'} 흐름 랙 결품 — 키팅 멈춤 · 보충 대기`); } sd.phase = 'stockout'; continue; }
        sd.kit = this.makeKit(p); sd.kitT = this.kitTime(sd.kit); sd.prog = 0;
      }
      sd.prog += dt / sd.kitT; sd.phase = sd.prog < SPS_T.pick ? 'pick' : 'verify';
      if (sd.prog >= 1) this.finish(p);
    }
  }
  finish(p) {
    const sd = this.side[p];
    this.consume(p); sd.queue.push(sd.kit); sd.built++; this.stats.kits++;
    sd.kit = null; sd.prog = 0; sd.phase = sd.queue.length >= SPS_SPEC.bufCap ? 'full' : 'pick';
  }

  // 셀 시작(sim.js): 반환 = 셀이 더 기다리는 시간(초)
  //  · 부품분류셀: 서열 버퍼에서 이 제품 키트를 꺼냄 — 버퍼가 비었으면 담는 중인 키트가 끝날 때까지 (결품이면 보충까지)
  //  · 조립셀: 검증을 빠져나간 키트 오류 → 키팅 구역에서 맞는 부품을 가져옴 · 공용 부품 상자 결품
  //  · 체결셀: 공용 부품 상자 결품
  plan(st, item) {
    if (!this.on || !item?.product) return 0;
    let extra = 0;
    if (st.id === SPS_CELL) {
      const sd = this.side[item.product]; if (!sd) return 0;
      if (!sd.queue.length) {   // 버퍼가 빔 → 담는 중인 키트가 끝날 때까지 (흐름 랙 결품이면 보충이 먼저)
        let restock = 0;
        if (!sd.kit && !this.stocked(item.product)) {
          restock = Math.max(0, ...sd.restockAt.map((t, k) => (sd.reqd[k] && sd.stock[k] === 0 ? t - this.sim.time : 0)));
          sd.stock = sd.stock.map((n, k) => (n === 0 ? SPS_SPEC.rackCap : n)); sd.reqd = sd.reqd.map((q, k) => q && sd.stock[k] !== SPS_SPEC.rackCap);
        }
        if (!sd.kit) { sd.kit = this.makeKit(item.product); sd.kitT = this.kitTime(sd.kit); sd.prog = 0; }
        extra = Math.min(90, restock + (1 - sd.prog) * sd.kitT);
        this.finish(item.product);
        this.stats.waits++; this.stats.waitS += extra;
      }
      item.kit = sd.queue.shift(); item.kitLoaded = false; item.kitTaken = [];
      return extra;
    }
    if ((st.id === 'DT_ASSY' || st.id === 'EA_ASSY') && item.kit?.missed && !item.kit.found) {
      item.kit.found = st.id; extra += SPS_SPEC.missDelay;
      this.sim.log?.('warn', `키트 오류 — ${item.kit.id}`, { obs: `${item.kit.verify.method} 검증을 통과한 키트에 ${item.kit.err ? '다른 사양 부품' : '누락'} (${st.name}에서 발견)`, dec: `${SPS_SPEC.missDelay}초 — 키팅 구역에서 맞는 부품을 가져옴`, act: '키트 검증 기준 점검' });
      this.event('miss', `${item.kit.id} 키트 오류 — ${st.name}에서 발견 · +${SPS_SPEC.missDelay}초`);
    }
    const L = this.line[st.id];
    if (L && this.mode !== 'dark') {   // 피지컬AI는 셀 부품 선반(sim.js st.parts)과 물류 휴머노이드 보충을 그대로 쓴다
      if (L.bins[0] <= 0 && L.bins[1] <= 0) {
        extra += SPS_SPEC.rush; L.stockouts++; this.stats.lineStockouts++;
        L.bins = [SPS_SPEC.binCap, SPS_SPEC.binCap]; L.card = null; L.refills++;
        this.event('line-stockout', `${st.name} 공용 부품(${SPS_LINE[st.id]}) 두 상자 모두 빔 — 급히 가져옴 +${SPS_SPEC.rush}초`);
      }
    }
    return extra;
  }
  // 셀 작업 완료(sim.js completeCycle)
  done(st, item) {
    if (!this.on || !item?.product) return null;
    if (st.id === SPS_CELL && item.kit) {
      const k = item.kit; item.kitLoaded = true; this.stats.loaded++;
      const rec = { id: k.id, t: r2(this.sim.time, 1), asset: SPS_SPEC.asset, part: item.wip ?? item.id, product: item.product, variant: k.variant, parts: k.parts.length, weight_g: k.weight,
        pick: k.pick.method, verify: k.verify.method, lots: k.lots ? `${k.lots.bearing} · ${k.lots.seal}` : null, trace: k.trace, result: k.missed ? '검증 통과 오류 (조립셀에서 발견)' : k.caught ? '검증에서 잡아 다시 담음' : k.fod ? '이물 노출' : 'OK', repick: k.repick, retry: k.retry };
      this.records.unshift(rec); if (this.records.length > 60) this.records.pop();
      (item.qx ??= {}).sps = { err: k.err ? 1 : 0, missed: k.missed ? 1 : 0, gap: k.gap ? 1 : 0 };
      if (k.lots && !k.gap) item.lots = { ...k.lots };   // 제품 계보: 베어링·오일씰 로트
      this.emit({ topic: `${SPS_TOPIC}/part`, kind: 'record', ...rec });
      return rec;
    }
    if ((st.id === 'DT_ASSY' || st.id === 'EA_ASSY') && item.kit) item.kitUsed = true;
    const L = this.line[st.id];
    if (L && this.mode !== 'dark') {
      const i = L.bins[0] > 0 ? 0 : 1;
      L.bins[i] = Math.max(0, L.bins[i] - 1);
      if (i === 0 && L.bins[0] === 0) { L.bins = [L.bins[1], 0]; this.kanban(st, L); }   // 앞 상자가 비면 뒤 상자를 앞으로 · 빈 상자의 칸반 카드
    }
    return null;
  }
  // 투빈 칸반: 빈 상자 카드 → 자동화는 다음 순회(밀크런) 때 · 레거시는 작업자가 빈 상자를 볼 때
  kanban(st, L) {
    const S = SPS_SPEC, now = this.sim.time;
    const at = this.mode === 'smart' ? Math.ceil((now + 1) / S.milkRun) * S.milkRun : now + S.legacyNotice[0] + this.rnd() * (S.legacyNotice[1] - S.legacyNotice[0]);
    L.card = { t: now, at }; this.stats.kanban++;
    this.event('kanban', `${st.name} 공용 부품(${SPS_LINE[st.id]}) 칸반 — ${this.mode === 'smart' ? `밀크런 ${Math.round((at - now) / 60)}분 뒤` : '작업자가 빈 상자를 볼 때'}`);
  }
  refillLine() {
    for (const [id, L] of Object.entries(this.line)) if (L.card && this.sim.time >= L.card.at) { L.bins[1] = SPS_SPEC.binCap; L.card = null; L.refills++; this.event('line-refill', `${this.st(id)?.name ?? id} 공용 부품 상자 채움`); }
  }
  // 라인사이드 재고 (%) — 피지컬AI는 셀 선반 재고(sim.js st.parts)
  lineLevel(id) {
    if (this.mode === 'dark') { const s = this.st(id), cap = this.sim.mode.partsCap || 40; return s?.parts != null ? (s.parts / cap) * 100 : 100; }
    const L = this.line[id]; return ((L.bins[0] + L.bins[1]) / (2 * SPS_SPEC.binCap)) * 100;
  }
  event(kind, text) {
    const ev = { t: r2(this.sim.time, 1), kind, text };
    this.events.unshift(ev); if (this.events.length > 30) this.events.pop();
    if (this.on) this.emit({ topic: `${SPS_TOPIC}/event`, kind: 'event', asset: SPS_SPEC.asset, ...ev });
  }
  measure() {
    const n = (s) => s * this.g(), m = this.mode;
    const vk = Object.values(this.side).find((sd) => sd.kit && sd.prog >= SPS_T.pick)?.kit;
    const allStock = Object.values(this.side).flatMap((sd) => sd.stock);
    const v = {
      weight: vk ? vk.weight + n(2) : 0, vision: vk?.verify.conf ? vk.verify.conf * 100 : 100,
      bufDT: this.side.doortrim.queue.length, bufEA: this.side.eaxle.queue.length,
      stock: (Math.min(...allStock) / SPS_SPEC.rackCap) * 100,
      particle: (m === 'dark' ? 1200 : m === 'smart' ? 3500 : 7000) * (1 + n(0.12)) + (this.side.eaxle.kit && m !== 'dark' ? 600 : 0),
      line: Math.min(...Object.keys(SPS_LINE).map((id) => this.lineLevel(id))),
      grasp: this.ai ? 98.6 + n(0.3) : m === 'smart' ? 99.2 + n(0.2) : 100,
    };
    for (const key of Object.keys(v)) v[key] = r2(Math.max(0, Math.min(key === 'weight' || key === 'particle' ? 1e7 : 100, v[key])), key === 'bufDT' || key === 'bufEA' ? 0 : 1);
    return v;
  }
  level(s, x) {
    if (x == null) return 'ok';
    const hit = (b) => b && ((b.hi != null && x >= b.hi) || (b.lo != null && x <= b.lo));
    return hit(s.alarm) ? 'alarm' : hit(s.warn) ? 'warn' : 'ok';
  }
  tick(dt) {
    if (!this.on) return;
    this.build(dt);
    this.refillLine();
    this.acc += dt; if (this.acc < 1 - 1e-9) return; this.acc = 0;
    const v = this.measure();
    this.latest = { t: this.sim.time, dt: this.side.doortrim.phase, ea: this.side.eaxle.phase, ...v };
    this.levels = Object.fromEntries(SPS_SENSORS.map((s) => [s.key, this.level(s, v[s.key])]));
    if (this.mode === 'traditional') return;   // 레거시: 센서 없음 (화면에는 내부값)
    if ((this.hist.at(-1)?.t ?? -9) <= this.sim.time - 2) { this.hist.push(this.latest); if (this.hist.length > 900) this.hist.shift(); }
    if ((this.lastQ ?? -9) <= this.sim.time - 5) { this.lastQ = this.sim.time; this.emit({ topic: SPS_TOPIC, kind: 'sample', asset: SPS_SPEC.asset, t: r2(this.sim.time, 1), phase: `${this.side.doortrim.phase}/${this.side.eaxle.phase}`, v, levels: this.levels }); }
  }
  snapshot() {
    const side = Object.fromEntries(Object.entries(this.side).map(([p, sd]) => [p, {
      phase: sd.phase, prog: r2(sd.prog, 2), queue: sd.queue.map((k) => ({ id: k.id, variant: k.variant })), kit: sd.kit ? { id: sd.kit.id, variant: sd.kit.variant } : null,
      stock: sd.stock.map((n, k) => ({ rack: SPS_RACKS[p][k], n, pct: Math.round((n / SPS_SPEC.rackCap) * 100), req: sd.reqd[k] })),
    }]));
    const line = Object.fromEntries(Object.entries(this.line).map(([id, L]) => [id, { part: SPS_LINE[id], pct: Math.round(this.lineLevel(id)), bins: this.mode === 'dark' ? null : L.bins.slice(), card: !!L.card, stockouts: L.stockouts }]));
    return { spec: SPS_SPEC, sensors: this.latest, levels: this.levels, ai: this.ai, mode: this.mode, on: this.on, stats: { ...this.stats }, side, line, records: this.records.slice(0, 20), events: this.events.slice(0, 8) };
  }
  emit(item) { if (this.mode === 'traditional') return; const o = (this.outbox ??= []); o.push(item); if (o.length > 200) o.shift(); this.onItem?.(item); }
}
