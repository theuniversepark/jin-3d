// 정밀조립Zone 서열 키팅 · 라인사이드 칸반 정보 (부품분류셀 · 조립·체결셀 정보 창) — 키팅 센서 · 피지컬AI ①~⑥ · 서열 버퍼 · 흐름 랙 · 최근 키트 (js/sps.js)
import { SPS_SENSORS, SPS_TOPIC, SPS_PHASE_KO, SPS_LINE, SPS_CELL } from './sps.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const COL = { ok: '#3ddc84', warn: '#f5b82e', alarm: '#ff5a5a' };
const P_KO = { doortrim: '도어트림', eaxle: 'e-axle' };

// 조립·체결셀: 키트(조립셀) · 공용 부품 투빈 칸반
function lineHtml(S, id) {
  const L = S.line[id]; if (!L) return '';
  const assy = id === 'DT_ASSY' || id === 'EA_ASSY', ai = S.ai, on = S.mode !== 'traditional';
  const how = ai ? '셀 부품 선반 · 물류 휴머노이드 보충 (선반 비전 계수 → 보충 요청)' : on ? `투빈 칸반 · 밀크런 ${Math.round(S.spec.milkRun / 60)}분 순회` : '투빈 · 작업자가 빈 상자를 보고 보충';
  return `<div class="mm">
    <h4>🧰 부품 공급 · ${assy ? '서열 키트 + ' : ''}라인사이드 칸반</h4>
    <ul class="mm-r">
      ${assy ? `<li><b>서열 키트</b> · AMR 키트 포켓에 실려 옴 — 로봇마다 첫 점의 부품(변형 부품)을 키트에서 집음<br><small>${S.stats.missed ? `검증을 통과한 키트 오류 ${S.stats.missed}건은 조립셀에서 발견 → 키팅 구역에서 맞는 부품을 가져옴 (+${S.spec.missDelay}초)` : '키트 오류가 조립셀까지 온 적 없음'}</small></li>` : ''}
      <li><b>공용 부품 (${esc(L.part)})</b> · 재고 ${L.pct}%${L.bins ? ` · 상자 ${L.bins[0]} / ${L.bins[1]}` : ''}${L.card ? ' · 칸반 카드 나감' : ''}${L.stockouts ? ` · 결품 ${L.stockouts}회` : ''}<br><small>${esc(how)}</small></li>
    </ul>
  </div>`;
}

