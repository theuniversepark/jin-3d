// 대화 기반 운영 컨트롤러 — 추론 기반 에이전트(FactoryAgent)가 정비·품질·흐름·물류를 계속 운영하고,
// 입력창의 운영자 지시만 해석해 공정에 반영한다. 내장 해석기(js/dialog.js)가 먼저 처리하고,
// 해석하지 못한 문장은 Claude가 연결되어 있을 때 Claude가 해석해 같은 조치(도구)로 돌려준다.
import { parseInstruction, applyAction, DIALOG_EXAMPLES } from './dialog.js';

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
    // 공유 페이지(서버 없음)에서는 Claude 서버에 묻지 않는다
    if (window.JIN3D_SHARED || window.JIN3D_NO_SERVER) { this.available = false; this.onChange?.(); return; }
    try {
      const r = await fetch('/api/status');
      if (r.ok) { const j = await r.json(); this.available = !!j.llm; this.model = j.model; }
    } catch { this.available = false; }
    this.onChange?.();
  }

  attach(sim, agent) {
    this.sim = sim; this.agent = agent;
    this.history = []; this.queue = null;
    this.gen = (this.gen ?? 0) + 1;     // 모드 전환 시 이전 응답 무시
    this.setEnabled(this.enabled && sim.mode.agentActive);
  }

  // 대화 기반은 Claude 연결 없이도 쓸 수 있다 (내장 해석기). 운영 판단은 언제나 추론 기반 에이전트가 한다
  setEnabled(on) {
    this.enabled = !!(on && this.sim?.mode.agentActive);
    if (this.agent) this.agent.llm = false;
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

  // 운영자 지시: 내장 해석기로 문장별 조치를 만들어 바로 반영하고, 해석하지 못한 문장은 Claude에 맡긴다
  chat(text) {
    if (!this.enabled) return false;
    const sim = this.sim;
    this.history.push({ t: fmt(sim.time), who: '운영자', text });
    sim.log('chat', '운영자 지시', { obs: text });
    const { actions, unknown } = parseInstruction(text, sim);
    const results = actions.map((a) => ({ a, r: applyAction(a, sim, { agent: this.agent, onMix: this.onMix }) }));
    const done = results.filter((x) => x.r.ok && !x.r.reply), replies = results.filter((x) => x.r.reply), failed = results.filter((x) => !x.r.ok);
    if (results.length) {
      this.agent.decisions += done.length;
      sim.log('dialog', done.length ? '대화 지시 → 공정 반영' : replies.length ? '대화 지시 → 상태 응답' : '대화 지시 → 반영 안 됨', {
        obs: [...new Set(actions.map((a) => a.clause))].join(' / '),
        dec: '추론 기반 운영 위에 운영자 지시 적용 (내장 해석기)',
        act: results.map((x) => `${x.r.ok ? '✓' : '✗'} ${x.r.text}`).join('\n'),
      });
      this.history.push({ t: fmt(sim.time), who: '에이전트', text: results.map((x) => x.r.text).join(' / ') });
    }
    if (unknown.length) {
      if (this.available) this.request('운영자 지시 해석 (내장 해석기로 알 수 없는 문장)', true, unknown.join(' / '));
      else sim.log('dialog', '대화 지시 → 해석하지 못함', { obs: unknown.join(' / '), dec: 'Agent 미연결 — 내장 해석기로 알 수 없는 문장', act: `예: ${DIALOG_EXAMPLES.join(' · ')}` });
    }
    return true;
  }

  // 대화 기반에서는 Claude를 주기적으로 부르지 않는다 (운영 판단은 추론 기반 에이전트)
  update() {}

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
      product_mix: sim.zone ? sim.line.mix : null,
      commands: { estop_all: sim.cmd.estopAll, pstop_all: sim.cmd.pstopAll, feed_hold: sim.cmd.feedHold, evacuate: sim.cmd.evac, line_speed_pct: Math.round(sim.cmd.lineSpeed * 100),
        cells: sim.processing.map((st) => ({ id: st.id, estop: !!st.cmd?.estop, hold: st.cmd?.hold ?? null, safe_speed: !!st.cmd?.safe, speed_pct: Math.round((st.cmd?.override ?? 1) * 100) })) },
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
      for (const r of out.rejected) this.sim.log('warn', `Agent 제안 반려 · ${r.name}`, { obs: r.input.reason, dec: r.error });
      if (out.text) {
        this.history.push({ t: fmt(this.sim.time), who: '에이전트', text: out.text });
        this.sim.log('llm', 'Agent 판단', { obs: trigger, dec: out.text, act: out.actions.length ? `조치 ${out.actions.length}건 실행` : '추가 조치 없음' });
      }
      this.status = `${(out.latencyMs / 1000).toFixed(1)}초 응답 · 조치 ${out.actions.length}건`;
    } catch (e) {
      if (gen !== this.gen) return;
      this.sim.log('alert', 'Agent 호출 실패', { obs: e.message, act: '추론 기반 에이전트로 계속 운영 · 지시를 더 짧게 다시 입력해 보세요' });
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
          sim.log('warn', `Agent 조치 미적용 · ${st?.name ?? input.station_id}`, { obs: '응답 대기 중 설비 상태가 바뀜' });
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
      // 대화 지시 해석 결과: 상위 명령·혼류 비율 (내장 해석기와 같은 경로로 실행)
      case 'issue_command': case 'set_mix': {
        const r = applyAction(name === 'set_mix' ? { type: 'mix', mix: input.mix } : { type: 'command', code: input.code, target: input.target, arg: input.arg ?? null, clause: input.reason },
          sim, { by: 'Agent · 대화 지시 해석', agent, onMix: this.onMix });
        if (!r.ok) { sim.log('warn', `Agent 조치 미적용 · ${r.text}`, { dec: input.reason }); return; }
        act = r.text;
        break;
      }
      default:
        return;
    }
    agent.decisions++;
    sim.log(level, `Agent · ${act}`, { dec: input.reason });
  }
}
