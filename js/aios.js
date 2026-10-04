// AIOS — 공장 운영 AI (FACOS: 공장 운영 시스템 관점, 피지컬AI 단계)
// VLA가 끝단 로봇의 추론 모델이라면, AIOS는 공장 오케스트레이터가 쓰는 운영 정책 모델이다.
// 1) 수집: 현장에서 올라오는 생산·설비·물류·에너지·품질 데이터와 인시던트·운영 의사결정을 10초마다 한 샘플로 모은다.
// 2) AI-ready 정제: 고정 스키마의 특징 벡터(시계열) + 이벤트(인시던트·의사결정) + 전이(상태·행동·보상·다음 상태)로 만들고,
//    10분(60샘플)마다 묶음(chunk)으로 서버(data/aios/)에 저장한다. 서버가 없으면 브라우저에 보관하고 zip으로 내려받는다.
// 3) 학습: 쌓인 데이터에서 운영 정책 헤드(AMR 선행 배차·셀 절전 진입·인시던트 판단 지연)의 후보 값을 찾는다.
// 4) 트윈 검증: 같은 라인·조건의 디지털트윈 시뮬레이션 두 벌(현재 정책 vs 후보 정책)을 실제로 돌려 생산량·에너지를 비교한다.
// 5) 배포: 오케스트레이터에 섀도 모드(추천만) → 적용 → 실측 효과 확인, 나빠지면 자동 롤백.
// 학습은 규칙 기반 정책 탐색이고(신경망 아님), 트윈 검증과 배포 후 효과는 시뮬레이션에서 실제로 측정한 값이다.
import { Simulation } from './sim.js';
import { FactoryAgent } from './agent.js';

export const SAMPLE_S = 10;            // 샘플 주기 (시뮬레이션 초)
export const CHUNK = 60;               // 저장 묶음 = 60샘플 = 10분
const KEEP = 2160;                     // 브라우저에 보관하는 최근 샘플 (6시간)
export const TRAIN_MIN = 180;          // 새 샘플 180개(30분)마다 자동 학습
const MANUAL_MIN = 30;                 // 수동 학습 최소 샘플 (5분)
const TWIN_S = 1200, TWIN_SEEDS = [11, 23];   // 트윈 검증: 20분 × 시드 2개
const SHADOW_S = 60, VERIFY_S = 600;   // 섀도 모드 60초, 배포 후 효과 확인 10분

// 운영 정책 헤드 — 오케스트레이터가 실제로 쓰는 값 (sim.mode에 반영)
export const HEADS = [
  { key: 'amrStage', label: 'AMR 선행 배차', unit: '대', base: 1, desc: '투입 스테이션에 미리 불러 두는 빈 AMR 수 (최대 2대)' },
  { key: 'ecoWait', label: '셀 절전 진입', unit: '초', base: 25, desc: '자재대기가 이만큼 이어지면 셀 대기전력 절감' },
  { key: 'orchLatency', label: '인시던트 판단 지연', unit: '초', base: 1.5, desc: '고장·결품 보고 → 오케스트레이터 판단·명령까지' },
];
export const FEATURES = [
  ['t', 's', '시뮬레이션 시각'], ['uph', 'ea/h', '최근 10분 시간당 생산'], ['oee', '%', '설비종합효율'], ['availability', '%', '가동률'], ['quality', '%', '양품률'],
  ['wip', 'ea', '재공'], ['raw_stock', 'ea', '투입구 자재'], ['fg_stock', 'ea', '완제품 재고'], ['power_kw', 'kW', '현재 전력'],
  ['good_delta', 'ea', '샘플 구간 양품'], ['energy_delta_kwh', 'kWh', '샘플 구간 에너지'], ['fail_delta', '건', '샘플 구간 고장'], ['pm_delta', '건', '샘플 구간 예지정비'],
  ['src_noamr_s', 's', '투입 스테이션 빈 AMR 대기 시간'], ['src_state', '-', '투입 스테이션 상태'],
  ['amr', '-', 'AMR 상태별 대수 {park,toSrc,atSrc,line,return}'], ['agv_battery', '%', 'AGV 평균 배터리'], ['agv_idle', '대', '유휴 AGV'],
  ['cells', '-', '셀별 [상태, 이용률, 건강도, 대기열, 자재대기 비율]'], ['incidents_open', '건', '열린 인시던트'], ['supply_disrupted', 'bool', '자재 공급 차질'],
  ['amr_battery_min', '%', '운반 AMR 최저 배터리'], ['net_ho', '회', '5G 누적 핸드오버'], ['net_lost', '건', '5G 업링크 유실'], ['cctv_open', '건', 'CCTV 에이전트 진행 중 이벤트'],
  ['erp_po_open', '건', 'ERP 진행 중 구매오더'], ['erp_mr_open', '건', 'ERP 진행 중 정비요청'],
  ['policy', '-', '적용 중인 운영 정책'], ['model', '-', 'AIOS 모델 버전'],
];
const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;

