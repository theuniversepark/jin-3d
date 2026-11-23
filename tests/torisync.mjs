// 토리 안내와 화면 · 공장 동기화 (검수 R06 ~ R10) — DOM 없이 최소 가짜 DOM · 가짜 공장으로 상태 기계 · 타이머 · 가드를 확인한다. 실행: npm test
//   R06 공장이 새로 시작되면(단계 · 리셋) 안내 중단/재구성 · 예약 콜백 무효   R07 준비 전 「다음」 · 대기 시간 초과   R08 음성 재생 실패 → 진행
//   R09 「이전」에서 창 · 카메라 · 상위망 복원   R10 첫 클릭으로 음성이 시작되면 읽는 시간 타이머 취소
// 실제 화면(창 · 탭 · 카메라 · 전 주제 순회)은 npm run test:tori (tests/tori-sync.cjs · Electron)
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 DOM (토리가 쓰는 만큼만) ─────────────────
const mkEl = () => { const kids = new Map(), cls = new Set(); const e = { dataset: {}, style: { setProperty() {} }, textContent: '', innerHTML: '', hidden: false, offsetWidth: 0, on: {},
  classList: { add: (...a) => a.forEach((x) => cls.add(x)), remove: (...a) => a.forEach((x) => cls.delete(x)), toggle: (x, on) => ((on ?? !cls.has(x)) ? cls.add(x) : cls.delete(x)), contains: (x) => cls.has(x) },
  querySelector: (q) => { if (!kids.has(q)) kids.set(q, mkEl()); return kids.get(q); }, querySelectorAll: () => [], addEventListener: (k, f) => { e.on[k] = f; }, setAttribute() {}, appendChild() {}, closest: () => null };
  return e; };
const body = mkEl(), taps = [];
globalThis.document = { createElement: mkEl, body, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hidden: false };
globalThis.window = { speechSynthesis: { cancel() {} } };
globalThis.fetch = () => Promise.reject(new Error('no fetch'));
globalThis.addEventListener = (k, f) => { if (k === 'pointerdown') taps.push(f); };
const act = { hasBeenActive: true }; Object.defineProperty(globalThis, 'navigator', { value: { userActivation: act }, configurable: true, writable: true });
globalThis.__toriFast = true;   // 읽는 시간 0.2초 · 창 0.3초 · 음성 시작 한도 0.4초

const { Tori, voiceKey, speakText } = await import('../js/tori.js');
class T extends Tori { async initGfx() {} }   // 그리기는 빼고 안내 상태 기계만

// ── 가짜 음성 ─────────────────
const A = { mode: 'reject', made: [], ms: 0 };   // reject: play() 거부 · error: 파일 오류 · play: ms 뒤 끝남 · hang: 끝나지 않음
globalThis.Audio = class { constructor(src) { this.src = src; A.made.push(this); } pause() { this.paused = true; clearTimeout(this.t); }
  play() { if (A.mode === 'reject') return Promise.reject(new Error('NotAllowedError')); if (A.mode === 'error') { setTimeout(() => this.onerror?.(), 10); return new Promise(() => {}); }
    if (A.mode === 'play') { this.onplay?.(); this.t = setTimeout(() => this.onended?.(), A.ms); } return Promise.resolve(); } };
const S = { mode: 'none', said: [] };   // none: 음성 합성 없음 · ok: 20ms 뒤 시작 · 100ms 뒤 끝 · error: 오류 · mute: 시작도 끝도 알리지 않음
const MALE = [{ name: 'Microsoft InJoon Online (Natural)', lang: 'ko-KR' }, { name: 'Microsoft Andrew Online (Natural)', lang: 'en-US' }], FEMALE = [{ name: 'Yuna', lang: 'ko-KR' }, { name: 'Microsoft Heami', lang: 'ko-KR' }, { name: 'Samantha', lang: 'en-US' }, { name: 'Google US English', lang: 'en-US' }];
const synth = { cancel() {}, voices: MALE, getVoices: () => synth.voices, speak(u) { S.said.push(u.text); if (S.mode === 'ok') { setTimeout(() => u.onstart?.(), 20); setTimeout(() => u.onend?.(), 100); } else if (S.mode === 'error') setTimeout(() => u.onerror?.({ error: 'not-allowed' }), 10); } };
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
const setSynth = (m) => { S.mode = m; S.said.length = 0; window.speechSynthesis = m === 'none' ? { cancel() {} } : synth; };

