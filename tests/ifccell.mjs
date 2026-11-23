// 형상 간섭 검사기가 드러낸 셀 로봇 · 투입 로봇 · 든 물건 겹침 가운데 node에서 확인할 수 있는 원인 검증 (화면 형상 · 자세는 npm run check:interference)
//   ① 부품분류셀: 빈 트레이가 슈트 면 · 회수 레인 롤러 위로만 미끄러진다 · 슈트에 놓는 자리가 컨베이어 끝에 걸리지 않는다
//   ② 검사·포장셀: e-axle 크레이트 안에 제품이 들어간다 · 프린터가 뚜껑 받침으로 뻗는 팔 밑이 아니다 · 고가반 6축 J1 한계가 일하는 방향 밖
//   ③ 역기구학 시작 자세(seed): 같은 목표를 시작 자세에 따라 다른 팔꿈치 갈래로 풀고, 캐시가 섞이지 않는다 (투입 로봇 · 적재 로봇이 쓴다)
//   ④ 투입 로봇 이동 자세 높이. 실행: npm test
import * as THREE from 'three';
import { SPS_GEO, SPS_TRAY, spsChute, spsReturnPose } from '../js/sps.js';
import { PACK_BOX, PACK_GEO } from '../js/pack.js';
import { nativeChain } from '../js/payload-robots.js';
import { LOADER } from '../js/loader.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

console.log('== 부품분류셀: 빈 트레이 회수');
{ const G = SPS_GEO, C = spsChute(), h = SPS_TRAY.len / 2; let worst = 9, tiltMax = 0, jump = 0, prev = null;
  for (let e = 0; e <= 4.8; e += 0.01) { const q = spsReturnPose(e);
    for (const sg of [-1, -0.5, 0, 0.5, 1]) { const x = q.x + sg * h * Math.cos(q.tilt), y = q.y - sg * h * Math.sin(q.tilt), floor = x < C.kx ? Math.max(C.surf(x), G.ret.y + 0.03) : G.ret.y + 0.03; worst = Math.min(worst, y - floor); }   // 트레이 바닥 다섯 점 ↔ 슈트 판 윗면 · 레인 롤러 윗면(ret.y + 0.03)
    tiltMax = Math.max(tiltMax, q.tilt); if (prev) jump = Math.max(jump, Math.hypot(q.x - prev.x, q.y - prev.y)); prev = q; }
  check('빈 트레이 바닥이 슈트 판 · 회수 레인 롤러 아래로 내려가지 않는다 (수평인 채 내려오면 3~8cm 묻혔다)', worst >= -0.002, `최소 여유 ${(worst * 1000).toFixed(1)}mm`);
  check('슈트에서는 슈트 기울기로 눕고 레인에서는 수평 · 자리가 튀지 않는다', Math.abs(tiltMax - C.sl) < 1e-6 && spsReturnPose(1).tilt === 0 && jump < 0.03 && Math.abs(spsReturnPose(0).x - G.chute.x) < 1e-6, `기울기 ${(tiltMax * 57.3).toFixed(1)}° · 한 틱 최대 ${(jump * 100).toFixed(1)}cm`);
  check('슈트에 놓는 트레이 동쪽 끝이 컨베이어 서쪽 끝보다 2cm 이상 서쪽 (−0.62일 때는 1cm 걸렸다)', G.chute.x + h <= G.conv.x0 - 0.02 && G.chute.x - h >= G.chute.x0 + 0.03 + 0.025, `트레이 ${(G.chute.x - h).toFixed(2)} ~ ${(G.chute.x + h).toFixed(2)} · 컨베이어 ${G.conv.x0} · 슈트 기둥 ${(G.chute.x0 + 0.055).toFixed(3)}`); }

