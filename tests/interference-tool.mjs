// 형상 간섭 검사기(tools/check-interference.cjs의 핵심부 tools/interference-core.cjs) 자체 검증 — 검수보고서 V01~V04 최소 재현
//   V01 옮긴 설비를 행렬 갱신 없이도 검출 · V02 고정 팔끼리 · 팔 ↔ 펜스 · 드론 · 갠트리 헤드 · 로봇 ↔ 제품 · V03 지게차 19cm 상자 · 포크 ↔ 팔레트만 허용 · 판 제품 · V04 기록 시각 = sim.time
// 같은 시나리오를 화면의 three.js로도 돌린다: npm run check:interference -- --selftest. 실행: npm test
import { createRequire } from 'node:module';
import * as THREE from 'three';
const require = createRequire(import.meta.url);
const C = require('../tools/interference-core.cjs'), S = require('../tools/interference-selftest.cjs');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 형상 간섭 검사기 자체 검증 (V01~V04)');
for (const r of S.run(THREE, C)) check(r.name, r.ok, r.info);
// 계산 단위: 방향 상자 깊이 · 삼각형 교차
{ const P = (bb, m) => C.obbSet({}, bb, m), I = new THREE.Matrix4(), unit = [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5];
  const a = P(unit, I.elements), b = P(unit, new THREE.Matrix4().makeTranslation(0.9, 0, 0).elements), c = P(unit, new THREE.Matrix4().makeTranslation(1.2, 0, 0).elements);
  check('방향 상자: 0.9m 떨어진 단위 상자 = 깊이 0.1m, 1.2m = 0', Math.abs(C.obbDepth(a, b) - 0.1) < 1e-9 && C.obbDepth(a, c) === 0, `${C.obbDepth(a, b).toFixed(3)} · ${C.obbDepth(a, c)}`);
  // 45° 돌린 얇은 막대: 축 정렬 상자는 겹치지만 방향 상자는 떨어져 있다 (기울어진 링크의 빈 공간)
  const bar = P([-1, -0.05, -0.05, 1, 0.05, 0.05], new THREE.Matrix4().makeRotationZ(Math.PI / 4).elements), dot = P([-0.1, -0.1, -0.1, 0.1, 0.1, 0.1], new THREE.Matrix4().makeTranslation(0.5, -0.5, 0).elements);
  check('방향 상자: 기울어진 막대의 축 정렬 상자 빈 구석에 있는 상자 = 겹침 아님', C.aabbHit(bar.aabb, dot.aabb) && C.obbDepth(bar, dot) === 0);
  const t = (x) => [0, 0, 0, 1, 0, 0, 0, 1, 0].map((v, i) => (i % 3 === 2 ? v + x : v));
  check('삼각형: 엇갈려 꿰뚫는 두 삼각형 = 교차, 같은 평면에 포개진 것 · 떨어진 것 = 아님', C.triTri([0, 0, 0, 1, 0, 0, 0, 1, 0], 0, [0.2, 0.2, -0.5, 0.2, 0.2, 0.5, 0.9, 0.9, 0.5], 0) && !C.triTri(t(0), 0, t(0), 0) && !C.triTri(t(0), 0, t(0.3), 0)); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
