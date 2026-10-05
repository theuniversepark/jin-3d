// KPI 영향 분석 · 개선 제안 · 의사결정 지원
// 1) 영향 분석: 매 틱 셀마다 "가동하지 못한 시간"을 원인(설비 고장 · 예지정비 · 재보정 · 부품 결품 · 자재 공급 차질 · 진로 현장 이벤트 ·
//    정지·감속 명령 · 흐름 대기 · 사이클 속도)으로 나눠 쌓는다. 자재대기·막힘은 그 원인을 만든 셀(상류 정지 → 하류 자재대기)이나 이벤트로 넘긴다.
//    셀마다 병목 대비 가중치(실효 사이클 / 병목 사이클)를 곱해, 병목이 아닌 셀의 대기는 덜 무겁게 센다.
// 2) KPI 반영: 이론 생산량(시간 / 기준 사이클)과 실제 양품의 차이(손실 대수)를 품질 불량(검출·유출) + 원인별 가중 손실시간 비례로 나눈다.
//    → 원인별 손실 대수 · UPH 손실 · OEE 손실(%p, 합 + OEE = 100%) · 재공 증가(원인별로 붙잡힌 대상물 평균) · 전력 낭비(정지 셀 대기전력 · 진로 대기 로봇)와
//    kWh/개 영향(그 손실이 없었다면 kWh/개).
// 3) 개선 제안: 원인별 손실이 기준을 넘으면 실제 운영 파라미터(레버)를 바꾸는 제안을 만든다. 근거 수치 · 기대 효과 · 부작용(트레이드오프)을 함께 낸다.
// 4) 의사결정 지원: 제안마다 디지털트윈(같은 라인·운영값 · 같은 현장 이벤트 재연, 현재 vs 제안 × 시드 2)으로 효과를 검증하고
//    "적용하시겠습니까?"를 묻는다. 적용하면 운영값을 바꾸고 10분 동안 실측 효과(적용 전 10분 대비)를 확인하며, 되돌리기를 지원한다.
import { Simulation, FIELD_EVENTS } from './sim.js';
import { FactoryAgent } from './agent.js';

export const CAUSES = {
  failure: { label: '설비 고장', icon: '⚠️' },
  pm:      { label: '예지정비', icon: '🔧' },
  cal:     { label: '재보정', icon: '📐' },
  parts:   { label: '부품 결품', icon: '📦' },
  supply:  { label: '자재 공급 차질', icon: '🚚' },
  hazard:  { label: '진로 현장 이벤트', icon: '🛢️' },
  command: { label: '정지·감속 명령', icon: '🛑' },
  flow:    { label: '흐름·밸런스 대기', icon: '⏳' },
  speed:   { label: '사이클 속도 손실', icon: '🐢' },
  quality: { label: '품질 불량', icon: '❌' },
};
const KEYS = Object.keys(CAUSES);
const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));
const SNAP_S = 30, SNAP_KEEP = 480;           // 30초마다 누적값 스냅샷 (4시간)
export const TWIN_S = 1800, TWIN_SEEDS = [7, 19, 31];   // 트윈 검증: 30분 × 시드 3 × (현재 · 제안)
export const VERIFY_S = 600;                  // 적용 후 실측 확인 10분
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

const stopCause = (st) => {
  switch (st.state) {
    case 'DOWN': return 'failure';
    case 'MAINT': return st.maintKind === 'pm' ? 'pm' : st.maintKind === 'cal' ? 'cal' : 'failure';
    case 'NOPARTS': return 'parts';
    case 'CSTOP': case 'ESTOP': case 'PSTOP': return 'command';
    default: return null;
  }
};
const idleKW = (st) => (st.state === 'DOWN' || st.state === 'MAINT' ? st.def.idleKW * 0.5 : st.powerSave ? st.def.idleKW * 0.3 : st.def.idleKW);

export class ImpactTracker {
  constructor(sim) {
    this.sim = sim;
    this.w = zero(); this.sec = zero(); this.wipInt = zero(); this.kwh = zero();
    this.n = zero();                  // 원인별 발생 건수 (셀 정지 시작 · 이벤트)
    this.events = [];                 // 개별 이벤트 영향 (최근 60건)
    this.open = new Map();            // 셀별 진행 중 정지 이벤트
    this.evRows = new Map();          // 현장 이벤트 id → 영향 행
    this.hzMoverSec = 0;              // 진로 이벤트로 멈춰 기다린 로봇 시간(대·초)
    this.snaps = []; this.nextSnap = 0;
    this.advisor = new Advisor(sim, this);
  }
  cells() { return this.sim.processing.filter((st) => !st.standby); }
  eff(st) { return st.def.cycle * this.sim.mode.cycleMul * (st.def.share ?? 1); }

