// 운영자 지시 게이트 — 대화 기반에서 입력된 지시가 올바른지, 지금 수행할 수 있는지를 단계별로 판단한다.
// 해석 → 대상 확인 → 안전 규칙 → 실행 가능성 → 영향 평가 → 판정(수행/거절). 수행이면 기존 경로로 실행하고,
// 명령은 전송 → 셀 수신 확인 → 완료까지 추적한다. 거절이면 사유와 대안을 운영자에게 돌려준다.
import { COMMANDS } from './commands.js';
import { ZONE_MIXES } from './line.js';
import { ST_LABEL } from './sim.js';

export const GATE_STEPS = [
  { key: 'parse', label: '해석', sub: '무엇을 하라는가' },
  { key: 'target', label: '대상 확인', sub: '어디에' },
  { key: 'safety', label: '안전 규칙', sub: '인터록·정지 상태' },
  { key: 'feasible', label: '실행 가능성', sub: '지금 상태에서' },
  { key: 'impact', label: '영향 평가', sub: '생산·설비 영향' },
];

const describe = (a, sim) => {
  const K = sim.cmd;
  switch (a.type) {
    case 'command': return `${COMMANDS[a.code].label}${a.arg != null ? ` ${a.arg}%` : ''}${a.target ? ` → ${K.targetName(a.target)}` : ''}`;
    case 'mix': return `혼류 비율 ${ZONE_MIXES[a.mix]?.label ?? a.mix}`;
    case 'interval': return `투입 간격 ${a.seconds}초`;
    case 'expedite': return '긴급 조달 (안전재고·대체 발주)';
    case 'status': return `상태 질의 · ${a.target === 'all' || !a.target ? '라인 전체' : K.targetName(a.target)}`;
  }
  return `"${a.clause ?? ''}"`;
};

