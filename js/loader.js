// 자재 투입 로봇셀 (정밀조립 · 유연생산 · 적응가공 투입구 공통) — 갠트리 로더 대신 주행 레일(7축) 위 고가반 6축
//  자재는 원자재 하역 쪽(side: +1 남 · −1 북) 한 줄 · 그 앞 레일 · 반대쪽은 비우고 AMR이 셀 가운데(x 0)를 서 → 동으로 지난다
//  한 번 투입: 레일을 따라 다음 제품 자재 앞으로 → 집기 → (세워 둔 패널은 위로 뽑아) 손목을 돌려 수평으로 → AMR 위로 와서 대기 → AMR이 서면 지그에 수평으로 내려놓기
//   · panel(빗살 랙에 세워 둔 판재): 진공 그리퍼가 로봇 쪽 면을 흡착 (툴 수평) → 랙 위로 뽑아 → 툴을 아래로 돌려 판재를 눕힌다
//   · lying(팔레트에 누운 하우징·주물): 위에서 클램프·평행 그리퍼로 집어 수평 그대로
//  정밀조립은 제품마다 그리퍼가 달라(하우징 클램프 ↔ 패널 진공) 셀 끝 툴 거치대에서 자동 툴 체인저로 바꿔 끼운다
//  시간은 시뮬레이션 초(배속 반영) — 투입 주기와 따로 돌며, 자재를 미리 집어 AMR 위에서 기다린다 (내려놓기만 투입 순간에)
import * as THREE from 'three';

