// 공장 진화 컨셉: 레거시 공장 → 자동화 공장 → 피지컬AI 자율공장
// 세 운영 모드(traditional·smart·dark)를 단계로 놓고, 단계별 운영 요소와 8시간 시뮬레이션 성과를 한 화면에 그린다.
import { MODES } from './sim.js';
import { ZONE_AMR } from './line.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const STAGES = [
  {
    key: 'traditional', no: 1, icon: '👷', title: '레거시 공장', motto: '사람이 일하고, 사람이 판단',
    color: '#c9a36a',
  },
  {
    key: 'smart', no: 2, icon: '🤖', title: '자동화 공장', motto: '로봇·AMR이 일하고, 사람이 감시·판단',
    color: '#3d9bff',
  },
  {
    key: 'dark', no: 3, icon: '🦾', title: '피지컬AI 자율공장', motto: 'AI가 판단하고, 로봇의 몸으로 실행',
    color: '#a77bff',
  },
];

// 단계 사이 전환 동인
const SHIFTS = ['자동화 전환<br><small>로봇·AMR·IoT·MES</small>', '자율화 전환<br><small>피지컬AI·AI 에이전트</small>'];

// 비교 축 — 각 단계의 값은 시뮬레이션 모드 설정과 일치시킨다 (js/sim.js MODES)
const ROWS = [
  ['공정 작업', ['작업자 수작업 · 단독 설비', '양쪽 협동로봇 셀 · SCARA · 6축', '협동로봇 셀 + 폐루프 자율 보정']],
  ['셀 간 물류', ['고정 컨베이어 · 지게차', `AMR ${ZONE_AMR.count}대 · AGV ${MODES.smart.vehicles}대`, `AMR ${ZONE_AMR.count}대 · AGV ${MODES.dark.vehicles}대 · 휴머노이드 부품 보충 ${MODES.dark.helpers}대`]],
  ['설비 정비', [`사후보전 — 고장 후 인지 (약 ${MODES.traditional.alarmDelay}초 지연)`, '예지정비 — IoT 임계치 · 정비원', `휴머노이드 정비 ${MODES.dark.techs}대 + 사족보행 순찰 ${MODES.dark.quadrupeds}대 선제 감지`]],
  ['품질', ['육안 검사', '비전·토크 전수 판정 · SPC 보정', '전수 판정 + 자율 재보정']],
  ['의사결정', ['작업반장 경험 · Push 투입', 'MES 규칙 기반 자동 제어 · Pull 투입', 'AI 에이전트 자율 운영 (Claude 감독 계층)']],
  ['데이터', ['수기 기록 · 센서 없음', 'IoT · MES · 디지털트윈', '디지털트윈 + 로봇 현장 센싱 (열화상·진동·음향)']],
  ['현장 인원', ['공정별 작업자 배치', '모니터링·관제·정비 소수 인원', '0명 — 원격 관제만']],
  ['조명·공조', ['상시 점등', '구역 제어', '고효율 LED · 구역 자동 조광']],
];

const num = (v) => Math.round(v).toLocaleString('ko-KR');
const KPIS = [
  ['양품 생산', (k) => k.good, (v) => `${num(v)}개`, 'max'],
  ['OEE', (k) => k.OEE, (v) => `${(v * 100).toFixed(1)}%`, 'max'],
  ['불량 유출', (k) => k.ppm, (v) => `${num(v)} ppm`, 'min'],
  ['돌발 고장', (k) => k.failures, (v) => `${num(v)}회`, 'min'],
  ['에너지 원단위', (k) => k.kwhPerUnit, (v) => `${v.toFixed(3)} kWh/개`, 'min'],
  ['현장 인원', (k) => k.people, (v) => `${num(v)}명`, 'min'],
];

export function renderConcept(el, { current, res, lineName, busy }) {
  const cols = 'grid-template-columns: 92px 1fr 76px 1fr 76px 1fr';
  const cell = (st, html, cls = '') => `<div class="cc-cell ${cls} ${st.key === current ? 'cur' : ''}" style="--c:${st.color}">${html}</div>`;
  const arrow = (i, row) => `<div class="cc-arrow">${row === 0 ? `<span>${SHIFTS[i]}</span>` : ''}</div>`;
  const line = (label, cells) => `<div class="cc-label">${label}</div>${cells.map((c, i) => c + (i < 2 ? arrow(i, -1) : '')).join('')}`;

  const head = `<div></div>${STAGES.map((st, i) => cell(st, `
      <div class="cc-no">${st.no}</div><div class="cc-icon">${st.icon}</div>
      <div class="cc-title">${st.title}</div><div class="cc-motto">${st.motto}</div>
      <button type="button" data-stage="${st.key}">${st.key === current ? '● 보는 중' : '3D로 보기'}</button>`, 'head') + (i < 2 ? arrow(i, 0) : '')).join('')}`;
  const body = ROWS.map(([label, vals]) => line(label, STAGES.map((st, i) => cell(st, esc(vals[i]))))).join('');

  let kpi;
  if (res) {
    kpi = KPIS.map(([label, get, fmt, best]) => {
      const vals = STAGES.map((st) => get(res[st.key].k));
      const top = best === 'max' ? Math.max(...vals) : Math.min(...vals);
      const max = Math.max(...vals) || 1;
      return line(label, STAGES.map((st, i) => cell(st, `<div class="cc-kv ${vals[i] === top ? 'best' : ''}"><b>${fmt(vals[i])}</b><i style="width:${(vals[i] / max) * 100}%"></i></div>`, 'kpi')));
    }).join('');
  } else {
    kpi = `<div class="cc-label">8시간 성과</div><div class="cc-calc" style="grid-column: 2 / -1">${busy
      ? '<span class="spin"></span> 세 단계를 같은 조건으로 8시간 시뮬레이션하는 중…'
      : '<button type="button" data-calc>📊 같은 라인·같은 조건으로 단계별 8시간 성과 계산</button>'}</div>`;
  }

  el.innerHTML = `<div class="cc-grid" style="${cols}">${head}${body}<div class="cc-sep" style="grid-column: 1 / -1">시뮬레이션 성과 (8시간 · ${esc(lineName)})</div>${kpi}</div>
    <div class="cmp-note">• 단계는 상단 모드 버튼과 같습니다. "3D로 보기"를 누르면 그 단계의 공장으로 바뀝니다.<br>
    • 같은 정밀조립Zone이라도 레거시는 고정 컨베이어·작업자, 자동화는 양쪽 협동로봇·AMR, 피지컬AI는 여기에 휴머노이드·사족보행 로봇과 AI 자율 운영이 더해집니다.<br>
    • 성과 수치는 예시용 가정값으로 돌린 시뮬레이션 결과입니다.</div>`;
}
