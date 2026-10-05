// Blender 자산 검증 — blender/build_assets.py가 내보낸 glTF(.glb) 파일을 직접 읽어
// GLB 형식(매직·버전·JSON/BIN 청크), 생성 도구(Blender glTF exporter), 크기(1단위 = 1m — 3D 모델과 같은 치수),
// 코드가 찾아 쓰는 이름(재질 LED · NAV_R · NAV_G · STROBE, 빈 객체 Rotor_0~3 · Guard)을 확인한다. 실행: npm test
import fs from 'node:fs';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const DIR = new URL('../assets/blender/', import.meta.url);
function glb(name) {
  const b = fs.readFileSync(new URL(`${name}.glb`, DIR)), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const magic = dv.getUint32(0, true), ver = dv.getUint32(4, true), len = dv.getUint32(8, true);
  const jlen = dv.getUint32(12, true), jtype = dv.getUint32(16, true);
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jlen)));
  const btype = dv.getUint32(20 + jlen + 4, true);
  return { ok: magic === 0x46546c67 && ver === 2 && len === b.length && jtype === 0x4e4f534a && btype === 0x004e4942, json, bytes: b.length };
}
// 장면 전체 경계 상자 (노드 변환: 이동·회전(쿼터니언)·크기 — 정점 min/max의 8개 꼭짓점을 변환해 모은다)
function bounds(J) {
  const qm = (q, v) => { const [x, y, z, w] = q, [a, b, c] = v, ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c; return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const walk = (ni, tf) => {
    const n = J.nodes[ni];
    const me = (p) => { let v = [p[0] * (n.scale?.[0] ?? 1), p[1] * (n.scale?.[1] ?? 1), p[2] * (n.scale?.[2] ?? 1)]; if (n.rotation) v = qm(n.rotation, v); v = [v[0] + (n.translation?.[0] ?? 0), v[1] + (n.translation?.[1] ?? 0), v[2] + (n.translation?.[2] ?? 0)]; return tf(v); };
    if (n.mesh != null) for (const pr of J.meshes[n.mesh].primitives) {
      const a = J.accessors[pr.attributes.POSITION];
      for (let k = 0; k < 8; k++) { const p = me([k & 1 ? a.max[0] : a.min[0], k & 2 ? a.max[1] : a.min[1], k & 4 ? a.max[2] : a.min[2]]); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); } }
    }
    for (const c of n.children ?? []) walk(c, me);
  };
  for (const r of J.scenes[J.scene ?? 0].nodes) walk(r, (v) => v);
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}
const SPEC = {   // 3D 모델 치수(폭 x · 높이 y · 길이 z, m)와 같은지 ±0.25m
  amr: { size: [0.97, 0.95, 1.47], mats: ['LED'], nodes: ['Lift', 'Jig', 'Lidar'] },
  agv: { size: [1.12, 0.5, 1.52], mats: ['LED'], nodes: ['Deck', 'Lidar'] },
  forklift: { size: [1.4, 2.33, 3.1], mats: ['Lamp'], nodes: ['Guard', 'Mast_Top', 'Fork_0.3', 'ForkCarriage'] },
  drone: { size: [1.0, 0.36, 1.0], mats: ['NAV_R', 'NAV_G', 'STROBE'], nodes: ['Rotor_0', 'Rotor_1', 'Rotor_2', 'Rotor_3', 'Gimbal'] },
  quadruped: { size: [0.54, 1.08, 1.08], mats: ['THERMAL'], nodes: ['Body', 'Cam', 'Hip_0', 'Hip_1', 'Hip_2', 'Hip_3', 'Knee_0', 'Knee_1', 'Knee_2', 'Knee_3'] },
  doortrim: { size: [0.8, 0.6, 0.15], mats: ['TrimPlastic', 'Leather', 'Chrome'], nodes: ['Trim_Panel', 'Trim_Armrest', 'Trim_Speaker', 'Trim_Handle'] },
  eaxle: { size: [1.08, 0.58, 0.48], mats: ['Copper', 'HVOrange', 'GearSteel'], nodes: ['FastenBolts', 'MotorHousing', 'GearHousing', 'Inverter', 'Rotor'] },
  truck: { size: [3.14, 3.92, 10.6], mats: ['CabPaint', 'TAIL', 'Tarp'], nodes: ['Door_L', 'Door_R', 'Tail_L', 'Tail_R', 'Deflector'] },
  ammr: { size: [0.83, 1.42, 0.67], mats: ['LED'], nodes: ['Lift', 'Head', 'ChestPanel', 'Lidar'] },
  humanoid: { size: [0.66, 1.94, 0.44], mats: ['VISOR', 'ACC'], nodes: ['Body', 'Waist', 'Head', 'Shoulder_L', 'Shoulder_R', 'Elbow_L', 'Elbow_R', 'Hip_L', 'Hip_R', 'Knee_L', 'Knee_R'] },
};
console.log('== Blender 자산 (assets/blender)');
const G6 = (J) => /Blender/i.test(J.asset?.generator ?? '');
for (const [k, S] of Object.entries(SPEC)) {
  const G = glb(k), J = G.json, B = bounds(J);
  check(`${k}.glb: GLB 2.0 (JSON + BIN 청크) · Blender glTF exporter로 생성`, G.ok && /Blender/i.test(J.asset?.generator ?? ''), `${(G.bytes / 1024).toFixed(0)}KB · ${J.asset?.generator} · 메시 ${J.meshes.length} · 재질 ${J.materials.length}`);
  check(`${k}: 크기가 3D 모델과 같음 (1단위 = 1m, 바닥 원점·Y 위)`, S.size.every((v, i) => Math.abs(B.size[i] - v) <= 0.25) && Math.abs(B.lo[1] - (k === 'drone' ? -0.23 : 0)) < 0.06, `${B.size.map((v) => v.toFixed(2)).join(' × ')} m · 바닥 y ${B.lo[1].toFixed(2)}`);
  const mn = J.materials.map((m) => m.name), nn = J.nodes.map((n) => n.name);
  check(`${k}: 코드가 쓰는 재질·노드 이름`, S.mats.every((m) => mn.includes(m)) && S.nodes.every((n) => nn.includes(n)), `재질 ${S.mats.join('·')} · 노드 ${S.nodes.join('·')}`);
  if (S.mats.includes('LED') || S.mats.includes('NAV_R') || S.mats.includes('VISOR') || S.mats.includes('THERMAL') || S.mats.includes('TAIL')) { const m = J.materials.find((x) => x.name === (S.mats.includes('TAIL') ? 'TAIL' : S.mats[0])); check(`${k}: 발광 재질(${S.mats.includes('TAIL') ? 'TAIL' : S.mats[0]})에 emissive`, Array.isArray(m.emissiveFactor) && m.emissiveFactor.some((v) => v > 0)); }
}
check('미리보기 렌더 (Blender Eevee) preview.png', fs.existsSync(new URL('preview.png', DIR)) && fs.statSync(new URL('preview.png', DIR)).size > 50000);
{ const J = glb('truck').json, at = (n) => J.nodes.find((x) => x.name === n);
  // 뒷문 경첩 = 3D 모델 자리(x = ±1.25 · 높이 2.55 · z = −5.25), 반투명 커튼(알파 블렌드)
  const ok = [['Door_L', -1], ['Door_R', 1]].every(([n, sd]) => { const t = at(n).translation; return !at(n).rotation && Math.abs(t[0] - sd * 1.25) < 0.01 && Math.abs(t[1] - 2.55) < 0.01 && Math.abs(t[2] + 5.25) < 0.01; });
  check('트럭: 뒷문 경첩 자리 · 반투명 커튼 재질', ok && J.materials.find((m) => m.name === 'Tarp')?.alphaMode === 'BLEND'); }
{ const J = glb('gantry').json, at = (n) => J.nodes.find((x) => x.name === n), parts = ['Post', 'XBeam', 'Bridge', 'Carriage', 'ZAxis'];
  // 갠트리 부품: 원점 그대로(코드가 셀 길이에 맞춰 복제·배치), X축 빔은 길이 1m(늘림 기준), 캐리지 도장 재질 GantryAcc
  const xb = J.nodes.find((n) => n.name === 'XProfile'), xa = J.accessors[J.meshes[xb.mesh].primitives[0].attributes.POSITION];
  const bad = parts.filter((n) => !at(n) || at(n).rotation || (at(n).translation ?? [0, 0, 0]).some((v) => Math.abs(v) > 1e-4));
  check('gantry.glb: 부품 5개(기둥·X축 빔·브리지·캐리지·승강축) 원점 · X축 빔 길이 1m · 도장 재질', G6(J) && !bad.length && Math.abs(xa.max[0] - xa.min[0] - 1) < 0.01 && J.materials.some((m) => m.name === 'GantryAcc'), bad.join(', ')); }
{ const J = glb('parts').json, names = ['P_Gear', 'P_Shaft', 'P_Bearing', 'P_Seal', 'P_CupHolder', 'P_Armrest', 'P_Grille', 'P_Switch', 'P_Screw', 'P_Bolt', 'P_Nut', 'P_Washer', 'P_Clip'];
  const miss = names.filter((n) => !J.nodes.some((x) => x.name === n));
  check('parts.glb: 조립 부품(기어·샤프트·베어링·오일씰·컵홀더·암레스트·스피커 그릴·스위치) · 체결 부품(나사·볼트·너트·와셔·클립) 13종', G6(J) && !miss.length, miss.join(', ') || `메시 ${J.meshes.length}`); }
{ const J = glb('maint').json, names = ['M_ToolChest', 'M_Locker', 'M_Workbench', 'M_Shelf', 'M_Cleaning', 'M_Compressor', 'M_Extinguisher', 'M_Ladder'];
  const miss = names.filter((n) => !J.nodes.some((x) => x.name === n));
  check('maint.glb: 정비실 비품 8종(공구 카트·캐비닛·작업대·소모품 선반·청소도구·컴프레서·소화기·사다리)', G6(J) && !miss.length, miss.join(', ') || `메시 ${J.meshes.length}`); }
{ const J = glb('forklift').json, fc = J.nodes.findIndex((n) => n.name === 'ForkCarriage'), kids = (J.nodes[fc]?.children ?? []).map((i) => J.nodes[i].name);
  check('지게차 포크 승강: ForkCarriage 아래 포크 2개 · 캐리지 · 짐받이 (코드가 마스트를 따라 올림)', fc >= 0 && ['Fork_0.3', 'Fork_-0.3', 'Carriage', 'Backrest_Top'].every((n) => kids.includes(n)), kids.slice(0, 5).join(', ')); }
{ const J = glb('arm6').json, segs = ['Seg_Base', 'Seg_Turret', 'Seg_Shoulder', 'Seg_Elbow', 'Seg_Wrist', 'Seg_Wrist2', 'Seg_Flange'], at = (n) => J.nodes.find((x) => x.name === n);
  // 6축 팔 마디: 관절 회전 중심이 원점(이동·회전 없음)이어야 코드가 makeArm 관절 그룹에 그대로 붙인다
  const bad = segs.filter((n) => !at(n) || at(n).rotation || (at(n).translation ?? [0, 0, 0]).some((v) => Math.abs(v) > 1e-4));
  check('arm6.glb: 6축 팔 마디 7개(베이스·J1~J6) · 관절 중심 원점 · Blender 생성', G6(J) && !bad.length && J.materials.some((m) => m.name === 'ArmAcc'), bad.join(', ')); }
