// 작은 물체 빼기(js/viewcull.js) 검증 — 검수보고서 R11: 「1픽셀 미만 제외」인데 식에 반지름 · 유클리드 거리를 써서 지름 1~2픽셀 물체도 사라졌다
// Three.js 실제 객체로: 투영 지름(카메라 공간 깊이 기준) 1픽셀 이상은 반드시 보이고, 0.5픽셀 미만은 숨겨도 됨, 화면 가장자리 · 깊이 ≠ 거리 · 카메라 변경(FOV · zoom · 해상도 · 방향),
// 데이터가 되는 렌더(에피소드 캡처 · 로봇 카메라 녹화 · CCTV)는 작은 물체를 빼지 않음. 실행: npm test
import fs from 'node:fs';
import * as THREE from 'three';
import { withCull, renderAux } from '../js/viewcull.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const mat = new THREE.MeshBasicMaterial();
// 장면 하나에 공 하나 (후보 목록이 장면마다 2초 보관되므로 경우마다 새 장면) — draw 안에서의 visible과 끝난 뒤 visible을 돌려준다
const probe = (cam, pxH, r, pos, opt = {}) => {
  const scene = new THREE.Scene(), m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat);
  m.position.copy(pos); scene.add(m); scene.updateMatrixWorld(true); cam.updateMatrixWorld(true);
  let during; withCull(scene, cam, pxH, opt, () => { during = m.visible; });
  return { during, after: m.visible };
};
// 기대값: 카메라 공간 깊이로 본 투영 지름 (px) — 2r · (pxH/2 · P[5]) / 깊이
const diaPx = (cam, pxH, r, pos) => { const v = pos.clone().applyMatrix4(cam.matrixWorldInverse); return 2 * r * (pxH / 2) * cam.projectionMatrix.elements[5] / (cam.isOrthographicCamera ? 1 : -v.z); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

console.log('== 경계 픽셀 (R11 최소 재현: 반지름 0.01m · 거리 1.5m · FOV 60° · 높이 120px)');
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100); cam.updateMatrixWorld(true);
{ const p = V(0, 0, -1.5), d = diaPx(cam, 120, 0.01, p), r = probe(cam, 120, 0.01, p);
  check('투영 지름 1.39px 물체는 그린다', Math.abs(d - 1.3856) < 1e-3 && r.during === true, `지름 ${d.toFixed(3)}px · 렌더 중 visible=${r.during}`); }
{ const p = V(0, 0, -5), d = diaPx(cam, 120, 0.01, p), r = probe(cam, 120, 0.01, p);
  check('0.5px 미만(0.42px)은 렌더 동안만 숨기고 되돌린다', d < 0.5 && r.during === false && r.after === true, `지름 ${d.toFixed(3)}px · 렌더 중 ${r.during} · 뒤 ${r.after}`); }
{ // 1px 바로 위 · 아래: 위는 반드시 보임 (아래는 보수적으로 남겨도 됨)
  const z1 = -(0.02 * 120 / (2 * Math.tan(Math.PI / 6))) , a = probe(cam, 120, 0.01, V(0, 0, z1 * 0.999)), b = probe(cam, 120, 0.01, V(0, 0, z1 * 1.2));
  check('지름 1.001px는 보이고 0.83px는 보수적으로 남기거나 숨김', a.during === true, `1.001px → ${a.during} · 0.83px → ${b.during}`); }

console.log('== 화면 가장자리 · 깊이 ≠ 거리');
{ // FOV 90° · 가로 2:1 — 깊이 1.15m, 옆으로 2m (거리 2.31m): 화면 안 오른쪽 끝, 깊이 기준 지름 1.04px
  const c = new THREE.PerspectiveCamera(90, 2, 0.1, 100); c.updateMatrixWorld(true);
  const p = V(2.0, 0, -1.15), d = diaPx(c, 120, 0.01, p), ndc = p.clone().project(c), r = probe(c, 120, 0.01, p);
  check('가장자리 물체: 유클리드 거리로는 1px 미만이어도 깊이 기준 1px 이상이면 그린다', d >= 1 && Math.abs(ndc.x) < 1 && 0.02 * 60 / p.length() < 1 && r.during === true, `깊이 지름 ${d.toFixed(2)}px · 거리 지름 ${(0.02 * 60 / p.length()).toFixed(2)}px · NDC x ${ndc.x.toFixed(2)}`); }
{ // 시야 안 무작위 위치 · 무작위 카메라: 투영 지름 1px 이상인데 숨긴 것이 하나도 없어야 한다
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let n = 0, wrong = 0, hidTiny = 0, tiny = 0, worst = '';
  for (let k = 0; k < 1500; k++) {
    const fov = 20 + rnd() * 80, asp = 0.75 + rnd() * 1.5, pxH = [90, 120, 144, 270, 960, 1920][Math.floor(rnd() * 6)];
    const c = new THREE.PerspectiveCamera(fov, asp, 0.1, 200); c.position.set(rnd() * 20 - 10, rnd() * 6, rnd() * 20 - 10); c.lookAt(rnd() * 20 - 10, rnd() * 3, rnd() * 20 - 10); c.updateMatrixWorld(true);
    const depth = 0.5 + rnd() * 60, th = Math.tan(fov * Math.PI / 360), local = V((rnd() * 2 - 1) * th * asp * depth * 0.98, (rnd() * 2 - 1) * th * depth * 0.98, -depth);
    const r = 0.002 + rnd() * 0.3, p = local.applyMatrix4(c.matrixWorld), d = diaPx(c, pxH, r, p), res = probe(c, pxH, r, p);
    if (d >= 1) { n++; if (!res.during) { wrong++; worst ||= `지름 ${d.toFixed(2)}px · FOV ${fov.toFixed(0)}° · ${pxH}px · 깊이 ${depth.toFixed(1)}m`; } }
    if (d < 0.25) { tiny++; if (!res.during) hidTiny++; }
  }
  check('무작위 1,500경우: 1px 이상인데 숨긴 것 0', n > 300 && wrong === 0, `1px 이상 ${n}건 중 숨김 ${wrong}건${worst ? ' (' + worst + ')' : ''}`);
  check('무작위: 0.25px 미만은 대부분 숨김 (빼기 효과 유지)', tiny > 100 && hidTiny / tiny > 0.9, `${hidTiny}/${tiny}`); }
{ // 카메라 뒤 · 카메라에 걸친 물체는 건드리지 않는다 (깊이가 0 이하 — 시야 검사에 맡김)
  const r = probe(cam, 120, 0.01, V(0, 0, 0.005));
  check('카메라에 걸친 물체는 숨기지 않음', r.during === true); }

