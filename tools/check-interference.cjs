// 형상 간섭 검사 (Electron) — 3단계 공장을 띄워 시뮬레이션을 돌리면서 움직이는 모든 형상(지상 이동체 · 드론 · 셀 로봇 팔 링크 · 갠트리/주행 헤드 · 문 · 대상물 · 트럭)이
// 다른 형상(서로 · 설비 · 펜스 · 기둥 · 상자 · 제품)과 겹치는지 본다. 핵심 계산은 tools/interference-core.cjs (node 테스트: tests/interference-tool.mjs)
//   ① 표본마다 장면 전체 행렬을 갱신한 뒤 부품별 방향 상자(OBB)로 후보를 찾고 ② 허용 접촉(포크 ↔ 팔레트 · 공구 ↔ 제품 · 자기 도크 · 바닥 주행면 …)만 이름 · 역할로 빼고
//   ③ 후보 쌍의 삼각형끼리 실제로 교차하는지 확인해 「삼각형 확정」과 「바운딩만 겹침」을 가른다. 시뮬레이션 0.1초 간격 사이는 화면 보간과 같게 나눠 한 표본에 3cm 넘게 움직이지 않게 본다
// 실행: npx electron tools/check-interference.cjs [분=20] [모드…] [옵션]
//   --out=폴더        결과 JSON · PNG 저장 위치 (기본 outputs/interference/<날짜시각>)
//   --shots=N         종류마다 가까이서 찍은 PNG(양쪽에서 2장) — 단계마다 최대 N종류 (기본 12 · 0이면 안 찍음)
//   --depth=0.01      방향 상자 겹침 깊이 기준 m          --move=0.03  한 표본 최대 이동 m      --sub=2..12  0.1초 간격 등분 범위
//   --no-tri          삼각형 확정 생략(후보만)            --stop=초    그 시뮬레이션 시각에서 멈춤(재현용)    --look=x,y,z  멈춘 시각의 그 자리를 가까이서 찍음
//   --only=정규식     그 종류(「개체 종류 ↔ 개체 종류」 — 예: '투입 로봇|부품분류셀')만 본다 — 고친 곳만 짧게 다시 볼 때 (전체 판정에는 쓰지 않는다)
//   --selftest        검사기 자체 점검만 (보고서 V01~V04 최소 재현 — 화면의 three.js로)
// 출력: 단계마다 요약(삼각형 확정 · 바운딩만 · 미확정 · 고정 장착 · 허용 접촉) + result.json(사건마다 실제 시각 · 모드 · 시드 · 양쪽 부품 · 행렬 · 관절 자세). 확정 · 미확정 간섭이 있으면 exit 1
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2).filter((a) => !a.endsWith('.cjs'));
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const args = argv.filter((a) => !a.startsWith('-'));
const MIN = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 20);
const MODES = args.filter((a) => /^[a-z]+$/.test(a)); if (!MODES.length) MODES.push('traditional', 'smart', 'dark');
const SELF = argv.includes('--selftest'), SHOTS = Number(opt('shots', 12)), STOP = Number(opt('stop', 0));
const [SUB0, SUB1] = String(opt('sub', '2..12')).split('..').map(Number);
const CFG = { minDepth: Number(opt('depth', 0.01)), tri: !argv.includes('--no-tri'), move: Number(opt('move', 0.03)), subMin: SUB0, subMax: SUB1 || SUB0, shots: SHOTS, verbose: !!process.env.IFC_VERBOSE, only: opt('only', '') };
const stampNow = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'outputs', 'interference', stampNow)));
app.setPath('userData', path.join(app.getPath('temp'), 'jin-3d-ifc-profile'));   // 평소 쓰는 앱 설정 · 저장 데이터를 건드리지 않게 따로
setTimeout(() => { console.log('TIMEOUT'); process.exitCode = 2; app.quit(); }, (20 + MIN * MODES.length * 4) * 60000);
process.on('unhandledRejection', (e) => { console.log('실행 오류 (화면 쪽 예외 — 검사를 끝내지 못함):', String(e?.stack || e).slice(0, 600)); process.exitCode = 2; app.quit(); });   // 화면 코드가 예외를 던지면 멈춘 채 남지 않게
const CORE = fs.readFileSync(path.join(__dirname, 'interference-core.cjs'), 'utf8'), SELFTEST = fs.readFileSync(path.join(__dirname, 'interference-selftest.cjs'), 'utf8');