// ── 가짜 공장 (main.js start()처럼 새 Simulation을 만들고 토리에 알린다) ─────────────────
function world(mode = 'dark') {
  const W = { mode, paused: false, speed: 5, calls: [], n: 0, ev: null };
  const mkSim = () => {
    const F = { online: true, q: 0, sent: [], ocs: new Map([['SORT', {}]]), orders: [], decisions: [], main: { reconcile: () => ({ good: 0 }) },
      setOnline(v) { const n = v && !this.online ? this.q : 0; this.online = v; if (v) this.q = 0; W.calls.push(['net', v, sim.id]); return n; },
      bus: { log: [], send: (from, to, type, o) => { const m = { from, to, type, status: to.startsWith('cell:') ? 'blocked' : 'ok', why: '바로 아래 계층만', msgId: `A2A-${F.sent.length + 1}`, ...o }; if (!F.online) F.q++; F.sent.push(m); return m; } },
      kpi: () => ({ queued: F.q, ocsOk: 0, ocsRej: 0, msgs: F.sent.length, blocked: 0, recon: { err: 0 } }) };
    const sim = { id: ++W.n, time: 0, fos: W.mode === 'dark' ? F : null, movers: [{ id: '휴머노이드-정비1', kind: 'humanoid', task: '정비', x: 1, z: 1 }], sec: { on: false }, cmd: { list: [] },
      impact: { advisor: { items: [], log: [], revert: (id) => W.calls.push(['revert', id, sim.id]), apply: () => true }, report: () => ({ rows: [] }) } };
    return sim;
  };
  W.sim = mkSim();
  W.start = (k) => { W.mode = k; W.sim = mkSim(); W.tori.simChanged(); };   // 사용자가 상단 단계 버튼 · 리셋을 누름 (토리의 setMode도 같은 길)
  W.h = { flyTo: (k) => W.calls.push(['fly', k]), camTo: (c) => W.calls.push(['cam', c]), openPanel: (p) => W.calls.push(['open', p.kind, p.tab ?? p.view ?? p.id ?? '']), closePanels: () => W.calls.push(['close']),
    qualityDrift: () => null, quietEvent: () => (W.ev = { id: 7, type: 'debris', label: '이물질', severity: 'warn', x: 3, z: 4, t0: 0, quiet: true, detected: false, sim: W.sim.id }),
    speed: (v) => { if (v == null) return W.speed; W.speed = v; return v; }, moverPos: (id) => (id === '휴머노이드-정비1' ? { x: 1, z: 1 } : null), pause: (v) => { W.paused = v; W.calls.push(['pause', v]); }, paused: () => W.paused,
    sim: () => W.sim, setMode: (k) => W.start(k), mode: () => W.mode, side() {} };
  W.tori = new T(W.h); W.tori.voice = false;
  W.since = (k, from = 0) => W.calls.slice(from).filter((c) => c[0] === k);
  return W;
}
const click = (t, k) => t.el.on.click({ target: { closest: () => ({ dataset: { t: k } }) } });
const hold = (t, i) => { t.go(i); t.cancelAuto(); };   // 그 단계로 가서 자동 넘김을 세워 둔다
const detect = (ev) => Object.assign(ev, { detected: true, detectedBy: '휴머노이드-정비1', tDetect: 2, conf: 0.9 });
const KO_STOP = '공장이 새로 시작돼서', KO_WAIT = '아직 감지되지 않았어요 — 감지되면 바로 넘어갈게요.';

