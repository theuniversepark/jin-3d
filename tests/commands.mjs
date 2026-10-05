// 명령 규칙 검증 — 콘솔 가용성(쓸 수 없는 이유), 보호정지·감속 해제, 현장 이벤트 자동 명령, 명령 메시지 순서. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const mk = (mode) => { const s = new Simulation(mode, 3, { line: zoneLine(), quiet: false }); const ag = new FactoryAgent(s); const run = (sec) => { for (let t = 0; t < sec - 1e-9; t += 0.05) { s.step(0.05); ag.update(0.05); s.events = []; } }; return { s, run }; };
{ const { s, run } = mk('dark'); run(200); const K = s.cmd, DT = 'DT_ASSY';
  console.log('== 콘솔 가용성 규칙');
  check('평상시 비상정지 가능', K.availability('ESTOP', 'all').ok);
  check('평상시 리셋 불가(이유 표시)', !K.availability('RESET', 'all').ok && K.availability('RESET', 'all').reason === '비상정지 상태가 아닙니다');
  check('Zone 전체에 재보정 불가 → 셀 선택 안내', K.availability('RECALIB', 'all').reason === '셀을 고르면 쓸 수 있습니다');
  check('셀에 대피 불가 → Zone 전체 안내', K.availability('EVACUATE', DT).reason === 'Zone 전체에서만 쓸 수 있습니다');
  K.issue('ESTOP', 'all'); check('전송 중 같은 명령 중복 막음', K.availability('ESTOP', 'all').reason === '전송 중…'); run(1);
  check('비상정지 중 → 리셋만 가능', K.availability('RESET', 'all').ok && ['SAFE_STOP', 'CYCLE_STOP', 'FEED_HOLD'].every((c) => K.availability(c, 'all').reason === '비상정지 중 — 먼저 리셋'));
  check('비상정지 중 셀 리셋 → Zone 전체 안내', K.availability('RESET', DT).reason.startsWith('Zone 전체 비상정지 중'));
  K.issue('RESET', 'all'); run(1); check('자가진단 중 → 잠시 후', K.availability('CYCLE_STOP', 'all').reason === '자가진단 중 — 잠시 후'); run(6);
  console.log('== 보호정지·감속');
  K.issue('SAFE_STOP', 'all'); run(1); const r = K.issue('RESUME', DT); run(1);
  check('Zone 보호정지 중 셀 재개 거부', r.state === 'rejected' && ['PSTOP', 'MAINT'].includes(s.processing.find((x) => x.id === DT).state), `${r.note} · 셀 ${s.processing.find((x) => x.id === DT).state}`);   // 정비·자율 보정 중인 셀은 정비 상태 유지
  K.issue('RESUME', 'all'); run(2); check('Zone 재개 → 전 셀 해제', s.processing.every((x) => x.state !== 'PSTOP'));
  K.issue('SAFE_SPEED', 'all'); run(1); check('Zone 감속 → 이동 속도 25%', K.lineSpeed === 0.25);
  K.issue('SPEED', 'all', 50); run(1); check('감속 + 속도 50% → 12.5%', Math.abs(K.lineSpeed - 0.125) < 1e-9);
  K.issue('SAFE_SPEED_OFF', 'all'); run(1); check('감속 해제 → 속도 50% 유지', K.lineSpeed === 0.5);
  K.issue('SPEED', 'all', 100); run(1); check('속도 100% 복귀', K.lineSpeed === 1 && s.processing.every((x) => K.speedOf(x) === 1));
  console.log('== 운전 재개(이전 구조): 보호정지·사이클 정지·감속·대피 한 번에 해제');
  K.issue('SAFE_STOP', 'all'); K.issue('SAFE_SPEED', 'all'); K.issue('EVACUATE', 'all'); run(2); K.issue('CYCLE_STOP', 'EA_FAST'); run(2);
  K.issue('RESUME', 'all'); run(2);
  check('Zone 재개 → 보호정지·감속·대피·사이클 정지 해제', !K.pstopAll && !K.lineSafe && !K.evac && s.processing.every((x) => !x.cmd?.hold && !x.cmd?.safe), `p${K.pstopAll} s${K.lineSafe} e${K.evac}`);
  K.issue('SAFE_SPEED', DT); run(1); K.issue('RESUME', DT); run(1); check('셀 재개 → 그 셀 감속 해제', !s.processing.find((x) => x.id === DT).cmd.safe);
  const vis = Object.entries((await import('../js/commands.js')).COMMANDS).filter(([, C]) => !C.hidden).map(([k]) => k).join(',');
  check('콘솔 버튼 구성(이전 구조)', vis === 'ESTOP,SAFE_STOP,SAFE_SPEED,EVACUATE,RESET,CYCLE_STOP,RESUME,SPEED,FEED_HOLD,FEED_RESUME,RECALIB,MAINT', vis);
  console.log('== 현장 이벤트 자동 명령');
  const st = s.processing.find((x) => x.id === DT);
  const ev = s.injectFieldEvent('intrusion', st.x, st.z + 4); run(0.5); s.detectFieldEvent(ev, '사족보행-1', 0.9); run(4);
  check('사람 진입 → 주변 셀 감속', st.cmd?.safe === true);
  run(70); check('이탈 후 감속 해제·인시던트 종료', !st.cmd.safe && ev.inc.status === 'resolved', ev.inc.status);
  console.log('== 명령 메시지');
  const states = K.out.filter((x) => x.c.code === 'ESTOP').map((x) => x.state).join('>');
  check('비상정지 메시지 순서', states === 'sent>ack>exec>done', states);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);

process.exitCode = fail ? 1 : 0;