for (const k of ['humanoid', 'quadruped', 'truck', 'eaxle', 'parts', 'doortrim', 'maint']) check(`미리보기 렌더 preview_${k}.png`, fs.existsSync(new URL(`preview_${k}.png`, DIR)) && fs.statSync(new URL(`preview_${k}.png`, DIR)).size > 30000);
{ const J = glb('humanoid').json, at = (n) => J.nodes.find((x) => x.name === n), hasRot = ['Body', 'Waist', 'Head', 'Shoulder_L', 'Elbow_L', 'Hip_L', 'Knee_L'].filter((n) => at(n).rotation);
  // 관절 빈 객체는 회전 없이 놓여야 코드의 rotation.x가 3D 모델과 같은 방향으로 움직인다. 어깨·고관절 높이 = 3D 모델(1.52m · 0.92m)
  const y = (n) => { let v = 0; for (const [i, x] of J.nodes.entries()) if (x.name === n) { v = x.translation?.[1] ?? 0; let p = i; for (;;) { const q = J.nodes.findIndex((z) => z.children?.includes(p)); if (q < 0) break; v += J.nodes[q].translation?.[1] ?? 0; p = q; } } return v; };
  check('휴머노이드 관절: 회전 없는 빈 객체 · 어깨 1.52m · 고관절 0.92m (3D 모델과 같은 자리)', !hasRot.length && Math.abs(y('Shoulder_L') - 1.52) < 0.01 && Math.abs(y('Hip_L') - 0.92) < 0.01, `어깨 ${y('Shoulder_L').toFixed(2)} · 고관절 ${y('Hip_L').toFixed(2)}${hasRot.length ? ' · 회전 ' + hasRot : ''}`); }
{ const J = glb('quadruped').json, at = (n) => J.nodes.find((x) => x.name === n);
  const rot = ['Body', 'Cam', 'Hip_0', 'Hip_1', 'Hip_2', 'Hip_3', 'Knee_0', 'Knee_1', 'Knee_2', 'Knee_3'].filter((n) => at(n).rotation);
  // 다리 순서·자리 = 3D 모델 (0: −x 앞 · 1: +x 앞 · 2: −x 뒤 · 3: +x 뒤 — 대각 보행 위상이 이 순서에 맞춰져 있다), 몸통 높이 0.55m
  const ok = [[-0.21, 0.36], [0.21, 0.36], [-0.21, -0.36], [0.21, -0.36]].every(([x, z], i) => { const t = at(`Hip_${i}`).translation; return Math.abs(t[0] - x) < 0.005 && Math.abs(t[2] - z) < 0.005; });
  check('사족보행 관절: 회전 없는 빈 객체 · 다리 순서·자리 · 몸통 높이 0.55m (3D 모델과 같음)', !rot.length && ok && Math.abs(at('Body').translation[1] - 0.55) < 0.005, rot.length ? '회전 ' + rot : ''); }