console.log('== R06 — 안내 중 공장이 새로 시작됨 (단계 · 리셋)');
{
  const W = world(), t = W.tori; t.play('facos'); for (const i of [1, 2, 3, 4, 5]) hold(t, i);
  const F0 = W.sim.fos, n0 = W.calls.length;
  check('준비: FacOS 상위망 단절 단계 — 망이 끊겨 있음', t.step === 5 && F0.online === false && t.netOff === true);
  hold(t, 6); hold(t, 7);   // 셀 게이트: 0.3초 뒤 창을 열기로 예약됨
  const n1 = W.calls.length; W.start('traditional');   // 사용자가 레거시로
  check('다른 단계로 바꾸면 안내를 멈추고 주제 메뉴로', t.open && t.step === -1 && t.sayEl.textContent.startsWith(KO_STOP), `step=${t.step} · ${t.sayEl.textContent.slice(0, 30)}`);
  check('이전 공장에서 얻은 것(가드레일 · 망 상태)을 버림', t.guard === undefined && t.netOff === undefined && t.ev === undefined);
  await wait(500);
  check('예약된 창 열기 콜백은 무효', W.since('open', n1).length === 0, JSON.stringify(W.since('open', n1)));
  check('실시간 글 · 추적 · 멈춤 타이머가 남아 있지 않음', t.sayEl.textContent.startsWith(KO_STOP) && W.since('pause', n1).length === 0 && W.since('cam', n1).length === 0);
  t.close(); void n0;
}
{
  const W = world(), t = W.tori; t.play('facos'); for (const i of [1, 2, 3, 4, 5]) hold(t, i);
  const old = W.sim.id; W.start('smart');   // 망을 끊어 둔 채 사용자가 자동화로
  check('새 공장에 옛 공장의 되돌리기(망 복구 · 개선안 되돌림)를 걸지 않음', !W.calls.some((c) => (c[0] === 'net' || c[0] === 'revert') && c[2] !== old), JSON.stringify(W.calls.filter((c) => c[0] === 'net')));
  t.close();
}
{
  const W = world('traditional'), t = W.tori; t.play('facos'); t.cancelAuto();   // 토리가 주제 첫 단계에서 스스로 피지컬AI로
  check('토리가 단계 진행 중 스스로 바꾼 단계는 안내를 멈추지 않음', W.mode === 'dark' && t.topic === 'facos' && t.step === 0 && t.run === 1, `mode=${W.mode} step=${t.step} run=${t.run}`);
  hold(t, 1); await wait(400);
  check('…바꾼 뒤 새 공장에서 그대로 진행 (창 열림)', W.since('open').some((c) => c[1] === 'orch' && c[2] === 'fos'));
  t.close();
}
{
  const W = world(), t = W.tori; t.play('incident'); hold(t, 1); hold(t, 2);
  const ev0 = t.ev; W.speed === 1 || check('준비: 1배속', false);
  W.start('dark');   // 리셋 (같은 단계)
  t.cancelAuto();
  check('리셋(같은 단계)이면 새 공장에서 주제를 처음부터 다시 구성', t.topic === 'incident' && t.step === 0 && t.ev === undefined && ev0?.quiet === false, `step=${t.step}`);
  check('…배속은 다시 1배속 · 끝나면 돌아갈 배속 기억', W.speed === 1 && t.spd0 === 5, `speed=${W.speed} spd0=${t.spd0}`);
  hold(t, 1);
  check('…이벤트는 새 공장에서 다시 만든다', t.ev && t.ev !== ev0 && t.ev.sim === W.sim.id);
  t.close(); check('접으면 배속 원래대로', W.speed === 5);
}
{
  const W = world(), t = W.tori; t.play('tour'); for (const i of [1, 2, 3, 4]) hold(t, i);
  const said = t.sayEl.textContent, g = t.gen; W.start('smart');   // 「단계 버튼으로 바꿀 수 있어요」 단계에서 눌러 봄
  check('공장을 보지 않는 단계는 단계를 바꿔도 그대로 이어 감', t.topic === 'tour' && t.step === 4 && t.sayEl.textContent === said && t.gen === g);
  hold(t, 5);
  check('…다음 단계에서 토리가 피지컬AI로 되돌림', W.mode === 'dark' && t.step === 5);
  hold(t, 6); W.start('traditional');
  check('피지컬AI를 요구한 뒤의 단계에서 다른 단계로 바꾸면 멈춤', t.step === -1 && t.sayEl.textContent.startsWith(KO_STOP));
  t.play('facos'); t.cancelAuto(); W.start('traditional');   // 말만 하는 첫 단계(피지컬AI 요구)
  check('FacOS 첫 단계(말만 하는 단계)에서 레거시로 바꿔도 멈춤', t.step === -1 && t.sayEl.textContent.startsWith(KO_STOP), `step=${t.step}`);
  t.close();
}
{
  const W = world(), t = W.tori; t.play('incident'); hold(t, 1); hold(t, 2); detect(t.ev); hold(t, 3);
  check('준비: 감지 뒤 설명하는 동안 현장 멈춤', W.paused === true && t.held === true);
  const n = W.calls.length; W.start('traditional'); await wait(450);
  check('단계를 바꾸면 멈춤을 풀고, 예약된 멈춤 검사가 새 공장을 다시 멈추지 않음', W.paused === false && W.since('pause', n).every((c) => c[1] === false), JSON.stringify(W.since('pause', n)));
  t.close();
}