export class AIOSPipeline {
  constructor(sim) {
    this.sim = sim; sim.aios = this;
    this.on = sim.mode.key === 'dark' && !sim.twin;
    this.policy = Object.fromEntries(HEADS.map((h) => [h.key, h.base]));
    if (this.on) this.apply(this.policy);   // 트윈은 검증할 정책을 따로 넣는다
    this.samples = []; this.events = []; this.decisions = []; this.total = 0; this.newSamples = 0;
    this.chunks = []; this.chunkSeq = 0; this.seenInc = new Set();
    this.latest = 0; this.jobs = []; this.job = null; this.backoff = 1;
    this.models = [{ v: 0, label: 'v1.0', policy: { ...this.policy }, note: '규칙 기반 초기 정책', t: 0 }];
    this.next = SAMPLE_S; this.prev = null;
  }
  label(v) { return `v1.${v}`; }
  get version() { return this.label(this.latest); }
  get trainAt() { return TRAIN_MIN * this.backoff; }   // 다음 자동 학습까지 필요한 새 샘플 수
  apply(p) { for (const h of HEADS) this.sim.mode[h.key] = p[h.key]; }

  // sim.log 훅: 운영 의사결정(에이전트·오케스트레이터)을 이벤트로 모은다
  onLog(level, title, body) {
    if (!this.on) return;
    this.decisions.push({ t: r1(this.sim.time), level, title, obs: body.obs ?? null, dec: body.dec ?? null, act: body.act ?? null });
    if (this.decisions.length > KEEP) this.decisions.shift();
  }