console.log('== 카메라 변경 (FOV · zoom · 해상도 · 방향 · 직교)');
{ const p = V(0, 0, -5);
  const tele = new THREE.PerspectiveCamera(15, 1, 0.1, 100); tele.updateMatrixWorld(true);
  check('FOV 60° → 15°: 0.42px → 1.82px, 보인다', diaPx(tele, 120, 0.01, p) > 1 && probe(tele, 120, 0.01, p).during === true, `${diaPx(tele, 120, 0.01, p).toFixed(2)}px`);
  const zoom = new THREE.PerspectiveCamera(60, 1, 0.1, 100); zoom.zoom = 4; zoom.updateProjectionMatrix(); zoom.updateMatrixWorld(true);
  check('zoom 4: 1.66px, 보인다', diaPx(zoom, 120, 0.01, p) > 1 && probe(zoom, 120, 0.01, p).during === true, `${diaPx(zoom, 120, 0.01, p).toFixed(2)}px`);
  check('해상도 120px → 480px: 1.66px, 보인다', probe(cam, 480, 0.01, p).during === true && probe(cam, 120, 0.01, p).during === false);
  const side = new THREE.PerspectiveCamera(60, 1, 0.1, 100); side.position.set(3, 1, 2); side.lookAt(13, 1, 2); side.updateMatrixWorld(true);   // +x를 보는 카메라
  check('옆을 보는 카메라: 앞 1.5m는 보이고 앞 5m는 숨김', probe(side, 120, 0.01, V(4.5, 1, 2)).during === true && probe(side, 120, 0.01, V(8, 1, 2)).during === false);
  const ortho = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100); ortho.updateMatrixWorld(true);   // 세로 4m를 120px에 — 0.02m = 0.6px, 0.04m = 1.2px (거리와 무관)
  check('직교 카메라: 거리와 무관하게 1.2px는 보이고 0.3px는 숨김', probe(ortho, 120, 0.02, V(0, 0, -50)).during === true && probe(ortho, 120, 0.005, V(0, 0, -1)).during === false); }

console.log('== 데이터가 되는 렌더 (에피소드 캡처 · 녹화) — 작은 물체를 빼지 않음');
{ const p = V(0, 0, -30), d = diaPx(cam, 120, 0.005, p);
  check('data 정책: 0.03px 물체도 남긴다', d < 0.05 && probe(cam, 120, 0.005, p, { data: true }).during === true && probe(cam, 120, 0.005, p).during === false, `지름 ${d.toFixed(3)}px`);
  // renderAux도 같은 정책으로 — 렌더러가 그리는 순간의 visible
  const scene = new THREE.Scene(), m = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), mat); m.position.copy(p); scene.add(m); scene.updateMatrixWorld(true);
  const seen = []; const R = { render: () => seen.push(m.visible) };
  renderAux(R, scene, cam, 120, { data: true }); renderAux(R, scene, cam, 120);
  check('renderAux(…, { data: true })는 그리고, 표시용은 뺀다', seen[0] === true && seen[1] === false && m.visible === true, JSON.stringify(seen)); }
{ // 데이터가 되는 렌더 호출부가 data 정책을 쓰는지 (소스 확인)
  const src = (f) => fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
  const rc = src('robotcam.js'), cap = rc.slice(rc.indexOf('captureFrame(ref'), rc.indexOf('drawDetections(g, cam'));
  check('에피소드 캡처(robotcam.captureFrame)는 data 정책', /renderAux\(r, this\.scene, this\.capCam, h, \{ data: true \}\)/.test(cap));
  check('로봇 카메라 녹화(robotrec)는 data 정책', /renderAux\(r, this\.cw\.scene, this\.cams\[i\], RREC\.th, \{ data: true \}\)/.test(src('robotrec.js')));
  check('CCTV 전광판 · 영상 창(녹화 · 스냅샷 원본)은 data 정책', /renderAux\(r, this\.scene, cam, [^)]*, \{ data: true \}\)/.test(src('cctvview.js')));
  check('화면 표시 전용(로봇 비전 전광판 · 로봇 정보 창)은 표시 정책 그대로', (rc.match(/renderAux\([^;]*\{ groups: true \}\)/g) ?? []).length === 2); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
