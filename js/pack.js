// 정밀조립Zone 검사·포장셀 포장 (DOM 없음 — 시뮬레이션 · 3D · 시험이 같이 쓴다)
// 그 제품 쪽 로봇 1대가 한다 (도어트림 = 남쪽 +z · e-axle = 북쪽 −z — 다른 쪽 로봇은 대기):
//   접이식 상자(도어트림 트레이 박스 · e-axle 폴딩 크레이트)를 매거진에서 집어 셀 밖 포장대에 놓아 편다 → AMR 위 제품을 들어 상자에 넣는다
//   → 뚜껑을 덮는다 → 라벨 프린터에서 라벨을 집어 뚜껑에 붙인다 → 닫힌 상자를 AMR 지그에 다시 싣는다 (구분 적재장으로)
// 자동화 협동로봇은 한자리(x −0.25 · z ±1.55)에서 팔로만 — 매거진·포장대·뚜껑 선반·프린터·AMR이 모두 UR20 리치(1.75m) 안
// 피지컬AI AMMR은 바퀴로 포장대 앞(z ±1.95)·매거진(x −1.3)·뚜껑 랙(x +1.3)·AMR 앞(z ±0.88)을 오가며 두 손으로

// 상자 (가로 x · 높이 · 세로 z, m) — 제품이 들어가는 크기 · 접힌 두께 · 뚜껑 두께 · 구분 적재장 적재 칸 (factory.js buildSink)
export const PACK_BOX = {
  doortrim: { w: 0.86, h: 0.16, d: 0.86, fold: 0.05, lid: 0.03, name: '트레이 박스' },
  eaxle: { w: 1.12, h: 0.5, d: 0.62, fold: 0.08, lid: 0.05, name: '폴딩 크레이트' },
};
// 셀 로컬 배치 (z는 쪽 부호 × 값): 포장대는 셀 밖(셀 가장자리 2.3m 바로 바깥) — 매거진(접힌 상자)·뚜껑·라벨 프린터 자리는 로봇마다
//  · 자동화 협동로봇·레거시 작업자(arm): 한자리(x −0.25 · z ±1.55)에서 팔이 닿게 — 매거진은 포장대 서쪽 앞(z 2.55) · 뚜껑은 포장대 동쪽 끝 받침 · 프린터는 포장대 앞 가장자리
//    (뚜껑을 셀 안 모서리에 두면 매거진으로 가는 위팔이 뚜껑 받침을 지난다)
//  · 피지컬AI AMMR(ammr): 포장대 앞(z ±1.95)에서 옆걸음으로 — 매거진 x −1.3 · 뚜껑 랙 x +1.3 · 프린터 x 0.85
export const PACK_GEO = {
  table: { x: 0, z: 2.75, y: 0.78, w: 1.3, d: 0.9 },
  lay: {
    arm: { mag: { x: -1.25, z: 2.55 }, lid: { x: 1.15, z: 2.6, y: 0.78 }, printer: { x: 0.5, z: 2.15 } },
    ammr: { mag: { x: -1.3, z: 2.75 }, lid: { x: 1.3, z: 2.75, y: 0.78 }, printer: { x: 0.85, z: 2.4 } },
  },
  arm: { x: -0.25, z: 1.55 }, ammr: { out: 1.95, in: 0.9, near: 1.15 },
  light: { x: 2.0, z: -1.75 },   // 셀 경광등 (출구 쪽 — 서쪽 기본 자리는 매거진으로 가는 팔이 지난다)
};
// e-axle을 위에서 잡는 자리 (대상물 좌표): 감속기 하우징 윗면(x −0.27 · 0.49m) — 인버터(x 0.03~0.37 · 0.57m)를 피해
export const PACK_GRIP = { doortrim: { x: 0, y: 0.075, z: 0 }, eaxle: { x: -0.27, y: 0.49, z: 0.08 } };
// 진행률 구간 (셀 사이클 = line.js PACK_CYCLE)
export const PACK_ARM = { box: [0.04, 0.2], prod: [0.2, 0.46], lid: [0.46, 0.6], label: [0.6, 0.7], back: [0.7, 0.9], home: [0.9, 1] };
export const PACK_AMMR = {
  turnOut: [0.04, 0.09], driveOut: [0.09, 0.14], box: [0.14, 0.27], turnIn: [0.27, 0.31], driveIn: [0.31, 0.36], grab: [0.36, 0.44], backOff: [0.44, 0.48],
  turnOut2: [0.48, 0.52], drop: [0.52, 0.6], lid: [0.6, 0.71], label: [0.71, 0.77], pickBox: [0.77, 0.82], turnIn2: [0.82, 0.86], driveIn2: [0.86, 0.9], place: [0.9, 0.95], back: [0.95, 1],
};
const at = (w, f) => w[0] + (w[1] - w[0]) * f;
// 물건이 손에 잡히는 순간 · 놓이는 순간 (진행률)
export const PACK_EV = {
  arm: { boxGrab: at(PACK_ARM.box, 0.3), boxSet: at(PACK_ARM.box, 0.8), prodGrab: at(PACK_ARM.prod, 0.3), prodSet: at(PACK_ARM.prod, 0.82), lidGrab: at(PACK_ARM.lid, 0.3), lidSet: at(PACK_ARM.lid, 0.8),
    labGrab: at(PACK_ARM.label, 0.3), labSet: at(PACK_ARM.label, 0.8), packGrab: at(PACK_ARM.back, 0.3), packSet: at(PACK_ARM.back, 0.85) },
  ammr: { boxGrab: at(PACK_AMMR.box, 0.4), boxSet: at(PACK_AMMR.box, 0.92), prodGrab: at(PACK_AMMR.grab, 0.7), prodSet: at(PACK_AMMR.drop, 0.8), lidGrab: at(PACK_AMMR.lid, 0.4), lidSet: at(PACK_AMMR.lid, 0.9),
    labGrab: at(PACK_AMMR.label, 0.35), labSet: at(PACK_AMMR.label, 0.85), packGrab: at(PACK_AMMR.pickBox, 0.7), packSet: at(PACK_AMMR.place, 0.8) },
};
// 진행률 p에서 물건이 어디 있나 — 제품: 'amr' · 'hand' · 'box' · 'gone'(상자째 AMR로) / 상자: 'mag' · 'hand' · 'table' · 'hand2' · 'amr'
export function packState(ammr, p) {
  const E = PACK_EV[ammr ? 'ammr' : 'arm'];
  const prod = p < E.prodGrab ? 'amr' : p < E.prodSet ? 'hand' : p < E.packGrab ? 'box' : 'gone';
  const box = p < E.boxGrab ? 'mag' : p < E.boxSet ? 'hand' : p < E.packGrab ? 'table' : p < E.packSet ? 'hand2' : 'amr';
  const lid = p < E.lidGrab ? 'stack' : p < E.lidSet ? 'hand' : 'on';
  const label = p < E.labGrab ? 'printer' : p < E.labSet ? 'hand' : 'on';
  return { prod, box, lid, label, packed: p >= E.packSet };
}
