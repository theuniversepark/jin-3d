// 렌더: Blender에서 모델링·재질 적용해 내보낸 glTF 모델(기본). 자산을 불러오지 못하면 three.js 코드로 만든 기본 도형 모델로 그린다
// Blender 자산은 blender/build_assets.py를 Blender로 실행해 만든다 (assets/blender/*.glb). 1단위 = 1m, Y 위, 바닥 중심 원점.
// Blender 옵션에서는 ① 운반 AMR · AGV · 지게차 · 순찰 드론 · 휴머노이드 · 사족보행 · 6축 로봇 팔 · AMMR · 화물트럭 · 갠트리(관절 빈 객체 포함)을 Blender 모델로 바꾸고 ② 실내 환경광(RoomEnvironment, PBR 반사)을 켠다.
// ③ 그 밖의 모든 로봇·시설·설비는 기본 도형(상자·원기둥·구)을 Blender에서 다시 만든 도형 라이브러리(primitives.glb)로 바꿔 끼운다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const BLENDER_ASSETS = { amr: '운반 AMR', agv: 'AGV', forklift: '지게차', drone: '순찰 드론', humanoid: '휴머노이드', quadruped: '사족보행', arm6: '6축 협동로봇 팔', ammr: 'AMMR 양팔 로봇', truck: '화물트럭', gantry: '갠트리 로봇', eaxle: 'e-axle 제품', parts: '조립·체결 부품', doortrim: '도어트림 제품', maint: '정비실 비품' };
export const RENDER = { style: 'blender', assets: {}, prims: new Map(), loaded: false, error: null, swapped: 0 };
let loading = null;

// 공유 페이지(Claude 아티팩트)는 .glb를 내려주지 못해 같은 모델을 JSON glTF(버퍼 내장, .gltf.json)로 둔다
export function loadBlenderAssets(base = 'assets/blender/', ext = globalThis.window?.JIN3D_SHARED ? '.gltf.json' : '.glb') {
  if (RENDER.loaded) return Promise.resolve(RENDER.assets);
  if (loading) return loading;
  const loader = new GLTFLoader();
  loading = Promise.all([...Object.keys(BLENDER_ASSETS).map((k) => loader.loadAsync(`${base}${k}${ext}`).then((g) => {
    g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    RENDER.assets[k] = g.scene;
  })),
  // 기본 도형 라이브러리: 노드 이름 → Blender에서 다듬은 지오메트리
  loader.loadAsync(`${base}primitives${ext}`).then((g) => { g.scene.traverse((o) => { if (o.isMesh) RENDER.prims.set(o.name, o.geometry); }); })]).then(() => { RENDER.loaded = true; return RENDER.assets; }).catch((e) => { RENDER.error = e.message; loading = null; throw e; });
  return loading;
}
export const blenderOn = () => RENDER.style === 'blender' && RENDER.loaded;

// 자산 복제: 이름이 정해진 재질(LED · NAV_R · NAV_G · STROBE)은 대수마다 따로 써야 하므로 재질을 복제해 돌려준다
export function cloneAsset(k) {
  const root = RENDER.assets[k].clone(true), mats = {};
  root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.material?.name;
    if (['LED', 'NAV_R', 'NAV_G', 'STROBE', 'Lamp', 'VISOR', 'ACC', 'THERMAL', 'ArmAcc', 'CabPaint', 'TAIL', 'GantryAcc'].includes(n)) { mats[n] ??= o.material.clone(); o.material = mats[n]; if (n === 'LED') mats[n].emissiveIntensity = 2.2; }
  });
  return { root, mats, find: (name) => root.getObjectByName(name) };
}

// 실내 환경광 (Blender 옵션): PBR 재질이 주변을 반사해 Blender 렌더와 비슷한 질감
let envTex = null;
export function applyRenderEnv(scene, renderer) {
  if (blenderOn()) {
    if (!envTex) { const pm = new THREE.PMREMGenerator(renderer); envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
    scene.environment = envTex; scene.environmentIntensity = 0.22;
  } else { scene.environment = null; }
}
export function resetRenderEnv() { envTex?.dispose(); envTex = null; }

// ── 기본 도형 다듬기 (모든 로봇·시설·설비) ─────────────────
// 화면의 상자·원기둥·구를 치수 키로 묶고, Blender에서 같은 치수로 다시 만든(둥근 모서리·부드러운 곡면) 도형으로 바꿔 끼운다.
// 메시의 위치·회전·부모(관절 그룹)는 그대로라 로봇 관절 동작·텔레메트리·선택(클릭)이 그대로 동작한다.
const r3 = (v) => Math.round(v * 1000) / 1000;
export function primKey(g) {
  const p = g?.parameters; if (!p) return null;
  if (g.type === 'BoxGeometry') return `B|${r3(p.width)}|${r3(p.height)}|${r3(p.depth)}`;
  if (g.type === 'CylinderGeometry') return `C|${r3(p.radiusTop)}|${r3(p.radiusBottom)}|${r3(p.height)}|${p.radialSegments}|${p.openEnded ? 1 : 0}`;
  if (g.type === 'SphereGeometry' && p.phiLength >= Math.PI * 2 - 1e-6 && p.thetaLength >= Math.PI - 1e-6) return `S|${r3(p.radius)}`;
  return null;
}
export const primName = (k) => k.replace(/\./g, 'p').replace(/\|/g, '_').replace(/-/g, 'm');
// 장면(또는 그룹)의 기본 도형 메시를 Blender 도형으로 바꿔 끼운다 — 텍스처·다중 재질 메시는 그대로 (UV·면 구분 유지)
export function blenderize(root) {
  if (!blenderOn() || !root) return 0;
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh || o.userData.bz) return;
    o.userData.bz = true;
    if (Array.isArray(o.material) || o.material?.map) return;
    const k = primKey(o.geometry); if (!k) return;
    const g = RENDER.prims.get(primName(k)); if (!g) return;
    o.geometry = g; n++;
  });
  RENDER.swapped += n;
  return n;
}