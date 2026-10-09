// 피지컬AI 다중 계층 보안 (총괄4 — 라온시큐어 사업단 「협업지능 시스템을 위한 피지컬AI 기반 다중 계층 보안기술 개발」 착수보고 2026.9 기준)
// FACOS 운영 흐름에 4개 보안 계층을 끼워 시뮬레이션으로 재현한다 — 실제 암호 연산·보안 모듈이 아니라, 어떤 주체·데이터·명령이
// 어느 계층에서 어떤 검증을 거치는지와 그 결과(통과·차단)를 기록한다. 렌더링과 분리되어 헤드리스에서도 같은 동작.
//  ① 피지컬AI 에이전트 보안: DID/VC 디지털 신원 · 최소 권한(PoLP) — ONE Access · TrustCore
//  ② 데이터·IP 보안: 동형암호 연합학습 · ZKML 무결성 검증 · eVDI 격리 워크스페이스 · 반출 통제(DLP)
//  ③ AI 모델 보안: 메타모픽(MR) · 차등 테스팅 → Safety Score · DRS
//  ④ OT 보안: OTAC 단방향 다이나믹 인증 · 구간 암호화 · DPI 명령 선별 제어 · AI 이상 탐지

export const SEC_LAYERS = {
  agent: { icon: '🪪', label: '피지컬AI 에이전트 보안', sub: 'DID/VC 신원 · 최소 권한', by: '라온시큐어 (ONE Access · TrustCore)' },
  data: { icon: '🔐', label: '데이터·IP 보안', sub: '동형암호 연합학습 · ZKML · eVDI 반출 통제', by: '디사일로 · 서강대 · 틸론' },
  model: { icon: '🧪', label: 'AI 모델 보안', sub: '메타모픽·차등 테스팅 → Safety Score', by: '전북대' },
  ot: { icon: '🏭', label: 'OT 보안', sub: 'OTAC 단방향 인증 · 구간 암호화 · DPI · AI 이상 탐지', by: '센스톤 · 아이티스테이션' },
};
// 1차년도(2026) 성과지표 목표 — 착수보고 8. 성과지표
export const SEC_KPI = [
  { name: 'AI 모델 안전성 검증모듈 적대적 공격 탐지 정확도', target: '70% 이상', org: '전북대', layer: 'model' },
  { name: 'AI 모델 행동 원인분석 정확도', target: '70% 이상', org: '전북대', layer: 'model' },
  { name: '암호화 적용에 따른 통신 지연 증가율 (평문 대비)', target: '50% 이하', org: '센스톤', layer: 'ot' },
  { name: 'DID/VC 기반 디지털 신원·권한 거버넌스', target: '90% 이상', org: '라온시큐어', layer: 'agent' },
  { name: '영지식(ZKML) 기반 무결성 위변조 탐지율', target: '90% 이상', org: '서강대', layer: 'data' },
  { name: '동형암호 연합학습 처리시간 (1만 파라미터)', target: '500ms 이하', org: '디사일로', layer: 'data' },
  { name: '신뢰무결성 컴포저블 모듈 입력조작 탐지정확도', target: '80% 이상', org: '틸론', layer: 'data' },
  { name: '신뢰무결성 컴포저블 모듈 민감정보 탐지정확도', target: '80% 이상', org: '틸론', layer: 'data' },
];
// 위협 주입 (시연) — 어느 계층이 막는지
export const SEC_THREATS = {
  spoof: { label: '위조 제어 명령', icon: '🎭', layer: 'ot', desc: '신원 없는 주체가 셀에 속도 변경 명령을 보냄 → OTAC 인증 실패 · DID 서명 없음 → 차단' },
  privesc: { label: '권한 밖 명령', icon: '🔓', layer: 'agent', desc: '로봇 에이전트가 비상정지 해제를 요청 → VC 권한(최소 권한) 밖 → 거부' },
  tamper: { label: '학습 데이터 위변조', icon: '🧬', layer: 'data', desc: 'VLA 에피소드 실행 로그 해시 불일치 → ZKML 무결성 검증 실패 → 해당 데이터 격리' },
  exfil: { label: '노하우 무단 반출', icon: '📤', layer: 'data', desc: '제조 레시피(명령 노하우)를 eVDI 밖으로 반출 시도 → DLP 민감정보 탐지 → 차단' },
};
// 통신 지연 모델 (가정값): 셀 명령 메시지 평문 왕복 지연과 구간 암호화(인증 연계 세션키 · AES-GCM) 추가 지연
const PLAIN_MS = 4.0, ENC_MS = 1.3;
// 동형암호 연합학습 집계 시간 모델 (가정값): 1만 파라미터당
const HE_MS_PER_10K = 410;