// 페이지 안에서 돈다 — 검사기 설치 (단계를 바꿀 때마다 새로: 장면이 다시 만들어진다)
const PAGE = `(async () => { const O = ${JSON.stringify(CFG)};
  const C = window.__ifcCore, T = window.__twin, V = T.view, THREE = await import('three'), { StepInterp } = await import('./js/stepinterp.js');
  const scene = V.root.parent, v3 = new THREE.Vector3();
  // ── 개체 · 역할 표시 (collision group): 가까운 조상의 표시가 이긴다
  const TAG = new WeakMap(), FORCE = new Set(), tag = (o, t) => { if (o?.isObject3D) TAG.set(o, { ...(TAG.get(o) ?? {}), ...t }); };
  const GRP = { agv: 'agv', forklift: 'forklift', amr: 'amr', carrier: 'amr', humanoid: 'humanoid', human: 'human', robot: 'maint', quad: 'quad', drone: 'drone' };
  for (const sv of V.stationViews) { tag(sv.group, { station: sv.st.name });
    const P = sv.parts ?? {}, robots = [...(P.robots ?? []).map((r, i) => [r, '로봇' + (i + 1)]), ...(P.spsPickers ?? []).map((r, i) => [r, '키팅 로봇' + (i + 1)]), ...Object.entries(P.arms ?? {}).map(([k, A]) => [A.arm, '적재 로봇(' + k + ')']), ...(P.loader?.r ? [[P.loader.r, '투입 로봇']] : [])];
    for (const [r, name] of robots) { if (!r?.root) continue; tag(r.root, { robot: sv.st.name + ' ' + name, grp: r.kind === 'ammr' ? 'ammr' : 'arm' }); FORCE.add(r.root);
      for (const tip of [r.tip, r.tip2]) { tag(tip, { role: 'tool' }); if (tip?.parent && /tool|flange/i.test(tip.parent.name)) tag(tip.parent, { role: 'tool' }); } } }   // 공구 = 손목 플랜지 아래 (그리퍼 · 손가락 · 집은 부품)
  for (const g of V.convGroups ?? []) if (!TAG.has(g)) tag(g, { station: '컨베이어' });
  const movers = [[V.vehicleViews, null], [V.carrierViews, 'amr'], [V.techViews, null], [V.helperViews, 'humanoid'], [V.quadViews, 'quad'], [V.workerViews, 'human'], [V.droneViews, 'drone']];   // 목록이 정해 주는 종류가 먼저, 없으면 kind
  for (const [list, g0] of movers) for (const vv of list ?? []) { tag(vv.g, { ent: vv.v.id, grp: g0 ?? GRP[vv.v.kind] ?? 'human' }); FORCE.add(vv.g);
    const u = vv.g.userData; if (u.fork?.isObject3D) tag(u.fork, { role: 'fork' }); if (u.load?.isObject3D) tag(u.load, { role: 'load' }); }   // 지게차 포크 캐리지 · 차량 적재물
  for (const d of V.humanoidDocks ?? []) tag(d.d, { grp: 'dock', owner: d.m.id });
  (V.dronePads ?? []).forEach((g, i) => tag(g, { grp: 'dock', owner: V.droneViews?.[i]?.v.id }));
  // 운영 중 생기는 것: 대상물(그 안의 라인 AMR) · 트럭 — 표본마다 다시 표시 (대상물 메시는 재사용된다)
  const tagDyn = () => { for (const [id, g] of V.itemMeshes ?? []) { const ent = '대상물(' + id + ')'; if (TAG.get(g)?.ent === ent) continue; nTag++;   // 대상물 메시는 재사용된다 — 번호가 바뀌면 분류를 다시
      TAG.set(g, { ent, grp: 'product' }); FORCE.add(g); if (g.userData.amr) TAG.set(g.userData.amr, { ent: '라인 AMR(' + id + ')', grp: 'amr' }); }
    for (const f of V.flyers ?? []) { const ent = '불량 배출품(' + (f.st?.name ?? '') + ')'; if (TAG.get(f.g)?.ent === ent) continue; nTag++; TAG.set(f.g, { ent, grp: 'effect', role: 'reject', station: f.st?.name }); FORCE.add(f.g); }   // 불량 배출 연출 (대상물 메시를 빌려 0.9초 날아간다 — js/factory.js handleEvents)
    for (const [id, tv] of V.truckViews ?? []) if (!TAG.has(tv.g)) { nTag++; tag(tv.g, { ent: '트럭 ' + id, grp: 'truck' }); FORCE.add(tv.g); } };
  // 이름으로 주는 역할 (허용 접촉 판정에만 쓴다 — 좁게)
  const ROLE = [[/^SpsKitTray$/, 'kit'], [/^KitPockets$/, 'seat'], [/^Jig$/, 'seat'], [/^SpsVerify$/, 'seat'], [/^SpsTrayReturn$/, 'seat'], [/^SpsConveyor$/, 'belt'], [/pallet/i, 'pallet'], [/^ToolStand$/, 'toolrest']];   // 키트 트레이가 얹히는 자리: 검증 저울 판 · 빈 트레이 회수 선반 · 키트 컨베이어
  const isTote = (o) => { const p = o.geometry?.parameters; return o.geometry?.type === 'BoxGeometry' && p.width === 0.62 && p.height === 0.34 && p.depth === 0.55; };   // 자동창고 토트 상자 (js/factory.js TOTE)
  const CLS = new WeakMap();
  const classify = (o) => { const h = CLS.get(o); if (h && h.p === o.parent && h.n === nTag) return h.c; const c = {};
    for (let p = o; p; p = p.parent) { const t = TAG.get(p); if (t) for (const k in t) if (c[k] === undefined) c[k] = t[k];
      if (c.role === undefined && p.isInstancedMesh) c.role = 'part';   // 재고 InstancedMesh = 쌓아 둔 자재 · 부품
      if (c.role === undefined && p.name) for (const [re, role] of ROLE) if (re.test(p.name)) { c.role = role; break; }
      if (c.role === undefined && p.userData?.ifc && p.userData.ifc !== 'mark') c.role = p.userData.ifc;
      if (p.userData?.ifcTote && isTote(o)) c.role = 'tote'; }
    if (/^(Finger|Thumb|Palm|Hand)/.test(o.name)) c.hand = true;   // 손 부품 (휴머노이드 Blender 모델 이름) — 손에 든 정비 도구(userData.ifc = 'handtool')와의 접촉만 허용
    c.kind = (c.ent ? c.ent.replace(/\\(.*\\)$/, '').replace(/[- ]?\\d+$/, '') : c.robot ?? (c.station ? c.station + ' 설비' : c.grp === 'dock' ? '충전 도크·이착륙장' : '건물·바닥 설비')) + (c.role ? ' [' + c.role + ']' : '');
    CLS.set(o, { p: o.parent, n: nTag, c }); return c; };
  let nTag = 0;
  const label = (p) => { const o = p.o, parts = []; for (let q = o; q && q !== V.root && q !== V.dyn; q = q.parent) if (q.name && !/^(Mesh|Object|Group|Scene)?\\d*$/.test(q.name)) parts.push(q.name);
    const b = p.bb, m = p.mw, s = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])], dim = [0, 1, 2].map((k) => ((b[k + 3] - b[k]) * s[k]).toFixed(2)).join('×');
    const c = [0, 1, 2].map((k) => (p.aabb[k] + p.aabb[k + 3]) / 2), cl = classify(o);
    return (cl.ent ?? cl.robot ?? cl.station ?? '건물·바닥 설비') + ': ' + (parts.reverse().slice(-3).join('/') || '(이름 없음)') + ' [' + o.geometry.type.replace('Geometry', '') + ' ' + dim + ' @' + c[0].toFixed(2) + ',' + c[1].toFixed(2) + ',' + c[2].toFixed(2) + (p.inst >= 0 ? ' #' + p.inst : '') + ']'; };
  // 관절 자세: 움직인 적 있는 조상마다 이름 · 위치 · 회전(사원수) — 그 자세를 다시 만들 수 있게
  const pose = (p) => { const out = []; for (let q = p.o; q && q !== scene && out.length < 14; q = q.parent) if (chk.sc.rec.get(q)?.moved) out.push({ n: q.name || q.type, p: q.position.toArray().map((x) => +x.toFixed(4)), q: q.quaternion.toArray().map((x) => +x.toFixed(5)) }); return out; };
  // 부품이 장면 어디에 달려 있는지(조상 이름 · 종류) · 재질 — 결과 JSON에서 무엇인지 찾을 수 있게
  const meta = (p) => { const chain = []; for (let q = p.o; q && q !== scene && chain.length < 9; q = q.parent) chain.push((q.name || q.type) + (q.parent ? '#' + q.parent.children.indexOf(q) : '')); const m = Array.isArray(p.o.material) ? p.o.material[0] : p.o.material; return { chain: chain.join('<'), mat: m ? m.type.replace('Material', '') + (m.transparent ? ' 반투명 ' + m.opacity : '') : '' }; };
  const ONLY = O.only ? new RegExp(O.only) : null;
  const chk = new C.Checker({ minDepth: O.minDepth, tri: O.tri, classify, label, pose, meta, forceDyn: FORCE, version: () => nTag, only: ONLY ? (A, B) => ONLY.test(A.kind + ' ↔ ' + B.kind) || ONLY.test(B.kind + ' ↔ ' + A.kind) : null });
  const interp = new StepInterp(), sim = () => T.sim;
  const targets = () => { const s = T.sim; return [s.vehicles, s.forklifts, s.carriers, s.techs, s.helpers, s.quads, s.drones, s.workers, s.yard?.trucks, s.inbound?.trucks, s.stations].flatMap((a) => a ?? []); };   // 화면 보간 대상과 같게 (js/main.js interpTargets)
  const keyOf = (ev) => ev.info.a.kind + ' ↔ ' + ev.info.b.kind;
  const shot = { done: new Set(), watch: [], pending: null, missed: new Map() };
  const onSample = (t, frac) => { tagDyn();
    const fresh = chk.check([V.root, V.dyn], t, frac);
    if (O.shots > 0) { for (const ev of fresh) { const k = keyOf(ev); if (!shot.done.has(k) && shot.done.size + shot.watch.length < O.shots && !shot.watch.some((w) => w.k === k)) shot.watch.push({ ev, k, prev: ev.d }); }
      for (const w of shot.watch) { const ev = w.ev;
        if (ev.ended) { w.drop = true; shot.missed.set(w.k, (shot.missed.get(w.k) ?? 0) + 1); continue; }   // 찍기 전에 끝난 짧은 겹침 — 같은 종류가 다시 나오면 그때 (두 번 놓치면 시작하자마자)
        if (ev.stamp === chk.sc.sample && (ev.d < w.prev - 1e-4 || t - ev.t0 >= 1 || ev.tri === true && t - ev.t0 >= 0.3 || (shot.missed.get(w.k) ?? 0) >= 2)) { w.drop = true; shot.done.add(w.k); shot.pending = { key: w.k, t: +t.toFixed(3), d: +ev.d.toFixed(4), tri: ev.tri, at: ev.triInfo?.at ?? ev.info.at, a: label(ev.a), b: label(ev.b), PA: Array.from(ev.a.P), PB: Array.from(ev.b.P) }; break; }
        w.prev = ev.d; }
      shot.watch = shot.watch.filter((w) => !w.drop); }
    return !!shot.pending; };
  const runner = new C.Runner({ get sim() { return T.sim; }, get agent() { return T.agent; }, view: V, interp, targets, dt: 0.1, sub: { min: O.subMin, max: O.subMax, move: O.move }, check: onSample });
  // 가까이서 찍기: 두 부품의 방향 상자를 선으로 그리고(빨강 = 앞쪽 부품 · 노랑 = 상대) 접촉점을 보게 카메라를 옮긴다
  let saved = null; const EDGE = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const wire = (P, color) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(EDGE.flatMap((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]), 3)); const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })); l.renderOrder = 999; l.frustumCulled = false; return l; };
  window.__ifc = { chk, runner,
    run(steps) { const paused = steps == null ? runner.advance() : runner.advance(steps); const p = shot.pending; shot.pending = null; return { paused, shot: p, done: runner.done, t: T.sim.time }; },
    shotOn(p, side, boxes) { const cam = T.persp, ctl = T.ctlP; if (!saved) { saved = { pos: cam.position.clone(), tg: ctl.target.clone(), near: cam.near, helpers: [], css: document.createElement('style') }; saved.css.textContent = 'body * { visibility: hidden !important } canvas { visibility: visible !important }'; document.head.appendChild(saved.css); }   // 패널 · 라벨은 가리고 3D 화면만
      for (const h of saved.helpers) scene.remove(h); saved.helpers = boxes ? [wire(p.PA, 0xff2020), wire(p.PB, 0xffe000)] : []; for (const h of saved.helpers) scene.add(h);
      const ext = (P) => { let d = 0; for (let i = 0; i < 24; i += 3) d = Math.max(d, Math.hypot(P[i] - p.at[0], P[i + 1] - p.at[1], P[i + 2] - p.at[2])); return d; }, r = Math.min(ext(p.PA), ext(p.PB));
      const dist = Math.max(1.1, Math.min(5, r * 2.4)), az = Math.atan2(p.PA[0] - p.PB[0], p.PA[2] - p.PB[2]) + Math.PI / 2 + (side ? Math.PI : 0), el = 0.6;
      cam.near = 0.05; cam.position.set(p.at[0] + Math.sin(az) * Math.cos(el) * dist, p.at[1] + Math.sin(el) * dist, p.at[2] + Math.cos(az) * Math.cos(el) * dist); ctl.target.set(p.at[0], p.at[1], p.at[2]); cam.updateProjectionMatrix(); ctl.update(); return true; },
    shotOff() { if (!saved) return; const cam = T.persp, ctl = T.ctlP; for (const h of saved.helpers) scene.remove(h); saved.css.remove(); cam.position.copy(saved.pos); ctl.target.copy(saved.tg); cam.near = saved.near; cam.updateProjectionMatrix(); ctl.update(); saved = null; },
    look(at) { return { key: 'look', t: T.sim.time, at, PA: Array(24).fill(0).map((_, i) => at[i % 3] + (i % 2 ? 0.6 : -0.6)), PB: Array(24).fill(0).map((_, i) => at[i % 3] + (i % 2 ? -0.6 : 0.6)) }; },
    result() { return JSON.stringify({ mode: T.sim.mode.key, seed: T.sim.seed, t: T.sim.time, samples: runner.samples, maxSub: runner.maxSub, stat: chk.stat, parts: chk.sc.live.length, events: chk.report(), allowed: chk.allowed() }); },
  };
  return JSON.stringify({ t: T.sim.time, seed: T.sim.seed, mode: T.sim.mode.key });
})()`;

