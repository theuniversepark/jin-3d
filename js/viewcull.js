// 화면 표시용 렌더(메인 화면 · 로봇 비전 전광판 · 로봇 정보 창): 그 화면에 지름 1픽셀보다 작게 찍힐 물체는 빼고 그린다
// 공장 전체를 여러 번 다시 그리므로, 멀리 있는 나사·케이블·라벨판 같은 작은 메시가 그리기 호출 대부분을 차지했다 (tools/perf-sample.cjs 측정)
// 크기는 투영 지름(감싸는 공 지름 × 초점 거리 ÷ 카메라 공간 깊이)으로 잰다 — 반지름 · 유클리드 거리로 재면 지름 1~2픽셀 물체와 화면 가장자리 물체까지 사라졌다 (검수 R11).
//   보수적으로: 공의 카메라 쪽 끝 깊이(깊이 − 반지름)와 가장자리에서 늘어나는 투영(× 거리/깊이)을 쓰고, 카메라에 걸치거나 뒤에 있으면 건드리지 않는다. 초점 거리는 투영 행렬에서 읽어 FOV · zoom · 직교 카메라가 그대로 반영된다
// data: 데이터가 되는 렌더(VLA 에피소드 캡처 · 로봇 카메라 녹화 · CCTV 전광판/영상 창 = NVR 녹화 · 스냅샷 · 영상 프레임 발행 원본)는 작은 물체를 빼지 않는다 — 학습 · 검사 영상에서 작은 부품 · 결함이 빠지면 안 된다
// groups: 화면 표시 전용 렌더(로봇 비전 전광판·로봇 정보 창)만 — 카메라 시야 밖이거나 1픽셀보다 작은 설비 그룹을 통째로 숨긴다.
//   렌더 한 번의 비용 대부분이 3만여 객체를 훑으며 시야를 검사하는 데 들어가서(아무것도 안 보이는 카메라도 약 10ms), 그룹째 빼면 훑을 객체가 준다.
//   그룹은 시야 밖일 때만 숨긴다 (안의 메시도 모두 시야 밖이라 그림이 같음 · 작게 찍히는 큰 설비는 1픽셀이라도 남게 그대로)
//   그룹 범위는 REFRESH_MS마다 다시 재므로 그 사이 안에서 움직이는 부분(로봇 팔·문)은 GROUP_PAD만큼 넉넉히 잡는다 — 데이터가 되는 렌더(녹화·에피소드)에는 쓰지 않는다
import * as THREE from 'three';

const MIN_PX = 1;          // 투영 지름이 이보다 작으면 뺀다 (화면 픽셀 · 경계에서는 그리는 쪽)
const DATA_MIN_PX = 0;     // 데이터가 되는 렌더의 기준 — 0: 작은 물체를 빼지 않음
const SMALL_R = 0.6;       // 이보다 큰 물체(월드 반지름 m)는 후보에서 뺀다 — 보조 카메라 먼 쪽 끝(60~90m)에서도 1픽셀 넘게 찍힘
const REFRESH_MS = 2000;   // 후보 목록을 다시 만드는 간격 (운영 중 새로 생긴 대상물·트럭·Blender 교체 모델)
const GROUP_MIN = 20;      // 그룹째 숨기는 대상: 메시가 이만큼 넘는 그룹
const GROUP_PAD = 3;       // 그룹 범위 여유 (m) — 다시 재기 전까지 안에서 움직이는 팔·문, 서 있다 출발한 차량(2초 · 1.5m/s)

const cache = new WeakMap();   // 장면마다 후보 목록 · 그룹 나무
function candidates(scene) {
  const now = performance.now(), hit = cache.get(scene);
  if (hit && now - hit.t < REFRESH_MS) return hit;
  const list = [], prev = hit?.boxes ?? new WeakMap(), boxes = new WeakMap(), sph = new THREE.Sphere();
  // 아래에서 위로: 그룹마다 자손 물체를 감싸는 상자 · 메시 수 · 숨기면 안 되는 것(빛 · 화면 크기 고정 스프라이트 · 시야 검사를 끈 물체) 포함 여부
  const walk = (o) => {
    const box = new THREE.Box3(); let n = 0, bad = !!(o.isLight || o.isSprite || o.isSkinnedMesh || ((o.isMesh || o.isLine || o.isPoints) && o.frustumCulled === false));
    const kids = [], start = list.length;
    if (o.geometry && (o.isMesh || o.isLine || o.isPoints)) {
      const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
      const s = o.isInstancedMesh ? (o.boundingSphere ?? (o.computeBoundingSphere(), o.boundingSphere)) : g.boundingSphere;
      if (s && Number.isFinite(s.radius)) {
        sph.copy(s).applyMatrix4(o.matrixWorld); box.expandByPoint(sph.center.clone().addScalar(sph.radius)).expandByPoint(sph.center.clone().addScalar(-sph.radius));
        n++;
        if (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && !o.children.length && sph.radius < SMALL_R) list.push({ o, r: sph.radius, c: s.center });   // 자식이 있는 메시는 숨기면 자식까지 사라지므로 뺀다
      }
    }
    for (const c of o.children) { const k = walk(c); if (k.n) box.union(k.box); n += k.n; bad ||= k.bad; if (k.node) kids.push(k.node); else kids.push(...k.kids); }
    let node = null;
    if (!o.isScene && !o.isMesh && n >= GROUP_MIN && !bad && !box.isEmpty()) {
      const p = prev.get(o), moved = !p || p.min.distanceTo(box.min) > 0.05 || p.max.distanceTo(box.max) > 0.05;   // 지난번과 범위가 달라졌으면 움직이는 그룹 — 숨기지 않고 안쪽 그룹만 본다
      boxes.set(o, box.clone());
      node = { o, s: box.getBoundingSphere(new THREE.Sphere()), moved, at: o.matrixWorld.elements.slice(12, 15), kids, start, end: list.length };   // [start, end): 이 그룹 안의 작은 메시 후보 (숨기면 건너뜀)
      node.s.radius += GROUP_PAD;
    }
    return { box, n, bad, node, kids };
  };
  const root = walk(scene);
  const hitNew = { t: now, list, nodes: root.node ? [root.node] : root.kids, boxes };
  cache.set(scene, hitNew);
  return hitNew;
}