console.log('== R07 — 준비되지 않은 단계의 「다음」 · 대기 시간 초과');
{
  const W = world(), t = W.tori; t.play('incident'); hold(t, 1); hold(t, 2);
  const n = W.calls.length; click(t, 'next');   // (앞 단계 「현장」은 이벤트를 보여 주려 멈췄다가 이 단계에서 풀었다)
  check('감지 전 「다음」: 넘어가지 않음', t.step === 2, `step=${t.step}`);
  check('…현장을 멈추지 않음', W.paused === false && W.since('pause', n).length === 0);
  check('…말풍선 · 음성 모두 「아직 감지되지 않았어요」 (감지했다는 녹음 문장 아님)', t.sayEl.textContent.includes(KO_WAIT) && t.spokenText === KO_WAIT, t.spokenText);
  t.go(3); check('go()로 직접 넘겨도 같은 가드', t.step === 2);
  detect(t.ev); click(t, 'next'); t.cancelAuto();
  check('감지 뒤 「다음」: 넘어가고 그때 현장을 멈춤', t.step === 3 && W.paused === true);
  check('…감지 뒤에는 녹음 문장(이 로봇이 감지했어요)', /이 로봇이 감지했어요/.test(t.spokenText), t.spokenText.slice(0, 30));
  t.close();
}
{
  const W = world(), t = W.tori; t.play('incident'); hold(t, 1); hold(t, 2);
  Object.assign(t.ev, { cleared: true });   // 감지되기 전에 사라진 이벤트 — 다음 단계로는 갈 수 있다
  const n = W.calls.length; t.go(3); t.cancelAuto(); await wait(400);
  check('감지되지 않은 채 다음 단계에 들어와도 현장을 멈추지 않음', t.step === 3 && W.paused === false && W.since('pause', n).length === 0);
  check('…음성은 말풍선 글 그대로 (감지했다는 녹음 문장 아님)', t.spokenText === t.sayEl.textContent && /아직 감지되지 않았어요/.test(t.spokenText), t.spokenText);
  t.close();
}
{
  globalThis.__toriReadyMax = 700;
  const W = world(), t = W.tori; t.play('incident'); hold(t, 1); const n = W.calls.length; t.go(2);   // 자동 넘김을 그대로 둔다
  await wait(700 + 200 + 500 + 400);
  check('자동 넘김: 한도가 지나도 감지 전이면 넘어가지 않음 — 시간 초과 상태', t.step === 2 && t.timedOut === true, `step=${t.step} timedOut=${t.timedOut}`);
  check('…「완료」가 아니라 시간 초과로 알림 · 단추는 「다시 기다리기」', /대기 시간 안에 일어나지 않았어요/.test(t.sayEl.textContent) && t.el.querySelector('[data-t="next"]').textContent === '다시 기다리기 ↻' && /다시 기다리기/.test(t.btnEl.innerHTML) === false);
  check('…준비되지 않은 현장을 멈추지 않음', W.paused === false && W.since('pause', n).every((c) => c[1] === false));
  click(t, 'next');
  check('「다시 기다리기」: 그 단계에서 다시 기다림', t.step === 2 && t.timedOut === false && t.sayEl.textContent.includes(KO_WAIT));
  await wait(700 + 200 + 500 + 400);
  check('…또 한도를 넘기면 다시 시간 초과', t.step === 2 && t.timedOut === true);
  detect(t.ev); await wait(1100 + 200 + 1000 + 300);
  check('시간 초과 뒤 감지되면 이어서 진행', t.step === 3 && t.timedOut === false && W.paused === true, `step=${t.step}`);
  t.close();
  const W2 = world(), t2 = W2.tori; t2.play('incident'); hold(t2, 1); t2.go(2);
  let t0 = 0; for (let k = 0; k < 60 && !t2.timedOut; k++) await wait(50); const to = t2.timedOut; t0 = performance.now();
  await wait(4000); const still = t2.topic === 'incident' && t2.step === 2;   // 알림을 읽을 시간 + 5초 동안은 그 단계에
  for (let k = 0; k < 60 && t2.topic === 'incident'; k++) await wait(50); t2.cancelAuto(); const dt = performance.now() - t0;
  check('시간 초과 뒤 5초: 이 예시를 건너뛰어 다음 주제(제품 ID 추적)로', to === true && still && t2.topic === 'trace' && t2.step === 0 && dt >= 5000, `topic=${t2.topic} step=${t2.step} ${Math.round(dt)}ms`);
  check('…건너뛸 때 감지를 막아 둔 이벤트를 풀어 줌 · 배속 원래대로', W2.ev.quiet === false && W2.speed === 5);
  t2.close(); delete globalThis.__toriReadyMax;
}

