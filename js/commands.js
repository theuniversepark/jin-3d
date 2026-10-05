// 상위 계층(공장 오케스트레이터) → 셀 현장 명령 — 긴급 명령(비상정지·리셋·보호정지·안전 감속·대피)과
// 제어 명령(사이클 정지·속도·투입 정지·재보정·예방정비)을 셀 컨트롤러로 보내고,
// 전송 → 수신 확인(ACK) → 실행 → 완료 보고 순서로 처리한다. 셀은 명령 상태에 따라 실제로 멈추고·느려지고·재가동한다.
// 명령마다 오케스트레이터 흐름도(스윔레인)에 기록되고, OPC UA PubSub 명령 메시지로 MQTT에 발행된다.
// 안전 규칙(비상정지 중 리셋 외 거부, 전체 비상정지 중 셀 리셋 거부 등)은 availability()에서 정하고, 셀 컨트롤러가 수신할 때 확인한다.

export const COMMANDS = {
  // ── 긴급 명령 ──
  ESTOP:      { group: 'emergency', icon: '🛑', label: '비상정지', desc: '정지 카테고리 0 — 로봇 즉시 정지·동력 차단, 셀 안 AMR 정지. 리셋 전까지 재가동 불가', scopes: ['all', 'cell'] },
  SAFE_STOP:  { group: 'emergency', icon: '✋', label: '보호정지', desc: '정지 카테고리 2 — 감속 정지 후 자세 유지(동력 유지). 재개 명령으로 바로 재가동', scopes: ['all', 'cell'] },
  SAFE_SPEED: { group: 'emergency', icon: '🐢', label: '안전 감속 25%', desc: '협동 운전 속도 제한 (ISO/TS 15066) — 사람·이물 인접 시', scopes: ['all', 'cell'] },
  EVACUATE:   { group: 'emergency', icon: '🏃', label: '이동로봇 대피', desc: 'AGV·휴머노이드·사족보행 로봇을 대기 구역으로 복귀시키고 해제까지 대기 (정비 중인 로봇은 작업을 마치고 복귀)', scopes: ['all'] },
  RESET:      { group: 'emergency', icon: '🔄', label: '비상정지 해제·리셋', desc: '안전 회로 리셋 → 셀 자가진단(5초) → 재가동', scopes: ['all', 'cell'] },
  // ── 제어 명령 ──
  CYCLE_STOP: { group: 'control', icon: '⏸', label: '사이클 정지', desc: '진행 중인 사이클을 마친 뒤 정지 (새 작업 받지 않음)', scopes: ['all', 'cell'] },
  RESUME:     { group: 'control', icon: '▶', label: '운전 재개', desc: '사이클 정지·보호정지·안전 감속·대피를 해제하고 정상 운전 (비상정지는 리셋 필요)', scopes: ['all', 'cell'] },
  SPEED:      { group: 'control', icon: '⏩', label: '속도 오버라이드', desc: '셀 사이클 속도 비율 변경', scopes: ['all', 'cell'], args: [50, 75, 100, 110], unit: '%' },
  FEED_HOLD:  { group: 'control', icon: '⛔', label: '투입 정지', desc: '자재 투입 스테이션의 신규 투입 중단 (라인 안 작업은 계속)', scopes: ['all'] },
  FEED_RESUME:{ group: 'control', icon: '📥', label: '투입 재개', desc: '자재 투입 재개', scopes: ['all'] },
  RECALIB:    { group: 'control', icon: '🎯', label: '자율 재보정', desc: '셀 로봇 비전·토크 재보정 (편차 드리프트 초기화)', scopes: ['cell'] },
  MAINT:      { group: 'control', icon: '🔧', label: '예방정비 지시', desc: '셀을 정비 모드로 전환하고 정비 로봇 배정', scopes: ['cell'] },
  // 콘솔에 버튼은 없고 오케스트레이터 자동 명령이 쓴다 (현장 이벤트 해소 시 감속만 해제 · 대피만 해제)
  SAFE_SPEED_OFF: { group: 'emergency', icon: '🐇', label: '안전 감속 해제', desc: '안전 감속을 풀고 정상 속도로 복귀', scopes: ['all', 'cell'], hidden: true },
  EVAC_END:   { group: 'emergency', icon: '↩', label: '이동로봇 대피 해제', desc: '대피를 풀고 이동로봇이 하던 일로 복귀', scopes: ['all'], hidden: true },
};
export const CMD_STATE = { sent: '전송', ack: '수신 확인', exec: '실행 중', done: '완료', rejected: '거부' };

