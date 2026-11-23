// 구간별 성능 수치 뽑기 — 앱과 같은 창 크기(1600×960)로 띄워 단계마다 몸풀기 뒤 일정 시간 재고 평균 fps · 프레임 간격 p95/p99 · CPU · 구간별 평균·p95·draw call을 낸다 (js/perf.js)
// 단계: 레거시 · 자동화 · 피지컬AI · 피지컬AI + 로봇 정보 창(손목 카메라 영상) · 피지컬AI + CCTV 영상 창
// 실행: npm run perf   결과: outputs/perf/report-<시각>.json   (PERF_SEC=초 로 측정 시간 변경, 기본 12초)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const out = path.resolve(__dirname, '../outputs/perf'); fs.mkdirSync(out, { recursive: true }); process.env.JIN3D_DATA_DIR = path.join(out, 'runtime');   // 측정 중 녹화·에피소드 저장은 측정 폴더 안에만
const wait = (ms) => new Promise((r) => setTimeout(r, ms)), SEC = +(process.env.PERF_SEC || 12);
const timer = setTimeout(() => { console.error('TIMEOUT'); app.exit(1); }, 900000);

const SCENES = [
  ['레거시', 'traditional', ''],
  ['자동화', 'smart', ''],
  ['피지컬AI', 'dark', ''],
  ['피지컬AI + 로봇 정보 창', 'dark', `const f=t.camWall.feeds().find(f=>f.ref);if(!f)return 'no-robot';t.view.selectRobot(f.ref);t.ui.showRobot();`],
  ['피지컬AI + CCTV 영상 창', 'dark', `const c=t.sim.cctv?.cams?.[0];if(!c)return 'no-cctv';window.__openCctv(c.id);`],
];

