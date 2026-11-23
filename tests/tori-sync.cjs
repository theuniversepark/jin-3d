// 토리 안내와 실제 화면의 동기화 (Electron · 검수 R06 ~ R10) — 앱 서버를 띄우고 진짜 화면에서 안내를 돌린다. 상태 기계 · 타이머는 tests/torisync.mjs (npm test)
// 실행: npm run test:tori                 (전부 — 약 15분: 경계 재현 + 한국어 10개 주제 자동 순회 · 「이전」 비교 + 영어 순회)
//       QUICK=1 npm run test:tori         (경계 재현만 — 약 4분)      WALK=1 … (순회만)      SHOT=폴더 … (대표 장면 PNG 저장)      KINDS=intrusion,debris … (인시던트 끝까지 볼 종류)
//  ① 처음 접속 인사 · 첫 클릭으로 음성 시작(R10)  ② 음성 재생 거부(R08)  ③ 안내 중 단계 변경 · 리셋(R06)  ④ 「이전」 창 · 상위망(R09)
//  ⑤ 인시던트 감지 전/후 「다음」 · 대기 시간 초과(R07 — 사람 진입 · 이물질 · 누유 · 연기)  ⑥ 전 주제 자동 순회 → 「이전」으로 되돌아가며 창 · 탭 · 카메라 · 망 상태 비교  ⑦ 영어 순회
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-tori-'));
process.env.JIN3D_DATA_DIR = path.join(tmp, 'data'); app.setPath('userData', path.join(tmp, 'profile'));   // 처음 접속 상태 (안내 본 적 없음 · 한국어)
const QUICK = !!process.env.QUICK, SHOT = process.env.SHOT, KINDS = (process.env.KINDS ?? 'intrusion,debris').split(',').filter(Boolean);
const ORDER = ['tour', 'facos', 'incident', 'trace', 'quality', 'kpi', 'data', 'link', 'docs', 'outcome'];
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const done = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 남겨도 무방 */ } app.exit(code); };
setTimeout(() => { console.log('TIMEOUT'); done(2); }, 50 * 60000);

// 화면 쪽 도우미: 지금 단계 · 화면 상태(보이는 창 · 탭 · 강조 · 카메라 · 망 · 멈춤)
const PAGE = `(() => { const T = window.__twin, t = T.tori; let cam = null;
  const fly = t.h.flyTo, to = t.h.camTo;
  t.h.flyTo = (k) => { cam = { fly: k }; return fly(k); };
  t.h.camTo = (c) => { cam = c.ms === 900 ? { follow: 1 } : c.view ? { fly: c.view } : c.station ? { station: c.station, d: c.d } : { x: Math.round(c.x), z: Math.round(c.z), d: c.d }; return to(c); };
  const vis = () => [...document.querySelectorAll('.modal:not(.hidden),#detail:not(.hidden),#orchPanel:not(.hidden)')];
  window.__ts = {
    pos: () => ({ topic: t.topic, step: t.step, n: t.steps().length, open: t.open, timedOut: !!t.timedOut, note: t.noteK ?? null }),
    snap: () => ({ topic: t.topic, step: t.step, mode: T.sim.mode.key, paused: t.h.paused(), held: !!t.held, speed: t.h.speed(), online: T.sim.fos ? T.sim.fos.online : null,
      vis: vis().map((e) => e.id).sort(), orchTab: document.querySelector('#orchPanel:not(.hidden)') ? T.orchView.tab : null,
      tabs: vis().filter((e) => e.id !== 'orchPanel').map((m) => m.id + ':' + [...m.querySelectorAll('button.on,[aria-selected="true"]')].map((b) => b.textContent.replace(/[0-9]/g, '').trim().slice(0, 10)).join('|')).sort(),
      hl: [...document.querySelectorAll('.tori-hl')].map((e) => e.id).sort(), cam, text: t.sayEl.textContent, spoken: t.spokenText, ko: /[가-힣]/.test(t.sayEl.textContent) }),
    prev: () => { document.querySelector('#tori [data-t="prev"]').click(); t.cancelAuto(); },
    next: () => document.querySelector('#tori [data-t="next"]').click(),
  }; return true; })()`;
