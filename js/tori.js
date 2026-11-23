// 토리(Tori) — 모두의 AI 팩토리 공장장 아바타 (피지컬AI 실증 메타팩토리 안내). 화면 오른쪽 아래에 서서(그림 애니메이션), 처음 접속하면 인사하고
// 주제별로 안내한다: 메타팩토리 둘러보기(단계 · Zone 카메라 이동 · 주요 버튼 강조) · 인시던트 해결 예시(실제로 현장 이벤트를 일으켜 진행 상황을 읽어 줌)
//   · 데이터 폐루프 · 데이터 플라이휠(고리 그림에 지금 단계 표시) · 매뉴얼·앱 내려받기
// 접으면 작은 얼굴만 남고, 누르면 주제 메뉴.
// 자동 넘김: 말이 끝난 뒤(음성이 없거나 낼 수 없으면 읽는 시간 뒤) 1초 동안 「다음」을 누르지 않으면 다음 단계로 (첫 인사도 둘러보기 시작) — 주제 마지막 단계는 이어진 다음 주제로(메뉴 순서), 활용 및 기대 맺음말이 끝나면 5초 뒤 메타팩토리 둘러보기부터 다시(끝없이 되풀이 · 「마치기」를 누르면 멈춤), 메뉴는 기다림,
//   실제로 일어나기를 기다리는 단계(인시던트 감지 · 출동 · 처리)는 ready()가 참이 된 뒤에만 — 「다음」 단추도 같은 검사 (준비 전이면 기다린다고 알림). 90초가 지나도 일어나지 않으면 「완료」로 넘기지 않고 시간 초과를 알린 뒤 다음 주제로 (「다시 기다리기」로 더 기다림)
// 공장과 맞추기: 공장이 새로 시작되면(main.js start() → simChanged — 단계 · 라인 · 리셋) 옛 공장의 이벤트 · 제안 · 망 상태를 버리고 안내를 멈추거나 새 공장에서 다시 구성한다. 예약된 창 · 멈춤 · 추적 콜백은 세대(gen)가 지나면 무효
//   「이전」으로 돌아온 단계도 순방향과 같은 창 · 카메라 · 상위망 상태로 맞춘다 (이벤트를 만드는 동작만 다시 하지 않는다)
// 그리기: 토리 전용 캔버스를 WebGPU(three/webgpu WebGPURenderer)로 — 메인 3D 화면(WebGL)과 따로라 공장 화면 속도와 무관
//   WebGPU를 쓸 수 없는 브라우저 · 공유 아티팩트에서는 같은 장면을 WebGL로 그린다 (모양 · 동작 같음)
// 말: 말풍선 글자와 녹음한 남성 음성을 함께 (녹음 없는 문장은 남성 OS 음성이 있을 때만 speechSynthesis로) · 🔊로 음성만 끌 수 있음
// 언어: 기본 한국어 · 머리의 EN 버튼으로 영어 안내(js/tori-en.js — 말풍선 · 녹음 · 단추 · 그림 글자) · 고른 언어는 기억
//   브라우저는 사용자가 화면을 누르기 전에는 소리를 막으므로, 그 전에 나온 말은 첫 클릭 때 읽는다 (앱은 처음부터 — electron/main.mjs autoplayPolicy)
// jin-3d(정밀조립Zone 하나): 상위 meta-factory 대본에서 유연생산 · 적응가공 · 정밀검사 Zone 단계는 뺐고, 샘플 검사는 검사·포장셀 최종 검사대의 출하 전 샘플 재검(js/serial.js)으로,
//   카메라 좌표는 이 건물 배치(입고 도크 왼쪽 벽 · 출하 도크 뒷벽 오른쪽)로 바꿨다. 문장을 고친 단계는 녹음이 없어 OS 음성으로 읽는다
// 안내 내용은 앱의 실제 구성에서 가져왔다: 센서망 계층(js/sensors.js) · VLA 학습·배포(js/vla.js) · AIOS(js/aios.js) · 데이터 연동(js/datahub.js)
import * as THREE from 'three';
import { PRODUCTS, SAMPLE_N } from './serial.js';
import { LEVERS } from './impact.js';
import { EN, EN_UI, EN_CHAINS, EN_RINGS } from './tori-en.js';

const SEEN = 'jin3d.tori.seen', VOICE = 'jin3d.tori.voice', LANG = 'jin3d.tori.lang';
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 사생활 보호 모드 등 */ } } };