// 단계별 전송 경로·지연 (초): 레거시는 반장이 무전·구두로 지시하고 작업자가 버튼을 누른다
const LINK = {
  traditional: { via: '무전·구두 지시 → 작업자 조작', delay: 8, estop: 3 },
  smart: { via: 'MES → PLC (OPC UA)', delay: 0.6, estop: 0.3 },
  dark: { via: '오케스트레이터 → 셀 컨트롤러 (OPC UA PubSub/TSN)', delay: 0.2, estop: 0.05 },
};

export class CommandCenter {
  constructor(sim) {
    this.sim = sim; this.seq = 0; this.list = []; this.out = [];
    // Zone 전체 상태: 비상정지·보호정지·안전 감속·속도 오버라이드·대피·투입 정지
    this.estopAll = false; this.pstopAll = false; this.lineSafe = false; this.overrideAll = 1; this.evac = false; this.feedHold = false;
  }
  // 투입·AMR·이동로봇 이동 속도 비율 (Zone 전체 속도 오버라이드 × 안전 감속)
  get lineSpeed() { return this.overrideAll * (this.lineSafe ? 0.25 : 1); }
  get link() { return LINK[this.sim.mode.key]; }
  cells() { return this.sim.processing.filter((st) => !st.standby); }
  targets(target) { return target === 'all' ? this.cells() : this.sim.processing.filter((st) => st.id === target); }
  targetName(target) { return target === 'all' ? '정밀조립Zone 전체' : this.sim.processing.find((st) => st.id === target)?.name ?? target; }
  label(c) { const C = COMMANDS[c.code]; return `${C.label}${c.arg != null ? ` ${c.arg}${C.unit ?? ''}` : ''}`; }
  active() { return this.list.filter((c) => c.state !== 'done' && c.state !== 'rejected'); }
  pending(code, target, arg) { return this.active().find((c) => c.code === code && c.target === target && (arg == null || c.arg === arg)); }

  // 대상의 현재 명령 상태 (Zone 전체 또는 셀 하나)
  status(target) {
    const all = target === 'all';
    if (all) {
      const cs = this.cells();
      return { all, estop: this.estopAll, anyEstop: this.estopAll || cs.some((st) => st.cmd?.estop), pstop: this.pstopAll, safe: this.lineSafe,
        cycle: cs.length > 0 && cs.every((st) => st.cmd?.hold === 'cycle'), override: this.overrideAll, check: cs.some((st) => st.cmd?.check > 0), evac: this.evac, feed: this.feedHold };
    }
    const st = this.sim.processing.find((x) => x.id === target), k = st?.cmd ?? {};
    return { all, st, estop: !!k.estop || this.estopAll, zoneEstop: this.estopAll, pstop: k.hold === 'protective' || this.pstopAll, zonePstop: this.pstopAll,
      safe: !!k.safe || this.lineSafe, zoneSafe: this.lineSafe, cycle: k.hold === 'cycle', override: k.override ?? 1, check: k.check > 0, evac: this.evac, feed: this.feedHold };
  }