console.log('== R08 — 음성 재생 실패에도 자동 넘김이 이어짐');
const voiced = async (prep, text) => { const W = world(), t = W.tori; await wait(5); t.voice = true; t.play('tour'); t.cancelAuto(); t.stopVoice(); prep?.(t); return { W, t }; };
const rec = (t, i, L = 'ko') => { const s = t.steps()[i], x = (L === 'en' && s.en) || s; (t.recorded[L] ??= new Set()).add(voiceKey(x.voice ?? x.say, L)); };
{
  A.mode = 'reject'; setSynth('none'); const { t } = await voiced(); rec(t, 1); t.go(1); await wait(30);
  check('녹음 play() 거부 (OS 음성도 없음): 영영 기다리지 않고 읽는 시간 타이머', t.speaking === false && !t.onSpoken && !!t.autoT, `speaking=${t.speaking} onSpoken=${!!t.onSpoken} autoT=${!!t.autoT}`);
  await wait(200 + 1000 + 300); t.cancelAuto();
  check('…읽는 시간 + 1초 뒤 다음 단계로', t.step === 2, `step=${t.step}`); t.close();
}
{
  A.mode = 'reject'; setSynth('ok'); const { t } = await voiced(); rec(t, 1); S.said.length = 0; t.go(1); await wait(60);
  check('녹음 play() 거부 (autoplay 차단): 같은 문장을 OS 음성으로', S.said.length === 1 && S.said[0] === speakText(t.steps()[1].say), `${S.said.length}건`);
  await wait(100 + 1000 + 300); t.cancelAuto();
  check('…OS 음성이 끝난 뒤 다음 단계로', t.step === 2, `step=${t.step}`); t.close();
}
{
  A.mode = 'reject'; setSynth('ok'); synth.voices = FEMALE; const { t } = await voiced(); rec(t, 1); S.said.length = 0; t.go(1); await wait(60);
  check('남성 OS 음성이 없으면(유나 · Heami뿐) 여성 음성으로 읽지 않고 읽는 시간 타이머', S.said.length === 0 && t.speaking === false && !t.onSpoken && !!t.autoT, `${S.said.length}건`);
  t.setLang('en'); S.said.length = 0; t.go(1); await wait(60);
  check('…영어도 남성 음성이 없으면 읽지 않음', S.said.length === 0, `${S.said.length}건`); t.setLang('ko'); t.cancelAuto(); t.close(); synth.voices = MALE;
}
{
  const f0 = globalThis.fetch, { MENU_SAY } = await import('../js/tori.js'); globalThis.fetch = () => new Promise((r) => setTimeout(() => r({ ok: true, json: async () => [voiceKey(MENU_SAY)] }), 40));   // 목록이 늦게 옴
  A.mode = 'play'; A.ms = 50; setSynth('ok'); const W = world(), t = W.tori; await wait(1); globalThis.fetch = f0; t.voice = true; A.made.length = 0; S.said.length = 0;
  t.menu(); const early = A.made.length + S.said.length; await wait(120);
  check('녹음 목록을 읽기 전에 말하면 OS 음성으로 넘기지 않고 목록을 기다렸다가 녹음을 튼다', early === 0 && A.made.length === 1 && S.said.length === 0, `early=${early} 녹음=${A.made.length} os=${S.said.length}`); t.cancelAuto(); t.close();
}
{
  A.mode = 'error'; setSynth('none'); const { t } = await voiced(); rec(t, 1); t.go(1); await wait(200 + 1000 + 400); t.cancelAuto();
  check('녹음 파일 오류: 읽는 시간 뒤 다음 단계로', t.step === 2, `step=${t.step}`); t.close();
}
{
  setSynth('error'); const { t } = await voiced(); t.go(1); await wait(40);   // 녹음 없는 문장 → OS 음성
  check('speech synthesis 오류: 끝난 것으로 치지 않고 읽는 시간 타이머', t.speaking === false && !t.onSpoken && !!t.autoT);
  await wait(200 + 1000 + 300); t.cancelAuto(); check('…다음 단계로', t.step === 2, `step=${t.step}`); t.close();
}
{
  setSynth('mute'); const { t } = await voiced(); t.go(1); await wait(300);
  check('OS 음성이 시작을 알리지 않는 동안은 기다림', t.step === 1 && t.speaking === true);
  await wait(400 + 200 + 1000 + 100); t.cancelAuto();
  check('…시작 한도를 넘기면 읽는 시간으로 넘어감', t.step === 2, `step=${t.step}`); t.close();
}
{
  A.mode = 'hang'; setSynth('none'); const { t } = await voiced(); rec(t, 1); t.go(1); await wait(300);
  check('준비: 끝나지 않는 음성 — 음성 끝을 기다리는 중', t.step === 1 && !!t.onSpoken);
  click(t, 'voice');   // 🔊 끔
  check('음성을 끄면 읽는 시간 타이머로', t.voice === false && !t.onSpoken && !!t.autoT);
  await wait(200 + 1000 + 300); t.cancelAuto(); check('…다음 단계로', t.step === 2, `step=${t.step}`); t.close();
}
{
  A.mode = 'hang'; setSynth('none'); const { t } = await voiced(); rec(t, 1); t.go(1); await wait(100);
  const a0 = t.audio; t.setLang('en');   // 영어 녹음 없음 · OS 음성 없음
  check('언어를 바꾸면 앞 언어 음성을 끊고 새 문장 기준으로', a0?.paused === true && t.audio === null && !t.onSpoken && !!t.autoT);
  await wait(200 + 1000 + 300); t.cancelAuto(); check('…다음 단계로', t.step === 2, `step=${t.step}`);
  t.setLang('ko'); t.close();
}
{
  A.mode = 'hang'; setSynth('none'); const { t } = await voiced(); rec(t, 1); rec(t, 2); t.go(1); const a1 = t.audio; t.go(2); const a2 = t.audio;
  a1.onerror?.(); a1.onended?.(); await wait(20);
  check('지난 단계 음성의 오류 · 종료는 지금 단계에 영향 없음 (세대)', t.audio === a2 && t.speaking === true && !!t.onSpoken && t.step === 2); t.close();
}