  // ── 1·2) 수집 · AI-ready 정제 ─────────────────
  snapshot() {
    const s = this.sim, k = s.kpi(), src = s.stations[0], T = s.time;
    const amr = { park: 0, toSrc: 0, atSrc: 0, line: 0, return: 0 };
    for (const c of s.carriers) { const st = c.state === 'docking' ? 'toSrc' : c.state; if (st in amr) amr[st]++; }
    const cells = s.processing.map((st) => [st.state, r3(st.ema), Math.round(st.health), s.queueLen(st), r3(st.c.starved / Math.max(1, T))]);
    const p = this.prev ?? { good: 0, energy: 0, fails: 0, pm: 0, noamr: 0 };
    const cur = { good: k.good, energy: k.energy, fails: k.failures, pm: k.pm, noamr: src.c.blocked };
    const v = s.vehicles;
    const x = {
      t: r1(T), uph: Math.round(k.uphRecent), oee: r1(k.OEE * 100), availability: r1(k.A * 100), quality: r1(k.Q * 100),
      wip: k.wip, raw_stock: k.raw, fg_stock: k.fg, power_kw: r1(k.powerKW),
      good_delta: cur.good - p.good, energy_delta_kwh: r3(cur.energy - p.energy), fail_delta: cur.fails - p.fails, pm_delta: cur.pm - p.pm,
      src_noamr_s: r1(cur.noamr - p.noamr), src_state: src.state, amr,
      agv_battery: v.length ? Math.round(v.reduce((a, b) => a + b.battery, 0) / v.length) : null, agv_idle: v.filter((a) => a.idle).length,
      cells, incidents_open: s.orch.openCount(), supply_disrupted: !!s.supplyDisrupted,
      amr_battery_min: s.carriers.length ? Math.round(Math.min(...s.carriers.map((c) => c.battery))) : null,
      net_ho: s.net?.on ? s.net.stats.ho : null, net_lost: s.net?.on ? s.net.summary().lost : null, cctv_open: s.cctvAgent ? s.cctvAgent.history.filter((h) => h.status === 'open').length : null,
      erp_po_open: s.erp?.on ? s.erp.stats().poOpen : null, erp_mr_open: s.erp?.on ? s.erp.stats().mrOpen : null,
      policy: { ...this.policy }, model: this.version,
    };
    this.prev = cur;
    return x;
  }
  collect() {
    const s = this.sim, x = this.snapshot();
    // 보상: 구간 양품 − 고장 패널티 − 에너지 (운영 정책 강화학습·모방학습용 라벨)
    x.reward = r3(x.good_delta - 3 * x.fail_delta - 0.5 * x.energy_delta_kwh);
    const last = this.samples.at(-1);
    if (last) last.next_t = x.t;
    this.samples.push(x); if (this.samples.length > KEEP) this.samples.shift();
    this.total++; this.newSamples++; this.bytes = (this.bytes ?? 0) + JSON.stringify(x).length;   // AI-ready 샘플 누적 바이트
    // 끝난 인시던트 → 이벤트 (감지부터 판단·완료까지 걸린 시간)
    for (const inc of s.orch.incidents) {
      if (inc.status !== 'resolved' || this.seenInc.has(inc.id)) continue;
      this.seenInc.add(inc.id);
      const at = (kind) => inc.steps.find((st) => st.kind === kind)?.t;
      const dec = at('decide');
      this.events.push({ t: r1(inc.t0), id: inc.id, type: inc.type, title: inc.title, source: inc.source, decide_s: dec != null ? r1(dec - inc.t0) : null, resolve_s: r1((inc.tEnd ?? s.time) - inc.t0), drone_s: inc.drone ? r1(inc.drone.dt) : null, drone_obs: inc.drone?.obs ?? null, steps: inc.steps.length, model: this.version });
      if (this.events.length > 500) this.events.shift();
    }
    if (this.total % CHUNK === 0) this.chunks.push({ id: `aios_${String(++this.chunkSeq).padStart(4, '0')}`, from: this.total - CHUNK, to: this.total, t: x.t });
  }
  // 전이 (상태 → 행동(구간 의사결정) → 보상 → 다음 상태)
  transitions(list = this.samples) {
    const out = [];
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      out.push({ t: a.t, state_t: a.t, action: this.decisions.filter((d) => d.t > a.t && d.t <= b.t).map((d) => d.title), policy: a.policy, reward: b.reward, next_state_t: b.t });
    }
    return out;
  }

  // ── 3) 학습: 데이터에서 정책 후보 찾기 ─────────────────
  learn(win) {
    const cur = { ...this.policy }, cand = { ...cur }, why = [];
    const dur = win.length * SAMPLE_S;
    const noAmr = win.reduce((a, x) => a + x.src_noamr_s, 0) / Math.max(1, dur);
    const starved = win.length ? win.reduce((a, x) => a + x.cells.reduce((b, c) => b + (c[0] === 'STARVED' ? 1 : 0), 0) / x.cells.length, 0) / win.length : 0;
    const incs = this.events.filter((e) => e.t >= (win[0]?.t ?? 0) && e.decide_s != null);
    // AMR 선행 배차는 2대까지 — 투입 진입로가 한 줄이라 3대 이상 미리 부르면 대기열·주차열 AMR끼리 교착될 수 있다 (트윈 검증 이득도 +2% 수준)
    if (noAmr > 0.08 && cur.amrStage < 2) { cand.amrStage = cur.amrStage + 1; why.push(`투입 스테이션이 빈 AMR을 기다린 시간 ${Math.round(noAmr * 100)}% → 선행 배차 ${cand.amrStage}대`); }
    if (starved > 0.2 && cur.ecoWait > 8) { cand.ecoWait = Math.max(8, Math.round(cur.ecoWait * 0.6)); why.push(`셀 자재대기 비율 ${Math.round(starved * 100)}% → 절전 진입 ${cur.ecoWait}초 → ${cand.ecoWait}초`); }
    if (incs.length && cur.orchLatency > 0.8) { cand.orchLatency = Math.round(Math.max(0.8, cur.orchLatency - 0.35) * 100) / 100; why.push(`인시던트 ${incs.length}건 대응 패턴 학습 → 판단 지연 ${cur.orchLatency}초 → ${cand.orchLatency}초`); }
    return { cand, why, feats: { noAmr: r3(noAmr), starved: r3(starved), incidents: incs.length } };
  }
  startTraining(manual = false) {
    if (!this.on || this.job || this.newSamples < (manual ? MANUAL_MIN : TRAIN_MIN)) return false;
    const win = this.samples.slice(-this.newSamples), v = this.latest + 1;
    const { cand, why, feats } = this.learn(win);
    this.job = { v, label: this.label(v), samples: win.length, total: this.total, events: this.events.length, decisions: this.decisions.length, phase: 'train', t0: this.sim.time, epochs: 8, epoch: 0, loss: [], cand, why, feats, prev: { ...this.policy } };
    this.jobs.unshift(this.job); if (this.jobs.length > 12) this.jobs.pop();
    this.newSamples = 0;
    this.sim.log('plan', `AIOS 학습 시작 · ${this.job.label}`, { obs: `운영 샘플 ${win.length}개 · 인시던트 ${feats.incidents}건 · 의사결정 ${this.decisions.length}건`, dec: manual ? '운영자 수동 학습 요청' : `새 샘플 ${TRAIN_MIN}개(30분) 이상 → 자동 재학습`, act: 'AIOS 학습 서버에서 운영 정책 학습 (8 에폭)' });
    return true;
  }

  // ── 4) 트윈 검증: 현재 정책 vs 후보 정책을 같은 조건의 디지털트윈에서 실제로 돌린다 ─────
  twinStart(j) {
    const mk = (pol, seed) => {
      const t = new Simulation('dark', seed, { line: this.sim.line, quiet: true, twin: true });
      for (const h of HEADS) t.mode[h.key] = pol[h.key];
      return { sim: t, agent: new FactoryAgent(t) };
    };
    j.twin = { runs: TWIN_SEEDS.flatMap((sd) => [{ who: 'cur', ...mk(j.prev, sd) }, { who: 'cand', ...mk(j.cand, sd) }]), i: 0, steps: 0, total: TWIN_SEEDS.length * 2 * TWIN_S * 10 };
  }
  twinWork(j) {
    const T = j.twin, t0 = performance.now();
    if (t0 - (this.winStart ?? 0) > 16) { this.winStart = t0; this.used = 0; }   // 화면 프레임(16ms)당 6ms까지만
    const budget = this.sim.quiet ? Infinity : 6;   // 헤드리스(비교·시험)는 한 번에 끝까지 — 결과가 실행 속도와 무관하게 같도록
    while (T.i < T.runs.length && this.used < budget) {
      const r = T.runs[T.i], a = performance.now();
      for (let n = 0; n < 300 && r.sim.time < TWIN_S - 1e-6; n++) { r.sim.step(0.1); r.agent.update(0.1); T.steps++; }
      if (r.sim.time >= TWIN_S - 1e-6) { const k = r.sim.kpi(); r.res = { good: k.good, kwh: k.energy, fails: k.failures }; r.sim = r.agent = null; T.i++; }
      this.used += performance.now() - a;
    }
    if (T.i < T.runs.length) return false;
    const sum = (who) => T.runs.filter((r) => r.who === who).reduce((a, r) => ({ good: a.good + r.res.good, kwh: a.kwh + r.res.kwh, fails: a.fails + r.res.fails }), { good: 0, kwh: 0, fails: 0 });
    const c = sum('cur'), d = sum('cand'), h = (TWIN_S / 3600) * TWIN_SEEDS.length;
    j.result = { uphCur: Math.round(c.good / h), uphCand: Math.round(d.good / h), kwhCur: r3(c.kwh / Math.max(1, c.good)), kwhCand: r3(d.kwh / Math.max(1, d.good)), failsCur: c.fails, failsCand: d.fails };
    j.result.gain = r1(((d.good - c.good) / Math.max(1, c.good)) * 100);
    j.result.eGain = r1(((j.result.kwhCur - j.result.kwhCand) / Math.max(1e-6, j.result.kwhCur)) * 100);
    j.twin = { done: true };
    return true;
  }

  // ── 5) 진행: 학습 → 트윈 검증 → 섀도 → 적용 → 효과 확인 ─────────────────
  update(dt) {
    if (!this.on) return;
    const s = this.sim;
    if (s.time >= this.next) { this.next += SAMPLE_S; this.collect(); }
    if (!this.job) { if (this.newSamples >= TRAIN_MIN * this.backoff) this.startTraining(); return; }
    const j = this.job;
    if (j.phase === 'train') {
      const ep = Math.min(j.epochs, Math.floor((s.time - j.t0) / 5));
      while (j.loss.length < ep) { const e = j.loss.length + 1; j.loss.push(r3(0.08 + 0.6 * Math.exp(-e / (2.2 + j.samples / 200)) + (s.rand() - 0.5) * 0.01)); }
      j.epoch = ep;
      if (ep >= j.epochs) {
        if (!j.why.length) { j.phase = 'rejected'; j.reason = '데이터에서 개선할 정책을 찾지 못함 (현재 정책 유지)'; this.finishReject(j); return; }
        j.phase = 'twin'; this.twinStart(j);
      }
    } else if (j.phase === 'twin') {
      if (!this.twinWork(j)) return;
      const R = j.result, score = R.gain + R.eGain * 0.5;
      if (score >= 0.5 && R.gain > -0.5) {
        j.phase = 'shadow'; j.t2 = s.time; this.backoff = 1;
        s.log('ok', `AIOS ${j.label} 트윈 검증 통과 → 섀도 모드`, { obs: `트윈 20분×2 · UPH ${R.uphCur} → ${R.uphCand} (${R.gain >= 0 ? '+' : ''}${R.gain}%) · kWh/개 ${R.kwhCur} → ${R.kwhCand}`, dec: j.why.join(' · '), act: `오케스트레이터 섀도 모드 ${SHADOW_S}초 (추천만, 현재 정책 실행)` });
      } else { j.phase = 'rejected'; j.reason = `트윈 검증 미달 — UPH ${R.gain >= 0 ? '+' : ''}${R.gain}%, 에너지 ${R.eGain >= 0 ? '+' : ''}${R.eGain}%`; this.finishReject(j); }
    } else if (j.phase === 'shadow' && s.time - j.t2 >= SHADOW_S) {
      j.phase = 'verify'; j.t3 = s.time; j.base = { good: s.stats.good, t: s.time, uph: Math.round(s.kpi().uphRecent) };
      this.policy = { ...j.cand }; this.apply(this.policy); this.latest = j.v;
      this.models.unshift({ v: j.v, label: j.label, policy: { ...j.cand }, note: j.why.join(' · '), t: s.time, twin: j.result });
      s.log('act', `AIOS ${j.label} 오케스트레이터 배포`, { obs: `섀도 모드 ${SHADOW_S}초 — 추천과 운영 상태 정상`, dec: HEADS.filter((h) => j.prev[h.key] !== j.cand[h.key]).map((h) => `${h.label} ${j.prev[h.key]}${h.unit} → ${j.cand[h.key]}${h.unit}`).join(' · '), act: `운영 정책 적용 · ${VERIFY_S / 60}분 동안 실측 효과 확인` });
    } else if (j.phase === 'verify' && s.time - j.t3 >= VERIFY_S) {
      const uph = Math.round(((s.stats.good - j.base.good) / (s.time - j.t3)) * 3600);
      j.after = { uph, before: j.base.uph };
      if (j.base.uph > 0 && uph < j.base.uph * 0.95) {
        j.phase = 'rollback'; this.policy = { ...j.prev }; this.apply(this.policy); this.latest = this.models[1]?.v ?? 0; this.models.shift();
        s.log('warn', `AIOS ${j.label} 롤백`, { obs: `배포 후 UPH ${uph} (배포 전 ${j.base.uph})`, act: `이전 모델 ${this.version}로 복귀` });
      } else {
        j.phase = 'done';
        s.log('ok', `AIOS ${j.label} 배포 효과 확인`, { obs: `배포 후 10분 UPH ${uph} (배포 전 ${j.base.uph})`, act: '모델 유지' });
      }
      j.tEnd = s.time; this.job = null;
    }
  }
  finishReject(j) {
    this.backoff = Math.min(4, this.backoff * 2); this.job = null; j.tEnd = this.sim.time;
    this.sim.log('warn', `AIOS ${j.label} 배포 안 함`, { obs: j.reason, act: `현재 모델 ${this.version} 유지 · 샘플 ${TRAIN_MIN * this.backoff}개 더 모은 뒤 재학습` });
  }
}

