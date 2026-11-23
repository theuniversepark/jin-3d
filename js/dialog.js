// 대화 기반 운영 — 정책 기반 에이전트가 공장을 계속 운영하는 위에, 입력창의 운영자 지시를 해석해 공정에 반영한다.
// 1) 내장 해석기: 한국어 지시(셀·대상·동작·수치)를 문장 단위로 나눠 조치로 바꾼다 — 서버·API 키 없이 즉시 동작
// 2) 내장 해석기로 알 수 없는 문장은 Claude가 연결되어 있으면 Claude가 해석해 같은 조치로 돌려준다 (js/llm.js)
// 조치는 모두 기존 경로로 실행된다: 상위 명령(js/commands.js), 혼류 비율, 투입 간격, 긴급 조달, 상태 질의.
import { COMMANDS } from './commands.js';
import { ZONE_MIXES } from './line.js';

// 정밀조립Zone 셀 별칭 (다른 라인은 설비 이름으로 찾는다)
const CELL_ALIASES = [
  [/부품\s*분류|분류\s*셀|소팅|부품\s*나누|분류하는|맨\s*(앞|처음)/, 'SORT'],
  [/도어\s*트림\s*(조립)/, 'DT_ASSY'],
  [/도어\s*트림\s*(체결|스크류|나사)/, 'DT_FAST'],
  [/(e-?\s*axle|이?\s*액슬|이\s*엑슬)\s*(조립)/i, 'EA_ASSY'],
  [/(e-?\s*axle|이?\s*액슬|이\s*엑슬)\s*(체결)/i, 'EA_FAST'],
  [/포장|검사\s*셀/, 'PACK'],
];
const ALL_RE = /전체|모든|모두|공장|라인\s*전|zone|존\s*전체|전\s*셀/i;
// 같은 뜻 표현 묶음 (Claude 없이도 흔한 바꿔 말하기를 받는다 · tests/dialog.mjs)
const DT = /도어\s*트림/, EA = /e-?\s*axle|이?\s*액슬|이\s*엑슬/i;
const MORE = /더|많이|늘|높|위주|중심|비중/, LESS = /절반|줄|적게|덜|낮/;
const URGENT = /비상|급히|급하게|위험|당장|긴급/, STOPW = /멈|정지|세워|스톱|중지/;
const FEED = /투입|자재|재료|소재|원자재|공급/, FEED_HOLDW = /정지|중단|멈|보류|막|쉬|홀드|그만|스톱/, FEED_GOW = /재개|다시|시작|풀/;
const MAINTW = /예방\s*정비|정비|점검|손\s*(좀\s*)?(봐|보)|고장|고쳐|수리|장비\s*(확인|봐)|(기계|장비|설비).*(이상|문제|소리)/;
const RECALW = /재보정|보정|캘리브|다시\s*(맞춰|잡아)|정밀도|영점/;
const NORMALW = /원래\s*대로|보통으로|표준으로|사이클\s*원래|무리하지|혹사/;
// 숫자: % · 퍼센트 · 프로 · 퍼, 또는 속도 문맥의 "N으로" · 반쯤 → 50
function pctOf(text) {
  const m = text.match(/(\d{2,3})\s*(%|퍼센트|프로|퍼)/) ?? (/속도|빠르게|느리게|천천히|올려|내려|낮춰|높여/.test(text) ? text.match(/(\d{2,3})\s*(?:으로|로)/) : null);
  if (m) return +m[1];
  return /반쯤|절반\s*속도|반\s*속도/.test(text) ? 50 : null;
}
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
// 실행 전에 걸러낼 문장 — 하지 말라는 지시 · 묻는 말 · 대상 셀이 불분명한 지시는 명령으로 바꾸지 않는다
// 부정 · 금지: 문장 끝이 「…지 마 / 말아 / 하면 안 돼 / 금지」 (중간의 「…지 말고 보통으로」는 다른 지시를 하라는 뜻이라 제외)
const NEG_END = /(지\s*(마|마요|마세요|마라|말아|말아요|말아줘|말아\s*주세요|말\s*것)|면\s*안\s*(돼|되|됩니다)\w*|금지|하지\s*않도록|못\s*하게\s*해\w*)\s*[.!?~]*$/;
// 묻는 말: 상태 · 현황을 묻고, 끝이 제어 동사(해 · 시켜 · 걸어 · 풀어 …)로 끝나지 않는다 (「알려줘 · 보여줘 · 확인해줘」는 묻는 말)
const ASK = /상태|어때|어떻|현황|몇\s*개|얼마|괜찮|돌아가|인가요|인지|있어\s*\?|있나|했어\s*\?|됐어\s*\?|\?\s*$/;
const DO_END = /(정지|멈춰|세워|정비|점검|보정|수리|고쳐|대피|투입|재개|해제|리셋|가동|낮춰|높여|올려|내려|바꿔|맞춰|풀어|걸어|시켜|해)\s*(줘|요|라|주세요|줄래|봐)?\s*[.!]*$/;
const SHOW_END = /(알려|보여|확인해|말해|봐)\s*(줘|요|주세요|줄래)?\s*[.!?]*$/;
const isAsk = (text) => ASK.test(text) && (SHOW_END.test(text) || /\?\s*$/.test(text) || !DO_END.test(text));
// 셀을 가리킨 말이 있는데 이름을 정확히 찾지 못하면 후보를 돌려준다 (「조립셀」 → 도어트림 · e-axle 조립셀, 「DT_ASY 셀」 → 없음)
function unclearCell(text, sim) {
  const id = text.match(/\b[A-Za-z]{2,}_[A-Za-z0-9_]+\b/);
  const word = text.match(/([가-힣A-Za-z0-9_-]+?)\s*셀/);
  if (!id && !word) return null;
  const key = norm((id?.[0] ?? word[1]).replace(/[·\s]/g, ''));
  const cells = sim.processing.filter((st) => !st.standby);
  const cand = cells.filter((st) => norm(st.name).includes(key) || norm(st.id).includes(key) || norm(st.id).replace(/_/g, '').includes(key.replace(/_/g, '')));
  return { word: id?.[0] ?? `${word[1]}셀`, cand };
}

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
function parseClause(text, sim, depth = 0) {
  const target = findTarget(text, sim), out = [];
  if (NEG_END.test(text)) return [{ type: 'unclear', reason: '하지 말라는 지시 — 명령을 보내지 않고 지금 상태를 그대로 둡니다', alt: '바꾸려면 원하는 동작을 말해 주세요 · 지금 상태는 "…상태 알려줘"로 확인' }];
  const cmd = (code, def = 'all', arg = null) => out.push({ type: 'command', code, target: target ?? def, arg });
  const pv = pctOf(text);
  // 혼류 비율 (제품 이름이 들어간 비율·전용 생산)
  const ratio = text.match(/(\d)\s*(?::|대|to)\s*(\d)/i);
  if (sim.zone && (ratio && /비율|혼류|도어\s*트림|e-?\s*axle|액슬|생산/i.test(text))) {
    let [a, b] = [+ratio[1], +ratio[2]];
    if (/(e-?\s*axle|이\s*액슬).*(도어\s*트림)/i.test(text) && !/(도어\s*트림).*(e-?\s*axle|이\s*액슬)/i.test(text)) [a, b] = [b, a];   // "e-axle 2 : 도어트림 1"
    const key = a === b ? '1:1' : a > b ? '2:1' : '1:2';
    out.push({ type: 'mix', mix: key, note: a !== b && Math.max(a, b) / Math.min(a, b || 1) !== 2 ? `요청 ${a}:${b} → 가장 가까운 ${ZONE_MIXES[key].label}` : null });
    return out;
  }
  if (sim.zone && /(도어\s*트림)\s*(만|전용)/.test(text)) { out.push({ type: 'mix', mix: 'dt' }); return out; }
  if (sim.zone && /(e-?\s*axle|이\s*액슬)\s*(만|전용)/i.test(text)) { out.push({ type: 'mix', mix: 'ea' }); return out; }
  if (sim.zone && /(반반|균등|같은\s*비율|1\s*대\s*1)/.test(text)) { out.push({ type: 'mix', mix: '1:1' }); return out; }
  // 한 제품을 늘리거나(위주 · 비중 높여) 다른 제품을 줄이면(절반 · 덜) 그쪽 2 : 1
  const mixOk = sim.zone && !(target && target !== 'all') && !/속도|정지/.test(text) && !MAINTW.test(text) && !RECALW.test(text);   // 셀 지시 · 정비 · 속도 문장의 "더"는 혼류가 아님
  const dtM = DT.test(text) && MORE.test(text) && !LESS.test(text), eaM = EA.test(text) && MORE.test(text) && !LESS.test(text);
  if (mixOk && ((dtM && !EA.test(text)) || (EA.test(text) && LESS.test(text) && !DT.test(text)))) { out.push({ type: 'mix', mix: '2:1' }); return out; }
  if (mixOk && ((eaM && !DT.test(text)) || (DT.test(text) && LESS.test(text) && !EA.test(text)))) { out.push({ type: 'mix', mix: '1:2' }); return out; }
  // 셀을 가리켰는데 정확히 못 찾으면 전체로 넓히지 않고 되묻는다
  if (!target) {
    const u = unclearCell(text, sim);
    if (u && u.cand.length === 1 && !depth) return parseClause(text.replace(u.word, u.cand[0].name), sim, 1);   // 후보가 하나면 그 셀
    if (u) return [{ type: 'unclear', reason: u.cand.length ? `「${u.word}」이(가) 여러 셀에 해당 — ${u.cand.map((c) => c.name).join(' · ')}` : `「${u.word}」에 해당하는 셀이 없음`, alt: `셀 이름을 정확히 (예: "${(u.cand[0] ?? sim.processing[0]).name} …") 또는 "전체 …"` }];
  }
  // 상태 질의 — 묻는 말이면 정지 · 정비 같은 낱말이 있어도 조회만 한다 (「비상정지 상태 알려줘」 · 「포장셀 정비 상태 어때?」)
  if (isAsk(text)) { out.push({ type: 'status', target: target ?? 'all' }); return out; }
  // 긴급·제어 명령 (먼저 해제·리셋류를 본다)
  if (/비상\s*정지\s*(해제|풀)|리셋|재가동/.test(text)) cmd('RESET');
  else if (/비상\s*정지|e-?\s*stop|긴급\s*정지|당장\s*멈/i.test(text) || (URGENT.test(text) && STOPW.test(text) && !/재고|조달|발주/.test(text))) cmd('ESTOP');
  else if (/보호\s*정지\s*(해제|풀)/.test(text)) cmd('RESUME');
  else if (/보호\s*정지/.test(text)) cmd('SAFE_STOP');
  else if (/대피\s*(해제|풀|끝|종료)/.test(text)) out.push({ type: 'command', code: 'EVAC_END', target: 'all' });
  else if (/대피|다\s*나가|모두\s*나가|피신/.test(text)) out.push({ type: 'command', code: 'EVACUATE', target: 'all' });
  else if (/감속\s*(해제|풀)|정상\s*속도|원래\s*속도/.test(text)) cmd('SAFE_SPEED_OFF');
  else if (/(투입|넣는|들어가는)\s*(간격|주기|텀)/.test(text) && /(\d+(?:\.\d+)?)\s*초/.test(text)) out.push({ type: 'interval', seconds: +text.match(/(\d+(?:\.\d+)?)\s*초/)[1] });
  else if (/긴급\s*조달|대체\s*발주|안전\s*재고|비상\s*재고|재고\s*풀|공급\s*(문제|차질).*(해결|빨리|급히)/.test(text)) out.push({ type: 'expedite' });
  else if (FEED.test(text) && FEED_HOLDW.test(text) && !/간격|주기/.test(text)) out.push({ type: 'command', code: 'FEED_HOLD', target: 'all' });
  else if (FEED.test(text) && FEED_GOW.test(text) && !/간격|주기/.test(text)) out.push({ type: 'command', code: 'FEED_RESUME', target: 'all' });
  else if (target && target !== 'all' && NORMALW.test(text) && !/빠르게|느리게|천천히/.test(text)) cmd('SPEED', 'all', 100);   // 셀 사이클을 표준(속도 100%)으로
  else if (pv != null || /속도|빠르게|느리게|천천히|살살/.test(text)) {
    if (/안전\s*(감속|속도)|협동\s*속도/.test(text) && pv == null) cmd('SAFE_SPEED');
    else {
      const v = pv != null ? Math.max(30, Math.min(120, pv)) : /빠르게|올려|높여/.test(text) ? 110 : /느리게|천천히|살살|내려|낮춰/.test(text) ? 75 : null;
      if (v != null) cmd('SPEED', 'all', v);
    }
  } else if (/감속/.test(text)) cmd('SAFE_SPEED');
  else if (RECALW.test(text)) out.push({ type: 'command', code: 'RECALIB', target: target ?? null });
  else if (MAINTW.test(text)) out.push({ type: 'command', code: 'MAINT', target: target ?? null });
  else if (/사이클\s*정지|일시\s*정지|멈춰|정지시켜|세워|정지/.test(text)) cmd('CYCLE_STOP');
  else if (/재개|다시\s*(가동|돌|시작)|계속\s*(가동|돌)|가동시켜/.test(text)) cmd('RESUME');
  return out;
}