console.log('== 검사·포장셀: 크레이트 · 프린터 · 고가반 6축 방향');
{ const B = PACK_BOX.eaxle, G = PACK_GEO, L = G.lay.arm, T = G.table;
  check('e-axle 크레이트 안 치수가 제품(길이 1.10 · 받침 포함 높이 0.59m)보다 크다', B.w - 0.04 >= 1.10 && B.h >= 0.59 + 0.005 && B.d - 0.04 >= 0.5, `안 ${(B.w - 0.04).toFixed(2)} × ${B.h} × ${(B.d - 0.04).toFixed(2)}`);
  check('e-axle 뚜껑 받침(6cm 동쪽)과 포장대 위 크레이트가 겹치지 않는다 · 매거진 팔레트가 포장대 다리 · 게이트 기둥과 떨어져 있다', L.lid.x + 0.06 - (B.w + 0.01) / 2 >= T.x + B.w / 2 + 0.02 && L.mag.x + (B.w + 0.1) / 2 <= T.x - T.w / 2 + 0.005 && L.mag.x - (B.w + 0.1) / 2 >= -2.05 + 0.07 + 0.03,
    `뚜껑 서쪽 끝 ${(L.lid.x + 0.06 - (B.w + 0.01) / 2).toFixed(3)} ↔ 크레이트 ${(T.x + B.w / 2).toFixed(2)} · 매거진 ${(L.mag.x - (B.w + 0.1) / 2).toFixed(2)} ~ ${(L.mag.x + (B.w + 0.1) / 2).toFixed(2)}`);
  // 프린터 ↔ 로봇 받침에서 뚜껑 받침으로 뻗는 팔의 선 (수평 거리)
  const dist = (p, a, b) => { const ux = b.x - a.x, uz = b.z - a.z, k = Math.max(0, Math.min(1, ((p.x - a.x) * ux + (p.z - a.z) * uz) / (ux * ux + uz * uz))); return Math.hypot(p.x - a.x - ux * k, p.z - a.z - uz * k); };
  const dP = dist(L.printer, G.arm, L.lid), reach = Math.hypot(L.printer.x - G.arm.x, L.printer.z - G.arm.z);
  check('라벨 프린터가 로봇 → 뚜껑 받침 선에서 0.25m 넘게 비켜 있고 협동로봇 리치(1.75m) 안', dP >= 0.25 && reach <= 1.5, `선에서 ${dP.toFixed(2)}m · 로봇에서 ${reach.toFixed(2)}m`);
  // 고가반 6축(e-axle 쪽 z −): 일하는 방향(AMR · 매거진 · 포장대 · 뚜껑 · 프린터)의 J1 = 방향각 − 받침 방향 — 한계(±180°)에서 0.4rad 넘게 떨어져 있고, 한계 방향은 AMR과 매거진 사이(서쪽 게이트 쪽)
  const base = { x: G.arm.x, z: -G.arm.z }, head = (x, z) => Math.atan2(x - base.x, z - base.z), wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const H = { AMR: head(0, 0), 매거진: head(L.mag.x, -L.mag.z), 포장대: head(T.x, -T.z), 제품놓기: head(T.x - 0.27, -T.z - 0.08), 뚜껑: head(L.lid.x + 0.06, -L.lid.z), 프린터: head(L.printer.x, -L.printer.z) };
  const J = Object.fromEntries(Object.entries(H).map(([k, a]) => [k, wrap(a - G.heavyYaw)])), mx = Math.max(...Object.values(J).map(Math.abs)), seam = wrap(G.heavyYaw + Math.PI);
  check('고가반 6축 J1이 모든 작업 방향에서 한계(±180°)와 0.4rad 넘게 떨어져 있다 (받침 방향 0이면 포장대가 한계 위)', mx <= Math.PI - 0.4, Object.entries(J).map(([k, v]) => `${k} ${(v * 57.3).toFixed(0)}°`).join(' · '));
  check('J1 한계 방향이 AMR과 매거진 사이 빈 쪽 — 매거진 → 포장대 → AMR 이동이 한계를 넘지 않는다', seam < H.AMR - 0.4 && seam > H.매거진 + 0.4 && J.매거진 > J.포장대 && J.포장대 > J.뚜껑 - 1e-9 && J.뚜껑 > J.AMR, `한계 방향 ${(seam * 57.3).toFixed(0)}° (AMR 0° · 매거진 ${(H.매거진 * 57.3).toFixed(0)}°)`); }

console.log('== 역기구학 시작 자세 (seed)');
{ // 6축 사슬(선회 · 어깨 · 팔꿈치 · 손목 3축): 위팔 1.0 · 아래팔 1.0 · 손목 ~ 손끝 0.3
  const root = new THREE.Group(), mk = (name, parent, x, y, z, axis, lo, hi) => { const g = new THREE.Group(); g.name = name; g.position.set(x, y, z); g.userData = { axis, lower: lo, upper: hi }; parent.add(g); return g; };
  const j1 = mk('J1', root, 0, 0, 0, [0, 1, 0], -3.14, 3.14), j2 = mk('J2', j1, 0, 0.5, 0, [0, 0, 1], -2.5, 2.5), j3 = mk('J3', j2, 0, 1.0, 0, [0, 0, 1], -2.8, 2.8);
  const j4 = mk('J4', j3, 0.8, 0, 0, [1, 0, 0], -6, 6), j5 = mk('J5', j4, 0.2, 0, 0, [0, 0, 1], -2.2, 2.2), j6 = mk('J6', j5, 0.1, 0, 0, [1, 0, 0], -6, 6), tip = new THREE.Group(); tip.position.set(0.2, 0, 0); j6.add(tip);
  const A = nativeChain(root, ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'], tip), T = [1.2, 0.9, 0];
  const err = (q) => { A.pose(...q); root.updateWorldMatrix(true, true); return tip.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...T)); };
  const q0 = A.ik(...T), up = A.ik(...T, false, [0, 0.2, -1.2, 0, 0, 0]), dn = A.ik(...T, false, [0, -1.9, 1.6, 0, 0, 0]), q1 = A.ik(...T);
  check('시작 자세에 따라 같은 목표를 다른 갈래(손목이 반대로 꺾인 자세)로 풀고 둘 다 목표에 닿는다', err(up) < 0.02 && err(dn) < 0.02 && up[4] > 0.3 && dn[4] < -0.3, `오차 ${err(up).toFixed(3)} · ${err(dn).toFixed(3)}m · 손목(J5) ${up[4].toFixed(2)} / ${dn[4].toFixed(2)}rad`);
  check('시작 자세를 준 풀이가 기본 풀이의 캐시를 덮지 않는다', q0.every((v, i) => v === q1[i]) && err(q0) < 0.02, `기본 풀이 오차 ${err(q0).toFixed(3)}m`); }

console.log('== 투입 로봇 이동 자세');
{ const eaTop = 0.15 + 2 * 0.68 + 0.57, heldH = 0.57, dtPost = 0.75 + 0.12 + 1.0 + 0.025;   // GLT 맨 위 층 하우징 윗면 · 든 하우징 높이 · 도어트림 용기 위 가로대 (js/factory.js SRC_GEO)
  check('이동 자세(손끝 높이)에서 든 하우징 아랫면이 GLT 맨 위 층 하우징 · 도어트림 용기 가로대보다 높다', LOADER.tuckY - heldH >= eaTop + 0.03 && LOADER.tuckY - heldH >= dtPost + 0.03 && LOADER.tuckR <= 0.9, `든 하우징 아랫면 ${(LOADER.tuckY - heldH).toFixed(2)}m ↔ 하우징 ${eaTop.toFixed(2)}m · 가로대 ${dtPost.toFixed(3)}m`); }

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
