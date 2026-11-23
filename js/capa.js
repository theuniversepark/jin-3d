// 품질 불량 → 원인 분석 → 재발 방지 대책 (8D CAPA) · 운영 정책 반영
// 체결셀 전수 검사 NG(trace.js inspect) · 출하 전 샘플 재검 NG(serial.js judge) → 불량 판정을 정밀조립 Zone 오케스트레이터와 총괄 오케스트레이터에 전달하고 8D 단계로 처리한다:
//   D0 NG 판정·격리(검사셀) → D1 팀 구성 → D2 문제 기술(5W2H) → D3 임시 조치(봉쇄 — 의심 제품 출하 보류 · 원인 후보 셀 재보정/점검) → 총괄 보고(Quality Alert)
//   → D4 근본 원인(AI 원인 분석) → D5 대책 선정(운영 정책 변경안) → 총괄 승인(정책 반영 · 수평 전개) → D6 시행·검증(반영 전후 불량률) → D7 재발 방지(FMEA AP 갱신 · 정책 표준화) → D8 종결
// 같은 원인(셀 + 요인)으로 다시 NG가 나면 진행 중인 8D에 묶는다 (사례 수만 늘어남).
// 정책 반영은 사람이 결정한다(정책 반영 / 보류) — 자동 반영을 켜면 총괄 오케스트레이터가 승인한다. 반영한 정책은 정책 이력에 남고 되돌릴 수 있다.
// 렌더링과 분리 — 헤드리스에서도 같은 흐름. 단계 간격은 운영 단계별 판단 속도 (레거시 사람 판단 · 자동화 MES · 피지컬AI 에이전트)
import { FACTOR, ENV_SPEC, ENV_SENS } from './trace.js';

export const D8 = [
  { key: 'D0', label: 'NG 판정·격리' }, { key: 'D1', label: '팀 구성' }, { key: 'D2', label: '문제 기술' }, { key: 'D3', label: '임시 조치 (봉쇄)' },
  { key: 'D4', label: '근본 원인' }, { key: 'D5', label: '대책 선정' }, { key: 'D6', label: '시행·검증' }, { key: 'D7', label: '재발 방지 (정책)' }, { key: 'D8', label: '종결' },
];
export const CAPA_LANES = [
  { key: 'field', label: '검사셀 · 현장', sub: '체결 토크·각도 전수 검사' },
  { key: 'zone', label: 'Manufacturing Agent', sub: '정밀조립 로컬 오케스트레이터 · 8D 수행 · 봉쇄 · 원인 분석' },
  { key: 'hq', label: '공장 오케스트레이터 (FacOS)', sub: '총괄 · Quality Alert · 승인 · 수평 전개' },
  { key: 'policy', label: '운영 정책', sub: '정책 반영 · FMEA · 표준화' },
];
const GAP = { traditional: 45, smart: 8, dark: 2.5 };      // 8D 단계 사이 판단 간격 (초)
export const VERIFY_S = 1200;
export const RECHECK_S = 240;                              // 봉쇄 제품 재검 시간 (시뮬레이션 4분)                              // D6 효과 검증 구간 (시뮬레이션 20분)
const WHO = { traditional: '품질 반장 · 정비원', smart: 'MES 품질 모듈 · 정비원', dark: '품질·정비·흐름 에이전트 · 정비 휴머노이드' };

