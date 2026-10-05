// 혼합형 다중 에이전트 (옵션) — 단일 자율운영 에이전트(agent.js FactoryAgent)와 같은 일을 세 층으로 나눠 한다.
// ① 반사 계층 (매 1초, 바로 실행): 자재 배차 · 절전 · AGV 충전 · 정지 설비 앞 투입 보류 — 빨라야 하는 판단은 규칙 그대로
// ② 도메인 에이전트 (각자 주기, 제안만): 정비(5초) · 품질(2초) · 흐름(3초) — 공장 상태 스냅샷을 보고 "제안 + 근거"를 메인에 올린다
// ③ 메인 조정자 (매 1초): 안전 우선순위(오케스트레이터 P1이면 예지정비·재보정 보류) → 상태 확인(이미 처리된 제안 정리) →
//    충돌 판정(병목 셀 가동 중 정비는 위급하지 않으면 대기 구간까지 미룸 · 정비 중·건강도 낮은 셀 고속 운전 거절 ·
//    투입 간격은 20초 안에 되돌리지 않음) → 승인한 제안만 실행. 제안 → 실행 지연 · 충돌 · 되돌림을 센다.
// 디지털트윈 비교(compareArchitectures): 같은 라인·시드·현장 이벤트로 단일 vs 혼합형을 실제로 돌려 UPH·OEE·WIP·kWh/개·판단 지연·충돌을 잰다.
import { FactoryAgent } from './agent.js';
import { Simulation } from './sim.js';

// ── 도메인 에이전트: 제안만 만든다 ─────────────────
const DOMAIN = {
  maint: {
    label: '정비 에이전트', period: 5,
    propose(s, m) {
      if (!m.pmEnabled) return [];
      const out = [];
      for (const st of s.processing) {
        if (st.request || st.state === 'DOWN' || st.state === 'MAINT' || st.health >= m.pmThreshold) continue;
        const a = s.assess(st);
        out.push({ kind: 'pm', st, prio: 5, critical: st.health <= m.pmThreshold - 7, why: `건강도 ${st.health.toFixed(0)}% · 10분 고장확률 ${(a.risk10 * 100).toFixed(0)}% · RUL ${a.rul.toFixed(0)}분` });
      }
      return out;
    },
  },
  quality: {
    label: '품질 에이전트', period: 2,
    propose(s, m) {
      const out = [];
      for (const st of s.processing) {
        if (st.def.inspect || st.request || st.state === 'DOWN' || st.state === 'MAINT') continue;
        const { cpk } = s.assess(st);
        if (cpk < (m.cpkMin ?? 1.15)) out.push({ kind: 'cal', st, prio: 5, why: `Cpk ${cpk.toFixed(2)}` });
      }
      return out;
    },
  },
  flow: {
    label: '흐름 에이전트', period: 3,
    propose(s, m, A) {
      const out = [];
      if (s.supplyDisrupted && A.disruptHandled < s.supplyDisruptedUntil) out.push({ kind: 'expedite', prio: 4, why: '창고 출고 중단' });
      let bott = null, bc = 0;
      for (const st of s.processing) { const c = st.def.cycle * m.cycleMul * st.speedMul * (st.def.share ?? 1); if (c > bc) { bc = c; bott = st; } }
      const target = +(bc * (m.releaseMargin ?? 0.98)).toFixed(2);
      if (Math.abs(target - s.releaseInterval) > 0.15) out.push({ kind: 'release', value: target, prio: 4, why: `병목 ${bott.name} ${bc.toFixed(1)}초` });
      let cand = null, cu = 0;
      for (const st of s.processing) { if (st.def.inspect) continue; const q = s.queueLen(st); if (st.ema > (m.boostUtil ?? 0.85) && q >= (m.boostQueue ?? 3) && st.ema > cu && st.health > 60) { cu = st.ema; cand = st; } }
      if (A.boosted && (A.boosted.health < 55 || (cand && cand !== A.boosted))) out.push({ kind: 'unboost', st: A.boosted, prio: 4, why: `건강도 ${A.boosted.health.toFixed(0)}%` });
      if (cand && cand !== A.boosted) out.push({ kind: 'boost', st: cand, prio: 5, why: `이용률 ${(cand.ema * 100).toFixed(0)}% · 대기열 ${s.queueLen(cand)}` });
      return out;
    },
  },
};

