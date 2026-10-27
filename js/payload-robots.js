import * as THREE from 'three';
import { cloneAsset } from './blender.js';
import { ROBOT_SPECS } from './robot-specs.js';

// Each movable pivot has an unrotated node below its URDF fixed origin transform.
// This keeps original mesh dimensions and joint axes, including the UR shoulder offsets.
export function nativeChain(root, names, tip) {
  const pivots = names.map((n) => root.getObjectByName(n));
  if (pivots.some((n) => !n) || !tip) throw new Error('Missing native robot joint/TCP');
  const axes = pivots.map((p) => new THREE.Vector3(...p.userData.axis).normalize());
  const qs = pivots.map(() => 0);
  const defs = pivots.map((p, i) => ({ name: `J${i + 1}`, unit: 'deg', min: p.userData.lower, max: p.userData.upper }));
  const pose = (...values) => pivots.forEach((p, i) => { qs[i] = THREE.MathUtils.clamp(values[i] ?? 0, defs[i].min, defs[i].max); p.quaternion.setFromAxisAngle(axes[i], qs[i]); });
  const cache = new Map();
  // CCD solves the original imported chain rather than stretching a generic two-link arm.
  // 로봇 루트 로컬 좌표에서 푼다 — 셀이 좌우 반전(scale.z −1)되어 있으면 월드 좌표에서는 회전 방향이 뒤집혀 발산한다 (팔이 바닥 아래로)
  // down: 툴을 아래로 세워 집는다 (팔레타이징 진공 그리퍼) — true면 위에서, {x,y,z}(루트 로컬 단위 벡터)면 그 방향에서 대상물 면에 수직으로 다가간다:
  // 손목 중심(끝에서 둘째 관절)을 목표에서 그 방향으로 손목~TCP 거리만큼 떨어진 점에 먼저 맞추고(팔 관절) 손목 3축으로 TCP를 목표에 맞춘다 (6축 J5 · 7축 J6)
  const ik = (x, y, z, down = false) => {
    const key = [x, y, z].map((v) => v.toFixed(3)).join(',') + (down ? (down === true ? 'd' : [down.x, down.y, down.z].map((v) => v.toFixed(2)).join('/')) : ''); if (cache.has(key)) return cache.get(key).slice();
    const prev = qs.slice(); root.updateWorldMatrix(true, true);
    const inv = root.matrixWorld.clone().invert(), M = new THREE.Matrix4();
    const at = (o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const target = new THREE.Vector3(x, y, z);
    const turn = (i, lim, eff = tip, goal = target) => {
      const p = pivots[i], origin = at(p);
      const axis = axes[i].clone().transformDirection(M.multiplyMatrices(inv, p.parent.matrixWorld));
      const a = at(eff).sub(origin), b = goal.clone().sub(origin);
      a.addScaledVector(axis, -a.dot(axis)); b.addScaledVector(axis, -b.dot(axis));
      if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) return;
      a.normalize(); b.normalize();
      const delta = THREE.MathUtils.clamp(Math.atan2(axis.dot(a.clone().cross(b)), a.dot(b)), -lim, lim);
      qs[i] = THREE.MathUtils.clamp(qs[i] + delta, defs[i].min, defs[i].max);
      p.quaternion.setFromAxisAngle(axes[i], qs[i]); root.updateWorldMatrix(true, true);
    };
    // 시작 자세를 기본 자세(home — 없으면 영점)로 두고 J1(선회)부터 목표 쪽으로 돌린다 — 뒤쪽 목표(AMR 지그 등)에 몸을 뒤로 젖혀(J2 한계) 팔꿈치가 지그·바닥으로 내려가지 않게, 늘 팔꿈치가 위인 자세로 푼다
    const solve = (seed) => {
      pose(...seed); root.updateWorldMatrix(true, true); turn(0, Math.PI);
      if (down && pivots.length >= 6) {
        const n = pivots.length, wc = pivots[n - 2], dir = down === true ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(down.x, down.y, down.z).normalize();
        const wrist = target.clone().addScaledVector(dir, at(tip).distanceTo(at(wc)));
        for (let it = 0; it < 32 && at(wc).distanceTo(wrist) > 0.005; it++) for (let i = n - 4; i >= 0; i--) turn(i, .45, wc, wrist);
        for (let it = 0; it < 32 && at(tip).distanceTo(target) > 0.005; it++) for (let i = n - 1; i >= n - 3; i--) turn(i, .45);
      }
      for (let it = 0; it < 32; it++) {
        if (at(tip).distanceTo(target) < 0.008) break;
        for (let i = pivots.length - 1; i >= 0; i--) turn(i, .45);
      }
      return { q: qs.slice(), e: at(tip).distanceTo(target) };
    };
    // CCD가 관절 한계에 걸려 못 닿으면(2cm 넘게) 시작 자세를 바꿔 다시 풀고 가장 가까운 해를 쓴다 (양팔 로봇의 한쪽 팔 등)
    const home = chain.home ?? pivots.map(() => 0);
    let best = solve(home);
    for (const [j, d] of [[1, .7], [1, -.7], [2, .9], [2, -.9], [3, .9], [3, -.9]]) { if (best.e < 0.02 || j >= pivots.length) break; const s = home.slice(); s[j] = (s[j] ?? 0) + d; const r = solve(s); if (r.e < best.e) best = r; }
    const result = best.q; pose(...prev); root.updateWorldMatrix(true, true);
    if (cache.size > 128) cache.clear(); cache.set(key, result); return result.slice();
  };
  const chain = { root, tip, pivots, jointDefs: defs, pose, ik, joints: () => qs.slice(), native: true };
  return chain;
}

