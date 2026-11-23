// 사용자 가이드 그림 찍기 (Electron) — 앱 서버를 띄우고 화면을 연 뒤, 단계 목록대로 창을 열어 docs/guide-images/ 에 JPEG로 저장한다.
// tools/smoke.cjs 와 같은 방식(capturePage). 그림은 1920×1080 창 · 가로 1600px · JPEG 품질 80 (PDF 15MB 안에 들도록).
// 실행: npx electron tools/guide-shots.cjs                         (tools/guide-shots.json 의 단계 전부)
//       ONLY=12_data,13_fleet npx electron tools/guide-shots.cjs   (이름으로 고른 단계만 — 앞 단계의 mode · ff 는 건너뛴다)
//       STEPS=파일.json OUT=폴더 npx electron tools/guide-shots.cjs      (다른 단계 파일 · 다른 폴더 — 창 여는 식을 시험할 때)
// 단계: { name, mode?, ff?, js?, wait?, shot?, clip?, dump? }
//   mode  'traditional' | 'smart' | 'dark' — 그 단계로 바꾼다(시뮬레이션이 새로 시작됨)
//   ff    공장 시간을 그만큼(초) 빨리 돌린다 — sim.step 만으로는 자재 투입이 안 되므로(loaderGate 가 화면 동작을 기다림) 그동안만 loaderGate 를 뗀다
//   js    화면 쪽 식(창 열기 · 탭 누르기) — 결과는 콘솔에 출력
//   wait  찍기 전 기다림(ms, 기본 1500)   shot: false 면 찍지 않음   clip: { x, y, width, height } 그 부분만(창 좌표)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.OUT || path.join(ROOT, 'docs', 'guide-images'));
const STEPS = JSON.parse(fs.readFileSync(path.resolve(process.env.STEPS || path.join(__dirname, 'guide-shots.json')), 'utf8'));
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const W = 1920, H = 1080, OUT_W = 1600, QUALITY = 80;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('TIMEOUT'); process.exitCode = 1; app.quit(); }, Number(process.env.TIMEOUT_MS) || 900000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true });
  w.webContents.setAudioMuted(true);   // 토리 안내 음성
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errs.push(String(e.message).slice(0, 300)); });
  const { startServer } = await import(path.join(ROOT, 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(6000);
  const js = (c) => w.webContents.executeJavaScript(c);
  const run = async (c) => { try { return await js(`(async()=>{ try { return await (${c}); } catch(e) { return '오류: ' + (e.stack || e); } })()`); } catch (e) { return '실패: ' + e.message; } };
  fs.mkdirSync(OUT, { recursive: true });
  for (const s of STEPS) {
    if (ONLY && !ONLY.has(s.name) && !s.always) continue;
    if (s.mode) { await js(`document.querySelector('[data-mode=${s.mode}]')?.click()`); await wait(3000); }
    if (s.ff) console.log(`  [${s.name}] 공장 시간 →`, await run(`(()=>{ const t=window.__twin, m=t.sim, g=m.loaderGate; m.loaderGate=null; for(let k=0;k<${Math.round(s.ff * 10)};k++){ m.step(0.1); t.agent?.update?.(0.1); } m.loaderGate=g; return Math.round(m.time); })()`));
    if (s.js) { const r = await run(s.js); if (s.dump) fs.writeFileSync(path.join(OUT, `${s.name}.txt`), typeof r === 'string' ? r : JSON.stringify(r, null, 1)); else if (r !== undefined && r !== null) console.log(`  [${s.name}] js →`, JSON.stringify(r)?.slice(0, 1500)); }   // dump: true 면 결과를 <이름>.txt 로 (화면 글자 대조용)
    await wait(s.wait ?? 1500);
    if (s.shot === false) continue;
    let img = await w.webContents.capturePage(s.clip);
    const sz = img.getSize(); if (sz.width > OUT_W) img = img.resize({ width: OUT_W, quality: 'best' });
    const file = path.join(OUT, `${s.name}.jpg`); fs.writeFileSync(file, img.toJPEG(QUALITY));
    console.log(`  ${s.name}.jpg  ${Math.round(fs.statSync(file).size / 1024)}KB`);
  }
  const uniq = [...new Set(errs)];
  for (const e of uniq) console.log('  콘솔 오류:', e);
  app.quit();
});