app.whenReady().then(async () => {
  try {
    const { startServer } = await import(path.resolve(__dirname, '../server/app-server.mjs')); const { port } = await startServer({ port: 0 });
    const w = new BrowserWindow({ width: 1600, height: 960, show: true, backgroundColor: '#0d1117', webPreferences: { backgroundThrottling: false } });
    await w.loadURL(`http://127.0.0.1:${port}`); const js = (c) => w.webContents.executeJavaScript(c);
    for (let k = 0; k < 90; k++) { if (await js('!!window.__twin?.RENDER.loaded')) break; await wait(500); }
    if (!await js('!!window.__twin?.RENDER.loaded')) throw Error('Blender assets not loaded');
    await js('window.__twin.tori?.close?.()');   // 토리 안내가 자동으로 넘어가며 단계 · 배속 · 카메라를 바꾸면 장면 조건이 달라진다 — 재기 전에 접는다
    const gpu = await js(`(()=>{const g=window.__twin.perf.getRenderer().getContext(),d=g.getExtension('WEBGL_debug_renderer_info');return d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER);})()`);
    const report = { at: new Date().toISOString(), electron: process.versions.electron, chrome: process.versions.chrome, platform: `${process.platform}-${process.arch}`, gpu, sec: SEC, scenes: [] };
    console.log(`GPU ${gpu} · Electron ${process.versions.electron} (Chrome ${process.versions.chrome}) · 단계마다 ${SEC}초`);
    for (const [name, mode, setup] of SCENES) {
      await js(`(()=>{document.querySelector('[data-mode=${mode}]').click();document.getElementById('cctvClose')?.click();const t=window.__twin;t.view.selectRobot(null);t.ui.hideDetail();})()`);
      await wait(4000);   // 몸풀기: 모드 전환 뒤 셰이더 컴파일·모델 교체가 끝나게
      const err = setup ? await js(`(()=>{const t=window.__twin;${setup}})()`) : null;
      if (err) { console.log(`== ${name}: 건너뜀 (${err})`); continue; }
      await wait(1500);
      await js('window.__twin.perf.toggle(true)'); await wait(SEC * 1000);
      const s = await js('window.__twin.perf.snapshot()'); await js('window.__twin.perf.toggle(false)');
      report.scenes.push({ name, mode, ...s });
      console.log(`\n== ${name}  ${s.fps} fps · 간격 ${s.gapAvg}ms (p95 ${s.gapP95} · p99 ${s.gapP99} · 최대 ${s.gapMax}) · CPU ${s.cpuAvg}ms (p95 ${s.cpuP95}) · draw ${s.callsAvg} (최대 ${s.callsMax}) · 삼각형 ${(s.triAvg / 1e6).toFixed(2)}M`);
      for (const v of Object.values(s.sections)) if (v.avg >= 0.05 || v.calls) console.log(`  ${v.label.padEnd(12)} 평균 ${v.avg.toFixed(2).padStart(6)}ms  p95 ${v.p95.toFixed(2).padStart(6)}ms  최대 ${v.max.toFixed(1).padStart(6)}ms  draw ${String(v.calls).padStart(5)}`);
    }
    // 에피소드 카메라 프레임 점검: 카메라 4대 에피소드는 카메라마다 프레임 수가 같아야 한다 (한 스텝의 묶음을 한꺼번에 찍음 · js/vla.js)
    report.episodes = await js(`(()=>{const e=window.__twin.epRec,eps=[...e.byRobot.values()].flat(),multi=eps.filter(x=>(x.cameras?.length??0)>1);
      const cnt=(x)=>x.videos?Object.fromEntries(Object.entries(x.videos).map(([c,v])=>[c,v.frames])):x.frames.reduce((m,f)=>(m[f.cam??'main']=(m[f.cam??'main']??0)+1,m),{});
      return {episodes:eps.length,multiCam:multi.length,uneven:multi.filter(x=>new Set(Object.values(cnt(x))).size>1).length,skippedSteps:e.skipped??0,video:e.video,sample:multi.slice(-3).map(x=>({id:x.id,frames:cnt(x),steps:x.steps.length})),
      grid:(()=>{const d=eps.flatMap(x=>x.steps.slice(1,-1).map((s,k)=>+(s.t-x.steps[k].t).toFixed(3)));const on=d.filter(v=>Math.abs(v-0.2)<0.002).length;const st=eps.flatMap(x=>x.steps);const fd=st.filter(s=>s.frame_dt!=null).map(s=>s.frame_dt).sort((a,b)=>a-b);
        return {intervals:d.length,on02:on,interp:st.filter(s=>s.interp).length,steps:st.length,gaps:eps.reduce((a,x)=>a+(x.sampling?.gaps??0),0),frameDtMedian:fd[fd.length>>1]??null,frameDtMax:fd.at(-1)??null};})()};})()`);
    console.log(`\n에피소드 ${report.episodes.episodes}개 (카메라 4대 ${report.episodes.multiCam}개 · 카메라별 프레임 수 다름 ${report.episodes.uneven}개) · 한도로 프레임 없이 기록한 스텝 ${report.episodes.skippedSteps} · 영상 방식 ${report.episodes.video}`);
    for (const x of report.episodes.sample) console.log(`  ${x.id} 스텝 ${x.steps} · ${JSON.stringify(x.frames)}`);
    { const g = report.episodes.grid; console.log(`  스텝 간격 0.2초: ${g.on02}/${g.intervals} · 보간 스텝 ${g.interp}/${g.steps} · 격자 다시 맞춤 ${g.gaps}회 · 영상−스텝 시각 차 중앙 ${g.frameDtMedian}ms (최대 ${g.frameDtMax}ms)`); }
    const f = path.join(out, `report-${report.at.replace(/[:.]/g, '-')}.json`); fs.writeFileSync(f, JSON.stringify(report, null, 2));
    console.log(`\n저장: ${path.relative(process.cwd(), f)}`);
    clearTimeout(timer); app.exit(0);
  } catch (e) { console.error(e.stack); clearTimeout(timer); app.exit(1); }
});