const camSame = (a, b) => { if (!a || !b) return a === b; if (a.follow || b.follow) return !!a.follow === !!b.follow; if (a.x != null && b.x != null) return Math.hypot(a.x - b.x, a.z - b.z) <= 4 && a.d === b.d; return JSON.stringify(a) === JSON.stringify(b); };
const diff = (f, b) => { const d = []; for (const k of ['mode', 'online', 'vis', 'orchTab', 'tabs', 'hl']) if (JSON.stringify(f[k]) !== JSON.stringify(b[k])) d.push(`${k}: ${JSON.stringify(f[k])} → ${JSON.stringify(b[k])}`); if (!camSame(f.cam, b.cam)) d.push(`cam: ${JSON.stringify(f.cam)} → ${JSON.stringify(b.cam)}`); return d; };

app.whenReady().then(async () => { try {
  const w = new BrowserWindow({ width: 1600, height: 950, show: false, webPreferences: { backgroundThrottling: false } });
  w.webContents.setAudioMuted(true); w.showInactive();   // 화면이 그려져야 공장이 돈다 · 소리는 끈다
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errs.push(String(e.message).slice(0, 300)); });
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  await w.loadURL(`http://127.0.0.1:${port}`);
  const js = async (c) => { const r = await w.webContents.executeJavaScript(`(async () => { try { return await (${c}); } catch (e) { return { __err: String(e.stack || e) }; } })()`); if (r?.__err) throw new Error(r.__err); return r; };
  const until = async (c, ms, step = 100) => { const t0 = Date.now(); for (;;) { const r = await js(c); if (r) return r; if (Date.now() - t0 > ms) return null; await wait(step); } };
  const shot = async (name) => { if (!SHOT) return; fs.mkdirSync(SHOT, { recursive: true }); fs.writeFileSync(path.join(SHOT, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const t = 'window.__twin.tori';
  await js(`(window.addEventListener('error', (e) => console.error('window.onerror: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno)), window.addEventListener('unhandledrejection', (e) => console.error('unhandledrejection: ' + (e.reason?.stack || e.reason))), 1)`);

  console.log('== ① 처음 접속 인사 · 첫 클릭으로 음성 시작 (R10)');
  const greeted = await until(`window.__twin?.tori?.open && ${t}.step === 0 && ${t}.topic === 'tour'`, 30000);
  check('처음 접속하면 토리가 스스로 둘러보기를 시작', !!greeted);
  const r10a = await js(`({ active: navigator.userActivation.hasBeenActive, pending: !!${t}.pending, speaking: !!${t}.speaking, timer: !!${t}.autoT })`);
  check('첫 클릭 전: 소리는 미뤄 두고 읽는 시간으로 자동 넘김 예약', !r10a.active && r10a.pending && !r10a.speaking && r10a.timer, JSON.stringify(r10a));
  w.webContents.sendInputEvent({ type: 'mouseDown', x: 4, y: 4, button: 'left', clickCount: 1 }); w.webContents.sendInputEvent({ type: 'mouseUp', x: 4, y: 4, button: 'left', clickCount: 1 });
  const r10b = await until(`${t}.speaking && ({ active: navigator.userActivation.hasBeenActive, audio: !!${t}.audio, timer: !!${t}.autoT, onSpoken: !!${t}.onSpoken, step: ${t}.step })`, 5000);
  check('첫 클릭: 녹음 음성이 시작되고 읽는 시간 타이머는 취소 (음성 끝 기준)', !!r10b && r10b.audio && !r10b.timer && r10b.onSpoken && r10b.step === 0, JSON.stringify(r10b));
  await wait(3000);
  const r10c = await js(`({ speaking: !!${t}.speaking, step: ${t}.step, timer: !!${t}.autoT })`);
  check('…음성이 나오는 동안 자동 넘김 타이머 없음', r10c.speaking && r10c.step === 0 && !r10c.timer, JSON.stringify(r10c));
  await js(`(${t}.close(), ${t}.voice = false, globalThis.__toriFast = true, 1)`);   // 이후는 소리 없이 읽는 시간(0.2초)으로 넘긴다 (② 만 음성 켬)
  await until(`!!window.__twin?.RENDER.loaded`, 60000, 500);
  await js(PAGE);

  if (!process.env.WALK) {   // WALK=1: 순회만
  console.log('== ② 녹음 재생 거부 (R08)');
  const r08 = await js(`(async () => { const t = ${t}, play = Audio.prototype.play, S = speechSynthesis, sp = S.speak; t.voice = true; t.play('tour'); t.cancelAuto(); t.stopVoice();
    Audio.prototype.play = () => Promise.reject(new Error('NotAllowedError')); const said = []; S.speak = (u) => { said.push(u.text); setTimeout(() => u.onerror?.({ error: 'not-allowed' }), 10); };
    t.go(1); const rec = !!t.audio; await new Promise((r) => setTimeout(r, 120)); const a = { rec, speaking: !!t.speaking, onSpoken: !!t.onSpoken, timer: !!t.autoT, said: said.length, step: t.step };
    await new Promise((r) => setTimeout(r, 1600)); const b = { step: t.step }; Audio.prototype.play = play; delete S.speak; if (S.speak !== sp) S.speak = sp; t.close(); t.voice = false; return { a, b }; })()`);
  check('녹음 play() 거부 → 같은 문장을 남성 OS 음성으로(없으면 읽지 않음) → 그것도 실패하면 읽는 시간 타이머', r08.a.rec && r08.a.said <= 1 && !r08.a.speaking && !r08.a.onSpoken && r08.a.timer, JSON.stringify(r08.a));
  check('…영영 기다리지 않고 다음 단계로', r08.b.step === 2, JSON.stringify(r08.b));

  console.log('== ③ 안내 중 단계 변경 · 리셋 (R06)');
  const modeBtn = (k) => `document.querySelector('#modeSeg [data-mode="${k}"]').click()`;
  await js(`(${t}.play('facos'), ${t}.cancelAuto(), ${t}.go(1), ${t}.cancelAuto(), 1)`); await wait(600);
  const r06a0 = await js(`__ts.snap()`);
  await js(modeBtn('traditional')); await wait(700);
  const r06a = await js(`({ ...__ts.snap(), open: ${t}.open, guard: ${t}.guard === undefined })`);
  check('FacOS 안내 중 레거시로: 안내를 멈추고 주제 메뉴 · 띄운 창 닫힘', r06a0.vis.includes('orchPanel') && r06a.step === -1 && r06a.open && r06a.mode === 'traditional' && /공장이 새로 시작돼서/.test(r06a.text) && !r06a.vis.includes('orchPanel'), `step=${r06a.step} mode=${r06a.mode} vis=${r06a.vis} · ${r06a.text.slice(0, 24)}`);
  await shot('r06-mode-change');
  await js(`(${t}.play('tour'), ${t}.cancelAuto(), 1)`);
  for (const i of [1, 2, 3, 4]) await js(`(${t}.go(${i}), ${t}.cancelAuto(), 1)`);
  await js(modeBtn('smart')); await wait(300);
  const r06b = await js(`__ts.snap()`);
  check('둘러보기 「단계 버튼」 단계에서 자동화로: 안내는 그대로', r06b.topic === 'tour' && r06b.step === 4 && r06b.mode === 'smart', `step=${r06b.step} mode=${r06b.mode}`);
  await js(`(${t}.go(5), ${t}.cancelAuto(), 1)`); await wait(1500);
  const r06c = await js(`__ts.snap()`);
  check('…다음 단계에서 토리가 스스로 피지컬AI로 (안내 유지)', r06c.topic === 'tour' && r06c.step === 5 && r06c.mode === 'dark', `step=${r06c.step} mode=${r06c.mode}`);
  await js(`(${t}.play('incident'), ${t}.cancelAuto(), ${t}.go(1), ${t}.cancelAuto(), 1)`); await wait(500);
  const ev0 = await js(`({ id: ${t}.ev?.id ?? null, label: ${t}.ev?.label ?? null, paused: ${t}.h.paused() })`);
  await js(`document.getElementById('btnReset').click()`); await wait(1500);
  const r06d = await js(`({ ...__ts.snap(), ev: ${t}.ev === undefined, events: window.__twin.sim.fieldEvents?.length ?? null })`);
  check('인시던트 안내 중 리셋: 새 공장에서 주제를 처음부터 다시 구성 (옛 이벤트 버림 · 멈춤 해제)', ev0.id != null && ev0.paused && r06d.topic === 'incident' && r06d.step === 0 && r06d.ev && !r06d.paused, `ev0=${JSON.stringify(ev0)} step=${r06d.step} paused=${r06d.paused}`);
  await js(`(${t}.close(), 1)`);

  console.log('== ④ 「이전」에서 창 · 상위망 복원 (R09)');
  await js(`(${t}.play('facos'), ${t}.cancelAuto(), 1)`);
  const stepTo = async (i, ms = 700) => { await js(`(${t}.go(${i}), ${t}.cancelAuto(), 1)`); await wait(ms); return js(`__ts.snap()`); };
  await stepTo(1); await stepTo(2); const f3 = await stepTo(3); const f4 = await stepTo(4);
  await js(`__ts.prev()`); await wait(700); const b3 = await js(`__ts.snap()`);
  check('순방향 3단계(결정 요청) fos 탭 · 4단계(가드레일) A2A 탭', f3.orchTab === 'fos' && f4.orchTab === 'a2a', `${f3.orchTab} · ${f4.orchTab}`);
  check('4 → 이전 3: fos 탭 (순방향과 같은 창)', b3.step === 3 && b3.orchTab === 'fos' && b3.vis.includes('orchPanel'), `tab=${b3.orchTab}`);
  await stepTo(4); const f5 = await stepTo(5); const f6 = await stepTo(6);
  await js(`__ts.prev()`); await wait(700); const b5 = await js(`__ts.snap()`);
  check('5단계 단절 · 6단계 복구', f5.online === false && f6.online === true, `${f5.online} · ${f6.online}`);
  check('6 → 이전 5: 「망을 끊었어요」 + 실제 망도 끊김', b5.step === 5 && b5.online === false && /망을 끊었어요/.test(b5.text), `online=${b5.online}`);
  await shot('r09-net-back');
  await js(`__ts.prev()`); await wait(400); const b4 = await js(`__ts.snap()`);
  check('5 → 이전 4: 망 복구', b4.step === 4 && b4.online === true);
  await js(`(${t}.close(), 1)`);
  check('접은 뒤 망 온라인', (await js(`window.__twin.sim.fos.online`)) === true);

  console.log('== ⑤ 인시던트 — 감지 전/후 「다음」 · 대기 시간 초과 (R07)');
  const kinds = ['intrusion', 'debris', 'leak', 'smoke'];
  for (const kind of kinds) {
    const full = KINDS.includes(kind);
    await js(`(${t}.h.quietEvent0 ??= ${t}.h.quietEvent, ${t}.h.quietEvent = () => { const ev = window.__twin.camWall.injectRandom('${kind}'); if (ev) ev.quiet = true; return ev ?? null; }, ${t}.play('incident'), ${t}.cancelAuto(), ${t}.go(1), ${t}.cancelAuto(), 1)`);
    await wait(1600);
    const e1 = await js(`({ type: ${t}.ev?.type ?? null, ...__ts.snap() })`);
    if (e1.type !== kind) { check(`[${kind}] 이벤트 생성`, false, `type=${e1.type}`); await js(`(${t}.close(), 1)`); continue; }
    await shot(`r07-${kind}-1-field`);
    // 감지를 막아 둔 채(시험) 「AI 감지」 단계로 — 대기 한도 3초
    await js(`(globalThis.__toriReadyMax = 3000, ${t}.go(2), ${t}.ev.quiet = true, 1)`);
    await js(`__ts.next()`); await wait(300);
    const g1 = await js(`({ det: !!${t}.ev.detected, ...__ts.snap(), pos: __ts.pos() })`);
    check(`[${kind}] 감지 전 「다음」: 넘어가지 않고 현장도 멈추지 않음`, g1.step === 2 && !g1.det && !g1.paused, `step=${g1.step} paused=${g1.paused}`);
    check(`[${kind}] …말풍선 · 음성 모두 「아직 감지되지 않았어요」`, /아직 감지되지 않았어요 — 감지되면/.test(g1.text) && /아직 감지되지 않았어요/.test(g1.spoken) && !/감지했어요/.test(g1.spoken), g1.spoken);
    await shot(`r07-${kind}-2-before-detect`);
    const to = await until(`__ts.pos().timedOut`, 8000);
    const g2 = await js(`({ det: !!${t}.ev.detected, ...__ts.snap(), label: document.querySelector('#tori [data-t="next"]').textContent })`);
    check(`[${kind}] 자동 넘김: 한도가 지나도 넘어가지 않고 시간 초과 안내 · 「다시 기다리기」`, !!to && g2.step === 2 && !g2.paused && /대기 시간 안에 일어나지 않았어요/.test(g2.text) && /다시 기다리기/.test(g2.label), `step=${g2.step} paused=${g2.paused} label=${g2.label}`);
    if (kind === kinds[0]) await shot(`r07-${kind}-3-timeout`);
    await js(`(delete globalThis.__toriReadyMax, __ts.next(), ${t}.ev.quiet = false, ${t}.ev.tq = window.__twin.sim.time, 1)`);   // 다시 기다리기 + 감지 풀기
    const det = await until(`!!${t}.ev?.detected`, 80000, 200);
    const at3 = det && await until(`${t}.step === 3 && ${t}.held && (${t}.cancelAuto(), true)`, 8000);   // 감지 로봇 단계에서 세워 두고 본다
    await wait(900);
    const g3 = await js(`({ by: ${t}.ev?.detectedBy ?? null, ...__ts.snap() })`);
    check(`[${kind}] 감지 뒤: 다음 단계로 넘어가 설명하는 동안 현장을 멈춤`, !!det && !!at3 && g3.step === 3 && g3.paused, `감지=${!!det} by=${g3.by} step=${g3.step} paused=${g3.paused}`);
    check(`[${kind}] …말풍선 · 음성 모두 「감지했어요」`, /감지했어요/.test(g3.text) && /감지했어요/.test(g3.spoken), g3.spoken?.slice(0, 40));
    await shot(`r07-${kind}-4-after-detect`);
    if (full && det) {   // 끝까지 자동으로: 오케스트레이터 → 출동 → 처리 → 해결 → 기록
      await js(`(${t}.scheduleAuto(${t}.cur(), false), 1)`);
      const t0 = Date.now(); let last = 3, timed = false; const seen = {};
      for (;;) { const p = await js(`__ts.pos()`); if (p.topic !== 'incident' || !p.open) break; if (p.timedOut) timed = true; if (p.step !== last) { last = p.step; seen[p.step] = Math.round((Date.now() - t0) / 1000); if ([4, 6, 8, 10].includes(p.step)) { await wait(800); await shot(`r07-${kind}-step${p.step}`); } if (p.step === 11) { await js(`(${t}.cancelAuto(), 1)`); break; } } if (Date.now() - t0 > 400000) break; await wait(150); }
      const e = await js(`({ cleared: !!${t}.ev?.cleared, ...__ts.snap() })`);
      check(`[${kind}] 끝까지 자동 진행 — 해결 · 기록 (시간 초과 없이)`, last === 11 && e.cleared && !timed, `마지막 단계 ${last} cleared=${e.cleared} 시간초과=${timed} 단계 진입(초) ${JSON.stringify(seen)}`);
    }
    await js(`(${t}.close(), ${t}.h.quietEvent = ${t}.h.quietEvent0, 1)`); await wait(300);
    check(`[${kind}] 접은 뒤 공장 재생 · 배속 원래대로`, (await js(`${t}.h.paused()`)) === false, `speed=${await js(`${t}.h.speed()`)}`);
    if (!full) await js(`document.getElementById('btnReset').click()`), await wait(1500);   // 남은 이벤트를 치우고 다음 종류로
  }

  }
  if (!QUICK) for (const lang of ['ko', 'en']) {
    console.log(lang === 'ko' ? '== ⑥ 한국어 전 주제 자동 순회 → 「이전」으로 되돌아가며 비교' : '== ⑦ 영어 전 주제 자동 순회');
    await js(`document.getElementById('btnReset').click()`); await wait(1500);
    if (lang === 'en') await js(`(${t}.menu(), document.querySelector('#tori [data-t="lang"]').click(), 1)`);
    const e0 = errs.length, diffs = [], slow = [], timedOut = []; let steps = 0, nonEn = 0, chain = true;
    await js(`(${t}.play('tour'), 1)`);
    for (let k = 0; k < ORDER.length; k++) {
      const topic = ORDER[k], fwd = []; let last = -1, n = 0, t0 = Date.now(), skipped = false;
      for (;;) {
        const p = await js(`__ts.pos()`);
        if (p.topic !== topic) { skipped = true; break; }   // 시간 초과로 건너뜀
        if (p.timedOut && !timedOut.includes(`${topic} ${p.step}`)) timedOut.push(`${topic} ${p.step}`);
        if (p.step !== last) {
          const dt = (Date.now() - t0) / 1000; if (last >= 0 && dt > 20) slow.push(`${topic} ${last}: ${Math.round(dt)}초`); t0 = Date.now(); last = p.step; n = p.n;
          if (lang === 'ko' && p.step === n - 1) await js(`(${t}.cancelAuto(), 1)`);   // 마지막 단계에서 세우고 되돌아가 본다
          await wait(700); const s = await js(`__ts.snap()`); if (s.step === p.step && s.topic === topic) { fwd[p.step] = s; steps++; if (lang === 'en' && s.ko) nonEn++; }
          if (p.step === n - 1) break;
        }
        if (Date.now() - t0 > 200000) { check(`[${lang}] ${topic} ${p.step}단계가 넘어가지 않음`, false); break; }
        await wait(100);
      }
      if (skipped) { check(`[${lang}] ${topic}: 시간 초과로 건너뜀`, false, timedOut.join(' · ')); continue; }
      if (lang === 'ko') {
        for (let i = n - 2; i >= 0; i--) { await js(`__ts.prev()`); await wait(700); const b = await js(`__ts.snap()`); if (!fwd[i]) { diffs.push(`${topic} ${i}: 순방향 기록 없음`); continue; } for (const d of diff(fwd[i], b)) diffs.push(`${topic} ${i} · ${d}`); }
        await js(`(${t}.go(${n - 1}), 1)`);   // 마지막 단계로 돌아가 자동 넘김을 잇는다
      }
      const next = ORDER[(k + 1) % ORDER.length];
      const moved = await until(`${t}.open && ${t}.topic === '${next}' && ${t}.step === 0`, k === ORDER.length - 1 ? 12000 : 8000);
      if (!moved) { chain = false; check(`[${lang}] ${topic} → ${next} 자동 이어짐`, false, JSON.stringify(await js(`__ts.pos()`))); await js(`(${t}.play('${next}'), 1)`); }
    }
    await js(`(${t}.close(), 1)`);
    check(`[${lang}] 10개 주제 ${steps}단계를 자동으로 끝까지 · 맺음말 뒤 둘러보기로 되풀이`, chain && steps >= 90, `${steps}단계`);
    check(`[${lang}] 대기 시간 초과 없음`, timedOut.length === 0, timedOut.join(' · '));
    check(`[${lang}] 콘솔 오류 0`, errs.length === e0, errs.slice(e0, e0 + 3).join(' | '));
    if (slow.length) console.log(`  (20초 넘게 머문 단계: ${slow.join(' · ')})`);
    if (lang === 'ko') { check('「이전」으로 돌아온 단계의 창 · 탭 · 강조 · 카메라 · 망 상태가 순방향과 같음', diffs.length === 0, `${diffs.length}건`); for (const d of diffs) console.log(`    다름: ${d}`); }
    else { check('[en] 말풍선에 한글 없음', nonEn === 0, `${nonEn}단계`); await js(`(${t}.menu(), document.querySelector('#tori [data-t="lang"]').click(), ${t}.close(), 1)`); }
  }

  const uniq = [...new Set(errs)];
  for (const e of uniq) console.log('  콘솔 오류:', e);
  check('콘솔 오류 없음', uniq.length === 0, `${uniq.length}건`);
  console.log(`결과: ${pass} PASS / ${fail} FAIL`);
  done(fail ? 1 : 0);
} catch (e) { console.error(e); done(1); } });
