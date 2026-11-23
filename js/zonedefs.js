// Zone 정의 — jin-3d 전용 얇은 판: 정밀조립Zone 하나 (meta-factory의 4 Zone 모듈이 쓰는 이름만 단일 Zone 뜻으로 둔다)
// 좌표가 필요한 값은 micro의 실제 배치를 쓴다. 다른 Zone(유연생산 · 적응가공 · 정밀검사) 정의는 두지 않는다
export const ZONE_LABEL = { main: '정밀조립' };
export const EXTRA_ZONES = [];   // 확장 Zone 없음
export const zoneAt = () => 'main';     // 바닥 좌표 → Zone
export const areaZone = () => 'main';   // 구역 이름 → Zone
export const camArea = () => 'main';    // CCTV 담당 구역 → Zone
export const inInsp = () => false;      // 정밀검사Zone 없음
export const zoneDef = () => null;      // 확장 Zone 정의 없음
export const facOf = () => null;        // 확장 Zone 설비 없음
export const BUILDING = { x0: -51, x1: 38, z0: -20, z1: 20 };   // 건물 바닥 (생산동 + 왼쪽 물류 확장동 · 왼쪽 벽 x −51 · 뒷벽 z −20 · 앞쪽 열린 면 z 20 — js/sim.js BLDG와 같은 값)