export const LOADER = { railZ: 1.45, railX: [-1.95, 3.25], carY: 0.62, readyUp: 0.4, standX: 3.6 };   // carY: 대차 위 로봇 받침 높이 — 넓은 도어(1.1m)를 AMR에 내려놓을 때 팔꿈치가 도어 가장자리 위로
// 보이는 메시만으로 잰 윗면 높이 (숨긴 부품 — e-axle 하우징의 속 부품·인버터 — 은 빼고)
export function visibleTop(o) {
  o.updateMatrixWorld(true); const b = new THREE.Box3();
  o.traverse((m) => { if (!m.isMesh) return; for (let p = m; p && p !== o.parent; p = p.parent) if (!p.visible) return; b.expandByObject(m, false); });
  return b.isEmpty() ? 0 : b.max.y;
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ease = (k) => { k = Math.min(1, Math.max(0, k)); return k * k * (3 - 2 * k); };

// g: 투입 스테이션 그룹(셀 로컬 · AMR 정차 = 원점) · K: factory.js KIT · o: { side, tools: [{ key, kind: 'vacuum'|'clamp'|'jaw' }] , changer }
export function buildLoader(g, K, o) {
  const { put, box, cyl, MAT, std } = K, s = o.side, zr = s * LOADER.railZ, [x0, x1] = o.railX ?? LOADER.railX, standX = o.standX ?? LOADER.standX;
  const auto = put(new THREE.Group(), 0, 0, 0, g); auto.name = 'LoaderCell';
  // 주행 레일: 바닥 베이스 · 레일 2줄 · 랙기어 · 양 끝 스토퍼
  put(box(x1 - x0 + 0.5, 0.18, 0.9, MAT.dark), (x0 + x1) / 2, 0.09, zr, auto);
  for (const dz of [-0.3, 0.3]) put(box(x1 - x0 + 0.4, 0.05, 0.08, MAT.steel), (x0 + x1) / 2, 0.205, zr + dz, auto);
  for (const x of [x0 - 0.2, x1 + 0.2]) put(box(0.12, 0.3, 0.9, MAT.yellow ?? MAT.accent), x, 0.15, zr, auto);
  const car = put(new THREE.Group(), 0, 0, zr, auto); car.name = 'LoaderCarriage';
  put(box(1.0, 0.1, 0.95, MAT.orange), 0, 0.27, 0, car); put(box(0.75, LOADER.carY - 0.32, 0.75, MAT.dark), 0, (LOADER.carY + 0.32) / 2, 0, car);   // 주행 대차 · 로봇 받침
  const toolMesh = (kind) => {
    const t = new THREE.Group(); t.name = `LoaderTool_${kind}`;
    put(box(0.16, 0.05, 0.16, MAT.steel), 0, 0.025, 0, t);   // 툴 체인저 판
    if (kind === 'vacuum') {   // 진공 그리퍼: 긴 프레임(판재 긴 쪽) 끝 흡착컵 6개
      put(box(0.9, 0.04, 0.05, MAT.steel), 0, 0.1, 0, t); put(box(0.05, 0.04, 0.4, MAT.steel), 0, 0.1, 0, t);
      for (const x of [-0.42, 0, 0.42]) for (const z of [-0.18, 0.18]) put(cyl(0.03, 0.04, 0.03, MAT.dark, 10), x, 0.135, z, t);
    } else {   // clamp(e-axle 하우징 V블록 클램프) · jaw(주물 평행 그리퍼): 몸체 + 손가락 2개
      put(box(0.3, 0.07, 0.12, MAT.dark), 0, 0.08, 0, t);
      for (const x of kind === 'clamp' ? [-0.17, 0.17] : [-0.12, 0.12]) put(box(0.04, 0.07, 0.1, MAT.steel), x, 0.145, 0, t);   // 손가락 끝이 TCP 바로 아래 — 길면 맨 아래 칸에서 트레이 바닥을 친다
    }
    return t;
  };
  const tools = {}; for (const T of o.tools) tools[T.key] = { kind: T.kind, mesh: toolMesh(T.kind) };
  let stand = null;
  if (o.changer) {   // 툴 거치대 (레일 동쪽 끝 바깥) — 쓰지 않는 그리퍼가 놓인다
    stand = put(new THREE.Group(), standX, 0, zr, auto); stand.name = 'ToolStand';
    put(box(0.12, 1.0, 0.12, MAT.dark), 0, 0.5, 0, stand); put(box(0.5, 0.05, 0.4, MAT.steel), 0, 1.02, 0, stand);
  }
  const L = { auto, car, K, railX: [x0, x1], standX, r: null, tools, stand, side: s, cur: o.tools[0].key, state: 'home', t: 0, plan: null, holding: null, held: {}, readyQ: null, homeQ: null, x: 0 };
  // 들고 있는 자재 (제품마다 · 손끝 TCP에 윗면이 오도록 뒤집어 단다 — buildSink 포장 상자와 같은 방식)
  L.setHeld = (key, mesh, top) => { L.held[key]?.removeFromParent(); if (key.startsWith('pad:')) top += PAD_UP; (L.heldTop ??= {})[key] = top; const r = L.r, sc = r.root.scale.x || 1, h = put(new THREE.Group(), 0, (r.arm.native ? top : -top) / sc, 0, r.tip); h.scale.setScalar(1 / sc); if (r.arm.native) h.rotation.x = Math.PI; h.add(mesh); h.visible = false; L.held[key] = h; };   // 고가반은 IRB 4600 모델을 키운 것 — 든 자재는 실물 크기로
  loaderRobot(L);
  return L;
}
// 로봇 (다시) 만들기 — Blender 실물 로봇 모델이 늦게 들어오면 그것으로 바꾼다 (셀 로봇 buildCrew와 같음) · 들고 있던 자재 표시는 호출 쪽이 다시 단다
const PAD_UP = 0.04;   // 클램프·평행 그리퍼 손가락이 TCP 아래로 나온 길이 — 분리판·빈 트레이는 손가락 끝을 판 윗면에 대고 든다
export function loaderRobot(L) {
  const { K, car } = L; if (L.r) L.r.root.removeFromParent();
  let r = K.heavyRobot(K.MAT.orange);
  if (!r.arm?.ik) { const a = K.makeArm(K.MAT.orange, 1.3); r = { root: a.root, tip: a.tip, arm: a, simple: 1.3 }; }   // 기본 도형 모드(Blender 실물 로봇 없음 — 웹 아티팩트 등): 간이 팔 · 해석적 역기구학 (툴은 늘 아래로)
  K.put(r.root, 0, LOADER.carY, 0, car); r.root.rotation.y = r.simple ? 0 : L.side > 0 ? Math.PI / 2 : -Math.PI / 2;   // 자재 쪽을 본다
  const fl = r.arm.flange ?? r.tip.parent;
  for (const n of ['CustomFinger1', 'CustomFinger-1', 'CustomGripper']) { const x = fl.getObjectByName(n); if (x) x.visible = false; }
  Object.assign(L, { r, held: {}, state: 'home', plan: null, holding: null, readyQ: null, homeQ: null, q: null, cur0: null, x: 0 });
  mountTool(L, L.cur);
  return r;
}
function mountTool(L, key) {
  const fl = L.r.arm.flange ?? L.r.tip.parent;
  for (const [k, T] of Object.entries(L.tools)) {
    if (k === key) { fl.add(T.mesh); T.mesh.position.set(0, 0, 0); T.mesh.rotation.set(0, 0, 0); }
    else if (L.stand) { L.stand.add(T.mesh); T.mesh.position.set(0, 1.05, 0); T.mesh.rotation.set(0, 0, 0); }
    else T.mesh.removeFromParent();
  }
  L.cur = key;
}

// 관절 자세 (셀 로컬 목표 · 대차 x 위치에서) — down: true(툴 아래) · V(방향)(목표 → 손목) · alignX: 플랜지 x축을 셀 x에 맞춤
function solve(L, cx, T, dir) {
  const { r, car } = L, P = car.parent; car.position.x = cx; car.updateWorldMatrix(true, true);
  const loc = r.root.worldToLocal(P.localToWorld(T.clone()));
  if (r.simple) return L.K.armIK(r.simple, loc.x, loc.y, loc.z);   // 간이 팔: 툴 아래로만
  let d = true; if (dir !== true) { const a = r.root.worldToLocal(P.localToWorld(T.clone())), b = r.root.worldToLocal(P.localToWorld(T.clone().add(dir))); const v = b.sub(a).normalize(); d = { x: v.x, y: v.y, z: v.z }; }
  const q = r.arm.ik(loc.x, loc.y, loc.z, d);
  return alignX(L, q, P);
}
// 위치 · 툴 방향 오차 (셀 로컬): 역기구학은 위치만 맞추고 손목이 덜 풀리면 툴 방향이 기운다 — 판재를 세워 든 채면 판이 기울어 랙·받침에 닿는다
function fitErr(L, cx, q, T, dir) {
  if (L.r.simple) return 0;
  const { r, car } = L, P = car.parent, A = r.arm, fl = A.flange ?? r.tip.parent; car.position.x = cx; A.pose(...q); car.updateWorldMatrix(true, true);
  const tip = P.worldToLocal(r.tip.getWorldPosition(V(0, 0, 0))), ax = V(0, 1, 0).transformDirection(fl.matrixWorld), o = P.localToWorld(V(0, 0, 0)), want = (dir === true ? V(0, -1, 0) : dir.clone().negate()).normalize();
  const wantW = P.localToWorld(want.clone()).sub(o).normalize();
  return tip.distanceTo(T) + (1 - ax.dot(wantW)) * 2;   // 1cm ≈ 0.6° 기울기
}
// 대차를 목표 x 둘레(0 · ±0.3 · ±0.6m)에 놓고 풀어 위치·방향 오차가 가장 작은 자세 — { cx, q }
function solveBest(L, x, T, dir) {
  let best = null;
  for (const dx of [0, 0.3, -0.3, 0.6, -0.6]) {
    const cx = Math.max(L.railX[0], Math.min(L.railX[1], x + dx)); if (best && best.cx === cx) continue;
    const q = solve(L, cx, T, dir), e = fitErr(L, cx, q, T, dir);
    if (!best || e < best.e) best = { cx, q, e };
    if (best.e < 0.01) break;
  }
  return best;
}
function alignX(L, q, P) { if (L.r.simple) return q;   // J6로 플랜지 x축(그리퍼 긴 쪽 · 들고 있는 자재 긴 쪽)을 셀 x축에 맞춘다 — 판재·하우징은 앞뒤 대칭이라 0° · 180° 중 가까운 쪽 · 돌리고 다시 재기를 되풀이
  const A = L.r.arm, fl = A.flange ?? L.r.tip.parent, out = q.slice(), wx = P.localToWorld(V(1, 0, 0)).sub(P.localToWorld(V(0, 0, 0))).normalize();
  const raw = () => {   // 툴 축을 기준으로 플랜지 x축에서 셀 x축까지의 각 (−π ~ π)
    A.pose(...out); fl.updateWorldMatrix(true, false);
    const ax = V(0, 1, 0).transformDirection(fl.matrixWorld), cur = V(1, 0, 0).transformDirection(fl.matrixWorld), w = wx.clone().addScaledVector(ax, -wx.dot(ax));
    if (w.lengthSq() < 1e-6) return null; w.normalize(); return Math.atan2(ax.dot(cur.clone().cross(w)), cur.dot(w));
  };
  const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
  let a = raw(); if (a == null) return out;
  const tgt = Math.abs(a) > Math.PI / 2 ? Math.sign(a) * Math.PI : 0;
  const q5 = out[5]; out[5] = q5 + 0.2; const a1 = raw(); out[5] = q5; const sg = Math.sign(wrap(a1 - a)) || 1;   // J6를 + 로 돌리면 각이 줄어드는지 느는지
  for (let i = 0; i < 6; i++) { const e = wrap(a - tgt); if (Math.abs(e) < 0.004) break; out[5] -= sg * e; a = raw(); }
  return out;
}

// 한 번 투입 계획 (키프레임 [시간, 대차 x, 관절]) — pick: { x, y(잡는 면 높이 · panel은 가운데), z, kind, rise(빗살·적층 위로 빼는 높이) } · placeY: AMR 지그 위 자재 윗면
function planFetch(L, key, pick, placeY) {
  const s = L.side, out = [], P = L.car.parent; let t = 0;
  const add = (dt, cx, q) => { t += dt; out.push([t, cx, q]); };
  // AMR 위 대기 높이: 지그 위 0.4m 또는 들고 있는 자재 아랫면이 1.65m(아래로 지나가는 AMR 위 대상물 — e-axle 윗면 약 1.5m — 보다 위) 중 높은 쪽
  L.readyY = Math.max(placeY + LOADER.readyUp, 1.65 + (L.heldTop?.[key] ?? 0.3));
  L.readyQ = solve(L, 0, V(0, L.readyY, 0), true);
  L.homeQ ??= solve(L, 0, V(0, 1.9, s * 0.4), true);
  const q0 = L.cur0 ?? L.homeQ; out.push([0, L.x, q0]);
  let swap = null;
  if (L.tools[key] && L.cur !== key && L.stand) {   // 툴 교체: 거치대 위로 → 내려 놓고 → 새 툴 물고 → 위로
    const ex = L.railX[1], above = solve(L, ex, V(L.standX, 1.6, s * LOADER.railZ), true), at = solve(L, ex, V(L.standX, 1.23, s * LOADER.railZ), true);
    add(2.4, ex, above); add(0.8, ex, at); swap = t; add(1.0, ex, at); add(0.8, ex, above);
  }
  const clampX = (x) => Math.max(L.railX[0], Math.min(L.railX[1], x));
  let padOn = null, padOff = null;
  if (pick.pad) {   // 층이 비면 그 층 분리판(e-axle GLT) · 빈 트레이(적응가공)를 먼저 옆 거치대·스택으로 옮긴다 — 툴 아래로, 판 가운데를 집어 수평 그대로
    const F = pick.pad.from.clone().add(V(0, PAD_UP, 0)), D = pick.pad.to.clone().add(V(0, PAD_UP, 0)), fx = clampX(F.x), dx = clampX(D.x);   // 손가락 끝이 판 윗면에 닿는 높이 (TCP를 판 윗면에 두면 손가락이 판 속으로 들어간다)
    const up = Math.max(0.75, F.y + 0.75 - D.y);   // 옆 용기 위로 넘어가는 높이
    add(2.0, fx, solve(L, fx, F.clone().add(V(0, 0.4, 0)), true)); add(0.8, fx, solve(L, fx, F, true)); padOn = t; add(0.4, fx, solve(L, fx, F, true));
    add(0.8, fx, solve(L, fx, F.clone().add(V(0, 0.75, 0)), true)); add(2.0, dx, solve(L, dx, D.clone().add(V(0, up, 0)), true)); add(0.8, dx, solve(L, dx, D, true)); padOff = t;
    add(0.5, dx, solve(L, dx, D.clone().add(V(0, 0.4, 0)), true));
  }
  const cx = clampX(pick.x), T = V(pick.x, pick.y, pick.z);
  let pre, grip, lift, back;
  let pcx = cx;
  if (pick.kind === 'panel') {   // 툴 수평 (로봇 쪽에서 판재 면으로) → 흡착 → 랙 위로 뽑음 → 통로 쪽으로 물러남 · 판이 기울지 않게 대차 자리를 골라 네 자세를 같은 자리에서
    const d = V(0, 0, -s);   // 목표 → 손목 (로봇 쪽)
    const gb = solveBest(L, cx, T, d); pcx = gb.cx; grip = gb.q;
    pre = solve(L, pcx, T.clone().add(V(0, 0, -s * 0.3)), d);
    // 뽑기(위로) · 물러나기(통로 쪽)는 짧은 직선 5토막 — 관절 보간 한 번이면 중간에 툴이 기울어 세운 판이 옆 칸·받침에 닿는다
    const seg = (A, B) => Array.from({ length: 5 }, (_, i) => solve(L, pcx, A.clone().lerp(B, (i + 1) / 5), d));
    const T1 = T.clone().add(V(0, pick.rise, 0)), T2 = T1.clone().add(V(0, 0, -s * 0.45));
    lift = seg(T, T1); back = seg(T1, T2);
  } else {
    pre = solve(L, cx, T.clone().add(V(0, 0.35, 0)), true); grip = solve(L, cx, T, true);
    lift = solve(L, cx, T.clone().add(V(0, pick.rise, 0)), true); back = lift;
  }
  // 랙 앞 경유점: 툴을 아래로 둔 채 랙 앞(레일 쪽 0.45m) 높이 1.75m 위로 와서 손목을 돌린다 — 곧장 관절 보간하면 툴이 랙 받침 높이까지 처진다
  //  경유점도 툴을 수평(판재 쪽)으로 — 손목은 AMR 위에서 높이 돌리고, 랙 앞에서는 곧게 내려가 다가간다 (랙 앞에서 손목을 돌리면 툴이 받침 높이까지 처진다)
  const dH = V(0, 0, -s), via = pick.kind === 'panel' ? solve(L, pcx, V(pick.x, Math.max(1.75, pick.y + 0.55), s * (LOADER.railZ + 0.45)), dH) : null;
  if (via) add(1.6, pcx, via);
  add(via ? 1.0 : 2.2, pcx, pre); add(0.8, pcx, grip); const gripT = t; add(0.6, pcx, grip);
  const list = (x) => (Array.isArray(x[0]) ? x : [x]);   // 직선 토막 목록 (판재) · 자세 하나 (누운 자재)
  for (const q of list(lift)) add(1.0 / list(lift).length, pcx, q); for (const q of list(back)) add(0.7 / list(back).length, pcx, q);
  if (via) add(1.0, pcx, solve(L, pcx, V(pick.x, Math.max(1.75, pick.y + pick.rise), s * (LOADER.railZ + 0.45)), dH));   // 들어 올린 채 랙 앞에서 물러남 — 손목은 AMR로 가며 돌려 눕힌다
  add(2.6, 0, L.readyQ);   // AMR 위 대기
  // 이어지는 자세끼리 J6(손목 마지막 축)가 반 바퀴 가까이 차이 나면 반 바퀴 돌린 같은 정렬로 — 판재·하우징은 앞뒤 대칭이라 자세마다 0° · 180°를 따로 고르면 그 사이에서 손목이 돌아 그리퍼가 세로로 선다
  for (let i = 1; i < out.length && !L.r.simple; i++) { const q = out[i][2] = out[i][2].slice(), p5 = out[i - 1][2][5]; while (q[5] - p5 > Math.PI / 2) q[5] -= Math.PI; while (q[5] - p5 < -Math.PI / 2) q[5] += Math.PI; }
  L.readyQ = out[out.length - 1][2];
  return { key, keys: out, swap, gripT, end: t, padKey: pick.pad?.key, padOn, padOff };
}
const at = (keys, t) => {
  let i = keys.findIndex((k) => k[0] >= t); if (i < 0) i = keys.length - 1; if (i === 0) return [keys[0][1], keys[0][2]];
  const [t0, x0, a] = keys[i - 1], [t1, x1, b] = keys[i], e = ease(t1 > t0 ? (t - t0) / (t1 - t0) : 1);
  return [x0 + (x1 - x0) * e, a.map((v, j) => v + (b[j] - v) * e)];
};

// 매 프레임: c = { next(다음 투입 제품 · 재고 없으면 null), pick(next), placeY, place(내려놓기 시작 — AMR이 서고 투입 차례), released(투입·적재가 실제로 일어남), dt(시뮬레이션 초), frozen, legacy }
//  반환: holding(들고 있는 제품 · 재고에서 빠진 것) — 투입 순간 손을 놓으면 null
export function stepLoader(L, c) {
  const A = L.r.arm;
  L.auto.visible = !c.legacy; if (c.legacy || c.frozen || !(A.ik || L.r.simple)) return L.holding;
  if (L.state === 'home') {
    L.homeQ ??= solve(L, 0, V(0, 1.9, L.side * 0.4), true);
    if (c.next) { const p = c.pick(c.next); if (p) { L.cur0 = L.q ?? L.homeQ; L.plan = planFetch(L, c.next, p, c.placeY(c.next)); L.state = 'fetch'; L.t = 0; } }
    else { L.q = L.q ? L.q.map((v, j) => v + (L.homeQ[j] - v) * 0.1) : L.homeQ.slice(); L.car.position.x = L.x; A.pose(...L.q); }
  }
  if (L.state === 'fetch') {
    const P = L.plan; L.t += c.dt;
    if (P.swap != null && L.t >= P.swap && L.cur !== P.key) mountTool(L, P.key);
    L.padHeld = P.padOn != null && L.t >= P.padOn && L.t < P.padOff ? P.padKey : null;   // 옮기는 중인 분리판·빈 트레이
    if (P.padOff != null && L.t >= P.padOff && !P.padDone) { P.padDone = true; L.padMoved = (L.padMoved ?? 0) + 1; }
    if (L.t >= P.gripT && !L.holding) L.holding = P.key;
    const [x, q] = at(P.keys, L.t); L.x = x; L.q = q;
    if (L.t >= P.end) { L.state = 'ready'; const pq = solve(L, 0, V(0, c.placeY(P.key), 0), true); while (!L.r.simple && pq[5] - L.readyQ[5] > Math.PI / 2) pq[5] -= Math.PI; while (!L.r.simple && pq[5] - L.readyQ[5] < -Math.PI / 2) pq[5] += Math.PI; L.placeQ = pq; L.car.position.x = L.x; }   // 내려놓기도 대기 자세와 같은 쪽 정렬
  }
  if (L.state === 'ready' && !L.placing && c.next && L.holding && L.holding !== c.next) {   // 투입 순서가 바뀜(혼류 비율 변경 등) — 든 자재를 용기에 되돌리고 다음 제품을 꺼낸다
    L.holding = null; L.state = 'home'; L.q = L.readyQ.slice();
  }
  if (L.state === 'ready') {
    // 내려놓기: AMR이 서고 투입 차례(c.place)가 오면 지그 위로 내려가(1초) 든 채 기다린다(L.atJig) → 투입·적재가 실제로 일어나는 순간(c.released) 손을 놓고 → 위로 물러나(0.8초) 다음 자재로
    //  손을 놓는 순간 대상물이 AMR에 나타나므로 사이에 사라지는 틈이 없다 (로봇이 먼저 놓고 떠나면 투입 전까지 비고, 다음 자재를 또 집어 왔다)
    if (!L.placing && c.place) { L.placing = true; L.pt = 0; L.rt = null; L.atJig = false; }
    if (L.placing) {
      if (L.rt == null) {
        L.pt = Math.min(1, L.pt + c.dt / 1.0); L.atJig = L.pt >= 1;
        L.q = L.readyQ.map((v, j) => v + (L.placeQ[j] - v) * ease(L.pt));
        if (L.atJig && c.released) { L.holding = null; L.rt = 0; }
      } else {
        L.rt += c.dt / 0.8; L.q = L.placeQ.map((v, j) => v + (L.readyQ[j] - v) * ease(L.rt));
        if (L.rt >= 1) { L.placing = false; L.atJig = false; L.state = 'home'; L.q = L.readyQ.slice(); }
      }
    } else L.q = L.readyQ.slice();
    L.x = 0;
  }
  L.car.position.x = L.x; A.pose(...L.q);
  for (const [k, h] of Object.entries(L.held)) h.visible = L.holding === k || (L.padHeld != null && k === L.padHeld);
  return L.holding;
}

// 용기 2자리 (쓰는 중 · 대기) — 제품마다 재고 n을 두 용기에 나눠 보인다 (용기당 C개)
//  n > C: 대기 용기는 꽉 참(C) · 쓰는 용기는 n − C │ n ≤ C: 쓰는 용기에 n · 다른 자리는 빈 용기(회수 대기)
//  쓰는 용기가 비는 순간(n이 C 아래로) 대기 용기가 쓰는 용기가 된다 — 자리마다 개수가 튀지 않는다 · 보충(n이 C 위로)되면 빈 자리에 꽉 찬 용기
export function containerSplit(st, n, C) {
  if (st.act == null) st.act = 0;
  if (st.n != null && st.n > C && n <= C) st.act = 1 - st.act;   // 대기 용기로 넘어감
  st.n = n;
  const c = [0, 0]; if (n > C) { c[1 - st.act] = C; c[st.act] = n - C; } else c[st.act] = n;
  return { act: st.act, c };
}