// ── 운영 데이터셋 zip ─────────────────
// meta/info.json(스키마·정책 헤드) · data/timeseries.jsonl · data/events.jsonl(인시던트) · data/decisions.jsonl · data/transitions.jsonl · models/registry.json
export function buildAiosZip(P, zipStore, iso, runId, range = null) {
  const enc = new TextEncoder();
  const S = range ? P.samples.filter((x) => x.t >= range[0] && x.t <= range[1]) : P.samples;
  const t0 = S[0]?.t ?? 0, t1 = S.at(-1)?.t ?? 0;
  const inR = (x) => x.t >= t0 - SAMPLE_S && x.t <= t1;
  const jl = (a) => enc.encode(a.map((x) => JSON.stringify(x)).join('\n') + (a.length ? '\n' : ''));
  const info = {
    dataset: 'jin3d_aios_ops', format: 'Jin-3D AIOS 운영 데이터셋 v1 (시계열·이벤트·의사결정·전이 JSONL)', generator: 'Jin-3D 디지털트윈 (시뮬레이션 데이터)',
    run_id: runId, factory: '메타팩토리 정밀조립Zone', sample_period_s: SAMPLE_S, samples: S.length, start: iso(t0), end: iso(t1),
    features: FEATURES.map(([name, unit, desc]) => ({ name, unit, desc })),
    cell_ids: P.sim.processing.map((st) => st.uid ?? st.id), cell_feature: ['state', 'utilization', 'health_pct', 'queue', 'starved_ratio'],
    reward: 'good_delta − 3·fail_delta − 0.5·energy_delta_kwh (구간 보상)', policy_heads: HEADS, model: P.version,
  };
  const files = [
    { path: 'meta/info.json', data: enc.encode(JSON.stringify(info, null, 2)) },
    { path: 'data/timeseries.jsonl', data: jl(S.map((x) => ({ timestamp: iso(x.t), ...x }))) },
    { path: 'data/events.jsonl', data: jl(P.events.filter(inR).map((e) => ({ timestamp: iso(e.t), ...e }))) },
    { path: 'data/decisions.jsonl', data: jl(P.decisions.filter(inR).map((d) => ({ timestamp: iso(d.t), ...d }))) },
    { path: 'data/transitions.jsonl', data: jl(P.transitions(S)) },
    { path: 'models/registry.json', data: enc.encode(JSON.stringify(P.models.map((m) => ({ version: m.label, policy: m.policy, note: m.note, deployed_at: iso(m.t), twin: m.twin ?? null })), null, 2)) },
    { path: 'README.txt', data: enc.encode(`Jin-3D AIOS 운영 데이터셋 — 공장 오케스트레이터 운영 정책 학습용\n샘플 ${S.length}개 · ${SAMPLE_S}초 주기 · 인시던트·의사결정·전이 포함\n스키마: meta/info.json · 시계열: data/timeseries.jsonl · 이벤트: data/events.jsonl · 의사결정: data/decisions.jsonl · 전이: data/transitions.jsonl · 모델: models/registry.json\n시뮬레이션으로 생성된 데이터입니다.\n`) },
  ];
  return zipStore(files);
}
