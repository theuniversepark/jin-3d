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
// 보안 인시던트 처리 흐름 — 레인(누가) · 단계(무엇을) · 담당 주체/에이전트 · 발생 후 시각(초)
export const SEC_LANES = [
  { key: 'src', label: '위협 출처', sub: '공격·오작동 주체' },
  { key: 'detect', label: '탐지 모듈', sub: 'OT 엔드포인트 · ONE Access · ZKML · eVDI' },
  { key: 'ai', label: '보안 분석 AI', sub: 'Internal AI 분석 시스템' },
  { key: 'orch', label: 'FACOS 오케스트레이터', sub: '보안 인시던트 판단·지시' },
  { key: 'resp', label: '대응 실행', sub: 'TrustCore · eVDI · 명령 센터 · 모델 검증' },
];
export const SEC_STAGES = [
  { key: 'occur', label: '발생' }, { key: 'detect', label: '탐지' }, { key: 'block', label: '차단·격리' }, { key: 'analyze', label: '분석·분류' },
  { key: 'decide', label: '판단·보고' }, { key: 'respond', label: '대응' }, { key: 'verify', label: '복구 확인' }, { key: 'feedback', label: '룰 환류' }, { key: 'close', label: '종결' },
];
// 담당 주체·에이전트 (흐름 상자에 표시)
export const SEC_ACTORS = {
  otac: { name: 'OT 엔드포인트 보안 장비', org: '센스톤 · OTAC 단방향 동적 인증' },
  dpi: { name: 'DPI 명령 선별 제어', org: '센스톤 · 아이티스테이션' },
  oneaccess: { name: 'ONE Access', org: '라온시큐어 · DID/VC 권한 검증' },
  trustcore: { name: 'TrustCore', org: '라온시큐어 · 신원·자격 저장소' },
  zkml: { name: 'ZKML 무결성 검증', org: '서강대' },
  he: { name: '동형암호 연합학습', org: '디사일로' },
  evdi: { name: 'eVDI 보안 워크스페이스', org: '틸론 · 반출 통제(DLP)' },
  intai: { name: 'Internal AI 분석 시스템', org: '틸론 · 보안 분석 에이전트' },
  mr: { name: 'AI 모델 안전성 검증', org: '전북대 · 메타모픽·차등 테스팅' },
  orch: { name: '공장 오케스트레이터', org: 'FACOS' },
  cmd: { name: '명령 센터', org: 'FACOS' },
};
const A = (k) => SEC_ACTORS[k].name;
export const SEC_FLOW = {
  spoof: ({ st }) => ({ title: `미등록 주체 → ${st.name} 속도 150% 명령`, block: `${st.name} OT 엔드포인트 OTAC 인증 실패 · DID 서명 없음`, act: '패킷 폐기 · 발신 세션 격리 · 차단 목록 등록 · 탐지 룰 재배포', steps: [
    { dt: 0, lane: 'src', stage: 'occur', actor: '미등록 외부 단말', a: null, text: `${st.name}에 속도 150% 제어 명령 송신` },
    { dt: 0.3, lane: 'detect', stage: 'detect', actor: A('otac'), a: 'otac', text: 'OTAC 동적 토큰 불일치 · DID 서명 없음 → 인증 실패' },
    { dt: 0.6, lane: 'detect', stage: 'block', actor: A('dpi'), a: 'dpi', text: '쓰기(제어) 명령 식별 · 추가 인증 없음 → 패킷 폐기' },
    { dt: 2, lane: 'ai', stage: 'analyze', actor: A('intai'), a: 'intai', text: '발신 세션·명령 패턴 분석 → 제어 명령 위조, 위험 높음' },
    { dt: 3.5, lane: 'orch', stage: 'decide', actor: A('orch'), a: 'orch', text: `보안 인시던트 P2 · ${st.name} 명령 채널 감시 강화 지시` },
    { dt: 5, lane: 'resp', stage: 'respond', actor: A('trustcore'), a: 'trustcore', text: '발신 세션 격리 · 차단 목록 등록' },
    { dt: 6.5, lane: 'resp', stage: 'verify', actor: A('cmd'), a: 'cmd', text: `${st.name} 상태 확인 — 위조 명령 미실행, 정상 운전 유지` },
    { dt: 8, lane: 'ai', stage: 'feedback', actor: A('intai'), a: 'intai', text: '위조 명령 탐지 룰 갱신 → OT 엔드포인트 재배포' },
    { dt: 9.5, lane: 'orch', stage: 'close', actor: A('orch'), a: 'orch', text: '종결 — 차단 확인, 공정 영향 없음' },
  ] }),
  privesc: ({ robot }) => ({ title: `${robot?.name ?? '로봇 에이전트'} → 비상정지 해제 요청`, block: `ONE Access: VC 권한 [${robot?.scopes.join(', ')}]에 command:emergency 없음`, act: '요청 거부 · 위임 VC 일시 정지 · 모델 재검사', steps: [
    { dt: 0, lane: 'src', stage: 'occur', actor: `${robot?.name ?? '로봇 에이전트'}`, a: null, text: '권한 밖 명령: 비상정지 해제 요청 (오작동·탈취 의심)' },
    { dt: 0.3, lane: 'detect', stage: 'detect', actor: A('oneaccess'), a: 'oneaccess', text: `DID 확인 · VC 권한에 command:emergency 없음` },
    { dt: 0.6, lane: 'detect', stage: 'block', actor: A('oneaccess'), a: 'oneaccess', text: '최소 권한 위반 → 요청 거부 (명령 센터로 전달 안 함)' },
    { dt: 2, lane: 'ai', stage: 'analyze', actor: A('intai'), a: 'intai', text: '에이전트 행동 이력 분석 → 비정상 권한 상승 시도' },
    { dt: 3.5, lane: 'orch', stage: 'decide', actor: A('orch'), a: 'orch', text: '보안 인시던트 P2 · 해당 에이전트 위임 VC 재검증 지시' },
    { dt: 5, lane: 'resp', stage: 'respond', actor: A('trustcore'), a: 'trustcore', text: '위임 VC 일시 정지 — 재발급 전 명령 요청 차단' },
    { dt: 6.5, lane: 'resp', stage: 'verify', actor: A('mr'), a: 'mr', text: '해당 로봇 VLA 정책 메타모픽 재검사 → 이상 없음' },
    { dt: 8, lane: 'ai', stage: 'feedback', actor: A('intai'), a: 'intai', text: '권한 상승 시도 탐지 룰 추가' },
    { dt: 9.5, lane: 'orch', stage: 'close', actor: A('orch'), a: 'orch', text: '종결 — 비상정지 유지 상태 변화 없음, 위임 VC 재발급 대기' },
  ] }),
  tamper: ({ st }) => ({ title: `VLA 에피소드 실행 로그 위변조 (${st.name})`, block: 'ZKML 증명 검증 실패 — 실행 로그 해시 불일치', act: '오염 에피소드 격리 · 연합학습 집계 제외 · 배포 모델 재검사', steps: [
    { dt: 0, lane: 'src', stage: 'occur', actor: `${st.name} 도메인 데이터`, a: null, text: '오염된 실행 로그가 학습 데이터로 반입' },
    { dt: 0.3, lane: 'detect', stage: 'detect', actor: A('zkml'), a: 'zkml', text: '영지식 증명 검증 실패 — 실행 로그 해시 불일치' },
    { dt: 0.6, lane: 'resp', stage: 'block', actor: A('evdi'), a: 'evdi', text: '해당 에피소드 격리 볼륨으로 이동 · 학습 제외' },
    { dt: 2, lane: 'ai', stage: 'analyze', actor: A('intai'), a: 'intai', text: '위변조 범위 분석 → 해당 도메인 최근 에피소드' },
    { dt: 3.5, lane: 'orch', stage: 'decide', actor: A('orch'), a: 'orch', text: '보안 인시던트 P2 · 오염 데이터 제외 재학습 지시' },
    { dt: 5, lane: 'resp', stage: 'respond', actor: A('he'), a: 'he', text: '오염 도메인 가중치를 연합 집계에서 제외' },
    { dt: 6.5, lane: 'resp', stage: 'verify', actor: A('mr'), a: 'mr', text: '배포 중인 모델 차등 테스팅 재검사 → 이상 없음' },
    { dt: 8, lane: 'ai', stage: 'feedback', actor: A('intai'), a: 'intai', text: '입력조작 탐지 룰 갱신 → 도메인 eVDI 재배포' },
    { dt: 9.5, lane: 'orch', stage: 'close', actor: A('orch'), a: 'orch', text: '종결 — 오염 데이터 격리, 모델 영향 없음' },
  ] }),
  exfil: () => ({ title: '제조 레시피(명령 노하우) eVDI 밖 반출 시도', block: 'eVDI DLP: 민감정보(공정 파라미터·노하우) 탐지 · DID 서명 없음', act: '반출 차단 · 세션 권한 정지 · 감사 증적 보존 · 룰 재배포', steps: [
    { dt: 0, lane: 'src', stage: 'occur', actor: 'eVDI 사용자 세션', a: null, text: '공정 파라미터·명령 노하우 파일 외부 반출 시도' },
    { dt: 0.3, lane: 'detect', stage: 'detect', actor: A('evdi'), a: 'evdi', text: 'DLP 민감정보 탐지 · DID 서명 없음' },
    { dt: 0.6, lane: 'resp', stage: 'block', actor: A('evdi'), a: 'evdi', text: '반출 차단 · 커널 반출 채널(USB·캡처) 차단' },
    { dt: 2, lane: 'ai', stage: 'analyze', actor: A('intai'), a: 'intai', text: '세션 행위 분석 → 내부 유출 시도 판정' },
    { dt: 3.5, lane: 'orch', stage: 'decide', actor: A('orch'), a: 'orch', text: '보안 인시던트 P2 · 세션 권한 정지 지시' },
    { dt: 5, lane: 'resp', stage: 'respond', actor: A('oneaccess'), a: 'oneaccess', text: '사용자 세션 권한 정지 — 관리자 승인 후 해제' },
    { dt: 6.5, lane: 'resp', stage: 'verify', actor: A('trustcore'), a: 'trustcore', text: '감사 증적 DID 서명 보존 · 반출 데이터 0건 확인' },
    { dt: 8, lane: 'ai', stage: 'feedback', actor: A('intai'), a: 'intai', text: '반출 탐지 룰 재배포 (능동형 방어 루프)' },
    { dt: 9.5, lane: 'orch', stage: 'close', actor: A('orch'), a: 'orch', text: '종결 — 유출 없음' },
  ] }),
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
    this.flows = []; this.flowSeq = 0;   // 보안 인시던트 처리 흐름 (최근 12건)
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
  // 위협 주입 (시연) — 보안 인시던트 처리 흐름(SEC_FLOW)을 단계마다 시각에 맞춰 진행하고, 오케스트레이터 인시던트(P2)에도 같은 흐름을 남긴다
  inject(type) {
    if (!this.on) return null;
    this.register();
    const s = this.sim, o = s.orch, T = SEC_THREATS[type]; if (!T) return null;
    const cells = s.processing.filter((st) => !st.standby), st = cells[Math.floor(s.rand() * cells.length)];
    const robot = [...this.ids.values()].find((x) => x.kind === 'robot');
    const script = SEC_FLOW[type]({ st, robot });
    this.stats.threats++;
    if (type === 'spoof' || type === 'privesc') this.stats.cmdBlocked++;
    if (type === 'tamper') this.stats.zkmlFail++;
    if (type === 'exfil') this.stats.exportBlocked++;
    const f = { id: ++this.flowSeq, type, title: script.title, layer: T.layer, t0: s.time, steps: [], status: 'open', tEnd: null };
    this.flows.unshift(f); if (this.flows.length > 12) this.flows.pop();
    this.note(T.layer, 'block', `${T.icon} ${T.label} 차단 — ${script.block}`);
    const inc = o.open('security', `sec:${f.id}`, `${T.icon} ${T.label} — ${script.title}`, SEC_LAYERS[T.layer].label, { prio: 2 });
    f.incId = inc.id;
    // 보안 흐름 레인 → 오케스트레이터 인시던트 레인 (현장 감지 · 셀 컨트롤러 · 오케스트레이터 · 실행 자원)
    const OL = { src: 'field', detect: 'field', ai: 'cell', orch: 'orch', resp: 'exec' }, OK = { occur: 'detect', detect: 'detect', block: 'self', analyze: 'report', decide: 'decide', respond: 'act', verify: 'act', feedback: 'notify' };
    script.steps.forEach((x) => o.later(x.dt, () => {
      f.steps.push({ ...x, t: s.time });
      if (x.stage === 'close') { f.status = 'resolved'; f.tEnd = s.time; o.close(inc, `${x.actor}: ${x.text}`); return; }
      o.step(inc, OL[x.lane], OK[x.stage], `${x.actor} — ${x.text}`);
    }));
    s.log('alert', `${T.icon} 보안 위협 차단 · ${T.label}`, { obs: script.block, act: script.act });
    return inc;
  }
  summary() {
    const L = this.latency;
    return { ids: this.identities, verified: this.stats.cmdVerified, blocked: this.stats.blocked, threats: this.stats.threats, rise: L.rise };
  }
}