const KO = { confirmed: '삼각형 확정', bounding: '바운딩만 겹침', unverified: '미확정', mount: '고정 장착' };
app.whenReady().then(async () => {
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  const w = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const errs = []; w.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errs.push(String(e.message).slice(0, 300)); });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(4000);
  const js = (c) => w.webContents.executeJavaScript(c);
  await js(`void window.__twin?.tori?.close?.()`);   // 안내 아바타(토리)가 스스로 단계 · 배속을 바꾸지 않게 접어 둔다 (tools/smoke.cjs와 같게)
  await js(CORE); await js(SELFTEST);
  if (SELF) {   // 검사기 자체 점검 — 화면의 three.js로 보고서 최소 재현을 돌린다
    const rows = JSON.parse(await js(`(async () => JSON.stringify(window.__ifcSelftest.run(await import('three'), window.__ifcCore)))()`)); let bad = 0;
    console.log('== 간섭 검사기 자체 점검 (화면 three.js)'); for (const r of rows) { if (!r.ok) bad++; console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.info ? '  — ' + r.info : ''}`); }
    console.log(`\n결과: ${rows.length - bad} PASS / ${bad} FAIL`); process.exitCode = bad ? 1 : 0; app.quit(); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const pause = `(()=>{ const b=document.getElementById('playBtn'); if (b.textContent.includes('❚')) b.click(); })()`;
  await js(pause);   // 페이지 루프는 멈추고 여기서 직접 돌린다
  const all = { tool: 'check-interference', minutes: MIN, config: CFG, started: new Date().toISOString(), modes: [] }; let bad = 0; const T0 = Date.now();
  for (const mode of MODES) {
    await js(`document.querySelector('[data-mode=${mode}]').click()`); await wait(2500); await js(pause); await wait(1800);   // Blender 모델 교체(1.5초마다)가 끝난 뒤 설치
    const start = JSON.parse(await js(PAGE)), tm0 = Date.now(), shots = [];
    const total = STOP ? Math.max(0, Math.round((STOP - start.t) / 0.1)) : Math.round(MIN * 600); let left = total, r;
    while (left > 0) { const n = Math.min(left, 300); left -= n;   // 30초씩
      r = await js(`window.__ifc.run(${n})`);
      while (r.paused) {   // 새 종류의 겹침: 그 자세 그대로 양쪽에서 가까이 찍고 이어 간다
        const base = `${mode}-${String(shots.length + 1).padStart(2, '0')}-t${r.shot.t.toFixed(1)}`, files = [];
        for (const [side, boxes] of [[0, false], [0, true], [1, true]]) { await js(`window.__ifc.shotOn(${JSON.stringify(r.shot)}, ${side}, ${boxes})`); await wait(450); const f = path.join(OUT, `${base}-${side ? 'b' : boxes ? 'a' : 'a-plain'}.png`); fs.writeFileSync(f, (await w.webContents.capturePage()).toPNG()); files.push(f); }
        await js(`window.__ifc.shotOff()`); shots.push({ ...r.shot, PA: undefined, PB: undefined, files });
        r = await js(`window.__ifc.run()`); } }
    if (opt('look')) for (const side of [0, 1]) { await js(`window.__ifc.shotOn(window.__ifc.look([${opt('look')}]), ${side}, false)`); await wait(450); const f = path.join(OUT, `${mode}-look-${side ? 'b' : 'a'}.png`); fs.writeFileSync(f, (await w.webContents.capturePage()).toPNG()); console.log('  보기 PNG', f); await js(`window.__ifc.shotOff()`); }   // --look=x,y,z: 끝난 시각의 그 자리를 가까이서 (재현 확인용)
    const res = JSON.parse(await js(`window.__ifc.result()`)); res.t0 = start.t; res.wallSec = Math.round((Date.now() - tm0) / 1000); res.shots = shots; all.modes.push(res);
    // 같은 원인끼리 묶는다: 개체 종류 ↔ 개체 종류 (번호 뗀 이름 · 역할) — 자세히(IFC_VERBOSE)는 부품 하나하나
    const agg = new Map(), cnt = { confirmed: 0, bounding: 0, unverified: 0, mount: 0 };
    for (const ev of res.events) { cnt[ev.verdict]++; const k = ev.verdict + '|' + (CFG.verbose ? ev.a.label.replace(/ @[^\]]*/, '') + ' ↔ ' + ev.b.label.replace(/ @[^\]]*/, '') : ev.a.kind + ' ↔ ' + ev.b.kind); const a = agg.get(k);
      if (!a) agg.set(k, { v: ev.verdict, k: k.split('|')[1], n: 1, ex: ev, sum: ev.t1 - ev.t0 }); else { a.n++; a.sum += ev.t1 - ev.t0; if (ev.maxD > a.ex.maxD) a.ex = ev; } }
    const rows = [...agg.values()], kinds = (v) => rows.filter((x) => x.v === v).length;
    console.log(`\n== ${mode}: ${(total / 600).toFixed(1)}분 (시뮬레이션 시각 ${start.t.toFixed(1)} → ${res.t.toFixed(1)}초 · 시드 ${res.seed}) · 표본 ${res.samples}개(0.1초를 최대 ${res.maxSub}등분) · 부품 ${res.parts}개 · 후보 ${res.stat.cand}쌍·표본 · 삼각형 검사 ${res.stat.tri}회 · ${res.wallSec}초 걸림`);
    console.log(`  간섭 사건: 삼각형 확정 ${cnt.confirmed}건(${kinds('confirmed')}종류) · 바운딩만 겹침 ${cnt.bounding}건(${kinds('bounding')}종류) · 미확정 ${cnt.unverified}건(${kinds('unverified')}종류)   |  고정 장착 ${cnt.mount}쌍(${kinds('mount')}종류 — 간섭으로 세지 않음)`);
    for (const v of ['confirmed', 'unverified', 'bounding']) for (const a of rows.filter((x) => x.v === v).sort((x, y) => y.ex.maxD - x.ex.maxD)) { const e = a.ex, sh = shots.find((s) => s.key === a.k);
      console.log(`  [${KO[v]}] ${a.k} · ${a.n}건 · 합 ${a.sum.toFixed(1)}초 · 상자 깊이 최대 ${e.maxD.toFixed(3)}m${e.triInfo?.pairs ? ` · 교차 삼각형 ${e.triInfo.pairs}쌍${e.triInfo.inside ? '(내포 ' + e.triInfo.inside + ')' : ''}` : ''} · 예 t=${e.tMax} ${e.initial ? '(처음부터) ' : ''}\n        ${e.a.label}\n      ↔ ${e.b.label}${sh ? '\n        PNG ' + sh.files[1] : ''}`); }
    if (CFG.verbose) for (const a of rows.filter((x) => x.v === 'mount')) console.log(`  [고정 장착] ${a.k} · ${a.n}쌍`);
    for (const a of res.allowed) console.log(`  (허용 접촉) ${a.why} · ${a.n}쌍·표본 · 상자 깊이 최대 ${a.maxD.toFixed(3)}m · 예 t=${a.t} ${a.ex}`);
    bad += cnt.confirmed + cnt.unverified;
  }
  all.finished = new Date().toISOString(); all.wallSec = Math.round((Date.now() - T0) / 1000); all.consoleErrors = [...new Set(errs)];
  const jf = path.join(OUT, 'result.json'); fs.writeFileSync(jf, JSON.stringify(all));
  for (const e of all.consoleErrors) console.log('  콘솔 오류:', e);
  console.log(`\n결과 JSON: ${jf}  (사건마다 실제 시각 · 모드 · 시드 · 양쪽 부품 · 행렬 · 관절 자세 — 재현: 같은 모드로 --stop=<t>)\n합계: 확정 · 미확정 간섭 ${bad}건 · ${all.wallSec}초`);
  process.exitCode = bad ? 1 : 0;
  app.quit();
});