  // 이 대상에 이 명령을 지금 쓸 수 있는가 — ok, reason(쓸 수 없는 이유), hard(안전 규칙: 셀 컨트롤러도 거부), active(이미 적용 중)
  availability(code, target, arg = null, self = null) {
    const C = COMMANDS[code], all = target === 'all';
    if (!C) return { ok: false, reason: '알 수 없는 명령', hard: true };
    if (!C.scopes.includes(all ? 'all' : 'cell')) return { ok: false, reason: all ? '셀을 고르면 쓸 수 있습니다' : 'Zone 전체에서만 쓸 수 있습니다', hard: true };
    const T = this.status(target);
    if (!all && !T.st) return { ok: false, reason: '대상 셀 없음', hard: true };
    const p = this.pending(code, target, arg);
    if (p && p !== self) return { ok: false, reason: '전송 중…', active: true };
    const no = (reason, hard = false, active = false) => ({ ok: false, reason, hard, active });
    if (code === 'ESTOP') return T.estop ? no('이미 비상정지 중', false, true) : { ok: true };
    if (code === 'RESET') {
      if (!all && T.zoneEstop) return no('Zone 전체 비상정지 중 — 대상을 Zone 전체로 바꿔 리셋', true);
      return (all ? T.anyEstop : T.estop) ? { ok: true } : no('비상정지 상태가 아닙니다');
    }
    if (code === 'EVACUATE') return T.evac ? no('대피 중', false, true) : { ok: true };
    if (code === 'EVAC_END') return T.evac ? { ok: true } : no('대피 중이 아닙니다');
    if (T.estop) return no('비상정지 중 — 먼저 리셋', true);
    if (T.check) return no('자가진단 중 — 잠시 후');
    switch (code) {
      case 'SAFE_STOP': return T.pstop ? no('보호정지 중', false, true) : { ok: true };
      case 'RESUME':
        if (!all && T.zonePstop) return no('Zone 전체 보호정지 중 — Zone 전체에서 해제', true);
        return { ok: true };
      case 'SAFE_SPEED': return T.safe ? no('감속 중', false, true) : { ok: true };
      case 'SAFE_SPEED_OFF':
        if (!all && T.zoneSafe) return no('Zone 전체 감속 중 — Zone 전체에서 해제', true);
        return T.safe || (all && this.cells().some((st) => st.cmd?.safe)) ? { ok: true } : no('감속 중이 아닙니다');
      case 'CYCLE_STOP': return T.cycle ? no('사이클 정지 중', false, true) : T.pstop ? no('보호정지 중') : { ok: true };
      case 'SPEED': return Math.round(T.override * 100) === arg ? no('현재 속도', false, true) : { ok: true };
      case 'FEED_HOLD': return T.feed ? no('투입 정지 중', false, true) : { ok: true };
      case 'FEED_RESUME': return T.feed ? { ok: true } : no('투입 정지 상태가 아닙니다');
      case 'RECALIB': case 'MAINT': {
        const st = T.st;
        if (st.state === 'DOWN') return no('고장 수리 중', true);
        if (st.state === 'MAINT' || st.request) return no('정비·보정 진행 중', true);
        if (T.pstop || T.cycle) return no('정지 상태 — 먼저 재개');
        return { ok: true };
      }
    }
    return { ok: true };
  }

  // 명령 발행 — by: 발행 주체, inc: 연결할 인시던트(없으면 명령 인시던트를 새로 연다), why: 발행 사유
  issue(code, target = 'all', arg = null, { by, inc, why } = {}) {
    const s = this.sim, o = s.orch, C = COMMANDS[code];
    if (!C || !C.scopes.includes(target === 'all' ? 'all' : 'cell')) return null;
    const c = { id: ++this.seq, code, target, arg, by: by ?? o.name, why, t: s.time, state: 'sent', history: [] };
    this.list.unshift(c); if (this.list.length > 60) this.list.pop();
    c.inc = inc ?? o.open('command', `cmd:${c.id}`, `${C.icon} ${this.label(c)} → ${this.targetName(target)}`, c.by, { prio: C.group === 'emergency' ? 1 : 4 });   // 긴급 명령(비상정지·보호정지 등)은 P1
    o.step(c.inc, 'orch', 'command', `${C.group === 'emergency' ? '긴급 명령' : '제어 명령'} #${c.id}: ${this.label(c)} → ${this.targetName(target)}${why ? ` (${why})` : ''}`);
    this.mark(c, 'sent');
    s.log(C.group === 'emergency' ? 'alert' : 'act', `${C.group === 'emergency' ? '긴급' : '제어'} 명령 #${c.id} · ${this.label(c)}`, { obs: `대상: ${this.targetName(target)}`, dec: why ?? `${c.by} 지시`, act: `${this.link.via} 전송` });
    o.later(code === 'ESTOP' ? this.link.estop : this.link.delay, () => this.receive(c));
    return c;
  }

  // 상태 변화 기록 — out은 데이터 허브가 가져가 OPC UA 명령 메시지로 발행한다 (허브가 없으면 오래된 것부터 버림)
  mark(c, state, text) {
    c.state = state; c.history.push({ t: this.sim.time, state }); if (text) c.note = text;
    this.out.push({ c, state, t: this.sim.time, text });
    if (this.out.length > 500) this.out.shift();
  }