  tick(dt) {
    const s = this.sim; if (dt <= 0) return;
    const cells = this.cells(); if (!cells.length) return;
    const maxEff = Math.max(...cells.map((st) => this.eff(st))); this.maxEff = maxEff;
    const K = s.cmd, halt = K.estopAll || K.pstopAll;
    // 진로 이벤트로 붙잡힌 대상물(라인 위 운반 AMR)·이동 로봇
    const hzEvs = []; let hzItems = 0, hzMovers = 0;
    for (const c of s.conveyors) for (const it of c.items) if (it.hzWait) { hzItems++; if (it.hzEv) hzEvs.push(it.hzEv); }
    for (const m of s.movers) if (m.hzWait) { hzMovers++; hzEvs.push(m.hzWait.ev); }
    const hzUniq = [...new Set(hzEvs)];
    this.hzMoverSec += hzMovers * dt;
    const stopped = cells.filter((st) => stopCause(st));
    const credit = (c, w, by, ev) => {
      this.w[c] += w;
      if (by && this.open.get(by)) this.open.get(by).w += w;
      if (c === 'hazard') { const evs = ev ? [ev] : hzUniq; for (const e of evs) { const row = this.evRow(e); if (row) row.w += w / evs.length; } }
    };
    for (const st of cells) {
      const w = this.eff(st) / maxEff;
      let c = stopCause(st), by = c ? st : null;
      // 셀 정지 이벤트 열기·닫기
      const cur = this.open.get(st);
      if (c && (!cur || cur.cause !== c)) { if (cur) this.closeStop(st); this.open.set(st, this.pushEvent({ cause: c, where: st.name, t0: s.time, w: 0, sec: 0 })); this.n[c]++; }
      else if (!c && cur) this.closeStop(st);
      if (st.state === 'BUSY') {
        const sp = Math.max(0, 1 - 0.9 / (s.mode.cycleMul * (st.speedMul ?? 1)));
        if (sp > 0) credit('speed', w * dt * sp);
        if (K.lineSpeed < 1) credit('command', w * dt * (1 - K.lineSpeed));
        continue;
      }
      if (!c) {
        if (halt) c = 'command';
        else if (st.state === 'BLOCKED') { by = stopped.find((o) => o.idx > st.idx) ?? null; c = by ? stopCause(by) : hzItems ? 'hazard' : 'flow'; }
        else if (s.supplyAlarm) c = 'supply';
        else if (hzItems) c = 'hazard';
        else { by = stopped.find((o) => o.idx < st.idx) ?? null; c = by ? stopCause(by) : 'flow'; }
      }
      credit(c, w * dt, by);
      this.sec[c] += dt;
      this.kwh[c] += (idleKW(st) * dt) / 3600;
      if (st.item) this.wipInt[c] += dt;
      if (this.open.get(st)) this.open.get(st).sec += dt;
    }
    if (hzItems) this.wipInt.hazard += hzItems * dt;
    if (hzMovers) this.kwh.hazard += (hzMovers * 0.15 * dt) / 3600;   // 진로 대기 로봇 대기전력
    for (const ev of s.fieldEvents ?? []) if (ev.affected?.size && !this.evRows.has(ev.id)) { this.evRow(ev); this.n.hazard++; }
    if (s.time >= this.nextSnap) { this.nextSnap = s.time + SNAP_S; this.snapshot(); }
    if (!s.twin) this.advisor.tick(dt);
  }
  evRow(ev) {
    if (!ev) return null;
    let row = this.evRows.get(ev.id);
    if (!row) { row = this.pushEvent({ cause: 'hazard', where: `${FIELD_EVENTS[ev.type]?.label ?? '현장 이벤트'} · x ${ev.x.toFixed(1)}, z ${ev.z.toFixed(1)}`, t0: ev.t0, w: 0, sec: 0, ev }); this.evRows.set(ev.id, row); }
    return row;
  }
  pushEvent(e) { this.events.unshift(e); if (this.events.length > 60) { const old = this.events.pop(); if (old.ev) this.evRows.delete(old.ev.id); } return e; }
  closeStop(st) { const e = this.open.get(st); if (e) e.t1 = this.sim.time; this.open.delete(st); }
  snapshot() {
    const s = this.sim;
    this.snaps.push({ t: s.time, w: { ...this.w }, wipInt: { ...this.wipInt }, kwh: { ...this.kwh }, good: s.stats.good, bad: s.stats.rejected + s.stats.escaped, energy: s.stats.energy, wipTot: s.stats.wipInt, hz: this.hzMoverSec });
    if (this.snaps.length > SNAP_KEEP) this.snaps.shift();
  }
  // 구간 [t0, now] 누적값 (window 초 · 0이면 처음부터)
  span(window = 0) {
    const s = this.sim, now = { t: s.time, w: this.w, wipInt: this.wipInt, kwh: this.kwh, good: s.stats.good, bad: s.stats.rejected + s.stats.escaped, energy: s.stats.energy, wipTot: s.stats.wipInt, hz: this.hzMoverSec };
    const base = window > 0 ? [...this.snaps].reverse().find((x) => x.t <= s.time - window) ?? this.snaps[0] : null;
    if (!base) return { ...now, t0: 0 };
    const d = (a, b) => Object.fromEntries(KEYS.map((k) => [k, a[k] - (b[k] ?? 0)]));
    return { t0: base.t, t: now.t, w: d(now.w, base.w), wipInt: d(now.wipInt, base.wipInt), kwh: d(now.kwh, base.kwh), good: now.good - base.good, bad: now.bad - base.bad, energy: now.energy - base.energy, wipTot: now.wipTot - base.wipTot, hz: now.hz - base.hz };
  }