// 손목 카메라를 그리퍼 접근 축에 맞춘다 (실제 VLA 손목 카메라처럼): 렌즈(+z)는 손끝(TCP) 앞 ahead 지점을 보고, 화면 위(+y)는 접근 축에서 카메라 쪽
// → 그리퍼 손가락이 화면 아래, 집는 물체가 화면 가운데. 접근 축 = 툴 몸체(TCP 부모) → TCP. 앵커 아래 카메라 몸체·렌즈도 함께 돈다
export function aimWristCam(anchor, tcp, ahead = 0.1) {
  const V = THREE.Vector3, P = anchor.parent; tcp.updateWorldMatrix(true, false); anchor.updateWorldMatrix(true, false);
  const t = tcp.getWorldPosition(new V()), c = anchor.getWorldPosition(new V());
  let b = tcp.parent, ax = new V(); while (b && ax.subVectors(t, b.getWorldPosition(new V())).length() < 0.01) b = b.parent;
  ax.normalize(); const up = c.clone().sub(t); up.addScaledVector(ax, -up.dot(ax));
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(t.addScaledVector(ax, ahead), c, up));
  anchor.quaternion.copy(P.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q));
  anchor.userData.wristTcp = tcp; return anchor;
}

export function makePayloadArm(kind) {
  const spec = ROBOT_SPECS[kind], A = cloneAsset(spec.asset), root = new THREE.Group(); root.add(A.root);
  const arm = nativeChain(root, [1, 2, 3, 4, 5, 6].map((i) => `J${i}`), A.find('ToolTCP'));
  Object.assign(arm, { spec, kind, payload: spec.payload, wristCam: true, wristCameraAnchor: A.find('WristCamera'), turret: arm.pivots[0], shoulder: arm.pivots[1], elbow: arm.pivots[2], wrist: arm.pivots[3], flange: A.find('ToolFlange'), cameraAnchor: A.find('WristCamera'), blender: true });
  arm.home = kind === 'cobot' ? [0, -1.1, 1.8, -2.25, -Math.PI / 2, 0] : [0, .35, -.55, 0, .8, 0];
  arm.pose(...arm.home);
  // 손목 카메라는 손가락이 벌어지는 방향(x)과 직각(z)에 — 가까운 손가락이 렌즈를 가리지 않고 두 손가락 사이로 대상물이 보인다
  if (arm.cameraAnchor) { const c = arm.cameraAnchor.position; c.set(-c.z, c.y, c.x); aimWristCam(arm.cameraAnchor, arm.tip); }
  return arm;
}

export function makePayloadDual(camModule) {
  const spec = ROBOT_SPECS.ammr, A = cloneAsset(spec.asset), root = new THREE.Group(); root.add(A.root);
  const head = A.find('Head'), torso = A.find('BodyCameraAnchor');
  const body = nativeChain(root, Array.from({length:6},(_,i)=>`torso_${i}`), torso);
  const arms = ['L','R'].map(side=>nativeChain(root,Array.from({length:7},(_,i)=>`${side}_J${i+1}`),A.find(`${side}_ToolTCP`)));
  arms.forEach((a,i)=>{ const nativePose=a.pose, sd=i?-1:1; a.nativePose=nativePose;
    a.pose=(yaw=0,shoulder=.3,elbow=1,wrist=.5,roll=0,twist=0)=>nativePose(-shoulder,sd*.35,yaw*.4,-elbow,roll,wrist,twist); a.pose(); a.home=a.joints(); });   // IK 시작 자세 = 기본 자세 (팔꿈치가 자연스러운 쪽으로 풀린다)
  const cams={head:camModule(head,0,0,.04,.55,-Math.PI/2,.04,false),handL:aimWristCam(camModule(arms[0].tip,0,.1,.07,0,0,.028),arms[0].tip),handR:aimWristCam(camModule(arms[1].tip,0,.1,.07,0,0,.028),arms[1].tip),back:camModule(torso,-.04,.07,-.15,.1,Math.PI/2,.04)};
  const bin=new THREE.Mesh(new THREE.BoxGeometry(.36,.18,.26),new THREE.MeshStandardMaterial({color:0x2f6fd6,roughness:.6}));bin.visible=false;bin.position.set(0,.44,-.2);root.add(bin);
  const extra=nativeChain(root,['right_wheel','left_wheel','head_0','head_1'],head);
  const jointDefs=[...body.jointDefs.map((j,i)=>({...j,name:`몸통 J${i+1}`})),...arms.flatMap((a,i)=>a.jointDefs.map(j=>({...j,name:`${i?'오른팔':'왼팔'} ${j.name}`}))),...extra.jointDefs.map((j,i)=>({...j,name:['오른바퀴','왼바퀴','머리 팬','머리 틸트'][i]}))];
  return {root,kind:'ammr',spec,tip:arms[0].tip,tip2:arms[1].tip,arms,body,dual:true,payload:spec.payload,payloadBasis:spec.payloadBasis,head,bin,cams,jointDefs,
    joints:()=>[...body.joints(),...arms.flatMap(a=>a.joints()),...extra.joints()],
    anim(busy,t){body.pose(0,busy?.03*Math.sin(t*.5):0,0,0,0,busy?.08*Math.sin(t*.4):0);arms.forEach((a,i)=>{const w=t*1.2+i*.7;a.pose(busy?.2*Math.sin(w):0,busy?.45:.2,busy?1.2+.1*Math.cos(w):1,.5,0,busy?.2*Math.sin(w):0);});}
  };
}
