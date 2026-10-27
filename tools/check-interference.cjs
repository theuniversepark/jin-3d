// 이동체 형상 간섭 검사 (Electron) — 3단계 공장을 띄워 시뮬레이션을 돌리면서, 지상 이동체(AMR·AGV·지게차·휴머노이드·사족보행·정비 로봇·작업자)의
// 실제 3D 형상(차체 기준 상자)이 설비·셀 로봇·기둥·상자 등 장면의 형상과 겹치는지 0.5초마다 본다 (평면 투영 다각형 SAT + 높이 겹침)
// 실행: npx electron tools/check-interference.cjs [분=20] [모드…]   → 겹침 목록(이동체 · 대상 · 깊이 · 위치)을 출력, 겹침이 있으면 exit 1
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.cjs'));
const MIN = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 20);
const MODES = args.filter((a) => /^[a-z]+$/.test(a)); if (!MODES.length) MODES.push('traditional', 'smart', 'dark');
setTimeout(() => { console.log('TIMEOUT'); process.exitCode = 2; app.quit(); }, 30 * 60000);

// 페이지 안에서 돈다 — 검사기 설치
const PAGE = `(() => { const process_env_verbose = ${process.env.IFC_VERBOSE ? 'true' : 'false'};
  const T = window.__twin, V = T.view, THREE_M4 = V.root.matrixWorld.constructor, V3 = V.root.position.constructor;
  const v = new V3(), inv = new THREE_M4(), rel = new THREE_M4(), im = new THREE_M4();
  const corners = (bb, m, out) => { for (let i = 0; i < 8; i++) { v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m); out.push([v.x, v.y, v.z]); } return out; };
  const hull = (P) => { P = P.map((p) => [p[0], p[2]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = []; for (const p of P) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-9) lo.pop(); lo.push(p); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 1e-9) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1)); };
  // SAT — 겹치면 최소 침투 깊이, 아니면 0
  const sat = (A, B) => { let best = Infinity; for (const P of [A, B]) for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; let nx = b[1] - a[1], nz = a[0] - b[0]; const L = Math.hypot(nx, nz); if (L < 1e-9) continue; nx /= L; nz /= L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity; for (const p of A) { const d = p[0] * nx + p[1] * nz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); } for (const p of B) { const d = p[0] * nx + p[1] * nz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    const o = Math.min(a1, b1) - Math.max(a0, b0); if (o <= 0) return 0; best = Math.min(best, o); } return best; };
  const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const flat = (o) => /Plane|Ring|Circle/.test(o.geometry?.type ?? '') || o.material?.transparent && o.material.depthWrite === false;
  // 대상 이름: 가장 가까운 설비 그룹(셀 이름) · 컨베이어 · 휴머노이드 도크 · 트럭 · 그 밖은 메시 이름/치수
  const labelOf = new Map();
  const tag = () => { labelOf.clear();
    for (const sv of V.stationViews) labelOf.set(sv.group, sv.st.name); for (const g of V.convGroups ?? []) labelOf.set(g, '컨베이어');
    for (const d of V.humanoidDocks ?? []) labelOf.set(d.d, '휴머노이드 도크(' + d.m.id + ')'); for (const [id, tv] of V.truckViews ?? []) labelOf.set(tv.g, '트럭 ' + id); };
  const nameOf = (o, mw = o.matrixWorld) => { const parts = []; for (let p = o; p && p !== V.root && p !== V.dyn; p = p.parent) { if (labelOf.has(p)) { parts.push(labelOf.get(p)); break; } if (p.name && !/^(Mesh|Object|Group)?\\d*$/.test(p.name)) parts.push(p.name); }
    const bb = o.geometry.boundingBox, s = o.getWorldScale(new V3()); const dim = [(bb.max.x - bb.min.x) * s.x, (bb.max.y - bb.min.y) * s.y, (bb.max.z - bb.min.z) * s.z].map((n) => n.toFixed(2)).join('×');
    const c = new V3(); o.geometry.boundingBox.getCenter(c).applyMatrix4(mw); const chain = []; for (let p = o, i = 0; p && p !== V.root && p !== V.dyn && i < 6; p = p.parent, i++) chain.push((p.name || p.type) + (p.parent ? '#' + p.parent.children.indexOf(p) : ''));
    return (parts.length ? parts.reverse().slice(-3).join('/') : '건물·바닥 설비') + ' [' + (o.geometry.type.replace('Geometry', '')) + ' ' + dim + ' @' + c.x.toFixed(2) + ',' + c.z.toFixed(2) + (process_env_verbose ? ' ' + chain.join('<') : '') + ']'; };
  const moverViews = () => [...(V.vehicleViews ?? []), ...(V.carrierViews ?? []), ...(V.techViews ?? []), ...(V.helperViews ?? []), ...(V.quadViews ?? []), ...(V.workerViews ?? [])];
  const isLabel = (o) => o.isCSS2DObject || o.isSprite;
  // 이동체 차체 상자 (자기 그룹 기준) → 평면 다각형 + 높이
  const moverShape = (g) => { g.updateWorldMatrix(true, true); inv.copy(g.matrixWorld).invert(); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    g.traverse((o) => { if (!o.isMesh || !shown(o) || flat(o)) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); rel.multiplyMatrices(inv, o.matrixWorld);
      for (const p of corners(o.geometry.boundingBox, rel, [])) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); } });
    if (!isFinite(x0)) return null; const e = 0.02;   // 맞닿음 여유
    const w = [[x0 + e, z0 + e], [x1 - e, z0 + e], [x1 - e, z1 - e], [x0 + e, z1 - e]].map(([x, z]) => { v.set(x, 0, z).applyMatrix4(g.matrixWorld); return [v.x, v.z]; });
    v.set(0, y0, 0).applyMatrix4(g.matrixWorld); const wy0 = v.y; v.set(0, y1, 0).applyMatrix4(g.matrixWorld);
    // 부품별 형상 (포크·마스트·팔처럼 상자 하나로 보면 빈 공간까지 막힌 것으로 잡히므로) — 4cm 미만 부품은 뺀다
    const parts = []; g.traverse((o) => { if (!o.isMesh || !shown(o) || flat(o)) return; const P = corners(o.geometry.boundingBox, o.matrixWorld, []); let a = Infinity, b = -Infinity; for (const p of P) { a = Math.min(a, p[1]); b = Math.max(b, p[1]); }
      const bb = o.geometry.boundingBox, sc = o.getWorldScale(new V3()); if (Math.max((bb.max.x - bb.min.x) * sc.x, (bb.max.y - bb.min.y) * sc.y, (bb.max.z - bb.min.z) * sc.z) < 0.04) return; parts.push({ poly: hull(P), y0: a, y1: b }); });
    return { poly: w, y0: wy0, y1: v.y, parts, cx: g.position.x, cz: g.position.z, r: Math.hypot(x1 - x0, z1 - z0) / 2 + Math.hypot((x0 + x1) / 2, (z0 + z1) / 2) }; };
  window.__ifc = {
    check(minDepth) {
      tag(); const out = [], mv = moverViews(), groups = new Set(mv.map((m) => m.g));
      const shapes = mv.map((m) => (m.g.visible && shown(m.g) ? { m, s: moverShape(m.g) } : null)).filter((x) => x?.s);
      const inMover = (o) => { for (let p = o; p; p = p.parent) if (groups.has(p)) return true; return false; };
      const items = new Set([...(V.itemMeshes?.values?.() ?? [])]);
      const inItem = (o) => { for (let p = o; p; p = p.parent) if (items.has(p)) return true; return false; };
      const statics = [];
      for (const top of [V.root, V.dyn]) top.traverse((o) => { if (!o.isMesh || isLabel(o) || !shown(o) || flat(o) || inMover(o) || inItem(o)) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        let dockOf = null; for (let p = o; p; p = p.parent) { const d = (V.humanoidDocks ?? []).find((h) => h.d === p); if (d) { dockOf = d.m.id; break; } }
        const add = (mw) => { const P = corners(o.geometry.boundingBox, mw, []); let y0 = Infinity, y1 = -Infinity; for (const p of P) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
          if (y1 <= 0.1 || y1 < 0.12 && y1 - y0 < 0.025) return;   // 바닥 판·바닥 표시 — 올라타 지나가는 높이(AMR 셀 바닥 판 · 출하 도크 레벨러 8cm)
          statics.push({ o, P, y0, y1, mw, dockOf }); };
        if (o.isInstancedMesh) for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, im); add(new THREE_M4().multiplyMatrices(o.matrixWorld, im)); }   // 재고 모델 — 인스턴스마다 (기본 지오메트리는 원점에 있다)
        else add(o.matrixWorld); });
      for (const { m, s } of shapes) {
        const st = m.v.state, tag2 = m.v.id + ' (' + m.v.kind + (st ? ' · ' + st : '') + (m.v.task ? ' · ' + m.v.task : '') + ')';
        for (const q of statics) { if (q.y1 <= s.y0 + 0.03 || q.y0 >= s.y1 - 0.03) continue;
          let cx = 0, cz = 0; for (const p of q.P) { cx += p[0]; cz += p[2]; } cx /= 8; cz /= 8; let rr = 0; for (const p of q.P) rr = Math.max(rr, Math.hypot(p[0] - cx, p[2] - cz));
          if (Math.hypot(cx - s.cx, cz - s.cz) > rr + s.r) continue;
          const qp = hull(q.P); if (!sat(s.poly, qp)) continue;
          let d = 0; for (const pt of s.parts) if (pt.y1 > q.y0 + 0.03 && pt.y0 < q.y1 - 0.03) d = Math.max(d, sat(pt.poly, qp) - 0.02);
          if (q.dockOf === m.v.id) continue;   // 자기 충전 도크 (들어가 서는 자리)
          if (m.v.kind === 'forklift' && q.y1 <= 0.2) continue;   // 지게차 포크 ↔ 팔레트 (포크 포켓에 넣어 들어 올림)
          if (d > minDepth) out.push({ who: tag2, kind: m.v.kind, id: m.v.id, what: nameOf(q.o, q.mw), d: +d.toFixed(2), x: +m.v.x.toFixed(2), z: +m.v.z.toFixed(2), y: q.y0.toFixed(2) + '~' + q.y1.toFixed(2) }); }
      }
      // 이동체끼리 (지상)
      for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) { const a = shapes[i], b = shapes[j];
        if (a.s.y1 <= b.s.y0 || b.s.y1 <= a.s.y0 || Math.hypot(a.s.cx - b.s.cx, a.s.cz - b.s.cz) > a.s.r + b.s.r) continue;
        if (!sat(a.s.poly, b.s.poly)) continue; let d = 0;
        for (const pa of a.s.parts) for (const pb of b.s.parts) if (pa.y1 > pb.y0 && pb.y1 > pa.y0) d = Math.max(d, sat(pa.poly, pb.poly) - 0.04);
        if (d > minDepth) out.push({ who: a.m.v.id + ' (' + a.m.v.kind + ')', kind: 'mover-mover', id: a.m.v.id, what: '이동체 ' + b.m.v.id + ' (' + b.m.v.kind + ')', d: +d.toFixed(2), x: +a.m.v.x.toFixed(2), z: +a.m.v.z.toFixed(2), y: '' }); }
      return out;
    },
    run(steps, every, minDepth) { const s = T.sim, ag = T.agent, res = []; for (let k = 0; k < steps; k++) { s.step(0.1); ag.update(0.1); V.update(0.1, true, 1); if (k % every === 0) for (const h of this.check(minDepth)) res.push({ t: +s.t?.toFixed?.(1) || k / 10, ...h }); } return res; },
  };
  return true;
})()`;

