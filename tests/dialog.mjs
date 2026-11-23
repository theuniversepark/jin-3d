// 정밀조립Zone 대화 지시 내장 해석기 검증 — Claude 없이도 흔한 바꿔 말하기(동의어 묶음)를 같은 조치로 바꾸는지,
// 비슷한 낱말이 다른 조치로 새지 않는지(비상 재고 ≠ 비상정지 · 셀 점검의 "더" ≠ 혼류). 실행: npm test
import { parseInstruction, DIALOG_EXAMPLES } from '../js/dialog.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const sim = { zone: true, processing: [['SORT', '부품분류셀'], ['DT_ASSY', '도어트림 조립셀'], ['DT_FAST', '도어트림 체결셀'], ['EA_ASSY', 'e-axle 조립셀'], ['EA_FAST', 'e-axle 체결셀'], ['PACK', '검사·포장셀']].map(([id, name]) => ({ id, name })) };
const show = (r) => `${r.actions.map((a) => [a.type, a.code, a.target, a.arg, a.mix, a.seconds].filter((v) => v != null).join(' ')).join(' ; ')}${r.unknown.length ? ` | 모름: ${r.unknown.join(' / ')}` : ''}`;
const is = (a, w) => Object.entries(w).every(([k, v]) => a[k] === v);
// want: 조치 목록(순서대로, 부분 일치) · unknown: 남아도 되는 모르는 문장 수
const T = (text, want, unknown = 0) => { const r = parseInstruction(text, sim); check(text, r.actions.length === want.length && want.every((w, k) => is(r.actions[k], w)) && r.unknown.length === unknown, show(r)); };

console.log('== 바꿔 말하기 (Claude 없이 내장 해석기로)');
T('포장하는 데 너무 빨리 돌리지 말고 반쯤 속도로', [{ type: 'command', code: 'SPEED', target: 'PACK', arg: 50 }]);
T('검사 포장 라인 속도 좀 낮춰서 60퍼로', [{ type: 'command', code: 'SPEED', target: 'PACK', arg: 60 }]);
T('라인 맨 앞에서 부품 나누는 셀 손 좀 봐줘', [{ code: 'MAINT', target: 'SORT' }]);
T('맨 처음 분류하는 로봇 셀 고장난 것 같아 봐줄래', [{ code: 'MAINT', target: 'SORT' }]);
T('액슬 위주로 가자, 도어트림은 절반만', [{ type: 'mix', mix: '1:2' }]);
T('이번엔 도어 트림 비중을 높여줘', [{ type: 'mix', mix: '2:1' }]);
T('급하게 비상 멈춤!', [{ code: 'ESTOP', target: 'all' }]);
T('위험해! 다 세워!', [{ code: 'ESTOP', target: 'all' }]);
T('재료 공급 좀 쉬었다가 하자', [{ code: 'FEED_HOLD' }]);
T('소재 공급 일단 홀드', [{ code: 'FEED_HOLD' }]);
T('원자재 넣는 간격 12초로 늘려', [{ type: 'interval', seconds: 12 }]);
T('자재 들어가는 주기 8초로', [{ type: 'interval', seconds: 8 }]);
T('투입 간격 너무 짧아, 15초로', [{ type: 'interval', seconds: 15 }]);
T('공급 문제 빨리 해결해, 비상 재고 풀어', [{ type: 'expedite' }]);
T('자재가 안 들어와, 급히 대체 발주 해', [{ type: 'expedite' }], 1);
T('대피 상황이야, 모두 나가', [{ code: 'EVACUATE' }]);
T('연기 난다 사람들 대피시켜', [{ code: 'EVACUATE' }]);
T('e-axle 체결셀 사이클 원래대로', [{ code: 'SPEED', target: 'EA_FAST', arg: 100 }]);
T('e-axle 조립셀 너무 혹사시키지 말고 보통으로', [{ code: 'SPEED', target: 'EA_ASSY', arg: 100 }]);
T('도어트림 체결하는 데 공정 다시 맞춰줘', [{ code: 'RECALIB', target: 'DT_FAST' }]);
T('e-axle 체결 쪽 토크 정밀도 다시 잡아줘', [{ code: 'RECALIB', target: 'EA_FAST' }]);
T('포장셀 좀 살살 돌려', [{ code: 'SPEED', target: 'PACK', arg: 75 }]);
T('도어트림 조립셀 기계 이상한 것 같아', [{ code: 'MAINT', target: 'DT_ASSY' }]);
T('자재 넣는 텀을 10초로', [{ type: 'interval', seconds: 10 }]);
T('부품 나누는 곳 지금 어때', [{ type: 'status', target: 'SORT' }]);
T('검사포장 쪽 요즘 괜찮아?', [{ type: 'status', target: 'PACK' }]);

console.log('== 기존 예시 · 다른 조치로 새지 않는지');
const ex = DIALOG_EXAMPLES.map((t) => parseInstruction(t, sim));
check('기존 예시 6개 모두 해석', ex.every((r) => r.actions.length && !r.unknown.length), ex.map(show).join(' / '));
T('비상 재고 풀어', [{ type: 'expedite' }]);
T('비상정지 해제', [{ code: 'RESET' }]);
T('도어트림 체결셀 점검 더 자주', [{ code: 'MAINT', target: 'DT_FAST' }]);
T('도어트림 조립셀 속도 더 빠르게', [{ code: 'SPEED', target: 'DT_ASSY', arg: 110 }]);
T('투입 재개', [{ code: 'FEED_RESUME' }]);
T('15초로', [], 1);
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