// 판정: 한 단계라도 fail이면 거절. warn은 수행하되 주의를 남긴다
export function evaluate(a, sim, agent) {
  const K = sim.cmd, checks = [];
  const add = (key, status, text) => checks.push({ key, status, text });
  const reject = (reason, alt) => ({ checks, verdict: 'reject', reason, alt, summary: describe(a, sim) });
  if (!a || a.type === 'unknown') {
    add('parse', 'fail', `"${a?.clause ?? ''}" — 알아들을 수 있는 공정 지시가 아닙니다`);
    return reject('지시를 해석하지 못함', '예: 포장셀 속도 75% · 도어트림 2:1 · e-axle 조립셀 예방정비');
  }
  add('parse', 'pass', `"${a.clause}" → ${describe(a, sim)}`);
  if (a.type === 'status') {
    add('target', 'pass', a.target && a.target !== 'all' ? K.targetName(a.target) : '라인 전체');
    for (const k of ['safety', 'feasible', 'impact']) add(k, 'pass', k === 'impact' ? '조회만 함 · 공정 변경 없음' : '해당 없음 (조회)');
    return { checks, verdict: 'answer', summary: describe(a, sim) };
  }

  if (a.type === 'command') {
    const C = COMMANDS[a.code];
    if (!a.target) { add('target', 'fail', '대상 셀이 지정되지 않음'); return reject('대상 셀 미지정', `예: "포장셀 ${C.label}"`); }
    const av = K.availability(a.code, a.target, a.arg);
    const scope = av.reason && /셀을 고르면|Zone 전체에서만|대상 셀 없음/.test(av.reason);
    if (scope) { add('target', 'fail', av.reason); return reject(av.reason, C.scopes.includes('all') ? '대상을 "전체"로' : '셀 이름을 함께 쓰세요'); }
    const st = a.target !== 'all' ? sim.processing.find((x) => x.id === a.target) : null;
    add('target', 'pass', st ? `${st.name} · 현재 ${ST_LABEL[st.state] ?? st.state}` : '정밀조립Zone 전체 (전 셀)');
    if (!av.ok && av.hard) { add('safety', 'fail', av.reason); return reject(av.reason, /리셋/.test(av.reason) ? '먼저 "비상정지 해제"' : /Zone 전체/.test(av.reason) ? '대상을 "전체"로 바꿔 지시' : null); }
    add('safety', 'pass', a.code === 'ESTOP' ? '비상정지는 항상 허용 (안전 우선)' : '인터록 통과 · 비상정지·보호정지 조건 충족');
    if (!av.ok) { add('feasible', 'fail', av.reason); return reject(av.reason === '전송 중…' ? '같은 명령이 이미 전송 중' : `변경 없음 — ${av.reason}`, null); }
    add('feasible', 'pass', `셀 컨트롤러가 받을 수 있는 상태 · 전송 경로 ${K.link.via} (약 ${a.code === 'ESTOP' ? K.link.estop : K.link.delay}초)`);
    // 영향 평가 (수행은 하되 주의)
    const n = a.target === 'all' ? K.cells().length : 1;
    const impact = {
      ESTOP: [`warn`, `${n}개 셀 즉시 정지·동력 차단 — 리셋 전까지 생산 중단`],
      SAFE_STOP: ['warn', `${n}개 셀 감속 정지 — 해제 전까지 생산 중단`],
      SAFE_SPEED: ['warn', `${n}개 셀 작업 속도 25% — 처리량 크게 감소`],
      EVACUATE: ['warn', 'AGV·휴머노이드·사족보행 작업 중단 — 자재 공급·부품 보충 지연'],
      CYCLE_STOP: ['warn', `${n}개 셀 현재 작업 후 정지 — 재개 전까지 생산 중단`],
      FEED_HOLD: ['warn', '신규 투입 중단 — 라인 안 재공을 다 쓰면 셀들이 자재대기'],
      MAINT: ['warn', `${st?.name ?? '셀'} 정비 동안 정지 (약 ${Math.round(sim.mode.pmTime || 90)}초) · 건강도 100% 회복`],
      RECALIB: ['pass', '4초 정지 · 공정 편차 초기화 (불량 감소)'],
      RESET: ['pass', '자가진단 5초 후 재가동'],
    }[a.code];
    if (a.code === 'SPEED') {
      const v = a.arg ?? 100;
      add('impact', v === 100 ? 'pass' : 'warn', v > 100 ? `사이클 ${v - 100}% 단축 — 마모 +40%, 고장 위험 증가` : v < 100 ? `처리량 약 ${100 - v}% 감소${a.target === 'all' ? ' · 투입·AMR 속도도 함께' : ''}` : '표준 속도');
    } else add('impact', impact?.[0] ?? 'pass', impact?.[1] ?? '영향 낮음');
    return { checks, verdict: 'approve', summary: describe(a, sim) };
  }

  if (a.type === 'mix') {
    if (!sim.zone) { add('target', 'fail', '정밀조립Zone 라인이 아님'); return reject('혼류 비율은 정밀조립Zone에서만', null); }
    add('target', 'pass', `자재 투입 스테이션 · 현재 ${ZONE_MIXES[sim.line.mix]?.label}`);
    add('safety', 'pass', '정지 명령과 무관 (투입 순서만 변경)');
    if (sim.line.mix === a.mix) { add('feasible', 'fail', `이미 ${ZONE_MIXES[a.mix].label}`); return reject('변경 없음 — 이미 같은 비율', null); }
    add('feasible', a.note ? 'warn' : 'pass', a.note ?? '지원하는 비율');
    add('impact', 'warn', `다음 투입부터 ${ZONE_MIXES[a.mix].label} · 라인 안 재공은 그대로${a.mix === 'dt' || a.mix === 'ea' ? ' · 다른 제품 라인은 비게 됨' : ''}`);
    return { checks, verdict: 'approve', summary: describe(a, sim) };
  }

  if (a.type === 'interval') {
    add('target', 'pass', `자재 투입 스테이션 · 현재 ${sim.releaseInterval.toFixed(1)}초`);
    add('safety', 'pass', '정지 명령과 무관');
    const s = Math.min(20, Math.max(5, a.seconds));
    add('feasible', s !== a.seconds ? 'warn' : 'pass', s !== a.seconds ? `허용 범위 5~20초 → ${s}초로 조정` : '허용 범위 5~20초');
    const bott = Math.max(...sim.processing.filter((x) => !x.standby).map((x) => x.def.cycle * sim.mode.cycleMul * (x.def.share ?? 1)));
    add('impact', s < bott * 0.95 ? 'warn' : s > bott * 1.3 ? 'warn' : 'pass', s < bott * 0.95 ? `병목 부하(${bott.toFixed(1)}초)보다 빨라 재공만 늘어남` : s > bott * 1.3 ? `병목보다 느려 생산량 약 ${Math.round((1 - bott / s) * 100)}% 감소` : `병목 부하 ${bott.toFixed(1)}초와 균형`);
    return { checks, verdict: 'approve', summary: describe({ ...a, seconds: s }, sim) };
  }

  if (a.type === 'expedite') {
    add('target', 'pass', '자재 창고 · 안전재고');
    add('safety', 'pass', '정지 명령과 무관');
    if (!sim.supplyDisrupted) { add('feasible', 'fail', '지금은 자재 공급 차질이 없음'); return reject('공급 차질이 없어 긴급 조달 불필요', null); }
    if (agent?.disruptHandled >= sim.supplyDisruptedUntil) { add('feasible', 'fail', '이번 차질에는 이미 긴급 조달함'); return reject('이미 긴급 조달함', null); }
    add('feasible', 'pass', `안전재고 ${sim.safetyStock}개 · 운송 AGV 확인`);
    add('impact', 'pass', '안전재고 투입 + 대체 발주로 차질 기간 단축');
    return { checks, verdict: 'approve', summary: describe(a, sim) };
  }
  add('parse', 'fail', '지원하지 않는 지시');
  return reject('지원하지 않는 지시', null);
}
