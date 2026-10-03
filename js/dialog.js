// 대화 기반 운영 — 추론 기반 에이전트가 공장을 계속 운영하는 위에, 입력창의 운영자 지시를 해석해 공정에 반영한다.
// 1) 내장 해석기: 한국어 지시(셀·대상·동작·수치)를 문장 단위로 나눠 조치로 바꾼다 — 서버·API 키 없이 즉시 동작
// 2) 내장 해석기로 알 수 없는 문장은 Claude가 연결되어 있으면 Claude가 해석해 같은 조치로 돌려준다 (js/llm.js)
// 조치는 모두 기존 경로로 실행된다: 상위 명령(js/commands.js), 혼류 비율, 투입 간격, 긴급 조달, 상태 질의.
import { COMMANDS } from './commands.js';
import { ZONE_MIXES } from './line.js';

// 정밀조립Zone 셀 별칭 (다른 라인은 설비 이름으로 찾는다)
const CELL_ALIASES = [
  [/부품\s*분류|분류\s*셀|소팅/, 'SORT'],
  [/도어\s*트림\s*(조립)/, 'DT_ASSY'],
  [/도어\s*트림\s*(체결|스크류|나사)/, 'DT_FAST'],
  [/(e-?\s*axle|이\s*액슬|이\s*엑슬)\s*(조립)/i, 'EA_ASSY'],
  [/(e-?\s*axle|이\s*액슬|이\s*엑슬)\s*(체결)/i, 'EA_FAST'],
  [/포장/, 'PACK'],
];
const ALL_RE = /전체|모든|모두|공장|라인\s*전|zone|존\s*전체|전\s*셀/i;
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

export const DIALOG_EXAMPLES = ['포장셀 속도 75%', '도어트림 2:1로 생산', 'e-axle 조립셀 예방정비', '투입 정지', '전체 보호정지', '부품분류셀 상태 어때?'];

// 문장에서 대상 셀(id) 또는 'all'을 찾는다
function findTarget(text, sim) {
  if (sim.zone) for (const [re, id] of CELL_ALIASES) if (re.test(text) && sim.processing.some((st) => st.id === id)) return id;
  const t = norm(text);
  const hit = sim.processing.filter((st) => !st.standby).find((st) => t.includes(norm(st.name.replace(/\s*\(.*\)$/, ''))) || t.includes(norm(st.name.replace(/셀$/, ''))));
  if (hit) return hit.id;
  return ALL_RE.test(text) ? 'all' : null;
}

