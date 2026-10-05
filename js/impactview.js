// KPI 영향 분석 · 개선 제안 · 의사결정 지원 창 (impact.js 결과를 그린다)
import { CAUSES, LEVERS, VERIFY_S, TWIN_S, TWIN_SEEDS, fmtV, impactMarkdown } from './impact.js';

const COLORS = { failure: '#ff5a5a', pm: '#f5b82e', cal: '#e0c341', parts: '#d58cff', supply: '#ff9152', hazard: '#ff6fae', command: '#9aa6b2', flow: '#5aa9e6', speed: '#59c9b9', quality: '#c77dff' };
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`, n0 = (v) => Math.round(v).toLocaleString('ko-KR'), n1 = (v) => v.toFixed(1);
const hm = (t0) => { const t = t0 + 8 * 3600; return `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`; };   // 화면 시계와 같은 시각 (08:00 시작)
const STATUS = { new: '결정 대기', verifying: '트윈 검증 중', verified: '검증 완료 · 결정 대기', applied: '적용됨', held: '보류', reverted: '되돌림' };
const REC = { apply: ['적용 권장', 'good'], neutral: ['효과 미미', 'mid'], hold: ['보류 권장', 'bad'] };
const delta = (a, b, d = 0, inv = false) => { const x = b - a, good = inv ? x < 0 : x > 0; return `<em class="${Math.abs(x) < 1e-9 ? '' : good ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${x.toFixed(d)}</em>`; };

export const impactState = { window: 1800 };