  // 원인별 영향 (window: 최근 N초, 0 = 전체)
  report(window = 0) {
    const s = this.sim, sp = this.span(window), T = Math.max(1, sp.t - sp.t0), ic = s.idealCycle;
    const ideal = T / ic, loss = Math.max(0, ideal - sp.good), qU = Math.min(loss, sp.bad), rem = loss - qU;
    const W = { ...sp.w, quality: 0 }, sumW = KEYS.reduce((a, k) => a + W[k], 0) || 1;
    const units = Object.fromEntries(KEYS.map((k) => [k, k === 'quality' ? qU : (rem * W[k]) / sumW]));
    const H = T / 3600, E = sp.energy, good = Math.max(1, sp.good);
    const rows = KEYS.map((k) => {
      const u = units[k], kwh = sp.kwh[k];
      return { key: k, ...CAUSES[k], units: u, uph: u / H, oeePts: (u * ic) / T, wip: sp.wipInt[k] / T, kwh, kwhUnitGain: E / good - (E - kwh) / (good + u), count: k === 'quality' ? sp.bad : this.n[k] };
    }).sort((a, b) => b.oeePts - a.oeePts);
    const oee = Math.min(1, (sp.good * ic) / T), uph = sp.good / H, avgWip = sp.wipTot / T, avgKW = E / H, kwhPerUnit = E / good;
    return {
      window, T, ideal, loss, good: sp.good, rows, unitPerW: rem / sumW,
      kpi: { uph, uphIdeal: 3600 / ic, oee, avgWip, avgKW, kwhPerUnit, energy: E, wasteKwh: KEYS.reduce((a, k) => a + sp.kwh[k], 0) },
      hazardMoverSec: sp.hz,
      events: this.events.filter((e) => (e.t1 ?? s.time) >= sp.t0).slice(0, 25).map((e) => ({ ...e, units: e.w * (rem / sumW), dur: (e.t1 ?? (e.ev ? (e.ev.cleared ? e.ev.tClear : s.time) : s.time)) - e.t0, open: e.ev ? !e.ev.cleared : e.t1 == null, affected: e.ev?.affected?.size ?? 0 })),
    };
  }
}

// ── 개선 레버: 실제 운영 파라미터 ─────────────────
export const LEVERS = {
  pmThreshold:  { label: '예지정비 시작 건강도', unit: '%', get: (s) => s.mode.pmThreshold, set: (s, v) => { s.mode.pmThreshold = v; }, ok: (s) => s.mode.pmEnabled && s.mode.agentActive },
  alarmDelay:   { label: '고장 발견·호출 지연', unit: '초', get: (s) => s.mode.alarmDelay ?? 0, set: (s, v) => { s.mode.alarmDelay = v; }, ok: (s) => !s.mode.agentActive && (s.mode.alarmDelay ?? 0) > 5 },
  orchLatency:  { label: '인시던트 판단 지연', unit: '초', get: (s) => s.orch.latency, set: (s, v) => { s.mode.orchLatency = v; }, ok: (s) => s.orch.latency > 0.6 },
  reorderPoint: { label: '자재 재주문점', unit: '개', get: (s) => s.mode.reorderPoint, set: (s, v) => { s.mode.reorderPoint = v; }, ok: () => true },
  releaseMargin:{ label: '투입 간격 배율 (병목 사이클 대비)', unit: '×', get: (s) => s.mode.releaseMargin ?? 0.98, set: (s, v) => { s.mode.releaseMargin = v; }, ok: (s) => s.mode.agentActive },
  releaseInterval: { label: '투입 간격 (고정)', unit: '초', get: (s) => s.releaseInterval, set: (s, v) => { s.releaseInterval = v; s.mode.releaseInterval = v; }, ok: (s) => !s.mode.agentActive },
  amrStage:     { label: 'AMR 선행 배차', unit: '대', get: (s) => s.mode.amrStage ?? 1, set: (s, v) => { s.mode.amrStage = v; }, ok: (s) => !!s.useAMR },
  ecoWait:      { label: '셀 절전 진입 대기', unit: '초', get: (s) => s.mode.ecoWait ?? 25, set: (s, v) => { s.mode.ecoWait = v; }, ok: (s) => s.mode.agentActive },
  cpkMin:       { label: '재보정 시작 Cpk', unit: '', get: (s) => s.mode.cpkMin ?? 1.15, set: (s, v) => { s.mode.cpkMin = v; }, ok: (s) => s.mode.agentActive },
};
const AIOS_KEYS = ['amrStage', 'ecoWait', 'orchLatency'];
const fmtV = (k, v) => `${k === 'releaseMargin' || k === 'cpkMin' ? v.toFixed(2) : r1(v)}${LEVERS[k].unit}`;

