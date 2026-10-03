// 3D 공장 모델 — 정적 레이아웃 생성 + 시뮬레이션 상태 동기화
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RobotTelemetry } from './telemetry.js';
import { BELT_Y, LOC, chgLoc, FG_CAP, RAW_CAP, ST_LABEL } from './sim.js';
import { YARD } from './shipping.js';
import { INBOUND, WH } from './receiving.js';
import { DRONE_PAD, dronePad } from './drone.js';
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
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(19, 10); t.colorSpace = THREE.SRGBColorSpace;
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

function makeArm(mat, s = 1) {
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
function makeCarrierAMR() {
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
  const g = new THREE.Group();
  put(box(1.2, 0.6, 1.7, MAT.orange), 0, 0.55, -0.2, g);
  put(box(1.1, 0.5, 0.5, MAT.dark), 0, 0.55, -1.0, g);
  for (const [x, z] of [[-0.6, 0.35], [0.6, 0.35], [-0.6, -0.8], [0.6, -0.8]]) {
    const w = put(cyl(0.28, 0.28, 0.2, MAT.rubber, 14), x, 0.28, z, g); w.rotation.z = Math.PI / 2;
  }
  put(box(0.08, 2.2, 0.08, MAT.dark), -0.45, 1.25, 0.75, g);
  put(box(0.08, 2.2, 0.08, MAT.dark), 0.45, 1.25, 0.75, g);
  put(box(1.0, 0.06, 0.06, MAT.dark), 0, 2.3, 0.75, g);
  for (const x of [-0.3, 0.3]) put(box(0.12, 0.05, 1.1, MAT.steel), x, 0.15, 1.3, g);
  const roof = put(box(1.2, 0.06, 1.3, MAT.dark), 0, 2.1, -0.4, g);
  for (const [x, z] of [[-0.55, 0.2], [0.55, 0.2], [-0.55, -1.0], [0.55, -1.0]]) put(box(0.05, 1.25, 0.05, MAT.dark), x, 1.45, z, g);
  const driver = makeWorker(0xf2c230); driver.scale.setScalar(0.85); put(driver, 0, 0.55, -0.4, g);
  const beacon = put(box(0.22, 0.14, 0.22, emis(0xffb020, 2.5), false), 0, 2.2, -0.4, g); beacon.visible = false;   // 자율 지게차 경광등
  const load = put(new THREE.Group(), 0, 0.2, 1.3, g);
  put(box(1.0, 0.12, 1.1, MAT.pallet), 0, 0.06, 0, load);
  const crates = [];
  for (let k = 0; k < 6; k++) crates.push(put(box(0.42, 0.3, 0.34, MAT.raw), -0.24 + (k % 2) * 0.48, 0.28, -0.36 + Math.floor(k / 2) * 0.36, load));
  load.visible = false;
  g.userData = { led: null, load, crates, roof, driver, beacon };
  return g;
}

// 화물트럭 (로컬 +z = 운전석 방향). 적재함은 반투명 커튼 사이더라 실린 팔레트가 보이고, 뒷문은 도크 쪽으로 열린다
const TRUCK_COLORS = [0x2a6fdb, 0xd23b3b, 0x2e9e6a, 0xf2a020, 0x6d5acf];
function makeTruck(i) {
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
  put(mesh(new THREE.CapsuleGeometry(0.19, 0.32, 4, 10), shell), 0, 1.32, 0, body);
  put(box(0.2, 0.12, 0.03, acc, false), 0, 1.38, 0.2, body);                 // 가슴 상태등
  put(cyl(0.05, 0.06, 0.08, joint), 0, 1.68, 0, body);
  const head = put(new THREE.Group(), 0, 1.84, 0, body);
  put(mesh(new THREE.SphereGeometry(0.15, 16, 12), shell), 0, 0, 0, head);
  const visor = emis(0x37e8ff, 2.2);
  put(box(0.22, 0.06, 0.06, visor, false), 0, 0.01, 0.12, head);
  const arm = (x) => {
    const sh = put(new THREE.Group(), x, 1.52, 0, body);
    put(mesh(new THREE.SphereGeometry(0.08, 10, 8), joint), 0, 0, 0, sh);
    put(mesh(new THREE.CapsuleGeometry(0.06, 0.48, 4, 8), shell), 0, -0.3, 0, sh);
    put(box(0.08, 0.1, 0.1, joint), 0, -0.62, 0, sh);
    return sh;
  };
  const armL = arm(-0.27), armR = arm(0.27);
  const bin = put(box(0.42, 0.24, 0.32, std(0x2f6fd6)), 0, 1.0, 0.38, body);   // 부품 빈 (운반 중)
  bin.visible = false;
  g.userData = { body, armL, armR, legL: legs[0], legR: legs[1], visor, bin, acc };
  return g;
}

// 사족보행 로봇 — 등 위 센서 마스트(열화상·음향 카메라)로 순찰 점검
function makeQuadruped() {
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
    put(box(0.82, 0.3, 0.64, MAT.white), 0, 0.2, 0, root);
    put(box(0.86, 0.07, 0.68, MAT.dark), 0, 0.06, 0, root);
    for (const [x, z] of [[-0.34, 0.24], [0.34, 0.24], [-0.34, -0.24], [0.34, -0.24]]) put(cyl(0.08, 0.08, 0.06, MAT.rubber, 12), x, 0.07, z, root).rotation.z = Math.PI / 2;
    const led = emis(0x2aa8ff, 2.2);
    put(box(0.84, 0.04, 0.03, led, false), 0, 0.3, 0.33, root);
    put(cyl(0.07, 0.07, 0.06, MAT.dark, 14), 0, 0.38, 0.24, root);                          // 라이다
    const bin = put(box(0.36, 0.18, 0.26, std(0x2f6fd6)), 0, 0.44, -0.2, root); bin.visible = false;   // 선반에서 가져오는 부품 빈
    const lift = put(new THREE.Group(), 0, 0.35, -0.05, root);
    put(box(0.2, 0.62, 0.2, MAT.steel), 0, 0.31, 0, lift);
    put(box(0.5, 0.3, 0.3, COBOT_MAT), 0, 0.72, 0, lift);                                    // 가슴
    put(box(0.52, 0.05, 0.31, MAT.orange), 0, 0.6, 0, lift);
    const head = put(new THREE.Group(), 0, 0.98, 0.02, lift);
    put(box(0.2, 0.16, 0.18, MAT.dark), 0, 0, 0, head);
    put(box(0.16, 0.05, 0.02, emis(0x37e8ff, 2), false), 0, 0.01, 0.1, head);                 // 스테레오 카메라
    const arms = [-1, 1].map((sd) => {
      const a = makeArm(COBOT_MAT, 0.46);
      put(a.root, sd * 0.33, 0.7, 0, lift); a.root.rotation.z = -sd * 0.35;                   // 어깨에서 바깥쪽으로 약간 기울여 장착
      put(cyl(0.06, 0.06, 0.05, COBOT_JOINT), 0, 0.09, 0, a.turret);
      return a;
    });
    const sideNames = ['왼팔', '오른팔'];
    return {
      root, kind, tip: arms[0].tip, tip2: arms[1].tip, head, bin, payload: 10, dual: true, arms, lift,
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
    const shell = std(0xe6e9ee, { roughness: 0.35, metalness: 0.2 }), jm = std(0x2a2f36, { roughness: 0.5, metalness: 0.4 });
    const legs = [-0.12, 0.12].map((x) => {
      const hip = put(new THREE.Group(), x, 0.92, 0, root);
      put(mesh(new THREE.CapsuleGeometry(0.08, 0.36, 4, 8), shell), 0, -0.22, 0, hip);
      put(mesh(new THREE.SphereGeometry(0.075, 10, 8), jm), 0, -0.45, 0.01, hip);
      put(mesh(new THREE.CapsuleGeometry(0.07, 0.34, 4, 8), shell), 0, -0.67, 0, hip);
      put(box(0.13, 0.06, 0.24, jm), 0, -0.89, 0.04, hip);
      return hip;
    });
    put(box(0.34, 0.16, 0.2, jm), 0, 0.98, 0, root);                                       // 골반
    const torso = put(new THREE.Group(), 0, 1.0, 0, root);                                  // 허리 회전
    put(mesh(new THREE.CapsuleGeometry(0.19, 0.3, 4, 10), shell), 0, 0.3, 0, torso);
    const led = emis(0xff8a2a, 1.6); put(box(0.2, 0.1, 0.03, led, false), 0, 0.36, 0.2, torso);   // 가슴 상태등
    put(cyl(0.05, 0.06, 0.08, jm), 0, 0.64, 0, torso);
    const head = put(new THREE.Group(), 0, 0.8, 0, torso);
    put(mesh(new THREE.SphereGeometry(0.15, 16, 12), shell), 0, 0, 0, head);
    put(box(0.22, 0.06, 0.06, emis(0x37e8ff, 2.2), false), 0, 0.01, 0.12, head);             // 스테레오 카메라 (바이저)
    const arms = [-1, 1].map((sd) => {
      put(mesh(new THREE.SphereGeometry(0.085, 10, 8), jm), sd * 0.25, 0.52, 0, torso);       // 어깨
      const a = makeArm(COBOT_MAT, 0.42);
      put(a.root, sd * 0.3, 0.5, 0.06, torso); a.root.rotation.set(1.35, 0, -sd * 0.2);    // 어깨에서 앞쪽(작업대)으로 뻗도록 장착
      return a;
    });
    const sideNames = ['왼팔', '오른팔'];
    return {
      root, kind, tip: arms[0].tip, tip2: arms[1].tip, head, payload: 15, dual: true, arms, torso, legs,
      jointDefs: [{ name: '허리 회전', unit: 'rad', min: -0.6, max: 0.6 },
        ...sideNames.flatMap((n) => ARM_JOINTS.map((j) => ({ ...j, name: `${n} ${j.name}` })))],
      joints: () => [torso.rotation.y, ...arms[0].joints(), ...arms[1].joints()],
      cur: null,
      anim(busy, t) {
        const w = t * 1.4;
        const target = [busy ? Math.sin(w * 0.45) * 0.28 : 0, busy ? Math.sin(w * 0.7) * 0.25 : 0];
        arms.forEach((a, i) => {
          const ph = w + i * Math.PI * 0.5, sd = i ? -1 : 1;   // 두 팔이 엇갈려 집고 놓는다
          target.push(...(busy ? [sd * (0.25 + Math.sin(ph) * 0.22), 0.85 + Math.sin(ph * 1.3) * 0.15, 1.25 + Math.cos(ph) * 0.12, 0.7, Math.sin(ph * 0.9) * 0.3, Math.sin(ph * 0.6) * 1.4]
            : [sd * 0.1, 0.2, 0.9, 0.4, 0, 0]));
        });
        this.cur = this.cur ? this.cur.map((c, i) => c + (target[i] - c) * 0.12) : target;
        const c = this.cur;
        torso.rotation.y = c[0]; head.rotation.y = c[1] - c[0] * 0.5;
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
    for (const z of [-1.6, 1.6]) {
      for (const x of [-L / 2, L / 2]) put(box(0.14, 2.6, 0.14, MAT.yellow), x, 1.3, z, root);   // 기둥 4개
      put(box(L + 0.14, 0.16, 0.16, MAT.yellow), 0, 2.68, z, root);                                // X축 레일
      put(box(L, 0.03, 0.05, MAT.steel), 0, 2.78, z, root);                                        // 리니어 가이드
    }
    const bridge = put(new THREE.Group(), 0, 0, 0, root);                                          // X축 주행 브리지
    put(box(0.22, 0.2, 3.4, MAT.yellow), 0, 2.86, 0, bridge);
    for (const z of [-1.6, 1.6]) put(box(0.34, 0.16, 0.26, MAT.dark), 0, 2.86, z, bridge);          // 레일 위 주행 블록
    const car = put(new THREE.Group(), 0, 2.7, 0, bridge);                                         // Y축 캐리지
    put(box(0.36, 0.26, 0.36, color), 0, 0, 0, car);
    const rod = put(box(0.08, 1.0, 0.08, MAT.steel), 0, -0.6, 0, car);                             // Z축
    put(box(0.34, 0.06, 0.26, MAT.dark), 0, -0.5, 0, rod);
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
    const held = put(box(0.12, 0.08, 0.12, std(0x3ddc84)), 0, 0.06, 0, r.tip); held.visible = false;
    r.vla = { shelf: { x: sx, y: 0.06 + 0.92 + 0.15, z: sz }, bins, held, lens, dir };
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
  const feeders = [];
  for (const z of [-1.0, 1.0]) {
    const r = put(new THREE.Group(), -1.95, 0.06, z, g); feeders.push(r);
    put(box(0.55, 1.0, 0.6, MAT.steel), 0, 0.5, 0, r);
    colors.forEach((c, i) => put(box(0.24, 0.16, 0.26, std(c)), -0.13 + (i % 2) * 0.26, 0.6 + Math.floor(i / 2) * 0.3, 0, r));
  }
  const bowl = put(cyl(0.3, 0.2, 0.3, MAT.steel), 1.95, 1.05, -1.0, g); feeders.push(bowl);
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
function buildScrew(g) {
  // 너트러너 문형은 대상물(셀 중앙) 바로 위 — 기둥은 양쪽 로봇 팔 작업 범위(x<-0.3) 밖
  for (const z of [-1.1, 1.1]) put(box(0.12, 2.6, 0.12, MAT.steel), 0.15, 1.45, z, g);
  put(box(0.2, 0.2, 2.4, MAT.steel), 0.15, 2.75, 0, g);
  const head = put(new THREE.Group(), 0.15, 2.3, 0, g);
  put(box(0.3, 0.35, 0.3, MAT.accent), 0, 0.1, 0, head);
  const bit = put(cyl(0.035, 0.05, 0.55, MAT.steel, 10), 0, -0.3, 0, head);
  const feeders = [];
  for (const z of [-1.0, 1.0]) {
    const f = put(box(0.45, 0.5, 0.4, MAT.white), -1.95, 0.45, z, g); feeders.push(f);
    put(cyl(0.16, 0.1, 0.18, MAT.steel), 0, 0.34, 0, f);
  }
  const ctl = put(box(0.5, 0.7, 0.35, MAT.dark), 1.95, 0.4, 1.6, g);
  const screen = emis(0x3ddc84, 1.2);
  put(box(0.36, 0.25, 0.02, screen, false), 0, 0.15, 0.18, ctl);
  return { head, bit, screen, feeders };
}

// 부품체결셀(e-axle): 다축 너트러너 포털 + 토크 모니터
function buildFasten(g) {
  for (const z of [-1.3, 1.3]) put(box(0.18, 3.0, 0.18, MAT.dark), 0.2, 1.6, z, g);
  put(box(0.3, 0.3, 2.8, MAT.dark), 0.2, 3.1, 0, g);
  const head = put(new THREE.Group(), 0.2, 2.4, 0, g);
  put(cyl(0.12, 0.12, 0.9, MAT.steel), 0, 0.45, 0, head);
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

function buildSource(g) {
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
  const lift = put(new THREE.Group(), 0, 0, 0, car);                                       // Z축 승강
  put(box(0.08, 1.4, 0.08, MAT.steel), 0, -0.9, 0, lift);
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
    const floor = put(mesh(new THREE.PlaneGeometry(76, 40), floorMat, false), 0, 0, 0, r);
    floor.rotation.x = -Math.PI / 2;
    this.floorMat = floorMat;
    // AGV 통로
    const laneGeo = (w, d) => new THREE.PlaneGeometry(w, d);
    const lanes = [[0, 9, 70, 2.6], [0, -9, 70, 2.6], [-33, 0, 2.6, 20.6], [35, 0, 2.6, 20.6]];
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
    put(box(57, 8, 0.3, MAT.wall), -9.5, 4, -20, r);
    const doorW = 4.6, spans = [[19, YARD.bays[0] - doorW / 2], [YARD.bays[0] + doorW / 2, YARD.bays[1] - doorW / 2], [YARD.bays[1] + doorW / 2, 38]];
    for (const [a, b] of spans) put(box(b - a, 8, 0.3, MAT.wall), (a + b) / 2, 4, -20, r);
    for (const bx of YARD.bays) put(box(doorW, 8 - 4.9, 0.3, MAT.wall), bx, 4.9 + (8 - 4.9) / 2, -20, r);
    put(box(19, 0.3, 0.32, MAT.steel), 28.5, 0.15, -20, r);
    // 왼쪽 벽: 입고 도크 문(z −16.8~−12.2, 높이 4.9m)만 트럭 하차용으로 열고 나머지는 외벽
    { const dz0 = INBOUND.dockZ - 2.3, dz1 = INBOUND.dockZ + 2.3;
      put(box(0.3, 8, dz0 + 20, MAT.wall), -38, 4, (-20 + dz0) / 2, r);
      put(box(0.3, 8, 20 - dz1, MAT.wall), -38, 4, (dz1 + 20) / 2, r);
      put(box(0.3, 8 - 4.9, 4.6, MAT.wall), -38, 4.9 + (8 - 4.9) / 2, INBOUND.dockZ, r);
      put(box(0.32, 0.3, 14, MAT.steel), -38, 0.15, -13, r);
      // 입고 도크: 말아 올린 셔터·문틀·도크 레벨러·범퍼·표지
      put(cyl(0.32, 0.32, 4.6, MAT.dark, 16), -37.85, 4.75, INBOUND.dockZ, r).rotation.x = Math.PI / 2;
      put(box(0.14, 0.25, 4.8, MAT.yellow), -37.75, 4.6, INBOUND.dockZ, r);
      for (const sd of [-1, 1]) put(box(0.2, 4.6, 0.18, MAT.yellow), -37.8, 2.3, INBOUND.dockZ + sd * 2.35, r);
      put(box(1.4, 0.08, 2.6, MAT.steel), -37.2, 0.04, INBOUND.dockZ, r);
      for (const sd of [-1, 1]) put(box(0.25, 0.5, 0.35, MAT.rubber), -38.3, 1.0, INBOUND.dockZ + sd * 1.15, r);
      put(makeSignSprite('입고 도크', '#3ddc84', 3.2), -37.6, 5.6, INBOUND.dockZ, r); }
    put(box(0.3, 8, 40, MAT.wall), 38, 4, 0, r);
    for (let x = -36; x <= 36; x += 9) put(box(0.6, 8, 0.6, MAT.steel), x, 4, -19.6, r);
    put(box(76, 0.5, 0.35, MAT.accent), 0, 7.7, -19.8, r);
    // 천장 형광등 기구는 두지 않는다 — 공장 밝기는 환경광·주광·보조광(main.js LOOK)으로 단계별로 유지
    // 캠틱종합기술원 사인 — 뒷벽, 중앙 관제 화면 왼쪽 빈 칸. 로고 글자가 흰색이라 남색 백보드 위에 붙인 백라이트 사인으로 만든다
    // 벽 기둥(9m 간격, x=-18·-9) 사이에 들어가도록 폭 8m, 관제 화면과 같은 중심 높이(5.1m)
    const sign = put(new THREE.Group(), -13.5, 5.1, -19.78, r);
    put(box(8.0, 2.95, 0.12, std(0x0c2048, { roughness: 0.5, metalness: 0.2 })), 0, 0, 0, sign);
    put(box(8.0, 0.08, 0.14, MAT.accent), 0, -1.52, 0, sign);
    const logoTex = new THREE.TextureLoader().load('assets/camtic_logo.png');
    logoTex.colorSpace = THREE.SRGBColorSpace; logoTex.anisotropy = 8;
    // 흰 글자가 블룸으로 번지지 않게 밝기를 조금 낮춘다
    put(new THREE.Mesh(new THREE.PlaneGeometry(7.4, 7.4 * 187 / 550), new THREE.MeshBasicMaterial({ map: logoTex, color: 0xcfd3d8, transparent: true, depthWrite: false })), 0, 0, 0.07, sign);
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
    this.buildSlogans();
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
    // 왼쪽 벽 바깥 가운데 (z 0, 입고 도크 문 z −16.8~−12.2를 비켜 폭 22m) — 바깥(−x)을 향함
    const left = put(make(22, H), -38.2, Y, 0, this.root); left.rotation.y = -Math.PI / 2;
    // 오른쪽 벽 바깥 — 바깥(+x)을 향함
    const right = put(make(26, H), 38.2, Y, 0, this.root); right.rotation.y = Math.PI / 2;
    this.facadeSigns = [back, left, right];
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

  // 벽면 슬로건 현수막 (단계별 하나만 보임): 레거시 — 캠틱 로고와 출하 도크 사이, 자동화 — 중앙 관제 화면과 출하 도크 사이
  // 판 크기는 글자에 맞춘다: 글자 높이 f(m) 기준으로 좌우 여백 0.9f, 위아래 여백 0.55f, 줄 간격 1.3f — 두 현수막 글자 크기가 같다
  buildSlogans() {
    const r = this.root, FONT = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
    const banner = (lines, x0, x1, { bg, fg, accent, stripe }, f = 1.0) => {
      const m = document.createElement('canvas').getContext('2d'); m.font = `900 100px ${FONT}`;
      const tw = Math.max(...lines.map((l) => m.measureText(l).width)) / 100 * f;
      const w = Math.min(x1 - x0, tw + 1.8 * f), h = lines.length * 1.3 * f + 1.1 * f;
      const g = put(new THREE.Group(), (x0 + x1) / 2, 5.1, -19.12, r);
      const px = 2048 / w, c = document.createElement('canvas'); c.width = 2048; c.height = Math.round(h * px);
      const x = c.getContext('2d'), band = 0.16 * f * px;
      x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = accent; x.fillRect(0, 0, c.width, band); x.fillRect(0, c.height - band, c.width, band);
      if (stripe) for (let i = -band * 2; i < c.width; i += band * 3) { x.fillStyle = stripe; x.beginPath(); x.moveTo(i, c.height - band); x.lineTo(i + band * 1.2, c.height - band); x.lineTo(i + band * 2.2, c.height); x.lineTo(i + band, c.height); x.fill(); }
      x.font = `900 ${f * px}px ${FONT}`; x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
      lines.forEach((l, i) => x.fillText(l, c.width / 2, (0.55 * f + 0.65 * f + i * 1.3 * f) * px));
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      put(box(w + 0.2, h + 0.2, 0.08, MAT.dark), 0, 0, -0.06, g);
      put(new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 })), 0, 0, 0, g);
      g.visible = false;
      return g;
    };
    // 레거시: 숙련 기술을 강조하는 전통 공장 현수막 (흰 바탕 · 빨간 글씨, 한 줄)
    this.sloganLegacy = banner(['우리의 숙련된 기술이 곧 회사의 경쟁력입니다!'], -8.8, 18.4, { bg: '#f4f1ea', fg: '#c8202a', accent: '#1d3f8f' });
    // 자동화: 설비 점검·안전 수칙 현수막 (남색 바탕 · 흰 글씨 · 노랑 안전 띠, 두 줄)
    this.sloganSmart = banner(['설비 점검은 철저하게,', '안전 수칙은 엄격하게'], 4.6, 18.4, { bg: '#123a7a', fg: '#ffffff', accent: '#f2c230', stripe: '#1b1b1b' });
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
    flat(42, 42, std(0x2b3036, { roughness: 0.95 }), -59, -24, -0.01);   // 서쪽으로 돌아 도크 중심선에 서는 공간까지
    flat(9, 36, std(0x24282d, { roughness: 0.95 }), INBOUND.roadX, -24, 0.0);
    flat(108, 7, std(0x24282d, { roughness: 0.95 }), -47, INBOUND.roadZ, 0.0);
    for (let x = -100; x < 7; x += 4) flat(2, 0.15, white, x, INBOUND.roadZ, 0.02);
    for (let z = -38; z < -6; z += 4) flat(0.15, 2, white, INBOUND.roadX, z, 0.02);
    for (const sd of [-1, 1]) flat(12, 0.15, line, -44.2, INBOUND.dockZ + sd * 1.7, 0.02);
    { const c2 = document.createElement('canvas'); c2.width = 1024; c2.height = 128;
      const g2 = c2.getContext('2d'); g2.fillStyle = 'rgba(61,220,132,0.95)'; g2.font = '700 64px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
      g2.fillText('입고 트럭 야드 · 입고 도크', 512, 64);
      const t2 = new THREE.CanvasTexture(c2); t2.colorSpace = THREE.SRGBColorSpace;
      const m2 = flat(14, 1.75, new THREE.MeshBasicMaterial({ map: t2, transparent: true, depthWrite: false }), -47, -21.5, 0.03); m2.rotation.z = 0; }
    const tx = document.createElement('canvas'); tx.width = 1024; tx.height = 128;
    const c = tx.getContext('2d'); c.fillStyle = 'rgba(242,194,48,0.95)'; c.font = '700 64px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('출하 트럭 야드 · 도크 1 · 대기 · 도크 2', 512, 64);
    const tex = new THREE.CanvasTexture(tx); tex.colorSpace = THREE.SRGBColorSpace;
    flat(16, 2, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }), YARD.waitX, -35.2, 0.03);
  }

  buildAreas() {
    const r = this.root;
    // 자재 공급 차질 경보: 자재창고 랙 주변
    this.whAlarm = put(makeAlarmFx(12.4, 4.6, 5.2), -26, 0, -16.5, r);
    // 물류 선반(자재창고 랙): 왼쪽 2열 × 3단 = 원자재 6칸, 오른쪽 2열 × 3단 = 부품 6칸 (한 칸 = 입고 팔레트 1개)
    // 원자재 칸은 박스 2단(20박스씩 = AGV 1회분), 부품 칸은 부품 빈 6개(40개씩) — 재고만큼 차고 배달할수록 줄어든다
    const rack = new THREE.Group(); put(rack, -26, 0, -16.5, r);
    this.whRawSlots = []; this.whPartSlots = []; this.whOut = false;
    this.whSign = put(makeSignSprite('⛔ 출고 중단 · 공급 차질', '#ff8a1f', 7.5), -26, 7.4, -15.5, r); this.whSign.visible = false;
    for (const x of [-5, -2.5, 0, 2.5, 5]) for (const z of [-1, 1]) put(box(0.12, 5, 0.12, MAT.accent), x, 2.5, z, rack);
    for (const y of [0.3, 1.9, 3.5]) {
      put(box(10.2, 0.1, 2.1, MAT.steel), 0, y, 0, rack);
      for (const x of [-3.75, -1.25]) {   // 원자재
        put(box(2.0, 0.12, 1.6, MAT.pallet), x, y + 0.11, 0, rack);
        const lo = put(box(1.8, 0.42, 1.4, MAT.raw), x, y + 0.38, 0, rack), hi = put(box(1.8, 0.42, 1.4, MAT.raw), x, y + 0.82, 0, rack);
        this.whRawSlots.push({ lo, hi, y });
      }
      for (const x of [1.25, 3.75]) {     // 부품
        put(box(2.0, 0.12, 1.6, MAT.pallet), x, y + 0.11, 0, rack);
        const bins = [];
        for (let k = 0; k < 6; k++) bins.push(put(box(0.56, 0.36, 0.62, MAT.partsBin), x - 0.62 + (k % 3) * 0.62, y + 0.37, -0.34 + Math.floor(k / 3) * 0.68, rack));
        this.whPartSlots.push({ bins, y });
      }
    }
    // 원자재 칸이 아래 단부터 차도록 정렬 (단 → 열)
    this.whRawSlots.sort((a, b) => a.y - b.y); this.whPartSlots.sort((a, b) => a.y - b.y);
    // 선반 앞 표지
    put(makeSignSprite('원자재', '#c9d2dc', 2.2), -28.5, 5.3, -15.3, r);
    put(makeSignSprite('부품', '#5aa9ff', 2.2), -23.5, 5.3, -15.3, r);
    // 물류 선반 재고 현황판 (랙 위 뒷벽): 재고 막대 · 입고 순환 상태 · 입출고 횟수
    const sc = document.createElement('canvas'); sc.width = 1536; sc.height = 420;
    this.whBoard = { cv: sc, tex: new THREE.CanvasTexture(sc), key: '' }; this.whBoard.tex.colorSpace = THREE.SRGBColorSpace; this.whBoard.tex.anisotropy = 8;
    const bd = put(new THREE.Group(), -26, 6.25, -19.2, r);
    put(box(10.4, 2.95, 0.12, std(0x0b0d10, { roughness: 0.5, metalness: 0.4 })), 0, 0, -0.07, bd);
    put(new THREE.Mesh(new THREE.PlaneGeometry(10, 2.73), new THREE.MeshBasicMaterial({ map: this.whBoard.tex, toneMapped: false })), 0, 0, 0, bd);
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
    const tech = put(new THREE.Group(), LOC.TECH.x + 0.8, 0, 16.5, r);
    put(box(5, 0.02, 3.5, std(0x6b4a2a)), 0, 0.01, -1.5, tech);
    // 공구함(빨강)·정비 작업대(회색)는 양옆에 두고 가운데를 비워 바닥 표시가 보이게 한다
    put(box(0.6, 1.8, 1.6, std(0xc0392b)), -2.15, 0.9, -1.4, tech);
    put(box(0.7, 0.9, 1.6, MAT.steel), 2.15, 0.45, -1.4, tech);
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
      const m = put(new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.0), new THREE.MeshBasicMaterial({ map: textTex(['🔧 정비실', sub], 3.4, 1.0, { fg: 'rgba(255,255,255,0.92)', sub: 'rgba(255,214,140,0.95)', border: 'rgba(242,194,48,0.9)' }), transparent: true, depthWrite: false })), 0, 0.03, -0.9, tech);
      m.rotation.x = -Math.PI / 2; m.visible = false; this.techMarks[k] = m;
    }
    // 표지판: 정비 대기 자리 뒤(라인 쪽 가장자리) 기둥 2개 위 — 앞에서 보면 대기 중인 정비 로봇 위로 보인다
    const signG = put(new THREE.Group(), 0, 0, -3.45, tech);
    for (const sx of [-1.3, 1.3]) put(box(0.08, 2.6, 0.08, MAT.steel), sx, 1.3, 0, signG);
    put(box(2.9, 0.9, 0.06, MAT.dark), 0, 2.45, 0, signG);
    put(new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.8), new THREE.MeshStandardMaterial({ map: textTex(['🔧 정비실', 'MAINTENANCE STATION'], 2.8, 0.8, { bg: '#1d3f8f', fg: '#ffffff', sub: '#f2c230' }), roughness: 0.6 })), 0, 2.45, 0.035, signG);
    // 관제/서버
    const srv = (this.server = put(new THREE.Group(), -2, 0, -17.5, r));
    this.serverLeds = [];
    for (const x of [-1.6, -0.5, 0.6, 1.7]) {
      const rk = put(box(0.9, 2.3, 1.0, MAT.dark), x, 1.15, 0, srv);
      for (let k = 0; k < 6; k++) {
        const m = emis(k % 2 ? 0x3dff8a : 0x2aa8ff, 2);
        this.serverLeds.push(m);
        put(box(0.6, 0.04, 0.02, m, false), 0, -0.8 + k * 0.32, 0.51, rk);
      }
    }
    this.serverPos = new THREE.Vector3(-2, 2.6, -17);
    // 디지털 트윈 대형 화면
    const c = document.createElement('canvas'); c.width = 1024; c.height = 340;
    this.screenCanvas = c;
    this.screenTex = new THREE.CanvasTexture(c); this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const scrMat = new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false });
    // 벽 기둥 앞(z -19.15)에 설치 — 오른쪽 로봇 비전 관제 화면과 같은 크기·높이·테두리 (js/robotcam.js DISPLAY)
    this.screen = put(new THREE.Mesh(new THREE.PlaneGeometry(12, 4), scrMat), -2, 5.1, -19.15, r);
    put(new THREE.Mesh(new THREE.BoxGeometry(12.3, 4.3, 0.12), std(0x14181e, { roughness: 0.6, metalness: 0.3 })), 0, 0, -0.08, this.screen);
    // 관제 데스크
    put(box(3.5, 0.8, 1.0, MAT.white), LOC.CTRL.x, 0.4, LOC.CTRL.z - 1.4, srv.parent);
  }

  // 모드별 설비/인원/조명 구성
  setup(sim, labelsOn = true, changed = null) {
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
    this.screen.visible = mode !== 'traditional';
    this.sloganLegacy.visible = mode === 'traditional';
    this.buildLogistics(sim);
    this.techMarks.human.visible = sim.mode.techKind !== 'humanoid'; this.techMarks.humanoid.visible = sim.mode.techKind === 'humanoid';
    this.sloganSmart.visible = mode === 'smart';

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
    return [...this.stationViews.map((s) => s.group), this.dyn];
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
      g.userData = { base, part, carton, tag, panel, arm, clips, housing, bolts, amr };
      this.dyn.add(g);
    }
    g.visible = true;
    return g;
  }
  styleItem(g, item) {
    const { base, part, carton, tag, panel, arm, clips, housing, bolts, amr } = g.userData;
    amr.visible = !!item.carrier;
    const dt = item.product === 'doortrim', ea = item.product === 'eaxle';
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
    const place = (item, x, y = BELT_Y, z = 0, yaw = 0) => {
      let g = this.itemMeshes.get(item.id);
      if (!g) { g = this.getItemMesh(); this.itemMeshes.set(item.id, g); }
      seen.add(item.id);
      g.userData.itemId = item.id;
      this.styleItem(g, item);
      g.position.set(x, y, z);
      g.rotation.y = yaw;
    };
    for (const c of sim.conveyors) for (const e of c.items) {
      const q = pointAt(c.path, e.s), q2 = pointAt(c.path, Math.min(c.len, e.s + 0.3)), q0 = pointAt(c.path, Math.max(0, e.s - 0.3));
      place(e.item, q.x, BELT_Y, q.z, Math.atan2(-(q2.z - q0.z), q2.x - q0.x));
    }
    for (const st of sim.processing) if (st.item) {
      const k = Math.min(1, st.itemT / (sim.entryTime ?? 0.5));
      const from = st.itemFrom ?? toWorld(st.def, -2, 0);   // 들어온 경로 끝점에서 셀 중앙으로
      const q = { x: from.x + (st.x - from.x) * k, z: from.z + (st.z - from.z) * k };
      let y = BELT_Y;
      if (st.state === 'BUSY' && (st.type === 'cnc' || st.type === 'press')) y += Math.sin(this.time * 60) * 0.006;
      place(st.item, q.x, y, q.z);
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

    // 차량
    for (const vv of this.vehicleViews) {
      const v = vv.v;
      vv.g.position.set(v.x, 0, v.z);
      vv.yaw = lerpAngle(vv.yaw, v.heading, Math.min(1, rdt * 8));
      vv.g.rotation.y = vv.yaw;
      const { load, crates, led } = vv.g.userData;
      load.visible = !!v.load;
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
    const st = v.station;
    if (!moved && st) target = Math.atan2(st.x - v.x, st.z - v.z);
    if (!moved && isTech && v.task && v.kind === 'human') target = Math.PI;
    pv.yaw = lerpAngle(pv.yaw, target, Math.min(1, rdt * 6));
    g.rotation.y = pv.yaw;
    const ud = g.userData;
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
        const top = parts.stack[raw - 1]?.position;
        const pick = top ? { x: top.x, z: top.z, y: top.y } : { x: 0, z: 1.5, y: 0.45 };
        const place = { x: 0, z: 0, y: BELT_Y + 0.18 }, UP = 2.05;     // 박스 중심 높이 기준
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
        parts.stack.forEach((bx, i) => (bx.visible = i < raw - (hold ? 1 : 0)));
        break;
      }
      case 'sink': {
        const fg = this.sim.fgStock;
        // 로봇이 아직 내려놓지 않은 박스(집는 중·옮기는 중·대기 중)는 적재 팔레트에 보이지 않는다
        if (parts.zoneStacks) for (const [k, arr] of Object.entries(parts.zoneStacks)) { const a = parts.arms?.[k], pend = a ? a.queue + (a.cyc && !a.cyc.placed ? 1 : 0) : 0; arr.forEach((b, i) => (b.visible = i < this.sim.fgBy[k] - pend)); }
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
    V.held.visible = held;
    if (held && st.item?.product) V.held.material.color.setHex(st.item.product === 'eaxle' ? 0x9a6bff : 0xf0a030);
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
    const sim = this.sim, CYC = 3.2;   // 한 사이클(시뮬레이션 초)
    const lerpA = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const ease = (k) => k * k * (3 - 2 * k);
    for (const [k, A] of Object.entries(parts.arms)) {
      const got = sim.stats.goodBy[k] ?? 0;
      if (A.seen == null) A.seen = got;
      if (got > A.seen) { A.queue += got - A.seen; A.seen = got; }
      A.queue = Math.min(A.queue, 3);   // 고속 재생에서 밀리면 앞 사이클은 건너뛴다
      const rz = A.sd * PALLET_ARM.z, s = PALLET_ARM.s;
      const home = armIK(s, 0, 1.9, -A.sd * 0.6);
      if (!A.cyc && A.queue > 0 && parts.auto.visible) {
        A.queue--;
        const arr = parts.zoneStacks[k], idx = Math.max(0, Math.min(arr.length - 1, sim.fgBy[k] - A.queue - 1));
        const b = arr[idx].position, topY = 0.9 + 0.5;   // AMR 지그 위 박스 윗면
        const pick = armIK(s, 0, topY, -rz), pickUp = armIK(s, 0, topY + 0.6, -rz);
        const place = armIK(s, b.x, b.y + 0.25, b.z - rz), placeUp = armIK(s, b.x, b.y + 0.95, b.z - rz);
        A.cyc = { t: 0, keys: [[0, home], [0.22, pickUp], [0.32, pick], [0.42, pickUp], [0.7, placeUp], [0.8, place], [0.9, placeUp], [1, home]], placed: false };
      } else if (!A.cyc && !parts.auto.visible) A.queue = 0;
      let q = home;
      if (A.cyc) {
        const c = A.cyc; c.t += dts / CYC;
        const u = Math.min(1, c.t), i = c.keys.findIndex((kf) => kf[0] >= u);
        const [t0, p0] = c.keys[Math.max(0, i - 1)], [t1, p1] = c.keys[i];
        q = lerpA(p0, p1, ease(t1 > t0 ? (u - t0) / (t1 - t0) : 1));
        A.held.visible = u >= 0.32 && u < 0.8;
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
    area(-28.8, -18.6, -20.6, -11.4, AMBER, '📦 물류존', agv ? '자재창고 · AGV 자재 상차 · 부품 랙 피킹' : '자재창고 · 지게차 자재 상차 · 부품 랙', -24.7, -12.2, 6.4);
    // 입고 지게차 전용 영역: 입고 도크 ↔ 창고 랙 왼쪽 입고 칸 ↔ 대기 — 뒤쪽 통로·세로 통로와 떨어져 있어 로봇 이동 경로와 겹치지 않는다
    { const Z = INBOUND.zone; area(Z.x0, Z.z0, Z.x1, Z.z1, GREEN, `🚚 입고 ${sim.mode.key === 'dark' ? '자율 ' : ''}지게차 전용`, '로봇 통행 금지 · 도크 ↔ 창고 입고 칸', (Z.x0 + Z.x1) / 2, Z.z1 - 0.6, 5.6); }
    // 입고 지게차 주차 칸 (대기 자리, 도크 쪽을 향해 반듯이 주차)
    { const rc = sim.forklifts?.find((f) => f.receiver); if (rc) { const hx = rc.home.x, hz = rc.home.z, pl = new THREE.MeshBasicMaterial({ color: 0xf2f5f8 });
      for (const sd of [-1, 1]) flat(2.9, 0.1, pl, hx - 0.15, hz + sd * 0.9, 0.02);   // 동쪽(선반 쪽) 끝선, 서쪽으로 들어온다
      flat(0.1, 1.9, pl, hx + 1.3, hz, 0.02); } }
    // 물류 대기: 부품 보충 휴머노이드 (피지컬AI)
    if (sim.helpers?.length) area(-20.2, -13.6, -16.2, -11.4, GREEN, '물류 대기', '부품 보충 휴머노이드', -18.2, -11.95, 3.8);
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
    // 물류 대기: 출하 지게차 (출하 도크 옆)
    area(18.2, -17.8, 20.8, -15.2, GREEN, '출하 대기', sim.mode.key === 'dark' ? '자율 지게차' : '출하 지게차 (유인)', 19.5, -14.55, 3.2);
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

  drawScreen(k, agentLine) {
    const c = this.screenCanvas, g = c.getContext('2d');
    g.fillStyle = '#04121f'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(55,232,255,0.15)';
    for (let x = 0; x < c.width; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
    g.fillStyle = '#37e8ff'; g.font = 'bold 30px sans-serif';
    g.fillText(`DIGITAL TWIN · ${this.sim.mode.label}`, 28, 48);
    const tiles = [['UPH', k.uphRecent.toFixed(0)], ['OEE', (k.OEE * 100).toFixed(1) + '%'], ['WIP', k.wip], ['POWER', k.powerKW.toFixed(0) + 'kW']];
    tiles.forEach(([a, b], i) => {
      const x = 28 + i * 245;
      g.fillStyle = 'rgba(55,232,255,0.08)'; g.fillRect(x, 70, 225, 110);
      g.fillStyle = '#7fb8cc'; g.font = '22px sans-serif'; g.fillText(a, x + 16, 102);
      g.fillStyle = '#ffffff'; g.font = 'bold 48px sans-serif'; g.fillText(b, x + 16, 160);
    });
    this.sim.processing.forEach((st, i) => {
      const x = 28 + i * 196;
      const col = { BUSY: '#3ddc84', DOWN: '#ff5a5a', ESTOP: '#ff5a5a', PSTOP: '#f5b82e', MAINT: '#f5b82e', BLOCKED: '#f5b82e' }[st.state] ?? '#5b7080';
      g.fillStyle = col; g.fillRect(x, 200, 180, 10);
      g.fillStyle = '#cfe6f0'; g.font = '20px sans-serif'; g.fillText(st.name.slice(0, 9), x, 238);
      g.fillStyle = '#7fb8cc'; g.font = '18px sans-serif'; g.fillText(`건강도 ${st.health.toFixed(0)}%`, x, 264);
    });
    g.fillStyle = '#37e8ff'; g.font = '20px sans-serif';
    g.fillText('AI ▸ ' + agentLine, 28, 312);
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