console.log('== R09 — 「이전」에서 창 · 카메라 · 상위망 상태 복원');
{
  setSynth('none'); const W = world(), t = W.tori; t.play('facos'); hold(t, 1); await wait(400);
  check('순방향 1단계(계층): fos 탭', W.since('open').at(-1)?.[2] === 'fos');
  const n = W.calls.length; hold(t, 2); hold(t, 3);
  check('순서대로 넘어온 단계는 이어받은 창을 그대로 (다시 열지 않음)', W.since('close', n).length === 0 && W.since('open', n).length === 0);
  hold(t, 4); await wait(400);
  check('4단계(가드레일): A2A 탭', W.since('open').at(-1)?.[2] === 'a2a');
  const n2 = W.calls.length; hold(t, 3);
  check('4 → 이전 3(결정 요청): fos 탭으로 되돌림 (순방향과 같은 창)', W.since('open', n2).at(-1)?.[2] === 'fos' && W.since('close', n2).length === 1, JSON.stringify(W.calls.slice(n2)));
  const F = W.sim.fos; hold(t, 4); hold(t, 5);
  check('5단계(단절): 망이 끊김 · 「끊었어요」', F.online === false && /망을 끊었어요/.test(t.sayEl.textContent));
  hold(t, 6);
  check('6단계(복구): 망이 이어짐 · 쌓인 1건 전달', F.online === true && t.flushed === 1 && /1건이 순서대로/.test(t.sayEl.textContent), `flushed=${t.flushed}`);
  hold(t, 5);
  check('6 → 이전 5: 실제 망도 다시 끊김 (말과 망이 같음)', F.online === false && /망을 끊었어요/.test(t.sayEl.textContent));
  hold(t, 4);
  check('5 → 이전 4: 망을 다시 이음', F.online === true);
  check('가드레일 시험 명령은 다시 보내지 않음 (이벤트 동작은 한 번)', F.sent.filter((m) => m.type === 'command').length === 1 && F.sent.filter((m) => m.type === 'status').length === 2);
  hold(t, 5); hold(t, 6); hold(t, 7); const n3 = W.calls.length; hold(t, 6);
  check('7(셀 게이트 · 라인 확대) → 이전 6: 카메라도 전체 보기로', W.since('fly', n3).at(-1)?.[1] === 'all', JSON.stringify(W.since('fly', n3)));
  t.play('facos'); t.cancelAuto(); const n4 = W.calls.length; hold(t, 1); hold(t, 2); await wait(50);   // 창이 열리기 전에(3초 전) 넘김
  check('창이 열리기 전에 넘겨도 이어받을 창은 열림', W.since('open', n4).at(-1)?.[2] === 'fos');
  const n5 = W.calls.length; hold(t, 1); hold(t, 0);
  check('창을 열기 전 단계(0)로 돌아오면 토리가 연 창을 닫음', W.since('close', n5).length >= 1 && t.panelOpen === false);
  hold(t, 5); t.menu();
  check('단절 단계에서 주제 메뉴로 나가면 망 복구', W.sim.fos.online === true);
  t.close();
}
{
  const W = world(), t = W.tori; t.play('tour'); t.cancelAuto(); const n = W.calls.length; for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) hold(t, i);
  check('창을 다루지 않는 단계는 사용자가 연 창을 닫지 않음', W.since('close', n).length === 0); t.close();
}