// 원인 요인 → 운영 정책 변경안
function proposalFor(sim, cause) {
  const m = sim.mode, f = cause.factor;
  if (f === 'health') {
    if (!m.pmEnabled) return { lever: 'text', title: '설비 일상 점검 주기 단축 (작업표준서 개정)', desc: '레거시 공장은 예지정비가 없어 작업표준서로 점검 주기를 줄인다 (시뮬레이션 값 변화 없음)' };
    const from = m.pmThreshold, to = Math.min(75, from + 5);
    return { lever: 'pmThreshold', title: `예지정비 착수 건강도 ${from}% → ${to}%`, desc: `${cause.name} 같은 품질 민감 셀이 열화되기 전에 정비`, from, to };
  }
  if (f === 'drift') { const from = m.cpkMin ?? 1.15, to = Math.min(1.6, Math.round((from + 0.18) * 100) / 100); return { lever: 'cpkMin', title: `재보정 시작 Cpk ${from} → ${to}`, desc: 'SPC 관리 한계를 높여 드리프트를 더 일찍 보정', from, to }; }
  if (ENV_SPEC[f]) {
    const S = ENV_SPEC[f], sts = Object.entries(ENV_SENS).filter(([k, v]) => v[f] && /_/.test(k)).map(([k]) => k);
    return { lever: `envComp.${f}`, title: `환경 인터록 — ${S.label} 기준 이탈 시 공정 보상`, desc: `${S.label} 관리 기준을 넘는 동안 민감 공정(${sts.join('·') || cause.name}) 공정 시간 +12% (경화·안정화) · 불량 영향 85% 감소`, from: false, to: true, key: f };
  }
  if (f === 'amr') return { lever: 'text', title: `${cause.st} 적재부·주행 충격 점검 · 점검 주기 단축`, desc: 'AMR 정비 기준 개정 (시뮬레이션 값 변화 없음)' };
  if (f === 'lot') return { lever: 'text', title: '수입검사 샘플링 강화 (로트 n=5 → 13)', desc: '원자재 수입검사 기준 개정 (시뮬레이션 값 변화 없음)' };
  return { lever: 'text', title: `${cause.name} 공정 능력 개선 과제 — 지그·그리퍼 개선 · 작업표준 재검토`, desc: '설비 상태·환경으로 설명되지 않는 고유 산포 (시뮬레이션 값 변화 없음)' };
}
// FMEA (AIAG-VDA): 심각도 S · 발생도 O(불량률) · 검출도 D(전수 토크 검사) → 조치 우선순위 AP
const occ = (rate) => (rate >= 0.05 ? 7 : rate >= 0.02 ? 6 : rate >= 0.01 ? 5 : rate >= 0.005 ? 4 : rate >= 0.002 ? 3 : 2);
const AP = (S, O, D) => (S >= 7 && O >= 4) || (S >= 7 && D >= 5) ? 'H' : O >= 3 || D >= 5 ? 'M' : 'L';

export class CapaManager {
  constructor(sim) {
    this.sim = sim; this.list = []; this.policies = []; this.seq = 0; this.pseq = 0; this.auto = false;
    sim.qpolicy = { envComp: {} };
    sim.capa = this;
  }
  get gap() { return GAP[this.sim.mode.key] ?? 8; }
  get open() { return this.list.filter((k) => k.status !== 'closed' && k.status !== 'held'); }
  get pending() { return this.list.filter((k) => k.status === 'approval'); }
  step(k, lane, d, text, extra = {}) {
    k.steps.push({ t: this.sim.time, lane, d, text, ...extra });
    // 8D 진행 → (앱) ERPNext 품질 조치(Quality Action) — 단계마다 전체 기록을 보내 덮어쓴다 (server/erpnext-bridge.mjs)
    this.sim.fac?.qual?.('q.capa', { key: k.id, kind: 'main', zone: 'main', title: k.title, status: k.status, stage: k.stage, cause: k.cause?.label ?? null, cases: [...k.cases], steps: k.steps.map((x) => ({ d: x.d, lane: x.lane, text: x.text })) });
  }
  later(dt, fn) { this.sim.orch.later(dt, fn); }

