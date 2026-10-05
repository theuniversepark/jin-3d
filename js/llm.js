// 대화 기반 운영 컨트롤러 — 추론 기반 에이전트(FactoryAgent)가 정비·품질·흐름·물류를 계속 운영하고,
// 입력창의 운영자 지시만 해석해 공정에 반영한다. 내장 해석기(js/dialog.js)가 먼저 처리하고,
// 해석하지 못한 문장은 Claude가 연결되어 있을 때 Claude가 해석해 같은 조치(도구)로 돌려준다.
import { parseInstruction, applyAction, DIALOG_EXAMPLES } from './dialog.js';
import { evaluate } from './gate.js';

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

  // 대화 기반은 Claude 연결 없이도 쓸 수 있다 (내장 해석기). 운영 판단은 언제나 추론 기반 에이전트가 한다 — Claude는 운영자 지시 해석에만 쓴다
  setEnabled(on) {
    this.enabled = !!(on && this.sim?.mode.agentActive);
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

  // 운영자 지시: 내장 해석기로 문장별 조치를 만들고, 조치마다 게이트(해석·대상·안전·실행 가능성·영향)를 거쳐
  // 수행 또는 거절한다. 기록(dialogs)은 대화창 항목을 누르면 게이트 도식으로 보인다.
  chat(text) {
    if (!this.enabled) return false;
    const sim = this.sim;
    this.history.push({ t: fmt(sim.time), who: '운영자', text });
    const rec = { id: (this.dlgSeq = (this.dlgSeq ?? 0) + 1), t: sim.time, text, items: [] };
    (this.dialogs ??= []).unshift(rec); if (this.dialogs.length > 40) this.dialogs.pop();
    sim.log('chat', '운영자 지시', { obs: text, dlg: rec.id });
    const { actions, unknown } = parseInstruction(text, sim);
    for (const a of actions) this.gateAndRun(rec, a, '내장 해석기');
    for (const c of unknown) {
      if (this.available) rec.items.push({ clause: c, source: 'Agent', gate: { checks: [{ key: 'parse', status: 'warn', text: `"${c}" — 내장 해석기로 알 수 없어 Agent에 해석 요청` }], verdict: 'pending', summary: 'Agent 해석 대기' } });
      else rec.items.push({ clause: c, source: '내장 해석기', gate: evaluate({ type: 'unknown', clause: c }, sim, this.agent) });
    }
    this.logDialog(rec);
    if (unknown.length && this.available) { this.pendingDialog = rec; this.request('운영자 지시 해석 (내장 해석기로 알 수 없는 문장)', true, unknown.join(' / ')); }
    return true;
  }

  // 게이트 판정 후 수행(실행 결과·명령 추적) 또는 거절
  gateAndRun(rec, a, source) {
    const sim = this.sim, gate = evaluate(a, sim, this.agent);
    const item = { clause: a.clause, source, action: a, gate };
    if (gate.verdict === 'approve' || gate.verdict === 'answer') {
      const r = applyAction(a, sim, { agent: this.agent, onMix: this.onMix, by: source === 'Agent' ? 'Agent · 대화 지시 해석' : '운영자 대화 지시' });
      item.result = r; item.cmd = r.cmd ?? null;
      if (!r.ok) { gate.verdict = 'reject'; gate.reason = r.text; }
      else if (gate.verdict === 'approve') this.agent.decisions++;
    }
    rec.items.push(item);
    return item;
  }

  logDialog(rec, items = rec.items) {
    const sim = this.sim;
    if (!items.length) return;
    const line = (it) => it.gate.verdict === 'approve' ? `✓ 수행 · ${it.result?.text ?? it.gate.summary}`
      : it.gate.verdict === 'answer' ? `💬 ${it.result?.text ?? ''}` : it.gate.verdict === 'pending' ? `⏳ ${it.gate.summary} · "${it.clause}"`
      : `✗ 거절 · ${it.gate.summary} — ${it.gate.reason}${it.gate.alt ? ` (${it.gate.alt})` : ''}`;
    const nOk = items.filter((i) => i.gate.verdict === 'approve').length, nNo = items.filter((i) => i.gate.verdict === 'reject').length;
    sim.log('dialog', `지시 게이트 · 수행 ${nOk} · 거절 ${nNo}${items.some((i) => i.gate.verdict === 'answer') ? ' · 응답' : ''}${items.some((i) => i.gate.verdict === 'pending') ? ' · Agent 해석 중' : ''}`, {
      obs: [...new Set(items.map((i) => i.clause))].join(' / '),
      dec: items.map((i) => i.gate.checks.map((c) => `${{ pass: '✓', warn: '⚠', fail: '✗' }[c.status]}${{ parse: '해석', target: '대상', safety: '안전', feasible: '가능', impact: '영향' }[c.key]}`).join(' ')).join(' | '),
      act: items.map(line).join('\n'), dlg: rec.id,
    });
    this.history.push({ t: fmt(sim.time), who: '에이전트', text: items.map(line).join(' / ') });
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
      // 드론 현장 관찰: 사고 현장을 먼저 날아가 본 영상 분석 결과 — 대응 조치 수립 근거
      drone: (sim.drones ?? []).map((d) => ({ id: d.id, task: d.task, battery: Math.round(d.battery), mission: d.mission ? { incident: d.mission.title, arrived: !!d.arrived } : null })),
      incidents_open: sim.orch.incidents.filter((i) => i.status === 'open').map((i) => ({ type: i.type, title: i.title, age_s: Math.round(sim.time - i.t0), drone_observation: i.drone?.obs ?? null })),
      recent_events: sim.logs.slice(0, 8).map((l) => `[${fmt(l.t)}] ${l.title}`),
      // 현장 감시 · 통신 · 에너지 · ERP — 판단 근거 (CCTV 에이전트 보고, 5G 링크, 배터리 부족 로봇, Odoo 발주·정비요청)
      cctv: sim.cctvAgent ? { cameras: sim.cctv.cams.length, blind_spots: sim.cctv.stats.blind, open_events: sim.cctvAgent.history.filter((h) => h.status === 'open').map((h) => ({ no: h.no, kind: h.kind, cam: h.cam, label: h.label, conf: h.conf })) } : null,
      network_5g: sim.net?.on ? (() => { const Q = sim.net.summary(); return { cells: sim.net.plan.cells.length, ues: Q.ues, handovers: Q.ho, ho_fail: Q.hoFail, rlf: Q.rlf, uplink_lost: Q.lost, weakest_rsrp_dbm: r1(Math.min(...sim.net.ues.map((u) => u.rsrp))) }; })() : null,
      low_battery: [...sim.vehicles, ...sim.carriers, ...sim.helpers, ...sim.techs.filter((t) => t.kind === 'humanoid'), ...sim.quads, ...(sim.drones ?? [])].filter((m) => m.battery != null && m.battery < 35).map((m) => ({ id: m.id, battery: Math.round(m.battery), charging: !!(m.charging || m.chgNow) })),
      erp: sim.erp?.on ? (() => { const E = sim.erp.stats(); return { purchase_orders_open: E.poOpen, maintenance_requests_open: sim.erp.db.mr.filter((m) => m.stage !== 'done').map((m) => ({ ref: m.ref, equipment: m.equipmentName, type: m.type, stage: m.stage })), rack_stock: { raw: sim.erp.quant.rackRaw.raw, parts: sim.erp.quant.rackParts.parts } }; })() : null,
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
      const rec = this.pendingDialog; this.pendingDialog = null;
      if (rec) {
        for (const it of rec.items) if (it.gate.verdict === 'pending') { it.gate.verdict = rec.agentItems?.length ? 'delegated' : 'reject'; it.gate.reason = rec.agentItems?.length ? 'Agent가 해석해 아래 조치로 전환' : 'Agent도 공정 조치로 해석하지 못함'; it.gate.checks[0].text += rec.agentItems?.length ? ' → 해석됨' : ' → 조치 없음'; it.reply = out.text; }
        this.logDialog(rec, rec.agentItems ?? []);
      }
      if (out.text) {
        this.history.push({ t: fmt(this.sim.time), who: '에이전트', text: out.text });
        this.sim.log('llm', 'Agent 판단', { obs: trigger, dec: out.text, act: out.actions.length ? `조치 ${out.actions.length}건 실행` : '추가 조치 없음' });
      }
      this.status = `${(out.latencyMs / 1000).toFixed(1)}초 응답 · 조치 ${out.actions.length}건`;
    } catch (e) {
      if (gen !== this.gen) return;
      if (this.pendingDialog) { for (const it of this.pendingDialog.items) if (it.gate.verdict === 'pending') { it.gate.verdict = 'reject'; it.gate.reason = `Agent 호출 실패: ${e.message}`; } this.pendingDialog = null; }
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
        const a = name === 'set_mix' ? { type: 'mix', mix: input.mix, clause: input.reason } : { type: 'command', code: input.code, target: input.target, arg: input.arg ?? null, clause: input.reason };
        const rec = this.pendingDialog;
        if (rec) { rec.agentItems ??= []; rec.agentItems.push(this.gateAndRun(rec, a, 'Agent')); return; }
        const r = applyAction(a, sim, { by: 'Agent · 대화 지시 해석', agent, onMix: this.onMix });
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