// 지시 전체 → 문장별 조치 (해석하지 못한 문장은 따로 돌려준다)
export function parseInstruction(text, sim) {
  const clauses = splitClauses(text), actions = [], unknown = [], seen = new Set();
  for (let i = 0; i < clauses.length; i++) {
    let c = clauses[i], a = parseClause(c, sim);
    // "투입 간격 너무 짧아, 15초로" — 수치만 있는 다음 문장을 앞 문장에 붙여 다시 본다
    if (!a.length && QTY.test(clauses[i + 1] ?? '')) { const j = `${c} ${clauses[i + 1]}`, b = parseClause(j, sim); if (b.length) { c = j; a = b; i++; } }
    if (!a.length) { unknown.push(c); continue; }
    for (const x of a) { const k = JSON.stringify([x.type, x.code, x.target, x.arg, x.mix, x.seconds, x.reason]); if (!seen.has(k)) { seen.add(k); actions.push({ ...x, clause: c }); } }   // 같은 조치를 두 번 말하면 한 번만 ("공급 문제 해결해, 비상 재고 풀어")
  }
  return { actions, unknown };
}
const QTY = /^\d+(?:\.\d+)?\s*(초|%|퍼센트|프로|퍼)?\s*(으로|로)?\s*(해|해줘|바꿔|맞춰)?$/;
export const splitClauses = (text) => text.split(/\s*(?:,|\.(?=\s|$)|;|\n|그리고|그 ?다음(?:에)?|이후에?|및)\s*/).map((s) => s.trim()).filter(Boolean);