  // 불량 사례 하나 (trace.js openCase)
  onDefect(c, r) {
    const s = this.sim, top = c.rca?.causes[0]; if (!top) return;
    s.qcomm?.report(c);   // 불량 판정 리포트 → 메인 서버 → RCA 서버 (js/qcomm.js)
    const key = `${top.station ?? top.factor}:${top.factor}`;
    const o = s.orch, inc = o.open('defect', `ng:${c.id}`, `${c.detectedName} 품질 불량 ${c.serial}`, c.detectedName, { where: s.stations.find((x) => (x.uid ?? x.id) === c.detectedAt) ?? null, zone: 'main' });
    o.step(inc, 'field', 'detect', `전수 검사 NG — ${c.inspection?.mode ?? '규격 이탈'} (토크 ${c.inspection?.torque} N·m · 각도 ${c.inspection?.angle}°)`);
    o.step(inc, 'cell', 'self', `셀 자체 조치: NG 제품 ${c.serial} 배출함 격리 · 시리얼 기록`);
    o.step(inc, 'cell', 'report', '상위 보고: 정밀조립 Zone 오케스트레이터 · 총괄 오케스트레이터에 불량 판정 전달');
    let k = this.open.find((x) => x.key === key);
    if (k) {
      k.cases.push(c.id); c.capa = k;
      this.step(k, 'field', 'D0', `추가 NG ${c.serial} — ${c.inspection?.mode ?? ''}`, { caseId: c.id });
      this.step(k, 'zone', 'D2', `문제 기술 갱신 — 같은 원인 ${k.cases.length}건`);
      o.later(o.latency, () => { o.step(inc, 'orch', 'decide', `판단(${(o.nameOf?.(inc) ?? o.name)}): 진행 중인 ${k.id}(${k.cause.label})에 묶음`); o.close(inc, `${k.id}로 이관 · 종결`); });
      return k;
    }
    k = { id: `CAPA-${String(++this.seq).padStart(3, '0')}`, key, title: `${c.detectedName} NG — ${top.label}`, t0: s.time, status: 'open', stage: 'D0', cause: { ...top }, cases: [c.id], steps: [], actions: [], horizontal: [], fmea: null, proposal: null, inc: inc.id, mode: s.mode.key };
    c.capa = k; this.list.unshift(k); if (this.list.length > 60) this.list.pop();
    const G = this.gap, T = s.trace, st = s.processing.find((x) => x.id === top.station);
    this.step(k, 'field', 'D0', `NG 판정 ${c.serial} (${c.product === 'doortrim' ? '도어트림' : c.product === 'eaxle' ? 'e-axle' : c.product}) — ${c.inspection?.mode ?? ''} · 배출함 격리`, { caseId: c.id });
    o.later(o.latency, () => { o.step(inc, 'orch', 'decide', `판단(${(o.nameOf?.(inc) ?? o.name)}): 8D ${k.id} 착수 · 총괄 오케스트레이터 Quality Alert`); });
    this.later(G, () => { k.stage = 'D1'; this.step(k, 'zone', 'D1', `8D 팀 구성 — ${WHO[s.mode.key]}`); });
    this.later(G * 2, () => {
      k.stage = 'D2';
      const rate = T.ngRate(s.time - 3600);
      this.step(k, 'zone', 'D2', `문제 기술(5W2H): 무엇 ${c.serial} · 어디 ${c.detectedName} · 언제 ${clk(c.t)} · 어떻게 ${c.inspection?.mode ?? '-'} · 얼마나 최근 1시간 불량률 ${(rate * 100).toFixed(2)}%`);
      k.rateBefore = rate;
    });
    this.later(G * 3, () => {
      k.stage = 'D3';
      const hold = c.suspects.filter((x) => x.status === 'ok' || x.status === 'wip');
      let act = `봉쇄: 원인 후보 셀 같은 시간대 경유 제품 ${hold.length}개 출하 보류·재검 지시`;
      // 원인 후보 셀 즉시 조치: 드리프트 → 재보정 · 열화 → 예지정비 요청 (요청이 이미 있거나 셀이 멈춰 있으면 건너뜀)
      if (st && top.factor === 'drift') { const ok = s.mode.key === 'dark' ? s.selfCalibrate(st) : s.requestTech(st, 'cal'); act += ok ? ` · ${st.name} 재보정 지시` : ` · ${st.name} 재보정 (이미 진행·대기 중)`; }
      if (st && top.factor === 'health' && s.mode.pmEnabled) { const ok = s.requestTech(st, 'pm'); act += ok ? ` · ${st.name} 예지정비 요청` : ` · ${st.name} 정비 (이미 요청됨)`; }
      if (ENV_SPEC[top.factor]) act += ` · 환경 이상 구간 ${ENV_SPEC[top.factor].label} 감시 강화`;
      k.actions.push({ t: s.time, d: 'D3', text: act, hold: hold.map((x) => x.serial) });
      for (const x of hold) { const r = T.byId.get(x.serial); if (r && !r.hold) { r.hold = `containment:${k.id}`; } }   // 봉쇄 — 수량 정산의 HOLD
      // 봉쇄 제품 재검 (RECHECK_S 뒤): 정상은 HOLD 해제, 검사에서 빠져나간 불량(유출)은 회수해 폐기로 — 결과가 올 때까지 해제하지 않는다
      // 봉쇄 때 아직 공정 중이던 제품은 완성된 뒤에야 재검할 수 있다 — 남아 있으면 RECHECK_S마다 다시 재검한다 (승인 대기가 길어져도 정상품이 구분 적재장에 묶여 라인이 서지 않게)
      const recheck = (first) => { if (k.status === 'closed') return; const R = this.recheck(k); if (first || R.ok || R.caught) this.step(k, 'zone', 'D3', `봉쇄 제품 재검 ${first ? '완료' : '(뒤이어 완성된 제품)'} — ${R.ok}개 HOLD 해제${R.caught ? ` · 유출 불량 ${R.caught}개 회수 (${R.serials.join(', ')})` : ' · 유출 불량 없음'}${R.left ? ` · 공정 중 ${R.left}개는 완성 뒤 재검` : ''}`); if (R.left) this.later(RECHECK_S, () => recheck(false)); };
      this.later(RECHECK_S, () => recheck(true));
      this.step(k, 'zone', 'D3', act);
      o.step(inc, 'exec', 'act', act); o.close(inc, `임시 조치 완료 — 8D ${k.id}로 이관`);
    });
    this.later(G * 3.5, () => this.step(k, 'hq', 'D3', `Quality Alert 수신 — 정밀조립 ${c.serial} NG · 1순위 원인 ${top.label} · 봉쇄 확인`));
    this.later(G * 4.5, () => {
      k.stage = 'D4';
      const rc = c.rca;
      this.step(k, 'zone', 'D4', `근본 원인(AI 원인 분석): ${top.label} — 비중 ${(top.score * 100).toFixed(0)}% · 신뢰도 ${(rc.confidence * 100).toFixed(0)}% · ${rc.why.at(-1) ?? ''}`);
    });
    this.later(G * 5.5, () => {
      k.stage = 'D5'; k.proposal = proposalFor(s, top);
      this.step(k, 'zone', 'D5', `대책 선정: ${k.proposal.title} — ${k.proposal.desc}`);
      this.step(k, 'hq', 'D5', this.auto ? '정책 변경 승인 검토 (자동 반영)' : '정책 변경 승인 요청 — 정책 반영 / 보류 결정 대기');
      k.status = 'approval';
      k.horizontal = this.horizontal(top);
      s.fos?.policyRequest(k);   // Manufacturing Agent → 공장 오케스트레이터 결정 요청 (사람 결정 HITL)
      if (this.auto) this.later(G, () => this.approve(k.id, '총괄 오케스트레이터 (자동 반영)'));
    });
    return k;
  }
  // 수평 전개: 같은 유형 공정의 다른 셀 (총괄 오케스트레이터가 점검 지시) — Zone이 하나라 정밀조립 안의 다른 라인 셀이 대상 · 환경 요인은 그 환경에 민감한 셀
  horizontal(top) {
    const s = this.sim, t = s.processing.find((x) => x.id === top.station)?.type;
    const same = { assembly: ['assembly', 'pressfit'], pressfit: ['assembly', 'pressfit'], screw: ['screw', 'fasten'], fasten: ['screw', 'fasten'] }[t] ?? [];
    return s.processing.filter((x) => x.id !== top.station && (same.includes(x.type) || (ENV_SPEC[top.factor] && (ENV_SENS[x.id] ?? ENV_SENS[x.type])?.[top.factor]))).slice(0, 6).map((x) => x.name ?? x.id);
  }