{
  const W = world(), t = W.tori; t.play('incident'); hold(t, 1); hold(t, 2); detect(t.ev); hold(t, 3); const c3 = W.since('cam').at(-1)[1];
  W.h.moverPos = () => ({ x: 30, z: 9 }); hold(t, 4); const n = W.calls.length; hold(t, 3);   // 감지 로봇이 그 사이 옮겨 감
  check('이전으로 돌아온 단계의 카메라는 그때 비춘 자리 그대로', JSON.stringify(W.since('cam', n).at(-1)?.[1]) === JSON.stringify(c3), JSON.stringify(W.since('cam', n).at(-1)?.[1])); t.close();
}

console.log('== R10 — 첫 클릭으로 음성이 시작되면 읽는 시간 타이머를 버림');
{
  act.hasBeenActive = false; taps.length = 0; A.mode = 'play'; A.ms = 1200; setSynth('none');
  const W = world(), t = W.tori; await wait(5); t.voice = true; t.play('tour'); t.cancelAuto(); rec(t, 1); t.go(1);
  check('첫 클릭 전: 소리는 미루고 읽는 시간으로 자동 넘김 예약', t.pending != null && t.speaking === false && !!t.autoT && taps.length === 1);
  await wait(100); act.hasBeenActive = true; taps[0](); await wait(20);   // 읽는 시간이 끝나기 전에 첫 클릭
  check('첫 클릭: 음성이 처음부터 시작 · 읽는 시간 타이머 취소 → 음성 끝 기준', t.speaking === true && !!t.onSpoken && !t.autoT, `speaking=${t.speaking} onSpoken=${!!t.onSpoken} autoT=${!!t.autoT}`);
  await wait(1500 - 120);
  check('음성이 끝나고 1초가 지나기 전에는 넘어가지 않음 (말을 끊지 않음)', t.step === 1, `step=${t.step}`);
  await wait(1100); t.cancelAuto();
  check('음성이 끝난 뒤 1초에 다음 단계로', t.step === 2, `step=${t.step}`);
  t.close(); act.hasBeenActive = true;
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
