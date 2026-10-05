// 3D 공장 모델 — 정적 레이아웃 생성 + 시뮬레이션 상태 동기화
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RobotTelemetry } from './telemetry.js';
import { BELT_Y, LOC, chgLoc, FG_CAP, RAW_CAP, ST_LABEL, TOOL_KITS, SINK_PICK } from './sim.js';
import { YARD } from './shipping.js';
import { INBOUND, WH, WH_RACK } from './receiving.js';
import { DRONE_PAD, dronePad } from './drone.js';
import { STAGES, INCIDENT_TYPES, prioOf } from './orchestrator.js';
import { NR } from './net5g.js';
import { blenderOn, cloneAsset, RENDER } from './blender.js';
import { equipmentList, STATUS_CLASS } from './assets.js';
import { ROBOT_KINDS, toWorld, pointAt, pathLength, isZone, ZONE_CELLS, ZONE_PRODUCTS, ZONE_MIXES, ZONE_NAME, FG_ZONE_CAP, AMR_LANES, amrPark, ZONE_AMR, AMMR, AMMR_FETCH } from './line.js';

// ── 헬퍼 ─────────────────────────────
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...o });
const emis = (color, intensity = 2) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
function mesh(geo, mat, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow; m.receiveShadow = true;
  return m;
}
const box = (w, h, d, mat, shadow) => mesh(new THREE.BoxGeometry(w, h, d), mat, shadow);
const cyl = (rt, rb, h, mat, seg = 20) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
const put = (o, x, y, z, parent) => { o.position.set(x, y, z); parent?.add(o); return o; };
// 로봇 카메라 모듈 (휴머노이드·AMMR: 머리 · 왼손 · 오른손 · 등 4대): 하우징·렌즈를 달고 앵커(+z = 보는 방향)를 돌려준다
// 앵커는 관절(머리·손목·몸통)에 붙어 함께 움직인다 — 로봇 영상(robotcam.js)과 VLA 에피소드 카메라 프레임이 이 시점을 쓴다
export const ROBOT_CAMS = [['head', '머리 스테레오 카메라'], ['handL', '왼손 카메라'], ['handR', '오른손 카메라'], ['back', '등 카메라']];
const CAM_BODY = new THREE.MeshStandardMaterial({ color: 0x1b1f25, roughness: 0.4, metalness: 0.55 });
const CAM_LENS = new THREE.MeshStandardMaterial({ color: 0x0a0d10, emissive: 0x37e8ff, emissiveIntensity: 1.8, roughness: 0.2 });
function camModule(parent, x, y, z, pitch = 0, yaw = 0, size = 0.05, housing = true) {
  const a = put(new THREE.Object3D(), x, y, z, parent); a.rotation.set(pitch, yaw, 0, 'YXZ');
  if (housing) {
    put(box(size, size * 0.72, size * 0.8, CAM_BODY, false), 0, 0, -size * 0.25, a);
    const lens = put(cyl(size * 0.28, size * 0.3, size * 0.22, CAM_LENS, 14), 0, 0, size * 0.2, a); lens.rotation.x = Math.PI / 2; lens.castShadow = false;
  }
  return a;
}

const MAT = {
  floor: std(0x55595f, { roughness: 0.92 }),
  lane: std(0x4a5560, { roughness: 0.9 }),
  laneLine: std(0xe8b923, { roughness: 0.7 }),
  wall: std(0xc9ccd1, { roughness: 0.9 }),
  steel: std(0x9aa3ad, { metalness: 0.65, roughness: 0.32 }),
  dark: std(0x2d3238, { metalness: 0.4, roughness: 0.55 }),
  white: std(0xe9ecef, { roughness: 0.45 }),
  accent: std(0x1f6feb, { roughness: 0.4 }),
  orange: std(0xf08a24, { roughness: 0.4, metalness: 0.15 }),
  yellow: std(0xf2c230, { roughness: 0.5 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0xa8d8ff, transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false }),
  booth: new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false }),
  pallet: std(0xa67c52, { roughness: 0.85 }),
  carton: std(0xc49a6c, { roughness: 0.85 }),
  raw: std(0x7d848c, { metalness: 0.5, roughness: 0.5 }),
  partsBin: std(0x2f6fd6, { roughness: 0.6 }),   // 입고 부품 팔레트 (부품 빈)
  crate: std(0x8a78a8, { roughness: 0.8 }),   // e-axle 크레이트 (구분 적재장과 같은 색)
  machined: std(0xd0d6dc, { metalness: 0.85, roughness: 0.18 }),
  copper: std(0xc8743a, { metalness: 0.8, roughness: 0.3 }),
  painted: std(0x2f6fd6, { metalness: 0.3, roughness: 0.3 }),
  defect: std(0xd23b3b, { emissive: 0x550000 }),
  rubber: std(0x1d1f22, { roughness: 0.9 }),
  skin: std(0xe0b48c),
  hiVis: std(0xb7f23a, { emissive: 0x1a2a00 }),
  shirt: std(0x3d5a80),
  tray: std(0x1f8a8a, { roughness: 0.6 }),
  trim: std(0x3a3633, { roughness: 0.75 }),
  trimSoft: std(0xb9a58a, { roughness: 0.85 }),
  clip: std(0xf2f2f2, { roughness: 0.4 }),
  housing: std(0xc4ccd4, { metalness: 0.75, roughness: 0.28 }),
  bolt: std(0x30353b, { metalness: 0.8, roughness: 0.3 }),
  crate: std(0x8a78a8, { roughness: 0.8 }),
};
// 정밀조립Zone 셀 바닥 색: 공동·공용 / 도어트림 전용 / e-axle 전용
const ZONE_COLOR = { shared: 0x2bb3a6, doortrim: 0xf0a030, eaxle: 0x9a6bff };
const cellUse = (id) => ZONE_CELLS[id]?.product ?? 'shared';

function beltTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#26292d'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#3a3f45'; g.fillRect(0, 0, 10, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const BELT_TEX = beltTexture();

function floorTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#8b9096'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 4000; i++) {
    const v = 120 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v + 2},${v + 5},0.25)`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = 'rgba(40,44,50,0.55)'; g.lineWidth = 2;
  for (let i = 0; i <= 512; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(22.25, 10); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ── 공용 부품 ─────────────────────────────
function makeStackLight() {
  const g = new THREE.Group();
  put(cyl(0.04, 0.04, 0.9, MAT.steel), 0, 0.45, 0, g);
  const colors = [0x30ff70, 0xffb020, 0xff3030];
  const mats = colors.map((c) => emis(c, 0.15));
  mats.forEach((m, i) => put(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 16), m, false), 0, 0.98 + (2 - i) * 0.17, 0, g));
  put(cyl(0.11, 0.11, 0.05, MAT.dark), 0, 1.42, 0, g);
  g.userData.set = (state, t) => {
    const blink = Math.sin(t * 8) > 0;
    const on = [0, 0, 0];
    if (state === 'BUSY') on[0] = 1;
    else if (state === 'ESTOP') on[2] = 1;                                  // 비상정지: 적색 점등 유지
    else if (state === 'PSTOP') on[1] = 1;                                  // 보호정지: 황색 점등 유지
    else if (state === 'CSTOP') on[1] = Math.sin(t * 3) > 0 ? 0.9 : 0.15;   // 사이클 정지: 황색 느린 점멸
    else if (state === 'CHECK') on[0] = blink ? 1 : 0.15;                   // 자가진단: 녹색 점멸
    else if (state === 'DOWN') on[2] = blink ? 1 : 0.1;
    else if (state === 'MAINT') { on[1] = blink ? 1 : 0.1; on[2] = blink ? 0.1 : 0.8; }
    else if (state === 'BLOCKED' || state === 'FULL' || state === 'HOLD') on[1] = blink ? 1 : 0.2;
    else if (state !== 'OFF') on[1] = 0.8;
    mats.forEach((m, i) => (m.emissiveIntensity = on[i] ? 3.2 * on[i] : 0.12));
  };
  return g;
}

// Blender 6축 팔 (RB20-1900 분위기의 독자 디자인): makeArm과 같은 관절 그룹·치수에 관절별 Blender 마디(Seg_*)를 배율 s로 붙인다
function makeArmBlender(mat, s) {
  const A = cloneAsset('arm6'), seg = (n, parent) => { const o = A.find(n); o.scale.setScalar(s); o.position.set(0, 0, 0); parent.add(o); return o; };
  if (mat?.color && mat !== COBOT_MAT) A.mats.ArmAcc.color.copy(mat.color);   // 산업용 팔은 셀 색을 관절 링 색으로
  const root = new THREE.Group();
  seg('Seg_Base', root);
  const turret = put(new THREE.Group(), 0, 0.4 * s, 0, root); seg('Seg_Turret', turret);
  const shoulder = put(new THREE.Group(), 0, 0.42 * s, 0, turret); seg('Seg_Shoulder', shoulder);
  const elbow = put(new THREE.Group(), 0, 1.1 * s, 0, shoulder); seg('Seg_Elbow', elbow);
  const wrist = put(new THREE.Group(), 0, 0.9 * s, 0, elbow); seg('Seg_Wrist', wrist);
  const wrist2 = put(new THREE.Group(), 0, 0, 0, wrist); seg('Seg_Wrist2', wrist2);
  const flange = put(new THREE.Group(), 0, 0.13 * s, 0, wrist2); seg('Seg_Flange', flange);
  const tip = put(new THREE.Object3D(), 0, 0.17 * s, 0, flange);
  const pose = (yaw, a, b, c, d = 0, e = 0) => { turret.rotation.y = yaw; shoulder.rotation.x = a; elbow.rotation.x = b; wrist.rotation.x = c; wrist2.rotation.z = d; flange.rotation.y = e; };
  const joints = () => [turret.rotation.y, shoulder.rotation.x, elbow.rotation.x, wrist.rotation.x, wrist2.rotation.z, flange.rotation.y];
  pose(0, 0.2, 0.9, 0.5);
  return { root, turret, shoulder, elbow, wrist, tip, pose, joints, blender: true };
}
function makeArm(mat, s = 1) {
  if (blenderOn()) return makeArmBlender(mat, s);
  const root = new THREE.Group();
  put(cyl(0.34 * s, 0.42 * s, 0.4 * s, MAT.dark), 0, 0.2 * s, 0, root);
  const turret = put(new THREE.Group(), 0, 0.4 * s, 0, root);
  put(cyl(0.27 * s, 0.3 * s, 0.35 * s, mat), 0, 0.17 * s, 0, turret);
  const shoulder = put(new THREE.Group(), 0, 0.42 * s, 0, turret);
  put(mesh(new THREE.SphereGeometry(0.2 * s, 16, 12), mat), 0, 0, 0, shoulder);
  put(box(0.22 * s, 1.1 * s, 0.24 * s, mat), 0, 0.55 * s, 0, shoulder);
  const elbow = put(new THREE.Group(), 0, 1.1 * s, 0, shoulder);
  put(mesh(new THREE.SphereGeometry(0.16 * s, 16, 12), MAT.dark), 0, 0, 0, elbow);
  put(box(0.17 * s, 0.9 * s, 0.17 * s, mat), 0, 0.45 * s, 0, elbow);
  const wrist = put(new THREE.Group(), 0, 0.9 * s, 0, elbow);
  put(mesh(new THREE.SphereGeometry(0.1 * s, 12, 10), MAT.dark), 0, 0, 0, wrist);
  // J5(손목 비틀기)·J6(툴 플랜지 회전) — 관절 데이터를 실제 모델 값으로 보여 주기 위해 분리
  const wrist2 = put(new THREE.Group(), 0, 0, 0, wrist);
  const flange = put(new THREE.Group(), 0, 0.13 * s, 0, wrist2);
  put(cyl(0.05 * s, 0.09 * s, 0.26 * s, MAT.steel), 0, 0, 0, flange);
  put(box(0.14 * s, 0.03 * s, 0.03 * s, MAT.dark), 0, 0.12 * s, 0, flange);   // 그리퍼 핑거 (회전이 보이도록)
  const tip = put(new THREE.Object3D(), 0, 0.17 * s, 0, flange);
  const pose = (yaw, a, b, c, d = 0, e = 0) => { turret.rotation.y = yaw; shoulder.rotation.x = a; elbow.rotation.x = b; wrist.rotation.x = c; wrist2.rotation.z = d; flange.rotation.y = e; };
  const joints = () => [turret.rotation.y, shoulder.rotation.x, elbow.rotation.x, wrist.rotation.x, wrist2.rotation.z, flange.rotation.y];
  pose(0, 0.2, 0.9, 0.5);
  return { root, turret, shoulder, elbow, wrist, tip, pose, joints };
}

// 구분 적재장 팔레타이징 로봇: 크기(배율)와 설치 위치(셀 중심에서 z 거리)
const PALLET_ARM = { s: 1.35, z: 1.25 };
// 2링크 역기구학: 팔 루트 기준 목표점(x, y, z)에 툴 끝이 아래를 향해 닿는 관절값 [J1, J2, J3, J4]
function armIK(s, x, y, z) {
  const L1 = 1.1 * s, L2 = 0.9 * s, tool = 0.3 * s, sh = 0.82 * s;
  const yaw = Math.atan2(x, z), r = Math.hypot(x, z), wy = y + tool - sh;
  const d = Math.min(Math.hypot(r, wy), L1 + L2 - 1e-3);
  const b = Math.acos(Math.max(-1, Math.min(1, (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2))));
  const a = Math.atan2(r, wy) - Math.atan2(L2 * Math.sin(b), L1 + L2 * Math.cos(b));
  return [yaw, a, b, Math.PI - a - b];
}

// 관절 정의 (이름·단위·가동 범위) — 텔레메트리 표시용
const DEG = Math.PI / 180;
const ARM_JOINTS = [
  { name: 'J1 베이스 회전', unit: 'deg', min: -180 * DEG, max: 180 * DEG },
  { name: 'J2 어깨', unit: 'deg', min: -90 * DEG, max: 150 * DEG },
  { name: 'J3 팔꿈치', unit: 'deg', min: -60 * DEG, max: 170 * DEG },
  { name: 'J4 손목 굽힘', unit: 'deg', min: -120 * DEG, max: 120 * DEG },
  { name: 'J5 손목 비틀기', unit: 'deg', min: -120 * DEG, max: 120 * DEG },
  { name: 'J6 툴 플랜지', unit: 'deg', min: -360 * DEG, max: 360 * DEG },
];

function makeSparks(color, n = 40, size = 0.07) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const p = new THREE.Points(geo, mat);
  p.userData.vel = new Float32Array(n * 3); p.userData.life = new Float32Array(n);
  p.frustumCulled = false;
  return p;
}
function stepSparks(p, active, origin, dt, spread = 1.5, gravity = -6) {
  const pos = p.geometry.attributes.position.array, vel = p.userData.vel, life = p.userData.life;
  for (let i = 0; i < life.length; i++) {
    life[i] -= dt;
    if (life[i] <= 0) {
      if (active && Math.random() < 0.5) {
        life[i] = 0.25 + Math.random() * 0.4;
        pos[i * 3] = origin.x; pos[i * 3 + 1] = origin.y; pos[i * 3 + 2] = origin.z;
        vel[i * 3] = (Math.random() - 0.5) * spread; vel[i * 3 + 1] = Math.random() * spread; vel[i * 3 + 2] = (Math.random() - 0.5) * spread;
      } else { pos[i * 3 + 1] = -100; continue; }
    }
    vel[i * 3 + 1] += gravity * dt;
    pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
  }
  p.geometry.attributes.position.needsUpdate = true;
}

function makeWorker(hat = 0xf2c230, vest = MAT.hiVis) {
  const g = new THREE.Group();
  const body = put(new THREE.Group(), 0, 0, 0, g);
  put(mesh(new THREE.CapsuleGeometry(0.13, 0.7, 4, 8), MAT.shirt), -0.11, 0.45, 0, body);
  put(mesh(new THREE.CapsuleGeometry(0.13, 0.7, 4, 8), MAT.shirt), 0.11, 0.45, 0, body);
  put(mesh(new THREE.CapsuleGeometry(0.26, 0.55, 4, 10), vest), 0, 1.25, 0, body);
  put(mesh(new THREE.SphereGeometry(0.17, 14, 10), MAT.skin), 0, 1.78, 0, body);
  const helmet = mesh(new THREE.SphereGeometry(0.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(hat));
  put(helmet, 0, 1.82, 0, body);
  const armL = put(mesh(new THREE.CapsuleGeometry(0.07, 0.55, 4, 6), vest), -0.33, 1.25, 0, body);
  const armR = put(mesh(new THREE.CapsuleGeometry(0.07, 0.55, 4, 6), vest), 0.33, 1.25, 0, body);
  g.userData = { body, armL, armR };
  return g;
}

function makeAGV(i) {
  if (blenderOn()) return makeAGVBlender();
  const g = new THREE.Group();
  put(box(1.1, 0.32, 1.5, MAT.white), 0, 0.24, 0, g);
  put(box(1.14, 0.06, 1.54, MAT.dark), 0, 0.1, 0, g);
  const led = emis(0x2aa8ff, 2.5);
  put(box(1.16, 0.05, 0.05, led, false), 0, 0.3, 0.76, g);
  put(box(1.16, 0.05, 0.05, led, false), 0, 0.3, -0.76, g);
  put(cyl(0.12, 0.14, 0.12, MAT.dark), 0, 0.46, 0.55, g);
  put(box(1.0, 0.04, 1.3, MAT.steel), 0, 0.42, -0.05, g);
  const load = put(new THREE.Group(), 0, 0.44, -0.05, g);
  put(box(1.0, 0.12, 1.2, MAT.pallet), 0, 0.06, 0, load);
  const crates = [];
  for (let k = 0; k < 6; k++) {
    const c = put(box(0.42, 0.3, 0.36, MAT.raw), -0.24 + (k % 2) * 0.48, 0.28, -0.4 + Math.floor(k / 2) * 0.4, load);
    crates.push(c);
  }
  load.visible = false;
  g.userData = { led, load, crates };
  return g;
}

// 조립 대상물 운반 AMR — 리프트 위 지그 상판이 컨베이어 높이(BELT_Y)에 맞춰져 있다. 길이 방향이 로컬 +z
// 제품 실물 이미지 (assets/doortrim.png · assets/eaxle.png) — 흰 바탕은 가장자리에서부터 채워 투명하게(부품 안쪽의 밝은 부분은 그대로)
const IMG_TEX = new Map();
function productTex(path, w, h) {
  if (IMG_TEX.has(path)) return IMG_TEX.get(path);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; IMG_TEX.set(path, tex);
  const img = new Image();
  img.onload = () => {
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h), a = d.data, seen = new Uint8Array(w * h), stack = [];
    const white = (i) => { const r = a[i * 4], gg = a[i * 4 + 1], b = a[i * 4 + 2]; return r > 226 && gg > 226 && b > 226 && Math.max(r, gg, b) - Math.min(r, gg, b) < 24; };
    for (let k = 0; k < w; k++) stack.push(k, (h - 1) * w + k);
    for (let k = 0; k < h; k++) stack.push(k * w, k * w + w - 1);
    while (stack.length) { const i = stack.pop(); if (seen[i] || !white(i)) continue; seen[i] = 1; a[i * 4 + 3] = 0; const x = i % w, y = (i / w) | 0; if (x > 0) stack.push(i - 1); if (x < w - 1) stack.push(i + 1); if (y > 0) stack.push(i - w); if (y < h - 1) stack.push(i + w); }
    g.putImageData(d, 0, 0); tex.needsUpdate = true;
  };
  img.src = path;
  return tex;
}
// 이미지 판: 위면에 실물 이미지, 아래로 어두운 판을 겹쳐 두께감 (W × D, 두께 = layers × step)
function makeImagePlate(tex, W, D, layers, step) {
  const g = new THREE.Group(), top0 = 0.02 + layers * step;
  const top = put(new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.5, metalness: 0.1 })), 0, top0, 0, g);
  top.rotation.x = -Math.PI / 2; top.castShadow = true;
  for (let k = 1; k <= layers; k++) {
    const m = put(new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, color: 0x4a4650, roughness: 0.8 })), 0, top0 - k * step, 0, g);
    m.rotation.x = -Math.PI / 2;
  }
  g.userData.top = top0;
  return g;
}
// 도어트림: AMR 지그 상판(1.1 × 0.8m) 짧은 변에 맞춘 0.8m 정사각 (이미지 비율 그대로), 트림 패널 약 5cm
function makeDoortrimPlate() { return makeImagePlate(productTex('assets/doortrim.png', 512, 512), 0.8, 0.8, 3, 0.016); }
// e-axle: 세로로 긴 단면 이미지(1:2)를 AMR 진행 방향(긴 변 1.1m)으로 눕혀 1.04 × 0.52m, 하우징 두께감 약 12cm. 체결 후 볼트 표시
// Blender e-axle (원통형 동축 모터 + 감속기 + 인버터, 앞 위쪽 단면으로 권선·회전자·기어가 보임): 길이 1.04m를 AMR 진행 방향(x)으로, 체결 볼트 FastenBolts
function makeEaxleModel() {
  const A = cloneAsset('eaxle'), g = new THREE.Group(); g.add(A.root);
  g.userData = { bolts: A.find('FastenBolts'), tagY: 0.66, blender: true };
  return g;
}
function makeEaxlePlate() {
  if (blenderOn()) return makeEaxleModel();
  const g = new THREE.Group(), p = makeImagePlate(productTex('assets/eaxle.png', 256, 512), 0.52, 1.04, 6, 0.02);
  p.rotation.y = Math.PI / 2; g.add(p);
  const bolts = put(new THREE.Group(), 0, p.userData.top + 0.02, 0, g);
  for (const sx of [-0.44, 0.44]) for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; put(cyl(0.022, 0.022, 0.04, MAT.bolt, 6), sx + Math.cos(a) * 0.07, 0, Math.sin(a) * 0.07, bolts); }
  g.userData.bolts = bolts;
  return g;
}
// ── Blender 옵션 모델 (assets/blender/*.glb) — 코드가 쓰는 부분(상태등 재질·적재물·로터·경광등)은 3D 모델과 같은 이름으로 넘긴다
function makeAGVBlender() {
  const A = cloneAsset('agv'), g = new THREE.Group(); g.add(A.root);
  const load = put(new THREE.Group(), 0, 0.44, -0.05, g);   // 팔레트·원자재 박스 (적재 시에만)
  put(box(1.0, 0.12, 1.2, MAT.pallet), 0, 0.06, 0, load);
  const crates = [];
  for (let k = 0; k < 6; k++) crates.push(put(box(0.42, 0.3, 0.36, MAT.raw), -0.24 + (k % 2) * 0.48, 0.28, -0.4 + Math.floor(k / 2) * 0.4, load));
  load.visible = false;
  g.userData = { led: A.mats.LED, load, crates, blender: true };
  return g;
}
function makeCarrierAMRBlender() {
  const A = cloneAsset('amr'), g = new THREE.Group(); g.add(A.root);
  g.userData = { led: A.mats.LED, blender: true };
  return g;
}
function makeForkliftBlender() {
  const A = cloneAsset('forklift'), g = new THREE.Group(); g.add(A.root);
  const driver = makeWorker(0xf2c230); driver.scale.setScalar(0.85); put(driver, 0, 0.55, -0.45, g);
  const beacon = put(box(0.22, 0.14, 0.22, emis(0xffb020, 2.5), false), 0, 2.24, -0.4, g); beacon.visible = false;
  const fork = A.find('ForkCarriage');   // 포크·캐리지 (마스트를 따라 승강) — 적재물도 포크 위에 얹혀 같이 오르내린다
  const load = put(new THREE.Group(), 0, 0.2, 1.3, fork);
  put(box(1.0, 0.12, 1.1, MAT.pallet), 0, 0.06, 0, load);
  const crates = [];
  for (let k = 0; k < 6; k++) crates.push(put(box(0.42, 0.3, 0.34, MAT.raw), -0.24 + (k % 2) * 0.48, 0.28, -0.36 + Math.floor(k / 2) * 0.36, load));
  load.visible = false;
  g.userData = { led: null, load, crates, roof: A.find('Guard'), driver, beacon, fork, blender: true };
  return g;
}
function makeDroneBlender() {
  const A = cloneAsset('drone'), g = new THREE.Group(), body = put(new THREE.Group(), 0, 0, 0, g); body.add(A.root);
  const rotors = [0, 1, 2, 3].map((i) => A.find(`Rotor_${i}`));
  const beam = put(mesh(new THREE.ConeGeometry(1.6, 1, 28, 1, true), new THREE.MeshBasicMaterial({ color: 0x37e8ff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }), false), 0, -0.5, 0, g);
  beam.visible = false;
  g.userData = { body, rotors, beam, strobe: { material: A.mats.STROBE }, navR: A.find('NavR'), navG: A.find('NavG'), blender: true };
  return g;
}
// Blender 휴머노이드 (Atlas 분위기의 독자 디자인): 관절 빈 객체를 3D 모델과 같은 이름(body·armL/R·legL/R)으로 넘기고 팔꿈치·무릎을 더한다
function makeHumanoidBlender(accent) {
  const A = cloneAsset('humanoid'), g = new THREE.Group(); g.add(A.root);
  A.mats.ACC.color.setHex(accent); A.mats.ACC.emissive.setHex(accent);
  const body = A.find('Body');
  const bin = put(box(0.42, 0.24, 0.32, std(0x2f6fd6)), 0, 1.0, 0.38, body);   // 부품 빈 (운반 중)
  bin.visible = false;
  const waist = A.find('Waist'), head = A.find('Head'), elbowL = A.find('Elbow_L'), elbowR = A.find('Elbow_R');
  // 카메라 4대: 머리(얼굴판 스테레오) · 양손(손바닥 위, 손가락 쪽을 봄) · 등(백팩 위, 뒤를 봄)
  const cams = { head: camModule(head, 0, 0.02, 0.14, 0.32, 0, 0.05, false), handL: camModule(elbowL, 0, -0.3, 0.05, Math.PI / 2, 0, 0.04), handR: camModule(elbowR, 0, -0.3, 0.05, Math.PI / 2, 0, 0.04), back: camModule(waist, 0, 0.5, -0.22, 0.2, Math.PI, 0.055) };
  g.userData = { body, waist, head, cams, armL: A.find('Shoulder_L'), armR: A.find('Shoulder_R'), legL: A.find('Hip_L'), legR: A.find('Hip_R'),
    elbowL, elbowR, kneeL: A.find('Knee_L'), kneeR: A.find('Knee_R'), visor: A.mats.VISOR, bin, acc: A.mats.ACC, blender: true };
  return g;
}
function makeCarrierAMR() {
  if (blenderOn()) return makeCarrierAMRBlender();
  const g = new THREE.Group();
  put(box(0.95, 0.3, 1.45, MAT.white), 0, 0.22, 0, g);
  put(box(0.99, 0.07, 1.49, MAT.dark), 0, 0.08, 0, g);
  const led = emis(0x2aa8ff, 2.5);
  for (const z of [-0.73, 0.73]) put(box(0.97, 0.05, 0.04, led, false), 0, 0.3, z, g);
  put(box(0.36, 0.06, 0.36, emis(0x37e8ff, 1.2), false), 0, 0.39, 0.5, g);   // 라이다
  put(cyl(0.12, 0.12, 0.48, MAT.steel), 0, 0.6, -0.05, g);                   // 리프트
  put(box(0.8, 0.06, 1.1, MAT.dark), 0, BELT_Y - 0.03, -0.05, g);              // 지그 상판
  for (const [x, z] of [[-0.36, -0.55], [0.36, -0.55], [-0.36, 0.45], [0.36, 0.45]]) put(box(0.06, 0.08, 0.06, MAT.yellow, false), x, BELT_Y + 0.02, z, g);
  g.userData = { led };
  return g;
}

// 정밀조립Zone 셀 바닥: 가운데 AMR 진입 통로(정차 위치 표시) + 양쪽 로봇 베이스 플레이트
function cellBase(g, len = 4.6) {
  put(box(len, 0.06, 4.6, MAT.dark), 0, 0.03, 0, g);
  put(box(len, 0.01, 1.5, MAT.lane), 0, 0.065, 0, g);
  for (const z of [-0.78, 0.78]) put(box(len, 0.012, 0.07, MAT.laneLine, false), 0, 0.07, z, g);
  for (const x of [-0.8, 0.8]) put(box(0.07, 0.012, 1.5, emis(0x37e8ff, 0.8), false), x, 0.072, 0, g);
}

function makeForklift() {
  if (blenderOn()) return makeForkliftBlender();
  const g = new THREE.Group();
  put(box(1.2, 0.6, 1.7, MAT.orange), 0, 0.55, -0.2, g);
  put(box(1.1, 0.5, 0.5, MAT.dark), 0, 0.55, -1.0, g);
  for (const [x, z] of [[-0.6, 0.35], [0.6, 0.35], [-0.6, -0.8], [0.6, -0.8]]) {
    const w = put(cyl(0.28, 0.28, 0.2, MAT.rubber, 14), x, 0.28, z, g); w.rotation.z = Math.PI / 2;
  }
  put(box(0.08, 2.2, 0.08, MAT.dark), -0.45, 1.25, 0.75, g);
  put(box(0.08, 2.2, 0.08, MAT.dark), 0.45, 1.25, 0.75, g);
  put(box(1.0, 0.06, 0.06, MAT.dark), 0, 2.3, 0.75, g);
  const fork = put(new THREE.Group(), 0, 0, 0, g);   // 포크 (승강)
  for (const x of [-0.3, 0.3]) put(box(0.12, 0.05, 1.1, MAT.steel), x, 0.15, 1.3, fork);
  const roof = put(box(1.2, 0.06, 1.3, MAT.dark), 0, 2.1, -0.4, g);
  for (const [x, z] of [[-0.55, 0.2], [0.55, 0.2], [-0.55, -1.0], [0.55, -1.0]]) put(box(0.05, 1.25, 0.05, MAT.dark), x, 1.45, z, g);
  const driver = makeWorker(0xf2c230); driver.scale.setScalar(0.85); put(driver, 0, 0.55, -0.4, g);
  const beacon = put(box(0.22, 0.14, 0.22, emis(0xffb020, 2.5), false), 0, 2.2, -0.4, g); beacon.visible = false;   // 자율 지게차 경광등
  const load = put(new THREE.Group(), 0, 0.2, 1.3, fork);
  put(box(1.0, 0.12, 1.1, MAT.pallet), 0, 0.06, 0, load);
  const crates = [];
  for (let k = 0; k < 6; k++) crates.push(put(box(0.42, 0.3, 0.34, MAT.raw), -0.24 + (k % 2) * 0.48, 0.28, -0.36 + Math.floor(k / 2) * 0.36, load));
  load.visible = false;
  g.userData = { led: null, load, crates, roof, driver, beacon, fork };
  return g;
}

// 트럭 적재함 바닥(1.27m) 위로 팔레트를 올리는 포크 높이 (팔레트 바닥 0.2m → 1.32m)
const TRUCK_BED_LIFT = 1.12;
// 화물트럭 (로컬 +z = 운전석 방향). 적재함은 반투명 커튼 사이더라 실린 팔레트가 보이고, 뒷문은 도크 쪽으로 열린다
const TRUCK_COLORS = [0x2a6fdb, 0xd23b3b, 0x2e9e6a, 0xf2a020, 0x6d5acf];
// Blender 화물트럭 (캡오버 + 커튼 사이더 일반형): 뒷문 경첩(Door_L/R) · 후미등(TAIL) · 실린 팔레트 자리를 3D 모델과 같게 넘긴다
function makeTruckBlender(i) {
  const A = cloneAsset('truck'), g = new THREE.Group(), L = YARD.truckLen; g.add(A.root);
  A.mats.CabPaint.color.setHex(TRUCK_COLORS[i % TRUCK_COLORS.length]);
  A.root.traverse((o) => { if (o.isMesh && o.material.name === 'Tarp') { o.material.transparent = true; o.material.depthWrite = false; o.material.side = THREE.DoubleSide; o.castShadow = false; } });
  const tail = ['Tail_L', 'Tail_R'].map((n) => A.find(n));
  const doors = ['Door_L', 'Door_R'].map((n) => A.find(n));
  const box8 = put(new THREE.Group(), 0, 0, -L / 2 + 3.9, g);
  const pallets = [0, 1, 2, 3].map((k) => {
    const pg = put(new THREE.Group(), 0, 1.27, 2.9 - k * 1.9, box8);
    put(box(1.2, 0.12, 1.6, MAT.pallet), 0, 0.06, 0, pg);
    const cartons = [];
    for (let j = 0; j < 8; j++) cartons.push(put(box(0.55, 0.45, 0.75, MAT.carton), -0.29 + (j % 2) * 0.58, 0.36 + Math.floor(j / 4) * 0.47, -0.39 + (Math.floor(j / 2) % 2) * 0.78, pg));
    pg.visible = false; return { pg, cartons };
  });
  g.userData = { doors, tail, pallets, blender: true };
  return g;
}
function makeTruck(i) {
  if (blenderOn()) return makeTruckBlender(i);
  const g = new THREE.Group(), L = YARD.truckLen, W = YARD.truckW;
  const cabMat = std(TRUCK_COLORS[i % TRUCK_COLORS.length], { roughness: 0.45, metalness: 0.3 });
  const cab = put(new THREE.Group(), 0, 0, L / 2 - 1.15, g);
  put(box(W, 2.4, 2.2, cabMat), 0, 1.75, 0, cab);
  put(box(W - 0.2, 0.9, 0.05, std(0x1a2533, { roughness: 0.2, metalness: 0.6 })), 0, 2.35, 1.12, cab);   // 앞유리
  put(box(W, 0.35, 0.3, MAT.dark), 0, 0.55, 1.05, cab);
  for (const x of [-0.85, 0.85]) put(box(0.35, 0.18, 0.05, emis(0xfff2c0, 1.6), false), x, 0.95, 1.13, cab);
  // 섀시·바퀴
  put(box(W - 0.4, 0.3, L - 0.3, MAT.dark), 0, 0.6, 0, g);
  for (const z of [L / 2 - 1.3, -L / 2 + 1.0, -L / 2 + 2.2]) for (const x of [-1.05, 1.05]) { const w = put(cyl(0.48, 0.48, 0.34, MAT.rubber, 16), x, 0.48, z, g); w.rotation.z = Math.PI / 2; }
  // 적재함 (길이 7.8m): 바닥·앞벽은 불투명, 지붕·옆면은 반투명 커튼
  const box8 = put(new THREE.Group(), 0, 0, -L / 2 + 3.9, g);
  const tarp = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.32, roughness: 0.7, depthWrite: false, side: THREE.DoubleSide });
  put(box(W, 0.14, 7.8, MAT.steel), 0, 1.2, 0, box8);
  put(box(W, 2.6, 0.1, std(0xe8ecf0)), 0, 2.55, 3.85, box8);
  for (const x of [-W / 2, W / 2]) put(mesh(new THREE.BoxGeometry(0.05, 2.6, 7.8), tarp, false), x, 2.55, 0, box8);
  put(mesh(new THREE.BoxGeometry(W, 0.05, 7.8), tarp, false), 0, 3.85, 0, box8);
  for (const z of [-3.85, -1.3, 1.3]) for (const x of [-W / 2, W / 2]) put(box(0.08, 2.6, 0.08, MAT.steel), x, 2.55, z, box8);
  put(box(W, 0.12, 0.12, MAT.yellow), 0, 1.25, -3.92, box8);   // 뒤 범퍼
  const doors = [-1, 1].map((sd) => { const d = put(new THREE.Group(), sd * W / 2, 2.55, -3.9, box8); put(box(W / 2, 2.6, 0.06, std(0xe8ecf0)), -sd * W / 4, 0, 0, d); return d; });
  const tail = [-1, 1].map((sd) => put(box(0.25, 0.14, 0.05, emis(0xff3030, 1.2), false), sd * 1.0, 1.0, -L / 2 - 0.02, g));
  // 실린 팔레트 4개 (앞쪽부터 채운다)
  const pallets = [0, 1, 2, 3].map((k) => {
    const pg = put(new THREE.Group(), 0, 1.27, 2.9 - k * 1.9, box8);
    put(box(1.2, 0.12, 1.6, MAT.pallet), 0, 0.06, 0, pg);
    const cartons = [];
    for (let j = 0; j < 8; j++) cartons.push(put(box(0.55, 0.45, 0.75, MAT.carton), -0.29 + (j % 2) * 0.58, 0.36 + Math.floor(j / 4) * 0.47, -0.39 + (Math.floor(j / 2) % 2) * 0.78, pg));
    pg.visible = false; return { pg, cartons };
  });
  g.traverse((o) => { if (o.isMesh && o.material !== tarp) o.castShadow = true; });
  g.userData = { doors, tail, pallets };
  return g;
}

// 순찰 드론 (쿼드콥터, 대각 약 1.1m): 몸체·암 4개·로터 4개·짐벌 카메라·항법등·착륙 스키드, 하방 관찰 빔
function makeDrone() {
  if (blenderOn()) return makeDroneBlender();
  const g = new THREE.Group(), body = put(new THREE.Group(), 0, 0, 0, g);
  const shell = std(0xe9edf2, { roughness: 0.35, metalness: 0.2 }), dark = MAT.dark;
  put(box(0.42, 0.14, 0.52, shell), 0, 0, 0, body);
  put(box(0.3, 0.06, 0.36, std(0x2a6fdb, { roughness: 0.4 })), 0, 0.09, 0, body);
  const rotors = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const arm = put(box(0.06, 0.04, 0.5, dark), sx * 0.2, 0.02, sz * 0.2, body); arm.rotation.y = Math.atan2(sx, sz);
    put(cyl(0.05, 0.05, 0.08, dark, 10), sx * 0.38, 0.06, sz * 0.38, body);
    const rotor = put(new THREE.Group(), sx * 0.38, 0.11, sz * 0.38, body);
    put(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.01, 24), new THREE.MeshBasicMaterial({ color: 0x9aa4ad, transparent: true, opacity: 0.35, depthWrite: false }), false), 0, 0, 0, rotor);
    put(box(0.4, 0.008, 0.03, dark, false), 0, 0.005, 0, rotor);
    rotors.push(rotor);
  }
  for (const sx of [-1, 1]) { put(box(0.02, 0.16, 0.02, dark), sx * 0.15, -0.14, 0.12, body); put(box(0.02, 0.16, 0.02, dark), sx * 0.15, -0.14, -0.12, body); put(box(0.03, 0.02, 0.4, dark), sx * 0.15, -0.22, 0, body); }
  const gimbal = put(new THREE.Group(), 0, -0.12, 0.2, body);
  put(mesh(new THREE.SphereGeometry(0.07, 14, 10), dark), 0, 0, 0, gimbal);
  put(cyl(0.03, 0.03, 0.04, emis(0x37e8ff, 2), 10), 0, 0, 0.06, gimbal).rotation.x = Math.PI / 2;
  const navR = put(mesh(new THREE.SphereGeometry(0.03, 8, 6), emis(0xff3030, 3), false), -0.38, 0.0, 0.38, body);
  const navG = put(mesh(new THREE.SphereGeometry(0.03, 8, 6), emis(0x3dff8a, 3), false), 0.38, 0.0, 0.38, body);
  const strobe = put(mesh(new THREE.SphereGeometry(0.035, 8, 6), emis(0xffffff, 0.5), false), 0, 0.13, -0.24, body);
  // 하방 관찰 빔 (순찰 점검·이벤트 확인 중에만)
  const beam = put(mesh(new THREE.ConeGeometry(1.6, 1, 28, 1, true), new THREE.MeshBasicMaterial({ color: 0x37e8ff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }), false), 0, -0.5, 0, g);
  beam.visible = false;
  g.userData = { body, rotors, beam, strobe, navR, navG };
  return g;
}

// 휴머노이드 — makeWorker와 같은 body/armL/armR 구조라 같은 걷기·작업 동작을 쓴다 (다리는 legL/legR)
function makeHumanoid(accent = 0xff8a2a) {
  if (blenderOn()) return makeHumanoidBlender(accent);
  const g = new THREE.Group();
  const shell = std(0xe6e9ee, { roughness: 0.35, metalness: 0.2 });
  const joint = std(0x2a2f36, { roughness: 0.5, metalness: 0.4 });
  const acc = std(accent, { emissive: accent, emissiveIntensity: 0.35 });
  const body = put(new THREE.Group(), 0, 0, 0, g);
  const legs = [];
  for (const x of [-0.12, 0.12]) {
    const hip = put(new THREE.Group(), x, 0.92, 0, body);
    put(mesh(new THREE.CapsuleGeometry(0.08, 0.36, 4, 8), shell), 0, -0.22, 0, hip);
    put(mesh(new THREE.SphereGeometry(0.075, 10, 8), joint), 0, -0.45, 0.01, hip);
    put(mesh(new THREE.CapsuleGeometry(0.07, 0.34, 4, 8), shell), 0, -0.67, 0, hip);
    put(box(0.13, 0.06, 0.24, joint), 0, -0.89, 0.04, hip);
    legs.push(hip);
  }
  put(box(0.34, 0.16, 0.2, joint), 0, 0.98, 0, body);                       // 골반
  const waist = put(new THREE.Group(), 0, 0, 0, body);                       // 허리 위 상체 (Atlas: 360° 회전)
  put(mesh(new THREE.CapsuleGeometry(0.19, 0.32, 4, 10), shell), 0, 1.32, 0, waist);
  put(box(0.2, 0.12, 0.03, acc, false), 0, 1.38, 0.2, waist);                 // 가슴 상태등
  put(cyl(0.05, 0.06, 0.08, joint), 0, 1.68, 0, waist);
  const head = put(new THREE.Group(), 0, 1.84, 0, waist);
  put(mesh(new THREE.SphereGeometry(0.15, 16, 12), shell), 0, 0, 0, head);
  const visor = emis(0x37e8ff, 2.2);
  put(box(0.22, 0.06, 0.06, visor, false), 0, 0.01, 0.12, head);
  const arm = (x) => {
    const sh = put(new THREE.Group(), x, 1.52, 0, waist);
    put(mesh(new THREE.SphereGeometry(0.08, 10, 8), joint), 0, 0, 0, sh);
    put(mesh(new THREE.CapsuleGeometry(0.06, 0.48, 4, 8), shell), 0, -0.3, 0, sh);
    put(box(0.08, 0.1, 0.1, joint), 0, -0.62, 0, sh);
    return sh;
  };
  const armL = arm(-0.27), armR = arm(0.27);
  const bin = put(box(0.42, 0.24, 0.32, std(0x2f6fd6)), 0, 1.0, 0.38, body);   // 부품 빈 (운반 중)
  bin.visible = false;
  const cams = { head: camModule(head, 0, 0.02, 0.14, 0.32, 0, 0.05, false), handL: camModule(armL, 0, -0.58, 0.06, Math.PI / 2, 0, 0.04), handR: camModule(armR, 0, -0.58, 0.06, Math.PI / 2, 0, 0.04), back: camModule(waist, 0, 1.42, -0.2, 0.2, Math.PI, 0.055) };
  g.userData = { body, waist, head, cams, armL, armR, legL: legs[0], legR: legs[1], visor, bin, acc };
  return g;
}

// 정비원·정비 휴머노이드가 챙겨 가는 도구 (TOOL_KITS.vis): 손에 든 공구함·진단 케이스·대걸레·빗자루·소화기, 바닥에서 미는 대걸레 버킷
function makeToolKits(g, ud) {
  const handOf = (sd) => { const el = sd > 0 ? ud.elbowR : ud.elbowL, arm = sd > 0 ? ud.armR : ud.armL; return el ? [el, -0.42] : arm?.isMesh ? [arm, -0.36] : [arm, -0.66]; };
  const [hR, yR] = handOf(1), [hL, yL] = handOf(-1);
  const red = std(0xc0392b, { roughness: 0.4 }), yel = std(0xf2b21b, { roughness: 0.45 }), gray = std(0x9aa3ad, { roughness: 0.35, metalness: 0.7 });
  const anchors = [];
  const kit = (parts) => { const k = new THREE.Group(); k.visible = false; parts(k); anchors.push(k.parent); return k; };
  const kits = {
    toolbox: kit((k) => { const a = put(new THREE.Group(), 0, yR - 0.2, 0, hR); a.add(k); put(box(0.42, 0.2, 0.2, red), 0, 0, 0, k); put(box(0.26, 0.04, 0.04, MAT.dark), 0, 0.13, 0, k); }),
    diag: kit((k) => { const a = put(new THREE.Group(), 0, yR - 0.17, 0, hR); a.add(k); put(box(0.32, 0.22, 0.1, yel), 0, 0, 0, k); put(box(0.18, 0.08, 0.012, MAT.dark), 0, 0.03, 0.056, k); }),
    mop: kit((k) => { const a = put(new THREE.Group(), 0, yR, 0, hR); a.add(k); put(cyl(0.014, 0.014, 1.3, gray, 10), 0, -0.35, 0.05, k); put(cyl(0.09, 0.09, 0.14, std(0xe6e3dc), 14), 0, -1.0, 0.05, k); }),
    broom: kit((k) => { const a = put(new THREE.Group(), 0, yR, 0, hR); a.add(k); put(cyl(0.012, 0.012, 1.2, std(0x2e9e6a), 10), 0, -0.3, 0.05, k); put(box(0.32, 0.12, 0.06, MAT.dark), 0, -0.92, 0.05, k); }),
    extinguisher: kit((k) => { const a = put(new THREE.Group(), 0, yR - 0.3, 0, hR); a.add(k); put(cyl(0.085, 0.085, 0.5, red, 16), 0, 0, 0, k); put(cyl(0.03, 0.03, 0.08, MAT.dark, 10), 0, 0.29, 0, k); }),
  };
  // 대걸레 버킷(바퀴): 몸 앞 바닥에서 밀고 간다 · 빗자루를 들면 다른 손에 쓰레받기
  const bucket = put(new THREE.Group(), 0.25, 0, 0.55, g); bucket.visible = false;
  put(box(0.42, 0.3, 0.32, yel), 0, 0.2, 0, bucket); put(box(0.2, 0.14, 0.28, MAT.dark), 0.12, 0.42, 0, bucket);
  const pan = put(new THREE.Group(), 0, yL - 0.12, 0, hL); pan.visible = false;
  put(box(0.26, 0.03, 0.24, std(0x2a6fdb)), 0, 0, 0.08, pan);
  const panA = pan; anchors.push(panA);
  return { kits, extra: { mop: bucket, broom: pan }, anchors };
}

// 휴머노이드 충전 도크: 대기 자리에 등을 대고 서면 등 배터리 팩 높이의 접점 암으로 충전 (로컬 +z = 로봇이 보는 쪽)
function makeHumanoidDock() {
  const g = new THREE.Group();
  put(box(0.95, 0.06, 0.95, std(0x2c3138, { roughness: 0.6 })), 0, 0.03, 0, g);
  put(box(0.95, 0.065, 0.08, MAT.yellow), 0, 0.033, 0.44, g);
  for (const x of [-0.12, 0.12]) put(box(0.1, 0.012, 0.16, std(0xc8743a, { metalness: 0.8, roughness: 0.3 })), x, 0.066, 0.02, g);   // 발 접점
  put(box(0.5, 1.75, 0.18, std(0xdfe3e8, { roughness: 0.45 })), 0, 0.875, -0.43, g);       // 충전 기둥
  put(box(0.54, 0.06, 0.22, std(0x2c3138)), 0, 1.78, -0.43, g);
  put(box(0.3, 0.12, 0.16, std(0x2c3138)), 0, 1.33, -0.3, g);                               // 접점 암 (등 배터리 팩 높이)
  put(box(0.24, 0.1, 0.02, std(0xc8743a, { metalness: 0.8, roughness: 0.3 })), 0, 1.33, -0.215, g);
  const led = emis(0x2aa8ff, 1.2);
  for (const x of [-0.2, 0.2]) put(box(0.04, 1.2, 0.02, led, false), x, 0.95, -0.333, g);
  const scr = emis(0x2aa8ff, 0.8); put(box(0.22, 0.12, 0.012, scr, false), 0, 1.6, -0.334, g);
  g.userData = { led, scr };
  return g;
}

// 사족보행 로봇 — 등 위 센서 마스트(열화상·음향 카메라)로 순찰 점검
// Blender 사족보행 (Spot 분위기의 독자 디자인): 관절 빈 객체(Body · Hip_i · Knee_i · Cam)를 3D 모델과 같은 이름·순서로 넘긴다
function makeQuadrupedBlender() {
  const A = cloneAsset('quadruped'), g = new THREE.Group(); g.add(A.root);
  const legs = [0, 1, 2, 3].map((i) => ({ hip: A.find(`Hip_${i}`), knee: A.find(`Knee_${i}`) }));
  const cam = A.find('Cam');
  const scanMat = new THREE.MeshBasicMaterial({ color: 0xff7a3d, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beam = put(new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.6, 18, 1, true), scanMat), 0, 0, 1.4, cam);
  beam.rotation.x = -Math.PI / 2; beam.visible = false;
  g.userData = { body: A.find('Body'), legs, cam, beam, blender: true };
  return g;
}
function makeQuadruped() {
  if (blenderOn()) return makeQuadrupedBlender();
  const g = new THREE.Group();
  const shell = std(0xf2c230, { roughness: 0.45 });
  const dark = std(0x23272c, { roughness: 0.5, metalness: 0.4 });
  const body = put(new THREE.Group(), 0, 0.55, 0, g);
  put(box(0.36, 0.2, 0.9, shell), 0, 0, 0, body);
  put(box(0.3, 0.12, 0.2, dark), 0, 0.02, 0.5, body);
  put(box(0.2, 0.04, 0.03, emis(0x37e8ff, 2), false), 0, 0.04, 0.6, body);
  put(cyl(0.025, 0.025, 0.35, dark, 8), 0.08, 0.27, -0.2, body);
  const cam = put(new THREE.Group(), 0.08, 0.47, -0.2, body);
  put(box(0.16, 0.12, 0.14, dark), 0, 0, 0, cam);
  put(cyl(0.035, 0.035, 0.05, emis(0xff6a3d, 2), 10), 0, 0, 0.08, cam).rotation.x = Math.PI / 2;
  const legs = [];
  for (const [x, z] of [[-0.21, 0.36], [0.21, 0.36], [-0.21, -0.36], [0.21, -0.36]]) {
    const hip = put(new THREE.Group(), x, -0.05, z, body);
    put(box(0.07, 0.28, 0.07, dark), 0, -0.13, 0, hip);
    const knee = put(new THREE.Group(), 0, -0.27, 0, hip);
    put(box(0.05, 0.26, 0.05, dark), 0, -0.12, 0, knee);
    put(mesh(new THREE.SphereGeometry(0.04, 8, 6), MAT.rubber), 0, -0.25, 0, knee);
    legs.push({ hip, knee });
  }
  const scanMat = new THREE.MeshBasicMaterial({ color: 0xff7a3d, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beam = put(new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.6, 18, 1, true), scanMat), 0, 0, 1.4, cam);
  beam.rotation.x = -Math.PI / 2;
  beam.visible = false;
  g.userData = { body, legs, cam, beam };
  return g;
}

function makeMaintBot() {
  const g = new THREE.Group();
  put(box(0.9, 0.4, 1.0, MAT.white), 0, 0.3, 0, g);
  put(box(0.94, 0.1, 1.04, MAT.orange), 0, 0.12, 0, g);
  const arm = makeArm(MAT.orange, 0.45); put(arm.root, 0, 0.5, 0.15, g);
  const beacon = emis(0xff9b2a, 3);
  put(mesh(new THREE.SphereGeometry(0.08, 10, 8), beacon, false), -0.3, 0.6, -0.35, g);
  g.userData = { arm, beacon };
  return g;
}

// ── 경보 표시 (설비 고장·공급 차질·현장 이벤트): 바닥 테두리 + 경광등 + 빛기둥, 깜빡임은 update에서 ─────────────────
export function makeAlarmFx(w, d, h = 4.2) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
  const t = 0.16;
  for (const [x, z, sx, sz] of [[0, -d / 2, w, t], [0, d / 2, w, t], [-w / 2, 0, t, d], [w / 2, 0, t, d]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), mat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.03, z); g.add(m);
  }
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false }));
  fill.rotation.x = -Math.PI / 2; fill.position.y = 0.025; g.add(fill);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), mat); beacon.position.y = h + 0.6; g.add(beacon);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.45, h, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
  beam.position.y = h / 2; g.add(beam);
  g.userData = { mats: [mat, fill.material, beam.material], base: [0.9, 0.12, 0.18], beacon };
  g.visible = false;
  return g;
}
// color: 경보 색, t: 시간 — 0.9초 주기로 깜빡인다 (동작 줄이기 설정이면 고정 표시)
const REDUCED_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function blinkAlarmFx(g, on, color, t) {
  g.visible = on; if (!on) return;
  const k = REDUCED_MOTION ? 1 : 0.35 + 0.65 * (Math.sin(t * Math.PI * 2 / 0.9) > 0 ? 1 : 0.15);
  g.userData.mats.forEach((m, i) => { m.color.setHex(color); m.opacity = g.userData.base[i] * k; });
  g.userData.beacon.scale.setScalar(REDUCED_MOTION ? 1 : 0.85 + 0.3 * k);
}
// 설비·벽에 가려지지 않는 경고 표지 (Sprite)
export function makeSignSprite(text, hex, width = 6) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(12,14,18,0.88)'; x.beginPath(); x.roundRect(4, 4, 632, 120, 26); x.fill();
  x.lineWidth = 8; x.strokeStyle = hex; x.stroke();
  x.fillStyle = hex; x.font = '800 54px "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 320, 68);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
  sp.scale.set(width, width / 5, 1); sp.renderOrder = 10;
  return sp;
}
// 로봇 고유 ID 명판 (작은 스프라이트)
function idPlate(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 72;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(10,12,16,0.88)'; x.beginPath(); x.roundRect(2, 2, 252, 68, 14); x.fill();
  x.lineWidth = 4; x.strokeStyle = '#ffb020'; x.stroke();
  x.fillStyle = '#ffb020'; x.font = '800 40px Menlo, "SF Mono", Consolas, monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 128, 38);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false }));
  sp.scale.set(0.78, 0.22, 1); return sp;
}
export const ALARM_COLOR = { fault: 0xff3030, supply: 0xff8a1f, event: 0xffc21f };

// ── 공정 설비 ─────────────────────────────
function stationBase(g, len = 4.2, depth = 3.6) {
  put(box(len, 0.15, depth, MAT.dark), 0, 0.075, 0, g);
  const beltMat = new THREE.MeshStandardMaterial({ map: BELT_TEX.clone(), roughness: 0.8 });
  beltMat.map.repeat.set(len / 0.5, 1);
  put(box(len, BELT_Y - 0.15, 1.2, [MAT.steel, MAT.steel, beltMat, MAT.steel, MAT.steel, MAT.steel]), 0, 0.15 + (BELT_Y - 0.15) / 2, 0, g);
  return beltMat;
}

function buildCNC(g) {
  const parts = {};
  put(box(4.2, 0.5, 3.3, MAT.white), 0, 0.4, -0.05, g);
  put(box(4.2, 2.6, 0.12, MAT.white), 0, 1.45, -1.65, g);
  put(box(0.12, 1.5, 3.3, MAT.white), -2.04, 2.0, -0.05, g);
  put(box(0.12, 1.5, 3.3, MAT.white), 2.04, 2.0, -0.05, g);
  put(box(4.24, 0.14, 3.34, MAT.accent), 0, 2.8, -0.05, g);
  put(box(4.2, 1.5, 0.05, MAT.glass, false), 0, 2.0, 1.6, g);
  put(box(4.22, 0.12, 0.12, MAT.accent), 0, 1.2, 1.6, g);
  const head = put(new THREE.Group(), 0, 2.2, 0, g);
  put(box(0.7, 0.7, 0.7, MAT.dark), 0, 0.15, 0, head);
  const spindle = put(cyl(0.12, 0.12, 0.4, MAT.steel), 0, -0.4, 0, head);
  put(cyl(0.03, 0.05, 0.3, MAT.machined), 0, -0.35, 0, spindle);
  const panel = put(box(0.6, 1.0, 0.25, MAT.dark), 2.5, 1.2, 1.3, g);
  const scr = emis(0x58c4ff, 1.2);
  put(box(0.45, 0.32, 0.02, scr, false), 0, 0.2, 0.14, panel);
  parts.head = head; parts.spindle = spindle; parts.screen = scr;
  parts.sparks = put(makeSparks(0xfff1c4, 30, 0.05), 0, 0, 0, g);
  return parts;
}

// ── 로봇 (종류별 모델 + 공통 애니메이션 인터페이스) ─────────────────
const COBOT_MAT = std(0xb9c1ca, { roughness: 0.5 });
const COBOT_JOINT = std(0x2a7fff, { roughness: 0.35 });

function makeRobot(kind, color, opts = {}) {
  if (kind === 'articulated' || kind === 'cobot') {
    const cobot = kind === 'cobot';
    const arm = makeArm(cobot ? COBOT_MAT : color, cobot ? 0.72 : 1);
    if (cobot) put(cyl(0.13, 0.13, 0.08, COBOT_JOINT), 0, 0.18, 0, arm.turret);
    const speed = cobot ? 1.4 : 2.2;
    return {
      root: arm.root, kind, tip: arm.tip, jointDefs: ARM_JOINTS, joints: arm.joints, payload: cobot ? 5 : 20, arm, scale: cobot ? 0.72 : 1,
      anim(busy, t) {
        if (busy) {
          const w = t * speed;
          arm.pose(Math.sin(w) * 0.35, 0.7 + Math.sin(w * 1.3) * 0.12, 1.25 + Math.cos(w) * 0.1, 0.75, Math.sin(w * 0.9) * 0.3, Math.sin(w * 0.6) * 1.6);
        } else arm.pose(0, 0.25, 0.9, 0.5, 0, 0);
      },
    };
  }
  if (kind === 'ammr') {
    // AMR 기반 양팔 로봇: 이동 플랫폼(바퀴·라이다) + 승강 몸통 + 양팔(각 6축) + 머리 카메라. 로컬 +z가 작업 쪽(통로)
    const root = new THREE.Group();
    let led, bin, lift, head;
    if (blenderOn()) {   // Blender AMMR (RB-Y1 분위기의 독자 디자인): 이동 베이스 · 몸통 기둥 · 가슴 · 카메라 머리. 팔은 아래에서 6축 팔(Blender 마디)로 단다
      const A = cloneAsset('ammr'); root.add(A.root);
      led = A.mats.LED; lift = A.find('Lift'); head = A.find('Head');
      bin = put(box(0.36, 0.18, 0.26, std(0x2f6fd6)), 0, 0.44, -0.2, root); bin.visible = false;   // 선반에서 가져오는 부품 빈
    } else {
      put(box(0.82, 0.3, 0.64, MAT.white), 0, 0.2, 0, root);
      put(box(0.86, 0.07, 0.68, MAT.dark), 0, 0.06, 0, root);
      for (const [x, z] of [[-0.34, 0.24], [0.34, 0.24], [-0.34, -0.24], [0.34, -0.24]]) put(cyl(0.08, 0.08, 0.06, MAT.rubber, 12), x, 0.07, z, root).rotation.z = Math.PI / 2;
      led = emis(0x2aa8ff, 2.2);
      put(box(0.84, 0.04, 0.03, led, false), 0, 0.3, 0.33, root);
      put(cyl(0.07, 0.07, 0.06, MAT.dark, 14), 0, 0.38, 0.24, root);                          // 라이다
      bin = put(box(0.36, 0.18, 0.26, std(0x2f6fd6)), 0, 0.44, -0.2, root); bin.visible = false;   // 선반에서 가져오는 부품 빈
      lift = put(new THREE.Group(), 0, 0.35, -0.05, root);
      put(box(0.2, 0.62, 0.2, MAT.steel), 0, 0.31, 0, lift);
      put(box(0.5, 0.3, 0.3, COBOT_MAT), 0, 0.72, 0, lift);                                    // 가슴
      put(box(0.52, 0.05, 0.31, MAT.orange), 0, 0.6, 0, lift);
      head = put(new THREE.Group(), 0, 0.98, 0.02, lift);
      put(box(0.2, 0.16, 0.18, MAT.dark), 0, 0, 0, head);
      put(box(0.16, 0.05, 0.02, emis(0x37e8ff, 2), false), 0, 0.01, 0.1, head);                 // 스테레오 카메라
    }
    const arms = [-1, 1].map((sd) => {
      const a = makeArm(COBOT_MAT, 0.46);
      put(a.root, sd * 0.33, 0.7, 0, lift); a.root.rotation.z = -sd * 0.35;                   // 어깨에서 바깥쪽으로 약간 기울여 장착
      put(cyl(0.06, 0.06, 0.05, COBOT_JOINT), 0, 0.09, 0, a.turret);
      return a;
    });
    const sideNames = ['왼팔', '오른팔'];
    // 카메라 4대: 머리 스테레오(작업대를 내려다봄) · 양손 손목(그리퍼 방향) · 등(몸통 뒤 — 선반·통로 쪽)
    const cams = { head: camModule(head, 0, 0.01, 0.11, 0.6, 0, 0.05, false), handL: camModule(arms[0].tip, 0.045, -0.02, 0, -Math.PI / 2, 0, 0.035), handR: camModule(arms[1].tip, 0.045, -0.02, 0, -Math.PI / 2, 0, 0.035), back: camModule(lift, 0, 0.8, -0.16, 0.25, Math.PI, 0.05) };
    return {
      root, kind, tip: arms[0].tip, tip2: arms[1].tip, head, bin, payload: 10, dual: true, arms, lift, cams,
      jointDefs: [{ name: '몸통 승강', unit: 'mm', min: 0, max: 0.12 },
        ...sideNames.flatMap((n) => ARM_JOINTS.map((j) => ({ ...j, name: `${n} ${j.name}` })))],
      joints: () => [lift.position.y - 0.35, ...arms[0].joints(), ...arms[1].joints()],
      // 작업 ↔ 대기 전환 때 자세가 튀지 않도록 목표 자세로 부드럽게 따라간다 (관절 속도·토크 값도 자연스러워짐)
      cur: null,
      anim(busy, t) {
        const w = t * 1.5;
        const target = [busy ? 0.06 + Math.sin(w * 0.5) * 0.04 : 0, busy ? Math.sin(w * 0.7) * 0.35 : 0];
        arms.forEach((a, i) => {
          const ph = w + i * Math.PI * 0.5, sd = i ? -1 : 1;   // 두 팔이 엇갈려 집고 놓는다
          target.push(...(busy ? [sd * (0.3 + Math.sin(ph) * 0.25), 0.8 + Math.sin(ph * 1.3) * 0.15, 1.2 + Math.cos(ph) * 0.12, 0.7, Math.sin(ph * 0.9) * 0.3, Math.sin(ph * 0.6) * 1.4]
            : [sd * 0.2, 0.3, 1.0, 0.5, 0, 0]));
        });
        this.cur = this.cur ? this.cur.map((c, i) => c + (target[i] - c) * 0.12) : target;
        const c = this.cur;
        lift.position.y = 0.35 + c[0];
        head.rotation.y = c[1];
        arms.forEach((a, i) => a.pose(...c.slice(2 + i * 6, 8 + i * 6)));
        led.emissive.setHex(busy ? 0x3ddc84 : 0x2aa8ff);
      },
    };
  }
  if (kind === 'scara') {
    const root = new THREE.Group();
    put(cyl(0.22, 0.28, 2.1, MAT.dark), 0, 1.05, 0, root);   // 퀼 하단이 AMR 위 대상물(약 1.3m) 위에서 멈추는 높이
    const l1 = put(new THREE.Group(), 0, 2.15, 0, root);
    put(box(0.26, 0.2, 0.9, color), 0, 0, 0.45, l1);
    const l2 = put(new THREE.Group(), 0, 0, 0.9, l1);
    put(cyl(0.14, 0.14, 0.24, MAT.dark), 0, 0, 0, l2);
    put(box(0.22, 0.16, 0.75, color), 0, 0.02, 0.37, l2);
    const quill = put(cyl(0.04, 0.04, 0.8, MAT.steel), 0, -0.2, 0.72, l2);
    put(box(0.12, 0.03, 0.03, MAT.dark), 0, -0.4, 0, quill);   // 흡착 패드 (J4 회전이 보이도록)
    const tip = put(new THREE.Object3D(), 0, -0.42, 0, quill);
    return {
      root, kind, tip, payload: 3,
      jointDefs: [
        { name: 'J1 제1 링크', unit: 'deg', min: -130 * DEG, max: 130 * DEG },
        { name: 'J2 제2 링크', unit: 'deg', min: -145 * DEG, max: 145 * DEG },
        { name: 'J3 상하 스트로크', unit: 'mm', min: 0, max: 0.3 },
        { name: 'J4 회전', unit: 'deg', min: -360 * DEG, max: 360 * DEG },
      ],
      joints: () => [l1.rotation.y, l2.rotation.y, -0.2 - quill.position.y, quill.rotation.y],
      anim(busy, t) {
        const w = t * 3;
        l1.rotation.y = busy ? Math.sin(w) * 0.5 : 0;
        l2.rotation.y = busy ? -Math.sin(w * 1.2) * 0.8 : 0.3;
        quill.position.y = busy ? -0.2 - Math.max(0, Math.sin(w * 2)) * 0.25 : -0.2;
        quill.rotation.y = busy ? Math.sin(w * 0.7) * 1.4 : 0;
      },
    };
  }
  if (kind === 'humanoid') {
    // 휴머노이드 로봇: 두 다리로 셀 작업 위치에 서서 허리를 돌리며 양팔(각 6축)로 작업. 머리에 스테레오 카메라. 로컬 +z가 작업 쪽
    const root = new THREE.Group();
    const jm = std(0x2a2f36, { roughness: 0.5, metalness: 0.4 });
    let legs, torso, head;
    if (blenderOn()) {   // Blender 휴머노이드 몸체(다리·허리·머리 관절)에 셀 작업용 6축 양팔을 단다
      const A = cloneAsset('humanoid'); root.add(A.root);
      legs = [A.find('Hip_L'), A.find('Hip_R')]; torso = A.find('Waist'); head = A.find('Head');
      A.find('Shoulder_L').visible = false; A.find('Shoulder_R').visible = false;
    } else {
      const shell = std(0xe6e9ee, { roughness: 0.35, metalness: 0.2 });
      legs = [-0.12, 0.12].map((x) => {
        const hip = put(new THREE.Group(), x, 0.92, 0, root);
        put(mesh(new THREE.CapsuleGeometry(0.08, 0.36, 4, 8), shell), 0, -0.22, 0, hip);
        put(mesh(new THREE.SphereGeometry(0.075, 10, 8), jm), 0, -0.45, 0.01, hip);
        put(mesh(new THREE.CapsuleGeometry(0.07, 0.34, 4, 8), shell), 0, -0.67, 0, hip);
        put(box(0.13, 0.06, 0.24, jm), 0, -0.89, 0.04, hip);
        return hip;
      });
      put(box(0.34, 0.16, 0.2, jm), 0, 0.98, 0, root);                                       // 골반
      torso = put(new THREE.Group(), 0, 1.0, 0, root);                                  // 허리 회전
      put(mesh(new THREE.CapsuleGeometry(0.19, 0.3, 4, 10), shell), 0, 0.3, 0, torso);
      const led = emis(0xff8a2a, 1.6); put(box(0.2, 0.1, 0.03, led, false), 0, 0.36, 0.2, torso);   // 가슴 상태등
      put(cyl(0.05, 0.06, 0.08, jm), 0, 0.64, 0, torso);
      head = put(new THREE.Group(), 0, 0.8, 0, torso);
      put(mesh(new THREE.SphereGeometry(0.15, 16, 12), shell), 0, 0, 0, head);
      put(box(0.22, 0.06, 0.06, emis(0x37e8ff, 2.2), false), 0, 0.01, 0.12, head);             // 스테레오 카메라 (바이저)
    }
    const arms = [-1, 1].map((sd) => {
      put(mesh(new THREE.SphereGeometry(0.085, 10, 8), jm), sd * 0.25, 0.52, 0, torso);       // 어깨
      const a = makeArm(COBOT_MAT, 0.42);
      put(a.root, sd * 0.3, 0.5, 0.06, torso); a.root.rotation.set(1.35, 0, -sd * 0.2);    // 어깨에서 앞쪽(작업대)으로 뻗도록 장착
      return a;
    });
    const sideNames = ['왼팔', '오른팔'];
    const backZ = blenderOn() ? -0.22 : -0.2, backY = blenderOn() ? 0.5 : 0.42;
    const cams = { head: camModule(head, 0, 0.02, 0.14, 0.45, 0, 0.05, false), handL: camModule(arms[0].tip, 0.045, -0.02, 0, -Math.PI / 2, 0, 0.035), handR: camModule(arms[1].tip, 0.045, -0.02, 0, -Math.PI / 2, 0, 0.035), back: camModule(torso, 0, backY, backZ, 0.2, Math.PI, 0.055) };
    return {
      root, kind, tip: arms[0].tip, tip2: arms[1].tip, head, payload: 15, dual: true, arms, torso, legs, cams,
      // Atlas형: 허리 360° 연속 회전 · 머리 좌우 180°(±90°)
      jointDefs: [{ name: '허리 회전', unit: 'rad', min: -Math.PI, max: Math.PI }, { name: '머리 회전', unit: 'rad', min: -Math.PI / 2, max: Math.PI / 2 },
        ...sideNames.flatMap((n) => ARM_JOINTS.map((j) => ({ ...j, name: `${n} ${j.name}` })))],
      joints: () => [Math.atan2(Math.sin(torso.rotation.y), Math.cos(torso.rotation.y)), head.rotation.y, ...arms[0].joints(), ...arms[1].joints()],
      cur: null,
      anim(busy, t) {
        const w = t * 1.4;
        // 작업 사이클마다 허리를 옆 부품 쪽으로 크게 돌려(약 100°) 머리 카메라로 부품을 확인하고 돌아온다 — 발은 그대로
        const turn = busy ? Math.max(0, Math.sin(w * 0.22)) ** 6 * 1.75 : 0;
        const target = [busy ? Math.sin(w * 0.45) * 0.28 + turn : 0, busy ? Math.sin(w * 0.7) * 0.25 : 0];
        arms.forEach((a, i) => {
          const ph = w + i * Math.PI * 0.5, sd = i ? -1 : 1;   // 두 팔이 엇갈려 집고 놓는다
          target.push(...(busy ? [sd * (0.25 + Math.sin(ph) * 0.22), 0.85 + Math.sin(ph * 1.3) * 0.15, 1.25 + Math.cos(ph) * 0.12, 0.7, Math.sin(ph * 0.9) * 0.3, Math.sin(ph * 0.6) * 1.4]
            : [sd * 0.1, 0.2, 0.9, 0.4, 0, 0]));
        });
        this.cur = this.cur ? this.cur.map((c, i) => c + (target[i] - c) * 0.12) : target;
        const c = this.cur;
        torso.rotation.y = c[0]; head.rotation.y = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, c[1] - c[0] * 0.3));
        arms[0].pose(...c.slice(2, 8)); arms[1].pose(...c.slice(8, 14));
        // 작업 중에는 무게중심을 옮기며 다리를 살짝 굽혔다 편다
        const k = busy ? Math.sin(w * 0.9) * 0.05 : 0;
        legs.forEach((h, j) => { h.rotation.x = (j ? -k : k); });
      },
    };
  }
  if (kind === 'gantry') {
    // 직교 3축 갠트리: 양쪽 X축 레일(고정 프레임) 위를 브리지가 주행(X) → 브리지 위 캐리지가 가로 이송(Y) → 수직 축 승강(Z)
    const root = new THREE.Group(), xr = opts.xr ?? 1.0, L = 2 * xr + 0.7;
    let bridge, car, rod;
    if (blenderOn()) {   // Blender 갠트리 (산업용 일반형): 기둥·X축 빔은 셀 길이에 맞춰 복제·늘리고, 브리지·캐리지·승강축은 3D 모델과 같은 그룹에 붙인다
      const A = cloneAsset('gantry'), part = (n) => A.find(n);
      if (color?.color) A.mats.GantryAcc.color.copy(color.color);
      for (const z of [-1.6, 1.6]) {
        for (const x of [-L / 2, L / 2]) { const p = part('Post').clone(); p.position.set(x, 0, z); root.add(p); }
        const xb = part('XBeam').clone(); xb.position.set(0, 0, z); xb.scale.x = L + 0.14; root.add(xb);
      }
      bridge = put(new THREE.Group(), 0, 0, 0, root); bridge.add(part('Bridge'));
      car = put(new THREE.Group(), 0, 2.7, 0, bridge); car.add(part('Carriage'));
      rod = put(new THREE.Group(), 0, -0.6, 0, car); rod.add(part('ZAxis'));
    } else {
      for (const z of [-1.6, 1.6]) {
        for (const x of [-L / 2, L / 2]) put(box(0.14, 2.6, 0.14, MAT.yellow), x, 1.3, z, root);   // 기둥 4개
        put(box(L + 0.14, 0.16, 0.16, MAT.yellow), 0, 2.68, z, root);                                // X축 레일
        put(box(L, 0.03, 0.05, MAT.steel), 0, 2.78, z, root);                                        // 리니어 가이드
      }
      bridge = put(new THREE.Group(), 0, 0, 0, root);                                          // X축 주행 브리지
      put(box(0.22, 0.2, 3.4, MAT.yellow), 0, 2.86, 0, bridge);
      for (const z of [-1.6, 1.6]) put(box(0.34, 0.16, 0.26, MAT.dark), 0, 2.86, z, bridge);          // 레일 위 주행 블록
      car = put(new THREE.Group(), 0, 2.7, 0, bridge);                                         // Y축 캐리지
      put(box(0.36, 0.26, 0.36, color), 0, 0, 0, car);
      rod = put(box(0.08, 1.0, 0.08, MAT.steel), 0, -0.6, 0, car);                             // Z축
      put(box(0.34, 0.06, 0.26, MAT.dark), 0, -0.5, 0, rod);
    }
    const tip = put(new THREE.Object3D(), 0, -0.53, 0, rod);
    // 집기 → 들어 올림 → X·Y 이동 → 내려놓기 → 복귀 (키프레임: [진행, X, Y, Z 하강])
    const K = [[0, -1, -0.8, 0], [0.12, -1, -0.8, 1], [0.22, -1, -0.8, 1], [0.32, -1, -0.8, 0], [0.55, 0.55, 0.7, 0], [0.65, 0.55, 0.7, 1], [0.73, 0.55, 0.7, 1], [0.82, 0.55, 0.7, 0], [1, -1, -0.8, 0]];
    const ease = (f) => f * f * (3 - 2 * f);
    return {
      root, kind, tip, payload: 30,
      jointDefs: [
        { name: 'X축 주행', unit: 'mm', min: -xr, max: xr },
        { name: 'Y축 이송', unit: 'mm', min: -1.2, max: 1.2 },
        { name: 'Z축 승강', unit: 'mm', min: 0, max: 0.5 },
      ],
      joints: () => [bridge.position.x, car.position.z, -0.6 - rod.position.y],
      anim(busy, t) {
        let x = 0, y = 0, zd = 0;
        if (busy) {
          const u = (t * 0.28) % 1, k = K.findIndex((q) => q[0] >= u), a = K[Math.max(0, k - 1)], b = K[k];
          const f = ease(b[0] > a[0] ? (u - a[0]) / (b[0] - a[0]) : 1);
          x = (a[1] + (b[1] - a[1]) * f) * xr; y = a[2] + (b[2] - a[2]) * f; zd = a[3] + (b[3] - a[3]) * f;
        }
        bridge.position.x += (x - bridge.position.x) * 0.25;
        car.position.z += (y - car.position.z) * 0.25;
        rod.position.y += (-0.6 - zd * 0.45 - rod.position.y) * 0.3;
      },
    };
  }
  return null;
}

// ── 조립·체결 부품 (Blender 실물 형상 assets/blender/parts.glb) — 셀별 부품 빈·피더·로봇 그리퍼에 놓는다
const CELL_PARTS = {
  DT_ASSY: ['P_CupHolder', 'P_Armrest', 'P_Grille', 'P_Switch'],   // 도어트림 조립: 컵홀더 · 암레스트 · 스피커 그릴 · 윈도 스위치
  EA_ASSY: ['P_Gear', 'P_Shaft', 'P_Bearing', 'P_Seal'],            // e-axle 조립: 헬리컬 기어 · 샤프트 · 베어링 · 오일씰
  DT_FAST: ['P_Screw', 'P_Clip', 'P_Washer', 'P_Nut'],              // 도어트림 체결: 나사 · 트림 클립 · 와셔 · 너트
  EA_FAST: ['P_Bolt', 'P_Nut', 'P_Washer', 'P_Screw'],              // e-axle 체결: 플랜지 볼트 · 너트 · 와셔 · 나사
};
const SMALL_PART = new Set(['P_Screw', 'P_Bolt', 'P_Nut', 'P_Washer', 'P_Clip']);
const cellParts = (st) => (blenderOn() && RENDER.assets.parts ? CELL_PARTS[st?.id] ?? null : null);
function partClone(name) { const src = RENDER.assets.parts?.getObjectByName(name); if (!src) return null; const o = src.clone(); o.position.set(0, 0, 0); return o; }
// 부품 더미: w × d 면적 위에 부품 여러 개 (작은 체결 부품은 6개, 큰 부품은 2개) — 바닥 = 0
function partPile(name, w, d, seed = 0) {
  const g = new THREE.Group(), n = SMALL_PART.has(name) ? 6 : 2, cols = n > 2 ? 3 : 2, rows = Math.ceil(n / cols);
  for (let k = 0; k < n; k++) {
    const o = partClone(name); if (!o) break;
    const cx = cols > 1 ? ((k % cols) / (cols - 1) - 0.5) * w * 0.55 : 0, cz = rows > 1 ? (Math.floor(k / cols) / (rows - 1) - 0.5) * d * 0.5 : 0;
    o.position.set(cx, 0, cz); o.rotation.y = ((k * 2.39 + seed * 1.7) % (Math.PI * 2));
    if (SMALL_PART.has(name) && name !== 'P_Washer' && name !== 'P_Nut' && (k + seed) % 2) { o.rotation.z = Math.PI / 2; o.position.y = 0.012; }   // 나사·볼트 일부는 눕혀서
    g.add(o);
  }
  return g;
}
// 색 부품 빈(상자 메시) 위에 그 빈의 부품을 담는다
function fillBins(bins, names) {
  if (!names) return;
  bins.forEach((b, k) => {
    const pr = b.geometry?.parameters; if (!pr) return;
    const pile = partPile(names[k % names.length], pr.width, pr.depth, k);
    pile.position.set(0, pr.height / 2 - 0.002, 0); b.add(pile);   // 빈의 자식 — 빈이 숨으면(부품 소진) 같이 숨는다
  });
}

// 공정 테이블 둘레에 로봇 배치 — 뒤/앞 교대로, 갠트리는 라인 방향으로 나란히
function placeRobots(g, st) {
  const group = new THREE.Group(); g.add(group);
  const robots = [];
  const { kind, count } = st.def.robot ?? { kind: 'none', count: 0 };
  if (!count || kind === 'none') return { group, robots };
  const color = st.type === 'paint' ? MAT.white : MAT.orange;
  const zr = st.type === 'paint' ? 1.4 : 1.7;
  // 정밀조립Zone: AMR 통로를 사이에 두고 양쪽에서 마주 보는 배치
  // 피지컬AI VLA: 6축 로봇은 대상물에 손이 닿도록 통로 쪽으로 조금 더 다가선다 (AMR 통과 폭은 유지)
  const vla = st.vla && (kind === 'cobot' || kind === 'articulated');
  const zz = vla ? 1.4 : 1.75;
  const slots = st.zone ? [[-0.75, -zz, 0], [-0.75, zz, Math.PI], [0.95, -zz, 0], [0.95, zz, Math.PI]]
    : [[-0.6, -zr, 0], [0.6, zr, Math.PI], [1.3, -zr, 0], [-1.3, zr, Math.PI]];
  // 갠트리는 대수만큼 셀 길이를 나눠 X축 주행 범위를 정한다 (1대: ±1.0m)
  const gx = count === 1 ? 1.0 : Math.max(0.3, 1.2 / (count - 1) - 0.25);
  for (let i = 0; i < count; i++) {
    const r = makeRobot(kind, color, kind === 'gantry' ? { xr: gx } : {});
    if (kind === 'gantry') put(r.root, count === 1 ? 0 : -1.2 + (2.4 * i) / (count - 1), 0.15, 0, group);
    else {
      const [x, z, yaw] = slots[i];
      // AMMR은 이동 플랫폼 깊이(0.64m)만큼 통로에서 조금 더 떨어져 도킹한다
      put(r.root, x, kind === 'ammr' ? 0.06 : 0.15, kind === 'ammr' ? Math.sign(z) * AMMR.slotZ : z, group); r.root.rotation.y = yaw;
      r.slot = { x, z: kind === 'ammr' ? Math.sign(z) * AMMR.slotZ : z, yaw, side: Math.sign(z) };
    }
    r.phase = i * 1.3;
    r.root.traverse((o) => { o.userData.robotIdx = i; });
    robots.push(r);
  }
  // AMMR 셀: 로봇이 오가는 부품 선반 — 시뮬레이션이 정한 자리(st.ammrRacks: 셀 긴 쪽 바깥, 통로·AMR 경로와 겹치면 셀 옆쪽)
  // 앞면이 로봇을 향한다. 같은 자리를 쓰는 로봇끼리는 선반 하나를 같이 쓴다
  const racks = [];
  const plans = kind === 'ammr' ? robots.map((r, i) => st.ammrRacks?.[i] ?? { mode: 'z', rack: { x: r.slot.x, z: r.slot.side * AMMR.rackZ }, side: r.slot.side }) : [];
  robots.forEach((r, i) => { if (plans[i]) r.plan = plans[i]; });
  const seen = new Map();
  for (const pl of plans) {
    const key = `${pl.rack.x.toFixed(2)},${pl.rack.z.toFixed(2)}`; if (seen.has(key)) continue; seen.set(key, true);
    const side = pl.side;
    const rk = put(new THREE.Group(), pl.rack.x, 0.06, pl.rack.z, group);
    rk.rotation.y = pl.mode === 'x' ? (pl.dir < 0 ? Math.PI / 2 : -Math.PI / 2) : side > 0 ? Math.PI : 0;
    for (const [px, pz] of [[-0.7, -0.24], [0.7, -0.24], [-0.7, 0.24], [0.7, 0.24]]) put(box(0.06, 1.75, 0.06, MAT.accent), px, 0.88, pz, rk);
    const bins = [];
    [0.32, 0.92, 1.52].forEach((y) => {
      put(box(1.46, 0.04, 0.52, MAT.steel), 0, y, 0, rk);
      [0x2f6fd6, 0x3ddc84, 0xf5b82e, 0xd23b3b].forEach((c, k) => bins.push(put(box(0.3, 0.2, 0.36, std(c)), -0.51 + k * 0.34, y + 0.12, 0.02, rk)));
    });
    racks.push({ side, group: rk, bins });
  }
  // 피지컬AI VLA: 로봇마다 바로 옆(진행 방향 바깥쪽 1m)에 2단 부품 선반, 손목 카메라, 집어 든 부품
  if (vla) robots.forEach((r) => {
    if (!r.slot) return;
    const dir = r.slot.x > 0 ? 1 : -1, sx = r.slot.x + dir * 1.0, sz = r.slot.z;
    const sh = put(new THREE.Group(), sx, 0.06, sz, group);
    for (const [px, pz] of [[-0.22, -0.27], [0.22, -0.27], [-0.22, 0.27], [0.22, 0.27]]) put(box(0.04, 0.98, 0.04, MAT.accent), px, 0.49, pz, sh);
    const bins = [];
    [0.48, 0.92].forEach((y) => {
      put(box(0.5, 0.03, 0.6, MAT.steel), 0, y, 0, sh);
      [0x2f6fd6, 0x3ddc84, 0xf5b82e, 0xd23b3b].forEach((c, k) => bins.push(put(box(0.2, 0.12, 0.24, std(c)), -0.11 + (k % 2) * 0.22, y + 0.075, -0.13 + Math.floor(k / 2) * 0.26, sh)));
    });
    const flange = r.tip.parent;
    const cam = put(box(0.07, 0.05, 0.06, MAT.dark), 0.07, 0.02, 0, flange);
    const lens = emis(0x37e8ff, 1.5); put(cyl(0.018, 0.018, 0.02, lens, 10), 0, 0.035, 0, cam);   // 손목 카메라 렌즈 (도구 방향)
    const names = cellParts(st);
    fillBins(bins, names);
    let held, heldParts = null;
    if (names) {   // 그리퍼에 실제 부품 (사이클마다 빈 순서대로 바꿔 집음)
      held = put(new THREE.Group(), 0, 0.02, 0, r.tip); held.visible = false;
      heldParts = names.map((n) => { const o = partClone(n); o.scale.setScalar(1.3); held.add(o); return o; });
    } else { held = put(box(0.12, 0.08, 0.12, std(0x3ddc84)), 0, 0.06, 0, r.tip); held.visible = false; }
    r.vla = { shelf: { x: sx, y: 0.06 + 0.92 + 0.15, z: sz }, bins, held, heldParts, pick: 0, lens, dir };
    racks.push({ side: r.slot.side, group: sh, bins, vla: true });
  });
  return { group, robots, racks };
}

// ── 공정 설비 (유형별) ─────────────────
function buildWeld(g) {
  const fence = new THREE.Group();
  for (const x of [-2, 2]) put(box(0.06, 1.3, 3.6, MAT.yellow), x, 0.8, 0, fence);
  put(box(4, 0.06, 0.06, MAT.yellow), 0, 1.4, -1.8, fence);
  g.add(fence);
  const table = put(box(1.2, 0.8, 0.8, MAT.dark), -1.2, 0.55, 2.0, g);
  return { manualProps: [table], sparks: put(makeSparks(0xffc060, 50, 0.07), 0, 0, 0, g) };
}

function buildAssembly(g, st, sim) {
  const colors = [0x2f6fd6, 0x3ddc84, 0xf5b82e, 0xd23b3b];
  if (!sim?.zone) {
    put(box(4.0, 0.08, 0.5, MAT.steel), 0, BELT_Y + 0.2, -0.85, g);
    colors.forEach((c, i) => put(box(0.5, 0.3, 0.4, std(c)), -1.5 + i * 0.6, BELT_Y + 0.4, -0.85, g));
    const bowl = put(cyl(0.45, 0.3, 0.4, MAT.steel), 1.6, BELT_Y + 0.3, -0.9, g);
    put(cyl(0.2, 0.2, 0.9, MAT.dark), 0, -0.6, 0, bowl);
    return { bowl };
  }
  // 정밀조립Zone: 양쪽 로봇 바깥 끝에 부품 랙(2단 빈), 오른쪽 끝에 볼 피더 (피지컬AI VLA 셀은 로봇별 부품 선반으로 대체)
  const feeders = [], names = cellParts(st);
  for (const z of [-1.0, 1.0]) {
    const r = put(new THREE.Group(), -1.95, 0.06, z, g); feeders.push(r);
    put(box(0.55, 1.0, 0.6, MAT.steel), 0, 0.5, 0, r);
    fillBins(colors.map((c, i) => put(box(0.24, 0.16, 0.26, std(c)), -0.13 + (i % 2) * 0.26, 0.6 + Math.floor(i / 2) * 0.3, 0, r)), names);
  }
  const bowl = put(cyl(0.3, 0.2, 0.3, MAT.steel), 1.95, 1.05, -1.0, g); feeders.push(bowl);
  if (names) { const pile = partPile(st.def.product === 'eaxle' ? 'P_Seal' : 'P_Clip', 0.4, 0.4, 3); pile.position.y = 0.15; bowl.add(pile); }   // 볼 피더의 작은 부품
  put(cyl(0.12, 0.12, 0.95, MAT.dark), 0, -0.55, 0, bowl);
  // 제품 전용 라인 표시판
  const sign = put(box(0.5, 0.35, 0.05, std(ZONE_COLOR[st.def.product] ?? 0x888888, { emissive: ZONE_COLOR[st.def.product] ?? 0, emissiveIntensity: 0.5 })), 1.95, 1.6, 1.0, g);
  put(box(0.05, 0.6, 0.05, MAT.dark), 0, -0.45, 0, sign);
  return { bowl, feeders };
}

// 부품분류셀: 비전 카메라 브리지 + 부품 공급 트레이 + 분류 빈
function buildSort(g, st, sim) {
  // 분류 게이트를 셀 입구(x −1.75)에 두고, 분류 로봇은 그 뒤에서 게이트 결정대로 작업한다
  const gate = buildGate(g, -1.75, 0x33ff99);
  if (sim?.zone) {
    // 제품별 키트 빈: 도어트림 쪽(+z) · e-axle 쪽(−z), 게이트 뒤 출구 쪽
    [['doortrim', 1.15], ['eaxle', -1.15]].forEach(([k, z]) => {
      const tones = k === 'doortrim' ? [0xf0a030, 0xf5b82e, 0xd98a2b] : [0x9a6bff, 0x7b5cd6, 0x2f6fd6];
      tones.forEach((c, i) => { const bin = put(box(0.42, 0.34, 0.4, std(c)), 0.45 + i * 0.47, 0.32, z, g); put(box(0.36, 0.02, 0.34, MAT.dark), 0, 0.17, 0, bin); });
      const tag = put(box(0.5, 0.22, 0.04, std(ZONE_COLOR[k], { emissive: ZONE_COLOR[k], emissiveIntensity: 0.6 })), 1.85, 0.75, z, g);
      put(box(0.04, 0.5, 0.04, MAT.dark), 0, -0.35, 0, tag);
    });
  } else {
    [0x2f6fd6, 0x3ddc84, 0xf5b82e, 0xd23b3b].forEach((c, i) => {
      const bin = put(box(0.42, 0.34, 0.4, std(c)), 0.2 + i * 0.47, 0.32, 1.15, g);
      put(box(0.36, 0.02, 0.34, MAT.dark), 0, 0.17, 0, bin);
    });
    put(box(1.4, BELT_Y + 0.09, 0.6, MAT.dark), 1.0, (BELT_Y + 0.09) / 2, -1.0, g);
  }
  return { ...gate };
}

// 분류·포장 게이트: 문형 프레임 + 비전 카메라·스캔 링·스캔 막 + 결정 표시판 (셀 입구에 두고 들어오는 대상물을 판별)
function buildGate(g, x, scanColor) {
  for (const z of [-1.0, 1.0]) put(box(0.14, 2.3, 0.14, MAT.dark), x, 1.3, z, g);
  put(box(0.22, 0.2, 2.2, MAT.dark), x, 2.45, 0, g);
  put(box(0.3, 0.26, 0.36, MAT.white), x, 2.2, 0, g);
  const ringMat = emis(0xffffff, 0.4);
  const ring = put(mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 28), ringMat, false), x, 1.9, 0, g);
  ring.rotation.x = Math.PI / 2;
  const scanMat = new THREE.MeshBasicMaterial({ color: scanColor, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const scan = put(new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.8), scanMat), x, 1.35, 0, g);
  scan.rotation.y = Math.PI / 2;
  // 결정 표시판 (게이트 위, 앞뒤)
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const signMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  for (const ry of [Math.PI / 2, -Math.PI / 2]) {   // 앞뒤 두 장 — 어느 쪽에서 봐도 글자가 바로 보이게
    const sign = put(new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), signMat), x + (ry > 0 ? 0.012 : -0.012), 2.95, 0, g);
    sign.rotation.y = ry;
  }
  put(box(0.06, 0.4, 0.06, MAT.dark), x, 2.65, 0, g);
  return { ringMat, scan, gateX: x, gateSign: { cv, tex, id: null } };
}
function drawGateSign(gs, st) {
  const d = st.gate, key = d ? `${d.id}:${st.state === 'DOWN'}` : 'none';
  if (gs.id === key) return; gs.id = key;
  const c = gs.cv.getContext('2d'), col = d?.product ? '#' + ZONE_COLOR[d.product].toString(16).padStart(6, '0') : '#37e8ff';
  c.fillStyle = '#071019'; c.fillRect(0, 0, 512, 128);
  c.fillStyle = col; c.fillRect(0, 0, 14, 128);
  c.font = 'bold 30px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; c.fillStyle = '#9fb4c8';
  c.fillText(st.def.type === 'pack' ? '포장 게이트 · 판별 결과' : '분류 게이트 · 판별 결과', 32, 42);
  c.font = 'bold 40px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; c.fillStyle = d?.product ? col : '#e6edf3';
  const t = d ? d.text : '대기 중'; let fs = 40;
  while (c.measureText(t).width > 460 && fs > 22) { fs -= 2; c.font = `bold ${fs}px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`; }
  c.fillText(t, 32, 98);
  gs.tex.needsUpdate = true;
}

// 부품압입셀: 양쪽 협동로봇이 힘제어로 압입 — 클립 피더 + 압입 툴 거치대 + 하중-변위 모니터
function buildPressFit(g) {
  for (const z of [-1.0, 1.0]) {
    const f = put(box(0.5, 0.75, 0.42, MAT.white), -1.95, 0.42, z, g);
    put(cyl(0.18, 0.12, 0.2, MAT.steel), 0, 0.47, 0, f);
  }
  const stand = put(box(0.4, 0.9, 0.4, MAT.dark), 1.95, 0.5, -1.05, g);
  const ram = put(new THREE.Group(), 0, 0.55, 0, stand);
  put(cyl(0.07, 0.07, 0.3, MAT.accent), 0, 0, 0, ram);
  const panel = put(box(0.7, 0.55, 0.08, MAT.dark), 1.95, 1.75, 1.05, g);
  const screen = emis(0x58c4ff, 1.2);
  put(box(0.6, 0.45, 0.02, screen, false), 0, 0, 0.05, panel);
  put(box(0.06, 1.1, 0.06, MAT.dark), 1.95, 0.95, 1.05, g);
  return { ram, screen };
}

// 스크류체결셀: 오버헤드 너트러너 + 스크류 피더 + 토크 컨트롤러
function buildScrew(g, st) {
  // 너트러너 문형은 대상물(셀 중앙) 바로 위 — 기둥은 양쪽 로봇 팔 작업 범위(x<-0.3) 밖
  for (const z of [-1.1, 1.1]) put(box(0.12, 2.6, 0.12, MAT.steel), 0.15, 1.45, z, g);
  put(box(0.2, 0.2, 2.4, MAT.steel), 0.15, 2.75, 0, g);
  put(box(0.24, 0.34, 0.24, MAT.dark), 0.15, 2.75, 0, g);                 // Z축 가이드 블록 (빔에 고정)
  const head = put(new THREE.Group(), 0.15, 2.3, 0, g);
  put(box(0.3, 0.35, 0.3, MAT.accent), 0, 0.1, 0, head);
  put(box(0.08, 1.25, 0.08, MAT.steel), 0, 0.8, 0, head);                // Z축 봉 — 가장 낮게(1.95m) 내려와도 윗끝(3.3m)이 빔·가이드 블록 안에 남는다
  const bit = put(cyl(0.035, 0.05, 0.55, MAT.steel, 10), 0, -0.3, 0, head);
  const feeders = [];
  for (const z of [-1.0, 1.0]) {
    const f = put(box(0.45, 0.5, 0.4, MAT.white), -1.95, 0.45, z, g); feeders.push(f);
    put(cyl(0.16, 0.1, 0.18, MAT.steel), 0, 0.34, 0, f);
    if (cellParts(st)) { const pile = partPile(z < 0 ? 'P_Screw' : 'P_Clip', 0.24, 0.24, z < 0 ? 1 : 2); pile.position.y = 0.43; f.add(pile); }   // 스크류 피더: 나사 · 트림 클립
  }
  const ctl = put(box(0.5, 0.7, 0.35, MAT.dark), 1.95, 0.4, 1.6, g);
  const screen = emis(0x3ddc84, 1.2);
  put(box(0.36, 0.25, 0.02, screen, false), 0, 0.15, 0.18, ctl);
  return { head, bit, screen, feeders };
}

// 부품체결셀(e-axle): 다축 너트러너 포털 + 토크 모니터
function buildFasten(g, st) {
  for (const z of [-1.3, 1.3]) put(box(0.18, 3.0, 0.18, MAT.dark), 0.2, 1.6, z, g);
  put(box(0.3, 0.3, 2.8, MAT.dark), 0.2, 3.1, 0, g);
  put(cyl(0.18, 0.18, 0.42, MAT.dark, 20), 0.2, 3.1, 0, g);              // 승강축 가이드 슬리브 (빔에 고정)
  const head = put(new THREE.Group(), 0.2, 2.4, 0, g);
  put(cyl(0.12, 0.12, 1.45, MAT.steel), 0, 0.72, 0, head);               // 승강축 — 가장 낮게(1.95m) 내려와도 윗끝(3.4m)이 빔·슬리브 안에 남는다
  const disc = put(cyl(0.45, 0.45, 0.22, MAT.accent, 24), 0, 0, 0, head);
  const spindles = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    spindles.push(put(cyl(0.04, 0.05, 0.4, MAT.steel, 8), Math.cos(a) * 0.32, -0.28, Math.sin(a) * 0.32, head));
  }
  const panel = put(box(0.8, 0.6, 0.08, MAT.dark), 1.8, 1.8, 1.35, g);
  const screen = emis(0x3ddc84, 1.2);
  put(box(0.7, 0.5, 0.02, screen, false), 0, 0, 0.05, panel);
  put(box(0.06, 1.15, 0.06, MAT.dark), 1.8, 0.95, 1.35, g);
  const names = cellParts(st);
  if (names) {   // 체결 부품 트레이 (볼트 · 너트 · 와셔): 너트러너 옆 작업대
    const tb = put(new THREE.Group(), 1.8, 0, -1.35, g);
    put(box(0.06, 0.9, 0.06, MAT.dark), 0, 0.45, 0, tb);
    put(box(0.7, 0.04, 0.4, MAT.steel), 0, 0.92, 0, tb);
    fillBins(['P_Bolt', 'P_Nut', 'P_Washer'].map((_, i) => put(box(0.2, 0.05, 0.3, std(0x2f6fd6)), -0.22 + i * 0.22, 0.965, 0, tb)), ['P_Bolt', 'P_Nut', 'P_Washer']);
  }
  return { head, disc, spindles, screen };
}

function buildPress(g) {
  put(box(3.2, 0.5, 2.6, MAT.dark), 0, 0.4, 0, g);
  put(box(1.0, 3.6, 1.0, MAT.accent), 0, 2.0, -1.3, g);
  put(box(2.4, 0.8, 2.0, MAT.accent), 0, 3.6, -0.4, g);
  const ram = put(new THREE.Group(), 0, 2.8, 0, g);
  put(box(1.4, 0.6, 1.2, MAT.steel), 0, 0, 0, ram);
  put(box(1.2, 0.08, 1.0, MAT.dark), 0, -0.34, 0, ram);
  for (const x of [-1.5, 1.5]) put(box(0.1, 1.2, 1.6, MAT.yellow), x, 1.4, 1.2, g);
  return { ram };
}

function buildLaser(g) {
  put(box(4.0, 0.5, 2.6, MAT.white), 0, 0.4, 0, g);
  for (const [x, z] of [[-1.9, -1.2], [1.9, -1.2], [-1.9, 1.2], [1.9, 1.2]]) put(box(0.1, 2.0, 0.1, MAT.dark), x, 1.6, z, g);
  put(box(4.0, 0.1, 2.5, MAT.dark), 0, 2.6, 0, g);
  put(box(3.9, 1.4, 0.04, std(0xff4a2a, { transparent: true, opacity: 0.25, depthWrite: false }), false), 0, 1.8, 1.22, g);
  const head = put(new THREE.Group(), 0, 2.3, 0, g);
  put(box(0.4, 0.4, 0.4, MAT.dark), 0, 0, 0, head);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xff3322, toneMapped: false });
  const beam = put(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6), beamMat), 0, -0.7, 0, head);
  return { head, beam, sparks: put(makeSparks(0xff8a50, 30, 0.05), 0, 0, 0, g) };
}

function buildTest(g) {
  put(box(3.6, 0.6, 2.4, MAT.dark), 0, 0.45, 0, g);
  for (const z of [-0.9, 0.9]) put(box(0.12, 1.8, 0.12, MAT.steel), 0.8, 1.6, z, g);
  put(box(0.2, 0.2, 2.0, MAT.steel), 0.8, 2.5, 0, g);
  const probe = put(new THREE.Group(), 0.8, 2.1, 0, g);
  put(box(0.5, 0.25, 0.7, MAT.accent), 0, 0, 0, probe);
  for (const z of [-0.2, 0, 0.2]) put(cyl(0.02, 0.02, 0.35, MAT.copper), 0, -0.3, z, probe);
  const scr = emis(0x3ddc84, 1.2);
  const mon = put(box(0.9, 0.6, 0.06, MAT.dark), -1.2, 2.0, -1.0, g);
  put(box(0.8, 0.5, 0.02, scr, false), 0, 0, 0.04, mon);
  put(box(0.06, 1.2, 0.06, MAT.dark), -1.2, 1.2, -1.0, g);
  return { probe, screen: scr };
}

function buildPaint(g) {
  put(box(4.4, 0.12, 3.6, MAT.dark), 0, 2.95, 0, g);
  for (const [x, z] of [[-2.15, -1.75], [2.15, -1.75], [-2.15, 1.75], [2.15, 1.75]]) put(box(0.12, 2.9, 0.12, MAT.steel), x, 1.45, z, g);
  put(box(4.3, 2.0, 0.04, MAT.booth, false), 0, 1.9, 1.75, g);
  put(box(4.3, 2.8, 0.04, MAT.booth, false), 0, 1.5, -1.75, g);
  put(box(0.04, 1.6, 3.5, MAT.booth, false), -2.15, 2.1, 0, g);
  put(box(0.04, 1.6, 3.5, MAT.booth, false), 2.15, 2.1, 0, g);
  put(cyl(0.45, 0.45, 2.2, MAT.steel), 1.2, 4.0, -0.8, g);
  const lamp = emis(0xe6f2ff, 0.8);
  put(box(3.6, 0.04, 0.4, lamp, false), 0, 2.87, 0, g);
  return { lamp, mist: put(makeSparks(0x4f8fff, 70, 0.12), 0, 0, 0, g) };
}

function buildVision(g) {
  const auto = new THREE.Group(); g.add(auto);
  for (const z of [-1.0, 1.0]) put(box(0.16, 2.3, 0.16, MAT.dark), 0, 1.3, z, auto);
  put(box(0.24, 0.22, 2.3, MAT.dark), 0, 2.45, 0, auto);
  put(box(0.35, 0.3, 0.45, MAT.white), 0, 2.2, 0, auto);
  put(cyl(0.08, 0.1, 0.15, MAT.dark), 0, 2.0, 0, auto);
  const ringMat = emis(0xffffff, 0.4);
  const ring = put(mesh(new THREE.TorusGeometry(0.38, 0.04, 8, 32), ringMat, false), 0, 1.75, 0, auto);
  ring.rotation.x = Math.PI / 2;
  const scanMat = new THREE.MeshBasicMaterial({ color: 0x33ff99, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const scan = put(new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.8), scanMat), 0, 1.3, 0, auto);
  scan.rotation.y = Math.PI / 2;
  const bin = put(box(0.9, 0.7, 0.9, std(0xb33a3a)), 1.4, 0.5, -1.9, g);
  put(box(0.8, 0.02, 0.8, MAT.dark), 0, 0.36, 0, bin);
  const lampMat = emis(0xfff4d0, 1.0);
  const manual = new THREE.Group(); g.add(manual);
  put(box(0.06, 1.6, 0.06, MAT.dark), -0.6, 1.0, 1.0, manual);
  put(box(0.8, 0.08, 0.3, lampMat, false), -0.3, 1.8, 0.7, manual);
  return { auto, manual, ringMat, scan, bin };
}

function buildPack(g, st, sim) {
  if (sim?.zone) {
    // 공동 포장셀: 입구에 포장 게이트(제품 판별 → 트레이/크레이트 결정), 그 뒤에 포장 로봇, 출구에 테이핑·라벨러 문형
    // 매거진은 출구 쪽 양 모서리(x +1.0, z ±1.65): 도어트림 트레이(+z) · e-axle 크레이트(−z) — 그 쪽 로봇이 그 포장을 맡는다
    const gate = buildGate(g, -1.75, 0x58c4ff);
    [['doortrim', 1.65], ['eaxle', -1.65]].forEach(([k, z]) => {
      const mg = put(new THREE.Group(), 1.0, 0.06, z, g);
      for (let i = 0; i < 6; i++) put(box(0.55, 0.1, 0.5, k === 'doortrim' ? MAT.carton : std(0x6d5a8a)), 0, 0.05 + i * 0.11, 0, mg);
      put(box(0.56, 0.04, 0.51, std(ZONE_COLOR[k])), 0, 0.7, 0, mg);
    });
    for (const z of [-0.85, 0.85]) put(box(0.12, 1.9, 0.12, MAT.steel), 1.45, 1.0, z, g);
    const head = put(box(0.6, 0.45, 1.8, MAT.white), 1.45, 2.0, 0, g);
    put(box(0.62, 0.1, 1.82, MAT.accent), 0, -0.25, 0, head);
    return { ...gate };
  }
  const mag = put(new THREE.Group(), 1.1, 0.15, -1.7, g);
  for (let i = 0; i < 6; i++) put(box(1.0, 0.06, 0.8, MAT.carton), 0, 0.05 + i * 0.07, 0, mag);
  const taper = put(box(0.6, 0.6, 1.3, MAT.white), 1.4, BELT_Y + 0.6, 0, g);
  put(box(0.62, 0.1, 1.32, MAT.accent), 0, 0.3, 0, taper);
  return {};
}

// ── 자재투입존 (정밀조립Zone · Blender): 한쪽(+z) 도어트림 빗살 거치대, 반대쪽(−z) e-axle 3단 랙에 실물 모델을 정렬 보관
// 수십 개를 그리므로 모델을 재질별로 합쳐(bake) InstancedMesh로 그린다 — 보이는 개수(count)가 재고 수량
function bakeAsset(root, skip) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let a = o; a && a !== root; a = a.parent) if (!a.visible || skip?.(a)) return;
    let gm = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (gm.index) gm = gm.toNonIndexed();
    for (const k of Object.keys(gm.attributes)) if (k !== 'position' && k !== 'normal') gm.deleteAttribute(k);
    const e = byMat.get(o.material.uuid) ?? byMat.set(o.material.uuid, { material: o.material, gs: [] }).get(o.material.uuid);
    e.gs.push(gm);
  });
  return [...byMat.values()].map(({ material, gs }) => ({ material, geometry: mergeGeometries(gs) }));
}
const BAKED = new Map();   // 자산별 재질 합친 지오메트리 (자산을 다시 불러오면 새로 만든다)
function bakedOf(name, skip) {
  const src = RENDER.assets[name]; if (!src) return null;
  const hit = BAKED.get(name); if (hit?.src === src) return hit.baked;
  const baked = bakeAsset(src.clone(true), skip); BAKED.set(name, { src, baked }); return baked;
}
function instancedStock(baked, mats) {
  const group = new THREE.Group();
  const meshes = baked.map(({ material, geometry }) => {
    const m = new THREE.InstancedMesh(geometry, material, mats.length);
    mats.forEach((mx, i) => m.setMatrixAt(i, mx));
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; group.add(m); return m;
  });
  return { group, setCount: (n) => meshes.forEach((m) => { m.count = Math.max(0, Math.min(mats.length, n)); }) };
}
function buildSourceZone(g) {
  const SLOTS = RAW_CAP / 2, auto = new THREE.Group(); g.add(auto);
  // 투입 갠트리 프레임: 양쪽 보관 구역(z −3 ~ +3)을 모두 덮는다
  for (const x of [-1.95, 1.95]) for (const z of [-3.15, 3.15]) put(box(0.12, 3.0, 0.12, MAT.yellow), x, 1.5, z, auto);
  for (const z of [-3.15, 3.15]) { put(box(4.1, 0.14, 0.14, MAT.yellow), 0, 3.0, z, auto); put(box(3.9, 0.03, 0.05, MAT.steel), 0, 3.09, z, auto); }
  const bridge = put(new THREE.Group(), 0, 3.0, 0, auto);
  put(box(0.18, 0.18, 6.5, MAT.dark), 0, 0.12, 0, bridge);
  for (const z of [-3.15, 3.15]) put(box(0.3, 0.14, 0.26, MAT.orange), 0, 0.14, z, bridge);
  const car = put(new THREE.Group(), 0, 0, 0, bridge);
  put(box(0.4, 0.3, 0.4, MAT.orange), 0, -0.05, 0, car);
  put(box(0.18, 0.7, 0.18, MAT.dark), 0, 0.3, 0, car);                                    // Z축 가이드 슬리브 (캐리지 위아래)
  const lift = put(new THREE.Group(), 0, 0, 0, car);
  put(box(0.08, 2.7, 0.08, MAT.steel), 0, -0.25, 0, lift);   // Z축 봉 (−1.6 ~ +1.1): 가장 낮게 내려가도 캐리지 슬리브에 물려 있다
  put(box(0.5, 0.08, 0.4, MAT.dark), 0, -1.6, 0, lift);
  // e-axle 적재 (−z): 바닥 팔레트 위에 받침대째 3열(x) × 3줄(z)로 놓고, 층 사이에 받침목을 깔아 3단으로 쌓는다 (선반 없음 — 갠트리가 위에서 집는다)
  const EA_H = 0.57, LV = [0.12, 0.72, 1.32];
  put(box(3.6, 0.12, 1.6, MAT.pallet), 0, 0.06, -2.15, g);
  const boards = LV.slice(1).map((y) => { const b = put(new THREE.Group(), 0, 0, 0, g); for (const z of [-0.52, 0, 0.52]) put(box(3.5, 0.03, 0.12, MAT.pallet), 0, y - 0.015, -2.15 + z, b); return b; });
  const eaSlots = [];
  LV.forEach((y) => { for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) eaSlots.push(new THREE.Vector3(-1.15 + c * 1.15, y, -2.15 - 0.52 + r * 0.52)); });
  const eaM = eaSlots.slice(0, SLOTS).map((v) => new THREE.Matrix4().makeTranslation(v.x, v.y, v.z));
  const ea = instancedStock(bakedOf('eaxle', (o) => o.name === 'FastenBolts'), eaM); g.add(ea.group);
  // 도어트림 빗살 거치대 (+z): 2열(x) × 10장, 세워서 앞면이 바깥(+z)을 보게 — 안쪽부터 채운다
  const dr = put(new THREE.Group(), 0, 0, 2.15, g);
  put(box(3.7, 0.08, 1.6, MAT.steel), 0, 0.04, 0, dr);
  for (const cx of [-0.95, 0.95]) {
    for (const x of [-0.36, 0.36]) put(box(0.05, 0.06, 1.5, MAT.dark), cx + x, 0.11, 0, dr);
    for (let k = 0; k <= 10; k++) for (const x of [-0.44, 0.44]) put(box(0.02, 0.5, 0.02, MAT.accent), cx + x, 0.33, -0.725 + k * 0.145, dr);   // 빗살 칸막이
    for (const x of [-0.44, 0.44]) put(box(0.03, 0.03, 1.5, MAT.accent), cx + x, 0.6, 0, dr);
  }
  const dtSlots = [];
  for (let k = 0; k < 10; k++) for (const cx of [-0.95, 0.95]) dtSlots.push(new THREE.Vector3(cx, 0.14, 2.15 - 0.65 + k * 0.145));
  const dtM = dtSlots.map((v) => new THREE.Matrix4().makeTranslation(v.x, v.y, v.z));
  const dt = instancedStock(bakedOf('doortrim'), dtM); g.add(dt.group);
  // 갠트리가 들고 가는 모델 (제품별): 중심이 기존 박스 자리(−1.85)
  const heldEA = put(new THREE.Group(), 0, -1.85 - EA_H / 2, 0, lift); const eh = cloneAsset('eaxle').root; eh.getObjectByName('FastenBolts').visible = false; heldEA.add(eh);
  const heldDT = put(new THREE.Group(), 0, -1.85 - 0.3, 0, lift); heldDT.add(cloneAsset('doortrim').root);
  const held = put(new THREE.Group(), 0, 0, 0, lift); held.add(heldEA, heldDT);
  return { auto, bridge, car, lift, held, heldEA, heldDT, stack: [], zoneStock: { ea: { ...ea, slots: eaSlots.slice(0, SLOTS), h: EA_H, boards }, dt: { ...dt, slots: dtSlots, h: 0.6 } } };
}

function buildSource(g, st, sim) {
  if (sim?.zone && blenderOn() && RENDER.assets.eaxle && RENDER.assets.doortrim) return buildSourceZone(g);
  const auto = new THREE.Group(); g.add(auto);
  for (const x of [-1.8, 1.8]) for (const z of [-1.5, 3.0]) put(box(0.12, 3.0, 0.12, MAT.yellow), x, 1.5, z, auto);
  put(box(3.8, 0.14, 0.14, MAT.yellow), 0, 3.0, -1.5, auto);
  put(box(3.8, 0.14, 0.14, MAT.yellow), 0, 3.0, 3.0, auto);
  // 투입 갠트리 (직교 3축): X축 레일(z −1.5·3.0) 위를 브리지가 주행(X) → 캐리지가 브리지를 따라 이송(Y) → 승강축이 내려가 집기(Z)
  for (const z of [-1.5, 3.0]) put(box(3.6, 0.03, 0.05, MAT.steel), 0, 3.09, z, auto);   // 리니어 가이드
  const bridge = put(new THREE.Group(), 0, 3.0, 0, auto);
  put(box(0.18, 0.18, 4.6, MAT.dark), 0, 0.12, 0.75, bridge);
  for (const z of [-1.5, 3.0]) put(box(0.3, 0.14, 0.26, MAT.orange), 0, 0.14, z, bridge);   // 레일 주행 블록
  const car = put(new THREE.Group(), 0, 0, 0, bridge);
  put(box(0.4, 0.3, 0.4, MAT.orange), 0, -0.05, 0, car);
  put(box(0.18, 0.7, 0.18, MAT.dark), 0, 0.3, 0, car);                                    // Z축 가이드 슬리브
  const lift = put(new THREE.Group(), 0, 0, 0, car);                                       // Z축 승강
  put(box(0.08, 2.7, 0.08, MAT.steel), 0, -0.25, 0, lift);                                 // 봉이 길어 가장 낮게 내려가도 캐리지에 물려 있다
  put(box(0.5, 0.08, 0.4, MAT.dark), 0, -1.6, 0, lift);
  const held = put(box(0.6, 0.35, 0.5, MAT.raw), 0, -1.85, 0, lift);
  put(box(2.6, 0.12, 2.0, MAT.pallet), 0, 0.21, 2.3, g);
  const stack = [];
  for (let i = 0; i < RAW_CAP; i++) {
    const lx = i % 4, lz = Math.floor(i / 4) % 5, ly = Math.floor(i / 20);
    stack.push(put(box(0.55, 0.32, 0.36, MAT.raw), -0.9 + lx * 0.6, 0.45 + ly * 0.34, 1.5 + lz * 0.4, g));
  }
  return { auto, bridge, car, lift, held, stack };
}

function buildSink(g, st, sim) {
  if (sim?.zone) {
    // 구분 적재장: 앞쪽(+z) 도어트림 구역, 뒤쪽(-z) e-axle 구역 — 로봇이 제품을 구분해 적재
    // 제품마다 적재 로봇 1대: AMR 하역 위치(셀 중앙)와 제품 구역 사이(z ±1.25)에서 AMR 위 박스를 집어 적재 팔레트에 쌓는다
    const stacks = {}, arms = {}, auto = put(new THREE.Group(), 0, 0, 0, g);
    [['doortrim', 1], ['eaxle', -1]].forEach(([k, sd]) => {
      const pad = put(new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.8), new THREE.MeshStandardMaterial({ color: ZONE_COLOR[k], transparent: true, opacity: 0.35, depthWrite: false })), 0, 0.02, sd * 3.0, g);
      pad.rotation.x = -Math.PI / 2;
      put(box(3.0, 0.12, 2.4, MAT.pallet), 0, 0.12, sd * 3.0, g);
      const mat = k === 'doortrim' ? MAT.carton : MAT.crate;
      stacks[k] = [];
      for (let i = 0; i < FG_ZONE_CAP; i++) {
        const lx = i % 4, lz = Math.floor(i / 4) % 3, ly = Math.floor(i / 12);
        stacks[k].push(put(box(0.66, 0.5, 0.66, mat), -1.05 + lx * 0.7, 0.43 + ly * 0.52, sd * (2.3 + lz * 0.7), g));
      }
      const arm = makeArm(k === 'doortrim' ? MAT.orange : std(0x7a5cc8, { roughness: 0.45, metalness: 0.3 }), PALLET_ARM.s);
      put(arm.root, 0, 0.06, sd * PALLET_ARM.z, auto);
      put(cyl(0.62, 0.66, 0.06, std(ZONE_COLOR[k], { roughness: 0.5 })), 0, 0.03, sd * PALLET_ARM.z, auto);   // 제품 색 받침
      const held = put(box(0.66, 0.5, 0.66, mat), 0, -0.25 - 0.02, 0, arm.tip); held.visible = false;       // 진공 그리퍼에 붙은 박스
      arms[k] = { arm, sd, held, queue: 0, cyc: null, seen: null };
    });
    return { zoneStacks: stacks, arms, auto };
  }
  put(box(3.0, 0.12, 2.4, MAT.pallet), 0, 0.21, 2.2, g);
  const stack = [];
  for (let i = 0; i < FG_CAP; i++) {
    const lx = i % 4, lz = Math.floor(i / 4) % 3, ly = Math.floor(i / 12);
    stack.push(put(box(0.66, 0.5, 0.66, MAT.carton), -1.05 + lx * 0.7, 0.52 + ly * 0.52, 1.5 + lz * 0.7, g));
  }
  const arm = makeArm(MAT.orange, 0.9); put(arm.root, 1.7, 0.15, 0.9, g);
  return { stack, arm, auto: arm.root };
}

const BUILDERS = {
  cnc: buildCNC, press: buildPress, laser: buildLaser, weld: buildWeld, assembly: buildAssembly,
  paint: buildPaint, vision: buildVision, test: buildTest, pack: buildPack, source: buildSource, sink: buildSink,
  sort: buildSort, pressfit: buildPressFit, screw: buildScrew, fasten: buildFasten,
};

// ── 메인 뷰 ─────────────────────────────
export class FactoryView {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group(); scene.add(this.root);
    this.dyn = new THREE.Group(); scene.add(this.dyn);
    this.time = 0;
    this.itemMeshes = new Map(); this.itemPool = [];
    this.flyers = [];
    this.packets = [];
    this.stationViews = [];
    this.conveyorTex = [];
    this.lampMats = [];
    this.iot = new THREE.Group(); this.root.add(this.iot);
    this.buildBuilding();
    this.buildAreas();
  }

  buildBuilding() {
    const r = this.root;
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.85, metalness: 0.05 });
    // 바닥: 생산동(x −38 ~ 38) + 왼쪽 물류 확장동(x −51 ~ −38) — 하나의 건물, 사이 벽 없음
    const floor = put(mesh(new THREE.PlaneGeometry(89, 40), floorMat, false), -6.5, 0, 0, r);
    floor.rotation.x = -Math.PI / 2;
    this.floorMat = floorMat;
    // AGV 통로
    const laneGeo = (w, d) => new THREE.PlaneGeometry(w, d);
    // 앞쪽 통로는 확장동 물류존(AGV 원자재 상차·부품 피킹)까지 이어지고, 왼쪽 세로 통로는 동선 계산의 교차 통로(x −35.5)와 같은 자리
    const lanes = [[-7, 9, 84, 2.6], [-1, -9, 72, 2.6], [-35.5, 0, 2.6, 20.6], [35, 0, 2.6, 20.6]];   // 입고 지게차 운행 구간은 바닥 초록 전용 표시로만 구분
    for (const [x, z, w, d] of lanes) {
      const l = put(new THREE.Mesh(laneGeo(w, d), MAT.lane), x, 0.005, z, r); l.rotation.x = -Math.PI / 2; l.receiveShadow = true;
      for (const s of [-1, 1]) {
        const horiz = w > d;
        const ln = put(new THREE.Mesh(laneGeo(horiz ? w : 0.1, horiz ? 0.1 : d), MAT.laneLine), x + (horiz ? 0 : s * (w / 2)), 0.01, z + (horiz ? s * (d / 2) : 0), r);
        ln.rotation.x = -Math.PI / 2;
      }
    }
    // 벽체·기둥
    // 뒷벽: 출하 도크 문 2개(폭 4.6m · 높이 4.9m)만 트럭 상차용으로 열고 나머지는 외벽 (입고 도크와 같은 방식)
    put(box(70, 8, 0.3, MAT.wall), -16, 4, -20, r);
    const doorW = 4.6, spans = [[19, YARD.bays[0] - doorW / 2], [YARD.bays[0] + doorW / 2, YARD.bays[1] - doorW / 2], [YARD.bays[1] + doorW / 2, 38]];
    for (const [a, b] of spans) put(box(b - a, 8, 0.3, MAT.wall), (a + b) / 2, 4, -20, r);
    for (const bx of YARD.bays) put(box(doorW, 8 - 4.9, 0.3, MAT.wall), bx, 4.9 + (8 - 4.9) / 2, -20, r);
    put(box(19, 0.3, 0.32, MAT.steel), 28.5, 0.15, -20, r);
    // 왼쪽 벽(확장동 x −51): 입고 도크 문(z −16.8~−12.2, 높이 4.9m)만 트럭 하차용으로 열고 나머지는 외벽
    // 왼쪽 벽은 그림자를 드리우지 않는다 (해가 왼쪽에서 비쳐 물류 확장동 바닥을 크게 덮던 그림자 제거 — 바닥은 다른 그림자를 그대로 받음)
    { const dz0 = INBOUND.dockZ - 2.3, dz1 = INBOUND.dockZ + 2.3;
      const W = INBOUND.wallX, lw = put(new THREE.Group(), 0, 0, 0, r);
      put(box(0.3, 8, dz0 + 20, MAT.wall), W, 4, (-20 + dz0) / 2, lw);
      put(box(0.3, 8, 20 - dz1, MAT.wall), W, 4, (dz1 + 20) / 2, lw);
      put(box(0.3, 8 - 4.9, 4.6, MAT.wall), W, 4.9 + (8 - 4.9) / 2, INBOUND.dockZ, lw);
      put(box(0.32, 0.3, 4.6, MAT.steel), W, 0.15, INBOUND.dockZ, lw);   // 강철 문턱은 도크 문 폭만 (나머지는 외벽 색 그대로)
      // 입고 도크: 말아 올린 셔터·문틀·도크 레벨러·범퍼·표지
      put(cyl(0.32, 0.32, 4.6, MAT.dark, 16), W + 0.15, 4.75, INBOUND.dockZ, lw).rotation.x = Math.PI / 2;
      put(box(0.14, 0.25, 4.8, MAT.yellow), W + 0.25, 4.6, INBOUND.dockZ, lw);
      for (const sd of [-1, 1]) put(box(0.2, 4.6, 0.18, MAT.yellow), W + 0.2, 2.3, INBOUND.dockZ + sd * 2.35, lw);
      put(box(1.4, 0.08, 2.6, MAT.steel), W + 0.8, 0.04, INBOUND.dockZ, lw);
      for (const sd of [-1, 1]) put(box(0.25, 0.5, 0.35, MAT.rubber), W - 0.3, 1.0, INBOUND.dockZ + sd * 1.15, lw);
      put(makeSignSprite('입고 도크', '#3ddc84', 3.2), W + 0.4, 5.6, INBOUND.dockZ, lw);
      lw.traverse((o) => (o.castShadow = false)); }
    put(box(0.3, 8, 40, MAT.wall), 38, 4, 0, r);
    for (let x = -45; x <= 36; x += 9) put(box(0.6, 8, 0.6, MAT.steel), x, 4, -19.6, r);
    put(box(89, 0.5, 0.35, MAT.accent), -6.5, 7.7, -19.8, r);
    // 천장 형광등 기구는 두지 않는다 — 공장 밝기는 환경광·주광·보조광(main.js LOOK)으로 단계별로 유지
    // 뒷벽 관제 화면 왼쪽(12×4m)에는 CCTV 전광판(js/cctvview.js)이 걸린다 — 캠틱 로고는 앞쪽 바닥 표시에 남긴다
    const logoTex = new THREE.TextureLoader().load('assets/camtic_logo.png');
    logoTex.colorSpace = THREE.SRGBColorSpace; logoTex.anisotropy = 8;
    // 바닥 표시 — 앞쪽 AGV 충전소(x -15~-3)와 사족보행·정비 휴머노이드 대기 구역(x 6~14) 사이. 카메라 쪽에서 바로 읽히는 방향
    const floorLogo = put(new THREE.Group(), 1.2, 0, 13.6, r);
    const flatOn = (w, d, mat, y) => { const m = put(new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat), 0, y, 0, floorLogo); m.rotation.x = -Math.PI / 2; m.receiveShadow = true; return m; };
    flatOn(6.6, 2.6, new THREE.MeshStandardMaterial({ color: 0x0c2048, roughness: 0.6, metalness: 0.1 }), 0.012);
    flatOn(6.6, 0.08, MAT.accent, 0.014).position.z = 1.3;
    flatOn(6.0, 6.0 * 187 / 550, new THREE.MeshBasicMaterial({ map: logoTex, color: 0xcfd3d8, transparent: true, depthWrite: false }), 0.016);
    // 출하 도크: 말아 올린 셔터·문틀·도크 레벨러·범퍼 (벽 기둥 사이 두 칸)
    for (const [i, bx] of YARD.bays.entries()) {
      put(cyl(0.32, 0.32, 4.6, MAT.dark, 16), bx, 4.75, -19.85, r).rotation.z = Math.PI / 2;
      put(box(4.8, 0.25, 0.14, MAT.yellow), bx, 4.6, -19.75, r);
      for (const sd of [-1, 1]) put(box(0.18, 4.6, 0.2, MAT.yellow), bx + sd * 2.35, 2.3, -19.8, r);
      put(box(2.6, 0.08, 1.4, MAT.steel), bx, 0.04, -19.2, r);
      for (const sd of [-1, 1]) put(box(0.35, 0.5, 0.25, MAT.rubber), bx + sd * 1.15, 1.0, -20.3, r);
      put(makeSignSprite(`출하 도크 ${i + 1}`, '#f2c230', 3.2), bx, 5.6, -19.6, r);
    }
    this.buildYard();
    this.buildFacadeSigns();
    this.buildBoard();
  }

  // 물류 선반 재고 현황판 — 원자재·부품 재고 막대(재주문점 표시), 입고 순환 상태, 입고·출고 누적
  drawWhBoard() {
    const sim = this.sim, ib = sim.inbound, B = this.whBoard; if (!B || !ib) return;
    const raw = sim.whRaw, parts = sim.partsTracked ? sim.whParts : null, d = ib.docked, moving = ib.trucks.find((t) => t.state !== 'dock' && t.state !== 'depart'), ord = ib.orders[0];
    const status = d ? ['🚚 ' + d.id + ' 하차 중 · 남은 팔레트 ' + d.pallets.length, '#3ddc84'] : moving ? ['🚚 ' + moving.id + ' 입차 중 (' + ({ arrive: '진입', wait: '대기', toDock: '후진 접안' })[moving.state] + ')', '#37e8ff']
      : ord ? [sim.supplyDisrupted ? '⛔ 발주됨 · 공급사 납품 지연 (공급 차질)' : `📝 발주됨 · ${Math.max(0, Math.ceil(ord.due - sim.time))}초 뒤 트럭 출발`, sim.supplyDisrupted ? '#ff8a1f' : '#f5b82e'] : ['✅ 재고 충분 · 배달로 줄어드는 중', '#8fb3c9'];
    const key = [raw, parts, status[0], ib.stats.trucks, sim.stats.supplyTrips, sim.stats.refills].join('|');
    if (key === B.key) return; B.key = key;
    const c = B.cv.getContext('2d'), W = B.cv.width, H = B.cv.height, F = '"Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    c.fillStyle = '#04121f'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#e8eef4'; c.font = `800 46px ${F}`; c.textBaseline = 'middle'; c.fillText('📦 물류 선반 재고 · 입고 순환', 36, 46);
    const bar = (y, label, v, cap, reorder, unit, col) => {
      c.font = `700 36px ${F}`; c.fillStyle = '#c9d2dc'; c.fillText(label, 36, y);
      const x0 = 210, w = 900, h = 40, f = Math.max(0, Math.min(1, v / cap));
      c.fillStyle = '#16232f'; c.fillRect(x0, y - h / 2, w, h);
      c.fillStyle = v <= reorder ? '#ff8a1f' : col; c.fillRect(x0, y - h / 2, w * f, h);
      for (let k = 1; k < WH.slots; k++) { c.fillStyle = '#04121f'; c.fillRect(x0 + (w * k) / WH.slots - 2, y - h / 2, 4, h); }   // 선반 칸 구분
      c.fillStyle = '#ffffff'; c.fillRect(x0 + w * (reorder / cap) - 2, y - h / 2 - 8, 4, h + 16);                          // 재주문점
      c.font = `700 34px ${F}`; c.fillStyle = '#e8eef4'; c.fillText(`${v.toLocaleString('ko-KR')} / ${cap.toLocaleString('ko-KR')}${unit}`, x0 + w + 24, y);
    };
    bar(128, '원자재', raw, WH.rawCap, WH.rawReorder, '박스', '#9aa4ae');
    if (parts != null) bar(196, '부품', parts, WH.partsCap, WH.partsReorder, '개', '#3d8bff');
    else { c.font = `600 32px ${F}`; c.fillStyle = '#8fb3c9'; c.fillText('부품   셀 부품은 작업자가 보충 (재고 추적은 피지컬AI)', 36, 196); }
    c.font = `800 38px ${F}`; c.fillStyle = status[1]; c.fillText(status[0], 36, 276);
    c.font = `600 30px ${F}`; c.fillStyle = '#8fb3c9';
    c.fillText(`입고 완료 트럭 ${ib.stats.trucks}대 · AGV 출고 ${sim.stats.supplyTrips ?? 0}회${sim.partsTracked ? ` · 부품 보충 출고 ${sim.stats.refills ?? 0}회` : ''} · 흰 선 = 재주문점(이하면 트럭 발주)`, 36, 350);
    B.tex.needsUpdate = true;
  }

  // CCTV: 사각지대 없는 배치(js/cctv.js)대로 천장 돔·외벽·기둥 카메라를 달고, 커버리지 지도(바닥 색: 빨강 사각지대 · 연두 1대 · 초록 2대 이상)를 준비한다
  buildCCTV(sim) {
    if (this.cctvG) this.root.remove(this.cctvG);
    const plan = sim.cctv, g = this.cctvG = put(new THREE.Group(), 0, 0, 0, this.root);
    const body = std(0xe9edf2, { roughness: 0.4 }), dark = std(0x16191d, { roughness: 0.25, metalness: 0.4 }), led = emis(0xff3b3b, 2);
    this.cctvLeds = [];
    for (const c of plan.cams) {
      const cg = put(new THREE.Group(), c.x, 0, c.z, g); cg.userData.cctvId = c.id;
      put(new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ visible: false })), 0, c.y, 0, cg);   // 누르기 쉬운 선택 영역
      if (c.kind === 'dome') {   // 천장 돔: 천장(8m)에서 내려온 짧은 브래킷 + 돔
        put(cyl(0.04, 0.04, 8 - c.y, MAT.steel, 6), 0, (8 + c.y) / 2, 0, cg);
        put(cyl(0.2, 0.2, 0.08, body, 16), 0, c.y, 0, cg);
        const d = put(mesh(new THREE.SphereGeometry(0.16, 16, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), dark), 0, c.y - 0.03, 0, cg);
        void d;
      } else {
        if (c.kind === 'pole') put(cyl(0.09, 0.12, c.y, MAT.steel, 8), 0, c.y / 2, 0, cg);
        else put(box(0.5, 0.12, 0.12, MAT.steel), 0, c.y + 0.1, 0, cg).rotation.y = c.face ?? 0;   // 외벽 브래킷
        put(cyl(0.24, 0.24, 0.12, body, 16), 0, c.y + 0.12, 0, cg);
        put(mesh(new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), dark), 0, c.y + 0.06, 0, cg);
      }
      const l = put(box(0.05, 0.05, 0.05, led, false), 0.14, c.kind === 'dome' ? c.y + 0.02 : c.y + 0.2, 0, cg); this.cctvLeds.push(l);
    }
    // 커버리지 지도 (구역별 캔버스, 1m = 1칸)
    this.cctvMap = put(new THREE.Group(), 0, 0, 0, g); this.cctvMap.visible = !!this.cctvOn;
    for (const r of Object.values(plan.regions)) {
      if (!r.pts.length) continue;
      const xs = r.pts.map((p) => p.x), zs = r.pts.map((p) => p.z), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const W = Math.round(x1 - x0) + 1, H = Math.round(z1 - z0) + 1, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c2 = cv.getContext('2d');
      r.pts.forEach((p, i) => { const n = r.count[i]; c2.fillStyle = n === 0 ? 'rgba(255,60,60,0.85)' : n === 1 ? 'rgba(170,230,90,0.55)' : 'rgba(40,200,120,0.42)'; c2.fillRect(Math.round(p.x - x0), Math.round(p.z - z0), 1, 1); });
      const tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
      const m = put(new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })), (x0 + x1) / 2, 0.05, (z0 + z1) / 2, this.cctvMap);
      m.rotation.x = -Math.PI / 2; m.renderOrder = 2;
    }
    // 카메라마다 감시 반경 원
    for (const c of plan.cams) {
      const ring = put(new THREE.Mesh(new THREE.RingGeometry(c.R - 0.12, c.R, 64), new THREE.MeshBasicMaterial({ color: c.region === 'inside' ? 0x37e8ff : 0xf5b82e, transparent: true, opacity: 0.35, depthWrite: false })), c.x, 0.06, c.z, this.cctvMap);
      ring.rotation.x = -Math.PI / 2;
    }
  }
  setCCTVMap(on) { this.cctvOn = on; if (this.cctvMap) this.cctvMap.visible = on; }

  // Private 5G: 천장 소형 셀(gNB) — 무선 유닛·안테나 2개·상태등, 커버리지 지도(RSRP 색) · PCI 표시 · 로봇 ↔ 서빙 셀 연결선
  build5G(sim) {
    if (this.netG) this.root.remove(this.netG);
    const net = sim.net, g = this.netG = put(new THREE.Group(), 0, 0, 0, this.root);
    g.visible = !!net?.on; this.netLinks = null; if (!net?.on) return;
    const plan = net.plan, body = std(0xf2f4f7, { roughness: 0.45 }), ant = std(0x2b3036, { roughness: 0.5 });
    this.netLeds = [];
    for (const c of plan.cells) {
      const cg = put(new THREE.Group(), c.x, 0, c.z, g); cg.userData.gnbId = c.id;
      put(new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), new THREE.MeshBasicMaterial({ visible: false })), 0, c.y, 0, cg);   // 누르기 쉬운 선택 영역
      put(cyl(0.035, 0.035, 8 - (c.y + 0.2), MAT.steel, 6), 0, (8 + c.y + 0.2) / 2, 0, cg);   // 천장 브래킷
      put(box(0.55, 0.32, 0.38, body), 0, c.y + 0.05, 0, cg);                                   // 무선 유닛 (RU)
      for (const sd of [-1, 1]) put(box(0.08, 0.42, 0.16, ant), sd * 0.2, c.y - 0.28, 0, cg);    // 안테나
      const led = emis(0x3dff8a, 2.2); this.netLeds.push(put(box(0.06, 0.04, 0.02, led, false), 0.18, c.y + 0.12, 0.2, cg));
      put(makeSignSprite(`5G ${c.id} · PCI ${c.pci}`, '#b89bff', 2.6), 0, c.y - 0.85, 0, cg).userData.netLabel = true;
    }
    // 커버리지 지도: 2m 칸마다 최강 셀 RSRP 색 (−70 이상 진초록 … −100 미만 빨강 = 음영지역)
    this.netMap = put(new THREE.Group(), 0, 0, 0, g); this.netMap.visible = !!this.netOn;
    { const xs = plan.pts.map((p) => p.x), zs = plan.pts.map((p) => p.z), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const W = Math.round((x1 - x0) / 2) + 1, H = Math.round((z1 - z0) / 2) + 1, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c2 = cv.getContext('2d');
      plan.pts.forEach((p, i) => { const v = plan.best[i]; c2.fillStyle = v >= -70 ? 'rgba(30,170,90,0.55)' : v >= -75 ? 'rgba(90,205,95,0.5)' : v >= NR.design ? 'rgba(190,230,90,0.5)' : v >= -90 ? 'rgba(245,184,46,0.6)' : v >= NR.require ? 'rgba(255,138,61,0.7)' : 'rgba(255,50,50,0.85)'; c2.fillRect(Math.round((p.x - x0) / 2), Math.round((p.z - z0) / 2), 1, 1); });
      const tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
      const m = put(new THREE.Mesh(new THREE.PlaneGeometry(W * 2, H * 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })), (x0 + x1) / 2, 0.055, (z0 + z1) / 2, this.netMap);
      m.rotation.x = -Math.PI / 2; m.renderOrder = 2; }
    // 로봇(5G 모뎀) ↔ 서빙 셀 연결선 — 핸드오버 직후 1.5초는 흰색으로 깜빡인다
    const n = net.ues.length, geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3)); geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    this.netLinks = put(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false })), 0, 0, 0, this.netMap);
    this.netLinks.frustumCulled = false;
    for (const sp of g.children) sp.traverse?.((o) => { if (o.userData.netLabel) o.visible = !!this.netOn; });
    g.traverse((o) => (o.castShadow = false));
  }
  // 선택한 기지국 표시: 바닥 링 + 서비스 영역 테두리 원(셀 반경)
  selectGnb(id) {
    if (this.gnbSel) { this.root.remove(this.gnbSel); this.gnbSel = null; }
    const c = this.sim?.net?.plan?.cells.find((x) => x.id === id); if (!c) return;
    const g = this.gnbSel = put(new THREE.Group(), c.x, 0, c.z, this.root);
    const m1 = put(new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 40), new THREE.MeshBasicMaterial({ color: 0xb89bff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })), 0, 0.07, 0, g); m1.rotation.x = -Math.PI / 2;
    const m2 = put(new THREE.Mesh(new THREE.RingGeometry(NR.R - 0.15, NR.R, 96), new THREE.MeshBasicMaterial({ color: 0xb89bff, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide })), 0, 0.07, 0, g); m2.rotation.x = -Math.PI / 2;
    put(cyl(0.02, 0.02, c.y - 0.4, emis(0xb89bff, 2), 8), 0, (c.y - 0.4) / 2, 0, g);
  }
  setNetMap(on) { this.netOn = on; if (this.netMap) this.netMap.visible = on; this.netG?.traverse((o) => { if (o.userData.netLabel) o.visible = on; }); }
  updateNetLinks() {
    const net = this.sim?.net; if (!this.netOn || !this.netLinks || !net?.on) return;
    const P = this.netLinks.geometry.attributes.position, C = this.netLinks.geometry.attributes.color, cells = net.plan.cells, t = net.sim.time;
    const PAL = [[0.37, 0.91, 1], [0.72, 0.61, 1], [0.24, 0.86, 0.52], [0.96, 0.72, 0.18], [1, 0.48, 0.24], [0.35, 0.66, 1]];
    net.ues.forEach((u, i) => {
      const p = u.pos(), c = cells[u.hoUntil >= 0 ? u.hoTarget : u.serv] ?? cells[0], y = p.y ?? 1;
      P.setXYZ(i * 2, p.x, y + 0.6, p.z); P.setXYZ(i * 2 + 1, c.x, c.y - 0.3, c.z);
      const flash = u.hos[0] && t - u.hos[0].t < 1.5 && Math.floor(t * 8) % 2 === 0, col = u.hoUntil >= 0 || flash ? [1, 1, 1] : PAL[c.pci % 3 * 2 % PAL.length + (c.idx % 2)] ?? PAL[0];
      C.setXYZ(i * 2, ...col); C.setXYZ(i * 2 + 1, ...col);
    });
    P.needsUpdate = true; C.needsUpdate = true;
  }

  // 건물 외벽 3면(뒷벽·왼쪽 벽·오른쪽 벽 바깥) 건물 사인 — "피지컬AI 실증 메타팩토리"
  // 남색 백보드 + 흰 글자 + 하늘색 띠. 벽 바깥 0.2m에 붙이고 바깥을 향한다 (앞면은 열려 있어 사인 없음)
  buildFacadeSigns() {
    const TEXT = '피지컬AI 실증 메타팩토리';
    const make = (w, h) => {
      const c = document.createElement('canvas'); c.width = 2048; c.height = Math.round(2048 * h / w);
      const g = c.getContext('2d');
      g.fillStyle = '#0c2048'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#37e8ff'; g.fillRect(0, c.height - c.height * 0.07, c.width, c.height * 0.07);
      let fs = c.height * 0.62; const F = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
      g.font = `800 ${fs}px ${F}`;
      while (g.measureText(TEXT).width > c.width * 0.9) { fs *= 0.95; g.font = `800 ${fs}px ${F}`; }
      g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(TEXT, c.width / 2, c.height * 0.47);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, color: 0xdfe4ea }));
      return m;
    };
    const Y = 5.7, H = 2.3;
    // 뒷벽 바깥 가운데 (x 0, 출하 도크 문 위쪽을 피한 폭) — 바깥(−z)을 향함
    const back = put(make(26, H), 0, Y, -20.2, this.root); back.rotation.y = Math.PI;
    // 왼쪽 벽 바깥: 사인 대신 스타워즈 오프닝 크롤 전광판 (피지컬AI 제조데이터 아키텍처를 무한 스크롤업) — buildCrawl
    const left = this.buildCrawl();
    // 오른쪽 벽 바깥 — 바깥(+x)을 향함
    const right = put(make(26, H), 38.2, Y, 0, this.root); right.rotation.y = Math.PI / 2;
    this.facadeSigns = [back, left, right];
  }

  // 왼쪽 외벽 크롤 전광판 (30 × 7.2m, 입고 도크 문 z −16.8~−12.2를 비켜 z −11.2 ~ 18.8) — 바깥(−x)을 향함
  // 스타워즈 오프닝 크롤처럼 글자가 아래에서 올라오며 멀어진다(위로 갈수록 좁고 작아짐, 위쪽은 서서히 사라짐). 바탕은 투명 — 건물 외벽 색 그대로, 글자는 검은색
  // 긴 글을 세로로 길게 그린 원본 캔버스를 만들어 두고, 프레임마다 화면 줄(행)마다 원근에 맞는 원본 줄을 사다리꼴 폭으로 옮겨 그린다 — 끝나면 처음부터 이어진다
  buildCrawl() {
    const W = 30, H = 7.2, F = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
    const TEXT = [
      ['t', '피지컬AI 실증 메타팩토리'],
      ['s', '피지컬AI 제조 데이터 구축'],
      ['p', '제조데이터의 수집·표준화·저장부터 AI 모델 학습·배포·현장운영 및 재학습까지 연계하는 피지컬AI 데이터·모델 선순환 체계'],
      ['h', '1. 데이터 발생·수집'],
      ['p', '센서·시계열, 영상·이미지, 로봇·제어, 공정·품질, 설비상태·이력, 로그·이벤트, 시뮬레이션·합성 데이터를 PLC·센서, 로봇제어기, SCADA, MES/MOM, PLM, ERP, 디지털트윈에서 모은다.'],
      ['h', '2. 데이터 저장·관리'],
      ['p', '데이터 레이크하우스 — Raw(원천데이터 보관) → Refined(정제) → Curated(큐레이티드). 데이터 카탈로그·검색, 메타데이터 관리, 데이터 계보, 분류·태깅·정책, 보안·권한·접근관리. Object Storage · 시계열 DB · 파일 저장소.'],
      ['h', '3. 데이터 정제·표준화·제공'],
      ['p', '수집/추출, 품질검증, 시간 동기화, 정제·변환, 표준연계/정보모델링(AAS · OPC UA · MQTT · ISA-95), 비식별화/보안처리를 거쳐 DW/DM, Feature Store, 학습 데이터셋, API·서비스로 제공한다.'],
      ['h', '4. AI 모델 학습·운영 (MLOps)'],
      ['p', '모델 개발·학습·튜닝, 실험·메타데이터 관리, 모델 레지스트리·버전관리, 모델 검증·승인·배포·서빙, 성능·드리프트 모니터링, 지속적 통합·배포·학습(CI/CD/CT).'],
      ['h', '5. 피지컬AI 서비스·현장 환류'],
      ['p', '피지컬AI 기반 설비·로봇 제어, AI 비전 품질검사·불량탐지, 로봇·공정 자율최적화, 예지보전·이상징후 탐지, 생산계획·운영효율 최적화, 협업형 지능 관제, sLLM 현장지원, 디지털트윈 가상검증.'],
      ['h', '운영성과 · 현장데이터 환류 (선순환)'],
      ['p', '운영성과·이상·이벤트 데이터를 다시 모아 모델 성능을 평가하고 원인을 분석해, 데이터·모델·제어로직을 보정하고 재학습·재배포로 성능을 높인다.'],
      ['h', '표준연계 및 상호운용성'],
      ['p', 'AAS (IEC 63278) · OPC UA · MQTT · ISA-95 · 공통 데이터 모델(CDM) · 시간동기화(NTP/PTP)'],
      ['h', '공통운영'],
      ['p', '오케스트레이션 · 통합 모니터링 · 데이터 계보 · 보안·권한관리 · 감사·로그 · 알림·이벤트 · 자원관리 · 장애대응·백업'],
    ];
    // 원본: 폭 1100px 글 기둥 (스타워즈 노랑, 양쪽 정렬 느낌의 가운데 정렬)
    const SW = 1100, src = document.createElement('canvas'); src.width = SW;
    const sg = src.getContext('2d'), FONT = { t: `900 92px ${F}`, s: `800 64px ${F}`, h: `800 58px ${F}`, p: `700 48px ${F}` }, LH = { t: 120, s: 96, h: 86, p: 68 };
    const lines = [];
    for (const [k, txt] of TEXT) {
      sg.font = FONT[k]; let cur = '';
      const words = k === 'p' ? txt.split(' ') : [txt];
      if (k === 'h' || k === 's') lines.push(['gap', '', 40]);
      for (const w of words) { const nx = cur ? `${cur} ${w}` : w; if (sg.measureText(nx).width > SW - 60 && cur) { lines.push([k, cur]); cur = w; } else cur = nx; }
      if (cur) lines.push([k, cur]);
      lines.push(['gap', '', k === 't' ? 30 : 24]);
    }
    lines.push(['gap', '', 520]);   // 한 바퀴 끝 — 빈 화면 뒤에 처음부터 다시
    src.height = lines.reduce((a, [k, , g]) => a + (k === 'gap' ? g : LH[k]), 0);
    sg.clearRect(0, 0, SW, src.height); sg.textAlign = 'center'; sg.textBaseline = 'middle';
    let y = 0;
    for (const [k, txt, g] of lines) { if (k === 'gap') { y += g; continue; } sg.font = FONT[k]; sg.fillStyle = k === 'h' || k === 't' ? '#000000' : '#111111'; sg.fillText(txt, SW / 2, y + LH[k] / 2); y += LH[k]; }
    // 화면 캔버스 (30 × 7.2m → 2048 × 492)
    const cv = document.createElement('canvas'); cv.width = 2048; cv.height = Math.round(2048 * H / W);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const g = put(new THREE.Group(), INBOUND.wallX - 0.2, 4.1, 3.8, this.root); g.rotation.y = -Math.PI / 2;
    put(new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })), 0, 0, 0, g);   // 외벽에 바로 쓴 글자 (테두리 없음)
    g.traverse((o) => (o.castShadow = false));
    this.crawl = { cv, src, tex, pos: 0, t: 0 };
    this.drawCrawl(0);
    return g;
  }
  drawCrawl(rdt) {
    const C = this.crawl; if (!C) return;
    C.t += rdt; if (C.t < 1 / 30 && rdt) return;   // 초당 약 30번 그린다
    C.pos = (C.pos + C.t * 55) % C.src.height; C.t = 0;   // 스크롤 속도: 원본 55px/초
    const { cv, src } = C, g = cv.getContext('2d'), Wc = cv.width, Hc = cv.height, SH = src.height;
    g.clearRect(0, 0, Wc, Hc);
    // 원근: 화면 줄 v(0 위 ~ 1 아래), 소실선은 화면 위 hz만큼 바깥 — 폭 ∝ (v + hz), 깊이 ∝ 1/(v + hz)
    const hz = 0.32, bottomW = Wc * 0.62, depth = (v) => 1 / (v + hz), d1 = depth(1), span = 1500;
    for (let row = 0; row < Hc; row++) {
      const v = row / Hc, w = bottomW * (v + hz) / (1 + hz);
      let sy = (C.pos + (depth(v) - d1) / (depth(0) - d1) * span * -1 + span) % SH; if (sy < 0) sy += SH;
      g.globalAlpha = Math.min(1, v * 2.2);   // 위쪽은 멀어지며 서서히 사라짐
      g.drawImage(src, 0, Math.floor(sy), src.width, 1, (Wc - w) / 2, row, w, 1);
    }
    g.globalAlpha = 1;
    C.tex.needsUpdate = true;
  }

  // 오른쪽 벽 설비 현황 전광판 — 모든 설비·로봇의 고유 ID·이름·현재 상태 (1초마다 갱신)
  buildBoard() {
    const W = 30, H = 6.4, cv = document.createElement('canvas'); cv.width = 4096; cv.height = Math.round(4096 * H / W);
    this.boardCanvas = cv; this.boardTex = new THREE.CanvasTexture(cv); this.boardTex.colorSpace = THREE.SRGBColorSpace; this.boardTex.anisotropy = 8;
    const g = put(new THREE.Group(), 37.72, 4.45, -1.5, this.root); g.rotation.y = -Math.PI / 2;
    put(box(W + 0.5, H + 0.5, 0.16, std(0x0b0d10, { roughness: 0.5, metalness: 0.4 })), 0, 0, -0.1, g);
    put(new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: this.boardTex, toneMapped: false })), 0, 0, 0, g);
    this.boardT = -1;
  }
  drawBoard() {
    const sim = this.sim, cv = this.boardCanvas, x = cv.getContext('2d'), W = cv.width, H = cv.height;
    const F = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif', MONO = 'Menlo, "SF Mono", Consolas, monospace';
    const list = equipmentList(sim, this);
    const COL = { run: '#3dff8a', idle: '#8fb3c9', charge: '#37e8ff', maint: '#ffc21f', fault: '#ff4d4d', stop: '#ff7a3d', off: '#5c6670' };
    x.fillStyle = '#020405'; x.fillRect(0, 0, W, H);
    // 머리줄: 제목 · 시각 · 상태별 대수
    const HH = 112;
    x.fillStyle = '#0d1a12'; x.fillRect(0, 0, W, HH);
    x.font = `900 58px ${F}`; x.fillStyle = '#ffb020'; x.textBaseline = 'middle'; x.textAlign = 'left';
    x.fillText('설비 현황판', 34, HH / 2); x.font = `700 30px ${MONO}`; x.fillStyle = '#c99a3a'; x.fillText('EQUIPMENT STATUS BOARD', 400, HH / 2 + 4);
    const s0 = Math.floor(sim.time) + 8 * 3600, clock = `${String(Math.floor(s0 / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s0 / 60) % 60).padStart(2, '0')}:${String(s0 % 60).padStart(2, '0')}`;
    const cnt = {}; for (const e of list) cnt[e.cls] = (cnt[e.cls] ?? 0) + 1;
    let cx = W - 34; x.textAlign = 'right';
    x.font = `700 44px ${MONO}`; x.fillStyle = '#3dff8a'; x.fillText(clock, cx, HH / 2); cx -= x.measureText(clock).width + 46;
    for (const k of ['off', 'stop', 'fault', 'maint', 'charge', 'idle', 'run']) {
      if (!cnt[k]) continue;
      const t = `${STATUS_CLASS[k]} ${cnt[k]}`; x.font = `800 38px ${F}`; x.fillStyle = COL[k]; x.fillText(t, cx, HH / 2); cx -= x.measureText(t).width + 18;
      x.beginPath(); x.arc(cx, HH / 2, 11, 0, Math.PI * 2); x.fill(); cx -= 40;
    }
    x.textAlign = 'right'; x.font = `700 30px ${F}`; x.fillStyle = '#7d8a95'; x.fillText(`전체 ${list.length}대 · ${sim.mode.label}`, cx, HH / 2);
    // 목록: 4열
    const cols = 4, rows = Math.ceil(list.length / cols), top = HH + 18, rh = Math.min(58, (H - top - 10) / Math.max(1, rows)), cw = W / cols;
    const fs = Math.max(22, Math.min(32, rh * 0.6));
    list.forEach((e, i) => {
      const c = Math.floor(i / rows), r = i % rows, x0 = c * cw + 24, y = top + r * rh + rh / 2;
      if (r % 2 === 0) { x.fillStyle = 'rgba(255,255,255,0.025)'; x.fillRect(c * cw + 8, top + r * rh, cw - 16, rh); }
      x.textAlign = 'left'; x.font = `800 ${fs}px ${MONO}`; x.fillStyle = '#ffb020'; x.fillText(e.uid, x0, y);
      x.font = `600 ${fs}px ${F}`; x.fillStyle = '#d7dde3'; let nm = e.name; while (x.measureText(nm).width > cw * 0.42 && nm.length > 3) nm = nm.slice(0, -2) + '…'; x.fillText(nm, x0 + fs * 5.4, y);
      const col = COL[e.cls] ?? '#8fb3c9', blink = (e.cls === 'fault' || e.cls === 'stop') && Math.floor(performance.now() / 500) % 2;
      x.fillStyle = blink ? 'rgba(255,255,255,0.15)' : col;
      x.textAlign = 'right'; x.font = `800 ${fs}px ${F}`; x.fillStyle = blink ? '#5a1a1a' : col; x.fillText(e.text, c * cw + cw - 30, y);
      x.beginPath(); x.arc(c * cw + cw - 30 - x.measureText(e.text).width - 18, y, fs * 0.22, 0, Math.PI * 2); x.fill();
      if (c) { x.fillStyle = 'rgba(255,176,32,0.18)'; x.fillRect(c * cw, top, 2, rows * rh); }
    });
    // LED 점 질감
    x.fillStyle = 'rgba(0,0,0,0.22)';
    for (let yy = 0; yy < H; yy += 4) x.fillRect(0, yy, W, 1);
    for (let xx = 0; xx < W; xx += 4) x.fillRect(xx, 0, 1, H);
    this.boardTex.needsUpdate = true;
  }

  // 건물 밖 트럭 야드 (뒷벽 바깥, 검은 외부): 아스팔트·도크 접안선·대기 자리·진출입 도로
  buildYard() {
    const r = this.root;
    const flat = (w, d, mat, x, z, y = 0.01) => { const m = put(new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat), x, y, z, r); m.rotation.x = -Math.PI / 2; m.receiveShadow = true; return m; };
    flat(34, 28, std(0x2b3036, { roughness: 0.95 }), 31, -34.2, -0.01);
    flat(110, 7, std(0x24282d, { roughness: 0.95 }), 62, YARD.roadZ, 0.0);
    const line = new THREE.MeshBasicMaterial({ color: 0xf2c230 }), white = new THREE.MeshBasicMaterial({ color: 0xd9dee4 });
    for (let x = 16; x < 116; x += 4) flat(2, 0.15, white, x, YARD.roadZ, 0.02);
    for (const bx of YARD.bays) for (const sd of [-1, 1]) flat(0.15, 12, line, bx + sd * 1.7, -26.4, 0.02);
    for (const sd of [-1, 1]) for (let z = -21; z > -33; z -= 1.6) flat(0.12, 0.8, white, YARD.waitX + sd * 1.6, z, 0.02);
    // 입고 트럭 야드 (왼쪽 벽 바깥): 바닥, 남북 도로(북행 입차·남행 출차), 서쪽 진입로, 도크 앞 정차선, 표시
    flat(42, 42, std(0x2b3036, { roughness: 0.95 }), -72, -24, -0.01);   // 서쪽으로 돌아 도크 중심선에 서는 공간까지
    flat(9, 36, std(0x24282d, { roughness: 0.95 }), INBOUND.roadX, -24, 0.0);
    flat(140, 7, std(0x24282d, { roughness: 0.95 }), -63, INBOUND.roadZ, 0.0);
    for (let x = -132; x < 7; x += 4) flat(2, 0.15, white, x, INBOUND.roadZ, 0.02);
    for (let z = -38; z < -6; z += 4) flat(0.15, 2, white, INBOUND.roadX, z, 0.02);
    for (const sd of [-1, 1]) flat(12, 0.15, line, INBOUND.wallX - 6.2, INBOUND.dockZ + sd * 1.7, 0.02);
    { const c2 = document.createElement('canvas'); c2.width = 1024; c2.height = 128;
      const g2 = c2.getContext('2d'); g2.fillStyle = 'rgba(61,220,132,0.95)'; g2.font = '700 64px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
      g2.fillText('입고 트럭 야드 · 입고 도크', 512, 64);
      const t2 = new THREE.CanvasTexture(c2); t2.colorSpace = THREE.SRGBColorSpace;
      const m2 = flat(14, 1.75, new THREE.MeshBasicMaterial({ map: t2, transparent: true, depthWrite: false }), -60, -21.5, 0.03); m2.rotation.z = 0; }
    const tx = document.createElement('canvas'); tx.width = 1024; tx.height = 128;
    const c = tx.getContext('2d'); c.fillStyle = 'rgba(242,194,48,0.95)'; c.font = '700 64px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('출하 트럭 야드 · 도크 1 · 대기 · 도크 2', 512, 64);
    const tex = new THREE.CanvasTexture(tx); tex.colorSpace = THREE.SRGBColorSpace;
    flat(16, 2, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), YARD.waitX, -35.2, 0.03);
  }

  // 물류 선반 칸 내용 (제품별 실물 모델 · 부품 토트) — Blender 모델은 앱 시작 후 불러오므로 화면을 만들 때마다(setup) 다시 채운다
  buildWhStock() {
    const { LV, COLS, group: G } = this.whRack;
    G.clear(); this.whRawSlots = []; this.whPartSlots = []; this.whRawShown = this.whPartsShown = undefined;
    const models = blenderOn() && RENDER.assets.eaxle && RENDER.assets.doortrim;
    const one = (name, m4, skip) => { const st = instancedStock(bakedOf(name, skip), m4); return st.group; };
    for (const y of LV) for (const c of COLS) {
      const x = c.x;
      put(box(2.0, 0.12, 1.6, MAT.pallet), x, y + 0.11, 0, G);
      if (c.kind === 'raw') {
        let lo, hi;
        if (models && c.p === 'doortrim') {   // 도어트림: 2장 × 3줄씩 세워 꽂음 (앞면 = 동쪽) — 앞 3줄 lo · 뒤 3줄 hi
          const rows = (zs) => zs.flatMap((z) => [-0.44, 0.44].map((dx) => new THREE.Matrix4().makeTranslation(x + dx, y + 0.17, z)));
          lo = one('doortrim', rows([0.55, 0.36, 0.17])); hi = one('doortrim', rows([-0.02, -0.21, -0.4])); G.add(lo, hi);
        } else if (models) {                  // e-axle: 축을 깊이 방향으로 3개씩 2단 (아래 lo · 위 hi)
          const row = (yy) => [-0.64, 0, 0.64].map((dx) => new THREE.Matrix4().makeTranslation(x + dx, yy, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
          const skip = (o) => o.name === 'FastenBolts';
          lo = one('eaxle', row(y + 0.17), skip); hi = one('eaxle', row(y + 0.76), skip); G.add(lo, hi);
        } else {
          const mat = c.p === 'eaxle' ? MAT.crate : MAT.raw;
          lo = put(box(1.8, 0.42, 1.4, mat), x, y + 0.38, 0, G); hi = put(box(1.8, 0.42, 1.4, mat), x, y + 0.82, 0, G);
        }
        this.whRawSlots.push({ lo, hi, y });
      } else {
        const bins = [], tote = std(c.p === 'eaxle' ? 0x6f5bd6 : 0xe08a2a);   // 제품별 부품 토트 (도어트림 주황 · e-axle 보라)
        for (let k = 0; k < 6; k++) bins.push(put(box(0.56, 0.36, 0.62, tote), x - 0.62 + (k % 3) * 0.62, y + 0.37, -0.34 + Math.floor(k / 3) * 0.68, G));
        fillBins(bins, cellParts({ id: c.p === 'eaxle' ? 'EA_ASSY' : 'DT_ASSY' }));
        this.whPartSlots.push({ bins, y });
      }
    }
    this.whRawSlots.sort((a, b) => a.y - b.y); this.whPartSlots.sort((a, b) => a.y - b.y);
  }

  // 정비실 비품: 뒤쪽(+z, 앞면이 실내를 봄) 캐비닛 · 공구 카트 · 작업대(공구 타공판) · 소모품 선반 · 에어 컴프레서, 오른쪽 확장 구역에 청소도구,
  // 왼쪽에 소화기 — 양쪽 끝은 정비 휴머노이드 충전 스테이션, 가운데는 비워 통로·바닥 표시가 보이게 한다
  buildTechFurniture() {
    const G = this.techFurn; G.clear();
    const M = RENDER.assets.maint;
    if (!blenderOn() || !M) {   // Blender 모델이 없으면 기본 상자: 공구함(빨강) · 작업대(회색)
      put(box(0.6, 1.8, 1.6, std(0xc0392b)), -2.15, 0.9, -1.4, G); put(box(0.7, 0.9, 1.6, MAT.steel), 2.15, 0.45, -1.4, G); return;
    }
    const place = (name, x, z, ry = Math.PI) => { const o = M.getObjectByName(name).clone(); o.position.set(x, 0, z); o.rotation.set(0, ry, 0); G.add(o); return o; };
    place('M_Locker', -2.0, -0.05); place('M_ToolChest', -1.15, 0.0); place('M_Workbench', 0.35, -0.2);
    place('M_Shelf', 1.95, -0.05); place('M_Compressor', 3.1, -0.15); place('M_Cleaning', 4.35, -0.55);
    place('M_Extinguisher', -2.25, -1.0, Math.PI / 2);   // (A형 사다리는 쓰는 작업이 없어 두지 않는다)
  }

  buildAreas() {
    const r = this.root;
    // 자재 공급 차질 경보: 자재창고 랙 주변
    this.whAlarm = put(makeAlarmFx(12.4, 4.6, 5.2), WH_RACK.x + 0.6, 0, WH_RACK.z, r); this.whAlarm.rotation.y = Math.PI / 2;
    // 물류 선반(자재창고 랙): 왼쪽 2열 × 3단 = 원자재 6칸, 오른쪽 2열 × 3단 = 부품 6칸 (한 칸 = 입고 팔레트 1개)
    // 원자재 칸은 박스 2단(20박스씩 = AGV 1회분), 부품 칸은 부품 빈 6개(40개씩) — 재고만큼 차고 배달할수록 줄어든다
    // 왼쪽 확장동 물류존: 선반을 왼쪽 벽에 붙여 남북으로 세운다 (로컬 −x 원자재 → 남쪽, +x 부품 → 북쪽, 앞면 = 동쪽)
    const rack = new THREE.Group(); put(rack, WH_RACK.x, 0, WH_RACK.z, r); rack.rotation.y = Math.PI / 2;
    this.whRawSlots = []; this.whPartSlots = []; this.whOut = false;
    this.whSign = put(makeSignSprite('⛔ 출고 중단 · 공급 차질', '#ff8a1f', 7.5), WH_RACK.x + 1.2, 7.4, WH_RACK.z, r); this.whSign.visible = false;
    // AS/RS(셔틀식 자동창고) 구조: 칸마다 기둥 · 단마다 앞뒤 로드 빔과 셔틀 레일 · 끝면 X 브레이싱 · 상부 크라운 프레임
    // 가운데(로컬 x 0)는 수직 리프트 · 단마다 셔틀이 레일을 오가며 칸 ↔ 리프트를 옮기고, 리프트 아래 동쪽(로컬 +z)에 반출 컨베이어
    // 열 배치: 원자재(남쪽) 도어트림 · e-axle, 부품(북쪽) 도어트림 부품 · e-axle 부품 — 제품별로 따로 보관
    const LV = [0.3, 1.9, 3.5], COLS = [{ x: -3.85, kind: 'raw', p: 'doortrim' }, { x: -1.55, kind: 'raw', p: 'eaxle' }, { x: 1.55, kind: 'parts', p: 'doortrim' }, { x: 3.85, kind: 'parts', p: 'eaxle' }];
    for (const x of [-5.0, -2.7, -0.45, 0.45, 2.7, 5.0]) for (const z of [-1, 1]) put(box(0.12, 5.2, 0.12, MAT.accent), x, 2.6, z, rack);
    for (const x of [-5.0, 5.0]) for (const [y0, sg] of [[0.3, 1], [2.7, -1]]) {   // 끝면 X 브레이싱
      for (const sd of [-1, 1]) { const br = put(box(0.04, 2.6, 0.04, MAT.steel), x, y0 + 1.2, 0, rack); br.rotation.x = sd * sg * 0.72; }
    }
    for (const z of [-1, 1]) put(box(10.2, 0.14, 0.12, MAT.accent), 0, 5.15, z, rack);                       // 크라운 프레임
    for (const x of [-5.0, -2.7, 0, 2.7, 5.0]) put(box(0.1, 0.1, 2.1, MAT.accent), x, 5.15, 0, rack);
    const shuttles = [];
    for (const y of LV) {
      for (const sd of [-1, 1]) {   // 리프트 양쪽 칸 구역 (가운데 리프트 칸 제외)
        for (const z of [-0.95, 0.95]) put(box(4.5, 0.12, 0.08, MAT.orange), sd * 2.72, y, z, rack);   // 앞뒤 로드 빔
        for (const z of [-0.18, 0.18]) put(box(4.5, 0.04, 0.05, MAT.steel), sd * 2.72, y + 0.02, z, rack);   // 셔틀 레일
        const sh = put(new THREE.Group(), sd * 2.7, y + 0.05, 0, rack); sh.userData.x0 = sd * 2.7;   // 셔틀 (칸 아래를 오감)
        put(box(0.9, 0.09, 0.62, MAT.orange), 0, 0.045, 0, sh);
        put(box(0.06, 0.03, 0.5, emis(0x3ddc84, 1.6), false), 0.46, 0.05, 0, sh);
        shuttles.push(sh);
      }
    }
    for (const x of [-0.45, 0.45]) for (const z of [-0.6, 0.6]) put(box(0.06, 5.0, 0.06, MAT.steel), x * 0.8, 2.6, z, rack);   // 리프트 가이드
    const lift = put(new THREE.Group(), 0, 0.3, 0, rack);
    put(box(0.7, 0.08, 1.3, MAT.orange), 0, 0, 0, lift);
    for (const x of [-0.3, 0.3]) put(box(0.04, 0.05, 1.2, MAT.steel), x, 0.06, 0, lift);
    put(box(0.8, 0.3, 0.8, MAT.dark), 0, 5.4, 0, rack);   // 리프트 구동부
    const io = put(new THREE.Group(), 0, 0, 1.25, rack);   // 반출 컨베이어 (동쪽, AGV·휴머노이드 쪽)
    put(box(0.8, 0.5, 0.5, MAT.dark), 0, 0.25, 0, io); put(box(0.85, 0.06, 0.55, MAT.steel), 0, 0.53, 0, io);
    for (let k = 0; k < 5; k++) put(cyl(0.03, 0.03, 0.8, MAT.steel, 10), 0, 0.57, -0.2 + k * 0.1, io).rotation.z = Math.PI / 2;
    this.asrs = { shuttles, lift };
    this.whRack = { rack, LV, COLS, group: put(new THREE.Group(), 0, 0, 0, rack) };
    this.buildWhStock();
    // 열 표지 (동쪽 면, 각 열 위)
    COLS.forEach((c) => put(makeSignSprite(c.p === 'eaxle' ? 'e-axle' : '도어트림', c.p === 'eaxle' ? '#b89bff' : '#ffb35a', 1.5), WH_RACK.x + 1.25, 4.75, WH_RACK.z - c.x, r));
    // 원자재 칸이 아래 단부터 차도록 정렬 (단 → 열)
    this.whRawSlots.sort((a, b) => a.y - b.y); this.whPartSlots.sort((a, b) => a.y - b.y);
    // 선반 앞 표지
    put(makeSignSprite('원자재', '#c9d2dc', 2.2), WH_RACK.x + 1.2, 5.3, WH_RACK.z + 2.5, r);
    put(makeSignSprite('부품', '#5aa9ff', 2.2), WH_RACK.x + 1.2, 5.3, WH_RACK.z - 2.5, r);
    // 물류 선반 재고 현황판 (선반 위 왼쪽 벽, 동쪽을 향함): 재고 막대 · 입고 순환 상태 · 입출고 횟수
    const sc = document.createElement('canvas'); sc.width = 1536; sc.height = 420;
    this.whBoard = { cv: sc, tex: new THREE.CanvasTexture(sc), key: '' }; this.whBoard.tex.colorSpace = THREE.SRGBColorSpace; this.whBoard.tex.anisotropy = 8;
    const bd = put(new THREE.Group(), INBOUND.wallX + 0.3, 6.25, WH_RACK.z, r); bd.rotation.y = Math.PI / 2;
    put(box(10.4, 2.95, 0.12, std(0x0b0d10, { roughness: 0.5, metalness: 0.4 })), 0, 0, -0.07, bd);
    put(new THREE.Mesh(new THREE.PlaneGeometry(10, 2.73), new THREE.MeshBasicMaterial({ map: this.whBoard.tex, toneMapped: false })), 0, 0, 0, bd);
    bd.traverse((o) => (o.castShadow = false));   // 왼쪽 벽에 붙은 재고 현황판도 그림자 없음
    // 드론 이착륙·충전 패드 (피지컬AI 단계에서만 보임)
    // 드론마다 이착륙·충전 패드 (H1·H2·H3…, 3m 간격) — 운용 대수만큼 보인다
    this.dronePads = [0, 1, 2, 3].map((i) => {
      const p = dronePad(i), g = put(new THREE.Group(), p.x, 0, p.z, r);
      const padC = document.createElement('canvas'); padC.width = padC.height = 256;
      const pc = padC.getContext('2d'); pc.fillStyle = '#1d2a3a'; pc.beginPath(); pc.arc(128, 128, 124, 0, Math.PI * 2); pc.fill();
      pc.strokeStyle = '#37e8ff'; pc.lineWidth = 10; pc.beginPath(); pc.arc(128, 128, 110, 0, Math.PI * 2); pc.stroke();
      pc.fillStyle = '#ffffff'; pc.font = '900 120px sans-serif'; pc.textAlign = 'center'; pc.textBaseline = 'middle'; pc.fillText(`H${i + 1}`, 128, 136);
      const padTex = new THREE.CanvasTexture(padC); padTex.colorSpace = THREE.SRGBColorSpace;
      const pad = put(new THREE.Mesh(new THREE.CircleGeometry(1.1, 40), new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.7 })), 0, 0.02, 0, g); pad.rotation.x = -Math.PI / 2;
      put(box(0.5, 0.25, 0.3, MAT.dark), 1.35, 0.125, 0, g);   // 무선 충전기
      g.visible = false; return g;
    });
    // 충전소
    this.chargers = [];
    for (let i = 0; i < 4; i++) {
      const L = chgLoc(i);
      const pad = put(new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.4), std(0x2b4a3a)), L.x, 0.012, L.z, r); pad.rotation.x = -Math.PI / 2;
      const post = put(box(0.4, 1.3, 0.3, MAT.white), L.x, 0.65, L.z + 1.5, r);
      const m = emis(0x3dff8a, 1.5);
      put(box(0.25, 0.25, 0.02, m, false), 0, 0.3, -0.16, post);
      this.chargers.push({ group: pad, post, m });
    }
    // 정비실
    // 정비실: 오른쪽(드론 패드 H1 쪽)으로 확장 — H1 패드 왼쪽 가장자리(x 19.4)에서 바닥 1.5칸(1.5m) 앞까지 (로컬 x −2.5 ~ +5.1)
    const tech = (this.tech = put(new THREE.Group(), LOC.TECH.x + 0.8, 0, 16.5, r));
    put(box(7.6, 0.02, 3.5, std(0x6b4a2a)), 1.3, 0.01, -1.5, tech);
    this.techFurn = put(new THREE.Group(), 0, 0, 0, tech);   // 비품 (Blender 모델은 앱 시작 후 불러오므로 setup마다 다시 채움)
    this.buildTechFurniture();
    // 정비실 바닥 표시 (단계별 문구: 레거시·자동화 — 정비원, 피지컬AI — 정비 휴머노이드) + 뒤쪽 표지판
    const textTex = (lines, w, h, { bg, fg, sub, border }) => {
      const c = document.createElement('canvas'); c.width = 1024; c.height = Math.round(1024 * h / w);
      const x = c.getContext('2d'), F = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
      if (bg) { x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); }
      if (border) { x.strokeStyle = border; x.lineWidth = c.height * 0.06; x.strokeRect(c.height * 0.04, c.height * 0.04, c.width - c.height * 0.08, c.height - c.height * 0.08); }
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillStyle = fg; x.font = `900 ${c.height * 0.38}px ${F}`; x.fillText(lines[0], c.width / 2, c.height * (lines[1] ? 0.4 : 0.52));
      if (lines[1]) { let fs = c.height * 0.2; x.font = `700 ${fs}px ${F}`; while (x.measureText(lines[1]).width > c.width * 0.88) { fs *= 0.94; x.font = `700 ${fs}px ${F}`; } x.fillStyle = sub; x.fillText(lines[1], c.width / 2, c.height * 0.76); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
    };
    this.techMarks = {};
    for (const [k, sub] of [['human', '정비원 대기 · 고장 수리 · 예지정비'], ['humanoid', '정비 휴머노이드 대기 · 고장 수리 · 예지정비']]) {
      const m = put(new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.0), new THREE.MeshBasicMaterial({ map: textTex(['🔧 정비실', sub], 3.4, 1.0, { fg: 'rgba(255,255,255,0.92)', sub: 'rgba(255,214,140,0.95)', border: 'rgba(242,194,48,0.9)' }), transparent: true, depthWrite: false })), 1.3, 0.03, -1.5, tech);   // 정비실 구역 정중앙
      m.rotation.x = -Math.PI / 2; m.visible = false; this.techMarks[k] = m;
    }
    // 관제/서버
    const srv = (this.server = put(new THREE.Group(), LOC.CTRL.x, 0, -17.5, r));   // 관제 서버 랙: 중앙 관제 디스플레이 가운데 아래
    this.serverLeds = [];
    for (const x of [-1.6, -0.5, 0.6, 1.7]) {
      const rk = put(box(0.9, 2.3, 1.0, MAT.dark), x, 1.15, 0, srv);
      for (let k = 0; k < 6; k++) {
        const m = emis(k % 2 ? 0x3dff8a : 0x2aa8ff, 2);
        this.serverLeds.push(m);
        put(box(0.6, 0.04, 0.02, m, false), 0, -0.8 + k * 0.32, 0.51, rk);
      }
    }
    this.serverPos = new THREE.Vector3(LOC.CTRL.x, 2.6, -17);
    // 디지털 트윈 대형 화면
    const c = document.createElement('canvas'); c.width = 2016; c.height = 448;   // 18×4m (4.5:1)
    this.screenCanvas = c;
    this.screenTex = new THREE.CanvasTexture(c); this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const scrMat = new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false });
    // 벽 기둥 앞(z -19.15)에 설치 — 18×4m: 높이는 양옆 CCTV 전광판·로봇 디스플레이(12×4m)와 같고 폭만 1.5배
    // 뒷벽 왼쪽 두 번째 기둥(x −36) ~ 오른쪽 네 번째 기둥(x 9) 사이: CCTV 전광판(x −29.325) → 관제 화면 → 로봇 디스플레이(x 2.325), 기둥·화면 사이 간격 모두 0.525m
    this.screen = put(new THREE.Mesh(new THREE.PlaneGeometry(18, 4), scrMat), LOC.CTRL.x, 5.1, -19.15, r);
    put(new THREE.Mesh(new THREE.BoxGeometry(18.3, 4.3, 0.12), std(0x14181e, { roughness: 0.6, metalness: 0.3 })), 0, 0, -0.08, this.screen);
    // 관제 데스크
    put(box(3.5, 0.8, 1.0, MAT.white), LOC.CTRL.x, 0.4, LOC.CTRL.z - 1.4, srv.parent);
  }

  // 모드별 설비/인원/조명 구성
  setup(sim, labelsOn = true, changed = null) {
    this.buildWhStock(); this.buildTechFurniture();
    this.sim = sim;
    const mode = sim.mode.key;
    // CSS2DRenderer는 씬에서 제거된 라벨의 DOM을 지우지 않으므로 직접 제거
    for (const v of [...this.stationViews, ...(this.vehicleViews ?? []), ...(this.techViews ?? []), ...(this.helperViews ?? []), ...(this.quadViews ?? []), ...(this.droneViews ?? []), ...(this.truckViews?.values() ?? [])]) {
      const l = v.label ?? v.lbl; l.removeFromParent(); l.element.remove();
    }
    this.truckViews = new Map(); this.labelsOn = labelsOn; this.idPlates = [];
    for (const sv of this.stationViews) { this.root.remove(sv.group); if (sv.alarm) this.root.remove(sv.alarm); }
    for (const c of this.convGroups ?? []) this.root.remove(c);
    if (this.zoneDeco) { this.root.remove(this.zoneDeco); this.zoneDeco = null; }
    this.dyn.clear();
    this.itemMeshes.clear(); this.itemPool = []; this.flyers = []; this.packets = [];
    this.stationViews = []; this.conveyorTex = []; this.convGroups = [];
    while (this.iot.children.length) this.iot.remove(this.iot.children[0]);

    for (const st of [...sim.stations, ...sim.standby]) {
      const g = new THREE.Group(); g.position.set(st.x, 0, st.z); g.rotation.y = st.rot;
      g.scale.z = st.def.side ?? 1;
      st.zone = sim.zone;
      st.vla = mode === 'dark';   // 피지컬AI: 카메라 기반 VLA로 선반에서 부품을 집어 조립·체결
      if (sim.useAMR) cellBase(g, st.type === 'source' || st.type === 'sink' ? 3.6 : 4.6);
      else this.conveyorTex.push(stationBase(g, st.type === 'source' || st.type === 'sink' ? 3.6 : 4.2).map);
      const parts = BUILDERS[st.type](g, st, sim);
      const { group: robotGroup, robots, racks } = placeRobots(g, st);
      parts.robots = robots; parts.racks = racks;
      // 셀 로봇 고유 ID 명판 (로봇 위, 라벨 버튼으로 켜고 끔)
      robots.forEach((rb, i) => { const uid = st.robotUids?.[i]; if (!uid) return; const sp = idPlate(uid); sp.position.set(0, rb.kind === 'ammr' ? 2.55 : 2.35, 0); rb.root.add(sp); this.idPlates.push(sp); sp.visible = labelsOn; });
      if (parts.arms) Object.values(parts.arms).forEach((A, i) => { const uid = sim.sinkRobotUids?.[i]; if (!uid) return; const sp = idPlate(uid); sp.position.set(0, 3.3, 0); A.arm.root.add(sp); this.idPlates.push(sp); sp.visible = labelsOn; });
      const vlaCell = st.vla && parts.robots?.some((r) => r.vla);
      if (vlaCell) for (const f of parts.feeders ?? []) f.visible = false;   // 로봇별 부품 선반으로 대체
      const light = vlaCell ? put(makeStackLight(), 0.1, 0.15, -2.1, g) : put(makeStackLight(), -1.9, 0.15, -1.6, g);
      g.traverse((o) => { o.userData.stationId = st.id; });
      g.userData.stationId = st.id;
      const autoVisible = mode !== 'traditional';
      robotGroup.visible = autoVisible;
      if (parts.auto) parts.auto.visible = autoVisible;
      if (parts.manual) parts.manual.visible = !autoVisible;
      if (parts.manualProps) parts.manualProps.forEach((p) => (p.visible = !autoVisible));
      // 라벨
      const el = document.createElement('div');
      el.className = 'st-label';
      const rb = st.def.robot?.count ? `${ROBOT_KINDS[st.def.robot.kind].short}×${st.def.robot.count}` : '';
      const cell = ZONE_CELLS[st.id.split('@')[0]];
      const use = cell && st.type !== 'source' && st.type !== 'sink' ? `<div class="use u-${cellUse(st.id.split('@')[0])}">${cell.use}</div>` : '';
      el.innerHTML = `<div class="nm">${cell && use ? `<b class="no">${cell.no}</b>` : ''}<span></span>${st.uid ? `<i class="uid">${st.uid}</i>` : ''}</div>${use}<div class="row"><span class="chip"></span><span class="hp"><i></i></span></div>${rb && mode !== 'traditional' ? `<div class="rb">🤖 ${rb}</div>` : ''}${(st.type === 'sort' || st.type === 'pack') && this.sim.zone ? '<div class="gd"></div>' : ''}`;
      el.classList.toggle('changed', !!changed?.has(st.id));
      el.classList.toggle('standby', !!st.standby);
      const label = new CSS2DObject(el); label.position.set(0, 4.3, 0); g.add(label);
      label.visible = labelsOn;
      // IoT 노드
      const sensorMat = emis(0x37e8ff, 2.5);
      const sp = toWorld(st.def, 1.7, -1.4);
      const sensor = put(mesh(new THREE.SphereGeometry(0.12, 12, 10), sensorMat, false), sp.x, 3.2, sp.z, this.iot);
      const ringM = new THREE.MeshBasicMaterial({ color: 0x37e8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
      const pulse = put(new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 24), ringM), sp.x, 3.2, sp.z, this.iot);
      pulse.lookAt(sp.x, 10, sp.z);
      this.root.add(g);
      // 설비 고장(·투입구는 공급 차질) 경보 — 셀 바닥 크기에 맞춘 테두리와 경광등
      const alarm = makeAlarmFx(st.type === 'source' || st.type === 'sink' ? 4.2 : 5.4, 5.4, 4.6);
      this.root.add(alarm); alarm.position.set(st.x, 0, st.z);
      this.stationViews.push({ st, group: g, parts, light, label, el, sensor, pulse, ringM, sensorMat, alarm, phase: Math.random() * 6 });
    }
    if (isZone(sim.line)) this.buildZoneDeco(sim);
    this.iot.visible = mode !== 'traditional';
    this.server.visible = mode !== 'traditional';
    for (const f of this.facadeSigns) f.visible = mode === 'dark';   // 외벽 "피지컬AI 실증 메타팩토리" 사인은 피지컬AI 단계에서만
    this.screen.visible = mode !== 'traditional';
    this.buildLogistics(sim);
    this.buildCCTV(sim);
    this.build5G(sim);
    this.cctvG.traverse((o) => (o.castShadow = false));   // 천장 CCTV(카메라·지지대)는 바닥에 그림자를 드리우지 않는다
    this.techMarks.human.visible = sim.mode.techKind !== 'humanoid'; this.techMarks.humanoid.visible = sim.mode.techKind === 'humanoid';

    // 컨베이어 (경로를 따라 직선 구간별로 생성, 코너는 겹쳐서 이음). 미사용 분기는 멈춘 채 어둡게
    const idle = sim.idleLinks.map((l) => ({ from: l.from, to: l.to, path: l.path, idle: true }));
    for (const c of [...sim.conveyors, ...idle]) {
      if (sim.useAMR) { this.buildGuide(c); continue; }
      const startTrim = c.from.type === 'source' ? 1.8 : 2.1, endTrim = c.to.type === 'sink' ? -0.2 : 0.1;
      const pts = trimPath(c.path, startTrim, endTrim);
      const g = new THREE.Group();
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
        if (L < 0.05) continue;
        const ext0 = i > 1 ? 0.5 : 0, ext1 = i < pts.length - 1 ? 0.5 : 0;
        const len = L + ext0 + ext1;
        const seg = new THREE.Group();
        const mid = (L + ext1 - ext0) / 2;
        seg.position.set(a.x + (dx / L) * mid, 0, a.z + (dz / L) * mid);
        seg.rotation.y = Math.atan2(-dz, dx);
        const tex = BELT_TEX.clone(); tex.repeat.set(len / 0.5, 1); tex.needsUpdate = true;
        const beltMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, color: c.idle ? 0x777777 : 0xffffff });
        put(box(len, 0.1, 1.0, [MAT.dark, MAT.dark, beltMat, MAT.dark, MAT.dark, MAT.dark]), 0, BELT_Y - 0.05, 0, seg);
        for (const sd of [-1, 1]) put(box(len, 0.12, 0.08, MAT.steel), 0, BELT_Y + 0.02, sd * 0.56, seg);
        for (let x = -len / 2 + 0.4; x <= len / 2 - 0.3; x += 1.6) for (const sd of [-1, 1]) put(box(0.08, BELT_Y - 0.1, 0.08, MAT.dark), x, (BELT_Y - 0.1) / 2, sd * 0.45, seg);
        if (!c.idle) this.conveyorTex.push(tex);
        g.add(seg);
      }
      this.root.add(g); this.convGroups.push(g);
    }
    // 차량
    this.vehicleViews = [...sim.vehicles, ...(sim.forklifts ?? [])].map((v) => {
      const g = v.kind === 'agv' ? makeAGV() : makeForklift();
      if (v.auto) { g.userData.driver.visible = false; g.userData.beacon.visible = true; }   // 자율 지게차: 운전자 없음
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const el = document.createElement('div'); el.className = 'v-label';
      const lbl = new CSS2DObject(el); lbl.position.set(0, v.kind === 'agv' ? 1.6 : 2.8, 0); g.add(lbl);
      lbl.visible = labelsOn;
      this.dyn.add(g);
      return { v, g, el, lbl, yaw: v.heading };
    });
    this.carrierViews = sim.carriers.map((c) => {
      const g = makeCarrierAMR();
      this.dyn.add(g);
      return { v: c, g, yaw: c.heading };
    });
    this.techViews = sim.techs.map((t) => {
      const g = t.kind === 'robot' ? makeMaintBot() : t.kind === 'humanoid' ? makeHumanoid(0xff8a2a) : makeWorker(0xff6a00, std(0xff6a00, { emissive: 0x331100 }));
      const el = document.createElement('div'); el.className = 'v-label tech';
      const lbl = new CSS2DObject(el); lbl.position.set(0, t.kind === 'robot' ? 1.4 : 2.4, 0); g.add(lbl);
      lbl.visible = labelsOn;
      this.dyn.add(g);
      return { v: t, g, el, lbl, yaw: t.heading, px: t.x, pz: t.z };
    });
    // 무인공장: 부품 보충 휴머노이드(파랑)·사족보행 순찰 로봇
    const robotView = (v, g, h, cls) => {
      const el = document.createElement('div'); el.className = `v-label ${cls}`;
      const lbl = new CSS2DObject(el); lbl.position.set(0, h, 0); g.add(lbl);
      lbl.visible = labelsOn;
      this.dyn.add(g);
      return { v, g, el, lbl, yaw: v.heading, px: v.x, pz: v.z };
    };
    this.helperViews = sim.helpers.map((h) => robotView(h, makeHumanoid(0x2aa8ff), 2.4, 'helper'));
    // 휴머노이드 충전 도크: 정비 휴머노이드·물류 휴머노이드 대기 자리마다 (등 쪽 = 대기 방향의 반대)
    this.humanoidDocks = [...sim.techs, ...sim.helpers].filter((m) => m.kind === 'humanoid' && m.home).map((m) => {
      const d = makeHumanoidDock(); d.position.set(m.home.x, 0, m.home.z); d.rotation.y = m.home.heading ?? 0; this.dyn.add(d);
      return { d, m };
    });
    this.quadViews = sim.quads.map((q) => robotView(q, makeQuadruped(), 1.5, 'quad'));
    this.droneViews = (sim.drones ?? []).map((d) => robotView(d, makeDrone(), 0.7, 'drone'));
    this.dronePads.forEach((g, i) => (g.visible = i < (sim.drones ?? []).length));
    this.workerViews = sim.workers.map((w) => {
      const hat = { 반장: 0xffffff, 모니터링: 0x2aa8ff, 관제: 0x2aa8ff, 검사원: 0x9b59b6 }[w.role] ?? 0xf2c230;
      const g = makeWorker(hat, w.role === '모니터링' || w.role === '관제' ? std(0x2a6fdb) : MAT.hiVis);
      this.dyn.add(g);
      return { v: w, g, yaw: w.heading, px: w.x, pz: w.z };
    });
    // 클릭으로 로봇을 고를 수 있게 이동 로봇 모델에 ID 표시 (사람은 제외)
    for (const vv of [...this.vehicleViews, ...this.carrierViews, ...this.techViews, ...this.helperViews, ...this.quadViews, ...this.droneViews]) {
      if (vv.v.kind === 'human') continue;
      vv.g.traverse((o) => { o.userData.moverId = vv.v.id; });
    }
    this.telemetry = null;
    this.robotLogs = new Map();   // 로봇별 정밀 기록 (새 실행마다 초기화)
    if (!this.selRing) {
      this.selRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 40), new THREE.MeshBasicMaterial({ color: 0x37e8ff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
      this.selRing.rotation.x = -Math.PI / 2; this.scene.add(this.selRing);
    }
    this.selRing.visible = false;
    this.labelsVisible = labelsOn;
  }

  // 클릭한 메시 → 선택 대상 (셀 로봇·이동 로봇·라인 위 AMR·설비)
  pick(hits) {
    for (const h of hits) {
      let o = h.object;
      while (o) {
        const u = o.userData;
        if (u.robotIdx != null && u.stationId) return { type: 'cell', stationId: u.stationId, idx: u.robotIdx };
        if (u.moverId) return { type: 'mover', id: u.moverId };
        if (u.cctvId) return { type: 'cctv', id: u.cctvId };
        if (u.gnbId) return { type: 'gnb', id: u.gnbId };
        if (u.itemId != null) {
          const it = [...this.sim.conveyors.flatMap((c) => c.items.map((e) => e.item)), ...this.sim.processing.map((st) => st.item)].find((x) => x?.id === u.itemId);
          if (it?.carrier) return { type: 'mover', id: it.carrier.id };
        }
        if (u.stationId && !o.parent?.userData.stationId) return { type: 'station', id: u.stationId };
        o = o.parent;
      }
    }
    return null;
  }
  pickTargets() {
    return [...this.stationViews.map((s) => s.group), this.dyn, ...(this.cctvG ? [this.cctvG] : []), ...(this.netG?.visible ? [this.netG] : [])];
  }
  selectRobot(ref) {
    this.telemetry = ref ? new RobotTelemetry(this, ref) : null;
    this.selRing.visible = !!ref;
  }

  // AMR 유도 경로 (바닥 테이프): 셀 중앙 → 다음 셀 중앙. 미사용 분기는 회색
  buildGuide(c) {
    const g = new THREE.Group();
    const mat = c.idle ? new THREE.MeshBasicMaterial({ color: 0x5b6670 }) : new THREE.MeshBasicMaterial({ color: 0x37e8ff, transparent: true, opacity: 0.8 });
    const pts = trimPath(c.path, c.from.type === 'source' ? 1.8 : 2.3, -2.3 + 2);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      const seg = put(new THREE.Group(), (a.x + b.x) / 2, 0, (a.z + b.z) / 2, g);
      seg.rotation.y = Math.atan2(-dz, dx);
      for (const sd of [-0.5, 0.5]) { const m = put(new THREE.Mesh(new THREE.PlaneGeometry(L + 0.1, 0.07), mat), 0, 0.016, sd, seg); m.rotation.x = -Math.PI / 2; }
      if (!c.idle) for (let x = -L / 2 + 0.6; x < L / 2 - 0.3; x += 1.6) {
        const ch = put(new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), mat), x, 0.016, 0, seg);   // 진행 방향 표시
        ch.rotation.x = -Math.PI / 2; ch.rotation.z = Math.PI / 4; ch.scale.set(1, 0.35, 1);
      }
    }
    this.root.add(g); this.convGroups.push(g);
  }

  // 정밀조립Zone 바닥 표시: Zone 경계선, 셀별 패드(공동·공용/도어트림/e-axle 색), Zone 이름
  buildZoneDeco(sim) {
    const g = (this.zoneDeco = new THREE.Group()); this.root.add(g);
    const flat = (w, d, mat, x, z, y = 0.008) => { const m = put(new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat), x, y, z, g); m.rotation.x = -Math.PI / 2; m.receiveShadow = true; return m; };
    const edge = new THREE.MeshBasicMaterial({ color: 0x37e8ff, transparent: true, opacity: 0.55 });
    const X0 = -31, X1 = 31.5, Z0 = -7.3, Z1 = 7.3;
    for (let x = X0; x < X1; x += 1.6) for (const z of [Z0, Z1]) flat(Math.min(1.0, X1 - x), 0.12, edge, x + 0.5, z, 0.012);
    for (let z = Z0; z < Z1; z += 1.6) for (const x of [X0, X1]) flat(0.12, Math.min(1.0, Z1 - z), edge, x, z + 0.5, 0.012);
    for (const [id, cell] of Object.entries(ZONE_CELLS)) {
      const col = ZONE_COLOR[cellUse(id)];
      flat(5.0, 4.6, new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.3, roughness: 0.9, depthWrite: false }), cell.x, cell.z, 0.01);
    }
    const decal = (text, color, w, x, z, size = 64) => {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
      const g2 = c.getContext('2d');
      g2.fillStyle = color; g2.font = `bold ${size}px sans-serif`; g2.textBaseline = 'middle';
      g2.fillText(text, 12, 64);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      return flat(w, w / 8, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), x, z, 0.014);
    };
    const mix = ZONE_MIXES[sim.line.mix] ?? ZONE_MIXES['1:1'];
    decal(`${ZONE_NAME} · 혼류 ${mix.label}`, 'rgba(55,232,255,0.9)', 16, -20.5, -5.6);
    decal(`▶ 도어트림 라인 (${ZONE_PRODUCTS.doortrim.customer})`, 'rgba(245,189,92,0.95)', 12, 1, 1.6, 56);
    decal(`▶ e-axle 라인 (${ZONE_PRODUCTS.eaxle.customer})`, 'rgba(184,155,255,0.95)', 12, 1, -1.6, 56);
    if (!sim.useAMR) return;
    // AMR 전용 동선: 대기열, 복귀 전용로(적재장 → 앞쪽 → 대기열), 출동 차로(대기열 → 투입 스테이션)
    const p0 = amrPark(0), pN = amrPark(ZONE_AMR.count - 1);
    flat(pN.x - p0.x + 1.4, 1.9, new THREE.MeshStandardMaterial({ color: 0x2bb3a6, transparent: true, opacity: 0.22, depthWrite: false }), (p0.x + pN.x) / 2, AMR_LANES.park, 0.01);
    decal('AMR 대기열', 'rgba(127,224,214,0.95)', 8, p0.x + 3.5, AMR_LANES.park + 1.3, 64);
    const tape = new THREE.MeshBasicMaterial({ color: 0x7fe0d6, transparent: true, opacity: 0.7 });
    const dash = (ax, az, bx, bz) => {
      const L = Math.hypot(bx - ax, bz - az), n = Math.floor(L / 1.2);
      for (let i = 0; i < n; i++) {
        const k = (i + 0.5) / n, m = flat(0.7, 0.1, tape, ax + (bx - ax) * k, az + (bz - az) * k, 0.016);
        m.rotation.z = Math.atan2(bz - az, bx - ax) * -1;
      }
    };
    const { ret, out, retX, dockX } = AMR_LANES;
    dash(retX, 2.4, retX, ret); dash(retX, ret, p0.x, ret);
    dash(pN.x, out, dockX, out); dash(dockX, out, dockX, 0.6);
    decal('◀ AMR 복귀 전용로', 'rgba(127,224,214,0.9)', 10, 8, ret + 0.9, 56);
    decal('◀ AMR 출동 차로', 'rgba(127,224,214,0.9)', 8, -24, out - 0.9, 56);
  }

  setLabels(on) {
    this.labelsVisible = on;
    for (const sv of this.stationViews) sv.label.visible = on;
    for (const vv of [...(this.vehicleViews ?? []), ...(this.techViews ?? []), ...(this.helperViews ?? []), ...(this.quadViews ?? []), ...(this.droneViews ?? []), ...(this.truckViews?.values() ?? [])]) vv.lbl.visible = on;
    this.labelsOn = on;
    for (const sp of this.idPlates ?? []) sp.visible = on;
  }

  // ── 제품 메시 ─────────────────────────────
  getItemMesh() {
    let g = this.itemPool.pop();
    if (!g) {
      g = new THREE.Group();
      const base = put(box(0.62, 0.36, 0.55, MAT.raw), 0, 0.18, 0, g);
      const part = put(cyl(0.13, 0.13, 0.3, MAT.copper, 14), 0, 0.5, 0, g);
      const carton = put(box(0.8, 0.6, 0.72, MAT.carton), 0, 0.3, 0, g);
      const tag = put(box(0.3, 0.02, 0.2, emis(0x3dff8a, 1.5), false), 0, 0.62, 0, g);
      // 도어트림: 트림 패널 + 암레스트 + 압입 클립 / e-axle: 모터·감속기 하우징 + 체결 볼트
      const panel = put(box(0.95, 0.08, 0.62, MAT.trim), 0, 0.41, 0, g);
      const arm = put(box(0.5, 0.1, 0.16, MAT.trimSoft), 0.1, 0.5, 0.12, g);
      const clips = put(new THREE.Group(), 0, 0.46, 0, g);
      for (const [cx, cz] of [[-0.38, -0.24], [0.38, -0.24], [-0.38, 0.24], [0.38, 0.24]]) put(box(0.07, 0.04, 0.07, MAT.clip, false), cx, 0, cz, clips);
      const housing = put(cyl(0.27, 0.27, 0.62, MAT.housing, 18), 0, 0.64, 0, g);
      housing.rotation.z = Math.PI / 2;
      const bolts = put(new THREE.Group(), 0.33, 0.64, 0, g);
      put(cyl(0.3, 0.3, 0.05, MAT.housing, 18), 0, 0, 0, bolts).rotation.z = Math.PI / 2;
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; put(cyl(0.035, 0.035, 0.06, MAT.bolt, 6), 0.03, Math.cos(a) * 0.22, Math.sin(a) * 0.22, bolts).rotation.z = Math.PI / 2; }
      const amr = makeCarrierAMR(); amr.position.y = -BELT_Y; amr.rotation.y = Math.PI / 2; g.add(amr);
      const dtImg = makeDoortrimPlate(); g.add(dtImg);   // 도어트림 실물 이미지 판 (부품분류셀부터)
      const eaImg = makeEaxlePlate(); g.add(eaImg);      // e-axle: Blender 입체 모델 (불러오지 못하면 실물 이미지 판) — 부품분류셀부터
      g.userData = { base, part, carton, tag, panel, arm, clips, housing, bolts, amr, dtImg, eaImg };
      this.dyn.add(g);
    }
    g.visible = true;
    return g;
  }
  styleItem(g, item, inSort = false) {
    const { base, part, carton, tag, panel, arm, clips, housing, bolts, amr, dtImg, eaImg } = g.userData;
    amr.visible = !!item.carrier;
    const dt = item.product === 'doortrim', ea = item.product === 'eaxle';
    dtImg.visible = false; eaImg.visible = false; clips.position.y = 0.46;
    panel.visible = dt && !!item.assembled; arm.visible = dt && !!item.assembled; clips.visible = dt && !!item.pressed;
    housing.visible = ea && !!item.assembled; bolts.visible = ea && !!item.fastened;
    if (item.scrap) {   // 불량품을 빼낸 빈 AMR
      panel.visible = arm.visible = clips.visible = housing.visible = bolts.visible = false;
      part.visible = carton.visible = base.visible = tag.visible = false;
      return;
    }
    if (item.product && item.packed) {
      // 포장 완료: 도어트림 트레이 박스 / e-axle 크레이트 (색으로 구분)
      panel.visible = arm.visible = clips.visible = housing.visible = bolts.visible = false;
      part.visible = false; base.visible = false; carton.visible = true;
      carton.material = dt ? MAT.carton : MAT.crate;
      tag.visible = true; tag.position.y = 0.61;
      return;
    }
    if (dt && (item.sorted || inSort || blenderOn())) {   // Blender: 자재투입존에서 집은 실물 그대로 처음부터
      // 도어트림: 부품분류셀부터 박스 대신 실물 이미지 판 (조립·압입 후에도 같은 판, 압입 클립 표시)
      carton.visible = false; part.visible = false; base.visible = false; panel.visible = false; arm.visible = false; dtImg.visible = true;
      clips.position.y = 0.08;   // 압입 클립은 이미지 판 위에
      tag.visible = !!item.inspected; tag.position.y = 0.12;
      return;
    }
    if (ea && (item.sorted || inSort || blenderOn())) {
      // e-axle: 부품분류셀부터 원통 하우징·박스 대신 실물 단면 이미지 판 (체결 후 양 끝 플랜지 볼트 표시)
      carton.visible = false; part.visible = false; base.visible = false; housing.visible = false; bolts.visible = false; eaImg.visible = true;
      eaImg.userData.bolts.visible = !!item.fastened;
      tag.visible = !!item.inspected; tag.position.y = eaImg.userData.tagY ?? 0.2;
      return;
    }
    if (item.product) {
      carton.visible = false; part.visible = false; base.visible = true;
      base.material = item.sorted ? MAT.tray : MAT.raw;
      tag.visible = !!item.inspected;
      tag.position.y = ea ? 0.93 : dt && item.assembled ? 0.57 : 0.37;
      return;
    }
    carton.visible = !!item.packed; carton.material = MAT.carton;
    base.visible = !item.packed;
    part.visible = !!item.assembled && !item.packed;
    tag.visible = !!item.inspected;
    tag.position.y = item.packed ? 0.61 : 0.37;
    base.material = item.painted ? MAT.painted : item.machined || item.assembled ? MAT.machined : MAT.raw;
    part.material = item.painted ? MAT.painted : MAT.copper;
  }

  syncItems() {
    const sim = this.sim, seen = new Set();
    const place = (item, x, y = BELT_Y, z = 0, yaw = 0, inSort = false) => {
      let g = this.itemMeshes.get(item.id);
      if (!g) { g = this.getItemMesh(); this.itemMeshes.set(item.id, g); }
      seen.add(item.id);
      g.userData.itemId = item.id;
      this.styleItem(g, item, inSort);
      g.position.set(x, y, z);
      g.rotation.y = yaw;
    };
    const sink = sim.stations[sim.stations.length - 1];
    for (const c of sim.conveyors) for (const e of c.items) {
      const q = pointAt(c.path, e.s), q2 = pointAt(c.path, Math.min(c.len, e.s + 0.3)), q0 = pointAt(c.path, Math.max(0, e.s - 0.3));
      // 구분 적재장: 경로 끝(입구)에서 가운데 정지 구간까지 들어가는 중 (시뮬레이션 enterT) — 다 들어간 뒤 적재 로봇이 집는다
      const k = e.item.enterT != null && sink.ins.includes(c) ? Math.min(1, e.item.enterT / SINK_PICK.enter) : 0, ke = k * k * (3 - 2 * k);
      place(e.item, q.x + (sink.x - q.x) * ke, BELT_Y, q.z + (sink.z - q.z) * ke, Math.atan2(-(q2.z - q0.z), q2.x - q0.x));
    }
    for (const st of sim.processing) if (st.item) {
      const k = Math.min(1, st.itemT / (sim.entryTime ?? 0.5));
      const from = st.itemFrom ?? toWorld(st.def, -2, 0);   // 들어온 경로 끝점에서 셀 중앙으로
      const q = { x: from.x + (st.x - from.x) * k, z: from.z + (st.z - from.z) * k };
      let y = BELT_Y;
      if (st.state === 'BUSY' && (st.type === 'cnc' || st.type === 'press')) y += Math.sin(this.time * 60) * 0.006;
      place(st.item, q.x, y, q.z, 0, st.type === 'sort');
    }
    for (const [id, g] of this.itemMeshes) if (!seen.has(id)) { g.visible = false; this.itemPool.push(g); this.itemMeshes.delete(id); }
  }

  // ── 이벤트 연출 ─────────────────────────────
  handleEvents() {
    const ev = this.sim.events; this.sim.events = [];
    for (const e of ev) {
      if (e.type === 'reject') {
        const g = this.getItemMesh(); this.styleItem(g, e.item); g.rotation.y = 0;
        g.userData.base.material = MAT.defect;
        const bin = toWorld(e.st.def, 1.4, -1.9);
        g.position.set(e.st.x, BELT_Y, e.st.z);
        this.flyers.push({ g, t: 0, from: new THREE.Vector3(e.st.x, BELT_Y, e.st.z), to: new THREE.Vector3(bin.x, 0.7, bin.z) });
      }
    }
  }

  // ── 프레임 갱신 ─────────────────────────────
  update(rdt, simRunning, simSpeed) {
    const sim = this.sim; if (!sim) return;
    this.time += rdt;
    const t = this.time, mode = sim.mode.key;
    this.handleEvents();
    this.syncItems();
    this.updateNetLinks();
    if (this.crawl && this.facadeSigns?.[1]?.visible) this.drawCrawl(rdt);
    if (this.netLeds) { const on = Math.floor(t * 2) % 2 === 0; for (const l of this.netLeds) l.material.emissiveIntensity = on ? 2.4 : 1.2; }

    // 컨베이어 벨트 스크롤
    const beltMove = simRunning ? (1.1 * rdt * simSpeed) / 0.5 : 0;
    for (const tex of this.conveyorTex) tex.offset.x = (tex.offset.x - beltMove) % 1;

    const dts = simRunning ? rdt * simSpeed : 0;
    for (const sv of this.stationViews) this.animateStation(sv, t, rdt, dts);
    // 경보 깜빡임: 고장 설비(빨강), 공급 차질 시 자재창고·투입구(주황) — 해결되면 꺼진다
    for (const sv of this.stationViews) {
      const s0 = sv.st.state;
      const kind = s0 === 'DOWN' || s0 === 'ESTOP' ? 'fault' : s0 === 'PSTOP' ? 'event' : sv.st.type === 'source' && sim.supplyAlarm ? 'supply' : null;
      blinkAlarmFx(sv.alarm, !!kind, ALARM_COLOR[kind] ?? 0, t);
      sv.el.classList.toggle('alarm-fault', kind === 'fault'); sv.el.classList.toggle('alarm-supply', kind === 'supply');
    }
    blinkAlarmFx(this.whAlarm, sim.supplyAlarm, ALARM_COLOR.supply, t);
    // 출고 중단 동안 창고 랙은 비어 보이고 '출고 중단' 표지가 깜빡인다
    const out = sim.supplyDisrupted;
    // 물류 선반: 원자재 칸은 20박스(AGV 1회분)마다 한 단씩, 부품 칸은 40개마다 빈 하나씩 — 입고되면 차고 배달하면 줄어든다
    const raw = sim.whRaw ?? 0, partsOn = sim.partsTracked, parts = partsOn ? sim.whParts : WH.partsCap;
    if (raw !== this.whRawShown) {
      this.whRawShown = raw;
      this.whRawSlots.forEach((sl, i) => { const n = Math.max(0, Math.min(WH.rawPallet, raw - i * WH.rawPallet)); sl.lo.visible = n > 0; sl.hi.visible = n > WH.rawPallet / 2; });
    }
    if (parts !== this.whPartsShown) {
      this.whPartsShown = parts;
      this.whPartSlots.forEach((sl, i) => { const n = Math.max(0, Math.min(WH.partsPallet, parts - i * WH.partsPallet)); const b = Math.ceil(n / (WH.partsPallet / 6)); sl.bins.forEach((x, k) => (x.visible = k < b)); });
    }
    this.drawWhBoard();
    if (this.asrs && !REDUCED_MOTION) {   // AS/RS: 셔틀이 단마다 칸 ↔ 리프트를 오가고 리프트가 오르내린다
      this.asrs.shuttles.forEach((sh, i) => { sh.position.x = sh.userData.x0 + Math.sin(t * 0.55 + i * 1.3) * 1.7; });
      this.asrs.lift.position.y = 0.3 + (1 - Math.cos(t * 0.45)) * 1.6;
    }
    this.whSign.visible = out;
    if (out) this.whSign.material.opacity = REDUCED_MOTION || Math.sin(t * Math.PI * 2 / 0.9) > 0 ? 1 : 0.35;

    // 불량 배출 연출
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i]; f.t += rdt * Math.max(1, simSpeed * 0.5);
      const k = Math.min(1, f.t / 0.9);
      f.g.position.lerpVectors(f.from, f.to, k); f.g.position.y += Math.sin(k * Math.PI) * 0.8;
      f.g.rotation.z = k * 3;
      if (k >= 1) { f.g.visible = false; f.g.rotation.z = 0; this.itemPool.push(f.g); this.flyers.splice(i, 1); }
    }

    // 휴머노이드 충전 도크: 충전 중 초록 숨쉬기 · 비어 있으면 파랑 대기
    for (const { d, m } of this.humanoidDocks ?? []) {
      const on = !!m.chgNow, { led, scr } = d.userData;
      led.emissive.setHex(on ? 0x3dff8a : 0x2aa8ff); led.emissiveIntensity = on ? 1.4 + Math.sin(t * 3) * 0.9 : 0.6;
      scr.emissive.setHex(on ? (m.battery > 95 ? 0x3dff8a : 0xf5b82e) : 0x2aa8ff);
    }
    // 차량
    for (const vv of this.vehicleViews) {
      const v = vv.v;
      vv.g.position.set(v.x, 0, v.z);
      vv.yaw = lerpAngle(vv.yaw, v.heading, Math.min(1, rdt * 8));
      vv.g.rotation.y = vv.yaw;
      const { load, crates, led, fork } = vv.g.userData;
      load.visible = !!v.load;
      if (fork) {   // 지게차 포크 높이: 도크에 선 트럭 뒤쪽에 포크 끝이 다가가면 적재함 바닥(1.27m) 위까지 올려 싣고 내린다 · 그 밖에는 주행 높이
        const fx = v.x + Math.sin(v.heading) * 1.9, fz = v.z + Math.cos(v.heading) * 1.9;
        let near = 99;
        for (const tk of [...(sim.yard?.trucks ?? []), ...(sim.inbound?.trucks ?? [])]) {
          if (tk.state !== 'dock') continue;
          const rx = tk.x - Math.sin(tk.heading ?? 0) * YARD.truckLen / 2, rz = tk.z - Math.cos(tk.heading ?? 0) * YARD.truckLen / 2;
          near = Math.min(near, Math.hypot(fx - rx, fz - rz));
        }
        const want = near < 3.4 ? TRUCK_BED_LIFT * Math.min(1, (3.4 - near) / 1.2) : v.load ? 0.12 : 0;
        fork.position.y += (want - fork.position.y) * Math.min(1, rdt * 5);
      }
      if (v.load) {
        const n = v.shipper || v.receiver ? crates.length : Math.ceil((v.load.n / (v.load.type === 'raw' ? 20 : sim.mode.vehicleCap)) * crates.length);
        crates.forEach((c, i) => { c.visible = i < n; c.material = v.load.type === 'raw' ? MAT.raw : v.load.type === 'parts' ? MAT.partsBin : v.load.product === 'eaxle' ? MAT.crate : MAT.carton; });
      }
      if (led) {
        const col = v.charging ? 0x3dff8a : v.battery < 25 ? 0xff4040 : v.load ? 0xffb020 : 0x2aa8ff;
        led.emissive.setHex(col);
        led.emissiveIntensity = v.charging ? 1.5 + Math.sin(t * 4) * 1.2 : 2.5;
      }
      if (v.auto) vv.g.userData.beacon.material.emissiveIntensity = v.moving ? (Math.sin(t * 9) > 0 ? 3 : 0.3) : 1;
      vv.el.innerHTML = `${v.uid ? `<i class="uid">${v.uid}</i>` : ''}${v.id}${v.kind === 'agv' ? ` · ${v.battery.toFixed(0)}%` : ''}<em>${v.task ?? '대기'}</em>`;
    }
    this.updateTrucks(t, rdt);
    if (this.boardCanvas && this.sim && t - (this.boardT ?? -1) > 1) { this.boardT = t; this.drawBoard(); }
    for (const cv of this.carrierViews) {
      const c = cv.v;
      cv.g.visible = c.state !== 'line';
      if (!cv.g.visible) continue;
      cv.g.position.set(c.x, 0, c.z);
      cv.yaw = lerpAngle(cv.yaw, c.heading, Math.min(1, rdt * 8));
      cv.g.rotation.y = cv.yaw;
      cv.g.userData.led.emissive.setHex(c.state === 'park' ? 0x3dff8a : c.state === 'atSrc' ? 0xffb020 : 0x2aa8ff);
    }
    for (const tv of this.techViews) this.animatePerson(tv, rdt, t, true);
    for (const hv of this.helperViews) { this.animatePerson(hv, rdt, t, true); hv.g.userData.bin.visible = !!hv.v.carry; }
    for (const qv of this.quadViews) this.animateQuad(qv, rdt, t);
    for (const dk of this.quadDocks ?? []) {   // 충전 도크 상태등
      const at = Math.hypot(dk.q.x - dk.q.home.x, dk.q.z - dk.q.home.z) < 0.3;
      dk.led.emissive.setHex(dk.q.charging ? 0x3dff8a : dk.q.battery < 30 ? 0xff8a3d : 0x2aa8ff);
      dk.led.emissiveIntensity = dk.q.charging ? 1.2 + Math.sin(t * 4) * 1.1 : at ? 2.2 : 0.8;
    }
    for (const dv of this.droneViews ?? []) this.animateDrone(dv, rdt, t);
    for (const wv of this.workerViews) this.animatePerson(wv, rdt, t, false);

    // IoT 데이터 패킷
    if (mode !== 'traditional') {
      for (const sv of this.stationViews) {
        if (sv.st.standby) { sv.ringM.opacity = 0; sv.sensorMat.emissive.setHex(0x334048); continue; }
        const k = ((t * 0.8 + sv.phase) % 1);
        sv.pulse.scale.setScalar(1 + k * 3); sv.ringM.opacity = 0.6 * (1 - k);
        sv.sensorMat.emissive.setHex(sv.st.state === 'DOWN' ? 0xff3030 : sv.st.state === 'MAINT' ? 0xffb020 : 0x37e8ff);
        if (Math.random() < rdt * 1.6) this.spawnPacket(sv);
      }
      this.updatePackets(rdt);
      for (let i = 0; i < this.serverLeds.length; i++) this.serverLeds[i].emissiveIntensity = Math.random() < 0.1 ? 0.2 : 2.2;
    }
    for (const c of this.chargers) c.m.emissiveIntensity = 1.2 + Math.sin(t * 2) * 0.4;
    // 선택한 로봇: 텔레메트리 샘플링 + 바닥 선택 링
    if (this.telemetry) {
      this.telemetry.sample(rdt, dts);
      const R = this.telemetry.R;
      if (R?.obj) {
        const p = R.obj.getWorldPosition(new THREE.Vector3());
        this.selRing.position.set(p.x, 0.03, p.z);
        this.selRing.scale.setScalar(R.kind === 'arm' ? 0.75 : R.kind === 'humanoid' ? 0.6 : 1.1);
        this.selRing.material.opacity = 0.55 + Math.sin(t * 5) * 0.3;
        this.selRing.visible = true;
      } else this.selRing.visible = false;
    }
  }

  animatePerson(pv, rdt, t, isTech) {
    const v = pv.v, g = pv.g;
    const moved = Math.hypot(v.x - pv.px, v.z - pv.pz) > 1e-4;
    pv.px = v.x; pv.pz = v.z;
    g.position.set(v.x, 0, v.z);
    let target = v.heading;
    const st = v.station, ud = g.userData;
    // 서서 일할 때 바라볼 곳: 대응 중인 현장 이벤트 → 일하는 셀(정비·부품 보충) — Atlas 휴머노이드는 발은 두고 허리(360°)·머리(±90°)를 돌린다
    let look = null;
    if (!moved && v.kind === 'humanoid' && v.task) {
      const ev = (this.sim.fieldEvents ?? []).find((e) => !e.cleared && v.job?.ev === e);
      const near = ev ?? v.job?.st ?? this.sim.processing.reduce((b, s2) => (Math.hypot(s2.x - v.x, (s2.z ?? 0) - v.z) < Math.hypot(b.x - v.x, (b.z ?? 0) - v.z) ? s2 : b), this.sim.processing[0]);
      if (near && Math.hypot(near.x - v.x, (near.z ?? 0) - v.z) < 4.5) look = Math.atan2(near.x - v.x, (near.z ?? 0) - v.z);
    }
    if (!moved && st && !ud.waist) target = Math.atan2(st.x - v.x, st.z - v.z);
    if (!moved && isTech && v.task && v.kind === 'human') target = Math.PI;
    pv.yaw = lerpAngle(pv.yaw, target, Math.min(1, rdt * 6));
    g.rotation.y = pv.yaw;
    if (ud.waist) {
      // 허리: 바라볼 곳과 발 방향의 차이만큼 (어느 방향이든, 360°) · 머리: 남은 각도와 둘러보기(±90° 안)
      const want = look != null ? Math.atan2(Math.sin(look - pv.yaw), Math.cos(look - pv.yaw)) : 0;
      pv.waistYaw = lerpAngle(pv.waistYaw ?? 0, want, Math.min(1, rdt * 3));
      ud.waist.rotation.y = pv.waistYaw;
      const rest = look != null ? Math.atan2(Math.sin(want - pv.waistYaw), Math.cos(want - pv.waistYaw)) : 0;
      const scan = moved ? Math.sin(t * 0.9 + (v.id?.length ?? 0)) * 0.55 : v.task ? Math.sin(t * 0.6) * 0.3 : 0;   // 걸을 때 좌우를 살피고, 일할 때 작업 부위를 훑어본다
      ud.head.rotation.y = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rest + scan));
      v.waistYaw = pv.waistYaw; v.headYaw = ud.head.rotation.y;   // 텔레메트리·에피소드용
    }
    if (ud.body) {
      if (moved) {
        ud.body.position.y = Math.abs(Math.sin(t * 9)) * 0.06;
        ud.armL.rotation.x = Math.sin(t * 9) * 0.6; ud.armR.rotation.x = -Math.sin(t * 9) * 0.6;
        if (ud.legL) { ud.legL.rotation.x = -Math.sin(t * 9) * 0.5; ud.legR.rotation.x = Math.sin(t * 9) * 0.5; }
      } else {
        ud.body.position.y = 0;
        const working = (st && st.state === 'BUSY') || (isTech && v.task && !moved);
        ud.armL.rotation.x = working ? -0.9 + Math.sin(t * 5) * 0.3 : 0;
        ud.armR.rotation.x = working ? -1.1 + Math.cos(t * 6) * 0.35 : 0;
        if (ud.legL) { ud.legL.rotation.x = 0; ud.legR.rotation.x = 0; }
      }
      if (v.carry && ud.bin) { ud.armL.rotation.x = -1.2; ud.armR.rotation.x = -1.2; }
      if (ud.visor) ud.visor.emissive.setHex(v.task ? 0x37e8ff : 0x3dff8a);
      // 챙긴 도구 표시 (정비실에서 챙기고 반납할 때까지)
      if (v.tool !== undefined || ud.toolKits) {
        ud.toolKits ??= makeToolKits(g, ud);
        const vis = TOOL_KITS[v.tool]?.vis;
        if (ud.toolShown !== vis) { ud.toolShown = vis; for (const [k, o] of Object.entries(ud.toolKits.kits)) o.visible = k === vis; for (const [k, o] of Object.entries(ud.toolKits.extra)) o.visible = k === vis; }
        if (vis && !v.carry) { const hold = vis === 'mop' || vis === 'broom' ? -0.5 : -0.15; ud.armR.rotation.x = Math.min(ud.armR.rotation.x, 0) * 0.3 + hold; }   // 도구 든 팔은 크게 흔들지 않는다
        if (vis) {   // 손에 든 도구는 팔·팔꿈치 각도를 되돌려 늘 아래로 곧게 늘어진다 (대걸레·빗자루 자루는 수직)
          const r = ud.armR.rotation.x + (ud.elbowR?.rotation.x ?? 0), l = ud.armL.rotation.x + (ud.elbowL?.rotation.x ?? 0);
          ud.toolKits.anchors.forEach((a, i) => { a.rotation.x = -(i === ud.toolKits.anchors.length - 1 ? l : r); });
        }
      }
      if (ud.kneeL) {   // Blender 휴머노이드: 앞으로 내딛는 다리의 무릎을 굽히고, 팔꿈치는 걸음·작업·운반에 맞춰 굽힌다
        const sw = moved ? Math.sin(t * 9) : 0;
        ud.kneeL.rotation.x = Math.max(0, sw) * 0.7; ud.kneeR.rotation.x = Math.max(0, -sw) * 0.7;
        const el = v.carry ? -0.5 : moved ? -0.35 : -0.12;
        ud.elbowL.rotation.x = ud.armL.rotation.x < -0.5 && !v.carry ? -0.7 : el; ud.elbowR.rotation.x = ud.armR.rotation.x < -0.5 && !v.carry ? -0.7 : el;
      }
    } else if (ud.arm) {
      const working = v.task && !moved;
      ud.arm.pose(Math.sin(t * 1.5) * 0.6, working ? 0.8 + Math.sin(t * 3) * 0.2 : 0.2, working ? 1.0 : 0.9, 0.5);
      ud.beacon.emissiveIntensity = working || moved ? (Math.sin(t * 10) > 0 ? 4 : 0.3) : 1;
    }
    if (pv.el) pv.el.innerHTML = `${v.uid ? `<i class="uid">${v.uid}</i>` : ''}${v.id}<em>${v.task ?? '대기'}</em>`;
  }

  animateQuad(qv, rdt, t) {
    const v = qv.v, g = qv.g, ud = g.userData;
    const moved = Math.hypot(v.x - qv.px, v.z - qv.pz) > 1e-4;
    qv.px = v.x; qv.pz = v.z;
    g.position.set(v.x, 0, v.z);
    // 점검 중에는 설비 쪽을 바라본다
    const target = v.scanning ? Math.atan2(v.scanning.x - v.x, v.scanning.z - v.z) : v.heading;
    qv.yaw = lerpAngle(qv.yaw, target, Math.min(1, rdt * 6));
    g.rotation.y = qv.yaw;
    ud.legs.forEach(({ hip, knee }, i) => {
      const ph = t * 10 + (i === 0 || i === 3 ? 0 : Math.PI);   // 대각 보행(trot)
      hip.rotation.x = moved ? Math.sin(ph) * 0.45 : 0;
      knee.rotation.x = moved ? Math.max(0, -Math.sin(ph)) * 0.6 + 0.15 : 0.15;
    });
    ud.body.position.y = 0.55 + (moved ? Math.abs(Math.sin(t * 10)) * 0.025 : 0);
    ud.beam.visible = !!v.scanning;
    ud.cam.rotation.y = v.scanning ? Math.sin(t * 2.5) * 0.4 : 0;
    qv.el.innerHTML = `${v.uid ? `<i class="uid">${v.uid}</i>` : ''}${v.id} · ${v.battery.toFixed(0)}%<em>${v.task ?? "대기"}</em>`;
  }

  spawnPacket(sv) {
    let p = this.packets.find((q) => !q.alive);
    if (!p) {
      if (this.packets.length > 80) return;
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0x7ff3ff, toneMapped: false }));
      this.dyn.add(m);
      p = { m, alive: false };
      this.packets.push(p);
    }
    p.alive = true; p.t = 0; p.m.visible = true;
    p.a = sv.sensor.position.clone();
    p.b = this.serverPos.clone();
    p.c = p.a.clone().lerp(p.b, 0.5); p.c.y = 9;
    p.m.material.color.setHex(sv.st.state === 'DOWN' ? 0xff5050 : 0x7ff3ff);
  }
  updatePackets(rdt) {
    for (const p of this.packets) {
      if (!p.alive) continue;
      p.t += rdt * 0.7;
      if (p.t >= 1) { p.alive = false; p.m.visible = false; continue; }
      const k = p.t, a = p.a, b = p.b, c = p.c;
      p.m.position.set(
        (1 - k) * (1 - k) * a.x + 2 * (1 - k) * k * c.x + k * k * b.x,
        (1 - k) * (1 - k) * a.y + 2 * (1 - k) * k * c.y + k * k * b.y,
        (1 - k) * (1 - k) * a.z + 2 * (1 - k) * k * c.z + k * k * b.z,
      );
    }
  }

  animateStation(sv, t, rdt, dts) {
    const { st, parts } = sv;
    const busy = st.state === 'BUSY';
    sv.light.userData.set(st.state, t);
    const p = st.progress ?? 0;
    // 비상정지·보호정지: 로봇이 그 자세 그대로 멈춘다
    const frozen = st.state === 'ESTOP' || st.state === 'PSTOP';
    if (parts.robots && !frozen) parts.robots.forEach((r, i) => {
      // 게이트 결정: 주 작업 로봇은 작업하고, 보조 로봇은 작업물을 잡아 고정한 자세로 천천히 따라간다
      const lead = this.sim.isLead(st, i);
      if (r.vla) return this.animVLA(r, st, busy && lead, p, i);
      r.anim(busy && lead, t + r.phase, p);
      if (r.kind === 'ammr' && st.vla) this.animAMMRVLA(r, st, busy, t, i, lead);
    });
    // AMMR: 대상물마다 작업 위치 ↔ 부품 선반 왕복 (회전 → 주행 → 양팔 피킹 → 회전 → 복귀 → 작업)
    if (st.ammr && parts.robots) parts.robots.forEach((r, i) => {
      const u = st.ammr[i]; if (!u || !r.slot) return;
      const e = u.pos * u.pos * (3 - 2 * u.pos), pl = r.plan;
      if (pl?.mode === 'x') {
        // 셀 옆쪽 선반: 진행 방향(±x)으로 돌아 로봇 줄을 따라 주행
        r.root.position.x = r.slot.x + (pl.pick.x - r.slot.x) * e;
        const face = pl.dir < 0 ? -Math.PI / 2 : Math.PI / 2;
        const d = ((face - r.slot.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        r.root.rotation.y = r.slot.yaw + u.turn * d;
      } else {
        r.root.position.z = r.slot.z + (r.slot.side * AMMR.pickZ - r.slot.z) * e;
        r.root.rotation.y = r.slot.yaw + u.turn * Math.PI;
      }
      if (u.phase !== 'work' && !(st.vla && u.phase === 'pick')) r.anim(u.phase === 'pick', t + r.phase, p);
      r.bin.visible = u.carry;   // 선반에서 가져온 부품 (플랫폼 트레이)
    });
    if (parts.racks?.length) {
      const frac = st.parts != null ? st.parts / (this.sim.mode.partsCap || 40) : 1;
      for (const rk of parts.racks) rk.bins.forEach((b, k) => (b.visible = k < Math.ceil(frac * rk.bins.length)));
    }
    if (st.standby) {
      if (parts.scan) parts.scan.visible = false;
      if (parts.stack) parts.stack.forEach((b) => (b.visible = false));
      return;
    }
    switch (st.type) {
      case 'cnc': {
        const down = busy && p > 0.1 && p < 0.9;
        parts.head.position.y += ((down ? 1.75 : 2.2) - parts.head.position.y) * Math.min(1, rdt * 5);
        if (busy) parts.spindle.rotation.y += dts * 40;
        parts.head.position.x = busy ? Math.sin(p * Math.PI * 6) * 0.25 : parts.head.position.x * 0.9;
        parts.screen.emissive.setHex(st.state === 'DOWN' ? 0xff3030 : 0x58c4ff);
        stepSparks(parts.sparks, down, { x: parts.head.position.x, y: BELT_Y + 0.45, z: 0 }, rdt, 1.4, -5);
        break;
      }
      case 'weld': {
        const welding = busy && parts.robots.length > 0 && this.sim.mode.key !== 'traditional' && Math.sin(t * 6) > -0.3;
        const manual = busy && this.sim.mode.key === 'traditional' && Math.sin(t * 4) > 0;
        stepSparks(parts.sparks, welding || manual, { x: manual ? -0.3 : 0, y: BELT_Y + 0.45, z: manual ? 0.4 : 0 }, rdt, 2.2, -7);
        break;
      }
      case 'paint': {
        const w = t * 2.5;
        parts.lamp.emissiveIntensity = busy ? 1.4 : 0.5;
        stepSparks(parts.mist, busy, { x: Math.sin(w) * 0.5, y: BELT_Y + 0.9, z: 0 }, rdt, 1.0, -1.5);
        break;
      }
      case 'press': {
        const k = busy ? Math.max(0, Math.sin(p * Math.PI * 2 - Math.PI / 2)) : 0;
        parts.ram.position.y = 2.8 - k * 1.1;
        break;
      }
      case 'laser': {
        parts.beam.visible = busy && p > 0.1 && p < 0.9;
        parts.head.position.x = busy ? Math.sin(p * Math.PI * 8) * 0.35 : 0;
        parts.head.position.z = busy ? Math.cos(p * Math.PI * 5) * 0.2 : 0;
        stepSparks(parts.sparks, parts.beam.visible, { x: parts.head.position.x, y: BELT_Y + 0.42, z: parts.head.position.z }, rdt, 1.2, -4);
        break;
      }
      case 'test': {
        const down = busy && p > 0.15 && p < 0.85;
        parts.probe.position.y += ((down ? 1.55 : 2.1) - parts.probe.position.y) * Math.min(1, rdt * 6);
        parts.screen.emissive.setHex(st.state === 'DOWN' ? 0xff3030 : down && Math.sin(t * 12) > 0 ? 0xf5b82e : 0x3ddc84);
        break;
      }
      case 'assembly':
        break;
      case 'pack':
      case 'sort': {
        if (!parts.gateSign) break;
        // 대상물이 입구 게이트를 지나는 동안 스캔 → 판별 결과를 표시판·스캔 링 색으로 보여 준다
        const passing = !!st.item && (st.itemT ?? 9) < this.sim.entryTime + 0.6;
        parts.scan.visible = passing;
        if (passing) parts.scan.position.x = parts.gateX + Math.sin(t * 9) * 0.12;
        const pc = st.gate?.product ? ZONE_COLOR[st.gate.product] : 0xffffff;
        parts.ringMat.color.setHex(pc); parts.ringMat.emissive?.setHex(pc);
        parts.ringMat.emissiveIntensity = passing ? 6 : st.item ? 1.4 : 0.4;
        drawGateSign(parts.gateSign, st);
        break;
      }
      case 'pressfit': {
        const k = busy ? Math.max(0, Math.sin(p * Math.PI * 3 - Math.PI / 2)) : 0;
        parts.ram.scale.y = 1 + k * 0.6;
        parts.screen.emissive.setHex(st.state === 'DOWN' ? 0xff3030 : k > 0.9 ? 0xf5b82e : 0x58c4ff);
        break;
      }
      case 'screw': {
        const down = busy && Math.sin(p * Math.PI * 8) > 0;
        parts.head.position.y += ((down ? 1.95 : 2.3) - parts.head.position.y) * Math.min(1, rdt * 8);
        if (down) parts.bit.rotation.y += dts * 30;
        parts.screen.emissive.setHex(st.state === 'DOWN' ? 0xff3030 : down ? 0xf5b82e : 0x3ddc84);
        break;
      }
      case 'fasten': {
        const down = busy && p > 0.2 && p < 0.85;
        // 너트러너가 내려와 있는 동안 로봇은 팔을 접고 기다린다 (헤드와 간섭 방지)
        if (down && parts.robots) for (const r of parts.robots) r.anim(false, t);
        parts.head.position.y += ((down ? 1.95 : 2.4) - parts.head.position.y) * Math.min(1, rdt * 5);
        if (down) for (const sp of parts.spindles) sp.rotation.y += dts * 25;
        parts.screen.emissive.setHex(st.state === 'DOWN' ? 0xff3030 : down && Math.sin(t * 10) > 0 ? 0xf5b82e : 0x3ddc84);
        break;
      }
      case 'vision': {
        const scanning = busy && parts.auto.visible;
        parts.scan.visible = scanning;
        if (scanning) parts.scan.position.x = Math.sin(p * Math.PI * 2) * 0.6;
        parts.ringMat.emissiveIntensity = scanning && p > 0.45 && p < 0.55 ? 8 : 0.4;
        break;
      }
      case 'source': {
        // 투입 주기마다: 자재 더미 맨 위 박스 위로 X·Y 이동 → Z 하강·집기 → 상승 → 투입 위치(AMR 지그·컨베이어)로 X·Y 이동 → 하강·내려놓기
        const sim = this.sim, raw = sim.rawStock, T = sim.releaseInterval;
        const waiting = sim.releaseTimer >= T - 1e-6;                    // 투입 시점인데 내려놓을 곳(빈 AMR)이 없으면 들고 대기
        const k = Math.min(1, sim.releaseTimer / T);
        const Z = parts.zoneStock;
        // 정밀조립Zone: 재고를 혼류 비율로 양쪽에 나눠 보이고, 다음 투입 제품 쪽에서 집는다
        let next = null, nDT = 0, nEA = 0;
        if (Z) {
          const w = sim.mix ?? { doortrim: 1, eaxle: 1 }, tot = (w.doortrim || 0) + (w.eaxle || 0) || 1;
          nDT = Math.min(Z.dt.slots.length, Math.round(raw * (w.doortrim || 0) / tot)); nEA = Math.min(Z.ea.slots.length, raw - nDT);
          next = sim.nextProduct?.() ?? 'doortrim';
          if (next === 'eaxle' && nEA === 0) next = 'doortrim'; else if (next === 'doortrim' && nDT === 0) next = 'eaxle';
        }
        const side = Z ? (next === 'eaxle' ? Z.ea : Z.dt) : null, sn = next === 'eaxle' ? nEA : nDT;
        const top = Z ? side.slots[sn - 1] : parts.stack[raw - 1]?.position;
        const pick = Z ? (top ? { x: top.x, z: top.z, y: top.y + side.h / 2 } : { x: 0, z: 2.15, y: 0.45 }) : top ? { x: top.x, z: top.z, y: top.y } : { x: 0, z: 1.5, y: 0.45 };
        const place = { x: 0, z: 0, y: BELT_Y + (Z ? 0.05 + side.h / 2 : 0.18) }, UP = Z ? 2.45 : 2.05;     // 들린 물체 중심 높이 기준
        // [진행, 위치(0=투입·1=더미), 높이(0=위·1=아래), 집음]
        const K = [[0, 0, 0, 0], [0.18, 1, 0, 0], [0.3, 1, 1, 0], [0.36, 1, 1, 1], [0.48, 1, 0, 1], [0.7, 0, 0, 1], [0.84, 0, 1, 1], [1, 0, 1, 1]];
        let pos = 0, down = 0, hold = 0;
        if (raw > 0 && !(st.state === 'HOLD' || st.state === 'ESTOP' || st.state === 'PSTOP')) {
          // 빈 AMR이 적재 위치에 도착해 있어야 내려놓는다 — 아직이면 투입 위치 위에서 들고 기다린다 (컨베이어 라인은 항상 가능)
          const ready = !sim.useAMR || sim.carriers.some((c) => c.state === 'atSrc');
          if (waiting) { pos = 0; down = ready ? 1 : 0.72; hold = 1; }   // AMR 지그 바로 위(약 5cm)에서 대기 — AMR이 아래로 들어오면 곧바로 내려놓는다
          else {
            const i = K.findIndex((q) => q[0] >= k), a = K[Math.max(0, i - 1)], b = K[i];
            const f = b[0] > a[0] ? (k - a[0]) / (b[0] - a[0]) : 1, e = f * f * (3 - 2 * f);
            pos = a[1] + (b[1] - a[1]) * e; down = a[2] + (b[2] - a[2]) * e; hold = a[3];
            if (!ready && pos < 0.5) down = Math.min(down, 0.72);
          }
        }
        const x = place.x + (pick.x - place.x) * pos, z = place.z + (pick.z - place.z) * pos;
        const lowY = pos > 0.5 ? pick.y : place.y, y = UP + (lowY - UP) * down;
        const sm = Math.min(1, rdt * 14);
        parts.bridge.position.x += (x - parts.bridge.position.x) * sm;
        parts.car.position.z += (z - parts.car.position.z) * sm;
        parts.lift.position.y += (y - 1.15 - parts.lift.position.y) * sm;   // 들린 박스 중심이 기본 1.15m
        parts.held.visible = !!hold;
        if (Z) {
          parts.heldEA.visible = next === 'eaxle'; parts.heldDT.visible = next !== 'eaxle';
          const eaN = nEA - (hold && next === 'eaxle' ? 1 : 0);
          Z.dt.setCount(nDT - (hold && next !== 'eaxle' ? 1 : 0)); Z.ea.setCount(eaN);
          Z.ea.boards.forEach((b, k) => { b.visible = eaN > (k + 1) * 9; });   // 위층이 있을 때만 그 아래 받침목
        } else parts.stack.forEach((bx, i) => (bx.visible = i < raw - (hold ? 1 : 0)));
        break;
      }
      case 'sink': {
        const fg = this.sim.fgStock;
        // 로봇이 아직 내려놓지 않은 박스(집는 중·옮기는 중·대기 중)는 적재 팔레트에 보이지 않는다 — 구분 적재장은 집어 들었지만 아직 놓지 않은 박스
        if (parts.zoneStacks) for (const [k, arr] of Object.entries(parts.zoneStacks)) { const a = parts.arms?.[k], pend = !a ? 0 : this.sim.zone ? (a.cyc && !a.cyc.placed && (this.sim.stats.grabBy?.[k] ?? 0) > a.cyc.grabBase ? 1 : 0) : a.queue + (a.cyc && !a.cyc.placed ? 1 : 0); arr.forEach((b, i) => (b.visible = i < this.sim.fgBy[k] - pend)); }
        else parts.stack.forEach((b, i) => (b.visible = i < fg));
        if (parts.arms) this.animatePalletizers(parts, dts);
        break;
      }
    }
  }

  // 드론: 위치·고도, 진행 방향으로 살짝 기울기, 로터 회전, 항법등·스트로브, 점검 중 하방 관찰 빔
  animateDrone(dv, rdt, t) {
    const d = dv.v, g = dv.g, ud = g.userData;
    const vx = (d.x - dv.px) / Math.max(rdt, 1e-3), vz = (d.z - dv.pz) / Math.max(rdt, 1e-3); dv.px = d.x; dv.pz = d.z;
    g.position.set(d.x, d.y, d.z);
    dv.yaw = lerpAngle(dv.yaw, d.heading, Math.min(1, rdt * 6)); g.rotation.y = dv.yaw;
    const sp = Math.min(1, Math.hypot(vx, vz) / 3.4);
    ud.body.rotation.x += (sp * 0.18 - ud.body.rotation.x) * Math.min(1, rdt * 4);   // 전진할 때 앞으로 숙인다
    const flying = d.y > 0.3;
    ud.body.position.y = flying ? Math.sin(t * 2.3) * 0.03 : 0;
    ud.rotors.forEach((r, i) => (r.rotation.y += (flying ? 60 : 2) * rdt * (i % 3 ? 1 : -1)));
    ud.strobe.material.emissiveIntensity = Math.sin(t * 7) > 0.85 ? 6 : 0.3;
    const look = flying && (d.mode === 'mission' || (d.mode === 'patrol' && d.hover > 0));
    ud.beam.visible = look;
    if (look) { ud.beam.scale.set(1, d.y - 0.2, 1); ud.beam.position.y = -(d.y - 0.2) / 2 - 0.1; ud.beam.material.color.setHex(d.mode === 'mission' ? 0xff8a3d : 0x37e8ff); ud.beam.material.opacity = d.mode === 'mission' ? 0.14 : 0.08; }
    dv.el.innerHTML = `${d.uid ? `<i class="uid">${d.uid}</i>` : ''}${d.id} · ${d.battery.toFixed(0)}%<em>${d.task ?? '대기'}</em>`;
  }

  // 피지컬AI VLA 조립·체결 (6축 로봇): 손목 카메라로 선반 부품 인식 → 집기 → 대상물로 운반 → 조립(체결은 너트 돌림) → 선반 복귀
  // 셀 사이클 진행률(p)에 맞춰 역기구학 키프레임을 따라간다. 로봇마다 시작을 조금씩 엇갈린다
  animVLA(r, st, busy, p, i) {
    const V = r.vla, s = r.scale, A = r.arm;
    const th = r.root.rotation.y, c = Math.cos(th), sn = Math.sin(th);
    const ik = (x, y, z) => { const dx = x - r.slot.x, dz = z - r.slot.z; return armIK(s, dx * c - dz * sn, y - 0.15, dx * sn + dz * c); };
    const wx = r.slot.x * 0.3, wz = r.slot.z * 0.22, wy = 1.3;   // 대상물(AMR 위)에서 로봇 쪽 가장자리
    const K = r.vlaKeys ??= {
      shelfUp: ik(V.shelf.x, V.shelf.y + 0.32, V.shelf.z), grab: ik(V.shelf.x, V.shelf.y + 0.03, V.shelf.z),
      workUp: ik(wx, wy + 0.35, wz), ins: ik(wx, wy + 0.04, wz),
    };
    let q = K.shelfUp, d = 0, e = 0, held = false, scan = false;
    if (busy) {
      const u = (p + i * 0.07) % 1;
      const keys = [[0, K.shelfUp], [0.1, K.grab], [0.18, K.grab], [0.3, K.shelfUp], [0.45, K.workUp], [0.55, K.ins], [0.75, K.ins], [0.85, K.workUp], [1, K.shelfUp]];
      const j = keys.findIndex((k) => k[0] >= u), [t0, a] = keys[Math.max(0, j - 1)], [t1, b] = keys[j];
      const k = t1 > t0 ? (u - t0) / (t1 - t0) : 1, ease = k * k * (3 - 2 * k);
      q = a.map((v, n) => v + (b[n] - v) * ease);
      held = u >= 0.18 && u < 0.62;
      scan = (u > 0.03 && u < 0.18) || (u > 0.45 && u < 0.56);   // 카메라 추론(부품 인식·조립 위치 정렬)
      if (u >= 0.55 && u < 0.75) { const f = (u - 0.55) / 0.2; if (st.type === 'screw' || st.type === 'fasten') e = f * Math.PI * 6; else d = Math.sin(f * Math.PI * 4) * 0.12; }
    }
    r.vlaCur = r.vlaCur ? r.vlaCur.map((v, n) => v + (q[n] - v) * 0.35) : q.slice();
    A.pose(r.vlaCur[0], r.vlaCur[1], r.vlaCur[2], r.vlaCur[3], d, e);
    if (held && !V.held.visible && V.heldParts) { V.pick = (V.pick + 1) % V.heldParts.length; V.heldParts.forEach((o, k) => { o.visible = k === V.pick; }); }
    V.held.visible = held;
    if (held && st.item?.product && V.held.material) V.held.material.color.setHex(st.item.product === 'eaxle' ? 0x9a6bff : 0xf0a030);
    V.lens.emissiveIntensity = scan ? 4 : 1.2;
  }

  // 피지컬AI AMMR: 작업 중 두 팔이 번갈아 플랫폼 위 부품 빈에서 집어 대상물에 조립 (빈은 선반 왕복으로 채움)
  // 피지컬AI AMMR: 선반 앞에서 양팔로 부품을 집어(카메라 인식) 플랫폼 트레이에 담고, 셀로 돌아와 트레이의 부품을 대상물에 조립
  animAMMRVLA(r, st, busy, t, i, lead = true) {
    const u0 = st.ammr?.[i]; if (!u0) return;
    if (!busy || (u0.phase !== 'pick' && u0.phase !== 'work')) return;
    if (!lead) {   // 보조 역할: 양팔로 작업물을 잡아 고정 (게이트 결정에 따라 주 작업은 반대쪽 AMMR)
      r.vlaArm ??= [null, null];
      r.arms.forEach((a, k) => { const sd = k ? -1 : 1, q = [sd * 0.45, 0.95, 1.35, 0.7]; r.vlaArm[k] = r.vlaArm[k] ? r.vlaArm[k].map((v, n) => v + (q[n] - v) * 0.2) : q; const c = r.vlaArm[k]; a.pose(c[0], c[1] + Math.sin(t * 2 + k) * 0.015, c[2], c[3], 0, 0); });
      return;
    }
    const F = AMMR_FETCH, p = st.progress ?? 0;
    const ease = (f) => { f = Math.min(1, Math.max(0, f)); return f * f * (3 - 2 * f); };
    const lerp = (a, b, k) => a.map((v, n) => v + (b[n] - v) * k);
    r.vlaArm ??= [null, null];
    r.arms.forEach((a, k) => {
      const sd = k ? -1 : 1;
      const shelf = [sd * 0.22, 1.0, 1.4, 0.9], tray = [sd * 2.55, 1.05, 1.5, 0.95], work = [sd * 0.3, 0.85, 1.25, 0.75];
      let q, twist = 0;
      if (u0.phase === 'pick') {   // 선반 쪽: 뻗어 집기 → 플랫폼 트레이에 담기
        const f = (p - F.driveOut) / (F.pick - F.driveOut);
        q = f < 0.55 ? lerp(work, shelf, ease(f / 0.3)) : lerp(shelf, tray, ease((f - 0.55) / 0.45));
      } else if (p < F.place) {    // 셀 쪽: 트레이의 부품을 집어 대상물에 놓기
        const f = (p - F.driveIn) / (F.place - F.driveIn);
        q = f < 0.5 ? lerp(work, tray, ease(f * 2)) : lerp(tray, work, ease((f - 0.5) * 2));
      } else {                     // 조립·체결·포장
        q = work.slice(); q[1] += Math.sin(t * 7 + k * 1.7) * 0.06; twist = Math.sin(t * 5 + k) * 0.6;
      }
      r.vlaArm[k] = r.vlaArm[k] ? r.vlaArm[k].map((v, n) => v + (q[n] - v) * 0.35) : q;
      const c = r.vlaArm[k]; a.pose(c[0], c[1], c[2], c[3], 0, twist);
    });
  }

  // 구분 적재장 로봇 2대: 제품 양품이 하역될 때마다(goodBy 증가) 집기 → 들어 올려 옮기기 → 다음 적재 칸에 내려놓기 → 복귀
  animatePalletizers(parts, dts) {
    const sim = this.sim, CYC = SINK_PICK.cycle;   // 한 사이클(시뮬레이션 초) — AMR이 도착해 시뮬레이션이 집기를 시작하면(pickStartBy) 사이클 시작
    const lerpA = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const ease = (k) => k * k * (3 - 2 * k);
    for (const [k, A] of Object.entries(parts.arms)) {
      const got = sim.zone ? (sim.stats.pickStartBy?.[k] ?? 0) : (sim.stats.goodBy[k] ?? 0);
      if (A.seen == null) A.seen = got;
      if (got > A.seen) { A.queue += got - A.seen; A.seen = got; }
      A.queue = Math.min(A.queue, 3);   // 고속 재생에서 밀리면 앞 사이클은 건너뛴다
      const rz = A.sd * PALLET_ARM.z, s = PALLET_ARM.s;
      const home = armIK(s, 0, 1.9, -A.sd * 0.6);
      if (!A.cyc && A.queue > 0 && parts.auto.visible) {
        A.queue--;
        const arr = parts.zoneStacks[k], idx = Math.max(0, Math.min(arr.length - 1, sim.fgBy[k] + (sim.zone ? 0 : -A.queue - 1)));   // 놓을 자리 = 다음 칸 (구분 적재장은 집기 전이라 아직 안 셈)
        const b = arr[idx].position, topY = 0.9 + 0.5;   // AMR 지그 위 박스 윗면
        const pick = armIK(s, 0, topY, -rz), pickUp = armIK(s, 0, topY + 0.6, -rz);
        const place = armIK(s, b.x, b.y + 0.25, b.z - rz), placeUp = armIK(s, b.x, b.y + 0.95, b.z - rz);
        A.cyc = { t: 0, keys: [[0, home], [0.22, pickUp], [0.32, pick], [0.42, pickUp], [0.7, placeUp], [0.8, place], [0.9, placeUp], [1, home]], placed: false, grabBase: sim.stats.grabBy?.[k] ?? 0 };
      } else if (!A.cyc && !parts.auto.visible) A.queue = 0;
      let q = home;
      if (A.cyc) {
        const c = A.cyc; c.t += dts / CYC;
        const u = Math.min(1, c.t), i = c.keys.findIndex((kf) => kf[0] >= u);
        const [t0, p0] = c.keys[Math.max(0, i - 1)], [t1, p1] = c.keys[i];
        q = lerpA(p0, p1, ease(t1 > t0 ? (u - t0) / (t1 - t0) : 1));
        A.held.visible = u >= 0.32 && u < 0.8 && (!sim.zone || (sim.stats.grabBy?.[k] ?? 0) > c.grabBase);   // 집기 전에는 박스가 AMR 위에 있다
        if (u >= 0.8) c.placed = true;
        if (c.t >= 1) A.cyc = null;
      } else A.held.visible = false;
      A.arm.pose(q[0], q[1], q[2], q[3]);
    }
  }

  // 물류존·물류 대기 구역 바닥 표시 (단계별로 다시 그린다): 점선 테두리 + 옅은 바탕 + 이름
  buildLogistics(sim) {
    if (this.logiDeco) this.root.remove(this.logiDeco);
    const g = this.logiDeco = put(new THREE.Group(), 0, 0, 0, this.root);
    const F = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
    const flat = (w, d, mat, x, z, y) => { const m = put(new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat), x, y, z, g); m.rotation.x = -Math.PI / 2; return m; };
    const area = (x0, z0, x1, z1, rgb, title, sub, tx, tz, tw = 6) => {
      const col = new THREE.Color(`rgb(${rgb})`), w = x1 - x0, d = z1 - z0;
      flat(w, d, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.08, depthWrite: false }), (x0 + x1) / 2, (z0 + z1) / 2, 0.006);
      const tape = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85 });
      const dash = (ax, az, bx, bz) => { const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.floor(L / 0.9)); for (let i = 0; i < n; i++) { const k = (i + 0.5) / n; const m = flat(az === bz ? 0.55 : 0.09, az === bz ? 0.09 : 0.55, tape, ax + (bx - ax) * k, az + (bz - az) * k, 0.018); } };
      dash(x0, z0, x1, z0); dash(x0, z1, x1, z1); dash(x0, z0, x0, z1); dash(x1, z0, x1, z1);
      const th = tw / 5.5, c = document.createElement('canvas'); c.width = 1024; c.height = Math.round(1024 / 5.5);
      const x = c.getContext('2d'); x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillStyle = `rgba(${rgb},0.95)`; x.font = `900 ${c.height * 0.46}px ${F}`; x.fillText(title, c.width / 2, c.height * (sub ? 0.36 : 0.52));
      if (sub) { let fs = c.height * 0.24; x.font = `700 ${fs}px ${F}`; while (x.measureText(sub).width > c.width * 0.94) { fs *= 0.94; x.font = `700 ${fs}px ${F}`; } x.fillStyle = 'rgba(232,237,242,0.85)'; x.fillText(sub, c.width / 2, c.height * 0.78); }
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      flat(tw, th, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), tx, tz, 0.02);
    };
    const AMBER = '245,166,35', GREEN = '61,220,132';
    const legacy = sim.mode.key === 'traditional', agv = sim.mode.vehicleKind === 'agv';
    // 물류존: 자재창고 랙 · AGV 상차 · 부품 랙 피킹
    area(-46.3, -6.9, -40.6, 4.3, AMBER, '📦 물류존', agv ? '자재창고 · AGV 자재 상차 · 부품 랙 피킹' : '자재창고 · 지게차 자재 상차 · 부품 랙', -42.4, 3.7, 3.4);
    // 입고 지게차 전용 영역: 입고 도크 ↔ 창고 랙 왼쪽 입고 칸 ↔ 대기 — 뒤쪽 통로·세로 통로와 떨어져 있어 로봇 이동 경로와 겹치지 않는다
    { const Z = INBOUND.zone; area(Z.x0, Z.z0, Z.x1, Z.z1, GREEN, `🚚 입고 ${sim.mode.key === 'dark' ? '자율 ' : ''}지게차 전용`, '로봇 통행 금지 · 도크 ↔ 선반 입고 면', (Z.x0 + Z.x1) / 2, Z.z1 - 0.6, 4.0); }
    // 입고 지게차 주차 칸 (대기 자리, 도크 쪽을 향해 반듯이 주차)
    { const rc = sim.forklifts?.find((f) => f.receiver); if (rc) { const hx = rc.home.x, hz = rc.home.z, pl = new THREE.MeshBasicMaterial({ color: 0xf2f5f8 });
      for (const sd of [-1, 1]) flat(0.1, 2.9, pl, hx + sd * 0.9, hz + 0.15, 0.02);   // 북쪽(뒷벽 쪽) 끝선, 남쪽에서 들어온다
      flat(1.9, 0.1, pl, hx, hz - 1.3, 0.02); } }
    // 물류 대기: 부품 보충 휴머노이드 (피지컬AI)
    if (sim.helpers?.length) area(-40.4, -6.9, -37.0, 4.3, GREEN, '물류 대기', '부품 보충 휴머노이드', -38.7, 3.7, 3.0);   // 물류존(x −46.3 ~ −40.6)과 오른쪽 로봇 통로(x −36.8~) 사이, 위·아래를 물류존과 맞춤
    // 물류 대기: AGV(레거시는 지게차) 대기·충전 — 충전 패드 4칸과 충전 기둥
    area(-15.6, 12.0, -2.8, 15.5, GREEN, agv ? '🔋 물류 대기 · AGV 충전' : '물류 대기 · 지게차', agv ? '자재 공급 AGV 대기·자동 충전' : '자재 운반 지게차 대기 (유인)', -9.2, 16.25, 6.5);
    // 사족보행 충전 스테이션 (피지컬AI): 도킹 충전기 + 상태등 (충전 중 초록 점멸, 대기 파랑)
    this.quadDocks = [];
    if (sim.quads?.length) {
      const xs = sim.quads.map((q) => q.home.x), zc = sim.quads[0].home.z;
      area(Math.min(...xs) - 1.2, zc - 1.2, Math.max(...xs) + 1.2, zc + 1.9, '90,169,255', '🔋 사족보행 충전 스테이션', `순찰 로봇 ${sim.quads.length}대 · 30% 이하 자동 복귀 도킹 충전`, (Math.min(...xs) + Math.max(...xs)) / 2, zc + 2.55, 4.6);
      for (const q of sim.quads) {
        const d = put(new THREE.Group(), q.home.x, 0, q.home.z, g);
        put(new THREE.Mesh(new THREE.CircleGeometry(0.7, 28), new THREE.MeshStandardMaterial({ color: 0x1d2a3a, roughness: 0.7 })), 0, 0.012, 0, d).rotation.x = -Math.PI / 2;
        put(box(0.7, 0.55, 0.28, MAT.white), 0, 0.28, 1.05, d);                 // 충전 도크 (로봇 뒤쪽)
        put(box(0.5, 0.06, 0.4, MAT.dark), 0, 0.03, 0.75, d);                    // 충전 접점 판
        const led = emis(0x2aa8ff, 2); put(box(0.42, 0.03, 0.12, led, false), 0, 0.57, 1.05, d);   // 도크 윗면 상태등 (앞에서도 보이게)
        this.quadDocks.push({ q, led });
      }
    }
    // 물류 대기: 출하 지게차 — 두 출하 도크(트럭) 사이 벽 앞
    { const fx = YARD.waitX, fz = YARD.wallZ + 2.4; area(fx - 1.3, fz - 2.1, fx + 1.3, fz + 1.3, GREEN, '출하 대기', sim.mode.key === 'dark' ? '자율 지게차' : '출하 지게차 (유인)', fx, fz + 1.95, 3.2); }
  }

  // 화물트럭: 시뮬레이션 트럭 목록과 모델을 맞추고, 위치·방향·뒷문·적재 팔레트·라벨을 갱신한다
  updateTrucks(t, rdt) {
    const yard = this.sim.yard; if (!yard) return;
    const all = [...yard.trucks, ...(this.sim.inbound?.trucks ?? [])];
    const live = new Set(all.map((k) => k.id));
    for (const [id, tv] of this.truckViews) if (!live.has(id)) { this.dyn.remove(tv.g); tv.lbl.removeFromParent(); tv.el.remove(); this.truckViews.delete(id); }
    const STATE = { arrive: '입차', wait: '대기 · 빈 도크 기다림', toDock: '도크 후진 접안', dock: '상차', depart: '만재 출발' };
    const IN_STATE = { arrive: '입차', wait: '대기 · 입고 도크 기다림', toDock: '입고 도크 후진 접안', dock: '하차', depart: '하차 완료 출발' };
    for (const k of all) {
      let tv = this.truckViews.get(k.id);
      if (!tv) {
        const g = makeTruck(+k.id.split('-')[1] || 0);
        const el = document.createElement('div'); el.className = 'v-label truck';
        const lbl = new CSS2DObject(el); lbl.position.set(0, 4.6, 0); g.add(lbl); lbl.visible = this.labelsOn ?? true;
        this.dyn.add(g); tv = { g, el, lbl, yaw: k.heading }; this.truckViews.set(k.id, tv);
      }
      tv.g.position.set(k.x, 0, k.z);
      tv.yaw = lerpAngle(tv.yaw, k.heading, Math.min(1, rdt * 10)); tv.g.rotation.y = tv.yaw;
      const ud = tv.g.userData, open = k.state === 'dock';
      ud.doors.forEach((d, i) => { const want = open ? (i ? -1 : 1) * 1.45 : 0; d.rotation.y += (want - d.rotation.y) * Math.min(1, rdt * 3); });
      const rev = k.moving && k.route[0]?.rev;
      ud.tail.forEach((m) => { m.material.emissive.setHex(rev ? 0xffffff : 0xff3030); m.material.emissiveIntensity = rev ? (Math.sin(t * 8) > 0 ? 2.5 : 0.4) : k.moving ? 1.6 : 0.8; });
      const ps = k.pallets ?? [];
      ud.pallets.forEach((p, i) => { p.pg.visible = i < ps.length; if (i < ps.length) p.cartons.forEach((c) => (c.material = ps[i] === 'eaxle' ? MAT.crate : ps[i] === 'raw' ? MAT.raw : ps[i] === 'parts' ? MAT.partsBin : MAT.carton)); });
      tv.el.innerHTML = k.inbound ? `${k.id}<em>${IN_STATE[k.state] ?? k.state}${k.state !== 'depart' ? ` · 팔레트 ${ps.length} (원자재 ${ps.filter((x) => x === 'raw').length} · 부품 ${ps.filter((x) => x === 'parts').length})` : ''}</em>`
        : `${k.id}<em>${STATE[k.state] ?? k.state}${k.state === 'dock' || k.state === 'depart' ? ` ${k.load}/${YARD.cap}` : ''}</em>`;
    }
  }

  updateLabels() {
    const sim = this.sim;
    for (const sv of this.stationViews) {
      const st = sv.st;
      sv.el.querySelector('.nm span').textContent = st.name;
      const chip = sv.el.querySelector('.chip');
      chip.textContent = ST_LABEL[st.state] ?? st.state;
      // 상위 명령으로 걸린 속도 제한·오버라이드
      const k = st.cmd;
      if (k?.safe) chip.textContent += ' · 감속 25%';
      else if (k && k.override !== 1) chip.textContent += ` · 속도 ${Math.round(k.override * 100)}%`;
      chip.className = 'chip s-' + st.state;
      const hp = sv.el.querySelector('.hp');
      if (st.standby) {
        hp.style.display = 'none';
        chip.textContent = `미사용 · ${st.def.usedBy.label} 시나리오`;
      } else if (st.def.cycle) {
        hp.style.display = '';
        if (st.parts != null && st.parts <= sim.mode.partsReorder) chip.textContent += ` · 부품 ${st.parts}`;
        const i = hp.querySelector('i');
        i.style.width = st.health.toFixed(0) + '%';
        i.style.background = st.health > 60 ? '#3ddc84' : st.health > 40 ? '#f5b82e' : '#ff5a5a';
      } else {
        hp.style.display = 'none';
        chip.textContent += st.type === 'source' ? ` · 재고 ${sim.rawStock}` : sim.zone ? ` · 도어트림 ${sim.fgBy.doortrim} · e-axle ${sim.fgBy.eaxle}` : ` · ${sim.fgStock}/${FG_CAP}`;
      }
      const gd = sv.el.querySelector('.gd');
      if (gd) { const d = st.gate, c = st.gateCount ?? {}; gd.textContent = `🚦 ${d?.product && st.item?.id === d.id ? d.text : '게이트 대기'} · 누적 도어트림 ${c.doortrim ?? 0} · e-axle ${c.eaxle ?? 0}`; gd.className = `gd ${st.item?.id === d?.id ? d?.product ?? '' : ''}`; }
      sv.el.classList.toggle('sel', this.selected === st.id);
    }
  }

  // 중앙 관제 화면 (2016×448 = 18×4m): 왼쪽 — 핵심 지표·셀 상태·AI 판단, 오른쪽 — 이벤트 알람 · 처리 과정 · 결과
  drawScreen(k, agentLine, data = null) {
    if (data) this.dataInfo = data;
    const c = this.screenCanvas, g = c.getContext('2d'), sim = this.sim, F = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
    const blink = Math.floor(performance.now() / 600) % 2 === 0;
    const fit = (txt, w) => { let t = String(txt); if (g.measureText(t).width <= w) return t; while (t.length > 1 && g.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; };
    const mmss = (sec) => { sec = Math.max(0, Math.round(sec)); return sec >= 3600 ? `${Math.floor(sec / 3600)}시간 ${Math.floor(sec / 60) % 60}분` : sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`; };
    g.fillStyle = '#04121f'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(55,232,255,0.10)'; g.lineWidth = 1;
    for (let x = 0; x < c.width; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
    // ── 왼쪽 (x 26~926): 지표 · 셀 상태 · 누적 데이터 · AI 학습 · AI 판단
    g.fillStyle = '#37e8ff'; g.font = `800 28px ${F}`; g.textBaseline = 'alphabetic';
    g.fillText(`DIGITAL TWIN · ${sim.mode.label}`, 26, 38);
    const s0 = Math.floor(sim.time) + 8 * 3600; g.fillStyle = '#7fb8cc'; g.font = `600 21px ${F}`; g.textAlign = 'right';
    g.fillText([s0 / 3600 % 24, s0 / 60 % 60, s0 % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'), 926, 38); g.textAlign = 'left';
    const tiles = [['UPH', k.uphRecent.toFixed(0)], ['OEE', (k.OEE * 100).toFixed(1) + '%'], ['WIP', k.wip], ['POWER', k.powerKW.toFixed(0) + 'kW']];
    tiles.forEach(([a, b], i) => {
      const x = 26 + i * 226;
      g.fillStyle = 'rgba(55,232,255,0.08)'; g.fillRect(x, 50, 212, 72);
      g.fillStyle = '#7fb8cc'; g.font = `600 18px ${F}`; g.fillText(a, x + 12, 72);
      g.fillStyle = '#ffffff'; g.font = `800 36px ${F}`; g.fillText(fit(b, 190), x + 12, 112);
    });
    // 셀 상태: 한 줄(최대 6칸, 넘치면 두 줄)
    const P = sim.processing, per = Math.min(6, P.length) || 1, rows = Math.ceil(P.length / per), cw = 900 / per, rh = rows > 1 ? 44 : 60;
    P.forEach((st, i) => {
      const x = 26 + (i % per) * cw, y = 134 + Math.floor(i / per) * rh;
      const col = { BUSY: '#3ddc84', DOWN: '#ff5a5a', ESTOP: '#ff5a5a', PSTOP: '#f5b82e', MAINT: '#f5b82e', BLOCKED: '#f5b82e', NOPARTS: '#f5b82e' }[st.state] ?? '#5b7080';
      g.fillStyle = col; g.fillRect(x, y, cw - 10, 6);
      g.fillStyle = '#cfe6f0'; g.font = `700 ${rows > 1 ? 17 : 19}px ${F}`; g.fillText(fit(st.name, cw - 12), x, y + 26);
      if (rows === 1) { g.fillStyle = '#7fb8cc'; g.font = `500 16px ${F}`; g.fillText(fit(`${ST_LABEL[st.state] ?? st.state} · 건강도 ${st.health.toFixed(0)}%`, cw - 12), x, y + 50); }
      else { g.fillStyle = col; g.font = `500 14px ${F}`; g.textAlign = 'right'; g.fillText(`${st.health.toFixed(0)}%`, x + cw - 12, y + 26); g.textAlign = 'left'; }
    });
    // 누적 데이터 · AI 학습 (두 칸)
    const BY = 206, BH = 196, num = (n) => Math.round(n).toLocaleString('ko-KR');
    const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);
    const box = (x, w, title, color, rowsTxt) => {
      g.fillStyle = 'rgba(55,232,255,0.06)'; g.fillRect(x, BY, w, BH); g.fillStyle = color; g.fillRect(x, BY, w, 3);
      g.font = `800 20px ${F}`; g.fillStyle = color; g.fillText(title, x + 12, BY + 28);
      rowsTxt.forEach(([a, b, cl], i) => {
        const y = BY + 56 + i * 28;
        g.font = `500 16px ${F}`; g.fillStyle = '#7fb8cc'; g.fillText(fit(a, 150), x + 12, y);
        g.font = `700 17px ${F}`; g.fillStyle = cl ?? '#e8edf2'; g.fillText(fit(b, w - 172), x + 164, y);
      });
    };
    const D = this.dataInfo ?? {}, H = D.hub ?? {}, ep = this.epRec, V = sim.vla, A = sim.aios;
    const epB = ep?.dataBytes ?? 0, aiB = A?.on ? A.bytes ?? 0 : 0, msgB = D.bytes ?? 0;
    box(26, 440, '🗄 누적 데이터', '#37e8ff', [
      ['총 데이터량', `${size(msgB + epB + aiB)} · ${mmss(sim.time)} 수집`],
      ['설비 데이터 포인트', `${num(H.points ?? 0)}개 (자산 ${H.assets ?? 0} · 필드 ${H.fields ?? 0})`],
      ['OPC UA·AAS 메시지', `${num(D.msgs ?? 0)}건 · ${size(msgB)}`],
      ['이벤트 기록', `${num(H.events ?? 0)}건 · 인시던트 ${sim.orch?.seq ?? 0}건`],
      ...(sim.mode.key === 'dark' ? [['VLA 에피소드', `${num(ep?.total ?? 0)}개 · 약 ${size(epB)}`], ['AIOS 운영 샘플', `${num(A?.total ?? 0)}개 · 묶음 ${A?.chunks?.length ?? 0} · ${size(aiB)}`]] : [['AI 학습 데이터', '피지컬AI 단계에서 수집']]),
    ]);
    const PH = { train: '학습 중', eval: '평가 중', canary: '카나리 배포', rollout: 'OTA 배포 중', twin: '트윈 검증', shadow: '섀도 모드', verify: '배포 효과 확인' };
    const vJob = V?.job, aJob = A?.job, vLast = V?.jobs?.find((x) => x !== vJob), aLast = A?.jobs?.find((x) => x !== aJob);
    const res = (j, kind) => !j ? '아직 없음' : j.phase === 'done' ? `${j.label} ${kind === 'v' ? `검증 ${j.val}% · ` : ''}배포 완료` : j.phase === 'rejected' ? `${j.label} 기준 미달 · 배포 안 함` : j.phase === 'rollback' ? `${j.label} 롤백` : `${j.label} ${PH[j.phase] ?? j.phase}`;
    const okRate = V?.allEps ? Math.round((V.okEps / V.allEps) * 100) : null;
    box(486, 440, '🧠 AI 학습', '#b89bff', sim.mode.key !== 'dark' ? [
      ['AI 학습', '피지컬AI 단계에서 운영'], ['현재 단계', `${sim.mode.label} — 데이터 수집·관제`], ['VLA (로봇 추론)', '규칙 기반 로봇 프로그램'], ['AIOS (공장 운영)', 'MES 규칙 기반 운영'],
    ] : [
      ['VLA 로봇 모델', `${V?.label(V.latest) ?? 'v1.0'} · 에피소드 성공률 ${okRate ?? '-'}%`],
      ['VLA 학습', vJob ? `${vJob.label} ${PH[vJob.phase] ?? vJob.phase}${vJob.phase === 'train' ? ` ${vJob.epoch}/${vJob.epochs} 에폭 · loss ${vJob.loss.at(-1) ?? '-'}` : vJob.phase === 'rollout' ? ` ${vJob.rollout.length}대` : ''}` : `대기 · 새 에피소드 ${V?.newEps ?? 0}/${V?.trainAt ?? 0}`, vJob ? '#f5d36b' : null],
      ['VLA 최근 결과', res(vLast, 'v'), vLast?.phase === 'done' ? '#7dffb0' : null],
      ['AIOS 운영 모델', `${A?.version ?? 'v1.0'} · 모델 ${A?.models?.length ?? 1}개 등록`],
      ['AIOS 학습', aJob ? `${aJob.label} ${PH[aJob.phase] ?? aJob.phase}${aJob.phase === 'train' ? ` ${aJob.epoch ?? 0}/${aJob.epochs} 에폭` : ''}` : `대기 · 새 샘플 ${A?.newSamples ?? 0}/${A?.trainAt ?? 0}`, aJob ? '#f5d36b' : null],
      ['AIOS 최근 결과', res(aLast, 'a'), aLast?.phase === 'done' ? '#7dffb0' : null],
    ]);
    g.fillStyle = '#37e8ff'; g.font = `600 18px ${F}`;
    g.fillText(fit('AI 판단 ▸ ' + agentLine, 900), 26, 432);
    // ── 오른쪽: 이벤트 알람 · 처리 과정 · 결과 (x 960~1996)
    const X = 960, W = 1036, inc = sim.orch?.incidents ?? [];
    const open = inc.filter((i) => i.status === 'open').sort((a, b) => prioOf(a) - prioOf(b) || a.t0 - b.t0), done = inc.filter((i) => i.status !== 'open' && sim.time - (i.tEnd ?? 0) < 600);
    g.fillStyle = 'rgba(55,232,255,0.25)'; g.fillRect(X - 16, 14, 2, 420);
    g.font = `800 28px ${F}`; g.fillStyle = open.length ? (blink ? '#ff5a5a' : '#ff9a3d') : '#3ddc84';
    g.fillText(open.length ? `🚨 이벤트 알람 ${open.length}건 처리 중` : '✅ 이벤트 없음 · 정상 운영', X, 42);
    g.font = `600 19px ${F}`; g.fillStyle = '#7fb8cc'; g.textAlign = 'right';
    g.fillText(fit(`${sim.orch?.name ?? ''} · 최근 10분 종료 ${done.length}건`, 520), X + W, 42); g.textAlign = 'left';
    const list = [...open, ...done].slice(0, 3);
    if (!list.length) {
      g.fillStyle = '#5b7080'; g.font = `500 22px ${F}`;
      g.fillText('설비 고장 · 자재 공급 차질 · 현장 이벤트가 생기면 여기에 알람과 처리 과정, 결과가 표시됩니다', X, 120);
    }
    const CH = 120;
    list.forEach((it, n) => {
      const y = 56 + n * (CH + 6), isOpen = it.status === 'open', T = INCIDENT_TYPES[it.type] ?? { label: it.type, icon: '•' };
      const accent = isOpen ? (blink ? '#ff5a5a' : '#ff9a3d') : '#3ddc84';
      g.fillStyle = isOpen ? 'rgba(255,70,70,0.10)' : 'rgba(61,220,132,0.07)'; g.fillRect(X, y, W, CH);
      g.fillStyle = accent; g.fillRect(X, y, 7, CH);
      if (isOpen) { g.strokeStyle = accent; g.lineWidth = 2; g.strokeRect(X + 1, y + 1, W - 2, CH - 2); }
      // 1줄: 종류 · 제목 · 경과/소요
      g.font = `800 23px ${F}`; g.fillStyle = '#ffffff';
      g.fillText(fit(`${T.icon} [P${prioOf(it)}] #${it.id} ${it.title}`, W - 300), X + 20, y + 29);   // 문제 해결 우선순위
      g.textAlign = 'right'; g.font = `700 20px ${F}`; g.fillStyle = accent;
      g.fillText(isOpen ? `진행 중 · 경과 ${mmss(sim.time - it.t0)}` : `완료 · 소요 ${mmss((it.tEnd ?? sim.time) - it.t0)}`, X + W - 14, y + 29); g.textAlign = 'left';
      // 2줄: 처리 단계 진행 표시 (감지 → … → 완료 확인)
      const kinds = new Set(it.steps.map((st) => st.kind)), stages = STAGES.filter((sg) => sg.key !== 'self' || kinds.has('self'));
      const last = stages.reduce((a, sg, i) => (kinds.has(sg.key) ? i : a), -1), sw = (W - 34) / stages.length;
      stages.forEach((sg, i) => {
        const x = X + 20 + i * sw, on = kinds.has(sg.key) || i < last, cur = isOpen && i === last;
        g.fillStyle = on ? (cur ? accent : isOpen ? '#37e8ff' : '#3ddc84') : 'rgba(127,184,204,0.18)'; g.fillRect(x, y + 40, sw - 8, 7);
        g.font = `${cur ? 800 : 600} 16px ${F}`; g.fillStyle = on ? '#e8edf2' : '#5b7080'; g.fillText(fit(sg.label, sw - 10), x, y + 66);
      });
      // 3줄: 진행 중이면 최근 처리 과정, 끝났으면 결과
      const st = it.steps[it.steps.length - 1], LANE = { field: '현장', cell: '셀', orch: '오케스트레이터', exec: '실행' };
      g.font = `600 19px ${F}`; g.fillStyle = isOpen ? '#cfe6f0' : '#7dffb0';
      g.fillText(fit(isOpen ? `▸ ${LANE[st?.lane] ?? ''} · ${st?.text ?? '감지됨'}` : `결과 ▸ ${st?.text ?? '처리 완료'}`, W - 36), X + 20, y + 91);
      g.font = `500 16px ${F}`; g.fillStyle = '#7fb8cc';
      const prev = it.steps.slice(-3, -1).map((x) => x.text).join('  ›  ');
      g.fillText(fit(`${T.label}${it.source ? ` · ${it.source}` : ''}${prev ? `  |  ${prev}` : ''}`, W - 36), X + 20, y + 113);
    });
    const more = open.length + done.length - list.length;
    if (more > 0) { g.font = `600 18px ${F}`; g.fillStyle = '#7fb8cc'; g.textAlign = 'right'; g.fillText(`외 ${more}건 — 하단 오케스트레이터 버튼에서 전체 흐름 보기`, X + W, 444); g.textAlign = 'left'; }
    this.screenTex.needsUpdate = true;
  }
}

// 경로 앞뒤를 잘라낸 점 목록 (코너 유지). endTrim이 음수면 끝을 연장한다.
function trimPath(pts, startTrim, endTrim) {
  const L = pathLength(pts);
  const s0 = startTrim, s1 = L - endTrim;
  const out = [pointAt(pts, s0)];
  let acc = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc > s0 && acc < s1) out.push({ ...pts[i] });
  }
  if (s1 > L) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1], seg = Math.hypot(b.x - a.x, b.z - a.z);
    out.push({ x: b.x + ((b.x - a.x) / seg) * (s1 - L), z: b.z + ((b.z - a.z) / seg) * (s1 - L) });
  } else out.push(pointAt(pts, s1));
  return out;
}

function lerpAngle(a, b, k) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