  // 셀 컨트롤러 수신 → 안전 규칙 확인(ACK/거부) → 실행. 같은 상태로 다시 보내는 명령(이미 정지 등)은 받아들이고 그대로 둔다
  receive(c) {
    const o = this.sim.orch, av = this.availability(c.code, c.target, c.arg, c);
    if (!av.ok && av.hard) {
      this.mark(c, 'rejected', av.reason);
      o.step(c.inc, 'cell', 'report', `명령 #${c.id} 거부: ${av.reason}`);
      if (c.inc.key === `cmd:${c.id}`) o.close(c.inc, `명령 거부 확인 · ${av.reason}`);
      return;
    }
    this.mark(c, 'ack');
    o.step(c.inc, 'cell', 'act', `셀 컨트롤러 수신 확인(ACK) · ${this.link.via}`);
    this.mark(c, 'exec');
    this.apply(c, this.targets(c.target));
  }

  apply(c, sts) {
    const s = this.sim, o = s.orch, all = c.target === 'all';
    const done = (text) => { if (c.state === 'done') return; this.mark(c, 'done', text); o.step(c.inc, 'cell', 'notify', `완료 보고: ${text}`); if (c.inc.key === `cmd:${c.id}`) o.close(c.inc, `명령 #${c.id} 이행 확인`); };
    const ensure = (st) => (st.cmd ??= { estop: false, hold: null, override: 1, safe: false, check: 0 });
    const n = sts.length;
    switch (c.code) {
      case 'ESTOP':
        for (const st of sts) { const k = ensure(st); k.estop = true; k.hold = null; k.check = 0; }
        if (all) this.estopAll = true;
        o.step(c.inc, 'cell', 'act', `실행: ${all ? '전 셀·AMR·이동로봇' : sts[0].name} 즉시 정지 · 로봇 동력 차단`);
        return done(`${n}개 셀 정지 확인 (안전 PLC 정지 신호)`);
      case 'RESET': {
        const tgt = sts.filter((st) => st.cmd?.estop);
        if (all) this.estopAll = false;
        if (!tgt.length && !all) return done('비상정지 상태 아님 — 조치 없음');
        for (const st of tgt) { st.cmd.estop = false; st.cmd.check = 5; }
        o.step(c.inc, 'cell', 'act', `실행: 안전 회로 리셋 · ${tgt.length}개 셀 자가진단 (5초)`);
        c.wait = () => tgt.every((st) => !(st.cmd.check > 0) || st.cmd.estop);
        c.onDone = () => done(tgt.some((st) => st.cmd.estop) ? '자가진단 중 비상정지 재발령 — 정지 유지' : '자가진단 정상 · 재가동');
        return;
      }
      case 'SAFE_STOP':
        for (const st of sts) ensure(st).hold = 'protective';
        if (all) this.pstopAll = true;
        o.step(c.inc, 'cell', 'act', '실행: 감속 정지 → 자세 유지 (동력 유지)');
        return done(`${n}개 셀 보호정지 확인`);
      case 'RESUME':
        for (const st of sts) { const k = ensure(st); k.hold = null; k.safe = false; }
        if (all) { this.pstopAll = false; this.lineSafe = false; if (this.evac) { this.evac = false; o.step(c.inc, 'exec', 'act', '이동로봇 대피 해제 · 작업 복귀'); } }
        o.step(c.inc, 'cell', 'act', `실행: 정상 운전 복귀${sts.some((st) => st.cmd.estop) ? ' (비상정지 셀은 리셋 필요)' : ''}`);
        return done(`${sts.filter((st) => !st.cmd.estop).length}개 셀 운전 재개`);
      case 'SAFE_SPEED':
        for (const st of sts) ensure(st).safe = true;
        if (all) this.lineSafe = true;
        o.step(c.inc, 'cell', 'act', `실행: 로봇 속도 25% 제한 · 협동 운전${all ? ' · 투입·이동 속도 25%' : ''}`);
        return done(`${n}개 셀 협동 감속 적용`);
      case 'SAFE_SPEED_OFF':
        for (const st of sts) ensure(st).safe = false;
        if (all) this.lineSafe = false;
        o.step(c.inc, 'cell', 'act', '실행: 안전 감속 해제 · 정상 속도');
        return done(`${n}개 셀 정상 속도 복귀`);
      case 'EVACUATE': {
        this.evac = true;
        const movers = [...s.vehicles, ...s.forklifts, ...s.helpers, ...s.quads];   // 정비 로봇은 수리를 마저 하고 복귀
        for (const m of movers) this.preempt(m, '대피', [{ go: m.home }, { until: () => !this.evac }]);
        o.step(c.inc, 'exec', 'act', `실행: 이동로봇 ${movers.length}대 대기 구역으로 복귀`);
        c.wait = () => !this.evac || movers.every((m) => Math.hypot(m.x - m.home.x, m.z - m.home.z) < 0.6);
        c.onDone = () => done(this.evac ? '이동로봇 대기 구역 집결 확인' : '집결 전 대피 해제');
        return;
      }
      case 'EVAC_END':
        this.evac = false;
        o.step(c.inc, 'exec', 'act', '실행: 대피 해제 · 이동로봇 하던 작업으로 복귀');
        return done('이동로봇 작업 복귀');
      case 'CYCLE_STOP':
        for (const st of sts) ensure(st).hold = 'cycle';
        o.step(c.inc, 'cell', 'act', '실행: 진행 중 작업 마무리 후 정지');
        c.wait = () => sts.every((st) => st.cmd.hold !== 'cycle' || st.cmd.estop || !st.item || st.done);
        c.onDone = () => done(`${n}개 셀 작업 마무리 후 정지`);
        return;
      case 'SPEED': {
        const k = (c.arg ?? 100) / 100;
        for (const st of sts) ensure(st).override = k;
        if (all) this.overrideAll = k;
        o.step(c.inc, 'cell', 'act', `실행: 작업 속도 ${c.arg}%${k > 1 ? ' (마모 증가)' : ''}`);
        return done(`작업 속도 ${c.arg}% 적용`);
      }
      case 'FEED_HOLD':
        this.feedHold = true;
        o.step(c.inc, 'cell', 'act', '실행: 투입 스테이션 신규 투입 중단');
        return done('투입 정지 확인');
      case 'FEED_RESUME':
        this.feedHold = false;
        o.step(c.inc, 'cell', 'act', '실행: 투입 재개');
        return done('투입 재개 확인');
      case 'RECALIB': {
        const st = sts[0], before = st.drift;
        ensure(st).check = 4;
        o.step(c.inc, 'cell', 'act', `실행: 비전·토크 재보정 (드리프트 ${(before * 100).toFixed(0)}%)`);
        c.wait = () => !(st.cmd.check > 0);
        c.onDone = () => { st.drift = 0; done(`재보정 완료 · 드리프트 ${(before * 100).toFixed(0)}% → 0%`); };
        return;
      }
      case 'MAINT': {
        const st = sts[0];
        st.state = 'MAINT'; st.maintKind = 'pm'; st.techOnSite = false;   // 정비 로봇이 도착할 때까지 셀 정지
        s.requestTech(st, 'pm');
        o.step(c.inc, 'cell', 'act', '실행: 셀 정비 모드 전환 · 정비 로봇 호출');
        c.wait = () => st.state !== 'MAINT';
        c.onDone = () => done(`예방정비 완료 · 건강도 ${st.health.toFixed(0)}%`);
        return;
      }
    }
  }

