// 공장 오케스트레이터 — 설비 고장·자재 공급 차질·현장 이벤트 같은 인시던트를
// 현장 감지 → 셀 자체 조치 → 상위 보고 → 판단 → 명령 → 실행 자원 조치 → 완료 확인 흐름으로 처리하고 단계마다 기록한다.
// 셀에서 해결되는 일(자율 재보정 등)은 셀 자체 조치 후 결과만 상위에 통보한다.
// 렌더링과 분리되어 있어 헤드리스 시뮬레이션에서도 같은 흐름으로 동작한다.

export const LANES = [
  { key: 'field', label: '현장 감지', sub: '로봇·센서·카메라' },
  { key: 'cell', label: '셀 컨트롤러', sub: '셀 자체 조치' },
  { key: 'orch', label: '공장 오케스트레이터', sub: '상황 판단·명령' },
  { key: 'exec', label: '실행 자원', sub: '정비·AGV·휴머노이드·사족보행' },
];
// 흐름 단계 (도표 상단 진행 표시)
export const STAGES = [
  { key: 'detect', label: '감지' }, { key: 'self', label: '셀 자체 조치' }, { key: 'report', label: '상위 보고' },
  { key: 'decide', label: '판단' }, { key: 'command', label: '명령' }, { key: 'act', label: '조치' }, { key: 'done', label: '완료 확인' },
];
export const INCIDENT_TYPES = {
  equipment: { label: '설비 고장', icon: '⚡' },
  supply: { label: '자재 공급 차질', icon: '⛔' },
  field: { label: '현장 이벤트', icon: '⚠' },
  quality: { label: '공정 편차', icon: '◎' },
  command: { label: '상위 명령', icon: '📡' },
  parts: { label: '부품 선반 결품', icon: '▦' },
};

export class Orchestrator {
  constructor(sim) {
    this.sim = sim; this.incidents = []; this.seq = 0; this.jobs = [];
  }
  // 오케스트레이터 이름·판단 지연 (단계별): 레거시는 작업반장이 직접 확인하고 판단한다
  get name() { return { traditional: '작업반장 (수동 판단)', smart: '공장 오케스트레이터 (MES)', dark: `피지컬AI 오케스트레이터${this.sim.aios?.latest ? ` · AIOS ${this.sim.aios.version}` : ''}` }[this.sim.mode.key]; }
  get latency() { return this.sim.mode.orchLatency ?? { traditional: 40, smart: 3, dark: 1.5 }[this.sim.mode.key]; }

  open(type, key, title, source, opts = {}) {
    const inc = { id: ++this.seq, type, key, title, source, t0: this.sim.time, steps: [], status: 'open', cellResolved: !!opts.cellResolved };
    this.incidents.unshift(inc);
    if (this.incidents.length > 40) this.incidents.pop();
    this.onOpen?.(inc);
    return inc;
  }
  find(key) { return this.incidents.find((i) => i.key === key && i.status === 'open'); }
  // kind: detect · self · report · decide · command · act · notify · done
  step(inc, lane, kind, text) {
    if (!inc || inc.status !== 'open') return;
    inc.steps.push({ t: this.sim.time, lane, kind, text });
  }
  close(inc, text, lane = 'orch') {
    if (!inc || inc.status !== 'open') return;
    this.step(inc, lane, 'done', text);
    inc.status = 'resolved'; inc.tEnd = this.sim.time;
  }
  later(delay, fn) { this.jobs.push({ at: this.sim.time + delay, fn }); }
  update() {
    if (!this.jobs.length) return;
    const due = this.jobs.filter((j) => j.at <= this.sim.time);
    if (!due.length) return;
    this.jobs = this.jobs.filter((j) => j.at > this.sim.time);
    for (const j of due) j.fn();
  }
  openCount() { return this.incidents.filter((i) => i.status === 'open').length; }
}
