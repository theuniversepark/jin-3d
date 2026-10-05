// Blender 다듬기용 기본 도형 수집 (Electron) — 3단계(레거시·자동화·피지컬AI) 공장을 띄워 장면의 모든 상자·원기둥·구 치수를 모은다
// → blender/primitives.json (blender/build_assets.py가 읽어 Blender에서 다듬은 도형 라이브러리 assets/blender/primitives.glb를 만든다)
// 실행: npm run blender:collect   (모델 코드가 바뀌면 다시 수집 → npm run blender:assets)
const { app, BrowserWindow } = require('electron');
const path = require('node:path'), fs = require('node:fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('TIMEOUT'); process.exitCode = 1; app.quit(); }, 240000);
app.whenReady().then(async () => {
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  const w = new BrowserWindow({ width: 1200, height: 800, show: false });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(3500);
  const js = (c) => w.webContents.executeJavaScript(c);
  const all = {};
  // 기본 렌더가 Blender라 도형이 이미 바뀌어 있으면 치수를 읽을 수 없다 — 기본 도형 모델(3d)로 그린 화면에서 모은다
  await js(`window.__twin.setRender('3d')`); await wait(1500);
  for (const mode of ['traditional', 'smart', 'dark']) {
    await js(`document.querySelector('[data-mode=${mode}]').click()`); await wait(2000);
    // 운영 중에 생기는 모델(대상물 AMR·트럭·입고 트럭 등)도 나오도록 잠시 돌린다
    await js(`(()=>{ const t=window.__twin, s=t.sim; for(let k=0;k<3000;k++){s.step(0.1); t.agent.update(0.1);} })()`); await wait(2500);
    const keys = await js(`(()=>{ const out={}; let scn=window.__twin.view.root; while(scn.parent) scn=scn.parent;
      scn.traverse((o)=>{ if(!o.isMesh) return; const k=window.__twin.primKey(o.geometry); if(k) out[k]=(out[k]??0)+1; }); return out; })()`);
    for (const [k, n] of Object.entries(keys)) all[k] = Math.max(all[k] ?? 0, n);
    console.log(mode, Object.keys(keys).length, 'kinds');
  }
  const list = Object.keys(all).sort();
  fs.writeFileSync(path.join(__dirname, '..', 'blender', 'primitives.json'), JSON.stringify({ note: 'tools/collect-primitives.cjs가 모은 기본 도형 키 (B|w|h|d · C|rt|rb|h|seg|open · S|r)', count: list.length, keys: list }, null, 1));
  console.log('total kinds', list.length, 'instances(max per mode)', Object.values(all).reduce((a, b) => a + b, 0));
  app.quit();
});