  // 하던 일 앞에 끼워 넣는다 — 해제되면 원래 작업을 이어서 한다 (운반 중이던 자재도 그대로)
  preempt(m, name, steps) {
    const prev = m.task;
    m.steps.unshift(...steps, { do: () => { m.task = prev; } });
    m.task = name; m.path = null; m.detourPts = 0;
  }

  update(dt) {
    for (const st of this.sim.processing) if (st.cmd?.check > 0 && !this.estopAll && !st.cmd.estop) st.cmd.check -= dt;
    for (const c of this.list) if (c.state === 'exec' && c.wait?.()) { c.wait = null; c.onDone?.(); }
  }

  // 명령으로 멈춘 셀의 표시 상태 (고장·정비 셀은 그 상태를 유지하고 진행만 멈춘다)
  stationGate(st) {
    const k = st.cmd;
    if (this.estopAll || k?.estop) return 'ESTOP';
    if (k?.check > 0) return 'CHECK';
    if (this.pstopAll || k?.hold === 'protective') return 'PSTOP';
    return null;
  }
  // 비상정지 중에는 수리·정비 진행도 멈춘다 (동력 차단·잠금)
  locked(st) { return this.estopAll || !!st.cmd?.estop; }
  speedOf(st) { const k = st.cmd; return (k?.override ?? 1) * (k?.safe || this.lineSafe ? 0.25 : 1); }
}