// 원인별 손실 → 제안 규칙 (pts: OEE %p, 근거 문장은 측정값으로 채움)
function rules(s, R) {
  const by = Object.fromEntries(R.rows.map((r) => [r.key, r])), P = (k) => by[k].oeePts * 100, out = [];
  const add = (lever, to, p) => { const L = LEVERS[lever]; if (!L.ok(s)) return; const from = L.get(s); if (Math.abs(to - from) < 1e-6) return; out.push({ lever, from, to, ...p }); };
  const fail = P('failure'), maint = P('pm') + P('cal'), sup = P('supply'), hz = P('hazard'), flow = P('flow'), q = P('quality'), cmdP = P('command');
  if (fail >= 0.3) {
    add('pmThreshold', Math.min(75, s.mode.pmThreshold + 6), { kpi: ['OEE', 'UPH'], title: '예지정비를 더 일찍 시작', est: `OEE 최대 +${r1(fail * 0.4)}%p · UPH +${r1(by.failure.uph * 0.4)} (고장 손실의 약 40%)`, why: `설비 고장으로 OEE −${r1(fail)}%p · UPH −${r1(by.failure.uph)} (고장 ${by.failure.count}건)`, expect: `고장 정지(긴급수리 ${s.mode.repairTime}초)를 계획 정비(${s.mode.pmTime}초)로 바꿔 고장 손실의 일부 회수`, trade: '예지정비 횟수 증가 — 정비 시간 소폭 증가' });
    add('alarmDelay', Math.max(5, Math.round((s.mode.alarmDelay ?? 0) * 0.3)), { kpi: ['OEE', 'UPH'], title: '설비 알람 자동 호출 (안돈)', est: `OEE 최대 +${r1(fail * 0.25)}%p (발견 지연분)`, why: `고장 발견까지 평균 ${s.mode.alarmDelay}초 — 설비 고장 OEE −${r1(fail)}%p`, expect: '정지 시간 = 발견 지연 + 수리 → 발견 지연 단축', trade: '알람 장치 · 호출 체계 필요' });
  }
  if (fail + maint + hz >= 0.6) add('orchLatency', Math.max(0.5, r1(s.orch.latency * 0.5)), { kpi: ['OEE', 'UPH', 'WIP'], title: '인시던트 판단·출동 지연 단축', est: `OEE 최대 +${r1((fail + maint + hz) * 0.1)}%p`, why: `고장·정비·진로 이벤트 손실 합 OEE −${r1(fail + maint + hz)}%p · 판단 지연 ${r1(s.orch.latency)}초`, expect: '보고 → 판단 → 출동이 빨라져 정지·대기 시간 단축', trade: '판단 근거 수집 시간 감소 (오판 위험 소폭)' });
  if (sup >= 0.2) add('reorderPoint', Math.min(28, s.mode.reorderPoint + 4), { kpi: ['UPH', 'OEE'], title: '자재 재주문점 상향 (안전재고)', est: `OEE 최대 +${r1(sup * 0.6)}%p · UPH +${r1(by.supply.uph * 0.6)}`, why: `자재 공급 차질로 OEE −${r1(sup)}%p · 자재대기 ${Math.round(by.supply.count || 0)}건`, expect: '투입구 재고가 일찍 보충돼 공급 차질 중에도 라인 유지', trade: '자재 재고 증가 (보관 공간 · 재고 비용)' });
  if (hz >= 0.15 || R.hazardMoverSec > 60) {
    add('orchLatency', Math.max(0.5, r1(s.orch.latency * 0.5)), { kpi: ['UPH', 'WIP'], title: '진로 이벤트 대응 출동 앞당김', est: `진로 대기 약 −20% · OEE +${r2(hz * 0.2)}%p`, why: `진로 현장 이벤트로 OEE −${r1(hz)}%p · 재공 +${r2(by.hazard.wip)} · 로봇 정지 대기 ${Math.round(R.hazardMoverSec)}대·초`, expect: '정비 휴머노이드가 빨리 출동해 이벤트가 빨리 해결 → 대기 로봇·라인 AMR 재개', trade: '판단 지연 단축' });
  }
  if (flow >= 3 && R.kpi.avgWip < 2.2 * s.processing.length) {
    if (s.mode.agentActive) add('releaseMargin', Math.max(0.9, r2((s.mode.releaseMargin ?? 0.98) - 0.04)), { kpi: ['UPH', 'OEE'], title: '투입 간격 단축 (자재대기 감소)', est: `UPH 최대 +${r1(by.flow.uph * 0.15)} · WIP +${r1(R.kpi.avgWip * 0.1)}`, why: `흐름·밸런스 대기로 OEE −${r1(flow)}%p · 평균 재공 ${r1(R.kpi.avgWip)}개`, expect: '병목 셀이 자재를 기다리는 시간 감소 → 처리량 증가', trade: '재공(WIP) 증가' });
    else add('releaseInterval', r1(s.releaseInterval * 0.92), { kpi: ['UPH', 'OEE'], title: '투입 간격 단축', why: `흐름 대기로 OEE −${r1(flow)}%p`, expect: '자재대기 감소', trade: 'WIP 증가 · 막힘 위험' });
    if (s.useAMR && (s.mode.amrStage ?? 1) < 2) add('amrStage', 2, { kpi: ['UPH'], title: 'AMR 선행 배차', est: `UPH 최대 +${r1(by.flow.uph * 0.05)}`, why: `흐름 대기 OEE −${r1(flow)}%p — 투입 스테이션 빈 AMR 대기`, expect: '다음 AMR을 미리 불러 투입 대기 감소', trade: 'AMR 대기 위치 점유' });
  }
  const blockedHeavy = R.kpi.avgWip > 2.5 * s.processing.length;
  if (blockedHeavy) {
    if (s.mode.agentActive) add('releaseMargin', Math.min(1.12, r2((s.mode.releaseMargin ?? 0.98) + 0.05)), { kpi: ['WIP', 'POWER'], title: '투입 속도 낮춰 재공 감축', est: `WIP 약 −${r1(R.kpi.avgWip * 0.15)}개`, why: `평균 재공 ${r1(R.kpi.avgWip)}개 (셀당 ${r1(R.kpi.avgWip / s.processing.length)}개)`, expect: "리틀의 법칙: 처리량이 같으면 재공 ↓ = 리드타임 ↓", trade: 'UPH 소폭 감소 가능' });
    else add('releaseInterval', r1(s.releaseInterval * 1.08), { kpi: ['WIP'], title: '투입 간격 늘려 재공 감축', why: `평균 재공 ${r1(R.kpi.avgWip)}개`, expect: '재공·리드타임 감소', trade: 'UPH 감소 가능' });
  }
  const idleWaste = by.flow.kwh + by.supply.kwh + by.hazard.kwh + by.parts.kwh;
  if (R.kpi.energy > 0 && idleWaste / R.kpi.energy > 0.02 && (s.mode.ecoWait ?? 25) > 8) add('ecoWait', Math.max(8, Math.round((s.mode.ecoWait ?? 25) * 0.5)), { kpi: ['POWER'], title: '셀 절전 진입 앞당김', est: `대기 낭비 약 −${r1(idleWaste * 0.35)}kWh · kWh/개 −${(idleWaste * 0.35 / Math.max(1, R.good)).toFixed(4)}`, why: `대기 셀 전력 낭비 ${r1(idleWaste)}kWh (전체의 ${r1((idleWaste / R.kpi.energy) * 100)}%)`, expect: '자재대기가 짧게 이어져도 대기전력 70% 절감 → kWh/개 감소', trade: '절전 해제 시 재기동 (생산 영향 없음)' });
  if (q >= 0.4) add('cpkMin', Math.min(1.3, r2((s.mode.cpkMin ?? 1.15) + 0.08)), { kpi: ['OEE'], title: '재보정 기준 강화 (Cpk)', est: `OEE 최대 +${r1(q * 0.3)}%p (불량 감소)`, why: `품질 불량으로 OEE −${r1(q)}%p (검출·유출 ${Math.round(by.quality.units)}개)`, expect: '공정 편차를 더 일찍 보정해 불량 감소', trade: '재보정 횟수 증가' });
  if (cmdP >= 1) out.push({ lever: null, kpi: ['UPH', 'OEE'], title: '정지·감속 명령 해제 검토', why: `정지·감속 명령으로 OEE −${r1(cmdP)}%p`, expect: '안전 확인 후 정상 속도 복귀', trade: '안전 확인 필요 (자동 적용 안 함)' });
  // 같은 레버는 하나로 (근거를 합친다)
  const m = new Map();
  for (const p of out) { const k = p.lever ?? p.title; if (!m.has(k)) m.set(k, p); else { const a = m.get(k); a.why += ` · ${p.why}`; a.kpi = [...new Set([...a.kpi, ...p.kpi])]; } }
  return [...m.values()];
}