console.log('== 도형 라이브러리 (모든 로봇·시설·설비)');
{ const G = glb('primitives'), J = G.json, keys = JSON.parse(fs.readFileSync(new URL('../blender/primitives.json', import.meta.url))).keys;
  const name = (k) => k.replace(/\./g, 'p').replace(/\|/g, '_').replace(/-/g, 'm'), nn = new Set(J.nodes.map((n) => n.name));
  check('primitives.glb: GLB 2.0 · Blender glTF exporter', G.ok && /Blender/i.test(J.asset?.generator ?? ''), `${(G.bytes / 1024 / 1024).toFixed(1)}MB · 메시 ${J.meshes.length}`);
  const miss = keys.filter((k) => !nn.has(name(k)));
  check('수집한 도형 치수가 모두 라이브러리에 (이름 = 치수 키)', keys.length > 200 && !miss.length, `${keys.length}종${miss.length ? ' · 없음 ' + miss.slice(0, 3).join(', ') : ''}`);
  // 상자 치수 확인: 노드 이름의 폭·높이·깊이와 정점 범위(±2mm)
  const bad = keys.filter((k) => k.startsWith('B|')).filter((k) => { const n = J.nodes.find((x) => x.name === name(k)), a = J.accessors[J.meshes[n.mesh].primitives[0].attributes.POSITION], [, w, h, d] = k.split('|').map(Number); return [w, h, d].some((v, i) => Math.abs(a.max[i] - a.min[i] - v) > 0.002); });
  check('상자 도형 치수가 3D와 같음 (±2mm)', !bad.length, bad.slice(0, 3).join(', ')); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