// 흐름 막대: 제품 ID 추적 7단계 (아래 작은 글씨 = 그 단계에서 붙는 ID)
const CHAIN = [['오더', ''], ['자재', '원자재 로트'], ['투입', '생산 ID'], ['공정', '셀별 이력'], ['판정', '제품 ID'], ['출하', '팔레트 SSCC'], ['이후', '조회 · 리콜']];
const FCHAIN = [['공장', 'FacOS'], ['게이트', 'A2A'], ['Zone', '오케스트레이터'], ['셀', 'OCS'], ['엣지', '스킬'], ['UNS', 'ISA-95'], ['기록', 'FAC']];   // FacOS 계층 + 정보 바탕(UNS)
const KCHAIN = [['손실', '원인 11종'], ['제안', '운영값'], ['트윈', '30분×3'], ['결정', '적용·보류'], ['실측', '10분'], ['학습', '이력']];   // KPI 개선 6단계
const LCHAIN = [['현장', '셀 엣지'], ['AAS', '시계열'], ['OPC UA', 'PubSub'], ['TSN', '유선'], ['이음5G', '이동 로봇'], ['UNS', 'MQTT 5'], ['FacOS', '구독·판단'], ['명령', 'cmd 4단']];   // 데이터 & 제어명령 파이프라인 6단계
const OCHAIN = [['활용', '실증 · 데이터 · 교육'], ['기대', '생산 · 안전 · 확산'], ['맺음말', '']];   // 활용 및 기대
const QCHAIN = [['예방', '건강·보정'], ['전수', '토크·각도'], ['샘플', '출하 전 재검'], ['대응', '봉쇄·경보'], ['원인', 'AI 분석'], ['개선', '8D·정책'], ['감시', '관리도']];   // 품질 관리 7단계
const textW = (t) => [...t].reduce((a, c) => a + (/[가-힣]/.test(c) ? 11.5 : 6.4), 0);   // 글자 폭 (한글 · 영문)
function chainSvg(at, C = CHAIN) {
  const W = 336, H = 70, n = C.length, gap = W / n;
  const nodes = C.map(([l, sub], k) => { const x = gap * k + gap / 2, on = at < 0 || k <= at, cur = k === at, w = Math.min(gap - 4, Math.max(38, textW(l) + 12));
    return `<g class="tr-n${on ? ' on' : ''}${cur ? ' cur' : ''}"><rect x="${x - w / 2}" y="10" width="${w}" height="22" rx="11"/><text x="${x}" y="25" text-anchor="middle">${l}</text>${sub ? `<text x="${x}" y="${k % 2 ? 62 : 48}" text-anchor="middle" class="tr-sub">${sub}</text>` : ''}</g>`; }).join('');
  const arrows = C.slice(1).map((_, k) => { const x1 = gap * k + gap / 2 + 20, x2 = gap * (k + 1) + gap / 2 - 22, on = at < 0 || k < at;
    return `<path d="M${x1} 21 L${x2} 21" class="tr-a${on ? ' on' : ''}" marker-end="url(#tc-h${on ? '1' : '0'})"/>`; }).join('');
  return `<svg class="tori-ring" viewBox="0 0 ${W} ${H}" role="img" aria-label="${C.map((c) => c[0]).join(' → ')}"><defs>${[0, 1].map((o) => `<marker id="tc-h${o}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="tr-h${o ? ' on' : ''}"/></marker>`).join('')}</defs>${arrows}${nodes}</svg>`;
}
// 실제 제품 예시 (시뮬레이션의 시리얼 서비스 · 제품 추적에서 읽음)
const prodKo = (p) => PRODUCTS[p]?.label ?? p;
// FacOS 주제: 공장 오케스트레이터 상태 (js/factoryos.js)
const fos = (T) => T.h.sim?.()?.fos ?? null;
const fosOrder = (F) => { const o = F?.orders.find((x) => x.status === 'open' && x.evidenced !== true) ?? F?.orders[0]; return o ? { o, good: F.main.reconcile(o.id)?.good ?? 0 } : null; };
const DEC_KO = { 'kpi-lever': 'KPI 개선안', 'kpi-revert': '개선안 되돌림', 'aios-policy': 'AIOS 배포', 'aios-rollback': 'AIOS 롤백', mix: '혼류 비율', interval: '투입 간격', expedite: '긴급 조달', policy: '정책 승인', 'due-risk': '납기 위험', timeout: '응답 시간 초과' };
// KPI 영향 · 개선 주제: 손실 분석 · 개선 제안 · 트윈 검증 · 결정 (js/impact.js)
const adv = (T) => T.h.sim?.()?.impact?.advisor ?? null;
const lossTop = (T) => T.h.sim?.()?.impact?.report(1800)?.rows?.[0] ?? null;
const pickProp = (T) => { const A = adv(T); if (!A) return null; const L = A.items.filter((p) => p.lever); return L.find((p) => p.status === 'verified' && p.twin?.recommend === 'apply') ?? L.find((p) => p.status === 'verified') ?? L.find((p) => p.status === 'verifying' || p.status === 'new') ?? null; };
const levV = (p, v) => { const L = LEVERS[p.lever]; return L ? `${Number.isInteger(v) ? v : (+v).toFixed(2)}${L.unit}` : `${v}`; };   // 운영값 + 단위
const REC_KO = { apply: '적용 권장', neutral: '효과 미미', hold: '보류 권장' };
const signed = (v, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
// 인시던트 예시: 그 인시던트 흐름도의 단계 · 시각 · 출동 로봇 도착
const RADIUS = { leak: 1.3, debris: 1.0, intrusion: 2.2, smoke: 1.8 };
const inc = (T, kind) => T.ev?.inc?.steps?.find((x) => x.kind === kind);
// 이 인시던트가 UNS에 남긴 토픽 (js/uns.js가 이미 발행한 것만) — part 'report': 보고 · 방송 A2A / 'cmd': 존의 명령 A2A + 셀 명령 4단 + 바뀐 셀 상태
//   오케스트레이터 창 UNS 탭이 다시 그릴 때마다 불러 강조한다 (main.js toriPanel → unsview.js unsFocus)
const UNS_CMD = { sent: 'cmd', ack: 'cmd/ack', exec: 'cmd/exec', done: 'cmd/done', rejected: 'cmd/done' };
const incUns = (T, s = T.h.sim?.(), part = 'report') => {
  const U = s?.uns, I = T.ev?.inc; if (!U || !I) return null;
  const a2a = (s.fos?.bus?.log ?? []).filter((m) => m.subject?.incident === I.id && m.seq <= U.a2aSeq && (part === 'cmd' ? m.type === 'command' : m.type === 'incident.report' || m.type === 'broadcast'))
    .map((m) => ({ topic: U.t('_facos', 'a2a', U.epSeg(m.from), U.epSeg(m.to)), m })).reverse();
  const cmds = part === 'cmd' ? (s.cmd?.list ?? []).filter((c) => c.inc === I).map((c) => {
    const base = c.target === 'all' ? U.t('main', '_zone') : U.t('main', U.cellUid(c.target));
    return { c, base, hs: c.history.slice(0, U.cmdSeen.get(c.id) ?? 0) };
  }) : [];
  const cells = cmds.filter((x) => x.c.target !== 'all').map((x) => U.t('main', U.cellUid(x.c.target), 'state')).filter((t) => U.tree.has(t));
  const ct = cmds.flatMap((x) => x.hs.map((h) => `${x.base}/${UNS_CMD[h.state] ?? 'cmd'}`));
  const topics = [...new Set([...a2a.map((x) => x.topic), ...ct, ...cells])];
  const short = (t) => t.slice(U.root.length + 1);
  return { a2a, cmds, cells, topics, short, sel: ct.at(-1) ?? a2a[0]?.topic ?? null,
    note: `인시던트 #${I.id} ${I.title} — ${part === 'cmd' ? '명령이 UNS에 남긴 토픽 (A2A 명령 · 셀 명령 4단 · 셀 상태)' : '보고가 UNS에 남긴 토픽 (A2A 보고)'}` };
};
// UNS 트리에서 조건에 맞는 토픽을 골라 강조 (최근 것 먼저) — 제품 ID 추적 · 파이프라인 안내가 씀
const unsSel = (s, f, note, prefer = null, max = 10) => {
  const U = s?.uns; if (!U) return null;
  const E = [...U.tree.values()].filter(f).sort((a, b) => (b.t ?? 0) - (a.t ?? 0)).slice(0, max);
  const pick = (prefer && E.find((e) => e.topic.endsWith(`/${prefer}`))) || E[0];
  return { E, topics: E.map((e) => e.topic), sel: pick?.topic ?? null, note, short: (t) => String(t ?? '').slice(U.root.length + 1) };
};
const qSample = (s, z = 'main') => { const U = s?.uns, e = U?.tree.get(U.t(z, '_zone', 'quality')); try { return e ? JSON.parse(e.payload) : null; } catch { return null; } };   // 최근 품질 표본 (앱 — 웹 버전은 없음)
const LINK_UNS = {
  tele: (s) => unsSel(s, (e) => e.kind === 'telemetry' && e.topic.includes('/main/'), '셀 설비 값이 ISA-95 공장 트리에 정리된 자리 ({존}/{셀}/telemetry)', null, 8),
  facos: (s) => unsSel(s, (e) => e.topic.includes('/_facos/') && ['state', 'order', 'decision'].includes(e.kind), 'FacOS가 판단 결과를 다시 UNS로 — 공장 상태 · 오더 · 결정', 'state', 8),
  cmd: (s) => unsSel(s, (e) => e.kind === 'cmd', '명령 4단 — cmd → cmd/ack → cmd/exec → cmd/done (같은 Correlation ID)', null, 8),
};
const A2A_KO = { 'incident.report': '인시던트 보고', broadcast: 'P1 방송', command: '명령' };
const at = (T, x) => `+${sec(x.t - T.ev.t0)}`;
const arrived = (T) => !!T.ev?.responder && !!T.ev.inc?.steps?.some((x) => x.kind === 'act' && x.text.startsWith(`${T.ev.responder} 현장 도착`));   // 따라가는 로봇이 도착했을 때만 (소화기 들고 「현장 대기」하는 휴머노이드는 아님)
const resp = (T) => (T.ev?.type === 'smoke' ? 'inspect' : T.ev?.type === 'intrusion' ? 'safety' : 'clean');   // 이벤트 종류별 대응 — 음성 문장 고르기
const took = (T) => { const d = T.ev.tDetect - (T.ev.tq ?? T.ev.t0); return d < 0.5 ? '곧바로' : `${sec(d)} 만에`; };   // 감지를 풀자마자 본 경우
const pickBot = (T) => { const ms = T.h.sim?.()?.movers ?? [], busy = (m) => m.task && !m.idle && !m.charging && !m.chgNow; return (ms.find((m) => m.kind === 'humanoid' && busy(m)) ?? ms.find(busy) ?? ms.find((m) => m.kind === 'humanoid') ?? ms[0])?.id ?? null; };   // 둘러보기 예시 로봇 — 일하며 움직이는 로봇 (휴머노이드 우선)
const byRobot = (T) => (T.h.moverPos?.(T.ev?.detectedBy) ? 'robot' : 'cctv');   // 로봇 카메라가 감지했는지, CCTV가 먼저 봤는지
// 현장 표지 · 빛기둥 색 (js/factory.js ALARM_COLOR · robotcam.js syncEvents): 경보(누유 · 연기 · 사람 진입) 빨강, 주의(이물질) 노랑 — 말과 화면 색을 맞춘다
const sevK = (T) => (T.ev?.severity === 'alarm' ? 'alarm' : 'warn');
const evColor = (T) => (sevK(T) === 'alarm' ? '빨간' : '노란');
const clearK = (T) => (resp(T) === 'clean' ? (sevK(T) === 'alarm' ? 'clean' : 'cleanWarn') : resp(T));   // 해결 문장: 청소 대응은 표지 색까지
// 사람 진입: 추적 사족보행과 진입자 사이 거리 · 둘을 한 화면에 담는 카메라 (가까우면 9m, 멀면 거리 + 8m까지 물러남)
const escortGap = (T) => { const ev = T.ev, q = ev?.escort?.q; return q && !ev.cleared ? Math.hypot(ev.x - q.x, ev.z - q.z) : null; };
const escortCam = (T) => { const ev = T.ev, q = ev?.escort?.q; if (!q || ev.cleared || resp(T) !== 'safety') return null; const g = Math.hypot(ev.x - q.x, ev.z - q.z); return { x: (ev.x + q.x) / 2, z: (ev.z + q.z) / 2, d: Math.min(34, Math.max(9, g + 8)) }; };
const clock = (t) => { const x = Math.floor(t) + 8 * 3600; return `${String(Math.floor(x / 3600) % 24).padStart(2, '0')}:${String(Math.floor(x / 60) % 60).padStart(2, '0')}`; };
const ex = {
  order: (s) => { const F = s?.fos; if (!F) return null; const o = F.orders.find((x) => x.status === 'open' && x.evidenced !== true) ?? F.orders[0]; return o ? { o, good: F.main?.reconcile?.(o.id)?.good ?? 0 } : null; },
  wip: (s, minSteps = 0) => s?.trace?.recent?.findLast((r) => r.status === 'wip' && !r.serial && r.steps.length >= minSteps) ?? null,
  serial: (s) => s?.serials?.units?.findLast((u) => u.serial && u.zone === 'main') ?? s?.serials?.units?.findLast((u) => u.serial) ?? null,
  pallet: (s) => s?.serials?.pallets?.[0] ?? null,
  shipped: (s) => s?.serials?.units?.findLast((u) => u.loc === 'shipped' && u.serial) ?? null,
};
const cellName = (s, id) => s?.processing?.find((st) => st.id === id)?.name ?? id;
// 품질 예시: 주입 뒤 생긴 불량 사례 · 그 사례의 8D · 최근 샘플 로트
const qx = {
  caseAfter: (s, t0) => (t0 == null ? null : s?.trace?.cases?.find((c) => c.kind === 'inline' && c.t >= t0) ?? null),
  capaOf: (s, c) => (c ? s?.capa?.list?.find((k) => k.cases?.includes(c.id)) ?? null : null),
  lot: (s) => (s?.serials?.lots ?? []).reduce((a, l) => (!a || l.t > a.t ? l : a), null),
  cells: (s) => (s?.processing ?? []).filter((st) => !st.standby && !['SRC', 'SINK'].includes(st.id)),
};
const LOT_KO = { hold: '출하 보류 · 판정 대기', released: '합격 · 보류 해제', contain: '불합격 · 봉쇄', sorting: '봉쇄 · 선별 검사 중', done: '선별 · 처분 완료' };

// 고리 그림: 데이터 폐루프 6단계 · 플라이휠 5단계 (마지막 → 처음으로 이어짐)
const RINGS = {
  loop: ['수집', '엣지', '서버·연동', 'AI 학습', '모니터링', '현장 제어'],
  fly: ['운영', '데이터', '학습', '배포', '성능 향상'],
};
// 주제별 단계: 말 · 카메라(Zone 시점) · 단계 전환 · 강조할 화면 요소 · 고리 그림(지금 단계)
const TOPICS = {
  tour: { name: '메타팩토리 둘러보기', steps: [
    { say: '안녕하세요! 저는 모두의 AI 팩토리 공장장 토리예요. 이곳은 피지컬AI 실증 메타팩토리로, 레거시 공장이 자동화를 거쳐 피지컬AI 자율공장으로 바뀌는 과정을 3D 디지털 트윈으로 보여 주는 시뮬레이터예요. 2분 정도 함께 둘러볼까요?', view: 'all', start: true },
    // 과제정의 (협업지능 피지컬AI 기술실증 테스트베드 플랫폼화 — 연구개발계획서 1p)
    { view: 'all', say: '이 메타팩토리는 협업지능 피지컬AI 기반 SW 플랫폼의 연구개발 성과를 실제 산업에 적용 · 확산하기 위한 개방형 기술실증 플랫폼이에요. 장비와 공간을 갖추는 데서 그치지 않고, R&D 성과 · 실증장비 · 제조공정 · 데이터 · 디지털트윈 · AI · 통합운영체계 · 기업실증 서비스를 하나의 구조로 연결해 반복해서 쓸 수 있는 실증 플랫폼으로 만드는 것이 이 과제예요.' },
    { say: '추진 목적은 한마디로, 피지컬AI 연구 성과가 실험실에 머물지 않고 이 메타팩토리에서 기술검증 → 실증 → 현장적용 → 확산까지 이어지게 하는 거예요. 데이터 · AI · 디지털트윈 · 로봇을 하나로 운영하며 안전성 · 신뢰성 · 실시간성을 검증하고, 여기서 쌓인 데이터는 다시 연구와 기업 현장으로 돌아가요. 이제 공장 안의 Zone을 둘러볼게요.' },
    { say: '가운데가 정밀조립Zone이에요. 도어트림과 e-axle을 혼류 생산하고, 부품분류 → 조립 → 체결 → 검사·포장 6개 셀이 이어져 있어요.', view: 'precision' },
    { say: '화면 위 단계 버튼으로 레거시 → 자동화 → 피지컬AI를 바꿀 수 있어요. 같은 라인을 세 단계로 운영해서 생산량 · OEE · 재공(공정 안에 머문 미완성품, WIP)이 어떻게 달라지는지 비교해요.', hl: ['#modeSeg'],
      voice: '화면 위 단계 버튼으로 레거시, 자동화, 피지컬AI를 바꿀 수 있어요. 같은 라인을 세 단계로 운영해서 생산량과 OEE, 그리고 재공, 즉 공정 안에 머물러 있는 미완성품이 어떻게 달라지는지 비교해요.' },
    { say: '지금은 피지컬AI 단계예요. 이 단계에서는 휴머노이드 · AMMR · 사족보행 로봇과 드론이 현장을 맡고, 로봇 카메라 영상을 보고 동작을 정하는 VLA 모델이 일해요.', mode: 'dark', hl: ['#modeSeg'] },
    { say: '오른쪽 패널은 공장 운영 AI예요. 고장 · 공급 차질 · 현장 이벤트를 관찰 → 판단 → 실행한 기록이 남아요. 아래 입력창에 "포장셀 속도 80%"처럼 지시할 수도 있어요.', hl: ['#agentPanel'] },
    { say: '위쪽 버튼에서는 로봇 데이터로 VLA 학습, 운영 AI 학습, KPI 영향 분석, 품질 추적, Zone 대시보드를 볼 수 있어요.', hl: ['#btnVla', '#btnAios', '#btnImpact', '#btnTrace', '#btnZoneDash'] },
    { say: '아래 버튼으로 설비 고장이나 현장 이벤트를 일부러 일으켜 보세요. 에이전트가 어떻게 대응하는지 볼 수 있어요. CCTV · 5G · 센서 배치도 여기서 봐요.', hl: ['#btnFault', '#btnEvent', '#btnCctv'] },
    // 예시로 로봇 하나를 눌러 상세 정보 창(실시간 작업 · 위치 · 배터리 · 5G · 카메라 · 관절)을 보여 준다 — 일하는 휴머노이드 우선, 화면은 그 로봇을 따라간다
    { act: (T) => { T.bot ??= pickBot(T); }, follow: (T) => T.bot, panel: (T) => T.bot && { kind: 'robot', id: T.bot }, live: true,
      voice: '설비나 로봇을 누르면 상세 정보 창이 열려요. 예시로 로봇 하나를 눌러 볼게요. 창에는 지금 하는 작업, 위치와 방향, 5G 신호와 핸드오버, 로봇 카메라의 실시간 영상, 배터리와 충전 상태가 보이고, 팔이 있는 로봇은 관절마다 각도와 속도, 토크와 온도도 실시간으로 바뀌어 보여요. 공장 설비를 누르면 상태와 건강도, 고장 위험과 처리 수량을 볼 수 있어요.',
      say: (T) => `설비나 로봇을 누르면 상세 정보 창이 열려요. 예시로 로봇 하나(${T.bot ?? '—'})를 눌러 볼게요. 창에는 지금 하는 작업 · 위치 · 방위 · 5G 서빙 셀 · 신호 세기 · 핸드오버, 로봇 카메라 실시간 영상, 배터리 · 충전 상태가 보이고, 팔이 있는 로봇은 관절마다 각도 · 속도 · 토크 · 온도도 실시간으로 바뀌어 보여요${(() => { const m = T.h.sim?.()?.movers?.find((x) => x.id === T.bot); return m ? ` (지금: ${m.task ?? '대기'}${m.battery != null ? ` · 배터리 ${Math.round(m.battery)}%` : ''})` : ''; })()}. 공장 설비를 누르면 상태 · 건강도 · 고장 위험 · 처리 수량을 볼 수 있어요.` },
    { panel: null, say: '🏷 라벨 버튼을 누르면 설비 · 로봇 이름표가 보여요. 저를 누르면 FacOS 공장 운영 SW, 인시던트 해결 예시, 제품 ID 추적, 품질 관리, KPI 영향 · 개선, 데이터 폐루프와 플라이휠, 데이터 & 제어명령 파이프라인(AAS · OPC UA · TSN · 이음5G), 매뉴얼 · 앱 내려받기, 활용 및 기대도 안내해 드려요!', view: 'all', hl: ['#btnLabels'], end: true, next: 'facos' },
  ] },
  // FacOS — 공장 운영 SW: 계층(공장 → 게이트 → Zone → 셀 → 엣지 → UNS → 기록) · 오더 · 결정 요청 · A2A 가드레일 · 상위망 단절 · 셀 게이트 · 현장 감지 · 보안 · UNS(정보 바탕) · FAC
  //   가드레일 시험 · 상위망 단절 시험은 토리가 직접 실행 (운영에 영향 없음 · 단절은 다음 단계 · 주제를 벗어나면 복구)
  facos: { name: 'FacOS — 공장 운영 SW', steps: [
    { mode: 'dark', view: 'all', hl: ['#facos'], fchain: -1,
      voice: 'FacOS는 이 공장의 운영 소프트웨어예요. 원칙은 세 가지예요. 명령은 위에서 아래로, 상태는 아래에서 위로, 같은 계층끼리는 핸드셰이크와 알림만 주고받아요. 결정이 필요한 일은 공장으로 올려요. 그리고 모든 계층은 UNS라는 하나의 정보 공간 위에서 연결돼요.',
      say: 'FacOS(Factory OS)는 이 공장의 운영 SW예요. 원칙 세 가지 — 명령은 위 → 아래, 상태는 아래 → 위, 같은 계층끼리는 핸드셰이크 · 알림만. 결정이 필요한 일은 공장으로 올려요. 모든 계층은 UNS(통합 네임스페이스) 하나 위에서 연결돼요. 화면 위 FacOS 줄이 지금 상태예요.' },
    { panel: { kind: 'orch', tab: 'fos' }, hl: ['#btnOrch'], fchain: 2,
      voice: '계층을 볼게요. 맨 위 공장 오케스트레이터가 오더와 우선순위, Zone 간 자원을 정하고, Zone마다 오케스트레이터가 셀을 맡아요. 셀 OCS는 AI 운영 정책에 따라 명령을 판단하고 검증하며, 맨 아래 엣지 스킬이 실제 동작을 해요.',
      say: '계층 — 공장 오케스트레이터(오더 · 납기 · 우선순위 · Zone 간 자원) → Agent Gateway(A2A 가드레일) → Zone 오케스트레이터(정밀조립 = Manufacturing Agent) → 셀 OCS(AI 운영 정책에 따라 명령 판단 · 검증) → 엣지 스킬(VLA 피킹 · 압입 · 체결 판정 · 인터록). 에이전트는 제안하고, 오케스트레이터가 검증해 확정해요.' },
    { hl: ['#btnOrch'], fchain: 0, live: true,
      voice: '오더는 공장이 Zone에 내려보내고, Zone이 투입 순서로 수락해요. 양품 목표를 채우면 Zone이 수량 정산 증빙을 올리고, 정산 오차가 0일 때만 공장이 오더를 닫아요.',
      say: (T) => { const r = fosOrder(fos(T)); return `오더 — 공장이 Zone에 배정 → Zone이 수락(투입 순서) → 양품 목표를 채우면 Zone이 종료 증빙 → 공장이 확인해 종료.${r ? ` 지금 ${r.o.id}: 양품 ${r.good}/${r.o.target} · 납기 ${clock(r.o.due)}.` : ''} 투입 = 공정 + 합격대기 + HOLD + 인계 + 폐기, 이 수량 정산 오차가 0일 때만 닫혀요.`; } },
    { hl: ['#btnOrch'], fchain: 0, live: true,
      voice: 'Zone이 스스로 못 정하는 일은 결정 요청으로 공장에 올라와요. 납기 위험이면 납기를 늘리고, 운영값을 바꾸는 개선안은 승인을 받은 뒤에 적용하고, 정책 반영은 사람이 결정해요. 결정에는 대상과 권한자, 계획 버전, 제약, 재개 조건이 꼭 붙어요.',
      say: (T) => { const d = fos(T)?.decisions?.[0]; return `결정 요청 — Zone이 못 정하는 일은 공장으로: 납기 위험(납기 연장) · 운영값 변경(KPI 개선안 · AIOS 배포 · 혼류 비율 · 투입 간격 · 긴급 조달 — 승인 뒤 계획 버전 증가) · 정책 승인(사람이 결정). 결정에는 대상 · 권한자 · 계획 버전 · 제약 · 재개 조건이 꼭 붙어요.${d ? ` 최근 결정: ${clock(d.t)} ${DEC_KO[d.kind] ?? d.kind} → ${d.verdict} (${d.version}).` : ' 아직 결정 요청은 없어요.'}`; } },
    { act: (T) => { const F = fos(T); if (F && T.guard === undefined) T.guard = F.bus.send('factory', `cell:${[...F.ocs.keys()][0] ?? 'SORT'}`, 'command', { body: { code: 'SPEED', arg: 0.5 }, text: '시험(토리): 공장이 Zone을 건너뛰어 셀에 직접 속도 명령' }); },   // 계층 건너뛰기 — 게이트웨이가 차단 (운영에 영향 없음)
      panel: { kind: 'orch', tab: 'a2a' }, hl: ['#btnOrch'], fchain: 1,
      voice: '이번에는 가드레일을 시험해 볼게요. 공장 오케스트레이터가 Zone을 건너뛰어 셀에 직접 속도 명령을 보내 봤어요. 명령은 바로 아래 계층으로만 내려갈 수 있어서 게이트웨이가 막았어요. 모든 메시지는 번호를 달고 기록돼요.',
      say: (T) => T.guard ? `가드레일 시험 — 제가 공장 오케스트레이터에서 Zone을 건너뛰어 셀 OCS(${T.guard.to.slice(5)})로 속도 명령을 보내 봤어요. 결과: ${T.guard.status === 'blocked' ? `차단 (${T.guard.why})` : T.guard.status}, ${T.guard.msgId}. A2A 메시지 탭에 빨간 줄로 남았어요. 모든 메시지는 번호 · 보낸 곳 · 받는 곳 · 계획 버전과 함께 기록돼요.` : '지금은 FacOS가 없어요 (피지컬AI 단계에서).' },
    { net: 'off', hl: ['#btnOrch'], fchain: 1, live: true,   // 이 단계에 있는 동안만 상위망을 끊는다 — 앞 · 뒤 어느 쪽에서 들어와도 같게 (go → syncNet)
      ready: (T) => !fos(T) || fos(T).kpi().queued > 0 || performance.now() - (T.netT0 ?? 0) > 15000,
      voice: '이번엔 공장과 Zone 사이 상위망을 끊어 볼게요. 망이 끊겨도 Zone은 승인된 범위 안에서 계속 일하고, 공장으로 갈 메시지는 Outbox에 쌓아 둬요.',
      say: (T) => { const F = fos(T); return F ? `상위망 단절 시험 — 공장 ↔ Zone 망을 끊었어요. Zone은 승인된 범위 안에서 계속 일하고, 공장으로 갈 메시지는 Edge Outbox에 쌓여요: 지금 ${F.kpi().queued}건.` : ''; } },
    { hl: ['#btnOrch'], fchain: 1,   // 망 복구는 go → syncNet (단절 단계를 벗어나면 다시 잇고 전달된 건수를 T.flushed에)
      voice: '망을 복구했어요. 쌓여 있던 메시지가 순서대로 공장에 전달됐어요. 접수 확인만으로 재개하지 않고, 공장이 실제로 처리한 뒤에 다음으로 넘어가요.',
      say: (T) => `복구 — 망을 다시 연결하자 Outbox에 쌓인 ${T.flushed ?? 0}건이 순서대로 공장에 전달됐어요. 접수 확인(ACK)만으로 재개하지 않고, 공장이 실제로 처리한 결과로 넘어가요. 이 시험 기록도 A2A 메시지 탭에 남아요.` },
    { panel: { kind: 'facos', view: 'cell' }, cam: { view: 'precision' }, hl: ['#facos'], fchain: 3, live: true,
      voice: '셀 게이트예요. 정비, 보정, 현장 명령은 셀 OCS가 AI 운영 정책에 따라 지금 셀 상황과 인터록을 함께 보고 승인하거나 거부하고, 그 사유를 남겨요. 마지막 권한은 안전 PLC에 있어요.',
      say: (T) => { const K = fos(T)?.kpi(); return `셀 게이트 — 정비 · 보정 · 현장 명령은 셀 OCS가 AI 운영 정책에 따라 셀 상황과 인터록을 함께 보고 승인 · 거부하고 사유를 남겨요${K ? ` (지금까지 승인 ${K.ocsOk} · 거부 ${K.ocsRej})` : ''}. 셀이 스스로 복구는 1회까지, 안 되면 Zone으로 올려요. 최종 권한은 안전 PLC예요. 창에는 셀별 진행 결과와 분류 · 포장 게이트 판별이 보여요.`; } },
    { panel: { kind: 'facos', view: 'sense' }, hl: ['#facos'], fchain: 4,
      voice: '현장 감지예요. 로봇 카메라와 CCTV 영상을 엣지에서 AI가 추론해 누유, 이물질, 연기, 무단 진입을 찾고, 오케스트레이터에 보고해요. 처리가 끝난 기록도 여기 남아요.',
      say: '현장 감지 — 로봇 카메라 · CCTV 영상을 엣지에서 AI가 추론해 누유 · 이물질 · 연기 · 무단 진입을 찾아 오케스트레이터에 보고해요. 안전(P1) · 보안 · 출하품 영향은 모든 계층에 바로 알려요. 인시던트 해결 예시에서 이 흐름을 끝까지 볼 수 있어요.' },
    { when: (T) => !!T.h.sim?.()?.sec?.on, panel: { kind: 'facos', view: 'sec' }, hl: ['#facos'], fchain: 1,
      voice: '보안 계층이에요. 로봇과 에이전트마다 디지털 신원을 두고, 명령에는 서명과 권한 증명을 붙여 검증해요. 위조되거나 권한 밖의 명령은 차단해요.',
      say: '보안 — 로봇 · 에이전트마다 분산 신원(DID)을 두고, 명령에는 서명과 권한 증명(VC) · 일회용 인증(OTAC)을 붙여 검증해요. 위조되거나 권한 밖의 명령은 차단하고 보안 인시던트(P2)로 올려요.' },
    { panel: { kind: 'orch', tab: 'uns' }, hl: ['#btnOrch'], fchain: 5, live: true,
      voice: 'FacOS가 정보를 주고받는 바탕은 UNS, 통합 네임스페이스예요. 공장과 Zone, 셀의 상태와 오더, 결정, 명령이 모두 ISA-95 계층 주소를 달고 MQTT 브로커 한 곳에 모여요. 에이전트끼리 직접 잇지 않고 UNS 하나만 보기 때문에, 새 시스템을 붙여도 FacOS는 바꿀 게 없어요. 상태는 바뀔 때만 보내고, 명령은 요청부터 완료까지 같은 번호로 이어져요.',
      say: (T) => { const S = T.h.sim?.()?.uns?.summary(); return `UNS(통합 네임스페이스) — FacOS가 정보를 주고받는 바탕이에요. 공장 · Zone · 셀의 상태 · 오더 · 결정 · A2A · 명령이 ISA-95 계층 주소(camtic/metafactory/존/셀/…)를 달고 MQTT 브로커 한 곳에 모여요. 에이전트끼리 직접 잇지 않고 UNS만 보니, 시스템을 더해도 FacOS는 그대로예요. 상태는 바뀔 때만(retain), 명령은 요청 → 접수 → 실행 → 완료를 같은 Correlation ID로 이어요.${S?.topics ? ` 지금 토픽 ${S.topics}개 · 보존 상태 ${S.retained}개 · 변화 없어 건너뜀 ${S.suppressed}건.` : ''} 앱에서는 설비 데이터가 Sparkplug B로 들어와요.`; } },
    // 데이터 코디네이터 — FacOS는 데이터를 갖지 않고, UNS 위에서 데이터가 오가는 주소 · 방향 · 권한 · 순서 · 기록을 정한다
    { panel: { kind: 'orch', tab: 'uns' }, hl: ['#btnOrch', '#facos'], fchain: 5, live: true,
      voice: '그래서 FacOS를 데이터 코디네이터라고 불러요. FacOS는 데이터를 직접 만들거나 쌓아 두지 않아요. 데이터는 설비와 셀이 만들고, 브로커가 날라요. FacOS는 그 데이터가 어떤 주소로, 어느 방향으로, 누구의 권한으로, 어떤 순서로 오가는지를 정하고, 무엇을 왜 결정했는지 기록해요. 그래서 시스템이 늘어나도 모두 같은 규칙으로 움직여요.',
      say: (T) => { const S = T.h.sim?.()?.uns?.summary(), K = fos(T)?.kpi(); return `데이터 코디네이터 — FacOS는 데이터를 만들거나 쌓아 두는 곳이 아니에요. 데이터는 설비(OPC UA) · 셀이 만들고, 브로커(MQTT 5)가 날라요. FacOS는 그 흐름의 규칙을 정해요: ① 주소(ISA-95 토픽) ② 방향(명령 ↓ · 상태 ↑ · 같은 계층은 알림만) ③ 권한(계층별 ACL · 상태 위조 불가) ④ 순서(명령 요청 → 접수 → 실행 → 완료, 같은 Correlation ID · 결정은 승인 뒤 계획 버전 증가) ⑤ 기록(A2A · 결정 · 오더 · 계획 버전).${S?.topics ? ` 지금 토픽 ${S.topics}개` : ''}${K ? ` · A2A ${K.msgs}건(차단 ${K.blocked}) · 명령 검증 승인 ${K.ocsOk} / 거부 ${K.ocsRej}` : ''}${S?.topics || K ? '.' : ''} 데이터를 처리하는 중심이 아니라 흐름의 질서를 맞추는 조정자라서, 시스템을 더해도 같은 규칙으로 움직여요.`; } },
    { panel: { kind: 'fac', tab: 'po' }, hl: ['#btnFac'], fchain: 6,
      voice: '마지막은 FAC 업무 기록이에요. FacOS가 한 발주, 입고, 재고 이동, 정비요청, 오더 배정과 종료가 전표로 남아요. 앱에서는 ERPNext와도 연동돼요.',
      say: 'FAC 업무 기록 — FacOS가 한 일이 전표로 남아요: 구매오더(P0000n) · 입고(WH/IN) · 내부 이동 · 출고(WH/OUT, 10분마다 한 전표로 묶음) · 정비요청(MR/) · 오더 배정 · 종료. 앱에서는 ERPNext와도 연동돼요.' },
    { panel: { kind: 'orch', tab: 'fos' }, hl: ['#btnOrch', '#facos'], fchain: -1, live: true, end: true, next: 'incident',
      voice: '정리하면, FacOS는 UNS 위에서 오더부터 결정, 명령 검증, 기록까지 공장의 운영 규칙을 지키게 해요. 이제 인시던트 해결 예시에서 FacOS가 실제로 움직이는 모습을 볼까요?',
      say: (T) => { const K = fos(T)?.kpi(); return `정리 — FacOS는 UNS 위에서 오더 → 결정 → 명령 검증 → 기록까지 운영 규칙을 지키게 해요.${K ? ` 지금 지표: 이상 판단 10초 이내 ${K.judgeRate == null ? '-' : `${Math.round(K.judgeRate * 100)}%`} · 수량 정산 오차 ${K.recon?.err ?? '-'} · 명령 검증 승인 ${K.ocsOk} / 거부 ${K.ocsRej} · A2A 메시지 ${K.msgs}건(차단 ${K.blocked}).` : ''} 다음 — 인시던트 해결 예시에서 FacOS가 실제로 움직이는 모습을 봐요!`; } },
  ] },
  // KPI 영향 · 개선: 손실 분석 → 개선 제안 → 디지털트윈 검증 → 결정(적용 · 보류 · 되돌리기) → 실측 → 이력
  //   적용 · 되돌리기는 트윈이 「적용 권장」일 때만 토리가 시연하고 운영값을 원래대로 남긴다 (실제 개선 결정은 사용자가)
  //   공장 시간 5분 전에는 제안이 없으므로, 제안이 생길 때까지 잠시 30배속 (다음 단계에서 원래 배속)
  kpi: { name: 'KPI 영향 · 개선', steps: [
    { act: (T) => { const A = adv(T), s = T.h.sim?.(); if (A && !A.items.some((p) => p.lever) && T.spd0 === undefined) { T.spd0 = T.h.speed?.() ?? null; T.h.speed?.(30); } },
      mode: 'dark', panel: { kind: 'impact', focus: 'loss' }, hl: ['#btnImpact'], kchain: -1, live: true, ready: (T) => !adv(T) || adv(T).items.some((p) => p.lever),
      voice: 'UPH가 떨어졌다는 것만으로는 손을 쓸 수 없어요. 어디서, 왜, 얼마나 잃었는지 알아야 개선할 수 있죠. KPI 영향 개선 창은 손실을 원인별로 나누고, 고칠 방법을 제안하고, 디지털 트윈으로 미리 검증한 뒤 결정을 물어요.',
      say: (T) => `KPI 영향 · 개선 — 「UPH가 떨어졌다」만으로는 손을 쓸 수 없어요. 어디서 · 왜 · 얼마나 잃었는지 알아야 고치죠. 이 창은 손실을 원인별로 나누고 → 고칠 방법을 제안하고 → 디지털트윈으로 미리 검증한 뒤 → 결정을 물어요.${T.spd0 !== undefined && !adv(T)?.items.some((p) => p.lever) ? ' (첫 제안은 공장 시간 5분 뒤부터 나와서, 잠시 30배속으로 돌리는 중이에요)' : ''}` },
    { act: (T) => T.restoreSpeed(), hl: ['#btnImpact'], kchain: 0, live: true,
      voice: '먼저 손실 분석이에요. 셀이 가동하지 못한 시간을 설비 고장, 정비, 자재 공급 차질, 현장 이벤트, 흐름 대기, 품질 불량 같은 열한 가지 원인으로 나누고, UPH와 OEE, 재공, 즉 공정 안에 머물러 있는 미완성품, 그리고 전력 손실로 바꿔 보여 줘요.',
      say: (T) => { const r = lossTop(T); return `① 손실 분석 — 가동하지 못한 시간을 원인 11가지(설비 고장 · 예지정비 · 재보정 · 결품 · 공급 차질 · 현장 이벤트 · 정지 명령 · 흐름 대기 · 출하 대기 · 속도 · 품질)로 나눠 UPH · OEE · 재공(공정 안에 머문 미완성품, WIP) · 전력 손실로 바꿔요.${r && r.oeePts > 0 ? ` 최근 30분 1순위는 ${r.icon} ${r.label}: OEE −${(r.oeePts * 100).toFixed(1)}%p · UPH −${r.uph.toFixed(1)}${r.wip > 0.05 ? ` · 재공 +${r.wip.toFixed(1)}` : ''}.` : ''}`; } },
    { act: (T) => { if (T.prop === undefined) T.prop = pickProp(T); }, panel: (T) => ({ kind: 'impact', focus: T.prop?.id ?? null }), hl: ['#btnImpact'], kchain: 1,
      voice: '손실이 기준을 넘으면 실제 운영값을 바꾸는 개선 제안이 생겨요. 예지정비 시작 시점, 재보정 기준, 투입 간격, AMR 선행 배차, 셀 절전 대기 같은 값이에요. 제안마다 근거, 기대 효과, 부작용이 함께 나와요.',
      say: (T) => { const p = T.prop; return p ? `② 개선 제안 — 「${p.title}」: 근거 ${p.why}. 바꿀 값 ${p.lever ? `${LEVERS[p.lever]?.label ?? p.lever} ${levV(p, p.from)} → ${levV(p, p.to)}` : ''}. 기대 효과 ${p.expect}. 부작용 ${p.trade}. 제안마다 근거 · 기대 효과 · 부작용이 함께 나와요.` : '② 개선 제안 — 지금은 손실이 기준 아래라 제안이 없어요. 손실이 기준을 넘으면 예지정비 시작 시점 · 재보정 기준 · 투입 간격 · AMR 선행 배차 · 셀 절전 대기 같은 실제 운영값을 바꾸는 제안이 생겨요.'; } },
    { hl: ['#btnImpact'], kchain: 2, live: true, ready: (T) => !T.prop || !!T.prop.twin || T.prop.status === 'applied',
      voice: '바로 적용하지 않고 디지털 트윈으로 먼저 검증해요. 지금 운영값과 제안 운영값으로 30분씩, 조건을 바꿔 세 번 돌리고, 실제 공장에서 일어난 현장 이벤트도 똑같이 재연해요. 결과는 적용 권장, 효과 미미, 보류 권장 중 하나예요.',
      say: (T) => { const p = T.prop, t = p?.twin; return `③ 트윈 검증 — 현재 vs 제안 운영값을 30분 × 시드 3으로 돌리고, 실제로 일어난 현장 이벤트도 똑같이 재연해요. ${!p ? '' : t ? `결과: ${REC_KO[t.recommend]} — UPH ${t.uphCur.toFixed(0)} → ${t.uphCand.toFixed(0)} · OEE ${signed((t.oeeCand - t.oeeCur) * 100)}%p · 재공 ${signed(t.wipCand - t.wipCur)} · 전력 ${signed((t.kwhCand - t.kwhCur) * 1000)}Wh/개.` : `검증 중… ${Math.round((p.progress ?? 0) * 100)}%`}`; } },
    { act: (T) => { const A = adv(T), p = T.prop; if (A && p && T.applied === undefined) T.applied = p.twin?.recommend === 'apply' && p.status === 'verified' ? A.apply(p.id) : false; },
      panel: (T) => ({ kind: 'impact', focus: T.prop?.id ?? null }), hl: ['#btnImpact'], kchain: 3,
      voice: '결정의 첫째는 적용이에요. 트윈에서 적용 권장이 나오고 부작용을 감당할 수 있을 때 적용하면, 운영값이 바로 바뀌고 10분 동안 적용 전과 실측을 비교해요.',
      say: (T) => `④ 결정 · 적용 — 언제: 트윈 「적용 권장」 + 부작용을 감당할 수 있을 때. 적용하면 운영값이 바로 바뀌고, 적용 전 10분 vs 적용 후 10분을 실측으로 비교해요.${T.applied ? ` 시연으로 「${T.prop.title}」을 적용했어요 (${levV(T.prop, T.prop.from)} → ${levV(T.prop, T.prop.to)}) — 다음 단계에서 되돌려 원래대로 둘게요.` : T.prop?.twin ? ` 이번 제안은 「${REC_KO[T.prop.twin.recommend]}」이라 적용은 시연하지 않을게요.` : ''}` },
    { hl: ['#btnImpact'], kchain: 3,
      voice: '둘째는 보류예요. 트윈에서 보류 권장이나 효과 미미가 나왔을 때, 또는 납기 직전이나 고장 대응 중처럼 지금 바꾸면 곤란할 때 보류해요. 보류는 거절이 아니라 지금은 아니라는 뜻이에요. 30분 뒤에도 근거가 남아 있으면 다시 물어요.',
      say: '⑤ 결정 · 보류 — 언제: 트윈 「보류 권장」 · 「효과 미미」, 또는 지금 바꾸면 곤란할 때(납기 직전 · 고장 대응 중). 보류는 거절이 아니라 「지금은 아님」 — 30분 동안 다시 묻지 않고, 그 뒤에도 손실 근거가 남아 있으면 다시 올라와요. 근거가 사라지면 제안도 저절로 정리돼요.' },
    { act: (T) => { const A = adv(T), p = T.prop; if (A && p && T.applied && p.status === 'applied') { A.revert(p.id); T.applied = 'reverted'; } },
      panel: (T) => ({ kind: 'impact', focus: T.prop?.id ?? null }), hl: ['#btnImpact'], kchain: 4,
      voice: '셋째는 되돌리기예요. 적용 뒤 10분 실측이 트윈 예측과 다르게 나빠졌다면 되돌려요. 10분 양품 수가 적으면 우연한 변동만으로도 UPH가 몇 퍼센트 흔들리니까, 화면의 신뢰 범위 안내도 함께 보세요.',
      say: (T) => `⑥ 결정 · 되돌리기 — 언제: 적용 후 10분 실측이 트윈 예측과 다르게 나빠졌을 때. 원래 운영값으로 돌아가고 실측 해석이 남아요. 10분 양품이 적으면 우연 변동만으로 UPH가 ±몇 % 흔들리니, 화면의 신뢰 범위 안내도 함께 봐요.${T.applied === 'reverted' ? ` 시연한 「${T.prop.title}」은 방금 되돌려 원래 값(${levV(T.prop, T.prop.from)})으로 두었어요.` : ''}` },
    { panel: { kind: 'impact', focus: 'log' }, hl: ['#btnImpact'], kchain: 5, live: true,
      voice: '모든 결정은 의사결정 이력과 운영 로그에 남아요. 누가, 언제, 무엇을 바꿨고 결과가 어땠는지가 쌓여서, 운영 AI 학습 데이터와 운영 규칙을 고치는 근거가 돼요.',
      say: (T) => { const L = adv(T)?.log ?? []; return `⑦ 의사결정 이력 — 누가 · 언제 · 무엇을 바꿨고 결과가 어땠는지가 남아요${L.length ? ` (지금 ${L.length}건 — 최근: ${L.slice(0, 2).map((x) => `${x.act} 「${x.title}」`).join(' · ')})` : ''}. 이 기록은 운영 AI(AIOS) 학습 데이터와 운영 규칙을 고치는 근거가 돼요.`; } },
    { hl: ['#btnImpact'], kchain: -1, end: true, next: 'data',
      voice: '활용 팁 세 가지예요. 결정은 검증, 적용, 실측, 판단 순서로 하세요. 보류는 거절이 아니라 지금은 아니라는 뜻이에요. 되돌리기는 실패가 아니라 학습이에요. 트윈과 실제 공장의 차이를 알려 주는 귀한 데이터가 되거든요.',
      say: '활용 팁 — ① 결정 순서는 검증 → 적용 → 실측 → 판단 (검증 없이 적용하면 실측에만 의존) ② 보류는 거절이 아니라 「지금은 아님」 ③ 되돌리기는 실패가 아니라 학습 — 「트윈은 좋았는데 실측은 나빴다」는 기록이 트윈과 실제 공장의 차이를 알려 주는 데이터가 돼요. 다음은 이 기록이 쌓이는 데이터 폐루프와 플라이휠이에요!' },
  ] },
  // 인시던트 해결 예시 (3막): ① 현장 — 이벤트를 조용히 만들고 그 자리로 확대, 감지한 로봇의 카메라 영상 → ② 오케스트레이터 — 그 인시던트 흐름도로
  //   보고 · 판단 · 명령 · 배정 → ③ 해결된 현장 — 출동 로봇을 따라가며 처리 · 정상화 · 기록. 진행하는 동안 시뮬레이션 1배속 (끝나면 원래 배속)
  incident: { name: '인시던트 해결 예시', steps: [
    { act: (T) => { if (T.spd0 === undefined) { T.spd0 = T.h.speed?.() ?? null; T.h.speed?.(1); } }, mode: 'dark', view: 'precision',
      voice: '예시로 현장에 문제를 하나 일으켜 볼게요. 잘 보이도록 시뮬레이션을 1배속으로 늦췄어요. 먼저 현장, 다음은 오케스트레이터, 마지막으로 해결된 현장 순서로 보여 드릴게요.',
      say: '예시로 현장에 문제를 하나 일으켜 볼게요. 잘 보이도록 시뮬레이션을 1배속으로 늦췄어요 (안내가 끝나면 원래 배속으로). 먼저 ① 현장 → ② 오케스트레이터 → ③ 해결된 현장 순서로 보여 드릴게요.' },
    // ── 1막 현장 ──
    // 말과 현장을 맞춘다: 이벤트를 만든 뒤 「AI 감지」 단계까지 현장을 멈추고 감지도 막는다 (ev.quiet) → 감지되면 감지 로봇 설명이 끝날 때까지 다시 멈춤
    { act: (T) => { if (T.ev === undefined) T.ev = T.h.quietEvent?.() ?? null; }, hold: (T) => !!T.ev, cam: (T) => T.ev && { x: T.ev.x, z: T.ev.z, d: 9 }, hl: ['#btnEvent'],
      vk: sevK, voice: {
        alarm: '현장입니다. 방금 로봇 카메라 앞에 문제가 생겼어요. 빨간 표지와 빛기둥이 보이죠? 경보 단계라 빨간색이에요. 아직 아무도 모르는 상태예요.',
        warn: '현장입니다. 방금 로봇 카메라 앞에 문제가 생겼어요. 노란 표지와 빛기둥이 보이죠? 주의 단계라 노란색이에요. 아직 아무도 모르는 상태예요.' },
      say: (T) => T.ev ? `현장 — 방금 「${T.ev.label}」 상황이 생겼어요 (우선순위 P${prioOf(T.ev)} · 위험 반경 ${RADIUS[T.ev.type] ?? 1.2}m). ${evColor(T)} 표지와 빛기둥이 보이죠? ${sevK(T) === 'alarm' ? '경보(빨강)' : '주의(노랑)'} 단계예요. 아직 아무도 모르는 상태예요.` : '지금은 현장 이벤트를 만들 수 없어요. 피지컬AI 단계에서 ⚠ 현장 이벤트 버튼으로 다시 해 보세요.' },
    { act: (T) => { if (T.ev?.quiet) { T.ev.quiet = false; T.ev.tq = T.h.sim?.()?.time; } }, hold: (T) => !!T.ev?.detected, live: true, ready: (T) => !T.ev || T.ev.detected || T.ev.cleared,
      wait: '아직 감지되지 않았어요 — 감지되면 바로 넘어갈게요.',   // 감지 전에 「다음」을 눌렀을 때
      voice: '주변을 지나는 로봇의 카메라 영상을 AI가 계속 추론하고 있어요. 이상한 물체나 사람이 보이면 바로 감지해요.',
      say: (T) => `AI 감지 — 주변을 지나는 로봇 카메라 영상을 AI가 계속 추론하고 있어요. ${!T.ev ? '' : T.ev.detected ? `${ga(T.ev.detectedBy)} 감지했어요!` : `지금 찾는 중이에요… (${sec((T.h.sim?.()?.time ?? T.ev.t0) - T.ev.t0)} 경과)`}` },
    { cam: (T) => { const p = T.ev && T.h.moverPos?.(T.ev.detectedBy); return p ? { x: p.x, z: p.z, d: 8 } : T.ev && { x: T.ev.x, z: T.ev.z, d: 9 }; },
      panel: (T) => T.ev?.detectedBy && byRobot(T) === 'robot' && { kind: 'robot', id: T.ev.detectedBy }, hold: (T) => !!T.ev?.detected,   // 감지한 그 순간의 카메라 화면을 보여 준다 — 감지되지 않은 현장은 멈추지 않는다
      vok: (T) => !!T.ev?.detected, vno: '아직 감지되지 않았어요. 조금 더 기다려 볼게요.', vk: byRobot, voice: {   // 감지 전이면 「감지했어요」 녹음 대신 vno 녹음
        robot: '이 로봇이 감지했어요. 잠시 뒤 열리는 로봇 정보 창에서 그 로봇의 카메라 영상과 AI 검출 상자를 볼 수 있어요. 감지하자마자 셀은 스스로 감속하고 우회해요.',
        cctv: '이번에는 CCTV 영상 AI가 먼저 감지했어요. 감지하자마자 셀은 스스로 감속하고, 주변 로봇은 그 구역을 우회해요.' },
      say: (T) => !T.ev?.detected ? '아직 감지되지 않았어요. 조금 더 기다려 볼게요.' : byRobot(T) === 'cctv' ? `${ga(T.ev.detectedBy)} ${took(T)} 감지했어요 (신뢰도 ${Math.round((T.ev.conf ?? 0) * 100)}%). 감지 즉시 셀 자체 조치 — ${T.ev.type === 'intrusion' ? '주변 로봇 협동 감속 · 접근 금지 구역 표시' : '주변 로봇 감속 · 우회 · 구역 표시'}. (설명하는 동안 현장은 잠시 멈춰 둘게요)` : `${ga(T.ev.detectedBy)} ${took(T)} 감지했어요 (신뢰도 ${Math.round((T.ev.conf ?? 0) * 100)}%). 잠시 뒤 열리는 로봇 정보 창에 그 카메라 영상과 AI 검출 상자가 보여요. 감지 즉시 셀 자체 조치 — ${T.ev.type === 'intrusion' ? '주변 로봇 협동 감속 · 접근 금지 구역 표시' : '감지 로봇 감속 · 우회 · 구역 표시'}.${T.held ? ' (설명하는 동안 현장은 잠시 멈춰 둘게요)' : ''}` },
    // ── 2막 오케스트레이터 ──
    { panel: (T) => T.ev?.inc && { kind: 'orchInc', key: `ev:${T.ev.id}` }, hl: ['#orchPanel'], live: true, hold: (T) => !!inc(T, 'command'), ready: (T) => !T.ev?.inc || !!inc(T, 'command') || T.ev.cleared,
      voice: '이제 오케스트레이터입니다. 셀이 상위로 보고하면, 그 Zone의 오케스트레이터가 우선순위를 정해요. 화재와 인명이 먼저, 그다음 시설과 작업 안전, 생산 정지 순이에요. 안전 사고는 FacOS 공장 오케스트레이터에도 바로 알려요.',
      say: (T) => { const r = inc(T, 'report'), d = inc(T, 'decide'); return `오케스트레이터 — 흐름도에 이 인시던트가 열려 있어요. 감지 → 셀 자체 조치 → ${r ? `상위 보고(${at(T, r)})` : '상위 보고'} → ${d ? `판단(${at(T, d)})` : '판단 중…'}. 우선순위는 P1 화재 · 인명 → P2 시설 · 작업 안전 → P3 생산 정지 순이고, 이번 건은 ${ieyo(`P${prioOf(T.ev ?? {})}`)}. P1 · P2는 FacOS 공장 오케스트레이터에 즉시 보고(A2A)돼요.`; } },
    // UNS로 다시 보기 ① 보고 — 존 오케스트레이터는 공장에 직접 잇지 않고 UNS A2A 토픽에 발행, FacOS가 구독 (강조 = 이번 사건 토픽)
    { panel: (T) => T.ev?.inc && { kind: 'orch', tab: 'uns', uns: (s) => incUns(T, s, 'report') }, hl: ['#orchPanel'], live: true, hold: (T) => !!inc(T, 'command'),
      voice: '같은 보고를 UNS에서 다시 볼게요. 존 오케스트레이터는 공장에 직접 연결하지 않아요. 인시던트 보고를 정해진 주소의 UNS 토픽에 발행하면, FacOS 공장 오케스트레이터가 그 토픽을 구독해서 받아요. 노랗게 강조된 줄이 이번 사건으로 생긴 토픽이에요.',
      say: (T) => { const R = incUns(T, undefined, 'report'); return `UNS로 보면 ① 보고 — 존 오케스트레이터는 공장에 직접 잇지 않고 UNS 토픽에 발행하고, FacOS가 그 토픽을 구독해 받아요.${!R ? '' : R.a2a.length ? ` 이번 사건: ${R.a2a.slice(0, 3).map((x) => `${A2A_KO[x.m.type] ?? x.m.type} → ${R.short(x.topic)}`).join(' · ')}${R.a2a.length > 3 ? ` 외 ${R.a2a.length - 3}건` : ''}.` : ' 보고 토픽이 발행되기를 기다리는 중이에요 (2초마다 수집)…'} 노랗게 강조된 줄이 그 토픽이에요 — 이벤트라 retain 없이 한 번만 나가요.`; } },
    { hl: ['#orchPanel'], live: true, hold: (T) => !!inc(T, 'command'),
      voice: '판단이 끝나면 명령이 내려가요. 하던 일이 덜 급한 로봇을 골라 배정하고, 하던 일은 처리 뒤에 이어서 해요. 주변 셀에는 안전 감속이나 보호 정지 명령이 함께 가요.',
      say: (T) => { const c = inc(T, 'command'); return `명령 · 배정 — ${c ? `${c.text.replace(/^명령:\s*/, '')} (${at(T, c)})` : '명령을 내리는 중이에요…'}${T.ev?.cmdCells?.length ? ` · 셀 ${T.ev.cmdCells.length}곳에 ${T.ev.type === 'intrusion' ? '안전 감속' : '보호 정지'} 명령` : ''}. 덜 급한 일을 하던 로봇을 골라 배정하고, 하던 일은 처리 뒤 이어서 해요.${T.held ? ' (설명하는 동안 현장은 잠시 멈췄어요 — 다음 단계에서 다시 움직여요)' : ''}`; } },
    // UNS로 다시 보기 ② 명령 — A2A 명령 + 셀 cmd 4단(같은 Correlation ID) + 셀 상태(retain)
    { panel: (T) => T.ev?.inc && { kind: 'orch', tab: 'uns', uns: (s) => incUns(T, s, 'cmd') }, hl: ['#orchPanel'], live: true, hold: (T) => !!inc(T, 'command'),
      voice: '명령도 UNS를 거쳐요. 존 오케스트레이터의 명령은 A2A 토픽으로, 셀에 보내는 명령은 셀 주소의 cmd 토픽으로 발행돼요. 셀은 접수, 실행, 완료를 같은 Correlation ID로 다시 발행하고, 접수만으로는 끝난 것으로 보지 않아요. 바뀐 셀 상태도 상태 토픽에 남아요.',
      say: (T) => { const R = incUns(T, undefined, 'cmd'); if (!R) return 'UNS로 보면 ② 명령 — 명령은 A2A 토픽과 셀의 cmd 토픽으로 나가요.'; const cm = R.cmds.map((x) => `${x.c.unsCorr ?? `CMD-${x.c.id}`} ${R.short(x.base)}: ${x.hs.map((h) => UNS_CMD[h.state] ?? h.state).join(' → ') || '발행 대기'}`); return `UNS로 보면 ② 명령 — ${R.a2a.length ? `존의 명령 A2A ${R.a2a.length}건(${R.short(R.a2a[0].topic)})` : '존의 명령 A2A 발행 대기'}${cm.length ? ` · 셀 명령 ${cm.slice(0, 2).join(' · ')}${cm.length > 2 ? ` 외 ${cm.length - 2}건` : ''}` : ' · 이번 건은 셀 명령 없이 대응 로봇 배정만'}. Correlation ID 하나로 cmd → ack → exec → done을 잇고, 접수(ack)만으로는 끝으로 보지 않아요${R.cells.length ? ` · 바뀐 셀 상태 ${R.cells.length}곳(retain)` : ''}. 지금은 현장이 멈춰 있어 다음 장면에서 완료(done)까지 이어져요.`; } },
    // ── 3막 해결된 현장 ──
    { act: (T) => { if (T.ev?.responder && !arrived(T) && resp(T) !== 'safety') { T.fast = true; T.h.speed?.(3); } },   // 현장까지 가는 길은 3배속 (도착하면 멈춰 1배속으로 — 다음 단계) · 사람 진입은 1배속(3배속이면 설명하는 동안 진입자가 다 나가 버린다)
      panel: null, follow: (T) => T.ev?.responder, camF: escortCam, cam: (T) => T.ev && !T.ev.responder && { x: T.ev.x, z: T.ev.z, d: 10 }, live: true,
      hold: arrived, ready: (T) => !T.ev || T.ev.cleared || (resp(T) === 'safety' && !T.ev.responder) || arrived(T),   // 따라가는 로봇이 도착하면 멈추고 다음 단계에서 처리를 보여 준다
      vk: resp, voice: {
        clean: '다시 현장입니다. 배정된 로봇을 따라가 볼게요. 현장까지 가는 동안은 3배속으로 빠르게 보여 드릴게요. 정비 휴머노이드가 정비실에서 도구를 챙겨 현장으로 가요.',
        inspect: '다시 현장입니다. 배정된 로봇을 따라가 볼게요. 현장까지 가는 동안은 3배속으로 빠르게 보여 드릴게요. 사족보행 로봇은 열화상과 가스 센서로 점검하러 가고, 정비 휴머노이드는 소화기를 챙겨 옆에서 대기해요.',
        safety: '다시 현장입니다. 사람이 들어온 경우에는 로봇이 사람에게 다가가지 않아요. 대신 가장 가까운 사족보행 로봇이 진입자 뒤쪽으로 돌아와 4미터 거리를 두고 따라가며, 행동과 동선을 오케스트레이터에 보고해요. 화면은 진입자와 로봇을 함께 비춰요. 주변 셀은 안전 속도로 기다려요.' },
      say: (T) => !T.ev ? '' : T.ev.type === 'intrusion' ? `출동 — 사람에게는 다가가지 않아요. ${T.ev.responder ? `${ga(T.ev.responder)} 진입자 뒤쪽으로 돌아와 4m 거리를 두고 합류${arrived(T) ? '했어요! 이제 따라가며 행동 · 동선을 보고해요.' : `하는 중이에요${escortGap(T) != null ? ` (지금 ${escortGap(T).toFixed(0)}m 뒤 · ${T.ev.escort?.phase === 'chase' ? '동선을 따라 따라잡는 중' : '뒤쪽으로 돌아가는 중'})` : ''}.`}` : 'CCTV로 진입자를 추적해요.'} 주변 셀은 안전 속도로 기다리고, 원격 관제 요원을 불러요.` : `출동 — ${T.ev.responder ? `화면이 ${T.ev.responder} 로봇을 따라가고 있어요${T.fast && !arrived(T) ? ' (이동 구간 3배속 ⏩)' : ''}. ${arrived(T) ? '현장에 도착했어요!' : T.h.sim?.()?.movers?.find((m) => m.id === T.ev.responder)?.task ?? '이동 중이에요…'}` : '대응 로봇을 기다리는 중이에요…'}` },
    { act: (T) => { if (T.fast) { T.fast = false; T.h.speed?.(1); } },   // 현장 처리는 다시 1배속으로
      cam: (T) => T.ev && { x: T.ev.x, z: T.ev.z, d: 8 }, follow: (T) => (resp(T) === 'safety' ? T.ev?.responder : null), camF: escortCam, live: true, ready: (T) => !T.ev || T.ev.cleared, hold: (T) => !!T.ev?.cleared,   // 처리가 끝나면 멈춰 해결 장면을 보여 준다 · 사람 진입은 추적 로봇을 따라간다
      vk: resp, voice: {
        clean: '로봇이 현장에서 처리하고 있어요. 이동 중인 다른 로봇들은 위험 반경을 피해 돌아가요.',
        inspect: '사족보행 로봇이 열화상과 가스 센서로 점검하고 있어요. 이동 중인 다른 로봇들은 위험 반경을 피해 돌아가요.',
        safety: '사족보행 로봇이 4미터 거리를 두고 진입자를 따라가요. 진입자가 멈추거나 다시 걸으면 그때마다, 걷는 동안은 10초마다 위치와 방향을 보고해요. 진입자가 다가오면 로봇이 물러서고, 다른 로봇들은 진입자 주변을 피해 돌아가요.' },
      say: (T) => `처리 중 — ${!T.ev ? '' : T.ev.cleared ? `처리가 끝났어요! ${T.ev.type === 'intrusion' ? '진입자가 구역을 나갔어요.' : ''}(설명이 끝나면 해결 장면으로 넘어가요)` : `${T.ev.responder ? `${ga(T.ev.responder)} ` : ''}${T.ev.type === 'smoke' ? '열화상 · 가스 센서로 점검' : T.ev.type === 'intrusion' ? '4m 거리를 두고 진입자를 따라가며 행동 · 동선을 보고하는' : '흡착 · 수거'} 중이에요.${T.ev.type === 'intrusion' && T.ev.acts?.length ? ` 최근 보고: 진입자 ${T.ev.acts.at(-1).what}.` : ''} 다른 로봇들은 위험 반경을 피해 돌아가요.`}` },
    { cam: (T) => T.ev && { x: T.ev.x, z: T.ev.z, d: 10 },
      vk: clearK, voice: {
        clean: '해결됐어요. 빨간 표지가 사라지고, 멈췄던 셀과 로봇은 정상 속도로 돌아갔어요. 도구는 정비실에 반납해요.',
        cleanWarn: '해결됐어요. 노란 표지가 사라지고, 멈췄던 셀과 로봇은 정상 속도로 돌아갔어요. 도구는 정비실에 반납해요.',
        inspect: '해결됐어요. 점검 결과 이상이 없어 알람을 해제했어요. 멈췄던 셀은 다시 돌아가고, 소화기는 정비실에 반납해요.',
        safety: '해결됐어요. 진입자가 구역을 나간 것을 사족보행 로봇이 확인하고, 이동 거리와 시간, 멈춘 곳을 담은 추적 결과를 보고했어요. 감속했던 셀과 로봇은 정상 속도로 돌아갔어요.' },
      say: (T) => !T.ev ? '' : `해결 — 표지가 사라지고 셀 · 로봇이 정상 속도로 돌아갔어요. 감지부터 해결까지 ${sec((T.ev.tClear ?? T.ev.t0) - (T.ev.tDetect ?? T.ev.t0))} (감지 ${sec((T.ev.tDetect ?? T.ev.t0) - (T.ev.tq ?? T.ev.t0))} · 대응 ${sec((T.ev.tClear ?? T.ev.t0) - (T.ev.tDetect ?? T.ev.t0))}).${T.ev.type === 'smoke' ? ' 점검 결과 발열 · 연소 흔적이 없어 알람을 해제했어요.' : ''}${T.ev.type === 'intrusion' && T.ev.walk ? ` 추적 결과: 동선 ${T.ev.walk.dist.toFixed(0)}m · 멈춤 ${T.ev.walk.stopped ? `1회 (${T.ev.walk.stopName ?? '셀'} 앞)` : '없음'} · 행동 보고 ${T.ev.acts?.length ?? 0}건 · 동선 기록 ${T.ev.trail?.length ?? 0}점${T.ev.escort?.minGap != null ? ` · 최소 거리 ${T.ev.escort.minGap.toFixed(1)}m` : ''}.` : ''}` },
    { panel: (T) => T.ev?.inc && { kind: 'orchInc', key: `ev:${T.ev.id}` }, hl: ['#btnOrch', '#btnImpact'], end: true, next: 'trace',
      voice: '흐름도에 감지부터 완료 확인까지 모든 시각이 남았어요. 이 기록은 KPI 영향 분석과 운영 AI 학습 데이터가 돼요. 이렇게 AI는 보고 판단하고, 피지컬AI 로봇은 직접 가서 해결해요.',
      say: (T) => `기록 — 흐름도에 감지 → 자체 조치 → 보고 → 판단 → 명령 → 조치 → 완료 확인 ${T.ev?.inc?.steps?.length ?? ''}단계 시각이 남았어요. 이 기록은 KPI 영향 분석과 운영 AI(AIOS) 학습 데이터가 돼요. AI는 보고 판단하고, 피지컬AI 로봇은 직접 가서 해결해요. ⚡ 설비 고장 · ⚠ 현장 이벤트 버튼으로 다른 상황도 시험해 보세요!` },
  ] },
  loop: { name: '데이터 폐루프', steps: [
    { say: '메타팩토리의 데이터는 한 번 쓰고 끝나지 않아요. 현장에서 모은 데이터가 엣지와 서버를 거쳐 AI 학습 · 모니터링에 쓰이고, 그 결과가 다시 현장 제어로 돌아와요. 이 닫힌 고리를 데이터 폐루프라고 해요.', ring: 'loop', at: -1, view: 'all' },
    { say: '① 수집 — 로봇의 관절 · 손끝 위치 · 카메라 영상, 설비 상태, 진동 · 온도 같은 환경 센서, CCTV, AMR · 드론 위치를 모아요. 모든 데이터에는 공장 기준 시계(PTP)의 같은 시각이 붙어요.', ring: 'loop', at: 0, hl: ['#btnSensors', '#btnCctv'] },
    { say: '② 엣지 — 셀 엣지가 센서 값을 모아 RMS · 첨도 · FFT 같은 특징을 뽑고 1초씩 묶어요. 엣지 게이트웨이는 프로토콜을 바꾸고, 연결이 끊겨도 잠시 저장했다가 보내요. 셀 제어기는 VLA 파지 · 체결 판정 같은 엣지 스킬을 현장에서 바로 실행해요.', ring: 'loop', at: 1, hl: ['#btnSensors'] },
    { say: '③ 서버 · 연동 — 존 서버를 거쳐 공장 중앙의 MQTT 브로커(UNS)로 모이고, AAS 모델과 OPC UA PubSub 형식으로 다른 시스템과 주고받아요. 센서 DB, 로봇 에피소드, 운영 데이터셋이 서버에 쌓여요.', ring: 'loop', at: 2, hl: ['#btnData'] },
    { say: '④ AI 학습 — 로봇 데이터와 카메라 영상은 AI-ready 에피소드가 되어 VLA 모델을 학습하고, 생산 · 설비 · 물류 · 에너지 · 품질 데이터는 운영 데이터셋이 되어 공장 운영 AI(AIOS)의 정책을 학습해요.', ring: 'loop', at: 3, hl: ['#btnVla', '#btnAios'], mode: 'dark' },
    { say: '⑤ 모니터링 — Zone 대시보드에서 OEE · 6대 손실 · 관리도를, FacOS 패널에서 공장 · 존 · 셀 상태를 실시간으로 봐요. KPI 영향 분석은 이벤트가 생산량 · OEE · 재공(공정 안에 머문 미완성품, WIP) · 전력에 미친 손실을 나눠 보여 줘요.', ring: 'loop', at: 4,
      voice: '모니터링. 존 대시보드에서 OEE와 6대 손실, 관리도를, FacOS 패널에서 공장과 존, 셀 상태를 실시간으로 봐요. KPI 영향 분석은 이벤트가 생산량과 OEE, 재공, 즉 공정 안에 머물러 있는 미완성품, 그리고 전력에 미친 손실을 나눠 보여 줘요.', hl: ['#btnZoneDash', '#btnImpact'] },
    { say: '⑥ 현장 제어 — 검증된 모델은 로봇과 오케스트레이터에 배포되고, 오케스트레이터는 판단을 셀 현장 명령(정지 · 속도 · 정비 · 투입)으로 내려보내요. 그 결과가 다시 ① 수집으로 돌아오면서 고리가 닫혀요.', ring: 'loop', at: 5, hl: ['#btnOrch'] },
    { say: '정리하면 수집 → 엣지 → 서버 → AI 학습 · 모니터링 → 현장 제어 → 다시 수집이에요. 이 고리가 돌 때마다 공장이 조금씩 더 똑똑해지는데, 그 이야기가 데이터 플라이휠이에요.', ring: 'loop', at: 6, end: true, next: 'fly' },
  ] },
  fly: { name: '데이터 플라이휠', steps: [
    { say: '플라이휠은 한 번 돌기 시작하면 점점 더 빨리 도는 무거운 바퀴예요. 로봇이 일할수록 데이터가 쌓이고, 데이터가 쌓일수록 모델이 좋아지고, 모델이 좋아지면 로봇이 더 많은 일을 더 잘하게 돼요.', ring: 'fly', at: -1 },
    { say: '운영 → 데이터 — 피지컬AI 단계에서 로봇은 작업 사이클 세 번에 한 번을 에피소드로 기록해요. 0.2초 간격의 관절 · 손끝 · 그리퍼 기록과 카메라 영상, 자연어 작업 지시, 성공 여부가 함께 저장돼요.', ring: 'fly', at: 0, hl: ['#btnVla'], mode: 'dark' },
    { say: '데이터 → 학습 — 새 에피소드가 200개 쌓이면 VLA 학습이 자동으로 시작돼요. 공장 운영 AI는 10초마다 모은 운영 데이터를 10분 단위 데이터셋으로 묶어 학습해요.', ring: 'fly', at: 1, hl: ['#btnVla', '#btnAios'] },
    { say: '학습 → 배포 — 새 모델은 검증 성공률이 나아졌을 때만 배포돼요. 로봇 한 대에 먼저 배포해 지켜본 뒤 전체로 넓히고, 운영 AI는 디지털트윈에서 지금 정책과 비교해 검증한 뒤 추천 모드부터 적용해요. 나빠지면 자동으로 되돌려요.', ring: 'fly', at: 2, hl: ['#btnVla', '#btnAios'] },
    { say: '배포 → 성능 향상 — 좋아진 모델로 성공한 작업이 늘고, 고장 · 현장 이벤트 같은 새 상황의 데이터도 쌓여요. 에피소드마다 어떤 모델 버전으로 일했는지 남아서 버전별 성과를 비교할 수 있어요.', ring: 'fly', at: 3, hl: ['#btnImpact'] },
    { say: '성능 향상 → 다시 운영 — 더 잘 일하는 로봇이 더 많은, 더 좋은 데이터를 만들어 바퀴가 다시 돌아요. 바퀴를 빨리 돌리는 열쇠는 데이터 품질이라서, 같은 기준 시계와 스텝 시각 · 보간 여부 · 영상 시각 차이까지 기록해요.', ring: 'fly', at: 4 },
    { say: '데이터 폐루프가 길이라면, 데이터 플라이휠은 그 길을 돌수록 빨라지는 힘이에요. 이어서 현장 데이터가 어떤 표준과 네트워크를 거쳐 서버까지 가는지 볼까요?', ring: 'fly', at: 5, end: true, next: 'link' },
  ] },
  // 제품 ID 추적: 단계마다 그 현장으로 카메라를 옮겨 확대하고(cam), 3초 뒤 관련 창을 연다(panel) — 설명을 메타팩토리 기능과 바로 연결
  trace: { name: '제품 ID 추적 — 오더부터 출하 이후까지', tour: true, steps: [
    { chain: -1, cam: { view: 'precision' }, panel: null,
      say: '제품 하나의 일생은 ID로 이어져요. 생산에 들어갈 때 생산 ID, 품질검사에 합격하면 제품 고유 ID, 출하할 때는 팔레트 ID가 붙어요. 오더부터 출하 이후까지 그 흐름을 현장과 화면으로 따라가 볼게요.' },
    { chain: 0, cam: { view: 'all' }, hl: ['#orchPanel'],
      panel: (T) => ({ kind: 'orch', tab: 'uns', uns: (s) => unsSel(s, (e) => e.kind === 'order', '오더 — FacOS가 UNS에 올린 작업 요청 (ISA-95 OperationsRequest · retain)', ex.order(s)?.o.id) }),   // 오더 토픽 강조 · 마지막 메시지 = 지금 오더
      voice: '첫째, 오더. 공장 오케스트레이터가 오더를 받아 각 Zone에 배정해요. 양품 목표와 혼류 비율, 납기가 함께 내려가요. 이 오더는 UNS의 FacOS 오더 토픽에 ISA-95 작업 요청 형식으로 올라가요. MES나 ERP는 FacOS에 따로 묻지 않고 이 토픽을 구독해서 진행을 봐요. 앱에서는 ERPNext 작업지시와도 연동돼요.',
      say: (T) => { const o = ex.order(T.h.sim?.()); return `① 오더 — 공장 오케스트레이터가 오더를 받아 Zone에 배정해요.${o ? ` 지금 오더는 ${o.o.id}: 양품 목표 ${o.o.target}개 중 ${o.good}개 완료, 납기 ${clock(o.o.due)}.` : ''} 이 오더는 UNS ${o ? `_facos/order/${o.o.id}` : '_facos/order/{오더}'}에 ISA-95 작업 요청(OperationsRequest) 형식 · retain으로 올라가요. MES · ERP는 FacOS에 따로 묻지 않고 이 토픽을 구독해 진행을 봐요 — 노랗게 강조된 줄. 앱에서는 ERPNext 작업지시와도 연동돼요.`; }, live: true },
    { chain: 1, cam: { x: -46, z: -9, d: 22 }, panel: { kind: 'fac', tab: 'po' }, hl: ['#btnFac'],
      voice: '둘째, 자재 준비. 창고 재고가 재주문점 아래로 내려가면 구매오더가 확정되고, 입고 트럭이 이 도크로 들어와요. 들어온 자재에는 원자재 로트가 붙고, AGV가 투입구까지 날라요. FAC 창에서 구매오더와 입고 전표, 재고를 볼 수 있어요.',
      say: '② 자재 준비 — 창고 재고가 재주문점 아래로 내려가면 구매오더가 확정되고, 입고 트럭이 이 도크(왼쪽 벽)로 들어와요. 들어온 자재에는 원자재 로트가 붙고, AGV가 투입구까지 날라요. FAC 창에서 구매오더 · 입고 전표 · 재고를 볼 수 있어요. 이런 업무 기록은 FacOS의 FAC 전표에 남고 UNS에는 싣지 않아요 — UNS는 지금 공장 상태를 나누는 곳이에요.' },
    { chain: 2, cam: { station: 'SRC', d: 11 }, panel: null,
      voice: '셋째, 생산 투입. 자재가 투입구에서 AMR 지그에 오르는 순간 생산 ID가 붙어요. 이후 공정 기록은 모두 이 생산 ID에 쌓여요.',
      say: (T) => { const r = ex.wip(T.h.sim?.()); return `③ 생산 투입 — 자재가 투입구에서 AMR 지그에 오르는 순간 생산 ID가 붙어요.${r ? ` 방금 투입된 ${eun(prodKo(r.product))} ${r.wip} · 원자재 로트 ${r.lot}${r.amr ? ` · 운반 ${r.amr}` : ''}이에요.` : ''} 이후 공정 기록은 모두 이 ID에 쌓여요. UNS에서는 투입된 셀의 상태 토픽(main/{셀}/state)이 값이 바뀔 때만 발행돼요.`; }, live: true },
    { chain: 3, act: (T) => { T.exWip = ex.wip(T.h.sim?.(), 2) ?? ex.wip(T.h.sim?.()); },
      cam: (T) => ({ station: T.exWip?.steps.at(-1)?.id ?? 'DT_ASSY', d: 12 }), panel: (T) => ({ kind: 'trace', tab: 'trace', id: T.exWip?.wip }), hl: ['#btnTrace'],
      voice: '넷째, 생산 중 추적. 셀을 지날 때마다 그 셀의 로봇과 VLA 모델 버전, 운반 AMR, 설비 건강도, 체결 토크 같은 공정 측정값, 그 자리 환경값이 이 제품의 이력으로 기록돼요. 품질 추적 창에서 셀별 이력을 볼 수 있어요.',
      say: (T) => { const r = T.exWip, s = T.h.sim?.(); return `④ 생산 중 추적 — 셀을 지날 때마다 로봇 · VLA 모델 버전 · 운반 AMR · 설비 건강도 · 공정 측정값(체결 토크 · 각도 · 압입 하중) · 그 자리 환경값이 기록돼요.${r ? ` 지금 ${eun(r.wip)} ${cellName(s, r.steps.at(-1)?.id)}에 있고, 지금까지 셀 ${r.steps.length}곳의 기록이 쌓였어요.` : ''} UNS에는 셀 설비 요약({셀}/telemetry)과 명령이 실리고, 제품별 이력은 품질 추적이 이 값을 생산 ID에 묶어 만든 거예요.`; }, live: true },
    { chain: 4, act: (T) => { T.exSer = ex.serial(T.h.sim?.()); }, cam: { station: 'PACK', d: 11 }, panel: (T) => ({ kind: 'trace', tab: 'serial', id: T.exSer?.serial }), hl: ['#btnTrace'],
      voice: '다섯째, 품질 판정. 체결셀에서 토크와 각도를 전수 검사하고, 검사 포장셀에서 합격하면 중앙 발행기가 제품 고유 ID를 발행해요. QR 라벨을 붙이고 바로 판독해 검증해요. 판정 결과는 제품 ID와 공정 값, 품질 값을 묶은 품질 표본으로 UNS에 발행되고, 품질 분석과 KPI, AI 원인 분석이 이 표본을 구독해요. 제품 ID가 UNS에 실리는 곳이 바로 여기예요. 불합격이면 불량 사례가 열리고 AI가 원인 셀을 찾아요.',
      say: (T) => { const u = T.exSer; return `⑤ 품질 판정 — 체결셀에서 토크 · 각도를 전수 검사하고, 검사·포장셀에서 합격하면 중앙 발행기가 제품 고유 ID를 발행해요(품목별 순차 · 재사용 없음).${u ? ` 최근 합격한 ${prodKo(u.product)}: 제품 ID ${u.serial} ← 생산 ID ${u.wip}, ${u.mark?.symbol === 'DM' ? '금속 각인 DataMatrix' : 'QR 라벨(GS1 Digital Link)'} 판독 등급 ${u.mark?.grade ?? '-'}.` : ''} 판정마다 UNS main/_zone/quality에 { id: 제품 ID, 공정 변수, 품질 특성 } 품질 표본이 발행되고 품질 · KPI · AI 원인 분석이 구독해요 — 제품 ID가 UNS에 실리는 유일한 곳이에요${(() => { const q = qSample(T.h.sim?.()); return q?.id ? ` (최근 표본 id ${q.id}${q.ng ? ' · 불합격' : ''})` : ''; })()}. 불합격이면 불량 사례가 열리고 AI가 원인 셀을 찾아요.`; }, live: true },
    { chain: 5, act: (T) => { T.exPal = ex.pallet(T.h.sim?.()); }, cam: { x: 28, z: -7, d: 26 }, panel: (T) => ({ kind: 'trace', tab: 'serial', id: T.exPal?.units?.[0] }), hl: ['#btnTrace'],
      voice: '여섯째, 포장과 출하. 합격품은 팔레트에 실리고, 팔레트마다 SSCC가 붙어 팔레트와 제품 ID가 묶여요. 트럭과 출하 시각도 함께 기록돼요. 출하 전 샘플 재검 결과에 따라 로트 출하를 보류하거나 풀어요.',
      say: (T) => { const p = T.exPal; return `⑥ 포장 · 출하 — 합격품은 팔레트에 실리고, 팔레트마다 SSCC가 붙어 팔레트와 제품 ID가 묶여요(EPCIS 묶음 이벤트). 트럭 · 출하 시각도 기록돼요.${p ? ` 최근 팔레트 ${p.sscc}에 ${prodKo(p.product)} ${p.units.length}개${p.truck ? ` · ${p.truck}로 출하` : ' · 출하 대기'}.` : ' 아직 만들어진 팔레트가 없어요.'} 출하 전 샘플 재검 결과에 따라 로트 출하를 보류하거나 풀어요. 팔레트 · 출하 기록은 EPCIS 저장소에 이벤트로 남고, 같은 값을 UNS에 두 번 싣지는 않아요.`; } },
    { chain: 6, act: (T) => { T.exShip = ex.shipped(T.h.sim?.()); }, cam: { x: 27, z: -23, d: 30 },
      panel: (T) => (T.exShip ? { kind: 'trace', tab: T.exShip.zone === 'main' ? 'trace' : 'serial', id: T.exShip.serial, epcis: true } : { kind: 'trace', tab: 'serial' }), hl: ['#btnTrace'],
      voice: '일곱째, 출하 이후. 제품 라벨의 QR 코드로 제품 ID를 조회하면 생산 이력까지 이어져요. 문제가 생기면 트럭에서 팔레트, 제품 ID로 리콜 범위를 찾고, 거꾸로 원인 셀과 로트, 시간대로 영향 범위를 좁혀요. 모든 기록은 GS1 EPCIS 표준 이벤트라 고객사와 협력사 시스템과 공유할 수 있어요. 이 시뮬레이터는 출하까지 기록하고, 판매 이후 A/S와 반품 데이터도 같은 ID로 이어 붙일 수 있는 구조예요.',
      say: (T) => { const u = T.exShip; return `⑦ 출하 이후 — 제품 라벨의 QR(GS1 Digital Link)로 제품 ID를 조회하면 생산 이력까지 이어져요. 문제가 생기면 트럭 → 팔레트 → 제품 ID로 리콜 범위를, 거꾸로 원인 셀 · 로트 · 시간대로 영향 범위를 찾아요.${u ? ` 예: ${eun(u.serial)} ${u.ship?.truck ?? '트럭'}에 실려 출하됐고, EPCIS 저장소에 발행 → 적재 → 팔레트 → 출하 이벤트가 남아 있어요.` : ' (아직 출하된 제품이 없어 조회 예시는 생략해요.)'} 시뮬레이터는 출하까지 기록하고, 판매 이후 A/S · 반품 데이터도 같은 ID로 이어 붙일 수 있는 구조예요.`; } },
    { chain: 7, cam: { view: 'all' }, panel: null, end: true, next: 'quality',
      say: '정리하면, 공장의 지금은 UNS에, 제품의 일생은 EPCIS에 남아요. FacOS는 둘을 같은 제품 ID와 같은 기준 시각으로 맞춰 둬요. 그래서 리콜 범위를 찾을 때 그 시각 그 셀에서 무슨 일이 있었는지 기록을 맞춰 볼 수 있어요. 이 데이터는 품질 원인 분석과 AI 학습, 고객 신뢰의 바탕이 돼요.' },
  ] },
  // 품질 관리: 예방 → 공정 내 전수 검사 → 출하 전 샘플 재검(검사·포장셀 최종 검사대 — js/serial.js sampleTick · judge) → 불량 대응 → AI 원인 분석 → 재발 방지(8D) → 모니터링
  //  · 2단계에서 조립셀 하나에 공정 편차를 일으켜(main.js toriQualityDrift) 실제 불량 사례가 생기게 하고, 4~6단계는 그 사례를 따라간다
  //  · 8D의 「정책 반영하시겠습니까?」는 사람이 결정하는 버튼이라 토리는 누르지 않고 보여 주기만 한다
  quality: { name: '품질 관리 — 예방부터 불량 대응 · 재발 방지까지', steps: [
    { qchain: -1, cam: { view: 'all' }, panel: null,
      say: '품질은 세 겹으로 지켜요. 문제가 생기기 전에 막는 예방, 모든 제품을 재는 공정 내 전수 검사, 검사·포장셀 최종 검사대의 출하 전 샘플 재검이에요. 그래도 불량이 나오면 봉쇄하고, AI가 원인을 찾고, 8D로 재발을 막아요. 현장과 화면으로 따라가 볼게요.' },
    { qchain: 0, cam: { station: 'EA_FAST', d: 13 }, panel: { kind: 'zd', tab: 'live' }, hl: ['#btnZoneDash'], live: true,
      voice: '첫째, 예방. 셀마다 설비 건강도와 공정 드리프트, 공정 능력 Cpk를 계속 지켜봐요. 건강도가 떨어지면 예지정비를, 드리프트가 쌓이면 재보정을 하고, 피지컬AI 단계에서는 순찰 로봇이 미세한 편차를 찾아 셀이 스스로 재보정해요. 온도와 습도, 진동 같은 환경 이상도 민감한 공정의 불량 위험으로 반영돼요.',
      say: (T) => { const C = qx.cells(T.h.sim?.()), s = T.h.sim?.(); const low = C.reduce((a, st) => { const cpk = s.assess?.(st)?.cpk ?? 0; return !a || cpk < a.cpk ? { st, cpk } : a; }, null);
        return `① 예방 — 셀마다 설비 건강도 · 공정 드리프트 · 공정 능력(Cpk)을 계속 지켜봐요. 건강도가 떨어지면 예지정비, 드리프트가 쌓이면 재보정, 피지컬AI 단계는 순찰 로봇이 미세 편차를 찾아 셀이 스스로 재보정해요.${C.length ? ` 지금 정밀조립 셀 ${C.length}곳 평균 건강도 ${Math.round(C.reduce((a, st) => a + st.health, 0) / C.length)}%${low ? `, Cpk 최저 ${low.cpk.toFixed(2)}(${low.st.name})` : ''}.` : ''} 환경 이상(온습도 · 진동)도 민감 공정 불량 위험에 반영돼요.`; } },
    { qchain: 1, act: (T) => { if (T.qInj === undefined) T.qInj = T.h.qualityDrift?.() ?? null; }, cam: (T) => ({ station: T.qInj?.id ?? 'DT_ASSY', d: 11 }), panel: { kind: 'trace', tab: 'ng' }, hl: ['#btnTrace'],
      voice: '둘째, 공정 내 전수 검사. 체결셀은 모든 제품의 체결 토크와 각도를 재서 판정하고, 부품분류셀은 비전으로 부품을 확인해요. 지금 시험으로 조립셀 하나에 공정 편차를 일으켰어요. 이 셀을 지난 제품은 체결셀 전수 검사에서 걸러질 거예요.',
      say: (T) => `② 공정 내 전수 검사 — 체결셀은 모든 제품의 체결 토크 · 각도를 재서 판정하고, 부품분류셀은 비전으로 부품을 확인해요. ${T.qInj ? `지금 시험으로 ${T.qInj.name}에 공정 편차(드리프트 60%)를 일으켰어요. 이 셀을 지난 제품은 체결셀 전수 검사에서 걸러질 거예요.` : '(이 라인에서는 편차 시연을 할 수 없어요.)'}` },
    { qchain: 2, cam: { station: 'PACK', d: 12 }, panel: { kind: 'trace', tab: 'hold' }, hl: ['#btnTrace'], live: true,
      voice: '셋째, 출하 전 샘플 재검. 검사 포장셀을 통과해 적재된 양품 가운데 정해진 개수마다 한 개를 샘플로 지정해, 최종 검사대에서 다시 검사해요. 샘플을 지정하는 순간 그 로트는 출하가 보류되고, 합격이면 풀리고 불합격이면 봉쇄돼요. 봉쇄된 제품은 선별 검사를 거쳐 재작업하거나 폐기하고, 8D로 이어져요.',
      say: (T) => { const l = qx.lot(T.h.sim?.()); return `③ 출하 전 샘플 재검 — 검사·포장셀 최종 검사대에서 적재 양품 ${SAMPLE_N}개마다 1개를 샘플로 지정해 다시 검사해요(체결 검사를 빠져나간 불량 · 외관 · 라벨 · 치수). 샘플을 지정하는 순간 그 로트는 출하 보류 → OK면 해제, NG면 봉쇄(로트 + 앞뒤 10분) · 선별 검사 · 재작업 · 폐기 처분 · 8D · 샘플링 강화(다음 3회는 절반 주기).${l ? ` 최근 로트 ${l.id}(${prodKo(l.product)} ${(l.members?.length ?? 0) + 1}개) — ${LOT_KO[l.status] ?? l.status}.` : ''}`; } },
    { qchain: 3, ready: (T) => !T.qInj || !!qx.caseAfter(T.h.sim?.(), T.qInj.t), cam: (T) => ({ station: T.qInj?.id === 'EA_ASSY' ? 'EA_FAST' : 'DT_FAST', d: 11 }),
      panel: (T) => { const c = qx.caseAfter(T.h.sim?.(), T.qInj?.t); return { kind: 'trace', tab: 'ng', caseId: c?.id }; }, hl: ['#btnTrace'], live: true,
      voice: '넷째, 불량 대응. 체결셀 전수 검사에서 불량이 나오면 그 제품을 격리하고 불량 사례가 열려요. 같은 시간대에 원인 후보 셀을 지난 다른 제품도 출하를 보류하고 다시 검사하도록 봉쇄해요. Zone 오케스트레이터와 총괄 오케스트레이터에는 품질 경보가 올라가요.',
      say: (T) => { const c = qx.caseAfter(T.h.sim?.(), T.qInj?.t); return c ? `④ 불량 대응 — ${c.detectedName}에서 ${c.serial} 불량 판정(NG). 사례 ${c.id}가 열리고, 같은 시간대에 원인 후보 셀을 지난 제품 ${c.suspects?.length ?? 0}개를 출하 보류 · 재검으로 봉쇄했어요. Zone · 총괄 오케스트레이터에 품질 경보(Quality Alert)가 올라가요.` : '④ 불량 대응 — 편차가 생긴 셀을 지난 제품이 체결셀 전수 검사에 닿기를 기다리는 중이에요…'; } },
    { qchain: 4, cam: (T) => { const c = qx.caseAfter(T.h.sim?.(), T.qInj?.t), st = c?.rca?.causes?.[0]?.station; return { station: st ?? T.qInj?.id ?? 'DT_ASSY', d: 10 }; },
      panel: (T) => { const c = qx.caseAfter(T.h.sim?.(), T.qInj?.t); return { kind: 'trace', tab: 'ng', caseId: c?.id }; }, hl: ['#btnTrace'],
      voice: '다섯째, AI 원인 분석. 불량 제품의 이력을 따라 지난 셀마다 그 순간의 불량 확률과 검사에서 나온 불량 유형을 맞춰 보고, 설비 열화, 공정 드리프트, 환경 요인으로 원인을 나눠요. 같은 셀, 같은 운반 AMR, 같은 원자재 로트의 불량률도 비교해요. 분석 데이터는 AI 학습용으로 내려받을 수 있어요.',
      say: (T) => { const s = T.h.sim?.(), c = qx.caseAfter(s, T.qInj?.t), top = c?.rca?.causes?.[0], S = s?.trace?.stats; const tot = c?.rca?.causes?.reduce((a, x) => a + x.score, 0) || 1;
        return `⑤ AI 원인 분석 — 불량 제품의 이력을 따라 지난 셀마다 그 순간 불량 확률과 검사 NG 유형을 맞춰 보고, 설비 열화 · 공정 드리프트 · 환경 요인으로 원인을 나눠요(같은 셀 · AMR · 원자재 로트 불량률도 비교).${top ? ` 이번 1순위는 「${top.label}」 ${Math.round((top.score / tot) * 100)}% — ${top.station === T.qInj?.id ? `실제로 편차를 일으킨 ${T.qInj.name}과 일치해요.` : `편차를 일으킨 곳은 ${T.qInj?.name ?? '-'}이에요.`}` : ''}${S?.cases ? ` 누적 1순위 적중 ${S.top1}/${S.cases}.` : ''}`; } },
    { qchain: 5, cam: { view: 'precision' }, panel: (T) => { const s = T.h.sim?.(), k = qx.capaOf(s, qx.caseAfter(s, T.qInj?.t)); return { kind: 'trace', tab: 'capa', capaId: k?.id }; }, hl: ['#btnTrace'], live: true,
      voice: '여섯째, 재발 방지. 8D로 처리해요. 격리, 팀 구성, 문제 기술, 임시 조치, 근본 원인, 대책 순서로 진행하고, 대책은 운영 정책 변경안으로 나와요. 정책 반영은 사람이 결정해요. 반영하면 일정 시간 불량률로 효과를 검증하고, FMEA를 갱신해 종결해요.',
      say: (T) => { const s = T.h.sim?.(), k = qx.capaOf(s, qx.caseAfter(s, T.qInj?.t)); return `⑥ 재발 방지 — 8D로 처리해요: D0 격리 → D1 팀 → D2 문제 기술 → D3 임시 조치(봉쇄 · 재보정) → D4 근본 원인(AI) → D5 대책(운영 정책 변경안) → 사람이 「정책 반영」 결정 → D6 효과 검증(반영 후 불량률) → D7 FMEA 갱신 → D8 종결.${k ? ` 지금 ${k.id}는 ${k.stage} 단계${k.status === 'approval' ? ` — 대책 「${k.proposal?.title ?? '정책 변경'}」의 반영 여부를 기다려요(결정은 사람이)` : ''}.` : ''}`; } },
    { qchain: 6, cam: { view: 'precision' }, panel: { kind: 'zd', tab: 'qa' }, hl: ['#btnZoneDash'],
      voice: '일곱째, 모니터링. Zone 대시보드의 관리도는 측정값의 평균과 산포를 그려, 규칙에 맞지 않는 움직임이 보이면 불량이 나기 전에 알려 줘요. 공정 변수와 품질의 상관, 불량 유형 파레토, OEE의 품질 손실도 함께 봐요.',
      say: '⑦ 모니터링 — Zone 대시보드의 관리도(X̄-R · I-MR)는 측정값의 평균과 산포를 그려, Western Electric 규칙에 어긋나는 움직임이 보이면 불량이 나기 전에 알려 줘요. 공정 변수 ↔ 품질 상관(산점도), NG 유형 파레토, OEE의 품질 손실도 함께 봐요.' },
    { qchain: 7, cam: { view: 'all' }, panel: null, end: true, next: 'kpi',
      say: '예방하고, 검사하고, 대응하고, 개선하는 고리가 계속 돌면서 품질이 좋아져요. 모든 품질 기록은 제품 ID로 이어져 있어서, 언제든 그 제품과 공정, 원인까지 거슬러 올라갈 수 있어요.' },
  ] },
  // 매뉴얼 · 앱 내려받기 — 사용자 가이드는 📘 버튼이 보일 때(docs/USER_GUIDE.pdf가 있을 때)만, 앱 내려받기는 ⬇ 버튼이 보일 때(웹 버전 + 릴리스 주소가 있을 때)만 안내한다 — 없는 버튼을 가리키지 않는다
  // 데이터 & 제어명령 파이프라인 — 앱 구현: AAS 서브모델 · TimeSeries(js/aas.js) · OPC UA PubSub JSON over MQTT · pcap(js/datahub.js · js/pcap.js) · 이음5G 특화망(js/net5g.js) · PTP 기준 시계(js/sensors.js)
  // TSN 스케줄(802.1Qbv) 자체는 시뮬레이션하지 않는다 — 기준 시계 동기 · 명령 전달 지연까지만 모사하므로 말풍선에 그렇게 밝힌다
  link: { name: '데이터 & 제어명령 파이프라인', steps: [
    { mode: 'dark', view: 'all', lchain: -1,
      voice: '현장 데이터가 서버까지 어떻게 가는지 따라가 볼게요. 설비와 로봇, 센서 값은 AAS 표준 시계열로 만들어지고, OPC UA 메시지로 바뀌어, 고정 설비는 TSN 유선망으로, 이동 로봇은 이음5G 특화망으로 공장 중앙 서버에 모여요. 거꾸로 오케스트레이터의 제어 명령은 UNS의 명령 토픽에서 출발해 같은 길을 따라 셀과 로봇으로 정해진 지연 안에 내려가요.',
      say: '현장 데이터가 서버까지 어떻게 가는지 따라가 볼게요. 설비 · 로봇 · 센서 값은 AAS 표준 시계열로 만들어지고 → OPC UA PubSub 메시지가 되어 → 고정 설비는 TSN 유선망, 이동 로봇은 이음5G 특화망을 타고 → 공장 중앙 서버에 같은 기준 시각으로 모여요. 거꾸로 오케스트레이터의 제어 명령은 UNS의 cmd 토픽에서 출발해 같은 OPC UA PubSub · TSN · 이음5G 길을 따라 셀과 로봇으로 정해진 지연 안에 내려가요. 실시간성과 정주기성을 지키는 것이 핵심이에요.' },
    { view: 'precision', hl: ['#btnSensors'], lchain: 0,
      voice: '먼저 현장입니다. 셀 설비의 상태와 사이클, 로봇의 관절과 손끝, 진동과 온도 같은 센서 값이 끊임없이 나와요. 셀 엣지가 이 값을 모으면서, 공장 기준 시계와 맞춘 시각을 하나하나 붙여요.',
      say: '① 현장 — 셀 설비의 상태 · 사이클 · 전력, 로봇의 관절 · 손끝 · 그리퍼, 진동 · 온도 같은 센서 값이 끊임없이 나와요. 셀 엣지가 이 값을 모으면서 공장 기준 시계(PTP)와 맞춘 시각을 하나하나 붙여요.' },
    { panel: { kind: 'data' }, hl: ['#btnData'], lchain: 1,
      voice: 'AAS는 설비와 로봇마다 붙는 디지털 명판이에요. 명판, 기술 사양, 현재 값, 시계열 서브모델로 나뉘고, 수집한 값은 시각과 함께 시계열 레코드로 쌓여요. 그래서 어느 시스템이든 같은 이름과 같은 단위로 데이터를 읽을 수 있어요.',
      say: '② AAS 시계열 — 설비 · 로봇마다 디지털 명판인 AAS(자산 관리 셸)가 있어요. 명판(Nameplate) · 기술 사양(TechnicalData) · 현재 값(OperationalData) · 시계열(TimeSeries, IDTA 02008) 서브모델로 나뉘고, 수집한 값은 시각과 함께 시계열 레코드로 쌓여요. 어느 시스템이든 같은 이름 · 같은 단위로 읽을 수 있어요.' },
    { panel: { kind: 'data' }, hl: ['#btnData'], lchain: 2,
      voice: '이 값을 OPC UA PubSub 메시지로 만들어, 정해진 주기마다 발행해요. 받는 쪽은 일일이 요청하지 않고 구독만 하면 실시간으로 받아요. 데이터 연동 창에서 실제 메시지와 패킷 기록을 볼 수 있어요.',
      say: '③ OPC UA PubSub — AAS로 정의한 값을 OPC UA PubSub(Part 14) 메시지로 만들어 정해진 주기마다 발행해요. 받는 쪽은 일일이 요청하지 않고 구독만 하면 실시간으로 받아요. 데이터 연동 창에서 실제 메시지와 패킷 덤프(pcap)를 볼 수 있어요.' },
    { panel: { kind: 'sensors' }, view: 'precision', hl: ['#btnSensors'], lchain: 3,
      voice: '셀 로봇과 설비처럼 자리를 지키는 장비는 TSN을 지원하는 유선망으로 보내요. 모든 스위치가 같은 시계를 쓰고, 중요한 메시지에는 정해진 시간 칸을 내줘서, 다른 데이터가 몰려도 정해진 주기와 지연 안에 도착해요. 오케스트레이터의 셀 명령도 이 길로 내려가요.',
      say: '④ TSN 유선망 — 셀 로봇 · 설비처럼 자리를 지키는 장비는 TSN(시간 민감형 네트워크)을 지원하는 유선 이더넷으로 보내요. 모든 스위치가 같은 시계(IEEE 802.1AS)를 쓰고, 중요한 메시지에 정해진 시간 칸(802.1Qbv)을 내줘서 다른 트래픽이 몰려도 정해진 주기 · 정해진 지연 안에 도착해요. 오케스트레이터의 셀 명령도 이 길(OPC UA PubSub/TSN)로 내려가요. (시뮬레이터는 기준 시계 동기와 명령 전달 지연까지 모사해요)' },
    { panel: { kind: 'net5g' }, view: 'all', hl: ['#btnNet5g'], lchain: 4,
      voice: '움직이는 로봇은 선을 꽂을 수 없어서 이음5G 특화망으로 보내요. 정해진 슬롯마다 보내 주기를 지키고, 지연은 10밀리초 안이에요. 기지국을 옮겨 가도 끊김과 유실이 없어요. 5G와 TSN을 연동하면 유선망과 같은 시계, 같은 주기로 이어져요. 바닥의 색은 신호 세기 지도예요.',
      say: '⑤ 이음5G 특화망 — AMR · 휴머노이드 · 사족보행 · 드론처럼 움직이는 로봇은 선을 꽂을 수 없어서 이음5G(n79 4.7GHz · 100MHz)로 보내요. 설정 그랜트로 정해진 슬롯마다 보내 주기를 지키고, 지연은 p99 10ms 안, 기지국을 옮겨 갈 때도 DAPS 핸드오버로 끊김 · 유실 없이 이어져요. 5G-TSN 연동(3GPP Rel-16)을 쓰면 유선 TSN과 같은 시계 · 같은 주기로 이어져요. 바닥의 색은 신호 세기(RSRP) 지도예요.' },
    // ⑥ UNS 브로커 — 한 브로커 안의 세 영역(설비 원천 OPC UA · Sparkplug B · ISA-95 공장 트리), 셀 설비 값이 공장 트리에 정리된 자리를 강조
    { panel: { kind: 'orch', tab: 'uns', uns: LINK_UNS.tele }, hl: ['#btnOrch'], lchain: 5, live: true,
      voice: '유선과 5G로 온 메시지는 공장 중앙의 MQTT 5 브로커, 바로 UNS로 모여요. 한 브로커 안에 영역이 나뉘어 있어요. 설비가 보낸 OPC UA 원천 메시지, 엣지 게이트웨이의 Sparkplug B 메시지, 그리고 이 값을 ISA-95 주소로 정리한 공장 트리예요. 한 토픽에 두 형식을 섞지 않아요. 노랗게 강조된 줄이 셀 설비 값이 공장 트리에 정리된 자리예요. 모든 값은 같은 기준 시각을 가지고 AAS 저장소와 센서 DB에도 쌓여요.',
      say: (T) => { const R = LINK_UNS.tele(T.h.sim?.()); return `⑥ UNS 브로커 — 유선 · 5G로 온 메시지는 공장 중앙의 MQTT 5 브로커(Mosquitto) = UNS로 모여요. 영역은 셋: opcua/json/… (설비 원천 OPC UA PubSub) · spBv1.0/… (엣지 게이트웨이 Sparkplug B, 앱) · camtic/metafactory/… (ISA-95 주소로 정리한 공장 트리). 한 토픽에 두 형식을 섞지 않아요.${R?.sel ? ` 강조된 줄: 셀 설비 요약 ${R.topics.length}개 — 예 ${R.short(R.sel)}.` : ''} 모두 같은 기준 시각(PTP)으로 AAS 저장소 · 센서 DB · 운영 데이터셋에도 쌓여 AI 학습 · 모니터링 · 디지털 트윈에 바로 쓰여요.`; } },
    // ⑦ FacOS — 설비에 직접 붙지 않고 UNS를 구독해 판단, 결과(상태 · 오더 · 결정)를 다시 UNS로
    { panel: { kind: 'orch', tab: 'uns', uns: LINK_UNS.facos }, hl: ['#btnOrch', '#facos'], lchain: 6, live: true,
      voice: 'FacOS는 설비에 직접 접속하지 않아요. UNS를 구독해서 공장 상태를 보고 판단하고, 그 결과인 공장 상태와 오더, 결정을 다시 UNS에 발행해요. 데이터는 설비가 만들고 브로커가 나르고, FacOS는 그 흐름의 규칙을 정하는 데이터 코디네이터예요.',
      say: (T) => { const R = LINK_UNS.facos(T.h.sim?.()); return `⑦ FacOS — 설비에 직접 접속하지 않고 UNS를 구독해 판단해요(opcua/json/# · aas/# · 공장 트리). 판단 결과는 다시 UNS로: _facos/state(공장 상태) · _facos/order(오더) · _facos/decision(결정)${R?.topics.length ? ` — 지금 강조 ${R.topics.length}개` : ''}. 데이터는 설비가 만들고 브로커가 나르고, FacOS는 주소 · 방향 · 권한 · 순서 · 기록을 정하는 데이터 코디네이터예요.`; } },
    // ⑧ 명령 하향 — {존}/{셀}/cmd → 엣지 게이트웨이 → TSN · 이음5G → 셀 · 로봇, 같은 Correlation ID로 ack · exec · done (게이트웨이 → OPC UA Method는 계획안)
    { panel: { kind: 'orch', tab: 'uns', uns: LINK_UNS.cmd }, hl: ['#btnOrch'], lchain: 7, live: true, end: true, next: 'docs',
      voice: '마지막은 거꾸로 가는 길, 제어 명령이에요. FacOS나 존 오케스트레이터가 셀 주소의 명령 토픽에 발행하면, 엣지 게이트웨이가 받아 TSN이나 이음5G로 셀과 로봇에 전달해요. 셀은 접수, 실행, 완료를 같은 Correlation ID로 다시 발행하고, 명령에는 만료 시간과 응답 토픽이 붙어요. 실제 장비에서는 게이트웨이가 이 명령을 OPC UA 메서드 호출로 바꿔 주는 구성을 계획하고 있어요.',
      say: (T) => { const R = LINK_UNS.cmd(T.h.sim?.()); return `⑧ 명령 하향 — FacOS · 존 오케스트레이터가 {존}/{셀}/cmd에 발행 → 엣지 게이트웨이 → TSN · 이음5G → 셀 · 로봇. 셀은 cmd/ack → cmd/exec → cmd/done을 같은 Correlation ID로 다시 발행하고, 접수(ack)만으로 끝으로 보지 않아요. MQTT 5 속성으로 만료(Message Expiry) · 응답 토픽(Response Topic)이 붙어요.${R?.E.length ? ` 최근 명령 토픽: ${R.E.slice(0, 3).map((e) => R.short(e.topic)).join(' · ')}.` : ' 이번 실행에는 아직 명령이 없어요 — 오케스트레이터 명령 콘솔에서 보내면 여기에 4단이 생겨요.'} (게이트웨이에서 OPC UA Method 호출로 바꾸는 부분은 실제 장비용 계획(안)이에요.)`; } },
  ] },
  docs: { name: '매뉴얼 · 앱 내려받기', next: 'outcome', steps: [
    // 매뉴얼 전에: Claude API 키를 넣으면 달라지는 것 (js/llm.js · js/agentcore.js · js/designer.js) — 키가 없어도 정책 기반 에이전트 · 내장 해석기로 공장은 그대로 돈다
    { hl: ['#btnSettings', '#engineSeg'],
      voice: '매뉴얼 전에 하나 알려 드릴게요. Claude API 키를 등록하면, 오른쪽 패널을 대화 기반으로 바꿔 Claude와 함께 공장을 운영할 수 있어요. 키가 없어도 정책 기반 에이전트와 내장 해석기로 공장은 그대로 돌아가요.',
      say: () => `매뉴얼 전에 — Claude API 키(sk-ant-…)를 등록하면 오른쪽 패널을 「대화 기반」으로 바꿔 Claude와 함께 공장을 운영할 수 있어요. 키가 없어도 정책 기반 에이전트 · 내장 해석기로 공장은 그대로 돌아가요. ${document.body.classList.contains('app') ? `⚙ 설정에서 넣은 키는 ${document.body.classList.contains('win') ? '이 PC에 암호화(DPAPI)' : '맥 키체인'}에만 보관되고 화면으로는 전달되지 않아요.` : !document.body.classList.contains('webkey') ? 'npm start로 실행했다면 서버를 켤 때 ANTHROPIC_API_KEY 환경변수로 키를 넣어요.' : '웹 버전은 ⚙ 설정에서 넣은 키를 이 브라우저에만 두고 Claude API를 직접 불러요. 공유 페이지는 키 없이 보는 분의 Claude 계정으로도 써요.'}` },
    { hl: ['#agentPanel', '#btnSettings'],
      voice: '키를 등록하면 특히 세 가지가 좋아져요. 첫째, 내장 해석기가 모르는 표현이나 여러 조건이 섞인 지시도 Claude가 공장 상태를 보고 해석해 실행해요. 둘째, 지금 정비요청이 뭐가 있는지, 5G에 이상이 없는지처럼 물으면 공장 데이터를 근거로 답해요. 셋째, 앱에서는 공정 설계 Agent가 말이나 공정도 파일로 라인을 설계해 줘요.',
      say: () => `키를 넣으면 효과적인 기능 — ① 자유로운 운영 지시: 내장 해석기가 모르는 표현 · 여러 조건이 섞인 지시(예: "병목 줄이고 재공은 낮춰 줘")를 Claude가 공장 상태를 보고 해석해 정비 예약 · 사이클 모드 · 투입 간격 · 투입 보류 · 셀 명령 · 혼류 비율 · Zone 명령 · 긴급 조달로 실행 ② 상황 질문: "진행 중인 정비요청은?" "5G 이상 있어?"처럼 물으면 설비 상태 · CCTV 이벤트 · 5G · 배터리 · FAC 기록을 근거로 답 ③ 공정 설계 Agent: 말이나 📎 공정도 · 레이아웃 파일로 라인 설계${document.body.classList.contains('app') ? '' : document.body.classList.contains('webkey') ? ' (앱 · npm start에서)' : ''}. Claude가 생각하는 동안은 시뮬레이션이 잠시 멈춰요.` },
    { when: () => shown('btnGuide'), voice: '책 모양의 사용자 가이드 버튼을 누르면 사용자 가이드 PDF를 내려받아요. 설치부터 화면 구성, 운영 시나리오 실습, 데이터 내보내기, 문제 해결까지 담겨 있어요.', say: '📘 버튼을 누르면 사용자 가이드(PDF)를 내려받아요. 설치부터 화면 구성, 운영 시나리오 실습, 데이터 내보내기, 문제 해결까지 담겨 있어요.', hl: ['#btnGuide'] },
    { when: () => isWeb(), voice: '앱 내려받기 버튼에서는 맥과 윈도우 앱을 내려받을 수 있어요. 맥은 애플 실리콘, 윈도우는 64비트 10과 11이에요. 앱에서는 서버 저장, MQTT 발행, MP4 녹화, 자연어 공정 설계 Agent까지 전체 기능을 내 컴퓨터에서 써요.', say: '⬇ 버튼에서는 맥(Apple Silicon)과 윈도우(64비트 10 · 11) 앱을 내려받을 수 있어요. 앱에서는 서버 저장 · MQTT 발행 · MP4 녹화 · 자연어 공정 설계 Agent까지 전체 기능을 내 컴퓨터에서 써요.', hl: ['#btnApps'] },
    { when: () => isWeb(), say: '맥은 압축을 풀어 응용 프로그램 폴더로 옮기고 처음 한 번 우클릭 → 열기, 윈도우는 폴더째 풀고 폴더 안의 실행 파일을 실행해 「PC 보호」 창이 뜨면 추가 정보 → 실행을 누르면 돼요. 그러면 지금 이 화면을 내 컴퓨터에서 그대로 확인할 수 있어요.', hl: ['#btnApps'] },
    { when: () => document.body.classList.contains('app'), say: '지금 쓰시는 앱은 서버 저장 · MQTT 발행 · 녹화 · 공정 설계 Agent가 모두 이 컴퓨터에서 동작해요. 데이터는 앱 데이터 폴더에 쌓이고, ⚙ 설정에서 Claude API 키를 넣으면 대화 기반 Agent도 쓸 수 있어요.', hl: ['#btnSettings'] },
  ] },
  // 활용 및 기대 — 모든 주제의 끝 (맺음말이 끝나면 5초 뒤 둘러보기부터 다시 — LOOP_MS). 메타팩토리 관점의 활용(실증장 · 데이터 공장 · 교육장) → 기대(수치 약속 없이) → 맺음말
  outcome: { name: '활용 및 기대', steps: [
    { mode: 'dark', view: 'all', hl: ['#btnCompare', '#btnVla', '#btnAios', '#btnFault'], ochain: 0,
      say: '활용 — 메타팩토리는 세 가지로 쓰여요. 기업이 설비 · 로봇을 들이기 전에 같은 라인을 레거시 · 자동화 · 피지컬AI로 돌려 보고 결정하는 실증장, 로봇 · 운영 데이터를 쌓아 AI를 학습시키는 데이터 공장, 운영자와 엔지니어가 고장 · 현장 이벤트 대응을 안전하게 훈련하는 교육장이에요. AAS · OPC UA · EPCIS 같은 표준으로 만들어, 여기서 검증한 방식을 실제 공장으로 그대로 옮길 수 있어요.' },
    { view: 'precision', hl: ['#btnImpact', '#btnTrace', '#btnCctv'], ochain: 1,
      say: '기대 — 고장과 이상에 AI가 스스로 대응해 멈추는 시간이 줄고, 제품 ID로 품질을 끝까지 추적해 불량 재발을 막아요. 위험하고 반복되는 일은 로봇이 맡아 사람은 더 안전하게 판단과 개선에 집중하고, 도입 위험이 줄어 더 많은 제조 현장이 피지컬AI 자율공장으로 나아갈 수 있어요.' },
    { view: 'all', end: true, ochain: 2,
      say: '끝으로, 우리가 만들어 갈 미래의 공장을 이야기해 볼게요. 피지컬AI 실증 메타팩토리의 목표는, 레거시 공장이 자동화를 거쳐 AI가 보고 판단하고 로봇이 직접 해결하는 자율공장으로 가는 길을 디지털 트윈에서 먼저 실증하고, 그 성과를 실제 제조 현장으로 넓히는 거예요. 멈추지 않는 공장, 스스로 좋아지는 공장, 사람이 더 안전하고 가치 있게 일하는 공장 — 모두의 AI 팩토리, 함께 만들어 가요. 지금까지 공장장 토리였습니다. 감사합니다!' },
  ] },
};
// 녹음이 없는 문장(실시간 수치 등)만 OS 음성으로 읽는다 — 토리는 남성 목소리라 남성 한국어 음성이 있을 때만 (Edge InJoon · Hyunsu 등)
// 맥 유나 · 윈도우 Heami 같은 여성 음성밖에 없으면 목소리가 바뀌지 않게 소리 없이 말풍선만 보여 준다 (맥의 Eddy · Reed · Rocko 같은 다국어 공용 음성은 외국인 억양이라 쓰지 않는다)
const MALE_KO = [/injoon/i, /hyunsu/i, /bongjin/i, /gookmin/i];
export const koVoice = (all) => { const ko = all.filter((v) => /^ko/i.test(v.lang)); for (const re of MALE_KO) { const v = ko.find((x) => re.test(x.name)); if (v) return v; } return null; };
// 영어 안내: 주제별 같은 번호 단계에 en(say · voice)을 붙인다 — 단계 수가 다르면 그 주제는 한국어로 (tests/toriEn.mjs)
for (const [k, T] of Object.entries(TOPICS)) { const E = EN[k]; T.en = E?.name; if (E?.steps?.length === T.steps.length) T.steps.forEach((st, i) => { st.en = E.steps[i]; }); else if (E) console.warn(`[토리] 영어 안내 단계 수 다름: ${k}`); }
// 데이터 폐루프와 플라이휠은 하나의 주제로 이어서 설명한다 (폐루프 마지막 단계가 플라이휠로 넘어가는 다리)
TOPICS.data = { name: '데이터 폐루프와 플라이휠', en: EN.data.name, steps: [...TOPICS.loop.steps.map((st) => ({ ...st, end: false, next: undefined })), ...TOPICS.fly.steps] };
delete TOPICS.loop; delete TOPICS.fly;
const shown = (id) => { const b = document.getElementById(id); return !!b && !b.hidden; };   // 그 버튼이 화면에 있는지 (주소 · 파일이 없으면 숨겨져 있다)
const isWeb = () => shown('btnApps');
const prioOf = (ev) => ({ intrusion: 1, smoke: 1 })[ev.type] ?? 2;   // js/sim.js FIELD_EVENTS prio
const sec = (s) => `${Math.max(0, s).toFixed(1)}초`;   // 시뮬레이션 시간
// 받침에 맞는 조사: 끝 글자가 한글이면 받침, 숫자면 읽는 소리(일 · 삼 · 육 · 칠 · 팔 · 영 → 받침), 영문 L · M · N · R은 받침으로 본다
const final = (w) => { const c = String(w).trim().slice(-1); if (/[가-힣]/.test(c)) return (c.charCodeAt(0) - 0xac00) % 28 > 0; if (/\d/.test(c)) return '013678'.includes(c); return /[lmnr]/i.test(c); };
const ga = (w) => `${w}${final(w) ? '이' : '가'}`, eun = (w) => `${w}${final(w) ? '은' : '는'}`, ieyo = (w) => `${w}${final(w) ? '이에요' : '예요'}`;

// 고리 그림 (SVG): 단계를 원 위에 놓고 화살표로 잇는다 · at = 지금 단계(-1 = 전체 소개, 마지막+1 = 한 바퀴 완성)
function ringSvg(key, at, en) {
  const L = (en ? EN_RINGS : RINGS)[key], n = L.length, W = 336, H = 150, cx = W / 2, cy = 74, rx = 128, ry = 50, all = at < 0 || at >= n;
  const pos = L.map((_, k) => { const a = -Math.PI / 2 + (k / n) * Math.PI * 2; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
  const half = L.map((t) => textW(t) / 2 + 11);   // 칸 반폭 (글자 폭)
  // 화살표는 칸 가장자리에서 시작해 다음 칸 가장자리에서 끝난다 (글자를 가로지르지 않게)
  const edge = ([x, y], [tx, ty], hw) => { const dx = tx - x, dy = ty - y, f = Math.min((hw + 4) / Math.max(1e-6, Math.abs(dx)), 15 / Math.max(1e-6, Math.abs(dy)), 0.45); return [x + dx * f, y + dy * f]; };
  const arcs = pos.map((p1, k) => { const p2 = pos[(k + 1) % n], [x1, y1] = edge(p1, p2, half[k]), [x2, y2] = edge(p2, p1, half[(k + 1) % n] + 3), mx = (x1 + x2) / 2, my = (y1 + y2) / 2, ox = (mx - cx) * 0.15, oy = (my - cy) * 0.15;
    const on = all || k === at; return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${(mx + ox).toFixed(1)} ${(my + oy).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" class="tr-a${on ? ' on' : ''}" marker-end="url(#tr-h${on ? '1' : '0'})"/>`; }).join('');
  const nodes = pos.map(([x, y], k) => { const on = all || k === at, w = half[k] * 2;
    return `<g class="tr-n${on ? ' on' : ''}${k === at ? ' cur' : ''}"><rect x="${x - w / 2}" y="${y - 11}" width="${w}" height="22" rx="11"/><text x="${x}" y="${y + 4}" text-anchor="middle">${L[k]}</text></g>`; }).join('');
  const mid = en ? EN_UI.ring[key] : key === 'loop' ? '데이터 폐루프' : '플라이휠';
  return `<svg class="tori-ring" viewBox="0 0 ${W} ${H}" role="img" aria-label="${mid}: ${L.join(' → ')} → ${L[0]}"><defs>${[0, 1].map((o) => `<marker id="tr-h${o}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="tr-h${o ? ' on' : ''}"/></marker>`).join('')}</defs>${arcs}${nodes}<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="tr-c">↻ ${mid}</text></svg>`;
}

// ── 녹음 음성 (assets/tori/voice/<해시>.mp3 · tools/tori-voice.mjs로 만듦) ─────────────────
// 문장(읽을 글)마다 해시로 파일을 찾는다 — 문장을 고치면 해시가 바뀌어 새로 만들어야 함(없으면 OS 음성)
export const MENU_SAY = '모두의 AI 팩토리 공장장 토리입니다. 무엇을 안내해 드릴까요?';
// 읽을 글: 말풍선 글자는 그대로 두고 소리만 고친다 — 약어 발음 · 붙은 낱말 띄우기 · 쉼(—는 마침표, 괄호 속 약어는 읽지 않음)
const PRON = [[/Correlation\s*ID/gi, '코릴레이션 아이디'], [/피지컬\s*AI/g, '피지컬 에이아이'], [/Fac\s?OS/gi, '팩오에스'], [/AIOS/g, '에이아이오에스'], [/AI-ready/g, '에이아이 레디'], [/(?<![A-Za-z])AI(?![A-Za-z])/g, '에이아이'],
  [/VLA/g, '브이엘에이'], [/Outbox/gi, '아웃박스'], [/(?<![A-Za-z])FAC(?![A-Za-z])/g, '팩'], [/AMMR/g, '에이엠엠알'], [/(?<![A-Za-z])AMR(?![A-Za-z])/g, '에이엠알'], [/(?<![A-Za-z])SW(?![A-Za-z])/g, '소프트웨어'],
  [/ERPNext/g, '이알피넥스트'], [/SSCC/g, '에스에스씨씨'], [/EPCIS/g, '이피씨아이에스'], [/FMEA/g, '에프엠이에이'], [/(?<![A-Za-z])UPH(?![A-Za-z])/g, '유피에이치'], [/(?<![A-Za-z])AAS(?![A-Za-z])/g, '에이에이에스'],
  [/(?<![A-Za-z])3D(?![A-Za-z])/g, '쓰리디'], [/(?<![A-Za-z])8D(?![A-Za-z])/g, '에잇디'], [/이음5G/g, '이음 파이브지'], [/(?<![A-Za-z])5G(?![A-Za-z])/g, '파이브지'], [/A\/S/g, '에이에스'], [/e-axle/g, '이액슬'], [/Zone/g, '존'], [/R&D/g, '알앤디'], [/\s*&\s*/g, '와 '], [/토리(예요|입니다|였습니다)/g, (_, e) => `토리 ${e === '예요' ? '이에요' : e}`], [/제어명령/g, '제어 명령'],
  [/OPC UA/g, '오피씨 유에이'], [/PubSub/g, '펍섭'], [/(?<![A-Za-z])TSN(?![A-Za-z])/g, '티에스엔'], [/MQTT/g, '엠큐티티'], [/(?<![A-Za-z])UNS(?![A-Za-z])/g, '유엔에스'], [/ISA-95/g, '아이에스에이 구십오'], [/Sparkplug/g, '스파크플러그'], [/(?<![A-Za-z])PTP(?![A-Za-z])/g, '피티피'], [/(?<![A-Za-z])DB(?![A-Za-z])/g, '디비'],
  [/Factory OS/g, '팩토리 오에스'], [/Claude/g, '클로드'], [/Agent/g, '에이전트'], [/(?<![A-Za-z])ID(?![A-Za-z0-9])/g, '아이디'], [/(?<![A-Za-z])OEE(?![A-Za-z0-9])/g, '오이이'], [/(?<![A-Za-z])KPI(?![A-Za-z0-9])/g, '케이피아이'], [/(?<![A-Za-z])CCTV(?![A-Za-z0-9])/g, '씨씨티비'], [/(?<![A-Za-z])OCS(?![A-Za-z0-9])/g, '오씨에스'], [/(?<![A-Za-z])QR(?![A-Za-z0-9])/g, '큐알'], [/(?<![A-Za-z])API(?![A-Za-z0-9])/g, '에이피아이'], [/(?<![A-Za-z])PLC(?![A-Za-z0-9])/g, '피엘씨'], [/(?<![A-Za-z])CT(?![A-Za-z0-9])/g, '씨티'], [/(?<![A-Za-z])AGV(?![A-Za-z0-9])/g, '에이지브이'], [/(?<![A-Za-z])GS1(?![A-Za-z0-9])/g, '지에스원'], [/(?<![A-Za-z])Cpk(?![A-Za-z0-9])/g, '씨피케이'], [/(?<![A-Za-z])PDF(?![A-Za-z0-9])/g, '피디에프'], [/(?<![A-Za-z])MP4(?![A-Za-z0-9])/g, '엠피포'], [/(?<![A-Za-z])PC(?![A-Za-z0-9])/g, '피씨'], [/(?<![A-Za-z])RMS(?![A-Za-z0-9])/g, '알엠에스'], [/(?<![A-Za-z])FFT(?![A-Za-z0-9])/g, '에프에프티'], [/(?<![A-Za-z])ERP(?![A-Za-z0-9])/g, '이알피'], [/(?<![A-Za-z])MES(?![A-Za-z0-9])/g, '엠이에스']];
const SPACE = [[/메타팩토리/g, '메타 팩토리'], [/성과활용/g, '성과 활용'], [/자율공장/g, '자율 공장'], [/디지털트윈/g, '디지털 트윈'], [/정비요청/g, '정비 요청'], [/구매오더/g, '구매 오더'], [/작업지시/g, '작업 지시'], [/예지정비/g, '예지 정비'],
  [/부품분류/g, '부품 분류'], [/외관검사/g, '외관 검사'], [/([가-힣])셀(?![가-힣])/g, '$1 셀'], [/([가-힣])셀(?=[이은을에의과로도마])/g, '$1 셀']];
const ro = (w) => { const c = w.charCodeAt(w.length - 1) - 0xac00, j = c % 28; return c < 0 || c > 11171 || j === 0 || j === 8 ? '로' : '으로'; };   // 받침 없거나 ㄹ이면 「로」
// 영어 읽을 글: 기호만 쉼으로 · 이름은 철자대로 읽게 띄운다
const PRON_EN = [[/Fac\s?OS|FacOS/g, 'Fac O S'], [/(?<![A-Za-z])UNS(?![A-Za-z])/g, 'U N S'], [/ISA-95/g, 'I S A 95'], [/AIOS/g, 'A I O S'], [/AMMRs?/g, (w) => `A M M R${w.endsWith('s') ? 's' : ''}`], [/(?<![A-Za-z])FAC(?![A-Za-z])/g, 'F A C'], [/Cpk/g, 'C P K'], [/PubSub/g, 'Pub Sub'],
  [/Meta-Factory/g, 'Meta Factory'], [/e-Um 5G/g, 'e-Um five G'], [/(?<![A-Za-z])NG(?![A-Za-z])/g, 'N G'], [/(?<![A-Za-z])P([123])(?![0-9])/g, 'P $1'], [/\bvs\b/g, 'versus'], [/(\d)×/g, '$1 times'], [/×/g, ' by ']];
const speakEn = (t) => {
  let s = String(t).replace(/[①②③④⑤⑥⑦]/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, (c) => (c === '→' ? c : ''))
    .replace(/\s*\([^)]*\)/g, '').replace(/\s+—\s+/g, '. ').replace(/—/g, ', ').replace(/\s*→\s*/g, ', ').replace(/\s*·\s*/g, ', ');
  for (const [re, w] of PRON_EN) s = s.replace(re, w);
  return s.replace(/\s*,\s*(,\s*)+/g, ', ').replace(/\.\s*,/g, '.').replace(/\s+/g, ' ').trim();
};
export const speakText = (t, lang = 'ko') => {
  if (lang === 'en') return speakEn(t);
  let s = String(t).replace(/[①②③④⑤⑥]/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, (c) => (c === '→' ? c : ''))
    .replace(/\s*\([^)]*\)/g, '')   // 괄호 속 보충(약어 · 예시)은 소리로 읽지 않는다
    .replace(/(^|[.!?]\s+)([가-힣]+(?: [가-힣]+)?) → ([가-힣]+(?: [가-힣]+)?) — /g, (_, p, a, b) => `${p}${a}에서 ${b}${ro(b)}. `)   // 「운영 → 데이터 —」 → 「운영에서 데이터로.」
    .replace(/\s+—\s+/g, '. ').replace(/—/g, ', ').replace(/\s*→\s*/g, ', ').replace(/\s*·\s*/g, ', ')
    .replace(/([가-힣])([A-Za-z])/g, '$1 $2');   // 「정밀조립Zone」처럼 한글에 붙은 영문은 띄워 읽는다
  for (const [re, w] of [...PRON, ...SPACE]) s = s.replace(re, w);
  return s.replace(/\s*,\s*(,\s*)+/g, ', ').replace(/\.\s*,/g, '.').replace(/\s+/g, ' ').trim();
};
export const voiceKey = (t, lang = 'ko') => { let h = 0x811c9dc5; for (const c of speakText(t, lang)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
// 녹음할 문장 전체: 고정 문장은 말풍선 그대로, 실시간 수치가 들어가는 단계는 voice(수치 없는 읽을 글)
export function narration(lang = 'ko') { const en = lang === 'en', U = en ? EN_UI : KO_UI; return [en ? EN_UI.menu : MENU_SAY, U.wait, U.timeout, U.stopped,   // 기다림 · 시간 초과 · 멈춤 안내도 녹음 (OS 음성으로 넘어가면 목소리가 바뀜)
  ...Object.values(TOPICS).flatMap((T) => T.steps.map((s) => (en ? s.en : s)).filter(Boolean).flatMap((s) => [...(s.voice && typeof s.voice === 'object' ? Object.values(s.voice) : [s.voice ?? (typeof s.say === 'string' ? s.say : null)]), s.wait, s.timeout, s.vno]).filter(Boolean))]; }   // 상황별 음성(voice: { 종류: 문장 } · vk가 고름)은 모두 녹음
const VOICE_DIR = new URL('../assets/tori/voice/', import.meta.url).href, voiceDir = (lang) => (lang === 'en' ? `${VOICE_DIR}en/` : VOICE_DIR);   // 영어 녹음은 voice/en/
const AUTO_MS = 1000, LOOP_MS = 5000, READY_MAX_MS = 90000, PANEL_MS = 3000, VOICE_START_MS = 5000;   // 현장을 보여 준 뒤 창을 열기까지 · OS 음성이 이 안에 시작하지 않으면 읽는 시간으로
const readyMax = () => globalThis.__toriReadyMax ?? READY_MAX_MS, panelMs = () => (globalThis.__toriFast ? 300 : PANEL_MS), voiceStartMs = () => (globalThis.__toriFast ? 400 : VOICE_START_MS);   // 시험 훅: 기다리는 한도 · 창 여는 시간 · 음성 시작 한도를 줄인다
const readMs = (t, lang) => (globalThis.__toriFast ? 200 : 1500 + speakText(t, lang).length * (lang === 'en' ? 65 : 150));   // 소리 없이 읽는 시간 (한글 초당 약 7자 · 영문 약 15자) · __toriFast: 화면 점검(smoke)에서 읽는 시간을 건너뛰는 시험 훅

const H = { incUns, UNS_CMD, unsSel, qSample, LINK_UNS, fos, fosOrder, clock, adv, lossTop, inc, arrived, escortGap, byRobot, sevK, ex, qx, prioOf, RADIUS };   // 영어 안내(js/tori-en.js)가 쓰는 공장 상태 도우미
const KO_UI = { bubble: '토리 안내', name: '토리', voice: '음성으로 읽기', close: '접기', avatar: '토리 — 눌러서 안내 주제 고르기', gpu: '토리를 그리는 방식',
  prev: '◀ 이전', next: '다음 ▶', topics: '주제', finish: '마치기', later: '다음에', start: '둘러보기 시작 ▶', lang: 'English guide', langBtn: 'EN',
  // 안내 문장 (녹음함 — narration()): 준비 전 「다음」 · 대기 시간 초과 · 공장이 새로 시작됨
  wait: '아직 준비되지 않았어요 — 준비되면 바로 넘어갈게요.', timeout: '기다리던 일이 대기 시간 안에 일어나지 않았어요. 이 예시는 여기서 멈추고 다음 주제로 넘어갈게요 — 「다시 기다리기」를 누르면 더 기다려요.', retry: '다시 기다리기 ↻',
  stopped: '공장이 새로 시작돼서 하던 안내를 멈췄어요. 이어서 볼 주제를 골라 주세요.' };
// 공장(시뮬레이션)을 보는 단계인지 — 아니면 공장이 새로 시작돼도 예약된 것이 옛 공장을 가리키지 않는다
const simBound = (s) => !!(s.act || s.live || s.hold || s.ready || s.follow || s.camF || s.panel || s.net || typeof s.cam === 'function' || typeof s.say === 'function');
const CTX = ['ev', 'qInj', 'guard', 'netOff', 'flushed', 'prop', 'applied', 'bot', 'exWip', 'exSer', 'exPal', 'exShip'];   // 단계 동작이 공장에서 얻어 둔 것 (그 실행에서만 유효)
const CHAINS = { chain: CHAIN, qchain: QCHAIN, fchain: FCHAIN, kchain: KCHAIN, lchain: LCHAIN, ochain: OCHAIN }, CHAIN_EN = { chain: 'CHAIN', qchain: 'QCHAIN', fchain: 'FCHAIN', kchain: 'KCHAIN', lchain: 'LCHAIN', ochain: 'OCHAIN' };
const EN_VOICE = [/andrew/i, /\bguy\b/i, /christopher/i, /daniel/i, /aaron/i, /\balex\b/i, /\bfred\b/i, /\btom\b/i, /\bevan\b/i, /nathan/i, /google uk english male/i];   // 남성 음성만 — 없으면 소리 없이
export const enVoice = (all) => { const en = all.filter((v) => /^en/i.test(v.lang)); for (const re of EN_VOICE) { const v = en.find((x) => re.test(x.name)); if (v) return v; } return null; };

export class Tori {
  // hooks: flyTo(viewKey) · setMode(modeKey) · mode() 지금 단계
  constructor(hooks) {
    this.h = hooks; this.topic = 'tour'; this.step = -1; this.open = false; this.talkT = 0; this.voice = store.get(VOICE) !== '0';   // 음성은 기본으로 켬 (🔊로 끄면 기억)
    this.lang = store.get(LANG) === 'en' ? 'en' : 'ko';   // 안내 언어 — 기본 한국어 (EN 버튼으로 바꾸면 기억)
    this.run = 0; this.gen = 0;   // run: 공장 실행 번호(simChanged) · gen: 단계 세대 — 예약된 창 · 멈춤 · 추적 · 실시간 글 콜백은 자기 세대가 아니면 아무것도 하지 않는다
    this.el = document.createElement('div'); this.el.id = 'tori'; this.el.className = 'tori mini';
    this.el.innerHTML = `<div class="tori-bubble" role="dialog" aria-live="polite" aria-label="토리 안내">
        <div class="tori-h"><b>토리</b><span class="tori-n"></span><span class="tori-gpu" title="토리를 그리는 방식"></span>
          <button type="button" data-t="lang" class="tori-lang"></button><button type="button" data-t="voice" title="음성으로 읽기">🔊</button><button type="button" data-t="close" title="접기">✕</button></div>
        <div class="tori-fig"></div>
        <p class="tori-say"></p>
        <div class="tori-btns"></div>
      </div><canvas class="tori-cv" width="300" height="300" title="토리 — 눌러서 안내 주제 고르기"></canvas>`;
    document.body.appendChild(this.el);
    this.cv = this.el.querySelector('.tori-cv'); this.sayEl = this.el.querySelector('.tori-say'); this.nEl = this.el.querySelector('.tori-n');
    this.figEl = this.el.querySelector('.tori-fig'); this.btnEl = this.el.querySelector('.tori-btns');
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]'), t = b?.dataset.t;
      if (t === 'next') { if (this.timedOut) this.retry(); else this.advance(); }
      else if (t === 'prev') this.go(this.step - 1);
      else if (t === 'topic') this.play(b.dataset.k);
      else if (t === 'menu') this.menu();
      else if (t === 'close' || t === 'skip') this.close();
      else if (t === 'lang') this.setLang(this.lang === 'en' ? 'ko' : 'en');
      else if (t === 'voice') { this.voice = !this.voice; store.set(VOICE, this.voice ? '1' : '0'); this.syncVoice(); const s = this.cur();
        if (s && this.timedOut) this.timeout(s);   // 시간 초과 안내 중이면 그 안내를 다시 (보통 자동 넘김으로 되돌리지 않는다)
        else { if (this.voice) this.speak(this.spokenText ?? this.sayEl.textContent); else this.stopVoice(); if (s) this.scheduleAuto(s, this.step === this.steps().length - 1); } }
      else if (e.target === this.cv && !this.open) this.menu();
    });
    this.syncVoice(); this.syncLang();
    this.recorded = {};   // 언어별 녹음된 문장 목록
    this.recLoad = {};   // 목록을 읽는 중 — 다 읽기 전에 말하면 녹음이 없는 줄 알고 OS 음성으로 넘어가므로 speak가 기다린다
    for (const L of ['ko', 'en']) this.recLoad[L] = Promise.resolve().then(() => fetch(`${voiceDir(L)}index.json`)).then((r) => (r.ok ? r.json() : [])).then((k) => { this.recorded[L] ??= new Set(k); }).catch(() => { this.recorded[L] ??= new Set(); });
    this.initGfx().catch((e) => console.warn('[토리] 그리기 시작 실패', e));
  }
  // ── 언어 ─────────────────
  get ui() { return this.lang === 'en' ? EN_UI : KO_UI; }
  tname(k) { const T = TOPICS[k]; return (this.lang === 'en' && T.en) || T.name; }
  tx(s) { return (this.lang === 'en' && s.en) || s; }   // 그 단계의 말풍선 · 녹음 문장 (영어가 없으면 한국어)
  syncLang() {
    const u = this.ui, q = (sel) => this.el.querySelector(sel);
    q('[data-t="lang"]').textContent = u.langBtn; q('[data-t="lang"]').title = u.lang; q('[data-t="voice"]').title = u.voice; q('[data-t="close"]').title = u.close;
    q('.tori-h b').textContent = u.name; q('.tori-bubble').setAttribute('aria-label', u.bubble); this.cv.title = u.avatar; q('.tori-gpu').title = u.gpu; this.el.lang = this.lang;
    this.skin();   // 아바타 그림도 언어에 맞춘다 (한국어 manager.png · 영어 manager-en.png)
  }
  skin() { const t = this.texs?.[this.lang]; if (t && this.fig && this.fig.material.map !== t) { this.fig.material.map = t; this.fig.material.needsUpdate = true; } }
  setLang(L) {   // 지금 보던 단계(또는 메뉴)를 새 언어로 다시 말한다 — 단계 동작 · 카메라는 그대로
    this.lang = L; store.set(LANG, L); this.syncLang();
    if (!this.open) return;
    if (this.step < 0) this.menu(this.menuNote); else { const s = this.cur(); if (s && this.timedOut) { this.paint(s, this.step, true); this.timeout(s); } else if (s) { this.paint(s, this.step); this.scheduleAuto(s, this.step === this.steps().length - 1); } }
  }
  syncVoice() { const b = this.el.querySelector('[data-t="voice"]'); b.classList.toggle('on', this.voice); b.hidden = !('speechSynthesis' in window); }
  // 주제 마지막 단계의 다음 주제: 단계에 적힌 next, 없으면 주제에 적힌 next (매뉴얼처럼 환경마다 마지막 단계가 다른 주제)
  nextTopic(s) { const S = this.steps(), last = s.end || s === S[S.length - 1]; return last ? (s.next ?? TOPICS[this.topic].next ?? null) : null; }
  steps() { return (this.list ??= TOPICS[this.topic].steps.filter((st) => !st.when || st.when(this))); }   // 환경에 맞는 단계만 (웹 · 앱)
  cur() { return this.step >= 0 ? this.steps()[this.step] : null; }

  // 처음 접속이면 인사부터 (한 번만)
  greetIfFirst() { if (!store.get(SEEN)) setTimeout(() => this.play('tour'), 1200); }

  // 주제 메뉴 (작은 토리를 누르면)
  menu(note) {   // note: 안내를 멈춘 까닭 (공장이 새로 시작됨 — ui 문장 키) · 언어를 바꿔도 그 문장으로
    this.unhold(); this.restoreSpeed(); this.stopTimers(); if (this.panelOpen) { this.h.closePanels?.(); this.panelOpen = false; } this.panelSrc = null; this.cancelAuto(); this.clearHl(); this.reveal([]); this.step = -1; this.open = true; this.el.classList.remove('mini');
    this.nEl.textContent = ''; this.figEl.innerHTML = ''; this.noteK = null; this.timedOut = false; this.menuNote = note ?? null;
    this.say(note ? this.ui[note] : this.lang === 'en' ? EN_UI.menu : MENU_SAY);
    this.btnEl.innerHTML = ['tour', 'facos', 'incident', 'trace', 'quality', 'kpi', 'data', 'link', 'docs', 'outcome'].map((k) => `<button type="button" data-t="topic" data-k="${k}">${this.tname(k)}</button>`).join('');
    this.btnEl.classList.add('menu');
  }
  play(topic) { this.unhold(); this.restoreSpeed(); this.stopTimers(); this.h.closePanels?.(); this.panelOpen = false; this.panelSrc = null;   // 새 주제는 깨끗한 화면에서 — 앞 주제가 띄운 창(오케스트레이터 · FacOS · KPI · 로봇 정보 · 5G 지도 …)을 닫고 시작
    this.topic = topic; this.list = null; this.dropCtx(); this.modeAt = this.h.mode?.(); this.needMode = null; this.step = -1; this.go(0); }   // step = -1: 앞 주제에서 자동으로 넘어와도 첫 단계 동작(act — 인시던트 1배속 · KPI 30배속)을 실행한다 (go는 뒤로 갈 때 act를 건너뛴다)
  stopTimers() { this.gen++; clearInterval(this.liveT); clearInterval(this.followT); clearInterval(this.holdT); clearTimeout(this.panelT); }   // 예약된 단계 콜백 무효 (세대를 올려 이미 불린 것도 막는다)
  dropCtx() { for (const k of CTX) this[k] = undefined; this.camAt = null; this.fast = false; this.noteK = null; this.timedOut = false; }   // 공장에서 얻어 둔 것을 버린다 (공장에는 손대지 않음)
  // 공장이 새로 시작됨 (main.js start() — 단계 · 라인 · 리셋). 옛 공장의 이벤트 · 제안 · 망 상태 · 로봇을 붙들고 설명을 이어 가지 않는다:
  //   토리가 단계 진행 중 스스로 바꾼 것(go → setMode)은 그대로 진행 · 공장을 보지 않는 단계는 그대로 · 사용자가 다른 단계로 바꿨으면 안내를 멈추고 주제 메뉴 · 같은 단계에서 새로 시작(리셋 · 라인)이면 새 공장에서 다시 구성
  simChanged() {
    this.run++;
    if (this.selfRun) return;
    const s = this.open ? this.cur() : null, used = CTX.some((k) => this[k] != null), mode = this.h.mode?.(), spd = this.spd0;
    this.unhold(); this.spd0 = undefined; this.dropCtx();   // 옛 공장에 되돌리기(망 복구 · 개선안 되돌림 · 감지 풀기)를 걸지 않는다 — 새 공장에 옛 ID로 가면 안 됨
    if (spd != null) this.h.speed?.(spd);   // 배속은 화면 설정이라 원래대로
    if (s && this.needMode && mode !== this.needMode) return this.menu('stopped');   // 이 주제가 요구한 단계(피지컬AI)에서 벗어남 — 말만 하는 단계라도 그 단계의 공장을 설명하는 중이다
    if (!s || (!used && !simBound(s))) { this.modeAt = mode; return; }
    if (mode !== this.modeAt) return this.menu('stopped');
    if (used) this.play(this.topic); else { this.list = null; this.go(Math.min(this.step, this.steps().length - 1)); }
  }
  unhold() { clearInterval(this.holdT); if (this.held) { this.held = false; if (this.heldByMe) this.h.pause?.(false); this.heldByMe = false; } }   // 토리가 직접 멈춘 경우에만 다시 재생 (사용자가 멈춰 둔 공장은 그대로)
  restoreSpeed() { if (this.ev?.quiet) this.ev.quiet = false;   // 인시던트 예시를 「AI 감지」 전에 벗어나면 감지를 막아 둔 이벤트를 풀어 준다
    this.fast = false; if (this.spd0 != null) this.h.speed?.(this.spd0); this.spd0 = undefined; if (this.netOff) { fos(this)?.setOnline(true); this.netOff = false; } if (this.applied === true && this.prop?.status === 'applied') { adv(this)?.revert(this.prop.id); this.applied = 'reverted'; } }   // KPI 주제에서 시연 적용 중 벗어나면 되돌림   // 인시던트 예시 배속 · FacOS 상위망 단절 시험 되돌림   // 인시던트 예시가 1배속으로 늦춘 것을 되돌림   // 시나리오(현장 이벤트 · 공정 편차)는 한 번 재생에 한 번만

  // 그 단계를 떠나도 되는지 — 실제로 일어나기를 기다리는 단계(ready)는 그 일이 일어난 뒤에만 (「다음」 단추 · 자동 넘김 · go가 같은 검사를 쓴다)
  canLeave(s = this.cur()) { return !(s?.ready && !s.ready(this)); }
  advance() { const s = this.cur(); if (!s) return; if (!this.canLeave(s)) return this.waitHere(s); const nx = this.nextTopic(s); if (nx) this.play(nx); else this.go(this.step + 1); }
  noteText(s) { return this.noteK ? (this.tx(s)[this.noteK] ?? this.ui[this.noteK]) : ''; }
  text(s) { const L = this.tx(s), t = typeof L.say === 'function' ? L.say(this, H) : L.say; return this.noteK ? `${t} ⏳ ${this.noteText(s)}` : t; }   // 말풍선 글 (+ 기다림 · 시간 초과 안내)
  waitHere(s) { this.noteK = 'wait'; this.sayEl.textContent = this.text(s); this.spokenText = this.noteText(s); this.speak(this.spokenText); }   // 준비 전 「다음」: 넘어가지 않고 기다린다고 알린다 (자동 넘김은 계속 기다림)
  // 대기 시간 초과: 「완료」로 넘기지 않는다 — 알린 뒤 5초 뒤 이 예시를 건너뛰어 다음 주제로 (「다시 기다리기」로 더 기다림 · 그 사이 일어나면 이어서 진행)
  timeout(s) {
    this.cancelAuto(); this.timedOut = true; this.noteK = 'timeout'; this.sayEl.textContent = this.text(s);
    const b = this.el.querySelector('[data-t="next"]'); if (b) b.textContent = this.ui.retry;
    const tok = this.autoTok;
    this.autoFn = () => { if (tok !== this.autoTok || !this.open) return; this.bar(LOOP_MS); this.autoT = setTimeout(() => { if (tok === this.autoTok && this.open) this.skipTopic(); }, LOOP_MS); };
    this.spokenText = this.noteText(s); this.speak(this.spokenText); this.armAuto();
  }
  retry() { const s = this.cur(); if (!s) return; this.timedOut = false; this.noteK = 'wait'; this.paint(s, this.step, true); this.scheduleAuto(s, this.step === this.steps().length - 1); }
  skipTopic() { const S = this.steps(), nx = S[S.length - 1]?.next ?? TOPICS[this.topic].next ?? null; if (nx) this.play(nx); else this.menu(); }
  // 단계가 필요한 상위망 상태 (FacOS 단절 시험): net 'off' 단계에 있는 동안만 끊고, 벗어나면 다시 잇는다 — 이전으로 돌아와도 말과 망이 같다. 사용자가 이미 끊어 둔 망은 건드리지 않는다
  syncNet(s) {
    const F = fos(this); if (!F) return;
    if (s.net === 'off') { if (F.online) { F.setOnline(false); this.netOff = true; this.netT0 = performance.now(); F.bus.send('zone:main', 'factory', 'status', { text: '정밀조립 상태 보고 (상위망 단절 중 · 토리 시험)' }); } else if (this.netOff === undefined) { this.netOff = false; this.netT0 = performance.now(); } }
    else if (this.netOff) { this.flushed = F.setOnline(true); this.netOff = false; }
  }
  // 그 단계에서 보이는 창 · 카메라의 출처: 그 단계에 적혀 있지 않으면 앞 단계에서 이어받은 것 (순방향으로 왔을 때 보이던 화면)
  srcOf(i, has) { const S = this.steps(); for (let k = i; k >= 0; k--) if (has(S[k])) return S[k]; return null; }

  go(i) {
    const S = this.steps();
    if (i < 0) return;
    if (i > this.step && this.step >= 0 && !this.canLeave()) return this.waitHere(this.cur());   // 준비되지 않은 단계는 건너뛰지 않는다
    if (i >= S.length) return this.close();
    this.cancelAuto(); this.clearHl(); this.stopTimers(); this.unhold();
    const s = S[i], back = i < this.step, seq = i === this.step + 1, g = this.gen; this.step = i; this.open = true; this.el.classList.remove('mini'); this.btnEl.classList.remove('menu');
    this.noteK = null; this.timedOut = false; this.menuNote = null;
    if (s.mode) this.needMode = s.mode;
    if (s.mode && this.h.mode?.() !== s.mode) { const r = this.run; this.selfRun = true; try { this.h.setMode?.(s.mode); } finally { this.selfRun = false; } if (r !== this.run) this.dropCtx(); this.modeAt = s.mode; this.list = null; }   // 단계를 바꾸면 그 단계에 맞는 안내만 다시 고른다 (예: 보안 계층은 피지컬AI에서만)   // 단계 동작(act)보다 먼저 — 모드를 바꾸면 공장이 새로 시작하므로 act는 새 공장을 보고 판단한다 (KPI 첫 단계 30배속) · selfRun: 토리가 바꾼 것 (simChanged가 안내를 멈추지 않게)
    if (s.act && !back) s.act(this);   // 이전으로 돌아올 때는 다시 실행하지 않음 (이벤트를 또 만들지 않게) — 되돌려야 하는 화면 · 망 상태는 아래에서 단계마다 맞춘다
    this.syncNet(s);
    // 카메라: 그 단계에 적힌 곳으로 — 이전 · 건너뛰어 들어온 단계에 적힌 곳이 없으면 앞 단계에서 이어받은 곳으로 (순방향과 같은 화면)
    const cs = s.view || s.cam ? s : seq ? null : this.srcOf(i, (x) => x.view || x.cam);
    if (cs?.view) this.h.flyTo?.(cs.view);
    if (cs?.cam) { const k = S.indexOf(cs), c = back && this.camAt?.[k] ? this.camAt[k] : typeof cs.cam === 'function' ? cs.cam(this) : cs.cam; if (c) { (this.camAt ??= [])[k] = c; this.h.camTo?.(c); } }   // 그 현장으로 이동 · 확대 — 이전으로 돌아오면 그때 비춘 자리 그대로 (그 사이 로봇이 옮겨 갔어도)
    if (s.hold) { const f = () => { if (g === this.gen && !this.held && s.hold(this)) { this.held = true; this.heldByMe = this.h.paused?.() === false; if (this.heldByMe) this.h.pause?.(true); } }; f(); this.holdT = setInterval(f, 300); }   // 명령이 내려지면 설명하는 동안 현장을 멈춤
    if (s.follow || s.camF) { const f = () => { if (g !== this.gen) return; const c = s.camF?.(this); if (c) return this.h.camTo?.({ ...c, ms: 900 }); const p = s.follow && this.h.moverPos?.(s.follow(this)); if (p) this.h.camTo?.({ x: p.x, z: p.z, d: 9, ms: 900 }); }; f(); this.followT = setInterval(f, 1000); }   // 출동 로봇을 따라간다 · camF가 자리를 주면 그쪽(진입자 + 추적 로봇을 함께)
    // 창: 그 단계에 적힌 창은 현장을 3초 보여 준 뒤 (null = 창 닫기) · 적혀 있지 않으면 앞 단계에서 이어받은 창 — 순서대로 넘어와 이미 떠 있으면 그대로, 아니면(이전 · 건너뜀 · 3초 전에 넘김) 바로 다시 연다
    const ps = this.srcOf(i, (x) => x.panel !== undefined), own = ps === s;
    if (ps && (own || !(seq && this.panelSrc === ps))) {   // 창을 다룬 단계가 앞에 없으면 손대지 않는다 (사용자가 연 창을 닫지 않게)
      this.h.closePanels?.(); this.panelOpen = false; this.panelSrc = ps.panel ? null : ps;
      const show = () => {   // 창 내용은 열 때 정한다 (그 사이 생긴 사례 · 제품 반영)
        const p = typeof ps.panel === 'function' ? ps.panel(this) : ps.panel;
        if (p && g === this.gen && this.open) { this.h.openPanel?.(p); this.panelOpen = true; this.panelSrc = ps; }
      };
      if (ps.panel) { if (own) this.panelT = setTimeout(show, panelMs()); else show(); }
    } else if (!ps && !seq && this.panelOpen) { this.h.closePanels?.(); this.panelOpen = false; this.panelSrc = null; }   // 창을 열기 전 단계로 되돌아옴 — 토리가 연 창을 닫는다
    const hls = (s.hl ?? []).map((q) => document.querySelector(q)).filter(Boolean);
    this.reveal(hls);
    for (const e of hls) e.classList.add('tori-hl');
    this.paint(s, i);
    this.scheduleAuto(s, i === S.length - 1);
    store.set(SEEN, '1');
  }
  // 단계의 글 · 그림 · 단추 (언어를 바꾸면 이것만 다시)
  paint(s, i, quiet) {   // quiet: 글 · 단추만 다시 (소리는 그대로)
    const S = this.steps(), u = this.ui, en = this.lang === 'en', L = this.tx(s), g = this.gen; clearInterval(this.liveT);
    this.nEl.textContent = `${this.tname(this.topic)}${i ? ` · ${i} / ${S.length - 1}` : ''}`;
    const ck = Object.keys(CHAINS).find((k) => s[k] != null);
    this.figEl.innerHTML = s.ring ? ringSvg(s.ring, s.at, en) : ck ? chainSvg(s[ck], en ? EN_CHAINS[CHAIN_EN[ck]] : CHAINS[ck]) : '';
    const last = s.end || i === S.length - 1, nx = this.nextTopic(s), nextLabel = this.timedOut ? u.retry : s.start ? u.start : nx ? `${this.tname(nx)} ▶` : last ? u.finish : u.next;
    this.btnEl.innerHTML = `${i ? `<button type="button" data-t="prev">${u.prev}</button>` : ''}${i === 0 && this.topic === 'tour' ? `<button type="button" data-t="skip">${u.later}</button>` : ''}<button type="button" data-t="menu">${u.topics}</button><button type="button" data-t="next" class="primary">${nextLabel}</button>`;
    const v = L.voice && typeof L.voice === 'object' ? L.voice[s.vk(this)] : L.voice;
    if (quiet) this.sayEl.textContent = this.text(s); else this.say(this.text(s), this.noteK ? this.noteText(s) : s.vok && !s.vok(this) ? L.vno : v);   // vok: 녹음 문장이 지금 현장과 맞을 때만 그 녹음을 쓴다 (아니면 vno 녹음)
    if (s.live || s.ready) this.liveT = setInterval(() => {   // 진행 상황을 1초마다 다시 읽음 (소리는 처음 한 번) · 기다리던 일이 일어나면 기다림 안내를 지우고, 시간 초과 뒤였으면 이어서 진행
      if (g !== this.gen) return;
      if (this.noteK && this.canLeave(s)) { const was = this.timedOut; this.noteK = null; this.timedOut = false; if (was) { this.paint(s, i, true); return this.scheduleAuto(s, i === S.length - 1); } }
      const t = this.text(s); if (t !== this.sayEl.textContent) this.sayEl.textContent = t;
    }, 1000);
  }
  say(text, voice) { this.sayEl.textContent = text; this.talkT = Math.min(6, 1.2 + text.length * (this.lang === 'en' ? 0.02 : 0.045)); this.spokenText = voice ?? text; this.speak(this.spokenText); }   // 말하는 입 모양 (글자 수만큼)
  close() { this.unhold(); this.restoreSpeed(); this.stopTimers(); if (this.panelOpen) { this.h.closePanels?.(); this.panelOpen = false; } this.panelSrc = null; this.noteK = null; this.timedOut = false; this.cancelAuto(); this.clearHl(); this.reveal([]); this.open = false; this.step = -1; this.el.classList.add('mini'); this.stopVoice(); this.talkT = 0; }
  clearHl() { document.querySelectorAll('.tori-hl').forEach((e) => e.classList.remove('tori-hl')); }
  // 가리킬 곳이 접힌 메뉴 안이면 먼저 펼친다 — 숨긴 왼쪽 · 오른쪽 패널, 접힌 FacOS 머리, 닫힌 존 에이전트 설정
  // 이 단계가 더는 가리키지 않으면 사용자가 둔 대로 다시 접는다 (연달아 가리키는 동안은 그대로 — 깜빡이지 않게)
  reveal(els) {
    const need = new Map(), b = document.body, ap = document.getElementById('agentPanel');   // 키 → [펼치기, 되접기]
    this.revealed ??= new Map();
    const shut = (k, now) => now || this.revealed.has(k);   // 내가 펼친 것은 사용자에게는 아직 접힌 것
    for (const e of els) {
      for (const k of ['left', 'right']) if (shut(k, b.classList.contains(`hide-${k}`)) && e.closest(`.panel.${k}`)) need.set(k, [() => this.h.side?.(k, false), () => this.h.side?.(k, true)]);
      if (ap && shut('facos', ap.classList.contains('facos-folded')) && e.closest('#facosSum, #zoneAgentBox')) need.set('facos', [() => ap.classList.remove('facos-folded'), () => ap.classList.add('facos-folded')]);
      for (let d = e.closest('details'); d; d = d.parentElement?.closest('details')) if (shut(d, !d.open)) { const det = d; need.set(det, [() => { det.dataset.tori = '1'; det.open = true; }, () => { det.dataset.tori = '1'; det.open = false; }]); }   // data-tori: 잠시 펼침 — 사용자 설정으로 저장하지 않음 (ui.js)
    }
    for (const [k, undo] of this.revealed) if (!need.has(k)) { undo(); this.revealed.delete(k); }
    for (const [k, [open, undo]] of need) if (!this.revealed.has(k)) { open(); this.revealed.set(k, undo); }
  }
  // ── 자동 넘김 ─────────────────
  cancelAuto() { this.autoTok = (this.autoTok ?? 0) + 1; clearTimeout(this.autoT); this.autoT = null; this.onSpoken = null; this.autoFn = null; this.el.querySelector('[data-t="next"]')?.classList.remove('auto'); }
  bar(ms) { const b = this.el.querySelector('[data-t="next"]'); b?.classList.remove('auto'); b?.style.setProperty('--tori-auto', `${ms}ms`); void b?.offsetWidth; b?.classList.add('auto'); }   // 기다리는 동안 차오르는 막대 (1초 · 맺음말 5초)
  scheduleAuto(s, last) {
    this.cancelAuto();
    const nx = this.nextTopic(s);   // 주제 마지막 단계: 다음 주제가 이어져 있으면 말이 끝나고 1초 뒤 그 주제로 (메뉴 순서)
    const loop = (s.end || last) && !nx && this.topic === 'outcome';   // 활용 및 기대 맺음말: 말이 끝나고 5초 뒤 둘러보기부터 다시
    if ((s.end || last) && !nx && !loop) return;
    const wait = loop ? LOOP_MS : AUTO_MS;
    const tok = this.autoTok, t0 = performance.now();
    const countdown = () => {
      if (tok !== this.autoTok || !this.open) return;
      if (!this.canLeave(s)) {   // 실제로 일어날 때까지 — 한도를 넘기면 넘어가지 않고 시간 초과로 (준비되지 않은 다음 단계가 현장을 멈추거나 「했어요」라고 말하지 않게)
        if (performance.now() - t0 < readyMax()) { this.autoT = setTimeout(countdown, 500); return; }
        return this.timeout(s);
      }
      this.bar(wait);
      this.autoT = setTimeout(() => { if (tok !== this.autoTok || !this.open) return; if (!this.canLeave(s)) return countdown(); if (loop) this.play('tour'); else if (nx) this.play(nx); else this.go(this.step + 1); }, wait);
    };
    this.autoFn = countdown; this.armAuto();
  }
  // 말이 끝나면 다음 동작(autoFn)을 시작 — 음성이 재생 중이면 끝날 때, 아니면 읽는 시간 뒤. 음성이 뒤늦게 실제로 시작하면(첫 클릭 · 음성 켜기) 읽는 시간 타이머를 버리고 음성 끝 기준으로 다시 건다
  armAuto() {
    const fn = this.autoFn; if (!fn) return;
    clearTimeout(this.autoT); this.el.querySelector('[data-t="next"]')?.classList.remove('auto');
    if (this.speaking) { this.autoT = null; this.onSpoken = () => { this.onSpoken = null; fn(); }; }
    else { this.onSpoken = null; this.autoT = setTimeout(fn, readMs(this.sayEl.textContent, this.lang)); }
  }
  spoken() { this.speaking = false; this.talkT = 0; clearTimeout(this.voiceT); this.onSpoken?.(); }
  voiceFail() { this.speaking = false; this.talkT = 0; clearTimeout(this.voiceT); this.armAuto(); }   // 소리를 낼 수 없음 — 끝난 것으로 치지 않고 읽는 시간을 준 뒤 넘어간다 (영영 기다리지도 않게)

  speak(text) {
    this.stopVoice(); if (!this.voice || !text) return;
    // 아직 사용자가 화면을 누른 적이 없으면 소리가 막힌다 — 첫 클릭 때 지금 말을 읽는다 (앱은 처음부터 — electron/main.mjs autoplayPolicy)
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive && !document.body.classList.contains('app')) {
      this.pending = text;
      if (!this.waitTap) { this.waitTap = true; addEventListener('pointerdown', () => { this.waitTap = false; setTimeout(() => { if (this.open && this.pending) this.speak(this.pending); }, 0); }, { once: true, capture: true }); }
      return;
    }
    this.pending = null;
    const L = this.lang, key = voiceKey(text, L);
    if (!this.recorded[L] && this.recLoad?.[L]) {   // 녹음 목록을 아직 못 읽음(시작 직후) — 읽은 뒤에 말한다 (그 사이 다른 말로 넘어갔으면 버림)
      const tok = this.spkTok = {}; this.recLoad[L].then(() => { if (this.spkTok === tok && this.recorded[L]) this.speak(text); }); return;
    }
    if (this.recorded[L]?.has(key)) {   // 녹음 (자연스러운 남성 음성 · 한국어 InJoon / 영어 Andrew)
      const a = this.audio = new Audio(`${voiceDir(L)}${key}.mp3`);
      this.speaking = true; this.armAuto();   // 실제 재생을 시작했으니 읽는 시간으로 걸어 둔 자동 넘김은 음성 끝 기준으로
      const fail = () => { if (this.audio !== a) return; this.audio = null; this.speakOS(text, L); };   // 녹음을 틀 수 없음(파일 오류 · 재생 거부) → 같은 문장을 OS 음성으로, 그것도 안 되면 읽는 시간으로 (세대가 지난 소리는 무시)
      a.onplay = () => { if (this.audio === a) this.talkT = 60; }; a.onended = () => { if (this.audio === a) this.spoken(); }; a.onerror = fail;
      let pr; try { pr = a.play(); } catch (e) { pr = Promise.reject(e); }
      Promise.resolve(pr).catch(fail);
      return;
    }
    this.speakOS(text, L);
  }
  speakOS(text, L) {   // 녹음이 없으면 OS 음성 (그 언어)
    const S = window.speechSynthesis; if (!S?.speak || typeof SpeechSynthesisUtterance === 'undefined') return this.voiceFail();
    const v = (L === 'en' ? enVoice : koVoice)(S.getVoices?.() ?? []); if (!v) return this.voiceFail();   // 남성 음성이 없으면 읽지 않는다 — 여성 음성으로 바뀌어 들리지 않게 (말풍선 + 읽는 시간)
    const u = new SpeechSynthesisUtterance(speakText(text, L)); u.lang = L === 'en' ? 'en-US' : 'ko-KR'; u.rate = 1.05; u.voice = v;
    this.speaking = true; this.armAuto(); let started = false;
    const fail = () => { if (this.utter !== u) return; this.utter = null; this.voiceFail(); };
    u.onstart = () => { if (this.utter === u) { started = true; this.talkT = 60; } }; u.onend = () => { if (this.utter === u) this.spoken(); }; u.onerror = fail;
    this.utter = u; try { S.speak(u); } catch { return fail(); }
    clearTimeout(this.voiceT); this.voiceT = setTimeout(() => { if (this.utter === u && !started) { S.cancel(); fail(); } }, voiceStartMs());   // 막혀서 시작도 끝도 알리지 않는 경우 (첫 클릭 전 등)
  }
  stopVoice() { this.speaking = false; this.utter = null; this.spkTok = null; clearTimeout(this.voiceT); window.speechSynthesis?.cancel(); if (this.audio) { this.audio.pause(); this.audio = null; } }

  // ── 아바타 (공장장 그림 애니메이션) ─────────────────
  // 투명 배경 PNG(assets/tori/manager.png)를 격자 판에 붙이고, 판의 꼭짓점을 매 프레임 조금씩 옮겨 움직임을 만든다:
  // 숨쉬기(몸통) · 좌우 흔들림 · 둥실 · 말할 때 고개 끄덕임 · 가리키는 손 들썩임 · 처음 나타날 때 튀어 오름
  async initGfx() {
    let r = null, kind = 'WebGL';
    if (navigator.gpu) {
      try {
        const W = await import('three/webgpu');
        r = new W.WebGPURenderer({ canvas: this.cv, antialias: true, alpha: true }); await r.init();
        kind = r.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
      } catch (e) { console.info('[토리] WebGPU 대신 WebGL로 그림', e?.message ?? e); r = null; }
    }
    r ??= new THREE.WebGLRenderer({ canvas: this.cv, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2)); r.setSize(this.cv.width, this.cv.height, false); r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.r = r; this.el.querySelector('.tori-gpu').textContent = kind;
    const scene = this.scene = new THREE.Scene(), cam = this.cam = new THREE.OrthographicCamera(-1.06, 1.06, 1.06, -1.06, 0.1, 10); cam.position.z = 5;
    // 아바타 그림: 한국어 manager.png · 영어 manager-en.png (같은 자세 · 같은 구도 — 목 · 손 위치가 같아 움직임 그대로) — 언어를 바꾸면 그림도 바꾼다 (skin)
    const load = async (f) => { const t = await new THREE.TextureLoader().loadAsync(new URL(`../assets/tori/${f}`, import.meta.url).href); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
    const [ko, en] = await Promise.all([load('manager.png'), load('manager-en.png').catch(() => null)]);
    this.texs = { ko, en: en ?? ko }; const tex = this.texs[this.lang];
    const geo = new THREE.PlaneGeometry(2, 2, 28, 28), pos = geo.attributes.position;
    this.base = Float32Array.from(pos.array); this.geo = geo;
    this.fig = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.02, depthWrite: false }));
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
    shadow.position.set(0.12, -0.9, -0.1); shadow.scale.set(1, 0.16, 1); this.shadow = shadow;
    scene.add(shadow, this.fig);
    this.t0 = performance.now(); this.last = 0; this.pop = 0;
    const loop = (now) => { requestAnimationFrame(loop); if (document.hidden || now - this.last < 33) return; const dt = Math.min(0.1, (now - (this.last || now)) / 1000); this.last = now; this.frame(dt, (now - this.t0) / 1000); };
    requestAnimationFrame(loop);
  }
  frame(dt, t) {
    const talking = this.talkT > 0; if (talking && this.talkT < 59) this.talkT -= dt;
    this.pop = Math.min(1, this.pop + dt * 2.5);
    const b = this.base, a = this.geo.attributes.position.array, ease = 1 - Math.pow(1 - this.pop, 3);
    // 그림 좌표(판 -1~1): 목 (0.0, -0.02) · 가리키는 손 (-0.56, -0.04) · 발 y -0.93
    const tilt = talking ? Math.sin(t * 5.2) * 0.05 : Math.sin(t * 0.9) * 0.015, nod = talking ? Math.abs(Math.sin(t * 7)) * 0.02 : 0;
    const breathe = 1 + Math.sin(t * 2.1) * 0.008, sway = Math.sin(t * 1.1) * 0.012, hand = talking ? Math.sin(t * 4.3) * 0.035 : Math.sin(t * 1.6) * 0.008;
    const c = Math.cos(tilt), s = Math.sin(tilt);
    for (let i = 0; i < a.length; i += 3) {
      let x = b[i], y = b[i + 1];
      const up = (y + 0.93) / 1.93;   // 발 0 → 머리 끝 1
      // 몸통 숨쉬기 (발은 고정)
      x *= 1 + (breathe - 1) * up; y = -0.93 + (y + 0.93) * (1 + (breathe - 1) * 0.6);
      // 머리: 목을 축으로 기울이고 끄덕임 (목 위로 갈수록 크게)
      const w = Math.min(1, Math.max(0, (b[i + 1] - 0.0) / 0.22)), hw = w * w * (3 - 2 * w);
      if (hw > 0) { const dx = x, dy = y + 0.02; x = dx * (1 - hw + hw * c) - dy * hw * s; y = -0.02 + dx * hw * s + dy * (1 - hw + hw * c) - nod * hw; }
      // 가리키는 손 들썩임
      const hx = b[i] + 0.56, hy = b[i + 1] + 0.04, g = Math.exp(-(hx * hx + hy * hy) / 0.025); y += hand * g;
      // 전체 좌우 흔들림 (발 기준) · 둥실 · 처음 나타날 때 튀어 오름
      x += sway * up; a[i] = x * ease; a[i + 1] = y * ease + Math.sin(t * 1.8) * 0.012 * up - (1 - ease) * 0.6;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.shadow.scale.set(1 - Math.sin(t * 1.8) * 0.04, 0.16, 1);
    this.r.render(this.scene, this.cam);
  }
}
