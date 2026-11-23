// 현장 로봇 업링크 — 감지한 로봇 · 대응 로봇 · 추적 사족보행이 서버(UNS {존}/_field/{로봇}/…)로 보내는 기록
//   ① 감지: detect 바로 · 영상 클립(clip) 10초 뒤 ② 대응 로봇: ack 한 번 · status 2초마다(retain) · 끝나면 done
//   ③ 사람 진입: 추적 사족보행 status에 진입자 거리 · 행동 · 동선, 행동 보고마다 track ④ UNS 트리에 같은 토픽
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { UnsNamespace, fieldTopic } from '../js/uns.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const mk = () => { const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), uns = new UnsNamespace(s); const out = [];
  const run = (sec, f) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); if (Math.round(s.time * 10) % 20 === 0) out.push(...uns.collect()); if (f?.()) return true; } }; return { s, uns, out, run }; };

// 1) 청소 대응 (debris)
{
  const { s, uns, out, run } = mk(); run(40);
  const ev = s.injectFieldEvent('debris', 4, 8.4); s.detectFieldEvent(ev, 'AMR-01', 0.91, { type: 'mover', id: 'AMR-01' });
  run(400, () => ev.cleared); run(3); out.push(...uns.collect());
  const tx = ev.tx ?? [], k = (r, kind) => tx.filter((m) => m.role === r && m.kind === kind);
  check('감지 로봇이 detect를 바로 보낸다', k('detect', 'detect').length === 1 && k('detect', 'detect')[0].t === ev.tDetect && k('detect', 'detect')[0].body.conf === 0.91);
  check('감지 영상 클립(앞뒤 10초)을 10초 뒤 보낸다', k('detect', 'clip').length === 1 && Math.abs(k('detect', 'clip')[0].t - ev.tDetect - 10) < 0.2, `${k('detect', 'clip')[0]?.body.bytes} B`);
  const st = k('respond', 'status');
  check('대응 로봇이 배정 응답(ack)을 한 번 보낸다', k('respond', 'ack').length === 1 && k('respond', 'ack')[0].robot === ev.responder);
  const gaps = st.slice(1).map((m, i) => m.t - st[i].t);
  check('대응 로봇 상태를 2초마다 보낸다', st.length >= 5 && gaps.every((g) => g > 1.9 && g < 2.3), `${st.length}건`);
  check('대응 로봇 상태에 위치 · 배터리 · 현장까지 거리', st.every((m) => Number.isFinite(m.body.x) && Number.isFinite(m.body.battery) && Number.isFinite(m.body.distToEvent)) && st.at(-1).body.distToEvent < st[0].body.distToEvent);
  check('해결되면 done', k('respond', 'done').length === 1);
  const tp = new Set(out.map((m) => m.topic));
  check('UNS 트리에 _field 토픽 (detect · clip · ack · status · done)', ['detect', 'clip', 'ack', 'status', 'done'].every((kind) => [...tp].some((t) => t.includes('/_field/') && t.endsWith('/' + kind))), [...tp].filter((t) => t.includes('_field')).join(' '));
  const stT = fieldTopic(st[0]);
  check('상태 토픽은 retain · 감지는 retain 아님', uns.tree.get(stT)?.retain === true && out.find((m) => m.topic.endsWith('/detect'))?.retain === false, stT);
}
// 2) 사람 진입 — 추적 사족보행
{
  let ok = 0, n = 0, trackOk = 0, detail = 0;
  for (const [x, z] of [[-10, 3], [8, -4], [0, 12]]) {
    const { s, run } = mk(); run(40);
    const ev = s.injectFieldEvent('intrusion', x, z); s.detectFieldEvent(ev, 'test', 0.9);
    run(400, () => ev.cleared); run(3); n++;
    const tx = ev.tx ?? [], st = tx.filter((m) => m.role === 'escort' && m.kind === 'status'), tr = tx.filter((m) => m.kind === 'track');
    if (st.length && st.every((m) => m.robot === ev.escort.q.id)) ok++;
    if (st.some((m) => m.body.phase === 'follow' && m.body.person && Number.isFinite(m.body.gap) && m.body.keepGap === 4 && m.body.person.exit)) detail++;
    if (ev.escort.phase !== 'follow' || (tr.length >= 1 && tr.every((m) => m.body.gap >= 3.5))) trackOk++;   // 합류가 늦으면 남은 행동이 적다 — 1건 이상 · 거리 3.5m 이상
    if (!tx.some((m) => m.role === 'escort' && m.kind === 'done' && m.body.walked > 0)) ok -= 1;
  }
  check('추적 사족보행이 상태 · 종료(done)를 보낸다', ok === n, `${ok}/${n}`);
  check('추적 상태에 진입자 거리 · 행동 · 동선 · 출구', detail >= 2, `${detail}/${n}`);
  check('합류 뒤 행동 보고마다 track (1건 이상 · 거리 3.5m 이상)', trackOk === n, `${trackOk}/${n}`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
