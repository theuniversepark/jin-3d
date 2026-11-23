// 형상 간섭 검사 핵심부 — 화면(Electron 페이지)과 node 테스트(tests/interference-tool.mjs)가 같은 코드를 쓴다 (three.js를 import하지 않고 객체 모양만 본다)
//   Scanner  장면을 훑어 부품(메시 · 인스턴스)마다 현재 월드 행렬의 방향 상자(OBB)를 만든다 — 훑기 전에 장면 전체 행렬을 갱신(V01)
//            움직인 적 있는 노드를 강체(body) 경계로 삼는다: 같은 강체 · 관절로 바로 이어진 강체(인접 링크)는 비교하지 않고, 그 밖의 움직이는 것은 모두 비교(V02)
//   pairRule 허용 접촉(포크 ↔ 팔레트 · 공구 ↔ 제품 · 자기 도크 · 바닥 주행면 …)만 이름 · 역할로 좁게 뺀다 (V03)
//   triHit   후보 쌍의 삼각형끼리 실제로 교차하는지 (바운딩 후보 → 삼각형 확정)
//   Tracker  겹침을 사건(시작 ~ 끝)으로 묶고 실제 시뮬레이션 시각 · 양쪽 부품 · 행렬 · 관절 자세를 남긴다 (V04)
//   Runner   0.1초 간격 사이를 화면 보간과 같게 나눠 한 표본에 3cm 넘게 움직이지 않게 본다
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.__ifcCore = factory(); })(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // ── 4×4 행렬 (three.js와 같은 열 우선 16칸)
  const mul = (a, b, o = new Float64Array(16)) => { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
  const inv = (m, o = new Float64Array(16)) => {
    const [a, b, c, d, e, f, g, h, i, j, k, l, mm, n, p, q] = m;
    const t0 = k * q - l * p, t1 = j * q - l * n, t2 = j * p - k * n, t3 = i * q - l * mm, t4 = i * p - k * mm, t5 = i * n - j * mm;
    const c0 = f * t0 - g * t1 + h * t2, c1 = -(e * t0 - g * t3 + h * t4), c2 = e * t1 - f * t3 + h * t5, c3 = -(e * t2 - f * t4 + g * t5);
    let det = a * c0 + b * c1 + c * c2 + d * c3; if (Math.abs(det) < 1e-30) det = 1e-30; const s = 1 / det;
    const u0 = g * q - h * p, u1 = f * q - h * n, u2 = f * p - g * n, u3 = e * q - h * mm, u4 = e * p - g * mm, u5 = e * n - f * mm;
    const v0 = g * l - h * k, v1 = f * l - h * j, v2 = f * k - g * j, v3 = e * l - h * i, v4 = e * k - g * i, v5 = e * j - f * i;
    o[0] = c0 * s; o[4] = c1 * s; o[8] = c2 * s; o[12] = c3 * s;
    o[1] = -(b * t0 - c * t1 + d * t2) * s; o[5] = (a * t0 - c * t3 + d * t4) * s; o[9] = -(a * t1 - b * t3 + d * t5) * s; o[13] = (a * t2 - b * t4 + c * t5) * s;
    o[2] = (b * u0 - c * u1 + d * u2) * s; o[6] = -(a * u0 - c * u3 + d * u4) * s; o[10] = (a * u1 - b * u3 + d * u5) * s; o[14] = -(a * u2 - b * u4 + c * u5) * s;
    o[3] = -(b * v0 - c * v1 + d * v2) * s; o[7] = (a * v0 - c * v3 + d * v4) * s; o[11] = -(a * v1 - b * v3 + d * v5) * s; o[15] = (a * v2 - b * v4 + c * v5) * s;
    return o; };
  const same16 = (a, b) => { for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false; return true; };

  // ── 방향 상자: 로컬 상자 8꼭짓점을 월드로 (기울어진 부품도 빈 공간 없이) + 변 방향 3개 · 축 정렬 상자
  // bb = [minx, miny, minz, maxx, maxy, maxz], m = 월드 행렬
  function obbSet(p, bb, m) {
    const P = p.P ?? (p.P = new Float64Array(24)), A = p.ax ?? (p.ax = new Float64Array(9)), B = p.aabb ?? (p.aabb = new Float64Array(6));
    B[0] = B[1] = B[2] = Infinity; B[3] = B[4] = B[5] = -Infinity;
    for (let i = 0; i < 8; i++) { const x = i & 1 ? bb[3] : bb[0], y = i & 2 ? bb[4] : bb[1], z = i & 4 ? bb[5] : bb[2];
      const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      P[i * 3] = X; P[i * 3 + 1] = Y; P[i * 3 + 2] = Z;
      if (X < B[0]) B[0] = X; if (Y < B[1]) B[1] = Y; if (Z < B[2]) B[2] = Z; if (X > B[3]) B[3] = X; if (Y > B[4]) B[4] = Y; if (Z > B[5]) B[5] = Z; }
    for (let k = 0; k < 3; k++) { const x = m[k * 4], y = m[k * 4 + 1], z = m[k * 4 + 2], L = Math.hypot(x, y, z) || 1; A[k * 3] = x / L; A[k * 3 + 1] = y / L; A[k * 3 + 2] = z / L; }
    return p; }
  const aabbHit = (a, b, e = 0) => a[0] <= b[3] + e && b[0] <= a[3] + e && a[1] <= b[4] + e && b[1] <= a[4] + e && a[2] <= b[5] + e && b[2] <= a[5] + e;
  // 방향 상자끼리 분리축 검사 (면 법선 6 + 변 외적 9) — 떨어져 있으면 0, 겹치면 가장 얕은 축의 겹침 깊이(m)
  function obbDepth(a, b) {
    let best = Infinity; const A = a.ax, B = b.ax, PA = a.P, PB = b.P;
    const axis = (x, y, z) => { const L = Math.hypot(x, y, z); if (L < 1e-9) return true; x /= L; y /= L; z /= L;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let i = 0; i < 24; i += 3) { const d = PA[i] * x + PA[i + 1] * y + PA[i + 2] * z; if (d < a0) a0 = d; if (d > a1) a1 = d; const e = PB[i] * x + PB[i + 1] * y + PB[i + 2] * z; if (e < b0) b0 = e; if (e > b1) b1 = e; }
      const o = Math.min(a1, b1) - Math.max(a0, b0); if (o <= 0) return false; if (o < best) best = o; return true; };
    // 면 법선 = 나머지 두 변의 외적 (비균등 배율로 변이 직교하지 않아도 맞다)
    for (const X of [A, B]) for (let k = 0; k < 3; k++) { const i = ((k + 1) % 3) * 3, j = ((k + 2) % 3) * 3; if (!axis(X[i + 1] * X[j + 2] - X[i + 2] * X[j + 1], X[i + 2] * X[j] - X[i] * X[j + 2], X[i] * X[j + 1] - X[i + 1] * X[j])) return 0; }
    for (let i = 0; i < 9; i += 3) for (let j = 0; j < 9; j += 3) if (!axis(A[i + 1] * B[j + 2] - A[i + 2] * B[j + 1], A[i + 2] * B[j] - A[i] * B[j + 2], A[i] * B[j + 1] - A[i + 1] * B[j])) return 0;
    return best === Infinity ? 0 : best; }

  // ── 물체인가 (V03): 물체가 아닌 표시만 뺀다 — 글자 · 선 · 점, 빛(가산 혼합), 감지 범위 · 표지(깊이를 쓰지 않는 반투명 기본 재질), 바닥에 그린 판
  //   유리 · 펜스 망 · 커튼 · 방수포처럼 반투명이어도 조명을 받는 재질은 물체다. 판(Plane · Circle · Ring)은 두께를 준 상자로 본다
  // d = { geomType, matType, transparent, depthWrite, additive, sprite, line, points, mark }
  function shapeKind(d) {
    if (d.sprite || d.line || d.points) return 'none';
    if (d.mark) return 'none';   // userData.ifc = 'mark' — 형상에 직접 표시한 「물체 아님」
    if (d.additive) return 'none';
    if (d.transparent && d.depthWrite === false && d.matType === 'MeshBasicMaterial') return 'none';
    return /Plane|Ring|Circle/.test(d.geomType ?? '') ? 'plate' : 'solid'; }
  const PLATE_T = 0.01;    // 판 두께 (제품 판 · 표지판)
  const FLOOR_MARK = 0.1;  // 이 높이 아래에 누운 판 = 바닥에 그린 표지 (차선 · 구역 색 · 글자)

  // ── 허용 접촉 (V03): 이름 · 역할로 좁게. a, b = { ent, grp, role, owner, station, ground, top, dyn } → 사유(문자열) 또는 ''
  //   grp: agv · forklift · amr · humanoid · human · maint · quad · drone · truck · arm · ammr · product · dock
  //   role: roller(주행 바퀴 · 가이드 롤러) · rail(그 레일) · reject(불량 배출 연출) · fork(포크 캐리지) · load(차량 적재물) · tool(공구 — 로봇 손목 플랜지 아래: 그리퍼 · 집은 부품) · part(재고 자재) · pallet · kit(키트 트레이) · seat(안착 지그 · 받침) · belt · tote · toolrest
  const GROUND = new Set(['agv', 'forklift', 'amr', 'humanoid', 'human', 'maint', 'quad', 'ammr']);   // ammr: 셀 안을 주행하는 이동 매니퓰레이터
  const RIDE_TOP = 0.1;   // 올라타 지나가는 바닥 판 높이 (AMR 셀 바닥 판 · 출하 도크 레벨러 8cm)
  const SEAT_MAX = 0.02;  // 얹힌 접촉으로 볼 깊이 — 이보다 깊이 묻히면 안착면이라도 간섭으로 센다
  function pairRule(a, b, d = 0) { return rule1(a, b, d) || rule1(b, a, d); }
  function rule1(a, b, d) {
    if (a.role === 'fork' && (b.role === 'pallet' || b.role === 'load')) return '포크 ↔ 팔레트·적재물';
    if (a.role === 'tool' && (b.grp === 'product' || b.role === 'kit' || b.role === 'part' || b.role === 'pallet' || b.role === 'load' || b.role === 'seat')) return '공구 ↔ 제품·부품 (집기·체결·이재)';
    if (a.role === 'tool' && b.role === 'toolrest') return '공구 ↔ 공구 거치대 (공구 교환)';
    if (b.grp === 'dock' && b.owner && b.owner === a.ent) return '자기 충전 도크·이착륙장 (도킹)';
    if (GROUND.has(a.grp) && a.role !== 'tool' && !b.dyn && b.top <= RIDE_TOP) return '바닥 주행면 (올라타 지나가는 판 10cm 이하)';
    if ((a.grp === 'product' || a.role === 'load' || a.role === 'kit') && (b.role === 'seat' || b.role === 'belt' || b.role === 'pallet') && d <= SEAT_MAX) return '제품 ↔ 안착면 (지그·벨트·팔레트에 얹힘 2cm 이하)';
    if (a.role === 'kit' && b.role === 'kit' && !!a.robot !== !!b.robot) return '키트 트레이 이재 (로봇 손 ↔ 컨베이어 — 같은 트레이를 넘겨받는 순간)';
    if (a.grp === 'product' && b.grp === 'product' && a.ent && a.ent === b.ent) return '같은 제품의 조립 부품끼리 (조립 진행에 따라 끼워지는 부품 — 조립 관계)';
    if (a.role === 'tote' && b.role === 'tote') return '창고 토트 이재 (스태커 크레인 ↔ 선반 칸·받침 — 같은 토트를 넘겨받는 순간)';
    if (a.role === 'roller' && b.role === 'rail' && d <= SEAT_MAX) return '구르는 장착부 ↔ 레일 (주행 바퀴·가이드 롤러가 레일에 물려 구름 2cm 이하)';   // 표시한 바퀴 ↔ 표시한 레일만 · 2cm 넘게 파고들면 간섭
    if (a.role === 'reject' && !b.dyn && !!a.station && a.station === b.station) return '불량 배출 연출 ↔ 그 셀 고정 설비 (배출 자리로 날아가는 0.9초 연출 — 시뮬레이션 대상물이 아님)';   // 다른 셀 · 건물 · 움직이는 것(로봇 · 이동체)과는 그대로 간섭
    if (a.role === 'handtool' && b.hand && a.ent && a.ent === b.ent) return '손에 든 도구 ↔ 그 손 (정비 도구를 쥔 손가락·엄지)';   // hand = 손 부품(손가락 · 엄지 · 손바닥) · 같은 이동체의 손만 — 다리 · 몸통 · 다른 이동체 · 설비와는 그대로 간섭
    return ''; }

  // ── 삼각형 (후보 쌍에만): 지오메트리마다 로컬 삼각형 상자를 한 번 만들어 두고, 겹치는 구역의 삼각형끼리만 교차 검사
  // geom = { pos: 위치 배열(xyz…), idx: 색인 배열|null, bb } → tri()가 n · tb(삼각형마다 로컬 상자 6칸)를 붙인다
  function triPrep(g) { if (g.tb) return g; const pos = g.pos, idx = g.idx, n = Math.floor((idx ? idx.length : pos.length / 3) / 3), tb = new Float32Array(n * 6);
    for (let t = 0; t < n; t++) { let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) { const v = (idx ? idx[t * 3 + k] : t * 3 + k) * 3, x = pos[v], y = pos[v + 1], z = pos[v + 2]; if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z; if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z; }
      tb[t * 6] = x0; tb[t * 6 + 1] = y0; tb[t * 6 + 2] = z0; tb[t * 6 + 3] = x1; tb[t * 6 + 4] = y1; tb[t * 6 + 5] = z1; }
    g.n = n; g.tb = tb; return g; }
  const boxOf = (bb, m) => { const o = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let i = 0; i < 8; i++) { const x = i & 1 ? bb[3] : bb[0], y = i & 2 ? bb[4] : bb[1], z = i & 4 ? bb[5] : bb[2];
    const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14]; if (X < o[0]) o[0] = X; if (Y < o[1]) o[1] = Y; if (Z < o[2]) o[2] = Z; if (X > o[3]) o[3] = X; if (Y > o[4]) o[4] = Y; if (Z > o[5]) o[5] = Z; } return o; };
  const boxAnd = (a, b, e) => [Math.max(a[0], b[0]) - e, Math.max(a[1], b[1]) - e, Math.max(a[2], b[2]) - e, Math.min(a[3], b[3]) + e, Math.min(a[4], b[4]) + e, Math.min(a[5], b[5]) + e];
  const trisIn = (g, r) => { const out = [], tb = g.tb; for (let t = 0, i = 0; t < g.n; t++, i += 6) if (tb[i] <= r[3] && tb[i + 3] >= r[0] && tb[i + 1] <= r[4] && tb[i + 4] >= r[1] && tb[i + 2] <= r[5] && tb[i + 5] >= r[2]) out.push(t); return out; };
  // 삼각형 ↔ 삼각형 교차 (Möller 1997 — 구간 겹침, 같은 평면이면 2D 검사). 꼭짓점은 [x,y,z] 9칸 배열의 오프셋
  function triTri(V, a, U, b) {
    const sub = (X, i, Y, j) => [X[i] - Y[j], X[i + 1] - Y[j + 1], X[i + 2] - Y[j + 2]], cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]], dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const N1 = cross(sub(V, a + 3, V, a), sub(V, a + 6, V, a)), d1 = -(N1[0] * V[a] + N1[1] * V[a + 1] + N1[2] * V[a + 2]);
    const s1 = Math.hypot(N1[0], N1[1], N1[2]); if (s1 < 1e-18) return false;
    const E = 1e-7 * s1; let du0 = N1[0] * U[b] + N1[1] * U[b + 1] + N1[2] * U[b + 2] + d1, du1 = N1[0] * U[b + 3] + N1[1] * U[b + 4] + N1[2] * U[b + 5] + d1, du2 = N1[0] * U[b + 6] + N1[1] * U[b + 7] + N1[2] * U[b + 8] + d1;
    if (Math.abs(du0) < E) du0 = 0; if (Math.abs(du1) < E) du1 = 0; if (Math.abs(du2) < E) du2 = 0;
    if (du0 * du1 > 0 && du0 * du2 > 0) return false;
    const N2 = cross(sub(U, b + 3, U, b), sub(U, b + 6, U, b)), d2 = -(N2[0] * U[b] + N2[1] * U[b + 1] + N2[2] * U[b + 2]);
    const s2 = Math.hypot(N2[0], N2[1], N2[2]); if (s2 < 1e-18) return false;
    const F = 1e-7 * s2; let dv0 = N2[0] * V[a] + N2[1] * V[a + 1] + N2[2] * V[a + 2] + d2, dv1 = N2[0] * V[a + 3] + N2[1] * V[a + 4] + N2[2] * V[a + 5] + d2, dv2 = N2[0] * V[a + 6] + N2[1] * V[a + 7] + N2[2] * V[a + 8] + d2;
    if (Math.abs(dv0) < F) dv0 = 0; if (Math.abs(dv1) < F) dv1 = 0; if (Math.abs(dv2) < F) dv2 = 0;
    if (dv0 * dv1 > 0 && dv0 * dv2 > 0) return false;
    const D = cross(N1, N2); let k = 0, mx = Math.abs(D[0]); if (Math.abs(D[1]) > mx) { mx = Math.abs(D[1]); k = 1; } if (Math.abs(D[2]) > mx) k = 2;
    if (dv0 === 0 && dv1 === 0 && dv2 === 0) return false;   // 같은 평면에 포개진 면(얹힌 면)은 관통이 아니다 — coplanar()는 판끼리 겹침을 따로 볼 때만
    const iv = (p0, p1, p2, e0, e1, e2) => {   // 삼각형이 두 평면의 교선을 지나는 구간
      const seg = (pa, pb, pc, ea, eb, ec) => [pa + (pb - pa) * ea / (ea - eb), pa + (pc - pa) * ea / (ea - ec)];
      if (e0 * e1 > 0) return seg(p2, p0, p1, e2, e0, e1); if (e0 * e2 > 0) return seg(p1, p0, p2, e1, e0, e2);
      if (e1 * e2 > 0 || e0 !== 0) return seg(p0, p1, p2, e0, e1, e2); if (e1 !== 0) return seg(p1, p0, p2, e1, e0, e2); if (e2 !== 0) return seg(p2, p0, p1, e2, e0, e1); return null; };
    const i1 = iv(V[a + k], V[a + 3 + k], V[a + 6 + k], dv0, dv1, dv2), i2 = iv(U[b + k], U[b + 3 + k], U[b + 6 + k], du0, du1, du2);
    if (!i1 || !i2) return false;
    const T = 1e-6 * (Math.abs(i1[0]) + Math.abs(i1[1]) + Math.abs(i2[0]) + Math.abs(i2[1]) + 1e-3);   // 점 · 변으로 맞닿기만 한 것은 뺀다
    return Math.max(i1[0], i1[1]) > Math.min(i2[0], i2[1]) + T && Math.max(i2[0], i2[1]) > Math.min(i1[0], i1[1]) + T; }
  function coplanar(N, V, a, U, b) {   // 같은 평면: 법선이 가장 큰 축을 버리고 2D로 — 변끼리 교차 또는 한쪽이 다른 쪽 안
    const A = [Math.abs(N[0]), Math.abs(N[1]), Math.abs(N[2])], k = A[0] >= A[1] && A[0] >= A[2] ? 0 : A[1] >= A[2] ? 1 : 2, i0 = (k + 1) % 3, i1 = (k + 2) % 3;
    const p = (X, o, j) => [X[o + j * 3 + i0], X[o + j * 3 + i1]], T1 = [0, 1, 2].map((j) => p(V, a, j)), T2 = [0, 1, 2].map((j) => p(U, b, j));
    const o = (p0, p1, p2) => (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    const segX = (p0, p1, q0, q1) => { const d1 = o(q0, q1, p0), d2 = o(q0, q1, p1), d3 = o(p0, p1, q0), d4 = o(p0, p1, q1); return d1 * d2 < 0 && d3 * d4 < 0; };
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (segX(T1[i], T1[(i + 1) % 3], T2[j], T2[(j + 1) % 3])) return true;
    const inT = (q, T) => { const s0 = o(T[0], T[1], q), s1 = o(T[1], T[2], q), s2 = o(T[2], T[0], q); return (s0 > 0 && s1 > 0 && s2 > 0) || (s0 < 0 && s1 < 0 && s2 < 0); };
    return inT(T1[0], T2) || inT(T2[0], T1); }
  // 점이 닫힌 형상 안인가 — 세 방향 반직선이 모두 홀수 번 지나야 안 (뚜껑 없는 상자 · 판은 안으로 보지 않게)
  function inside(g, p) { const pos = g.pos, idx = g.idx; const cnt = [0, 0, 0];
    for (let t = 0; t < g.n; t++) {
      const v = [0, 1, 2].map((k) => (idx ? idx[t * 3 + k] : t * 3 + k) * 3);
      for (let ax = 0; ax < 3; ax++) { const u = (ax + 1) % 3, w = (ax + 2) % 3;   // +ax 방향 반직선: 나머지 두 축으로 본 삼각형 안에 점이 있고 그 위에서 삼각형이 점보다 앞
        const x0 = pos[v[0] + u] - p[u], y0 = pos[v[0] + w] - p[w], x1 = pos[v[1] + u] - p[u], y1 = pos[v[1] + w] - p[w], x2 = pos[v[2] + u] - p[u], y2 = pos[v[2] + w] - p[w];
        const c0 = x0 * y1 - x1 * y0, c1 = x1 * y2 - x2 * y1, c2 = x2 * y0 - x0 * y2; if (!((c0 > 0 && c1 > 0 && c2 > 0) || (c0 < 0 && c1 < 0 && c2 < 0))) continue;
        const s = c0 + c1 + c2, h = (c1 * pos[v[0] + ax] + c2 * pos[v[1] + ax] + c0 * pos[v[2] + ax]) / s; if (h > p[ax]) cnt[ax]++; } }
    return cnt[0] % 2 === 1 && cnt[1] % 2 === 1 && cnt[2] % 2 === 1; }
  const WORK_MAX = 4e6;   // 삼각형 상자 비교 상한 — 넘으면 「미확정」으로 남긴다
  // 두 형상(지오메트리 + 월드 행렬)의 삼각형 교차 → { hit: true|false|null(미확정), pairs, at:[x,y,z](교차 삼각형 중심 평균 · 월드), na, nb, inside }
  function triHit(ga, ma, gb, mb, maxPairs = 48) {
    triPrep(ga); triPrep(gb);
    const rel = mul(inv(mb), ma), relI = inv(rel), e = 1e-4;   // B 로컬에서 본다
    const rB = boxAnd(boxOf(ga.bb, rel), gb.bb, e); if (rB[0] > rB[3] || rB[1] > rB[4] || rB[2] > rB[5]) return { hit: false, pairs: 0, na: 0, nb: 0 };
    const tB = trisIn(gb, rB), rA = boxAnd(boxOf(rB, relI), ga.bb, e), tA = trisIn(ga, rA), res = { hit: false, pairs: 0, na: tA.length, nb: tB.length };
    const vtx = (g, t, k, o, off, m) => { const v = (g.idx ? g.idx[t * 3 + k] : t * 3 + k) * 3, x = g.pos[v], y = g.pos[v + 1], z = g.pos[v + 2]; if (m) { o[off] = m[0] * x + m[4] * y + m[8] * z + m[12]; o[off + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; o[off + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]; } else { o[off] = x; o[off + 1] = y; o[off + 2] = z; } };
    if (tA.length && tB.length) {
      // A 삼각형을 B 로컬로 옮기고, 구역의 가장 긴 축으로 칸을 나눠 B 삼각형을 넣어 둔다
      const VA = new Float64Array(tA.length * 9), BA = new Float64Array(tA.length * 6);
      for (let i = 0; i < tA.length; i++) { for (let k = 0; k < 3; k++) vtx(ga, tA[i], k, VA, i * 9 + k * 3, rel);
        for (let c = 0; c < 3; c++) { BA[i * 6 + c] = Math.min(VA[i * 9 + c], VA[i * 9 + 3 + c], VA[i * 9 + 6 + c]); BA[i * 6 + 3 + c] = Math.max(VA[i * 9 + c], VA[i * 9 + 3 + c], VA[i * 9 + 6 + c]); } }
      let ax = 0; if (rB[4] - rB[1] > rB[3 + ax] - rB[ax]) ax = 1; if (rB[5] - rB[2] > rB[3 + ax] - rB[ax]) ax = 2;
      const K = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(tB.length)))), lo = rB[ax], w = (rB[3 + ax] - lo) / K || 1, bins = Array.from({ length: K }, () => []), bin = (x) => Math.max(0, Math.min(K - 1, Math.floor((x - lo) / w)));
      const tb = gb.tb; for (let j = 0; j < tB.length; j++) { const o = tB[j] * 6; for (let c = bin(tb[o + ax]), c1 = bin(tb[o + 3 + ax]); c <= c1; c++) bins[c].push(j); }
      const seen = new Int32Array(tB.length).fill(-1), VB = new Float64Array(9); let work = 0, sx = 0, sy = 0, sz = 0;
      outer: for (let i = 0; i < tA.length; i++) { const a = i * 6;
        for (let c = bin(BA[a + ax]), c1 = bin(BA[a + 3 + ax]); c <= c1; c++) for (const j of bins[c]) { if (seen[j] === i) continue; seen[j] = i; if (++work > WORK_MAX) { res.hit = res.pairs ? true : null; res.capped = true; break outer; }
          const o = tB[j] * 6; if (BA[a] > tb[o + 3] || BA[a + 3] < tb[o] || BA[a + 1] > tb[o + 4] || BA[a + 4] < tb[o + 1] || BA[a + 2] > tb[o + 5] || BA[a + 5] < tb[o + 2]) continue;
          for (let k = 0; k < 3; k++) vtx(gb, tB[j], k, VB, k * 3, null);
          if (!triTri(VA, i * 9, VB, 0)) continue;
          res.pairs++; sx += (VA[i * 9] + VA[i * 9 + 3] + VA[i * 9 + 6]) / 3; sy += (VA[i * 9 + 1] + VA[i * 9 + 4] + VA[i * 9 + 7]) / 3; sz += (VA[i * 9 + 2] + VA[i * 9 + 5] + VA[i * 9 + 8]) / 3;
          if (res.pairs >= maxPairs) { res.capped = true; break outer; } } }
      if (res.pairs) { res.hit = true; const x = sx / res.pairs, y = sy / res.pairs, z = sz / res.pairs; res.at = [mb[0] * x + mb[4] * y + mb[8] * z + mb[12], mb[1] * x + mb[5] * y + mb[9] * z + mb[13], mb[2] * x + mb[6] * y + mb[10] * z + mb[14]]; return res; }
      if (res.hit === null) return res;
    }
    // 겉면이 만나지 않아도 한쪽이 통째로 다른 쪽 안에 있을 수 있다 (내포) — 꼭짓점 하나가 상대 형상 안인지
    const p = [0, 0, 0];
    if (tA.length || tB.length) { if (tA.length) vtx(ga, tA[0], 0, p, 0, rel); if (tA.length && inside(gb, p)) { res.hit = true; res.inside = 'A⊂B'; res.at = [mb[0] * p[0] + mb[4] * p[1] + mb[8] * p[2] + mb[12], mb[1] * p[0] + mb[5] * p[1] + mb[9] * p[2] + mb[13], mb[2] * p[0] + mb[6] * p[1] + mb[10] * p[2] + mb[14]]; return res; }
      if (tB.length) vtx(gb, tB[0], 0, p, 0, relI); if (tB.length && inside(ga, p)) { res.hit = true; res.inside = 'B⊂A'; res.at = [ma[0] * p[0] + ma[4] * p[1] + ma[8] * p[2] + ma[12], ma[1] * p[0] + ma[5] * p[1] + ma[9] * p[2] + ma[13], ma[2] * p[0] + ma[6] * p[1] + ma[10] * p[2] + ma[14]]; return res; } }
    return res; }

  // ── 장면 훑기. opt = { minDepth, cell, classify(o) → {ent, grp, role, owner, station, robot, ground, label}, forceDyn: Set(늘 움직이는 것으로 볼 노드 — 이동체 · 로봇 · 대상물 뿌리) }
  class Scanner {
    constructor(opt = {}) { this.o = { cell: 1, ...opt }; this.rec = new WeakMap(); this.sample = 0; this.seq = 0; this.live = []; this.grid = new Map(); this.big = new Set(); this.force = opt.forceDyn ?? new Set(); this.q = 0; }
    // 장면 뿌리들을 훑어 부품 목록을 갱신한다. 반환: 이번 표본에 자세가 바뀐(또는 새로 나타난) 부품
    scan(roots) {
      this.sample++; const S = this.sample, tops = new Set();
      for (const r of roots) { let t = r; while (t.parent) t = t.parent; tops.add(t); }
      for (const t of tops) t.updateMatrixWorld(true);   // V01: 훑기 전에 장면 전체 행렬을 지금 자세로 — 직전에 옮긴 팔 · 헤드 · 문 · 상자가 오래된 matrixWorld로 남지 않게
      const live = [], changed = [];
      const walk = (o, body, upNew) => {
        if (!o.visible) return;
        let r = this.rec.get(o); const e = o.matrix.elements, isNew = !r || r.stamp !== S - 1;   // 새로 생겼거나 숨었다 다시 나타남
        if (!r) { r = { o, id: ++this.seq, m: Float64Array.from(e), moved: false, stamp: 0, pbody: null }; this.rec.set(o, r); }
        else if (!same16(r.m, e)) { r.m.set(e); r.moved = true; }
        if (!r.moved && (this.force.has(o) || isNew && !upNew && S > 1)) r.moved = true;   // 첫 표본 뒤에 나타난 것(대상물 · 상자 · 트럭 · 집은 부품)은 나타난 뿌리가 강체 경계 — 그 아래는 같은 강체
        r.stamp = S;
        if (r.moved) { r.pbody = body; body = r; }
        if (o.isMesh && o.geometry?.attributes?.position) this.part(o, r, body, live, changed);
        const ch = o.children; for (let i = 0; i < ch.length; i++) walk(ch[i], body, isNew); };
      for (const r of roots) walk(r, null, false);
      // 사라진 부품(숨김 · 제거)을 격자에서 뺀다
      for (const p of this.live) if (p.stamp !== S) this.ungrid(p);
      this.live = live; return changed; }
    part(o, r, body, live, changed) {
      const S = this.sample, g = o.geometry;
      if (r.kind === undefined) { const m = Array.isArray(o.material) ? o.material[0] : o.material ?? {};
        r.kind = shapeKind({ geomType: g.type, matType: m.type, transparent: m.transparent, depthWrite: m.depthWrite, additive: m.blending === 2, mark: o.userData?.ifc === 'mark' }); r.parts = []; }
      if (r.kind === 'none') return;
      if (!g.boundingBox) g.computeBoundingBox(); const b = g.boundingBox; if (!(b.max.x >= b.min.x)) return;
      const n = o.isInstancedMesh ? o.count : 1, mw = o.matrixWorld.elements;
      for (let i = 0; i < n; i++) {   // 재고 InstancedMesh는 인스턴스마다 (기본 지오메트리는 원점에 있다)
        let p = r.parts[i]; if (!p) p = r.parts[i] = { id: r.id * 4096 + i, o, inst: o.isInstancedMesh ? i : -1, r, mw: new Float64Array(16).fill(NaN), stamp: 0, cells: null, kind: r.kind, bb: null };
        let M = mw; if (p.inst >= 0) { const im = o.instanceMatrix.array; M = mul(mw, im.subarray ? im.subarray(i * 16, i * 16 + 16) : im.slice(i * 16, i * 16 + 16)); }
        const ch = !same16(p.mw, M) || p.stamp !== S - 1 || p.body !== body;
        if (ch) { p.mw.set(M);
          // 판은 두께를 준 상자로 (법선 = 로컬 z)
          p.bb = r.kind === 'plate' ? [b.min.x, b.min.y, Math.min(b.min.z, -PLATE_T / 2), b.max.x, b.max.y, Math.max(b.max.z, PLATE_T / 2)] : [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
          obbSet(p, p.bb, p.mw);
          // 바닥에 그린 표지 (누운 판 · 바닥에서 10cm 아래) — 물체 아님
          p.none = r.kind === 'plate' && p.aabb[4] <= FLOOR_MARK && Math.abs(p.ax[7]) > 0.99;
          this.regrid(p); p.cls = null; }
        if (p.body !== body || !p.stamp) p.since = S;   // 지금 강체 소속이 된 표본 — 이 뒤 처음 본 순간부터 겹쳐 있었는지(고정 장착) 가릴 때 쓴다
        if (body) p.dynSince ??= S;   // 움직이는 것으로 처음 비교되기 시작한 표본
        p.stamp = S; p.body = body; p.dyn = !!body; p.changed = ch;
        if (p.none) continue;
        live.push(p); if (ch) changed.push(p); } }
    ungrid(p) { if (p.cells) { for (const k of p.cells) this.grid.get(k)?.delete(p); p.cells = null; } this.big.delete(p); }
    regrid(p) { this.ungrid(p); if (p.none) return; const c = this.o.cell, B = p.aabb, x0 = Math.floor(B[0] / c), x1 = Math.floor(B[3] / c), z0 = Math.floor(B[2] / c), z1 = Math.floor(B[5] / c);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 48) { this.big.add(p); return; }   // 바닥 · 벽 같은 큰 것은 따로
      p.cells = []; for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x * 65536 + z; let s = this.grid.get(k); if (!s) this.grid.set(k, s = new Set()); s.add(p); p.cells.push(k); } }
    // 부품 p와 축 정렬 상자가 겹치는 다른 부품들
    near(p, fn) { const q = ++this.q, B = p.aabb; const see = (b) => { if (b === p || b.q === q) return; b.q = q; if (aabbHit(B, b.aabb)) fn(b); };
      if (p.cells) for (const k of p.cells) { const s = this.grid.get(k); if (s) for (const b of s) see(b); }
      else for (const b of this.live) see(b);
      for (const b of this.big) see(b); }
    // 비교할 쌍인가 (V02 group/mask): 둘 중 하나는 움직이는 것 · 같은 강체가 아님 · 관절로 바로 이어진 강체(인접 링크)가 아님
    static mask(a, b) { if (!a.dyn && !b.dyn) return false; if (a.body === b.body) return false; if (a.body && a.body.pbody === b.body && b.body || b.body && b.body.pbody === a.body && a.body) return false; return true; }
    // 이번 표본의 겹침 후보: 자세가 바뀐 부품마다 주변 부품과 방향 상자 깊이 > minDepth. fn(a, b, depth)
    pairs(changed, minDepth, fn) { const S = this.sample;
      for (const a of changed) this.near(a, (b) => { if (b.stamp !== S || b.none) return; if (b.changed && b.id < a.id) return;   // 둘 다 바뀐 쌍은 한 번만
        if (!Scanner.mask(a, b)) return; const d = obbDepth(a, b); if (d > minDepth) fn(a, b, d); }); }
    cls(p) { const v = this.o.version?.() ?? 0; if (p.cls && p.clsV === v) return p.cls; p.clsV = v; return (p.cls = { ...(this.o.classify?.(p.o) ?? {}), top: p.aabb[4], dyn: p.dyn }); }   // version: 개체 표시가 바뀌면(대상물 메시 재사용) 다시 분류
    geom(p) { const g = p.o.geometry; let G = this.geoms?.get(g); if (!G) { (this.geoms ??= new WeakMap()).set(g, G = { pos: g.attributes.position.array, idx: g.index ? g.index.array : null, bb: null }); if (g.attributes.position.isInterleavedBufferAttribute || g.attributes.position.itemSize !== 3) { const at = g.attributes.position, n = at.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = at.getX(i); a[i * 3 + 1] = at.getY(i); a[i * 3 + 2] = at.getZ(i); } G.pos = a; } }
      return { pos: G.pos, idx: G.idx, bb: p.bb, get tb() { return G.tb; }, set tb(v) { G.tb = v; }, get n() { return G.n; }, set n(v) { G.n = v; } }; }
    tri(a, b) { return triHit(this.geom(a), a.mw, this.geom(b), b.mw); }
  }

  // ── 겹침 사건: 같은 부품 쌍의 겹침을 시작 ~ 끝으로 묶는다. 시각은 부르는 쪽이 준 실제 시뮬레이션 시각(sim.time) 그대로 (V04)
  class Tracker {
    constructor() { this.active = new Map(); this.closed = []; this.allowed = new Map(); this.sample = 0; this.t = 0; }
    begin(sample, t) { this.sample = sample; this.t = t; }
    allow(why, d, label) { const a = this.allowed.get(why); if (!a) this.allowed.set(why, { n: 1, maxD: d, ex: label(), t: this.t }); else { a.n++; if (d > a.maxD) { a.maxD = d; a.ex = label(); a.t = this.t; } } }
    // 겹침 한 건. 새 사건이거나 더 깊어졌으면 detail()로 상세(부품 · 행렬 · 자세)를 다시 남긴다
    hit(a, b, d, detail) { const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id; let ev = this.active.get(key);
      if (!ev) { ev = { key, a, b, t0: this.t, s0: this.sample, t1: this.t, maxD: 0, n: 0, tri: null, triN: 0, triD: -1, triS: -99, fresh: true }; this.active.set(key, ev); }
      ev.n++; ev.t1 = this.t; ev.stamp = this.sample; ev.d = d;
      if (d > ev.maxD + 0.002 || ev.fresh) { ev.maxD = Math.max(ev.maxD, d); ev.tMax = this.t; ev.info = detail(); ev.fresh = false; }
      return ev; }
    // 표본 끝: 다시 본 쌍(둘 중 하나가 움직였거나 사라짐)인데 이번에 겹치지 않았으면 사건을 닫는다
    end(present) { for (const [k, ev] of this.active) { if (ev.stamp === this.sample) continue; const gone = !present(ev.a) || !present(ev.b);
      if (gone || ev.a.changed || ev.b.changed) { ev.gone = gone; ev.ended = true; this.active.delete(k); this.closed.push(ev); } } }
    // 끝까지 열려 있던 사건 포함 전부
    all() { return [...this.closed, ...this.active.values()]; }
  }

  // ── 표본 간격: 시뮬레이션 0.1초 간격 사이를 화면 보간(js/stepinterp.js)과 같게 나눠 본다 — 한 표본에 이동체가 move(3cm) 넘게 움직이지 않게 (min ~ max 등분)
  // o = { sim, agent, view, interp, targets(), dt, sub: { min, max, move }, check(t, frac) → true면 멈춤(스크린샷 뒤 advance로 이어 감) }
  class Runner {
    constructor(o) { this.o = o; this.j = 0; this.n = 0; this.left = 0; this.tg = null; this.samples = 0; this.maxSub = 0; this.paused = false; }
    static subs(disp, sub) { return Math.max(sub.min, Math.min(sub.max, Math.ceil(disp / sub.move - 1e-9))); }
    get done() { return this.left <= 0 && this.j >= this.n; }
    // steps 간격을 더 진행한다 (멈췄으면 그 간격의 남은 표본부터 — steps 없이 부른다). 반환: check가 멈추라고 해서 멈췄으면 true
    advance(steps) { const o = this.o, dt = o.dt ?? 0.1; if (steps != null) this.left += steps;
      if (this.paused) { o.interp?.restore(); this.paused = false; }   // 멈춘 동안 그대로 둔 보간 값을 되돌리고 이어 간다
      for (;;) {
        if (this.j >= this.n) {   // 새 간격
          if (this.left <= 0) return false; this.left--;
          const tg = this.tg = o.targets?.() ?? [], p0 = tg.map((m) => [m.x, m.y ?? 0, m.z]);
          o.interp?.capture(tg); o.sim.step(dt); o.agent?.update?.(dt);
          let disp = 0; tg.forEach((m, i) => { const d = Math.hypot(m.x - p0[i][0], (m.y ?? 0) - p0[i][1], m.z - p0[i][2]); if (d < 3 && d > disp) disp = d; });   // 3m 넘는 순간 이동은 보간하지 않는다 (stepinterp와 같게)
          this.n = Runner.subs(disp, o.sub ?? { min: 1, max: 1, move: 0.03 }); this.j = 0; if (this.n > this.maxSub) this.maxSub = this.n; }
        while (this.j < this.n) { this.j++; const a = this.j / this.n;
          if (this.j < this.n) o.interp?.apply(this.tg, a);
          o.view?.update(dt / this.n, true, 1); this.samples++;
          if (o.check(o.sim.time - dt * (1 - a), a)) { this.paused = true; return true; }   // 실제 시뮬레이션 시각 (간격 안에서는 보간 비율만큼 앞) · 보간 값은 그대로 둔 채 멈춘다 (그 자세를 찍게)
          o.interp?.restore(); } } }
  }

  // ── 사건 정리: 고정 장착(같은 개체 안에서 처음 본 순간부터 끝까지 겹친 쌍)과 간섭을 가른다
  // sameUnit(clsA, clsB): 같은 이동체 · 같은 로봇 · 같은 셀 설비인가
  // 이 쌍을 비교하기 시작한 표본: 같은 관절 사슬 안(같은 로봇 · 같은 이동체의 링크끼리)은 둘이 지금 강체로 갈린 때, 그 밖은 둘 중 하나가 움직이는 것이 된 때
  function pairSince(a, b) { const top = (r) => { while (r?.pbody) r = r.pbody; return r; };
    return a.body && b.body && top(a.body) === top(b.body) ? Math.max(a.since ?? 1, b.since ?? 1) : Math.min(a.dynSince ?? Infinity, b.dynSince ?? Infinity); }
  function verdict(ev, A, B) {
    const first = ev.s0 <= pairSince(ev.a, ev.b);   // 처음 비교한 표본부터 겹쳐 있었다
    const unit = A.ent || B.ent ? A.ent === B.ent : !!A.station && A.station === B.station && !(A.robot && B.robot && A.robot !== B.robot);   // 같은 이동체 · 같은 대상물 · 같은 셀 설비(서로 다른 로봇끼리는 아님)
    if (first && unit && (!ev.ended || ev.gone)) return 'mount';   // 고정 장착 · 조립 관계 (간섭으로 세지 않고 따로 적는다)
    return ev.tri === true ? 'confirmed' : ev.tri === false ? 'bounding' : 'unverified'; }

  // ── 검사기: 훑기 → 후보(방향 상자) → 허용 접촉 빼기 → 삼각형 확정 → 사건 기록
  // opt = { minDepth(방향 상자 겹침 깊이 기준 m), tri(삼각형 확정 여부), classify(o), label(part), pose(part), forceDyn }
  class Checker {
    constructor(opt = {}) { this.o = { minDepth: 0.01, tri: true, ...opt }; this.sc = new Scanner(this.o); this.tr = new Tracker(); this.stat = { samples: 0, cand: 0, tri: 0, triMs: 0 }; }
    side(p) { const c = this.sc.cls(p); return { label: this.o.label?.(p) ?? (p.o.name || 'part' + p.id), ent: c.ent ?? null, grp: c.grp ?? null, role: c.role ?? null, station: c.station ?? null, robot: c.robot ?? null, kind: c.kind ?? null, dyn: p.dyn, m: Array.from(p.mw, (x) => +x.toFixed(5)), bb: p.bb.map((x) => +x.toFixed(4)), pose: this.o.pose?.(p) ?? null, ...(this.o.meta?.(p) ?? {}) }; }
    // 한 표본. t = 실제 시뮬레이션 시각. 반환: 이번 표본에 새로 시작된 사건들
    check(roots, t, frac = 1) { const sc = this.sc, tr = this.tr, fresh = [], now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
      const changed = sc.scan(roots); tr.begin(sc.sample, t); this.stat.samples++;
      sc.pairs(changed, this.o.minDepth, (a, b, d) => { if (this.o.only && !this.o.only(sc.cls(a), sc.cls(b))) return; this.stat.cand++;   // only: 그 종류만 보는 재현용 거르개 (--only)
        const why = pairRule(sc.cls(a), sc.cls(b), d); if (why) { tr.allow(why, d, () => (this.o.label?.(a) ?? a.o.name) + ' ↔ ' + (this.o.label?.(b) ?? b.o.name)); return; }
        const ev = tr.hit(a, b, d, () => { const I = [0, 1, 2].map((k) => +((Math.max(a.aabb[k], b.aabb[k]) + Math.min(a.aabb[k + 3], b.aabb[k + 3])) / 2).toFixed(3)); return { t: +t.toFixed(3), frac: +frac.toFixed(3), d: +d.toFixed(4), at: I, a: this.side(a), b: this.side(b) }; });
        if (ev.n === 1) fresh.push(ev);
        // 삼각형 확정: 사건이 시작될 때, 그 뒤로는 아직 확정되지 않은 동안 1cm 더 깊어지거나 0.5초 지날 때마다 다시
        if (this.o.tri && ev.tri !== true && (ev.triN === 0 || d > ev.triD + 0.01 || t - ev.triS >= 0.5)) { const t0 = now(), r = sc.tri(a, b); this.stat.tri++; this.stat.triMs += now() - t0; ev.triN++; ev.triD = d; ev.triS = t;
          if (r.hit) { ev.tri = true; ev.triInfo = { t: +t.toFixed(3), d: +d.toFixed(4), pairs: r.pairs, at: r.at.map((x) => +x.toFixed(3)), inside: r.inside ?? null, na: r.na, nb: r.nb }; }
          else if (r.hit === null) ev.triCap = true; else if (ev.tri == null) { ev.tri = false; ev.triInfo = { na: r.na, nb: r.nb, pairs: 0 }; } } });
      tr.end((p) => p.stamp === sc.sample && !p.none);
      return fresh; }
    // 사건 목록 (JSON으로 내보낼 수 있는 값만). verdict: confirmed(삼각형 확정) · bounding(바운딩만 겹침) · unverified(미확정) · mount(고정 장착)
    report() { const sc = this.sc; return this.tr.all().map((ev) => { const A = sc.cls(ev.a), B = sc.cls(ev.b); return { verdict: verdict(ev, A, B), initial: ev.s0 <= pairSince(ev.a, ev.b), t0: +ev.t0.toFixed(3), t1: +ev.t1.toFixed(3), tMax: +(ev.tMax ?? ev.t0).toFixed(3), maxD: +ev.maxD.toFixed(4), samples: ev.n, open: !ev.ended, gone: !!ev.gone, tri: ev.tri, triCap: !!ev.triCap, triInfo: ev.triInfo ?? null, ...ev.info }; }); }
    allowed() { return [...this.tr.allowed].map(([why, a]) => ({ why, n: a.n, maxD: +a.maxD.toFixed(4), ex: a.ex, t: +a.t.toFixed(2) })); }
  }

  return { mul, inv, same16, obbSet, obbDepth, aabbHit, shapeKind, pairRule, GROUND, RIDE_TOP, PLATE_T, FLOOR_MARK, triPrep, triTri, triHit, inside, Scanner, Tracker, Runner, Checker, verdict };
});
