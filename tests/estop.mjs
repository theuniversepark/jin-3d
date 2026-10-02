// 비상정지 검증 — 레거시·자동화·피지컬AI 3단계에서 전체·셀 비상정지, 리셋 거부 규칙, 정지 중 수리·보정 잠금, 자가진단 후 재가동을 확인한다.
// 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0; const fails = [];
const check = (mode, name, ok, info = '') => { if (ok) pass++; else { fail++; fails.push(`${mode} · ${name} ${info}`); } console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const mk = (mode, seed = 7) => { const s = new Simulation(mode, seed, { line: zoneLine(), quiet: false }); const ag = new FactoryAgent(s); const run = (sec) => { for (let t = 0; t < sec - 1e-9; t += 0.05) { s.step(0.05); ag.update(0.05); s.events = []; } }; return { s, ag, run }; };
const movers = (s) => [...s.vehicles, ...s.forklifts, ...s.carriers, ...s.techs, ...s.helpers, ...s.quads];
const snap = (s) => JSON.stringify({ m: movers(s).map((m) => [m.x.toFixed(4), m.z.toFixed(4)]), p: s.processing.map((st) => (st.progress ?? 0).toFixed(5)), conv: s.conveyors.map((c) => c.items.map((i) => i.s.toFixed(4))), ammr: s.processing.map((st) => st.ammr?.map((u) => [u.pos, u.phase, u.bin]) ?? null), rep: s.processing.map((st) => (st.repairRemaining ?? 0).toFixed(3)), rel: s.stats.released, raw: s.rawStock });
const LAT = { traditional: 3, smart: 0.3, dark: 0.05 };
for (const mode of ['traditional', 'smart', 'dark']) {
  console.log(`== ${mode}`);
  // 1) 전체 비상정지: 전송 지연 → 전 셀 정지
  { const { s, run } = mk(mode); run(240);
    const c = s.cmd.issue('ESTOP', 'all'); const t0 = s.time; let tStop = null;
    for (let k = 0; k < 200 && tStop == null; k++) { run(0.05); if (s.processing.every((st) => st.state === 'ESTOP' || st.state === 'DOWN' || st.state === 'MAINT') && s.cmd.estopAll) tStop = s.time - t0; }
    check(mode, '전체 정지까지 지연', tStop != null && Math.abs(tStop - LAT[mode]) < 0.11, `${tStop?.toFixed(2)}s (기대 ${LAT[mode]}s)`);
    check(mode, '명령 상태 전송→ACK→실행→완료', c.history.map((h) => h.state).join('>') === 'sent>ack>exec>done', c.history.map((h) => h.state).join('>'));
    const a = snap(s); run(30); const b = snap(s);
    check(mode, '30초 동안 이동체·컨베이어·셀 진행·AMMR·투입 모두 정지', a === b);
    const src = s.stations[0].state; check(mode, '투입 스테이션 비상정지 표시', src === 'ESTOP', src);
    // 2) 리셋 없이 재개 불가
    s.cmd.issue('RESUME', 'all'); run(15); check(mode, '전체 재개 명령으로 풀리지 않음', s.cmd.estopAll && snap(s) === b);
    const r = s.cmd.issue('RESUME', s.processing[1].id); run(15); check(mode, '셀 재개 명령 거부', r.state === 'rejected', r.state);
    const sp = s.cmd.issue('SPEED', s.processing[1].id, 50); run(15); check(mode, '셀 속도 명령 거부', sp.state === 'rejected', sp.state);
    // 3) 전체 정지 중 셀 단위 리셋은 거부되어야 한다
    const cr = s.cmd.issue('RESET', s.processing[2].id); run(15);
    check(mode, '전체 비상정지 중 셀 리셋 거부', cr.state === 'rejected' && s.processing[2].state === 'ESTOP', `${cr.state} · ${s.processing[2].state}`);
    // 4) 비상정지 중 자율 보정·예지정비가 끼어들지 않음
    s.processing[3].drift = 0.5; s.processing[3].health = 30; run(30);
    check(mode, '비상정지 중 셀 자율 보정·정비 시작 안 함', s.processing[3].state === 'ESTOP', s.processing[3].state);
    // 5) 리셋 → 자가진단 → 재가동 → 생산 재개
    const rs = s.cmd.issue('RESET', 'all'); let sawCheck = false, tRun = null; const t1 = s.time, rel0 = s.stats.released;
    for (let k = 0; k < 1200 && tRun == null; k++) { run(0.05); if (s.processing.some((st) => st.state === 'CHECK')) sawCheck = true; if (!s.cmd.estopAll && s.processing.every((st) => !['ESTOP', 'CHECK'].includes(st.state))) tRun = s.time - t1; }
    check(mode, '리셋 후 자가진단 거쳐 재가동', sawCheck && tRun != null && Math.abs(tRun - (LAT[mode] === 3 ? 8 : LAT[mode] === 0.3 ? 0.6 : 0.2) - 5) < 0.3, `${tRun?.toFixed(2)}s`);
    run(90); check(mode, '재가동 후 90초 안에 투입·이동 재개', s.stats.released > rel0 && snap(s) !== b, `투입 +${s.stats.released - rel0}`);
    check(mode, '리셋 명령 완료 보고', rs.state === 'done', rs.state);
  }
  // 6) 고장 수리 중 비상정지: 수리도 멈추고, 리셋 후 이어서
  { const { s, run } = mk(mode); run(200);
    const st = s.processing[2]; s.injectFault(st); for (let k = 0; k < 600 && !st.techOnSite; k++) run(0.5);
    run(2); s.cmd.issue('ESTOP', 'all'); run(4); const r0 = st.repairRemaining; run(20);
    check(mode, '수리 중 비상정지 → 수리 진행 멈춤', st.techOnSite ? Math.abs(st.repairRemaining - r0) < 1e-6 : true, `${r0?.toFixed(1)} → ${st.repairRemaining?.toFixed(1)} (${st.state})`);
    check(mode, '고장 셀은 고장 상태 유지', st.state === 'DOWN', st.state);
    s.cmd.issue('RESET', 'all'); run(400); check(mode, '리셋 후 수리 완료', st.state !== 'DOWN', st.state);
  }
  // 7) 셀 단위 비상정지: 그 셀만 정지, 나머지는 가동, 리셋하면 복귀
  { const { s, run } = mk(mode); run(240);
    const st = s.processing.find((x) => x.id === 'DT_ASSY'), other = s.processing.find((x) => x.id === 'EA_ASSY');
    s.cmd.issue('ESTOP', st.id); run(5); const p0 = st.progress, o0 = other.c.processed; run(60);
    check(mode, '셀 비상정지: 대상 셀 진행 정지', st.state === 'ESTOP' && st.progress === p0, `${st.state}`);
    check(mode, '셀 비상정지: 다른 라인 셀은 계속 생산', other.c.processed > o0, `+${other.c.processed - o0}`);
    check(mode, '셀 비상정지: 이동로봇은 계속 움직임', !s.cmd.estopAll);
    const bad = s.cmd.issue('CYCLE_STOP', st.id); run(10); check(mode, '비상정지 셀에 제어 명령 거부', bad.state === 'rejected');
    s.cmd.issue('RESET', st.id); run(30); check(mode, '셀 리셋 후 재가동', !['ESTOP', 'CHECK'].includes(st.state), st.state);
    const dup = s.cmd.issue('RESET', st.id); run(10); check(mode, '정지 아닐 때 리셋 → 조치 없음 완료', dup.state === 'done' || dup.state === 'rejected', dup.state);
  }
  // 8) 비상정지 두 번, 리셋 중 비상정지
  { const { s, run } = mk(mode); run(200);
    s.cmd.issue('ESTOP', 'all'); s.cmd.issue('ESTOP', 'all'); run(10);
    s.cmd.issue('RESET', 'all'); run(LAT[mode] === 3 ? 10 : 2); s.cmd.issue('ESTOP', 'all'); run(10);
    check(mode, '자가진단 중 비상정지 → 다시 정지', s.cmd.estopAll && s.processing.every((st) => ['ESTOP', 'DOWN', 'MAINT'].includes(st.state)), s.processing.map((x) => x.state).join(','));
    s.cmd.issue('RESET', 'all'); run(30); check(mode, '다시 리셋 → 재가동', !s.cmd.estopAll && s.processing.every((st) => !['ESTOP', 'CHECK'].includes(st.state)));
  }
  // 9) 대피 중 비상정지 → 리셋 후에도 대피 유지(별도 해제 필요)
  { const { s, run } = mk(mode); run(200);
    s.cmd.issue('EVACUATE', 'all'); run(20); s.cmd.issue('ESTOP', 'all'); run(10); s.cmd.issue('RESET', 'all'); run(30);
    check(mode, '대피는 리셋으로 풀리지 않음', s.cmd.evac);
  }
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`); for (const f of fails) console.log('  FAIL', f);

process.exitCode = fail ? 1 : 0;