// ── 의사결정 지원: 제안 → 트윈 검증 → "적용하시겠습니까?" → 적용 · 보류 → 실측 효과 → 되돌리기 ─────────────────
export class Advisor {
  constructor(sim, tracker) {
    this.sim = sim; this.tr = tracker; this.items = []; this.seq = 0; this.next = 120; this.job = null; this.held = new Map();
    this.log = [];   // 의사결정 이력
  }
  get pending() { return this.items.filter((p) => p.status === 'new' || p.status === 'verified' || p.status === 'verifying'); }
  tick() {
    const s = this.sim;
    if (s.time >= this.next) { this.next = s.time + 60; this.refresh(); }
    // 화면 운영(헤드리스 시험 아님): 새 제안은 차례로 디지털트윈 검증까지 미리 돌려 두고 적용 여부를 묻는다
    if (!this.job && !s.quiet) { const p = this.items.find((x) => x.status === 'new' && x.lever && !x.twin); if (p) this.verify(p.id); }
    if (this.job) this.work();
    for (const p of this.items) if (p.status === 'applied' && s.time - p.tApply >= VERIFY_S && !p.measured) this.measure(p);
  }
  refresh() {
    const s = this.sim; if (s.time < 300) return;
    const R = this.tr.report(1800);
    const fresh = rules(s, R);
    for (const f of fresh) {
      const key = f.lever ?? f.title;
      if (this.items.some((p) => (p.lever ?? p.title) === key && ['new', 'verifying', 'verified'].includes(p.status))) {
        // 근거는 최신 측정값으로, 운영값이 바뀌었으면(AIOS 배포 등) 변경 폭도 다시 잡고 트윈 결과는 무효
        const p = this.items.find((x) => (x.lever ?? x.title) === key && ['new', 'verified'].includes(x.status));
        if (p) { p.why = f.why; p.est = f.est; if (f.lever && (Math.abs(p.from - f.from) > 1e-6 || Math.abs(p.to - f.to) > 1e-6)) Object.assign(p, { from: f.from, to: f.to, status: 'new', twin: null }); }
        continue;
      }
      if (this.items.some((p) => (p.lever ?? p.title) === key && p.status === 'applied' && !p.measured)) continue;   // 적용 효과 확인 중
      if ((this.held.get(key) ?? -1e9) > s.time - 1800) continue;   // 보류 30분 동안 다시 묻지 않음
      this.items.unshift({ id: ++this.seq, ...f, status: 'new', t: s.time });
    }
    // 근거가 사라진 제안(손실이 기준 아래로)은 정리
    for (const p of this.items) if (p.status === 'new' && !fresh.some((f) => (f.lever ?? f.title) === (p.lever ?? p.title))) p.status = 'stale';
    this.items = this.items.filter((p) => p.status !== 'stale').slice(0, 30);
  }
  find(id) { return this.items.find((p) => p.id === +id); }