// 문장 하나 → 조치 목록
function parseClause(text, sim) {
  const target = findTarget(text, sim), out = [];
  const cmd = (code, def = 'all', arg = null) => out.push({ type: 'command', code, target: target ?? def, arg });
  const pct = text.match(/(\d{2,3})\s*(%|퍼센트|프로)/);
  // 혼류 비율 (제품 이름이 들어간 비율·전용 생산)
  const ratio = text.match(/(\d)\s*(?::|대|to)\s*(\d)/i);
  if (sim.zone && (ratio && /비율|혼류|도어\s*트림|e-?\s*axle|이\s*액슬|생산/i.test(text))) {
    let [a, b] = [+ratio[1], +ratio[2]];
    if (/(e-?\s*axle|이\s*액슬).*(도어\s*트림)/i.test(text) && !/(도어\s*트림).*(e-?\s*axle|이\s*액슬)/i.test(text)) [a, b] = [b, a];   // "e-axle 2 : 도어트림 1"
    const key = a === b ? '1:1' : a > b ? '2:1' : '1:2';
    out.push({ type: 'mix', mix: key, note: a !== b && Math.max(a, b) / Math.min(a, b || 1) !== 2 ? `요청 ${a}:${b} → 가장 가까운 ${ZONE_MIXES[key].label}` : null });
    return out;
  }
  if (sim.zone && /(도어\s*트림)\s*(만|전용)/.test(text)) { out.push({ type: 'mix', mix: 'dt' }); return out; }
  if (sim.zone && /(e-?\s*axle|이\s*액슬)\s*(만|전용)/i.test(text)) { out.push({ type: 'mix', mix: 'ea' }); return out; }
  if (sim.zone && /(반반|균등|같은\s*비율|1\s*대\s*1)/.test(text)) { out.push({ type: 'mix', mix: '1:1' }); return out; }
  if (sim.zone && /(도어\s*트림).*(더|많이|늘)/.test(text)) { out.push({ type: 'mix', mix: '2:1' }); return out; }
  if (sim.zone && /(e-?\s*axle|이\s*액슬).*(더|많이|늘)/i.test(text)) { out.push({ type: 'mix', mix: '1:2' }); return out; }
  // 상태 질의
  if (/상태|어때|어떻|현황|알려|보고|몇\s*개|얼마|확인해/.test(text) && !/정지|멈|정비|보정|속도|투입|대피/.test(text)) { out.push({ type: 'status', target: target ?? 'all' }); return out; }
  // 긴급·제어 명령 (먼저 해제·리셋류를 본다)
  if (/비상\s*정지\s*(해제|풀)|리셋|재가동/.test(text)) cmd('RESET');
  else if (/비상\s*정지|e-?\s*stop|긴급\s*정지|당장\s*멈/i.test(text)) cmd('ESTOP');
  else if (/보호\s*정지\s*(해제|풀)/.test(text)) cmd('RESUME');
  else if (/보호\s*정지/.test(text)) cmd('SAFE_STOP');
  else if (/대피\s*(해제|풀|끝|종료)/.test(text)) out.push({ type: 'command', code: 'EVAC_END', target: 'all' });
  else if (/대피/.test(text)) out.push({ type: 'command', code: 'EVACUATE', target: 'all' });
  else if (/감속\s*(해제|풀)|정상\s*속도|원래\s*속도/.test(text)) cmd('SAFE_SPEED_OFF');
  else if (/투입\s*간격/.test(text) && /(\d+(?:\.\d+)?)\s*초/.test(text)) out.push({ type: 'interval', seconds: +text.match(/(\d+(?:\.\d+)?)\s*초/)[1] });
  else if (/투입|자재\s*넣/.test(text) && /정지|중단|멈|보류|막/.test(text)) out.push({ type: 'command', code: 'FEED_HOLD', target: 'all' });
  else if (/투입|자재\s*넣/.test(text) && /재개|다시|시작|풀/.test(text)) out.push({ type: 'command', code: 'FEED_RESUME', target: 'all' });
  else if (pct || /속도|빠르게|느리게|천천히/.test(text)) {
    if (/안전\s*(감속|속도)|협동\s*속도/.test(text) && !pct) cmd('SAFE_SPEED');
    else {
      const v = pct ? Math.max(30, Math.min(120, +pct[1])) : /빠르게|올려|높여/.test(text) ? 110 : /느리게|천천히|내려|낮춰/.test(text) ? 75 : null;
      if (v != null) cmd('SPEED', 'all', v);
    }
  } else if (/감속/.test(text)) cmd('SAFE_SPEED');
  else if (/긴급\s*조달|대체\s*발주|안전\s*재고/.test(text)) out.push({ type: 'expedite' });
  else if (/재보정|보정|캘리브/.test(text)) out.push({ type: 'command', code: 'RECALIB', target: target ?? null });
  else if (/예방\s*정비|정비|점검/.test(text)) out.push({ type: 'command', code: 'MAINT', target: target ?? null });
  else if (/사이클\s*정지|일시\s*정지|멈춰|정지시켜|세워|정지/.test(text)) cmd('CYCLE_STOP');
  else if (/재개|다시\s*(가동|돌|시작)|계속\s*(가동|돌)|가동시켜/.test(text)) cmd('RESUME');
  return out;
}

// 지시 전체 → 문장별 조치 (해석하지 못한 문장은 따로 돌려준다)
export function parseInstruction(text, sim) {
  const clauses = text.split(/\s*(?:,|\.(?=\s|$)|;|\n|그리고|그 ?다음(?:에)?|이후에?|및)\s*/).map((s) => s.trim()).filter(Boolean);
  const actions = [], unknown = [];
  for (const c of clauses) { const a = parseClause(c, sim); if (a.length) actions.push(...a.map((x) => ({ ...x, clause: c }))); else unknown.push(c); }
  return { actions, unknown };
}