export function spsHtml(M, id = SPS_CELL) {
  const S = M?.snapshot(); if (!S?.on) return '';
  if (id !== SPS_CELL) return lineHtml(S, id);
  const v = S.sensors ?? {}, L = S.levels ?? {}, st = S.stats, ai = S.ai, on = S.mode !== 'traditional';
  const lim = (s) => (s.alarm ? [s.alarm.lo != null ? `≤${s.alarm.lo}` : '', s.alarm.hi != null ? `≥${s.alarm.hi}` : ''].filter(Boolean).join(' · ') : '');
  const row = (s) => `<tr title="${esc(s.dev)}"><td>${esc(s.label)}</td><td style="color:${COL[L[s.key] ?? 'ok']};font-weight:700">${v[s.key] ?? '-'} <small>${esc(s.unit)}</small></td><td><small>${esc(lim(s))}</small></td></tr>`;
  const mode = ai ? '피지컬AI' : on ? '자동화' : '레거시';
  const sides = Object.entries(S.side).map(([p, sd]) => `<li><b>${P_KO[p]}</b> · ${esc(SPS_PHASE_KO[sd.phase] ?? sd.phase)}${sd.kit ? ` (${esc(sd.kit.variant)} · ${Math.round(sd.prog * 100)}%)` : ''} · 서열 버퍼 ${sd.queue.length}개${sd.queue.length ? ` — ${sd.queue.map((k) => esc(k.variant)).join(' / ')}` : ''}<br><small>흐름 랙 ${sd.stock.map((x) => `${esc(x.rack)} ${x.pct}%${x.req ? '(보충 중)' : ''}`).join(' · ')}</small></li>`).join('');
  const items = [
    ['① 범용 파지', ai ? 'AMMR이 처음 보는 부품·사양도 따로 가르치지 않고 집음 (VLA)' : on ? '레일 협동로봇 · 표시등이 켜진 칸만 (정해진 부품 · 티칭 위치)' : '작업자 키팅', ''],
    ['② 빈 피킹', ai ? `섞인 스위치(플렉시블 피더)·오일씰을 비전으로 집음 · 집기 실패를 스스로 다시 ${st.graspRetry}회` : on ? '정렬된 상자에서만 집음 (섞인 부품은 작업자가 정렬)' : '작업자', ''],
    ['③ 키트 검증 AI', `잘못 담음 ${st.errors}개 → 검증에서 ${st.caught}개 · 조립셀에서 발견 ${st.missed}개`,
      ai ? '영상 + 무게로 좌/우 · 색상 · 수량을 확인해 키팅 구역에서 다시 담음' : on ? `무게만 — 같은 무게의 좌/우 · 색상은 조립셀에서 발견 (+${S.spec.missDelay}초)` : '육안 — 절반만 잡음'],
    ['④ 로트 추적', `e-axle 키트 ${st.lots}개${st.rescans ? ` · 다시 스캔 ${st.rescans}회` : ''}${st.traceGap ? ` · 기록 누락 ${st.traceGap}건` : ''}`,
      ai ? '베어링·오일씰을 집으면서 로트 라벨을 판독 → 제품 계보에 연결' : on ? '검증대 고정 스캐너 (라벨이 가려지면 다시 스캔 +5초)' : '수기 기록 (누락 시 추적 불가)'],
    ['⑤ 개봉·청정 취급', `클린 부스 입자 ${v.particle ?? '-'}개/ft³${st.fod ? ` · 이물 노출 ${st.fod}건` : ''}`,
      ai ? '힘 제어로 포장을 벗기고 장갑 낀 손처럼 이물 없이 담음 (사람 출입 없음)' : on ? '작업자가 개봉 — 포장 조각이 들어가면 검증대 영상에서 발견해 다시 담음' : '작업자 개봉 · 육안'],
    ['⑥ 결품·막힘 예측', `흐름 랙 보충 ${st.replenish}회 · 결품 ${st.stockouts}회 · 키트 대기 ${st.waits}회 (${Math.round(st.waitS)}초)${ai ? ` · 막힘 대응 ${st.throttled}회` : ''}`,
      ai ? '생산 순서로 흐름 랙을 미리 보충 · 조립 라인이 막히면 그 제품 키트는 1개만 담음' : on ? '칸반 카드 — 25%에서 보충 요청' : '빈 칸이 보여야 보충 (결품이면 부품분류셀이 기다림)'],
  ].map(([h, b, s]) => `<li><b>${esc(h)}</b> · ${b}${s ? `<br><small>${esc(s)}</small>` : ''}</li>`).join('');
  const recs = S.records.slice(0, 6).map((r) => `<li><b style="color:${r.result === 'OK' ? COL.ok : COL.warn}">${esc(r.result)}</b> · ${esc(String(r.part).split('-').slice(-2).join('-'))} · ${esc(r.id)} · ${esc(r.variant)} · ${r.weight_g}g${r.lots ? ` · 로트 ${esc(r.lots)}` : ''}</li>`).join('') || '<li>아직 키트 기록 없음</li>';
  const evs = S.events.slice(0, 5).map((e) => `<li>${Math.floor(e.t / 60)}분 · ${esc(e.text)}</li>`).join('') || '<li>보충·칸반 기록 없음</li>';
  const lines = Object.entries(S.line).map(([id, x]) => `${esc(id)} ${x.pct}%${x.card ? '(칸반)' : ''}`).join(' · ');
  return `<div class="mm">
    <h4>🧰 서열 키팅 · ${esc(S.spec.model)}</h4>
    <div class="mm-dec" style="border-color:${COL.ok}"><b style="color:${COL.ok}">${mode}</b>
      <span>키팅 구역 2곳(흐름 랙 → 피킹 로봇 → 검증대 → 서열 버퍼) → 이 셀 로봇이 키트를 AMR 키트 포켓에 실음 → 조립셀 로봇이 집음</span></div>
    <div class="mm-h">키팅 구역</div><ul class="mm-r">${sides}</ul>
    <div class="mm-h">피지컬AI 적용 요소</div><ul class="mm-r">${items}</ul>
    <table class="mm-t"><thead><tr><th>센서</th><th>현재</th><th>경보</th></tr></thead><tbody>${SPS_SENSORS.map(row).join('')}</tbody></table>
    <div class="mm-h">최근 키트</div><ul class="mm-r">${recs}</ul>
    <div class="mm-h">보충 · 칸반</div><ul class="mm-r">${evs}</ul>
    <small>키트 ${st.kits}개 담음 · AMR에 실음 ${st.loaded} · 라인사이드 ${lines} · 칸반 ${st.kanban}회 · 결품 ${st.lineStockouts}회 · 토픽 ${esc(SPS_TOPIC)} (…/part · …/event)</small>
  </div>`;
}
export const SPS_CELLS = [SPS_CELL, ...Object.keys(SPS_LINE)];