export class SecurityLayer {
  constructor(sim) {
    this.sim = sim; this.on = sim.mode.key === 'dark';
    this.ids = new Map();   // 주체 이름/ID → { did, name, kind, scopes }
    this.log = []; this.seq = 0;
    this.stats = { cmdVerified: 0, cmdBlocked: 0, otac: 0, dpiWrite: 0, encMsgs: 0, heRounds: 0, zkml: 0, zkmlFail: 0, mrTests: 0, exports: 0, exportBlocked: 0, threats: 0, blocked: 0 };
    this.byLayer = { agent: 0, data: 0, model: 0, ot: 0 };
    this.scores = [];   // VLA 후보 모델별 Safety Score · DRS
    sim.sec = this;
  }
  // 신원 등록 (DID/VC 발행) — 물리 에이전트(로봇·이동체·드론)와 소프트웨어 에이전트, 각자 역할에 필요한 권한만(최소 권한)
  register() {
    if (!this.on || this.ids.size) return;
    const s = this.sim, add = (key, name, kind, scopes) => this.ids.set(key, { did: `did:camtic:${kind}:${key.toLowerCase()}`, name, kind, scopes });
    for (const st of s.processing) for (const u of st.robotUids ?? []) add(u, `${st.name} 로봇 ${u}`, 'robot', ['task:execute', 'telemetry:publish']);
    for (const u of s.sinkRobotUids ?? []) add(u, `적재 로봇 ${u}`, 'robot', ['task:execute', 'telemetry:publish']);
    for (const m of [...s.movers, ...s.drones]) if (m.uid) add(m.uid, m.id, m.kind === 'drone' ? 'drone' : 'mobile', ['move', 'task:execute', 'telemetry:publish']);
    add('ORCH', '공장 오케스트레이터', 'agent', ['command:control', 'command:emergency', 'task:assign']);
    add('AGENT', '자율 에이전트', 'agent', ['command:control', 'task:assign']);
    add('OPERATOR', '운영자(관제)', 'human', ['command:control', 'command:emergency']);
    add('AIOS', 'AIOS 공장 운영 AI', 'agent', ['policy:deploy']);
    add('VLA', 'VLA 학습 서버', 'agent', ['model:train', 'model:deploy', 'data:read']);
  }
  get identities() { return this.ids.size; }
  issuerOf(by) { return /관제|비상정지 버튼|운영자|대화/.test(by ?? '') ? this.ids.get('OPERATOR') : this.ids.get('ORCH'); }
  note(layer, kind, text) {
    this.log.push({ id: ++this.seq, t: this.sim.time, layer, kind, text }); if (this.log.length > 120) this.log.shift();
    if (kind === 'block') { this.byLayer[layer]++; this.stats.blocked++; }
  }
  // 상위 명령: ① 발신 주체 DID 서명 · VC 권한 검증 → ④ OT 엔드포인트 OTAC 인증 · 구간 암호화 · DPI(쓰기 명령은 추가 인증)
  onCommand(c, C, cells) {
    if (!this.on) return true;
    this.register();
    const who = this.issuerOf(c.by), need = C.group === 'emergency' ? 'command:emergency' : 'command:control';
    if (!who?.scopes.includes(need)) { this.stats.cmdBlocked++; this.note('agent', 'block', `명령 #${c.id} 거부 — ${who?.name ?? '미등록 주체'}에 ${need} 권한 없음`); return false; }
    this.stats.cmdVerified++; this.stats.otac += cells; this.stats.dpiWrite++; this.stats.encMsgs += cells;
    this.note('agent', 'pass', `명령 #${c.id} ${who.name} DID 서명 · VC(${need}) 확인`);
    this.note('ot', 'pass', `명령 #${c.id} → 셀 ${cells}곳 OTAC 인증 · 구간 암호화 · DPI 쓰기 명령 추가 인증 통과`);
    return true;
  }
  get latency() { return { plain: PLAIN_MS, enc: PLAIN_MS + ENC_MS, rise: ENC_MS / PLAIN_MS }; }
  // VLA 학습: ② 셀(도메인)마다 eVDI에서 로컬 학습 → 가중치 동형암호화 → 연합 집계 (원본·노하우는 도메인 밖으로 나가지 않음)
  onVlaTrain(job) {
    if (!this.on) return;
    const doms = this.sim.processing.filter((st) => st.vlaCell).length, params = 10000;
    job.he = { domains: doms, ms: Math.round(HE_MS_PER_10K * (params / 10000)) };
    this.stats.heRounds++;
    this.note('data', 'pass', `VLA ${job.label} 연합학습 — 도메인 ${doms}개 eVDI 로컬 학습 · 동형암호 가중치 집계 ${job.he.ms}ms/1만 파라미터`);
  }
  // VLA 평가: ③ 메타모픽 관계 5종(조명·시점·객체 위치·부분 가림·센서 지연) × 차등 테스팅(현재 모델 대비) → Safety Score · DRS
  onVlaEval(job, passed) {
    if (!this.on) return;
    const mr = ['조명 변화', '시점 변화', '객체 위치 변화', '부분 가림', '센서 지연'], cases = mr.length * 40;
    const safety = Math.round(Math.min(99, job.val - 1.5) * 10) / 10, drs = Math.round((1 - Math.abs(job.val - job.prevVal) / 100) * 1000) / 1000;
    job.safety = { mr, cases, safety, drs };
    this.stats.mrTests += cases;
    this.scores.unshift({ t: this.sim.time, label: job.label, safety, drs, val: job.val, passed }); if (this.scores.length > 10) this.scores.pop();
    this.note('model', passed ? 'pass' : 'info', `VLA ${job.label} 메타모픽 ${mr.length}종 · ${cases}건 · 차등 테스팅 → Safety Score ${safety} · DRS ${drs}${passed ? '' : ' (평가 미달 — 배포 안 함)'}`);
  }
  // VLA 배포: ② ZKML 무결성 증명 검증 — 서명된 모델만 OTA
  onVlaDeploy(job, phase, n) {
    if (!this.on) return;
    this.stats.zkml += n;
    this.note('data', 'pass', `VLA ${job.label} ${phase === 'canary' ? '카나리' : '전체 OTA'} — ZKML 무결성 증명 검증 · 모델 서명 확인 ${n}대`);
  }
  // 데이터 반출: ② eVDI 반출 검사(DLP 민감정보 · 입력조작) → DID 서명 반출
  onExport(kind, name, bytes) {
    if (!this.on) return true;
    this.stats.exports++;
    this.note('data', 'pass', `${kind} 반출 — eVDI DLP 검사 통과 · DID 서명 반출 (${name}${bytes ? `, ${(bytes / 1024).toFixed(0)}KB` : ''})`);
    return true;
  }
  // 위협 주입 (시연) — 해당 계층이 막고 오케스트레이터에 보안 인시던트로 보고
  inject(type) {
    if (!this.on) return null;
    this.register();
    const s = this.sim, o = s.orch, T = SEC_THREATS[type]; if (!T) return null;
    const cells = s.processing.filter((st) => !st.standby), st = cells[Math.floor(s.rand() * cells.length)];
    const robot = [...this.ids.values()].find((x) => x.kind === 'robot');
    const text = {
      spoof: [`미등록 주체 → ${st.name} 속도 150% 명령`, `${st.name} OT 엔드포인트: OTAC 동적 토큰 불일치 · DID 서명 없음`, '명령 폐기 · 발신 세션 격리 · TrustCore 차단 목록 등록', 'ot'],
      privesc: [`${robot?.name ?? '로봇 에이전트'} → 비상정지 해제 요청`, `ONE Access: VC 권한 [${robot?.scopes.join(', ')}]에 command:emergency 없음`, '요청 거부 · 위임 VC 재발급 없이 차단 유지', 'agent'],
      tamper: [`VLA 에피소드 실행 로그 위변조 (${st.name})`, 'ZKML 증명 검증 실패 — 실행 로그 해시 불일치', '해당 에피소드 학습 제외 · 도메인 eVDI 격리 볼륨으로 이동', 'data'],
      exfil: ['제조 레시피(명령 노하우) eVDI 밖 반출 시도', 'eVDI DLP: 민감정보(공정 파라미터·노하우) 탐지 · DID 서명 없음', '반출 차단 · 세션 행위 로그 보존 · 탐지 룰 재배포', 'data'],
    }[type];
    this.stats.threats++;
    if (type === 'spoof' || type === 'privesc') this.stats.cmdBlocked++;
    if (type === 'tamper') this.stats.zkmlFail++;
    if (type === 'exfil') this.stats.exportBlocked++;
    this.note(text[3], 'block', `${T.icon} ${T.label} 차단 — ${text[1]}`);
    const inc = o.open('security', `sec:${this.seq}`, `${T.icon} ${T.label} — ${text[0]}`, SEC_LAYERS[text[3]].label, { prio: 2 });
    o.step(inc, 'field', 'detect', `${SEC_LAYERS[text[3]].icon} ${text[1]}`);
    o.step(inc, 'cell', 'self', `즉시 차단 (${SEC_LAYERS[text[3]].label})`);
    o.step(inc, 'orch', 'report', `보안 인시던트 보고: ${text[0]}`);
    o.later(2, () => { o.step(inc, 'orch', 'decide', `조치: ${text[2]}`); o.later(2, () => o.close(inc, `${T.label} 차단 확인 · 공정 영향 없음`)); });
    s.log('alert', `${T.icon} 보안 위협 차단 · ${T.label}`, { obs: text[1], act: text[2] });
    return inc;
  }
  summary() {
    const L = this.latency;
    return { ids: this.identities, verified: this.stats.cmdVerified, blocked: this.stats.blocked, threats: this.stats.threats, rise: L.rise };
  }
}