// 조치 실행 — 결과 한 줄씩 돌려준다 (실행 못 하면 이유)
export function applyAction(a, sim, { by = '운영자 대화 지시', onMix, agent } = {}) {
  const K = sim.cmd;
  const name = (t) => K.targetName(t);
  switch (a.type) {
    case 'command': {
      const C = COMMANDS[a.code];
      if (!a.target) return { ok: false, text: `${C.label}: 대상 셀을 지정하세요 (예: "포장셀 ${C.label}")` };
      const av = K.availability(a.code, a.target, a.arg);
      if (!av.ok && av.hard) return { ok: false, text: `${C.label} → ${name(a.target)}: ${av.reason}` };
      const c = K.issue(a.code, a.target, a.arg, { by, why: a.clause });
      return c ? { ok: true, cmd: c, text: `${C.icon} ${K.label(c)} → ${name(a.target)} (명령 #${c.id})` } : { ok: false, text: `${C.label}: 이 대상에는 쓸 수 없습니다` };
    }
    case 'mix': {
      if (!sim.zone) return { ok: false, text: '혼류 비율은 정밀조립Zone 라인에서만 바꿀 수 있습니다' };
      if (sim.line.mix === a.mix) return { ok: true, text: `혼류 비율은 이미 ${ZONE_MIXES[a.mix].label}입니다` };
      sim.setMix(a.mix); onMix?.(a.mix);
      return { ok: true, text: `혼류 비율 → 도어트림 : e-axle = ${ZONE_MIXES[a.mix].label}${a.note ? ` (${a.note})` : ''} · 다음 투입부터 적용` };
    }
    case 'interval': {
      const s = Math.min(20, Math.max(5, a.seconds));
      sim.releaseInterval = s;
      return { ok: true, text: `투입 간격 ${s.toFixed(1)}초${s !== a.seconds ? ` (허용 범위 5~20초로 조정)` : ''}` };
    }
    case 'expedite': {
      const act = agent?.expedite?.();
      return act ? { ok: true, text: act } : { ok: false, text: '지금은 자재 공급 차질이 없어 긴급 조달하지 않았습니다' };
    }
    case 'status': return { ok: true, text: statusText(sim, a.target), reply: true };
  }
  return { ok: false, text: '알 수 없는 조치' };
}

export function statusText(sim, target) {
  const STL = { BUSY: '가동', STARVED: '자재대기', BLOCKED: '배출대기', DOWN: '고장', MAINT: '정비중', ESTOP: '비상정지', PSTOP: '보호정지', CSTOP: '사이클정지', CHECK: '자가진단', NOPARTS: '부품결품', REFILL: '부품보충중', IDLE: '대기' };
  if (target && target !== 'all') {
    const st = sim.processing.find((x) => x.id === target), a = sim.assess(st);
    const k = st.cmd, lim = [k?.safe && '감속 25%', k && k.override !== 1 && `속도 ${Math.round(k.override * 100)}%`, k?.hold === 'cycle' && '사이클 정지'].filter(Boolean);
    return `${st.name}: ${STL[st.state] ?? st.state} · 건강도 ${st.health.toFixed(0)}% · 10분 고장확률 ${(a.risk10 * 100).toFixed(1)}% · Cpk ${a.cpk.toFixed(2)} · 처리 ${st.c.processed}개${lim.length ? ` · ${lim.join(' · ')}` : ''}`;
  }
  const k = sim.kpi(), down = sim.processing.filter((s) => s.state === 'DOWN').map((s) => s.name);
  const open = sim.orch.openCount();
  return `라인: 시간당 ${Math.round(k.uphRecent)}개 · OEE ${(k.OEE * 100).toFixed(1)}% · 재공 ${k.wip}개 · 양품 ${k.good}개${sim.zone ? ` (도어트림 ${sim.stats.goodBy.doortrim ?? 0} · e-axle ${sim.stats.goodBy.eaxle ?? 0})` : ''}${down.length ? ` · 고장 ${down.join(', ')}` : ''}${open ? ` · 진행 중 인시던트 ${open}건` : ''}${sim.zone ? ` · 혼류 ${ZONE_MIXES[sim.line.mix]?.label ?? '1 : 1'}` : ''}`;
}