app.whenReady().then(async () => {
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  const w = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { backgroundThrottling: true } });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(4000);
  const js = (c) => w.webContents.executeJavaScript(c);
  await js(`(()=>{ const b=document.getElementById('playBtn'); if (b.textContent.includes('❚')) b.click(); })()`);   // 페이지 루프는 멈추고 여기서 직접 돌린다
  let total = 0;
  for (const mode of MODES) {
    await js(`document.querySelector('[data-mode=${mode}]').click()`); await wait(2500);
    await js(`(()=>{ const b=document.getElementById('playBtn'); if (b.textContent.includes('❚')) b.click(); })()`);
    await js(PAGE);
    const agg = new Map(); let n = 0;
    const chunk = 600;   // 1분씩
    for (let i = 0; i < MIN; i++) {
      const res = await js(`window.__ifc.run(${chunk}, 5, 0.03)`);
      // 같은 원인끼리 묶는다: 이동체 종류(번호 뗀 이름) × 대상 설비(셀 이름까지) — 자세히(IFC_VERBOSE)는 이동체·메시 하나하나
      for (const r of res) { n++; const k = process.env.IFC_VERBOSE ? r.id + ' ↔ ' + r.what : r.id.replace(/-?\d+$/, '') + ' ↔ ' + (r.what.startsWith('건물') ? r.what.replace(/ @.*$/, '') : r.what.replace(/ \[.*$/, '')); const a = agg.get(k); if (!a) agg.set(k, { ...r, n: 1, maxD: r.d, ids: new Set([r.id]) }); else { a.n++; a.ids.add(r.id); if (r.d > a.maxD) Object.assign(a, r, { n: a.n, ids: a.ids, maxD: r.d }); } }
    }
    console.log(`\n== ${mode}: ${MIN}분 · 겹침 표본 ${n}건 · 종류 ${agg.size}`);
    for (const a of [...agg.values()].sort((a, b) => b.maxD - a.maxD)) console.log(`  ${a.who}${a.ids.size > 1 ? ` 외 ${a.ids.size - 1}대` : ''}  ↔  ${a.what}  · 최대 ${a.maxD}m · ${a.n}회 · 예 t=${a.t} (${a.x}, ${a.z}) y ${a.y}`);
    total += agg.size;
  }
  process.exitCode = total ? 1 : 0;
  app.quit();
});