// 조치 실행 — 결과 한 줄씩 돌려준다 (실행 못 하면 이유)
// 운영 계획을 바꾸는 지시(혼류 비율 · 투입 간격)는 FacOS 공장 결정을 거친다 — 지시한 사람이 승인자 · 계획 버전 증가 (js/factoryos.js change)
//   셀 명령(속도 · 정지 · 정비 …)은 명령 경로(commands.js)가 이미 Manufacturing Agent → 셀 OCS A2A로 남긴다
const fosChange = (sim, c, apply) => (sim.fos ? sim.fos.change({ human: true, ...c }, apply) : (apply?.(), { ok: true }));
const ver = (sim) => (sim.fos ? ` · FacOS 계획 ${sim.fos.planVersion}` : '');
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
      const r = fosChange(sim, { kind: 'mix', title: `혼류 비율 변경 — 도어트림 : e-axle = ${ZONE_MIXES[a.mix].label}`, before: ZONE_MIXES[sim.line.mix]?.label, after: ZONE_MIXES[a.mix].label, by, constraints: '다음 투입부터 · 진행 중 오더 수량 유지', resume: '' }, () => { sim.setMix(a.mix); onMix?.(a.mix); });
      if (!r.ok) return { ok: false, text: `혼류 비율 변경 보류 — ${r.reason}` };
      return { ok: true, text: `혼류 비율 → 도어트림 : e-axle = ${ZONE_MIXES[a.mix].label}${a.note ? ` (${a.note})` : ''} · 다음 투입부터 적용${ver(sim)}` };
    }
    case 'interval': {
      const s = Math.min(20, Math.max(5, a.seconds));
      const r = fosChange(sim, { kind: 'interval', title: `투입 간격 변경 — ${s.toFixed(1)}초`, before: sim.releaseInterval != null ? `${(+sim.releaseInterval).toFixed(1)}초` : '자동', after: `${s.toFixed(1)}초`, by, constraints: '허용 범위 5~20초', resume: '' }, () => { sim.releaseInterval = s; });
      if (!r.ok) return { ok: false, text: `투입 간격 변경 보류 — ${r.reason}` };
      return { ok: true, text: `투입 간격 ${s.toFixed(1)}초${s !== a.seconds ? ` (허용 범위 5~20초로 조정)` : ''}${ver(sim)}` };
    }
    case 'expedite': {
      const act = agent?.expedite?.();
      if (act) fosChange(sim, { kind: 'expedite', title: `긴급 조달 — ${act}`, by, plan: false, autonomous: true, constraints: '자재 공급 차질 대응', resume: '공급 재개' });
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
    const k = st.cmd, lim = [st.request && `${st.request.kind === 'repair' ? '수리' : st.request.kind === 'pm' ? '예방정비' : '정비'} 요청 중`, k?.safe && '감속 25%', k && k.override !== 1 && `속도 ${Math.round(k.override * 100)}%`, k?.hold === 'cycle' && '사이클 정지'].filter(Boolean);
    return `${st.name}: ${STL[st.state] ?? st.state} · 건강도 ${st.health.toFixed(0)}% · 10분 고장확률 ${(a.risk10 * 100).toFixed(1)}% · Cpk ${a.cpk.toFixed(2)} · 처리 ${st.c.processed}개${lim.length ? ` · ${lim.join(' · ')}` : ''}`;
  }
  const k = sim.kpi(), down = sim.processing.filter((s) => s.state === 'DOWN').map((s) => s.name);
  const open = sim.orch.openCount(), C = sim.cmd, cmds = [C?.estopAll && '비상정지 발령 중', C?.pstopAll && '보호정지 중', C?.feedHold && '투입 보류', C?.evac && '대피 중'].filter(Boolean);
  return `라인: 시간당 ${Math.round(k.uphRecent)}개 · OEE ${(k.OEE * 100).toFixed(1)}% · 재공 ${k.wip}개 · 양품 ${k.good}개${sim.zone ? ` (도어트림 ${sim.stats.goodBy.doortrim ?? 0} · e-axle ${sim.stats.goodBy.eaxle ?? 0})` : ''}${down.length ? ` · 고장 ${down.join(', ')}` : ''}${open ? ` · 진행 중 인시던트 ${open}건` : ''} · ${cmds.length ? cmds.join(' · ') : '비상정지 · 보호정지 없음'}${sim.zone ? ` · 혼류 ${ZONE_MIXES[sim.line.mix]?.label ?? '1 : 1'}` : ''}`;
}
