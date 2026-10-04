// UI 스크롤 검증 (Electron) — 모든 팝업 창을 열고, 스크롤이 필요한 영역마다 실제 마우스 휠로 아래·위로 굴려
// 끝까지 내려가고 다시 맨 위로 올라오는지, 주기 갱신(0.25~1.5초) 뒤에도 스크롤 위치·펼친 항목이 유지되는지 확인한다.
// 실행: npm run test:ui  (서버를 직접 띄움 · 창 높이 620px로 스크롤이 생기게)
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
setTimeout(() => { console.log('TIMEOUT'); process.exitCode = 1; app.quit(); }, 400000);
const H = +(process.env.H || 620);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1400, height: H, show: false });
  const errs = []; w.webContents.on('console-message', (e) => { if (e.level === 'error') errs.push(e.message.slice(0, 200)); });
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(3500);
  const js = (c) => w.webContents.executeJavaScript(c);
  await js(`document.querySelector('[data-mode=dark]').click()`); await wait(2000);
  // 내용이 충분히 길어지도록: 1시간 운영 + 고장·현장 이벤트·명령
  await js(`(()=>{ const t=window.__twin, s=t.sim; for(let k=0;k<36000;k++){s.step(0.1); t.agent.update(0.1);} s.injectFault(s.processing[3]); s.injectFieldEvent('leak', -20, 8); s.cmd.issue('SAFE_SPEED','all'); for(let k=0;k<200;k++){s.step(0.1); t.agent.update(0.1);} s.cmd.issue('SAFE_SPEED_OFF','all'); for(let k=0;k<100;k++){s.step(0.1); t.agent.update(0.1);} })()`);
  await wait(1500);
  // 스크롤이 필요한 요소 찾기 (보이는 것, overflow auto/scroll, 내용 > 높이)
  const find = (root) => js(`(()=>{ const R=${root}; if(!R) return []; R.querySelectorAll('details').forEach((d)=>{ d.open=true; }); window.__R=R; const out=[]; const all=[R, ...R.querySelectorAll('*')];
    const path=(n)=>{ const p=[]; while(n && n!==R){ p.unshift([...n.parentElement.children].indexOf(n)); n=n.parentElement; } return p.join('.'); };
    all.forEach((e,i)=>{ const cs=getComputedStyle(e); if(!/(auto|scroll)/.test(cs.overflowY)) return; if(e.scrollHeight<=e.clientHeight+4) return; const r=e.getBoundingClientRect(); if(r.width<20||r.height<20) return;
      out.push({ id: path(e), cls: (e.id?('#'+e.id):'')+'.'+[...e.classList].join('.'), sh: e.scrollHeight, ch: e.clientHeight }); }); return out; })()`);
  const R0 = (id) => `(()=>{ const R=window.__R; const id='${id}'; return id==='' ? R : id.split('.').reduce((n,i)=>n?.children[+i], R); })()`;
  const point = (id) => js(`(()=>{ const e=${R0(id)}; if(!e) return null; const r=e.getBoundingClientRect(); const xs=[0.5,0.3,0.7,0.15,0.85], ys=[0.5,0.3,0.7,0.2,0.8];
    for (const fy of ys) for (const fx of xs) { const x=Math.round(r.x+r.width*fx), y=Math.round(Math.max(0,r.y)+Math.min(r.height, innerHeight-Math.max(0,r.y))*fy); const h=document.elementFromPoint(x,y); if(!h) continue; let n=h; while(n && n!==e){ const cs=getComputedStyle(n); if(/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight>n.clientHeight+4) break; n=n.parentElement; } if(n===e) return [x,y]; } return null; })()`);
  const top = (id) => js(`(${R0(id)})?.scrollTop ?? -1`);
  const openDetails = (id) => js(`[...(window.__R?.querySelectorAll('details') ?? [])].every((d)=>d.open)`);
  const settle = async (id) => { let a = await top(id), b; for (let k = 0; k < 15; k++) { await wait(120); b = await top(id); if (Math.abs(b - a) < 0.5) break; a = b; } return b; };
  const wheel = async (x, y, dy, n) => { for (let i = 0; i < n; i++) { w.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }); await wait(40); } await wait(350); };
  const results = [];
  async function testPopup(name, open, root, close) {
    await open(); await wait(1200);
    const els = await find(root);
    if (!els.length) { results.push([name, '-', '스크롤 필요 없음 (내용이 창 안에 다 들어감)', 'n/a']); }
    for (const el of els) {
      const p = await point(el.id); if (!p) { results.push([name, el.cls, `가려져 휠 위치 없음 (${el.sh}/${el.ch})`, 'skip']); continue; }
      await wheel(p[0], p[1], -120, 8); const d1 = await settle(el.id);
      await wait(1500); const d2 = await top(el.id);
      await wheel(p[0], p[1], 120, 30); const u1 = await settle(el.id);
      await wait(1200); const u2 = await top(el.id);
      const det = await openDetails(), need = Math.min(20, el.sh - el.ch - 1); const ok = d1 >= need && d2 >= d1 * 0.6 && u1 <= 2 && u2 <= 2 && det;
      results.push([name, el.cls, `내용 ${el.sh}px / 창 ${el.ch}px · 아래로 ${Math.round(d1)} → 1.5초 뒤 ${Math.round(d2)} · 위로 ${Math.round(u1)} → 1.2초 뒤 ${Math.round(u2)}${det ? '' : ' · 펼친 항목이 접힘'}`, ok ? 'PASS' : 'FAIL']);
    }
    await close(); await wait(500);
  }
  const clickId = (id) => js(`document.getElementById('${id}')?.click()`);
  const D = (sel) => `document.querySelector('${sel}')`;
  // 정보 창 (로봇: AMR · 셀 로봇, 설비)
  await testPopup('로봇 정보 창 (AMR)', () => js(`(()=>{ const t=window.__twin; t.view.selectRobot({type:'mover', id:'AMR-03'}); t.ui.showRobot(); })()`), D('#detail'), () => js(`window.__twin.ui.hideDetail(); window.__twin.view.selectRobot(null)`));
  await testPopup('로봇 정보 창 (셀 로봇)', () => js(`(()=>{ const t=window.__twin; t.view.selectRobot({type:'cell', stationId:'DT_ASSY', idx:0}); t.ui.showRobot(); })()`), D('#detail'), () => js(`window.__twin.ui.hideDetail(); window.__twin.view.selectRobot(null)`));
  await testPopup('설비 정보 창', () => js(`(()=>{ const t=window.__twin; t.ui.showDetail(t.sim.processing[3]); })()`), D('#detail'), () => js(`window.__twin.ui.hideDetail()`));
  await testPopup('CCTV 영상 창', async () => { await clickId('btnCctv'); await js(`document.getElementById('cctvOpen')?.click()`); }, D('#cctvPanel'), async () => { await js(`document.getElementById('cctvClose').click()`); await clickId('btnCctv'); });
  await testPopup('CCTV 카드', () => clickId('btnCctv'), D('#cctvCard'), () => clickId('btnCctv'));
  await testPopup('5G 카드', () => clickId('btnNet5g'), D('#net5gCard'), () => clickId('btnNet5g'));
  await testPopup('5G 기지국 창', () => js(`window.__twin.openGnb('gNB-01')`), D('#gnbPanel'), () => js(`document.getElementById('gnbClose').click()`));
  await testPopup('오케스트레이터 (인시던트 흐름)', () => clickId('btnOrch'), D('#orchPanel'), async () => {});
  await testPopup('오케스트레이터 (명령 콘솔)', () => js(`document.querySelector('#orchPanel [data-tab=cmd]').click()`), D('#orchPanel'), async () => { await js(`document.querySelector('#orchPanel [data-tab=flow]').click()`); await clickId('btnOrch'); });
  await testPopup('진화 컨셉', () => clickId('btnConcept'), D('#concept'), () => clickId('closeConcept'));
  await testPopup('3단계 8시간 비교', async () => { await clickId('btnCompare'); await wait(1500); }, D('#compare'), () => clickId('closeCompare'));
  await testPopup('데이터 연동', () => clickId('btnData'), D('#datahub'), () => clickId('closeData'));
  for (const tab of ['po', 'stock', 'mr', 'live', 'log']) await testPopup(`Odoo (${tab})`, async () => { await clickId('btnOdoo'); await js(`document.querySelector('[data-odtab=${tab}]')?.click()`); }, D('#odooModal'), () => clickId('closeOdoo'));
  await testPopup('VLA 학습', () => clickId('btnVla'), D('#vlaModal'), () => clickId('closeVla'));
  await testPopup('AIOS 학습', () => clickId('btnAios'), D('#aiosModal'), () => clickId('closeAios'));
  for (const v of ['agent', 'cell', 'sense']) await testPopup(`FACOS 상세 (${v})`, () => js(`document.querySelector('#facos [data-open="facos:${v}"]')?.click()`), D('#facosModal'), () => clickId('closeFacos'));
  for (const r of results) console.log(r[3].padEnd(5), r[0].padEnd(22), r[1].slice(0, 40).padEnd(40), r[2]);
  const bad = results.filter((r) => r[3] === 'FAIL' || r[3] === 'skip').length;
  console.log(`\n결과: ${results.filter((r) => r[3] === 'PASS').length} PASS / ${bad} FAIL (스크롤 불필요 ${results.filter((r) => r[3] === 'n/a').length}) · 콘솔 오류 ${errs.length}`);
  if (errs.length) console.log(errs.slice(0, 5));
  process.exitCode = bad || errs.length ? 1 : 0; app.quit();
});
