// Claude(LLM) 감독 계층 — 언제 호출할지 판단하고, 스냅샷을 보내고, 돌아온 조치를 시뮬레이션에 적용한다.
// 반사 계층(AGV 배차·충전·절전)은 계속 규칙 기반 FactoryAgent가 처리한다.

const PERIOD = 300;          // 정기 점검 주기 (시뮬레이션 초)
const RISK_TRIGGER = 0.15;   // 10분 고장확률이 이 값을 넘으면 즉시 호출
const HISTORY = 12;

const fmt = (t) => {
  const s = Math.floor(t) + 8 * 3600;
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const r1 = (v) => Math.round(v * 10) / 10;

export class LLMController {
  constructor() {
    this.available = false;
    this.model = null;
    this.enabled = false;
    this.pauseWhileThinking = true;
    this.inFlight = false;
    this.queue = null;            // { reasons:Set, urgent, operatorMessage }
    this.calls = 0; this.costUSD = 0; this.tokensIn = 0; this.tokensOut = 0;
    this.status = '';
    this.onChange = null;
  }

  async probe() {
    try {
      const r = await fetch('/api/status');
      if (r.ok) { const j = await r.json(); this.available = !!j.llm; this.model = j.model; }
    } catch { this.available = false; }
    this.onChange?.();
  }

  attach(sim, agent) {
    this.sim = sim; this.agent = agent;
    this.history = []; this.queue = null;
    this.lastPeriodic = 0; this.lastFailures = 0; this.wasDisrupted = false;
    this.riskNotified = new Map();
    this.gen = (this.gen ?? 0) + 1;     // 모드 전환 시 이전 응답 무시
    this.setEnabled(this.enabled && sim.mode.agentActive);
  }

  setEnabled(on) {
    this.enabled = on && this.available && this.sim?.mode.agentActive;
    if (this.agent) this.agent.llm = this.enabled;
    if (this.enabled) { this.lastPeriodic = this.sim.time; this.request('LLM 감독 모드 시작 — 초기 상황 점검', false); }
    this.onChange?.();
  }

  get holdSim() { return this.enabled && this.inFlight && this.pauseWhileThinking; }

  request(reason, urgent = false, operatorMessage = null) {
    if (!this.enabled) return;
    if (!this.queue) this.queue = { reasons: new Set(), urgent: false, operatorMessage: null };
    this.queue.reasons.add(reason);
    this.queue.urgent ||= urgent;
    if (operatorMessage) this.queue.operatorMessage = operatorMessage;
    this.pump();
  }

  chat(text) {
    if (!this.enabled) return false;
    this.history.push({ t: fmt(this.sim.time), who: '운영자', text });
    this.sim.log('chat', '운영자 지시', { obs: text });
    this.request('운영자 지시 수신', true, text);
    return true;
  }

  // 매 프레임 호출 — 이벤트 감지
  update() {
    if (!this.enabled) return;
    const sim = this.sim;
    if (sim.stats.failures > this.lastFailures) {
      const down = sim.processing.filter((s) => s.state === 'DOWN').map((s) => s.name).join(', ');
      this.lastFailures = sim.stats.failures;
      this.request(`돌발 고장 발생: ${down || '설비'}`, true);
    }
    if (sim.supplyDisrupted && !this.wasDisrupted) this.request('자재 공급 차질 감지', true);
    this.wasDisrupted = sim.supplyDisrupted;
    for (const st of sim.processing) {
      if (st.request || st.state === 'DOWN' || st.state === 'MAINT') continue;
      const a = sim.assess(st);
      const last = this.riskNotified.get(st.id) ?? -1e9;
      if (a.risk10 > RISK_TRIGGER && sim.time - last > 180) {
        this.riskNotified.set(st.id, sim.time);
        this.request(`${st.name} 고장 위험 상승 (10분 고장확률 ${(a.risk10 * 100).toFixed(0)}%)`, true);
      }
    }
    if (sim.time - this.lastPeriodic >= PERIOD) {
      this.lastPeriodic = sim.time;
      this.request('정기 점검 (5분 주기)', false);
    }
  }

  snapshot() {
    const sim = this.sim, m = sim.mode, k = sim.kpi();
    return {
      clock: fmt(sim.time), mode: m.label, line: sim.line.name,
      kpi: {
        good_units: k.good, uph_recent: Math.round(k.uphRecent), oee_pct: r1(k.OEE * 100),
        availability_pct: r1(k.A * 100), quality_pct: r1(k.Q * 100), wip: k.wip, avg_wip: r1(k.avgWip),
        power_kw: Math.round(k.powerKW), escaped_ppm: Math.round(k.ppm), failures: k.failures, pm_done: k.pm, cal_done: k.cal,
      },
      material: {
        raw_stock: sim.rawStock, raw_cap: 40, inbound_raw: sim.inboundRaw, safety_stock: sim.safetyStock,
        fg_stock: sim.fgStock, fg_cap: 36, release_interval_s: r1(sim.releaseInterval), release_hold: sim.releaseHold,
        supply_disrupted_remaining_s: Math.max(0, Math.round(sim.supplyDisruptedUntil - sim.time)),
        expedited: sim.supplyDisrupted && this.agent.disruptHandled >= sim.supplyDisruptedUntil,
      },
      maintenance: {
        pm_time_s: m.pmTime, repair_time_s: m.repairTime, self_calibration: m.key === 'dark',
        techs: sim.techs.map((t) => ({ id: t.id, kind: t.kind, task: t.task ?? 'idle' })),
      },
      stations: sim.processing.map((st) => {
        const a = sim.assess(st);
        return {
          id: st.id, name: st.name, type: st.type, robot: st.def.robot, task: st.def.task, inspect: st.def.inspect, state: st.state, health: r1(st.health), rul_min: Math.round(a.rul),
          risk10_pct: r1(a.risk10 * 100), cpk: Math.round(a.cpk * 100) / 100, util_pct: Math.round(st.ema * 100),
          queue_in: sim.queueLen(st), share: st.def.share ?? 1, product_line: st.def.product ?? null, cycle_s: r1(st.def.cycle * m.cycleMul * st.speedMul), boost: st.speedMul < 1,
          request: st.request?.kind ?? null, processed: st.c.processed, defects: st.c.defects, failures: st.c.fails,
        };
      }),
      vehicles: sim.vehicles.map((v) => ({ id: v.id, task: v.task ?? 'idle', battery: Math.round(v.battery) })),
      recent_events: sim.logs.slice(0, 8).map((l) => `[${fmt(l.t)}] ${l.title}`),
    };
  }

  async pump() {
    if (this.inFlight || !this.queue || !this.enabled) return;
    const job = this.queue; this.queue = null;
    const gen = this.gen;
    this.inFlight = true;
    const trigger = [...job.reasons].join(' / ');
    this.status = `분석 중 · ${trigger}`;
    this.onChange?.();
    try {
      const res = await fetch('/api/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: this.snapshot(), trigger, urgent: job.urgent, operatorMessage: job.operatorMessage, history: this.history.slice(-HISTORY) }),
      });
      const out = await res.json();
      if (gen !== this.gen) return;
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      this.calls++; this.costUSD += out.costUSD; this.tokensIn += out.usage.input_tokens; this.tokensOut += out.usage.output_tokens;
      for (const a of out.actions) this.apply(a);
      for (const r of out.rejected) this.sim.log('warn', `Claude 제안 반려 · ${r.name}`, { obs: r.input.reason, dec: r.error });
      if (out.text) {
        this.history.push({ t: fmt(this.sim.time), who: '에이전트', text: out.text });
        this.sim.log('llm', 'Claude 판단', { obs: trigger, dec: out.text, act: out.actions.length ? `조치 ${out.actions.length}건 실행` : '추가 조치 없음' });
      }
      this.status = `${(out.latencyMs / 1000).toFixed(1)}초 응답 · 조치 ${out.actions.length}건`;
    } catch (e) {
      if (gen !== this.gen) return;
      this.sim.log('alert', 'Claude 호출 실패', { obs: e.message, act: '규칙 기반 반사 계층으로 계속 운영' });
      this.status = `오류: ${e.message}`;
    } finally {
      if (gen === this.gen) {
        this.inFlight = false;
        this.onChange?.();
        if (this.queue) setTimeout(() => this.pump(), 500);
      }
    }
  }

  apply({ name, input }) {
    const sim = this.sim, agent = this.agent;
    const st = input.station_id && sim.processing.find((s) => s.id === input.station_id);
    let act = null, level = 'act';
    switch (name) {
      case 'schedule_maintenance': {
        if (!st || st.request || st.state === 'DOWN' || st.state === 'MAINT') {
          sim.log('warn', `Claude 조치 미적용 · ${st?.name ?? input.station_id}`, { obs: '응답 대기 중 설비 상태가 바뀜' });
          return;
        }
        level = 'plan';
        if (input.kind === 'cal' && sim.mode.key === 'dark') { sim.selfCalibrate(st); act = `${st.name} 자율 보정 (10초)`; }
        else { sim.requestTech(st, input.kind); act = `${st.name} ${input.kind === 'pm' ? '예지정비' : '재보정'} 인력 배정`; }
        break;
      }
      case 'set_cycle_mode':
        if (!st) return;
        if (input.mode === 'boost') {
          if (agent.boosted && agent.boosted !== st) agent.boosted.speedMul = 1;
          st.speedMul = 0.9; agent.boosted = st; act = `${st.name} 사이클 10% 단축`;
        } else {
          st.speedMul = 1; if (agent.boosted === st) agent.boosted = null; act = `${st.name} 표준 사이클 복귀`;
        }
        break;
      case 'set_release_interval':
        sim.releaseInterval = Math.min(20, Math.max(5, input.seconds));
        act = `투입 간격 ${sim.releaseInterval.toFixed(1)}초`;
        break;
      case 'set_release_hold':
        sim.releaseHold = input.hold; act = input.hold ? '자재 투입 보류' : '자재 투입 재개';
        break;
      case 'expedite_supply':
        act = agent.expedite() ?? '공급 차질이 없어 적용하지 않음';
        break;
      default:
        return;
    }
    agent.decisions++;
    sim.log(level, `Claude · ${act}`, { dec: input.reason });
  }
}
