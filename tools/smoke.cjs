// 화면 로드 점검 (Electron) — 앱 서버를 띄우고 화면을 연 뒤 단계(레거시 · 자동화 · 피지컬AI)마다 시뮬레이션을 돌리며
// 콘솔 오류 · 처리되지 않은 예외가 없는지, 시뮬레이션 시각이 흐르는지 확인한다. 화면 그림도 남길 수 있다.
// 실행: npm run smoke            (오류가 있으면 실패)
//       SHOT=폴더 npm run smoke  (단계별 화면 PNG를 그 폴더에 저장)
//       EVAL='식' npm run smoke  (피지컬AI 단계에서 화면 쪽 자바스크립트 식을 실행해 결과를 출력 — 창 열기 확인용)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('TIMEOUT'); process.exitCode = 1; app.quit(); }, 240000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1600, height: 950, show: false });
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errs.push(String(e.message).slice(0, 400)); });
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(5000);
  const js = (c) => w.webContents.executeJavaScript(c);
  await js(`window.addEventListener('error', (e) => console.error('window.onerror: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno)); window.addEventListener('unhandledrejection', (e) => console.error('unhandledrejection: ' + (e.reason?.stack || e.reason)));`);
  await js(`window.__twin?.tori?.close?.()`);   // 안내 아바타(토리)가 첫 인사 뒤 자동으로 넘어가며 단계 · 배속을 바꾸지 않게 접어 둔다 (토리는 EVAL로 따로 돌려 본다)
  const out = [];
  for (const mode of ['traditional', 'smart', 'dark']) {
    await js(`document.querySelector('[data-mode=${mode}]')?.click()`); await wait(2500);
    // 10분 운영을 빠르게 돌려 주기 갱신 · 창 그리기 경로를 태운다 — 빨리 돌리는 동안은 화면이 갱신되지 않아 투입 로봇 동작을 기다리는 문(loaderGate)이 열리지 않으므로 잠시 떼어 둔다
    const r = await js(`(()=>{ try { const t=window.__twin, s=t?.sim; if(!s) return { err: '__twin 없음' }; const t0=s.time, gate=s.loaderGate; s.loaderGate=null; for(let k=0;k<6000;k++){ s.step(0.1); t.agent?.update?.(0.1); } s.loaderGate=gate; return { mode: s.mode.key, dt: Math.round(s.time-t0), good: s.stats?.good ?? null }; } catch(e) { return { err: String(e.stack || e).slice(0, 600) }; } })()`);
    await wait(2500);
    out.push(r);
    if (r.err) errs.push(`[${mode}] ${r.err}`);
    if (process.env.SHOT) { fs.mkdirSync(process.env.SHOT, { recursive: true }); fs.writeFileSync(path.join(process.env.SHOT, `${mode}.png`), (await w.webContents.capturePage()).toPNG()); }
  }
  if (process.env.EVAL) {
    try { console.log('EVAL →', JSON.stringify(await js(`(async()=>{ try { return await (${process.env.EVAL}); } catch(e) { return 'EVAL 오류: ' + (e.stack || e); } })()`))); } catch (e) { console.log('EVAL 실패:', e.message); }
    await wait(2000);
    if (process.env.SHOT) fs.writeFileSync(path.join(process.env.SHOT, 'eval.png'), (await w.webContents.capturePage()).toPNG());
  }
  for (const r of out) console.log('  단계', JSON.stringify(r));
  const uniq = [...new Set(errs)];
  for (const e of uniq) console.log('  콘솔 오류:', e);
  console.log(uniq.length ? `결과: FAIL (콘솔 오류 ${uniq.length}건)` : '결과: PASS (콘솔 오류 없음)');
  process.exitCode = uniq.length ? 1 : 0;
  app.quit();
});