export class HybridAgent extends FactoryAgent {
  constructor(sim) {
    super(sim);
    this.arch = 'hybrid';
    this.agents = Object.entries(DOMAIN).map(([key, d]) => ({ key, ...d, next: 0, proposed: 0, approved: 0 }));
    this.queue = [];
    this.ma = { proposed: 0, approved: 0, deferred: 0, rejected: 0, stale: 0, conflicts: 0, latSum: 0, latN: 0, latMax: 0, reversals: 0, releaseChanges: 0, rule: { p1: 0, bott: 0, nearBott: 0, slots: 0, boostMaint: 0, releaseOsc: 0, stale: 0 } };
    this.lastRelease = { t: -1e9, dir: 0 };
    sim.agentHub = this;   // 현장 보고(사족보행 순찰 등)를 도메인 에이전트 제안으로 받는다
  }
  // 현장 보고 → 해당 도메인 에이전트 제안 (메인 조정자가 판정). 이미 처리 중·같은 제안이 대기 중이면 받지 않는다
  report(p) {
    if (!this.m.agentActive) return false;
    const st = p.st;
    if (st && (st.request || st.state === 'DOWN' || st.state === 'MAINT')) return true;
    const key = `${p.kind}:${st?.id ?? ''}`;
    if (this.queue.some((q) => q.key === key)) return true;
    this.queue.push({ ...p, key, t0: this.sim.time });
    const a = this.agents.find((x) => x.key === p.by); if (a) a.proposed++;
    this.ma.proposed++; this.ma.reports = (this.ma.reports ?? 0) + 1;
    return true;
  }
  get name() { return `${super.name} · 혼합형 다중 에이전트`; }

