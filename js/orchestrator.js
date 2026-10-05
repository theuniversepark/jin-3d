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

// 문제 해결 우선순위: 화재·사람·시설 안전을 먼저, 그다음 생산량·공정 운영·효율 (숫자가 작을수록 먼저)
export const PRIORITY = {
  1: { label: 'P1 화재·인명 안전', short: 'P1', desc: '화재 징후·사람 진입·비상정지 — 모든 일보다 먼저, 판단 대기 최소화, 대응 자원 선점' },
  2: { label: 'P2 시설·작업 안전', short: 'P2', desc: '바닥 누유·이물질(미끄럼·충돌) · 보호정지 — 생산 작업보다 먼저' },
  3: { label: 'P3 생산 정지', short: 'P3', desc: '설비 고장 — 안전 문제 다음으로 즉시 복구' },
  4: { label: 'P4 생산 차질', short: 'P4', desc: '자재 공급 차질·부품 결품·운영 명령' },
  5: { label: 'P5 효율·품질', short: 'P5', desc: '예지정비·재보정·공정 편차 — 안전(P1) 대응 중에는 보류' },
};
const TYPE_PRIO = { field: 2, equipment: 3, supply: 4, parts: 4, command: 4, quality: 5 };
export const prioOf = (inc) => inc?.prio ?? TYPE_PRIO[inc?.type] ?? 4;

export class Orchestrator {
  constructor(sim) {
    this.sim = sim; this.incidents = []; this.seq = 0; this.jobs = [];
  }
  // 오케스트레이터 이름·판단 지연 (단계별): 레거시는 작업반장이 직접 확인하고 판단한다
  get name() { return { traditional: '작업반장 (수동 판단)', smart: '공장 오케스트레이터 (MES)', dark: `피지컬AI 오케스트레이터${this.sim.aios?.latest ? ` · AIOS ${this.sim.aios.version}` : ''}` }[this.sim.mode.key]; }
  get latency() { return this.sim.mode.orchLatency ?? { traditional: 40, smart: 3, dark: 1.5 }[this.sim.mode.key]; }

  open(type, key, title, source, opts = {}) {
    const inc = { id: ++this.seq, type, key, title, source, t0: this.sim.time, steps: [], status: 'open', cellResolved: !!opts.cellResolved, where: opts.where ?? null, prio: opts.prio ?? TYPE_PRIO[type] ?? 4 };   // prio: 문제 해결 우선순위 (PRIORITY)   // where: 현장 위치 (드론 우선 출동)
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
  // 우선순위 lvl 이하(더 급한) 진행 중 인시던트
  urgentOpen(lvl) { return this.incidents.filter((i) => i.status === 'open' && prioOf(i) <= lvl); }
  // 판단 지연: 화재·인명 안전은 판단 대기를 줄여 바로 명령 (P1 25% · P2 50%)
  latencyFor(prio) { return Math.max(0.3, this.latency * (prio <= 1 ? 0.25 : prio === 2 ? 0.5 : 1)); }
  openCount() { return this.incidents.filter((i) => i.status === 'open').length; }
}