  // 트윈 검증: 현재 운영값 vs 제안 운영값, 실제 공장에서 일어난 현장 이벤트를 같은 간격으로 재연
  verify(id) {
    const p = this.find(id); if (!p || !p.lever || this.job) return false;
    const s = this.sim, base = { ...s.mode }, rel = s.releaseInterval;
    const recent = (s.fieldLog ?? []).slice(-6), gap = recent.length > 1 ? Math.min(450, Math.max(150, (recent.at(-1).t0 - recent[0].t0) / (recent.length - 1))) : 300;
    const evs = recent.map((e, i) => ({ type: e.type, x: e.x, z: e.z, at: 120 + i * gap })).filter((e) => e.at < TWIN_S - 60);
    const mk = (cand, seed) => {
      const t = new Simulation(s.mode.key, seed, { line: s.line, quiet: true, twin: true });
      Object.assign(t.mode, base); t.releaseInterval = rel;
      if (cand) LEVERS[p.lever].set(t, p.to);
      return { sim: t, agent: new FactoryAgent(t), evs: evs.map((e) => ({ ...e })) };
    };
    p.status = 'verifying'; p.progress = 0;
    this.job = { p, runs: TWIN_SEEDS.flatMap((sd) => [{ who: 'cur', ...mk(false, sd) }, { who: 'cand', ...mk(true, sd) }]), i: 0 };
    return true;
  }
  work() {
    const J = this.job, budget = this.sim.quiet ? Infinity : 5, t0 = performance.now();
    while (J.i < J.runs.length && performance.now() - t0 < budget) {
      const r = J.runs[J.i];
      for (let n = 0; n < 200 && r.sim.time < TWIN_S - 1e-6; n++) {
        r.sim.step(0.1); r.agent.update(0.1);
        while (r.evs.length && r.sim.time >= r.evs[0].at) { const e = r.evs.shift(); r.sim.injectFieldEvent(e.type, e.x, e.z); }
      }
      if (r.sim.time >= TWIN_S - 1e-6) { const k = r.sim.kpi(); r.res = { good: k.good, oee: k.OEE, wip: k.avgWip, kwh: k.energy }; r.sim = r.agent = null; J.i++; }
    }
    J.p.progress = (J.i + (J.runs[J.i]?.sim ? J.runs[J.i].sim.time / TWIN_S : 0)) / J.runs.length;
    if (J.i < J.runs.length) return;
    const sum = (who) => { const rs = J.runs.filter((r) => r.who === who); const n = rs.length; return { good: rs.reduce((a, r) => a + r.res.good, 0), oee: rs.reduce((a, r) => a + r.res.oee, 0) / n, wip: rs.reduce((a, r) => a + r.res.wip, 0) / n, kwh: rs.reduce((a, r) => a + r.res.kwh, 0) }; };
    const c = sum('cur'), d = sum('cand'), h = (TWIN_S / 3600) * TWIN_SEEDS.length;
    const T = { uphCur: c.good / h, uphCand: d.good / h, oeeCur: c.oee, oeeCand: d.oee, wipCur: c.wip, wipCand: d.wip, kwhCur: c.kwh / Math.max(1, c.good), kwhCand: d.kwh / Math.max(1, d.good), kwCur: c.kwh / h, kwCand: d.kwh / h };
    // 판정: 목표 KPI 개선 + 다른 KPI 크게 나빠지지 않음
    const dU = (T.uphCand - T.uphCur) / Math.max(1, T.uphCur), dO = T.oeeCand - T.oeeCur, dW = (T.wipCand - T.wipCur) / Math.max(0.5, T.wipCur), dE = (T.kwhCand - T.kwhCur) / Math.max(1e-6, T.kwhCur);
    const score = dU * 1 + dO * 1 - dW * 0.25 - dE * 0.5;
    T.recommend = score > 0.002 && dU > -0.02 ? 'apply' : score > -0.002 ? 'neutral' : 'hold';
    Object.assign(J.p, { twin: T, status: 'verified' });
    this.job = null;
  }
  // 적용: 운영값 변경 · 오케스트레이터 로그 · 실측 기준 시점
  apply(id) {
    const p = this.find(id), s = this.sim; if (!p || !p.lever || p.status === 'applied') return false;
    if (this.job?.p === p) this.job = null;
    p.from = LEVERS[p.lever].get(s);
    LEVERS[p.lever].set(s, p.to);
    if (AIOS_KEYS.includes(p.lever) && s.aios?.policy) s.aios.policy[p.lever] = p.to;   // AIOS 기준 정책도 맞춘다
    p.status = 'applied'; p.tApply = s.time; p.before = this.windowKpi(s.time - VERIFY_S, s.time);
    s.log('act', `개선안 적용 · ${p.title}`, { obs: p.why, dec: '운영자 승인 (의사결정 지원)', act: `${LEVERS[p.lever].label} ${fmtV(p.lever, p.from)} → ${fmtV(p.lever, p.to)}` });
    this.log.unshift({ t: s.time, act: '적용', title: p.title, change: `${fmtV(p.lever, p.from)} → ${fmtV(p.lever, p.to)}` });
    return true;
  }
  hold(id) {
    const p = this.find(id); if (!p) return false;
    if (this.job?.p === p) this.job = null;
    p.status = 'held'; this.held.set(p.lever ?? p.title, this.sim.time);
    this.log.unshift({ t: this.sim.time, act: '보류', title: p.title });
    return true;
  }
  revert(id) {
    const p = this.find(id), s = this.sim; if (!p || p.status !== 'applied') return false;
    LEVERS[p.lever].set(s, p.from);
    if (AIOS_KEYS.includes(p.lever) && s.aios?.policy) s.aios.policy[p.lever] = p.from;
    p.status = 'reverted';
    s.log('warn', `개선안 되돌림 · ${p.title}`, { act: `${LEVERS[p.lever].label} ${fmtV(p.lever, p.to)} → ${fmtV(p.lever, p.from)}` });
    this.log.unshift({ t: s.time, act: '되돌림', title: p.title, change: `${fmtV(p.lever, p.to)} → ${fmtV(p.lever, p.from)}` });
    return true;
  }
  // 구간 KPI (스냅샷 차이)
  windowKpi(a, b) {
    const S = this.tr.snaps, s = this.sim;
    const at = (t) => [...S].reverse().find((x) => x.t <= t) ?? S[0];
    const A = at(a), B = b >= s.time ? { t: s.time, good: s.stats.good, energy: s.stats.energy, wipTot: s.stats.wipInt } : at(b);
    if (!A || !B || B.t - A.t < 60) return null;
    const T = B.t - A.t, good = B.good - A.good, E = B.energy - A.energy;
    return { T, uph: good / (T / 3600), oee: Math.min(1, (good * s.idealCycle) / T), wip: (B.wipTot - A.wipTot) / T, kw: E / (T / 3600), kwhUnit: E / Math.max(1, good) };
  }
  measure(p) {
    p.after = this.windowKpi(p.tApply, p.tApply + VERIFY_S); p.measured = true;
    const b = p.before, a = p.after;
    if (b && a) this.sim.log('ok', `개선안 실측 · ${p.title}`, { obs: `적용 전 10분 UPH ${Math.round(b.uph)} · OEE ${(b.oee * 100).toFixed(1)}% · WIP ${b.wip.toFixed(1)} · ${b.kw.toFixed(0)}kW → 적용 후 UPH ${Math.round(a.uph)} · OEE ${(a.oee * 100).toFixed(1)}% · WIP ${a.wip.toFixed(1)} · ${a.kw.toFixed(0)}kW` });
  }
}
export { fmtV };