  think() {
    // ① 반사 계층
    this.logistics();
    if (!this.m.agentActive) return;
    this.energy(); this.fleet(); this.wipReflex();
    // ② 도메인 에이전트: 각자 주기로 제안
    const t = this.sim.time;
    for (const a of this.agents) {
      if (t < a.next) continue;
      a.next = t + a.period;
      for (const p of a.propose(this.sim, this.m, this)) {
        const key = `${p.kind}:${p.st?.id ?? ''}`;
        if (this.queue.some((q) => q.key === key)) continue;   // 같은 제안이 이미 대기 중
        this.queue.push({ ...p, key, by: a.key, t0: t }); a.proposed++; this.ma.proposed++;
      }
    }
    // ③ 메인 조정자
    this.arbitrate();
    this.summary();
  }
  // 정지 설비 앞 투입 보류 · 재개 (반사): 단일 에이전트 흐름 제어 3)과 같다
  wipReflex() {
    const s = this.sim, src = s.stations[0], down = s.processing.filter((st) => st.state === 'DOWN' || st.state === 'MAINT'), wip = s.wip();
    if (!s.releaseHold && down.length && wip >= 12) { s.releaseHold = true; this.decide('act', '투입 일시 보류', { obs: `${down.map((d) => d.name).join(', ')} 정지 중 · 재공 ${wip}개`, dec: '반사 계층: 상류 포화', act: '자재 투입 보류' }); }
    else if (s.releaseHold && (!down.length || wip < 7)) { s.releaseHold = false; this.decide('ok', '투입 재개', { obs: `재공 ${wip}개`, act: '자재 투입 재개' }); }
    if (src.state === 'HOLD' && !s.releaseHold && !s.cmd.feedHold) src.state = 'BUSY';
  }
  arbitrate() {
    const s = this.sim, m = this.m, t = s.time, P1 = s.orch.urgentOpen(1).length > 0;
    // 병목 = 실효 부하가 가장 큰 셀
    let bott = null, bc = 0; for (const st of s.processing) { const c = st.def.cycle * m.cycleMul * st.speedMul * (st.def.share ?? 1); if (c > bc) { bc = c; bott = st; } }
    const keep = [];
    const order = [...this.queue].sort((a, b) => a.prio - b.prio || (a.st?.health ?? 100) - (b.st?.health ?? 100));
    let pmSlots = Math.max(0, (s.techs?.length ?? 1) - s.requests.filter((r) => r.kind === 'pm' && !r.st?.request?.self).length);   // 동시에 걸 수 있는 예지정비 (정비 인력 수)
    for (const p of order) {
      const st = p.st;
      // 이미 처리됐거나 상태가 바뀐 제안은 정리
      if (st && (p.kind === 'pm' || p.kind === 'cal') && (st.request || st.state === 'DOWN' || st.state === 'MAINT')) { this.ma.stale++; this.ma.rule.stale++; continue; }
      if (t - p.t0 > 60) { this.ma.stale++; this.ma.rule.stale++; continue; }   // 1분 넘은 제안은 버리고 다시 받는다
      if (p.kind === 'pm') {
        if (P1) { this.ma.deferred++; this.ma.rule.p1++; keep.push(p); continue; }                       // 안전(P1) 대응 중 보류
        const busyBott = st === bott && st.state === 'BUSY';
        if (busyBott && !p.critical) { this.ma.deferred++; this.ma.conflicts++; this.ma.rule.bott++; keep.push(p); continue; }   // 병목 가동 중 — 대기 구간 또는 위급까지
        if (st.state === 'BUSY' && !p.critical && st.health > m.pmThreshold - 4 && st !== bott && (st.def.cycle * m.cycleMul * (st.def.share ?? 1)) / bc > 0.85) { this.ma.deferred++; this.ma.rule.nearBott++; keep.push(p); continue; }   // 병목에 가까운 셀도 조금 더 기다림
        if (pmSlots <= 0 && !p.critical) { this.ma.deferred++; this.ma.rule.slots++; keep.push(p); continue; }   // 정비 인력이 모두 바쁨
        if (s.requestTech(st, 'pm')) { pmSlots--; this.exec(p, `${st.name} 예지정비 지시`, { obs: p.why, dec: `메인 조정: ${st.state === 'BUSY' ? (st === bott ? '병목이지만 위급' : '병목 아님 — 가동 중 정비 영향 작음') : '설비 대기 구간 활용'}`, act: '정비 인력 배정' }, 'plan'); }
        else { this.ma.deferred++; keep.push(p); }
      } else if (p.kind === 'cal') {
        if (P1 && m.key !== 'dark') { this.ma.deferred++; this.ma.rule.p1++; keep.push(p); continue; }
        const ok = m.key === 'dark' ? s.selfCalibrate(st) : s.requestTech(st, 'cal');
        if (ok) this.exec(p, `${st.name} ${m.key === 'dark' ? '자율 보정' : '공정 재보정'}`, { obs: p.why, dec: '메인 조정: 품질 제안 승인', act: m.key === 'dark' ? '셀 자율 재보정 (10초)' : '정비원 재보정' }, 'plan');
        else { this.ma.deferred++; keep.push(p); }
      } else if (p.kind === 'release') {
        const dir = Math.sign(p.value - s.releaseInterval);
        // 진동 방지: 20초 안에 반대 방향으로 되돌리지 않음 (차이가 크면 예외)
        if (this.lastRelease.dir && dir !== this.lastRelease.dir && t - this.lastRelease.t < 20 && Math.abs(p.value - s.releaseInterval) < 0.6) { this.ma.rejected++; this.ma.conflicts++; this.ma.rule.releaseOsc++; continue; }
        if (this.lastRelease.dir && dir !== this.lastRelease.dir) this.ma.reversals++;
        s.releaseInterval = p.value; this.lastRelease = { t, dir }; this.ma.releaseChanges++;
        this.exec(p, '투입 속도 동기화', { obs: p.why, dec: '메인 조정: 흐름 제안 승인', act: `투입 간격 ${p.value}초` }, 'act', this.ready('release', 30));
      } else if (p.kind === 'boost') {
        // 충돌: 정비가 필요한(건강도 낮거나 정비 제안 대기) 셀은 고속 운전 거절
        if (st.health < m.pmThreshold + 5 || this.queue.some((q) => q.kind === 'pm' && q.st === st)) { this.ma.rejected++; this.ma.conflicts++; this.ma.rule.boostMaint++; continue; }
        if (this.boosted && this.boosted !== st) { this.boosted.speedMul = 1; this.ma.reversals++; }
        st.speedMul = m.boostMul ?? 0.9; this.boosted = st;
        this.exec(p, `병목 해소: ${st.name} 사이클 최적화`, { obs: p.why, dec: '메인 조정: 정비 충돌 없음', act: `사이클 ${Math.round((1 - (m.boostMul ?? 0.9)) * 100)}% 단축` }, 'act');
      } else if (p.kind === 'unboost') {
        if (this.boosted === st) { st.speedMul = 1; this.boosted = null; this.exec(p, `${st.name} 표준 사이클 복귀`, { obs: p.why, act: '사이클 100%' }, 'info'); } else this.ma.stale++;
      } else if (p.kind === 'expedite') {
        const act = this.expedite(); if (!act) { keep.push(p); continue; }
        s.supplyCommand?.(act); this.exec(p, '자재 공급 차질 감지', { obs: p.why, dec: '메인 조정: 공급 차질 대응 승인', act }, 'alert');
      }
    }
    this.queue = keep;
  }
  exec(p, title, body, level = 'act', log = true) {
    const lat = this.sim.time - p.t0;
    this.ma.approved++; this.ma.latSum += lat; this.ma.latN++; this.ma.latMax = Math.max(this.ma.latMax, lat);
    const a = this.agents.find((x) => x.key === p.by); if (a) a.approved++;
    if (log) this.decide(level, title, { ...body, dec: `${body.dec ?? ''}${body.dec ? ' · ' : ''}${p.source ? `${p.source} 순찰 보고 → ` : ''}${a?.label ?? ''} 제안 → ${lat.toFixed(0)}초 뒤 실행` });
    else this.decisions++;
  }
  status() {
    const M = this.ma;
    return { ...M, avgLat: M.latN ? M.latSum / M.latN : 0, queue: this.queue.length, pending: this.queue.map((q) => ({ kind: q.kind, st: q.st?.name ?? null, by: q.by, age: this.sim.time - q.t0, source: q.source ?? null })), agents: this.agents.map((a) => ({ key: a.key, label: a.label, period: a.period, proposed: a.proposed, approved: a.approved })) };
  }
}