const hidden = [], skip = [], frustum = new THREE.Frustum(), vp = new THREE.Matrix4();
// cam: 그릴 카메라 · pxH: 이 렌더가 차지하는 세로 픽셀 (전광판 칸이면 칸 높이) · groups: 그룹째 숨기기 (화면 표시 전용 렌더만) · data: 데이터가 되는 렌더 (작은 물체를 빼지 않음)
export function renderAux(r, scene, cam, pxH, opt) { withCull(scene, cam, pxH, opt, () => r.render(scene, cam)); }
// 메인 화면(후처리 포함)처럼 렌더를 직접 부르는 곳: 작은 물체를 뺀 채 draw()를 실행하고 되돌린다
export function withCull(scene, cam, pxH, { groups = false, data = false } = {}, draw) {
  const minPx = data ? DATA_MIN_PX : MIN_PX;
  if (!groups && !(minPx > 0)) return draw();   // 뺄 것이 없는 렌더 — 후보 목록도 만들지 않는다
  cam.updateMatrixWorld();
  const ce = cam.matrixWorld.elements, cx = ce[12], cy = ce[13], cz = ce[14];
  const fl = Math.hypot(ce[8], ce[9], ce[10]) || 1, fx = -ce[8] / fl, fy = -ce[9] / fl, fz = -ce[10] / fl;   // 카메라가 보는 방향 (월드)
  const ortho = !!cam.isOrthographicCamera, f = (pxH / 2) * cam.projectionMatrix.elements[5];   // 초점 거리(px): 원근은 깊이 1m의 1m가 찍히는 픽셀 수 · 직교는 1m가 찍히는 픽셀 수
  const C = candidates(scene), list = C.list;
  if (groups) {
    frustum.setFromProjectionMatrix(vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const visit = (nd) => {
      const o = nd.o; if (!o.visible) return;
      const e = o.matrixWorld.elements, a = nd.at, still = Math.abs(e[12] - a[0]) + Math.abs(e[13] - a[1]) + Math.abs(e[14] - a[2]) < GROUP_PAD / 2;   // 그룹 자체가 크게 옮겨졌으면(차량) 잰 범위가 안 맞음
      if (!nd.moved && still) {
        if (!frustum.intersectsSphere(nd.s)) { o.visible = false; hidden.push(o); if (nd.end > nd.start) skip.push(nd.start, nd.end); return; }
      }
      for (const k of nd.kids) visit(k);
    };
    for (const nd of C.nodes) visit(nd);
  }
  if (minPx > 0) for (let i = 0, j = 0; i < list.length; i++) {
    if (j < skip.length && i === skip[j]) { i = skip[j + 1] - 1; j += 2; continue; }   // 숨긴 그룹 안 — 훑지 않음 (그룹 순서대로 쌓여 있음)
    const { o, r: rad, c } = list[i]; if (!o.visible) continue;
    const dia = 2 * rad * f;   // 깊이 1m에서의 투영 지름 (px)
    if (ortho) { if (dia < minPx) { o.visible = false; hidden.push(o); } continue; }
    const e = o.matrixWorld.elements;
    const x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12] - cx, y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13] - cy, z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14] - cz;
    const dn = x * fx + y * fy + z * fz - rad; if (dn <= 0) continue;   // 공의 카메라 쪽 끝 깊이 — 카메라에 걸치거나 뒤에 있으면 그대로 둔다 (시야 검사가 거름)
    // 투영 지름 ≈ dia · 거리 / 깊이² (화면 가장자리에서는 1/cos만큼 늘어남) < minPx 일 때만 뺀다 — 제곱해서 비교 (제곱근 없이)
    const m = minPx * dn * dn;
    if (dia * dia * (x * x + y * y + z * z) < m * m) { o.visible = false; hidden.push(o); }
  }
  try { draw(); } finally { for (let i = hidden.length - 1; i >= 0; i--) hidden[i].visible = true; hidden.length = 0; skip.length = 0; }
}