// ── 리포트 (Markdown) ─────────────────
export function impactMarkdown(sim, window = 0) {
  const tr = sim.impact, R = tr.report(window), K = R.kpi, A = tr.advisor;
  const pct = (v) => `${(v * 100).toFixed(1)}%`, n1 = (v) => v.toFixed(1), hm = (t) => `${Math.floor(t / 3600)}시간 ${Math.floor((t % 3600) / 60)}분`;
  const L = [];
  L.push(`# KPI 영향 분석 · 개선 리포트`, '', `- 공장: ${sim.mode.label} · 분석 구간: ${window ? `최근 ${Math.round(window / 60)}분` : `전체 ${hm(R.T)}`}`, `- 기준 사이클 ${sim.idealCycle.toFixed(2)}초 → 이론 UPH ${Math.round(K.uphIdeal)} · 이론 생산 ${Math.round(R.ideal)}개 · 실제 양품 ${R.good}개 · 손실 ${Math.round(R.loss)}개`, '');
  L.push('## 1. KPI 현황', '', '| KPI | 값 | 비고 |', '|---|---|---|',
    `| UPH | ${Math.round(K.uph)} | 이론 ${Math.round(K.uphIdeal)} 대비 ${pct(K.uph / K.uphIdeal)} |`,
    `| OEE | ${pct(K.oee)} | 손실 ${pct(1 - K.oee)} — 아래 원인별로 배분 |`,
    `| WIP (평균) | ${n1(K.avgWip)}개 | 원인별 붙잡힌 대상물 합 ${n1(R.rows.reduce((a, r) => a + r.wip, 0))}개 |`,
    `| POWER (평균) | ${K.avgKW.toFixed(0)}kW · ${K.kwhPerUnit.toFixed(2)}kWh/개 | 정지·대기 낭비 ${n1(K.wasteKwh)}kWh (${pct(K.wasteKwh / Math.max(1e-6, K.energy))}) |`, '');
  L.push('## 2. 원인별 영향 (UPH · OEE · WIP · POWER)', '', '| 원인 | 건수 | 손실 대수 | UPH 손실 | OEE 손실 | WIP 증가 | 전력 낭비 | kWh/개 영향 |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of R.rows) if (r.units > 0.05 || r.kwh > 0.01) L.push(`| ${r.icon} ${r.label} | ${r.count || '-'} | ${n1(r.units)} | −${n1(r.uph)} | −${(r.oeePts * 100).toFixed(2)}%p | +${r.wip.toFixed(2)} | ${r.kwh.toFixed(2)}kWh | −${r.kwhUnitGain.toFixed(3)} |`);
  L.push('', `> 손실 대수 = 이론 생산 − 양품. 품질 불량(검출·유출)을 먼저 떼고, 나머지를 원인별 병목 가중 손실시간 비례로 나눴습니다. OEE 손실 합 + OEE = 100%. 진로 이벤트 로봇 정지 대기 ${Math.round(R.hazardMoverSec)}대·초.`, '');
  L.push('## 3. 이벤트별 영향 (최근)', '', '| 시각 | 원인 | 위치 | 지속 | 손실 대수 | 영향 로봇 |', '|---|---|---|---:|---:|---:|');
  for (const e of R.events.slice(0, 15)) L.push(`| ${hm(e.t0)} | ${CAUSES[e.cause].label} | ${e.where} | ${Math.round(e.dur)}초${e.open ? ' (진행 중)' : ''} | ${n1(e.units)} | ${e.affected || '-'} |`);
  L.push('', '## 4. 개선 방법 · 제안', '');
  if (!A.items.length) L.push('- 현재 기준을 넘는 손실이 없어 제안이 없습니다.');
  for (const p of A.items) {
    L.push(`### ${p.title} — ${p.kpi.join(' · ')} [${{ new: '결정 대기', verifying: '트윈 검증 중', verified: '검증 완료 · 결정 대기', applied: '적용됨', held: '보류', reverted: '되돌림' }[p.status]}]`);
    L.push(`- 근거: ${p.why}`);
    if (p.lever) L.push(`- 변경: ${LEVERS[p.lever].label} ${fmtV(p.lever, p.from)} → ${fmtV(p.lever, p.to)}`);
    L.push(`- 기대 효과: ${p.expect}${p.est ? ` — 추정 ${p.est}` : ''}`, `- 부작용: ${p.trade}`);
    if (p.twin) { const t = p.twin; L.push(`- 트윈 검증 (30분 × 시드 3): UPH ${Math.round(t.uphCur)} → ${Math.round(t.uphCand)} · OEE ${pct(t.oeeCur)} → ${pct(t.oeeCand)} · WIP ${n1(t.wipCur)} → ${n1(t.wipCand)} · ${t.kwhCur.toFixed(3)} → ${t.kwhCand.toFixed(3)}kWh/개 — ${{ apply: '적용 권장', neutral: '효과 미미', hold: '보류 권장' }[t.recommend]}`); }
    if (p.after && p.before) L.push(`- 실측 (적용 전/후 10분): UPH ${Math.round(p.before.uph)} → ${Math.round(p.after.uph)} · OEE ${pct(p.before.oee)} → ${pct(p.after.oee)} · WIP ${n1(p.before.wip)} → ${n1(p.after.wip)} · ${p.before.kw.toFixed(0)} → ${p.after.kw.toFixed(0)}kW`);
    L.push('');
  }
  if (A.log.length) { L.push('## 5. 의사결정 이력', ''); for (const x of A.log.slice(0, 20)) L.push(`- ${hm(x.t)} · ${x.act} · ${x.title}${x.change ? ` (${x.change})` : ''}`); }
  return L.join('\n');
}