// 단일 에이전트 계측: 투입 간격 변경·되돌림·고속 운전 전환을 센다 (판단 지연 0 — 판단 즉시 실행)
export class MeteredAgent extends FactoryAgent {
  constructor(sim) { super(sim); this.arch = 'single'; this.ma = { releaseChanges: 0, reversals: 0, lastDir: 0 }; }
  think() {
    const r0 = this.sim.releaseInterval, b0 = this.boosted;
    super.think();
    const r1 = this.sim.releaseInterval;
    if (r1 !== r0) { const d = Math.sign(r1 - r0); if (this.ma.lastDir && d !== this.ma.lastDir) this.ma.reversals++; this.ma.lastDir = d; this.ma.releaseChanges++; }
    if (b0 && this.boosted !== b0) this.ma.reversals++;
  }
}

// ── 디지털트윈 비교: 같은 조건(라인·시드·현장 이벤트·설비 고장 주입)으로 단일 vs 혼합형 ─────────────────
export function compareArchitectures({ mode = 'dark', line, seeds = [7, 19, 31], T = 3600, events = true, only = null } = {}) {
  const run = (Arch, seed) => {
    const s = new Simulation(mode, seed, { line, quiet: true, twin: true }), ag = new Arch(s);
    let next = 300, k = 0, t0 = performance.now();
    for (let t = 0; t < T; t += 0.1) {
      s.step(0.1); ag.update(0.1);
      if (events && t > next) {   // 10분마다 현장 이벤트(피지컬AI) · 20분마다 설비 고장
        next += 600; k++;
        if (mode === 'dark') { const p = [[4, 8.2], [-6, -8.2], [14, 8.4], [-20, 8.6], [22, -8.4]][k % 5]; s.injectFieldEvent(['leak', 'smoke', 'debris'][k % 3], p[0], p[1]); }
        if (k % 2 === 0) s.injectFault(s.processing[k % s.processing.length]);
      }
    }
    const K = s.kpi(), down = s.processing.reduce((a, st) => a + st.c.down + st.c.maint, 0);
    return { uph: K.uph, oee: K.OEE, wip: K.avgWip, kwhUnit: K.kwhPerUnit, failures: K.failures, pm: K.pm, cal: K.cal, downMin: down / 60, shipped: K.shipped, decisions: ag.decisions,
      ...(ag.arch === 'hybrid' ? ag.status() : { avgLat: 0, latMax: 0, conflicts: 0, proposed: ag.decisions, approved: ag.decisions, deferred: 0, rejected: 0 }), reversals: ag.ma.reversals, releaseChanges: ag.ma.releaseChanges, ms: performance.now() - t0 };
  };
  const avg = (rs) => { const o = {}; for (const k of Object.keys(rs[0])) if (typeof rs[0][k] === 'number') o[k] = rs.reduce((a, r) => a + r[k], 0) / rs.length; return o; };
  const single = only === 'hybrid' ? [] : seeds.map((sd) => run(MeteredAgent, sd)), hybrid = only === 'single' ? [] : seeds.map((sd) => run(HybridAgent, sd));
  return { mode, seeds, T, single: single.length ? avg(single) : null, hybrid: hybrid.length ? avg(hybrid) : null, runs: { single, hybrid } };
}

// 화면용: 실행 사이사이 화면을 그리도록 한 번에 한 판씩 (진행 콜백)
export async function compareArchitecturesAsync(opts, onProgress) {
  const seeds = opts.seeds ?? [7, 19, 31], runs = { single: [], hybrid: [] }, total = seeds.length * 2; let done = 0;
  for (const arch of ['single', 'hybrid']) for (const sd of seeds) {
    await new Promise((r) => setTimeout(r, 30));
    const one = compareArchitectures({ ...opts, seeds: [sd], only: arch });
    runs[arch].push(one.runs[arch][0]); onProgress?.(++done, total);
  }
  const avg = (rs) => { const o = {}; for (const k of Object.keys(rs[0])) if (typeof rs[0][k] === 'number') o[k] = rs.reduce((a, r) => a + r[k], 0) / rs.length; return o; };
  return { mode: opts.mode, seeds, T: opts.T, single: avg(runs.single), hybrid: avg(runs.hybrid), runs };
}
