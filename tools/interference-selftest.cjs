// 간섭 검사기 자체 점검 — 검수보고서 V01~V04 최소 재현을 실제 three.js 장면으로 만들어 검사기(tools/interference-core.cjs)에 넣는다
// node(tests/interference-tool.mjs — node_modules/three)와 화면(npm run check:interference -- --selftest — 화면의 three.js) 양쪽에서 같은 시나리오를 돈다
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.__ifcSelftest = factory(); })(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function run(THREE, C) {
    const rows = [], check = (name, ok, info = '') => rows.push({ name, ok: !!ok, info: String(info) });
    const std = () => new THREE.MeshStandardMaterial();
    const mk = (geo, mat, x, y, z, parent, cls, name) => { const m = new THREE.Mesh(geo, mat ?? std()); m.position.set(x, y, z); if (cls) m.userData.cls = cls; if (name) m.name = name; parent.add(m); return m; };
    const box = (w, h, d, x, y, z, parent, cls, name) => mk(new THREE.BoxGeometry(w, h, d), null, x, y, z, parent, cls, name);
    const grp = (x, y, z, parent, cls, name) => { const g = new THREE.Group(); g.position.set(x, y, z); if (cls) g.userData.cls = cls; if (name) g.name = name; parent.add(g); return g; };
    // 표시(userData.cls)는 가까운 조상 것이 이긴다 — 실제 검사기의 개체 · 역할 표시와 같은 방식
    const classify = (o) => { const c = {}; for (let p = o; p; p = p.parent) { const t = p.userData?.cls; if (t) for (const k in t) if (c[k] === undefined) c[k] = t[k]; } return c; };
    const world = (force = []) => { const scene = new THREE.Scene(), chk = new C.Checker({ classify, forceDyn: new Set(force), label: (p) => p.o.name || 'part' }); return { scene, chk, force: chk.sc.force, step: (t = 0) => chk.check([scene], t), ev: () => chk.report(), found: (v) => chk.report().filter((e) => !v || e.verdict === v) }; };
    const names = (W) => W.ev().map((e) => `${e.a.label}↔${e.b.label}:${e.verdict}`).join(' ');

    // ── V01: 설비 상자를 옮긴 뒤 행렬을 갱신하지 않아도(오래된 matrixWorld) 지금 자리로 판정
    { const W = world(), mover = grp(0, 0, 0, W.scene, { ent: 'AGV-1', grp: 'agv' }); W.force.add(mover); box(1, 1, 1, 0, 0.6, 0, mover, null, '차체');
      const eq = box(1, 1, 1, 5, 0.6, 0, W.scene, null, '설비 상자'); W.step(0); const n0 = W.found().length;
      eq.position.x = 0.4;   // 옮기기만 하고 updateMatrixWorld는 부르지 않는다
      const stale = eq.matrixWorld.elements[12]; W.step(0.1); const e = W.found('confirmed');
      check('V01 옮긴 설비 상자: 행렬을 갱신하지 않은 채 검사해도 겹침 검출 (훑기 전에 장면 전체 행렬 갱신)', n0 === 0 && stale === 5 && e.length === 1, `옮기기 전 ${n0}건 · 검사 직전 matrixWorld x=${stale}(오래된 값) · 옮긴 뒤 ${e.length}건 깊이 ${e[0]?.maxD}`);
      eq.position.x = 5; W.step(0.2); check('V01 다시 떼어 놓으면 사건이 닫힘 (오탐도 없음)', W.ev().length === 1 && W.ev()[0].open === false, `열린 사건 ${W.ev().filter((x) => x.open).length}`); }

    // ── V03: 지게차라도 높이 19cm 일반 상자와 차체가 겹치면 검출 · 포크 ↔ 팔레트만 허용
    { const W = world(), fk = grp(0, 0, 0, W.scene, { ent: '지게차', grp: 'forklift' }); W.force.add(fk); box(1.2, 1.0, 2.0, 0, 0.62, 0, fk, null, '차체');
      const fork = grp(0, 0, 0, fk, { role: 'fork' }); box(0.12, 0.05, 1.1, 0.25, 0.1, 1.5, fork, null, '포크');
      box(0.6, 0.19, 0.6, 0.3, 0.095, -0.6, W.scene, null, '일반 상자 19cm');   // 차체 아래로 12cm 파고든다 (전에는 지게차면 20cm 이하를 모두 뺐다)
      box(1.0, 0.14, 1.0, 0.25, 0.07, 1.6, W.scene, { role: 'pallet' }, '팔레트');
      W.step(0); const ev = W.found(), al = W.chk.allowed();
      check('V03 높이 19cm 일반 상자 ↔ 지게차 차체 = 검출', ev.some((e) => /일반 상자/.test(e.a.label + e.b.label) && /차체/.test(e.a.label + e.b.label)), names(W));
      check('V03 포크 ↔ 팔레트 = 허용 접촉 (간섭으로 세지 않음)', !ev.some((e) => /팔레트/.test(e.a.label + e.b.label)) && al.some((a) => /포크/.test(a.why)), al.map((a) => a.why + ' ' + a.n).join(' · '));
      const W2 = world(), f2 = grp(0, 0, 0, W2.scene, { ent: '지게차', grp: 'forklift' }); W2.force.add(f2); const fo2 = grp(0, 0, 0, f2, { role: 'fork' }); box(0.12, 0.05, 1.1, 0, 0.1, 1.5, fo2, null, '포크');
      box(0.6, 0.19, 0.6, 0, 0.095, 1.6, W2.scene, null, '일반 상자 19cm'); W2.step(0);
      check('V03 포크 ↔ 팔레트가 아닌 19cm 상자 = 검출 (포크라도 팔레트 · 적재물만 허용)', W2.found().length === 1, names(W2));
      const W3 = world(), amr = grp(0, 0, 0, W3.scene, { ent: 'AMR-1', grp: 'amr' }); W3.force.add(amr); box(0.9, 0.3, 1.4, 0, 0.17, 0, amr, null, '차체');
      box(3, 0.08, 3, 0, 0.04, 0, W3.scene, null, '셀 바닥 판 8cm'); box(0.3, 0.19, 0.3, 0.2, 0.095, 0.3, W3.scene, null, '일반 상자 19cm'); W3.step(0);
      check('V03 바닥 주행면(10cm 이하 판)만 허용 · 19cm 상자는 AMR에도 검출', W3.found().length === 1 && /19cm/.test(names(W3)) && W3.chk.allowed().some((a) => /바닥 주행면/.test(a.why)), names(W3)); }

    // ── V03: 판(PlaneGeometry) 제품은 두께를 준 상자 · 유리 같은 반투명 물체도 검사 · 표지(깊이 안 쓰는 기본 재질) · 빛은 제외
    { const W = world(), arm = grp(0, 0, 0, W.scene, { robot: '조립셀 로봇1', grp: 'arm', station: '조립셀' }); W.force.add(arm); const link = grp(0.8, 0, 0, arm, null, 'J2'); box(0.2, 0.2, 1.0, 0, 1.0, 0, link, null, '링크');
      const item = grp(0, 1.0, 0.3, W.scene, { ent: '대상물(1)', grp: 'product' }); W.force.add(item); const plate = mk(new THREE.PlaneGeometry(0.9, 0.5), null, 0, 0, 0, item, null, '도어트림 판'); plate.rotation.x = -Math.PI / 2;
      mk(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }), 0, 1.0, 0, W.scene, null, '감지 범위 표시').rotation.x = -Math.PI / 2;
      mk(new THREE.ConeGeometry(1, 1, 12), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 0, 1.0, 0, W.scene, null, '조명 원뿔');
      mk(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false }), 0, 0.02, 0, W.scene, null, '바닥 구역 색').rotation.x = -Math.PI / 2;
      mk(new THREE.BoxGeometry(0.04, 1.4, 1.0), new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.2, depthWrite: false }), 0.08, 1.0, -0.45, W.scene, { station: '조립셀' }, '유리 칸막이');
      W.step(0); const n0 = W.found().length; link.position.x = 0; W.step(0.1); const s = names(W);   // 링크가 판 · 유리 쪽으로 움직여 들어간다
      check('V03 PlaneGeometry 제품 판 ↔ 로봇 링크 = 검출 (두께를 준 상자 · 삼각형 확정)', /도어트림 판↔링크:confirmed|링크↔도어트림 판:confirmed/.test(s), s);
      check('V03 반투명 유리 칸막이 ↔ 로봇 링크 = 검출 (반투명이어도 물체)', n0 === 0 && /링크↔유리 칸막이:confirmed|유리 칸막이↔링크:confirmed/.test(s), s);
      check('V03 감지 범위 표시 · 조명 원뿔 · 바닥 구역 색은 물체가 아님', !/감지 범위|조명 원뿔|바닥 구역/.test(s), s); }

    // ── V02: 빠져 있던 비교 쌍
    { // 고정 셀 팔 ↔ 다른 고정 셀 팔 · 팔 ↔ 펜스 · 인접 링크는 제외
      const W = world(), st = grp(0, 0, 0, W.scene, { station: '조립셀' }), fence = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.28, depthWrite: false });
      const arm = (x, name) => { const r = grp(x, 0, 0, st, { robot: name, grp: 'arm' }); W.force.add(r); box(0.3, 0.3, 0.3, 0, 0.15, 0, r, null, name + ' 받침'); const j1 = grp(0, 0.3, 0, r, null, 'J1'); box(0.2, 0.6, 0.2, 0, 0.3, 0, j1, null, name + ' 링크1'); const j2 = grp(0, 0.6, 0, j1, null, 'J2'); box(0.75, 0.12, 0.12, 0.375, 0, 0, j2, null, name + ' 링크2'); return { r, j1, j2 }; };
      const A = arm(-0.8, '로봇1'), B = arm(0.8, '로봇2'); B.j1.rotation.y = Math.PI;   // 마주 봄: 링크2 끝이 x −0.05 · +0.05에서 10cm 떨어져 있다
      mk(new THREE.BoxGeometry(0.04, 1.6, 3), fence, -2.0, 0.8, 0, st, null, '펜스 망');
      W.step(0); const n0 = W.found().filter((e) => e.verdict !== 'mount').length;
      A.j2.scale.x = 1.2; B.j2.scale.x = 1.2; W.step(0.1); const s1 = names(W);   // 두 팔을 뻗음: 끝이 x −0.1 ~ +0.1에서 겹친다
      check('V02 고정 셀 팔 ↔ 다른 고정 셀 팔 겹침 = 검출', /로봇1 링크2↔로봇2 링크2:confirmed|로봇2 링크2↔로봇1 링크2:confirmed/.test(s1), s1);
      check('V02 인접 링크(관절로 바로 이어진 링크 1 ↔ 2)는 간섭으로 세지 않음', !/로봇1 링크1↔로봇1 링크2|로봇1 링크2↔로봇1 링크1/.test(s1), s1);
      A.j1.rotation.y = Math.PI; W.step(0.2); const s2 = names(W);   // 로봇1이 뒤로 돎: 링크2 끝 x −1.7 — 펜스(x −2.0)에 아직 닿지 않음
      A.j2.scale.x = 1.7; W.step(0.3); const s3 = names(W);   // 더 뻗으면 끝 x −2.075 — 펜스를 지난다
      check('V02 고정 셀 팔 ↔ 펜스 = 검출 (펜스 망은 반투명이어도 물체)', /펜스 망/.test(s3) && !/펜스 망/.test(s2), s3);
      check('V02 처음 자세에서는 간섭 없음 (받침 ↔ 링크1 맞닿음은 깊이 기준 아래)', n0 === 0, `처음 ${n0}건`); }
    { // 드론 ↔ 드론 · 드론 ↔ 설비 · 드론 ↔ 지상 이동체
      const W = world(), dr = (x, id) => { const g = grp(x, 6, 0, W.scene, { ent: id, grp: 'drone' }); W.force.add(g); box(0.8, 0.2, 0.8, 0, 0, 0, g, null, id + ' 몸체'); return g; };
      const d1 = dr(0, '순찰 드론-1'), d2 = dr(3, '순찰 드론-2'); box(0.4, 7, 0.4, -3, 3.5, 0, W.scene, null, '기둥'); const hum = grp(0, 0, 4, W.scene, { ent: '휴머노이드-1', grp: 'humanoid' }); W.force.add(hum); box(0.5, 1.8, 0.4, 0, 0.9, 0, hum, null, '휴머노이드 몸');
      W.step(0); const n0 = W.found().length; d2.position.x = 0.5; W.step(0.1); const a = names(W);
      d1.position.x = -2.8; W.step(0.2); const b = names(W); d2.position.set(0.1, 1.7, 4); W.step(0.3); const c = names(W);
      check('V02 드론 ↔ 드론 겹침 = 검출', n0 === 0 && /드론-1 몸체↔순찰 드론-2 몸체|드론-2 몸체↔순찰 드론-1 몸체/.test(a), a);
      check('V02 드론 ↔ 설비(기둥) = 검출', /기둥/.test(b), b);
      check('V02 드론 ↔ 지상 이동체 = 검출', /휴머노이드 몸/.test(c), c); }
    { // 갠트리 헤드 ↔ 자체 프레임 · 다른 헤드 — 레일에 물려 늘 겹친 쌍은 고정 장착, 끝 멈추개를 치면 간섭
      const W = world(), st = grp(0, 0, 0, W.scene, { station: '체결셀' }); box(4, 0.2, 0.2, 0, 2.5, 0, st, null, '레일'); box(0.1, 0.5, 0.5, 2.0, 2.4, 0, st, null, '끝 멈추개');
      const head = (x, n) => { const h = grp(x, 2.4, 0, st, null, n); W.force.add(h); box(0.3, 0.3, 0.3, 0, 0, 0, h, null, n); return h; }; const h1 = head(-1, '헤드1'), h2 = head(0.5, '헤드2');
      W.step(0); h1.position.x = -0.9; W.step(0.1); const m0 = W.found('mount').length, c0 = W.found().length - m0;
      h2.position.x = 1.9; W.step(0.2); const a = names(W); h1.position.x = 1.7; W.step(0.3); const b = names(W);
      check('V02 갠트리 헤드 ↔ 레일(늘 물려 있음) = 고정 장착으로 따로, 간섭 아님', m0 === 2 && c0 === 0, `고정 장착 ${m0}쌍 · 간섭 ${c0}건`);
      check('V02 갠트리 헤드 ↔ 자체 프레임(끝 멈추개) = 검출', /헤드2↔끝 멈추개:confirmed|끝 멈추개↔헤드2:confirmed/.test(a), a);
      check('V02 갠트리 헤드 ↔ 다른 헤드 = 검출', /헤드1↔헤드2:confirmed|헤드2↔헤드1:confirmed/.test(b), b); }
    { // 로봇 ↔ 일반 제품: 링크가 제품을 치면 검출, 공구(손끝 아래)가 제품에 닿는 것은 허용
      const W = world(), r = grp(0, 0, 0, W.scene, { robot: '조립셀 로봇1', grp: 'arm', station: '조립셀' }); W.force.add(r); const j = grp(0, 1, 0, r, null, 'J3'); box(0.15, 0.15, 0.8, 0, 0, 0.4, j, null, '링크3');
      const tip = grp(0, 0, 0.8, j, { role: 'tool' }, 'ToolTCP'); box(0.06, 0.2, 0.06, 0, -0.1, 0, tip, null, '그리퍼');
      const item = grp(0, 0.78, 0.8, W.scene, { ent: '대상물(7)', grp: 'product' }); W.force.add(item); box(0.5, 0.1, 0.5, 0, 0, 0, item, null, '제품');
      W.step(0); const a = names(W), al = W.chk.allowed().map((x) => x.why).join(' · '); j.rotation.x = 0.35; W.step(0.1); const b = names(W);
      check('V02 공구 ↔ 제품 접촉 = 허용 (집기 · 체결)', !/제품/.test(a) && /공구/.test(al), al);
      check('V02 로봇 링크 ↔ 제품 = 검출 (제품 그룹을 통째로 빼지 않음)', /링크3↔제품|제품↔링크3/.test(b), b); }
    { // 안착면: 2cm까지 얹힌 접촉만 허용, 더 깊이 묻히면 검출
      const W = world(), tray = grp(0, 0.805, 0, W.scene, { station: '분류셀', role: 'kit' }); W.force.add(tray); box(0.46, 0.04, 0.32, 0, 0, 0, tray, null, '키트 트레이'); box(2, 0.06, 0.5, 0, 0.77, 0, W.scene, { station: '분류셀', role: 'belt' }, '키트 컨베이어');
      W.step(0); const n0 = W.found().length, al = W.chk.allowed().map((x) => x.why).join(''); tray.position.y = 0.79; W.step(0.1);
      check('V03 안착면(벨트)에 1.5cm 얹힌 트레이 = 허용, 3cm 묻히면 검출', n0 === 0 && /안착면/.test(al) && W.found().length === 1, `${n0}건 → ${W.found().length}건 (${names(W)})`); }
    { // 구르는 장착부: 표시한 바퀴 ↔ 표시한 레일이 2cm까지 물린 것만 허용 — 깊이 파고들거나 레일이 아닌 것에 닿으면 검출
      const W = world(), rail = box(0.12, 0.06, 6, 0, 0.03, 0, W.scene, { role: 'rail' }, '주행 레일'), cr = grp(0, 0, 0, W.scene, null, '크레인'); W.force.add(cr);
      const wheel = box(0.4, 0.32, 0.3, 0, 0.205, 0, cr, { role: 'roller' }, '주행 대차');   // 밑면 0.045 — 레일(윗면 0.06)에 1.5cm 물림
      box(0.3, 0.1, 0.3, 0, 0.05, 2.0, W.scene, null, '레일 위 이물 상자');
      W.step(0); const n0 = W.found().length, al = W.chk.allowed().map((x) => x.why).join('');
      wheel.position.y = 0.18; W.step(0.1); const deep = names(W);   // 4cm 파고듦
      wheel.position.y = 0.205; cr.position.z = 1.8; W.step(0.2); const box2 = names(W);   // 레일 위 이물 상자를 침
      check('구르는 장착부: 바퀴 ↔ 레일 1.5cm 물림 = 허용, 4cm 파고들면 검출', n0 === 0 && /구르는 장착부/.test(al) && /주행 대차↔주행 레일|주행 레일↔주행 대차/.test(deep), `${n0}건 · ${al} → ${deep}`);
      check('구르는 장착부: 바퀴 ↔ 레일이 아닌 상자 = 검출 (레일 표시가 있는 것만 허용)', /이물 상자/.test(box2), box2); }
    { // 불량 배출 연출: 그 셀의 고정 설비와 겹치는 것만 뺀다 — 다른 셀 설비 · 움직이는 로봇 · 이동체와 겹치면 검출
      const W = world(), stA = grp(0, 0, 0, W.scene, { station: '체결셀' }), stB = grp(4, 0, 0, W.scene, { station: '조립셀' });
      box(0.5, 1.0, 0.45, 1.0, 0.5, 0, stA, null, '볼트 공급기'); box(0.5, 1.0, 0.45, 0, 0.5, 0, stB, null, '옆 셀 제어반');
      const rb = grp(1.0, 0, 1.5, stA, { robot: '체결셀 로봇1', grp: 'arm' }); W.force.add(rb); box(0.2, 0.2, 0.8, 0, 0.6, 0, rb, null, '로봇 링크');
      const fl = grp(0, 1.5, 0, W.scene, { ent: '불량 배출품', grp: 'effect', role: 'reject', station: '체결셀' }); W.force.add(fl); box(0.4, 0.3, 0.4, 0, 0, 0, fl, null, '불량품');
      W.step(0); fl.position.set(1.0, 0.7, 0); W.step(0.1); const a = names(W), al = W.chk.allowed().map((x) => x.why).join('');
      fl.position.set(1.0, 0.6, 1.3); W.step(0.2); const b = names(W); fl.position.set(4, 0.7, 0); W.step(0.3); const c = names(W);
      check('불량 배출 연출 ↔ 그 셀 고정 설비 = 허용 (연출)', !/볼트 공급기/.test(a) && /불량 배출 연출/.test(al), al);
      check('불량 배출 연출 ↔ 움직이는 로봇 링크 · 다른 셀 설비 = 검출', /로봇 링크/.test(b) && /옆 셀 제어반/.test(c), `${b} / ${c}`); }

    { // 손에 든 정비 도구: 그 이동체의 손 부품(손가락)과 닿는 것만 허용 — 자기 다리 · 다른 이동체와 겹치면 검출
      const W = world(), hu = grp(0, 0, 0, W.scene, { ent: '휴머노이드-정비1', grp: 'humanoid' }); W.force.add(hu); box(0.16, 0.8, 0.16, 0.12, 0.45, 0, hu, null, '다리');
      const arm = grp(0.45, 0.9, 0, hu, null, 'Elbow_R'); box(0.03, 0.06, 0.03, 0, 0, 0, arm, { hand: true }, '손가락');
      W.force.add(arm); const anc = grp(0, 0, 0, arm, null, '도구 고정점'); W.force.add(anc); const kit = grp(0, -0.12, 0, anc, { role: 'handtool' }, '진단기 묶음'); W.force.add(kit); box(0.1, 0.22, 0.32, 0, 0, 0, kit, null, '진단기');   // 윗면이 손가락 아랫면보다 2cm 위 — 쥔 손 · 도구는 팔과 따로 도는 고정점 아래 (실제 장면과 같은 강체 경계)
      const other = grp(3, 0, 0, W.scene, { ent: '휴머노이드-정비2', grp: 'humanoid' }); W.force.add(other); box(0.03, 0.06, 0.03, 0, 0.9, 0, other, { hand: true }, '남의 손가락');
      W.step(0); const a = names(W), al = W.chk.allowed().map((x) => x.why).join(''); arm.position.x = 0.2; W.step(0.1); const b = names(W);   // 팔을 몸 쪽으로: 진단기가 자기 다리를 파고든다
      arm.position.x = 0.45; other.position.set(0.45, -0.1, 0); W.step(0.2); const c = names(W);   // 남의 손가락이 진단기 속으로
      check('손에 든 도구 ↔ 그 손가락 = 허용 (쥠)', !/진단기/.test(a) && /손에 든 도구/.test(al), al || a);
      check('손에 든 도구 ↔ 자기 다리 · 다른 이동체의 손 = 검출 (그 손만 허용)', /진단기↔다리|다리↔진단기/.test(b) && /남의 손가락/.test(c), `${b} / ${c}`); }
    { // 로봇이 든 포장(적재물): 그리퍼 · 안착면(2cm 이하)만 허용 — 깊이 묻히거나 제품 · 설비와 겹치면 검출 / 안착면이라도 로봇 링크가 닿으면 검출
      const W = world(), st = grp(0, 0, 0, W.scene, { station: '포장셀' }), pack = grp(0, 1.5, 0, st, { role: 'load' }, '든 포장'); W.force.add(pack); box(1.16, 0.6, 0.62, 0, 0.3, 0, pack, null, '닫힌 포장');
      box(0.2, 0.04, 0.74, 0.62, 0.9, 0, W.scene, { ent: '라인 AMR(3)', grp: 'amr', role: 'seat' }, '키트 포켓'); box(0.5, 0.3, 0.5, 0, 0.75, 2, W.scene, { ent: '대상물(3)', grp: 'product' }, '제품');
      box(1.0, 0.75, 1.0, 3, 0.375, 0, st, { role: 'seat' }, '분리판 거치대');
      const rb = grp(3, 0, 1.5, st, { robot: '포장셀 로봇1', grp: 'arm' }); W.force.add(rb); const j = grp(0, 0.9, 0, rb, null, 'J4'); box(0.2, 0.2, 0.9, 0, 0, 0, j, null, '아래팔'); const tip = grp(0, -0.25, -0.9, j, { role: 'tool' }, 'ToolTCP'); box(0.6, 0.02, 0.6, 0, 0, 0, tip, null, '든 분리판');
      W.step(0); pack.position.y = 0.905; W.step(0.1); const n1 = W.found().length, al = W.chk.allowed().map((x) => x.why).join(' · ');   // 포켓(윗면 0.92)에 1.5cm 얹힘
      pack.position.y = 0.87; W.step(0.2); const deep = names(W); pack.position.set(0, 0.7, 2); W.step(0.3); const prod = names(W);   // 5cm 묻힘 → 제품 위로 내려옴
      pack.position.set(0, 3, 0); rb.position.z = 0.9; j.position.y = 0.995; W.step(0.4); const s4 = names(W), al4 = W.chk.allowed().map((x) => x.why).join(' · ');   // 든 분리판을 거치대 윗면(0.75)에 1.5cm 눌러 놓음 · 아래팔(밑면 0.895)은 거치대 위
      j.position.y = 0.8; W.step(0.5); const s5 = names(W);   // 아래팔(밑면 0.7)이 거치대 속으로
      check('든 포장(적재물) ↔ 안착면 1.5cm = 허용, 5cm 묻히면 검출', n1 === 0 && /안착면/.test(al) && /닫힌 포장↔키트 포켓|키트 포켓↔닫힌 포장/.test(deep), `${n1}건 · ${al} → ${deep}`);
      check('든 포장(적재물) ↔ 제품 = 검출 (적재물 표시가 제품 관통을 가리지 않음)', /닫힌 포장↔제품|제품↔닫힌 포장/.test(prod), prod);
      check('든 분리판(공구) ↔ 거치대(안착면) = 허용, 로봇 아래팔 ↔ 거치대 = 검출', !/거치대/.test(s4) && /공구/.test(al4) && /아래팔↔분리판 거치대|분리판 거치대↔아래팔/.test(s5), `${s4} / ${s5}`); }

    // ── 바운딩 후보 ↔ 삼각형 확정 구분
    { const W = world(), a = grp(0, 1, 0, W.scene, { ent: 'A', grp: 'agv' }); W.force.add(a); mk(new THREE.TorusGeometry(0.5, 0.05, 8, 24), null, 0, 0, 0, a, null, '고리');
      const b = grp(0, 1, 0, W.scene, { ent: 'B', grp: 'agv' }); W.force.add(b); box(0.2, 0.2, 0.2, 0, 0, 0, b, null, '고리 구멍 속 상자');
      W.step(0); const e0 = W.ev()[0]; b.position.x = 0.45; W.step(0.6); const e1 = W.ev()[0];
      check('바운딩 상자만 겹침(고리 구멍 속 빈 공간) = 「바운딩만 겹침」, 고리에 닿으면 「삼각형 확정」', e0?.verdict === 'bounding' && e1?.verdict === 'confirmed', `${e0?.verdict} → ${e1?.verdict} (교차 삼각형 ${e1?.triInfo?.pairs}쌍)`);
      const W2 = world(), c = grp(0, 1, 0, W2.scene, { ent: 'C', grp: 'agv' }); W2.force.add(c); mk(new THREE.SphereGeometry(0.5, 16, 12), null, 0, 0, 0, c, null, '큰 공');
      const d = grp(0, 1, 0, W2.scene, { ent: 'D', grp: 'agv' }); W2.force.add(d); mk(new THREE.SphereGeometry(0.1, 8, 6), null, 0.05, 0, 0, d, null, '작은 공'); W2.step(0); const e2 = W2.ev()[0];
      check('겉면이 만나지 않아도 통째로 안에 든 형상 = 확정(내포)', e2?.verdict === 'confirmed' && !!e2.triInfo?.inside, `${e2?.verdict} ${e2?.triInfo?.inside}`); }

    // ── V04: 기록 시각 = 실제 시뮬레이션 시각(sim.time) · 표본 간격(한 표본 3cm)
    { const mkRun = (sub) => { const W = world(), mover = grp(-1.0, 0, 0, W.scene, { ent: 'AGV-1', grp: 'agv' }); W.force.add(mover); box(0.2, 0.5, 0.5, 0, 0.4, 0, mover, null, '차체'); box(0.04, 1, 1, 0.16, 0.5, 0, W.scene, null, '얇은 벽');
        const sim = { time: 600, v: { x: -1.0, y: 0, z: 0 }, step(dt) { this.time += dt; this.v.x += 3.4 * dt; } };   // 600초에서 시작 · 초속 3.4m (0.1초에 34cm)
        const interp = { p: null, capture(tg) { this.p = tg.map((m) => m.x); }, apply(tg, a) { this.cur = tg.map((m) => m.x); tg.forEach((m, i) => { m.x = this.p[i] + (this.cur[i] - this.p[i]) * a; }); }, restore() { if (this.cur) { sim.v.x = this.cur[0]; this.cur = null; } } };
        const seen = []; const R = new C.Runner({ sim, interp, targets: () => [sim.v], view: { update() { mover.position.x = sim.v.x; } }, dt: 0.1, sub, check: (t, f) => { W.chk.check([W.scene], t, f); seen.push(t); return false; } });
        R.advance(5); R.advance(5); return { W, R, sim, seen }; };   // 두 청크로 나눠 돌린다 (전에는 청크마다 시각이 0부터)
      const fine = mkRun({ min: 2, max: 12, move: 0.03 }), coarse = mkRun({ min: 1, max: 1, move: 0.03 }), e = fine.W.ev()[0];
      check('V04 기록 시각 = 실제 시뮬레이션 시각(sim.time) — 청크를 나눠 돌려도 600초대', !!e && e.t0 > 600 && e.t0 <= fine.sim.time && e.t >= e.t0 && Math.abs(fine.sim.time - 601) < 1e-6, e ? `t0=${e.t0} tMax=${e.tMax} (sim.time ${fine.sim.time.toFixed(1)})` : '사건 없음');
      check('표본 간격: 0.1초에 34cm 가는 이동체를 12등분(2.8cm)해 4cm 벽 통과를 검출 — 0.1초 표본만으로는 놓침', fine.W.ev().length === 1 && coarse.W.ev().length === 0 && fine.R.maxSub === 12, `등분 ${fine.R.maxSub} · 표본 ${fine.R.samples}개 → ${fine.W.ev().length}건 / 0.1초 표본 ${coarse.R.samples}개 → ${coarse.W.ev().length}건`);
      const e2 = fine.W.ev()[0]; check('V04 사건에 양쪽 부품 이름 · 월드 행렬 · 관절 자세 자리 · 깊이가 남음', !!e2 && e2.a.m.length === 16 && e2.b.m.length === 16 && !!e2.a.label && !!e2.b.label && e2.maxD > 0 && Array.isArray(e2.at), e2 ? `${e2.a.label} ↔ ${e2.b.label} · 깊이 ${e2.maxD}` : ''); }
    return rows;
  }
  return { run };
});