export function impactHTML(sim) {
  const tr = sim.impact; if (!tr) return '';
  const st = impactState, R = tr.report(st.window), K = R.kpi, A = tr.advisor;
  const win = [[600, '최근 10분'], [1800, '최근 30분'], [0, '전체']].map(([w, l]) => `<button data-imp-win="${w}" class="${st.window === w ? 'on' : ''}">${l}</button>`).join('');
  const lossRows = R.rows.filter((r) => r.oeePts > 0.0005 || r.kwh > 0.005);
  // OEE 폭포: OEE + 원인별 손실 = 100%
  const bar = `<div class="imp-bar"><i style="width:${K.oee * 100}%;background:var(--good)" title="OEE ${pct(K.oee)}"></i>${lossRows.map((r) => `<i style="width:${r.oeePts * 100}%;background:${COLORS[r.key]}" title="${r.label} −${(r.oeePts * 100).toFixed(2)}%p"></i>`).join('')}</div>
    <div class="imp-leg"><span><b style="background:var(--good)"></b>OEE ${pct(K.oee)}</span>${lossRows.slice(0, 8).map((r) => `<span><b style="background:${COLORS[r.key]}"></b>${r.label} −${(r.oeePts * 100).toFixed(1)}%p</span>`).join('')}</div>`;
  const tile = (k, v, sub) => `<div class="imp-tile"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`;
  const tiles = `<div class="imp-tiles">
    ${tile('UPH', n0(K.uph), `이론 ${n0(K.uphIdeal)} · 손실 −${n0(K.uphIdeal - K.uph)}`)}
    ${tile('OEE', pct(K.oee), `손실 ${pct(1 - K.oee)} · 1위 ${lossRows[0] ? `${lossRows[0].label} −${(lossRows[0].oeePts * 100).toFixed(1)}%p` : '-'}`)}
    ${tile('WIP', n1(K.avgWip), `원인별 붙잡힘 +${R.rows.reduce((a, r) => a + r.wip, 0).toFixed(2)}개`)}
    ${tile('POWER', `${K.avgKW.toFixed(0)}kW`, `${K.kwhPerUnit.toFixed(3)}kWh/개 · 낭비 ${n1(K.wasteKwh)}kWh`)}</div>`;
  const table = `<table class="imp-t"><thead><tr><th>원인</th><th>건수</th><th>손실 대수</th><th>UPH</th><th>OEE</th><th>WIP</th><th>전력 낭비</th><th>kWh/개</th></tr></thead><tbody>
    ${lossRows.map((r) => `<tr><td><b class="dot" style="background:${COLORS[r.key]}"></b>${r.icon} ${r.label}</td><td>${r.count || '-'}</td><td>${n1(r.units)}</td><td>−${n1(r.uph)}</td><td>−${(r.oeePts * 100).toFixed(2)}%p</td><td>+${r.wip.toFixed(2)}</td><td>${r.kwh.toFixed(2)}kWh</td><td>−${r.kwhUnitGain.toFixed(4)}</td></tr>`).join('') || '<tr><td colspan="8">손실 없음</td></tr>'}
    </tbody></table><p class="imp-note">손실 대수 = 이론 생산(구간 ÷ 기준 사이클 ${sim.idealCycle.toFixed(2)}초) − 양품. 품질 불량을 먼저 떼고 나머지를 원인별 병목 가중 손실시간 비례로 배분 — OEE 손실 합 + OEE = 100%. 자재대기·막힘은 그 원인을 만든 셀 정지·이벤트로 넘겨 셉니다. 진로 이벤트 로봇 정지 대기 ${n0(R.hazardMoverSec)}대·초.</p>`;
  const evs = R.events.slice(0, 10);
  const evT = `<table class="imp-t ev"><thead><tr><th>시각</th><th>원인</th><th>위치</th><th>지속</th><th>손실 대수</th><th>영향 로봇</th></tr></thead><tbody>
    ${evs.map((e) => `<tr><td>${hm(e.t0)}</td><td><b class="dot" style="background:${COLORS[e.cause]}"></b>${CAUSES[e.cause].label}</td><td>${e.where}</td><td>${Math.round(e.dur)}초${e.open ? ' <em class="dn">진행 중</em>' : ''}</td><td>${n1(e.units)}</td><td>${e.affected || '-'}</td></tr>`).join('') || '<tr><td colspan="6">이 구간에 이벤트 없음</td></tr>'}</tbody></table>`;
  // 효과 순: 결정 대기 중 트윈 검증에서 개선이 큰 것부터 → 검증 전 → 적용됨 → 보류·되돌림
  const gain = (p) => p.twin ? (p.twin.uphCand - p.twin.uphCur) / Math.max(1, p.twin.uphCur) + (p.twin.oeeCand - p.twin.oeeCur) - 0.5 * (p.twin.kwhCand - p.twin.kwhCur) / Math.max(1e-6, p.twin.kwhCur) : -1;
  const rank = (p) => ({ verified: 0, verifying: 1, new: 1, applied: 2, held: 3, reverted: 3 })[p.status];
  const list = [...A.items].sort((a, b) => rank(a) - rank(b) || gain(b) - gain(a));
  const cards = list.filter((p) => p.status !== 'held' || sim.time - p.t < 3600).map((p) => propCard(sim, p)).join('') || '<p class="imp-note">현재 기준(원인별 OEE 손실 · 전력 낭비 · 재공)을 넘는 손실이 없어 제안이 없습니다. 운영 5분 뒤부터 1분마다 다시 분석합니다.</p>';
  const logs = A.log.slice(0, 8).map((x) => `<li>${hm(x.t)} · <b>${x.act}</b> · ${x.title}${x.change ? ` (${x.change})` : ''}</li>`).join('');
  return `<div class="imp-head"><div class="seg imp-win">${win}</div><button data-imp-md class="imp-md">📄 리포트 저장 (.md)</button></div>
    ${tiles}
    <h3>OEE 손실 분해 — 이벤트·문제가 UPH · OEE · WIP · POWER에 미친 영향</h3>${bar}${table}
    <h3>이벤트별 영향</h3>${evT}
    <h3>개선 방법 · 제안 <small>제안마다 디지털트윈(현재 vs 제안, ${TWIN_S / 60}분 × 시드 ${TWIN_SEEDS.length}, 실제 현장 이벤트 재연)으로 검증한 뒤 적용 여부를 묻습니다</small></h3>${cards}
    ${logs ? `<h3>의사결정 이력</h3><ul class="imp-log">${logs}</ul>` : ''}`;
}