  // 정책 반영 (사람 결정 · 자동 반영)
  approve(id, by = '사용자 결정') {
    const k = this.list.find((x) => x.id === id); if (!k || k.status !== 'approval') return false;
    const s = this.sim, p = k.proposal, G = this.gap;
    k.status = 'verify'; k.stage = 'D6';
    // 같은 정책이 이미 적용 중이면(다른 8D가 먼저 반영) 새로 바꾸지 않고 그 정책에 연결한다
    const same = this.policies.find((x) => x.status === 'applied' && x.lever === p.lever && (p.lever === 'text' ? x.title === p.title : x.to === p.to || (p.lever === 'pmThreshold' || p.lever === 'cpkMin') && x.to >= p.to));
    const pol = same ?? this.apply(p, k, by);
    s.fos?.policyDecision(k, 'approve', by);
    if (same) { (same.capas ??= [same.capa]).push(k.id); }
    this.step(k, 'hq', 'D6', `승인 (${by}) · 수평 전개 지시: ${k.horizontal.length ? k.horizontal.join(', ') : '해당 공정 없음'}`);
    this.step(k, 'policy', 'D6', same ? `이미 적용 중인 ${same.id} (${same.title})에 연결 — 추가 변경 없음` : pol.applied ? `정책 반영: ${p.title}` : `기준 개정: ${p.title} (시뮬레이션 값 변화 없음)`, { policy: pol.id });
    this.step(k, 'zone', 'D6', `시행·검증: 반영 후 ${VERIFY_S / 60}분 불량률 측정 (반영 전 1시간 ${(k.rateBefore * 100).toFixed(2)}%)`);
    k.tApply = s.time;
    this.later(VERIFY_S, () => this.verify(k, pol));
    return true;
  }
  hold(id, by = '사용자 결정') {
    const k = this.list.find((x) => x.id === id); if (!k || k.status !== 'approval') return false;
    k.status = 'held'; k.stage = 'D8'; k.tEnd = this.sim.time;
    this.sim.fos?.policyDecision(k, 'hold', by); this.release(k);
    this.step(k, 'hq', 'D8', `보류 (${by}) — 정책 미반영 · 봉쇄 조치만 유지하고 종결`);
    this.sim.qcomm?.close(k);   // RCA 서버에 종결 보고
    return true;
  }
  verify(k, pol) {
    const s = this.sim, T = s.trace, after = T.ngRate(k.tApply, s.time), before = k.rateBefore ?? 0;
    k.effect = { before, after, window: VERIFY_S };
    if (pol) pol.effect = k.effect;
    this.step(k, 'zone', 'D6', `검증 결과: 불량률 ${(before * 100).toFixed(2)}% → ${(after * 100).toFixed(2)}% (${after <= before ? '개선' : '악화 — 추가 분석 필요'})`);
    const S = 7, D = 2, O0 = occ(before), O1 = occ(after);
    k.fmea = { failureMode: s.trace.cases.find((c) => c.id === k.cases[0])?.inspection?.mode ?? '규격 이탈', cause: k.cause.label, S, O: [O0, O1], D, AP: [AP(S, O0, D), AP(S, O1, D)], control: k.proposal.title };
    k.stage = 'D7';
    this.step(k, 'policy', 'D7', `재발 방지 표준화: FMEA 발생도 ${O0} → ${O1} · AP ${k.fmea.AP[0]} → ${k.fmea.AP[1]} · 관리계획에 "${k.proposal.title}" 등록`);
    this.later(this.gap, () => { k.stage = 'D8'; k.status = 'closed'; k.tEnd = s.time; this.release(k); this.step(k, 'hq', 'D8', `종결 — ${k.cases.length}건 · 정책 이력 ${pol?.id ?? '-'} · 수평 전개 ${k.horizontal.length}곳 확인`); s.qcomm?.close(k); });
  }
  recheck(k) {
    const T = this.sim.trace, out = { ok: 0, caught: 0, serials: [], left: 0 };
    for (const r of T?.recent ?? []) {
      if (r.hold !== `containment:${k.id}`) continue;
      if (r.status === 'escaped') { if (r.loc === 'fg') this.sim.fac?.qual?.('q.disp', { key: r.serial ?? r.wip, lot: null, zone: 'main', product: r.product, d: 'scrap', why: `${k.id} 봉쇄 재검 — 유출 불량 회수 (격리)`, sample: false }); this.sim.serials?.dropStock(r); if (r.loc === 'fg') r.loc = 'quarantine'; r.status = 'ng'; r.recovered = k.id; r.hold = null; T.stats.escaped--; T.stats.ng++; T.stats.recovered = (T.stats.recovered ?? 0) + 1; out.caught++; out.serials.push(r.serial); }
      else if (r.status !== 'wip') { r.hold = null; out.ok++; }
      else out.left++;
    }
    return out;
  }
  // 봉쇄 해제 (남은 것) — 8D 종결·보류 때
  release(k) { const T = this.sim.trace; let n = 0; for (const r of T?.recent ?? []) if (r.hold === `containment:${k.id}`) { r.hold = null; n++; } return n; }
  // 정책 적용 · 이력
  apply(p, k, by) {
    const s = this.sim, m = s.mode;
    const pol = { id: `POL-${String(++this.pseq).padStart(3, '0')}`, t: s.time, capa: k?.id ?? null, title: p.title, lever: p.lever, from: p.from ?? null, to: p.to ?? null, by, status: 'applied', applied: p.lever !== 'text', effect: null };
    if (p.lever === 'pmThreshold') m.pmThreshold = p.to;
    else if (p.lever === 'cpkMin') m.cpkMin = p.to;
    else if (p.lever?.startsWith('envComp.')) s.qpolicy.envComp[p.key] = true;
    this.policies.unshift(pol);
    s.log?.('act', `운영 정책 반영 · ${pol.id}`, { obs: k ? `${k.id} ${k.cause.label}` : '', dec: p.title, act: by });
    return pol;
  }
  revert(id) {
    const s = this.sim, m = s.mode, pol = this.policies.find((x) => x.id === id); if (!pol || pol.status !== 'applied') return false;
    if (pol.lever === 'pmThreshold') m.pmThreshold = pol.from;
    else if (pol.lever === 'cpkMin') m.cpkMin = pol.from;
    else if (pol.lever?.startsWith('envComp.')) delete s.qpolicy.envComp[pol.lever.split('.')[1]];
    pol.status = 'reverted'; pol.tRevert = s.time;
    s.log?.('info', `운영 정책 되돌림 · ${pol.id}`, { dec: pol.title });
    return true;
  }
  // 현재 적용 중인 품질 정책 값
  current() {
    const m = this.sim.mode, E = this.sim.qpolicy.envComp;
    return [
      ['예지정비 착수 건강도', m.pmEnabled ? `${m.pmThreshold}%` : '— (레거시: 예지정비 없음)'],
      ['재보정 시작 Cpk', `${m.cpkMin ?? 1.15}`],
      ['환경 인터록 (공정 보상)', Object.keys(E).length ? Object.keys(E).map((k) => ENV_SPEC[k].label).join(' · ') : '없음'],
    ];
  }
}
const clk = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export { FACTOR };