function propCard(sim, p) {
  const A = sim.impact.advisor, L = p.lever && LEVERS[p.lever];
  const chips = p.kpi.map((k) => `<i>${k}</i>`).join('');
  let body = '', act = '';
  if (p.twin) {
    const t = p.twin, [rl, rc] = REC[t.recommend];
    body += `<div class="imp-twin"><b>트윈 검증</b>
      <span>UPH ${n0(t.uphCur)} → ${n0(t.uphCand)} ${delta(t.uphCur, t.uphCand)}</span>
      <span>OEE ${pct(t.oeeCur)} → ${pct(t.oeeCand)} ${delta(t.oeeCur * 100, t.oeeCand * 100, 1)}%p</span>
      <span>WIP ${n1(t.wipCur)} → ${n1(t.wipCand)} ${delta(t.wipCur, t.wipCand, 1, true)}</span>
      <span>${t.kwhCur.toFixed(3)} → ${t.kwhCand.toFixed(3)}kWh/개 ${delta(t.kwhCur * 1000, t.kwhCand * 1000, 1, true)}Wh</span>
      <strong class="${rc}">${rl}</strong></div>`;
  }
  if (p.status === 'verifying') body += `<div class="imp-prog"><i style="width:${Math.round((p.progress ?? 0) * 100)}%"></i><span>디지털트윈 검증 중 ${Math.round((p.progress ?? 0) * 100)}%</span></div>`;
  if (p.status === 'new' || p.status === 'verified') {
    const q = p.twin ? (p.twin.recommend === 'apply' ? '트윈 검증에서 개선이 확인됐습니다. 이 제안을 적용하시겠습니까?' : p.twin.recommend === 'hold' ? '트윈 검증에서 나빠졌습니다. 그래도 적용하시겠습니까?' : '트윈 검증에서 효과가 작습니다. 적용하시겠습니까?') : p.lever ? '디지털트윈 검증 전입니다. 검증하거나 바로 적용할 수 있습니다.' : '운영자 확인이 필요한 제안입니다.';
    act = `<div class="imp-ask"><span>❓ ${q}</span>${p.lever ? `${!p.twin && !A.job ? '<button data-imp-verify>🧪 트윈 검증</button>' : ''}<button data-imp-apply class="primary">✅ 적용</button>` : ''}<button data-imp-hold>⏸ 보류</button></div>`;
  }
  if (p.status === 'applied') {
    const left = Math.max(0, VERIFY_S - (sim.time - p.tApply));
    const live = A.windowKpi(p.tApply, sim.time);
    const b = p.before, a = p.after ?? live;
    body += b && a ? `<div class="imp-twin"><b>${p.measured ? '실측 효과' : `실측 중 (${Math.ceil(left / 60)}분 남음)`}</b>
      <span>UPH ${n0(b.uph)} → ${n0(a.uph)} ${delta(b.uph, a.uph)}</span><span>OEE ${pct(b.oee)} → ${pct(a.oee)} ${delta(b.oee * 100, a.oee * 100, 1)}%p</span>
      <span>WIP ${n1(b.wip)} → ${n1(a.wip)} ${delta(b.wip, a.wip, 1, true)}</span><span>${b.kw.toFixed(0)} → ${a.kw.toFixed(0)}kW ${delta(b.kw, a.kw, 1, true)}</span><small>적용 전 10분 vs 적용 후</small></div>`
      : `<div class="imp-twin"><b>실측 중</b><span>적용 후 ${Math.ceil(left / 60)}분 동안 효과를 측정합니다</span></div>`;
    act = `<div class="imp-ask"><span>${hm(p.tApply)} 적용 · ${L.label} ${fmtV(p.lever, p.from)} → ${fmtV(p.lever, p.to)}</span><button data-imp-revert>↩ 되돌리기</button></div>`;
  }
  return `<div class="imp-card ${p.status}" data-imp-id="${p.id}">
    <div class="imp-ch"><b>${p.title}</b><span class="imp-chips">${chips}</span><small>${STATUS[p.status]}</small></div>
    <div class="imp-why">📊 근거: ${p.why}</div>
    ${L ? `<div class="imp-chg">⚙️ ${L.label}: <b>${fmtV(p.lever, p.status === 'applied' || p.status === 'reverted' ? p.from : L.get(sim))}</b> → <b>${fmtV(p.lever, p.to)}</b></div>` : ''}
    <div class="imp-why">🎯 기대 효과: ${p.expect}${p.est ? ` <em>(추정 ${p.est})</em>` : ''}</div>
    <div class="imp-why muted">⚖️ 부작용: ${p.trade}</div>
    ${body}${act}</div>`;
}

// 클릭 처리 — 바뀌었으면 true
export function impactClick(sim, e) {
  const A = sim.impact?.advisor; if (!A) return false;
  const w = e.target.closest('[data-imp-win]'); if (w) { impactState.window = +w.dataset.impWin; return true; }
  if (e.target.closest('[data-imp-md]')) {
    const blob = new Blob([impactMarkdown(sim, impactState.window)], { type: 'text/markdown' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `KPI_impact_${sim.mode.key}_${Math.round(sim.time)}s.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return false;
  }
  const card = e.target.closest('[data-imp-id]'); if (!card) return false;
  const id = card.dataset.impId;
  if (e.target.closest('[data-imp-verify]')) return A.verify(id);
  if (e.target.closest('[data-imp-apply]')) return A.apply(id);
  if (e.target.closest('[data-imp-hold]')) return A.hold(id);
  if (e.target.closest('[data-imp-revert]')) return A.revert(id);
  return false;
}
