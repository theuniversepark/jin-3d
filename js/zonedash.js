// Zone 대시보드 창 — 📡 실시간 모니터링(설비 상태 · 생산 진행률 · 시계열) · ⚙ OEE·파레토(가동률·성능·품질 · 6대 손실 · NG 유형) · 📊 품질·상관(관리도 · 산점도)
// 계산은 js/zonekpi.js, 그리기는 SVG 문자열 (라이브러리 없음 — 웹 버전·공유 페이지에서도 그대로). 상단 「📈 Zone 대시보드」로 연다 — Zone은 정밀조립 하나 (Zone 고르는 단추 없음)
import { ZONES, ZONE_NAME, LOSS, PLANNED, QSPEC, controlChart, topPairs, pearson, interpretControl, interpretScatter } from './zonekpi.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(d)}%`);
const fx = (v, d = 2) => (v == null || !Number.isFinite(v) ? '-' : Number(v).toFixed(d));
const clk = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`; };
const mins = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)}시간` : `${(s / 60).toFixed(1)}분`);
export const zdState = { tab: 'live', ptab: 'loss', y: null, x: null };
const TABS = { live: '📡 실시간 모니터링', oee: '⚙ OEE·파레토', qa: '📊 품질·상관 (관리도·산점도)' };
const ST = { BUSY: ['가동', 'good'], OK: ['정상', 'good'], IDLE: ['대기', 'muted'], STARVED: ['자재 대기', 'muted'], NOPARTS: ['부품 대기', 'warn'], BLOCKED: ['출구 대기', 'warn'], DONE: ['다음 셀 대기', 'warn'], DOWN: ['고장', 'bad'], MAINT: ['정비 중', 'warn'], ESTOP: ['정지', 'bad'], PSTOP: ['보호정지', 'warn'], CSTOP: ['사이클 정지', 'warn'], STOP: ['정지', 'bad'] };
const BUCKET_UI = [['busy', '가동', '#3ddc84'], ['down', '고장', LOSS.down.col], ['pm', '계획 정비', '#8a96a3'], ['setup', '준비·교체', LOSS.setup.col], ['stop', '운영 정지', LOSS.stop.col], ['idle', '자재 대기', LOSS.idle.col], ['blocked', '출구 막힘', LOSS.blocked.col]];
const chip = (t, tone = '') => `<b class="qt-chip ${tone}">${t}</b>`;
const tile = (k, v, sub, tone = '') => `<div class="imp-tile ${tone}"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`;
const bar = (v, col, w = 120) => `<span class="zd-bar" style="width:${w}px"><i style="width:${Math.max(0, Math.min(1, v)) * 100}%;background:${col}"></i></span>`;
const healthCol = (h) => (h < 40 ? 'var(--bad)' : h < 60 ? 'var(--warn)' : 'var(--good)');

// ── 셀 실시간 상태 (Zone 흐름 · 설비 관리) ─────────────────
function liveCells(sim) {
  return sim.processing.filter((s) => !s.standby).map((st) => ({ id: st.id, name: st.name, state: st.state, progress: st.item ? st.progress : 0, health: st.health, item: st.item ? `${st.item.product === 'eaxle' ? 'e-axle' : '도어트림'} ${st.item.id}` : '', done: st.c.processed }));
}

// ── SVG 그리기 ─────────────────
const W = 560, H = 190, PADL = 44, PADR = 10, PADT = 12, PADB = 24;
function axes(x0, x1, y0, y1, { ylab = (v) => fx(v, 2), xlab = null, ticks = 4 } = {}) {
  let s = '';
  for (let k = 0; k <= ticks; k++) { const v = y0 + ((y1 - y0) * k) / ticks, y = PADT + (H - PADT - PADB) * (1 - k / ticks); s += `<line x1="${PADL}" x2="${W - PADR}" y1="${y}" y2="${y}" class="zd-grid"/><text x="${PADL - 4}" y="${y + 3}" class="zd-ax" text-anchor="end">${ylab(v)}</text>`; }
  if (xlab) for (let k = 0; k <= 4; k++) { const v = x0 + ((x1 - x0) * k) / 4, x = PADL + (W - PADL - PADR) * (k / 4); s += `<text x="${x}" y="${H - 6}" class="zd-ax" text-anchor="middle">${xlab(v)}</text>`; }
  return s;
}
const sx = (v, x0, x1) => PADL + ((v - x0) / (x1 - x0 || 1)) * (W - PADL - PADR);
const sy = (v, y0, y1) => PADT + (1 - (v - y0) / (y1 - y0 || 1)) * (H - PADT - PADB);
function lineChart(series, { y0 = 0, y1 = 1, ylab, title = '' } = {}) {
  const all = series.flatMap((s) => s.pts); if (all.length < 2) return `<div class="zd-empty">${title} — 데이터가 쌓이는 중입니다 (30초마다 기록)</div>`;
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  const paths = series.map((s) => `<polyline fill="none" stroke="${s.col}" stroke-width="${s.w ?? 1.6}" points="${s.pts.map((p) => `${sx(p[0], x0, x1).toFixed(1)},${sy(p[1], y0, y1).toFixed(1)}`).join(' ')}"/>`).join('');
  const leg = series.map((s) => `<span><i style="background:${s.col}"></i>${esc(s.name)} ${s.last ?? ''}</span>`).join('');
  return `<div class="zd-chart"><div class="zd-ct">${title}<span class="zd-leg">${leg}</span></div><svg viewBox="0 0 ${W} ${H}" class="zd-svg">${axes(x0, x1, y0, y1, { ylab, xlab: clk })}${paths}</svg></div>`;
}
function paretoChart(items, { unit = '', title = '' } = {}) {
  if (!items.length) return `<div class="zd-empty">${title} — 아직 없음</div>`;
  const L = items.slice(0, 8), n = L.length, max = L[0].v, bw = (W - PADL - 40) / n;
  let s = axes(0, 1, 0, max, { ylab: (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)) });
  L.forEach((x, i) => { const h = (x.v / max) * (H - PADT - PADB), X = PADL + i * bw + 4; s += `<rect x="${X}" y="${H - PADB - h}" width="${bw - 8}" height="${h}" fill="${LOSS[x.key]?.col ?? '#ff8a5c'}" opacity="0.85"><title>${esc(x.label)} ${x.v.toFixed(1)}${unit} (${pct(x.pct)})</title></rect><text x="${X + (bw - 8) / 2}" y="${H - 8}" class="zd-ax" text-anchor="middle">${i + 1}</text>`; });
  const cy = (c) => PADT + (1 - c) * (H - PADT - PADB), cx = (i) => PADL + i * bw + bw / 2;
  s += `<polyline fill="none" stroke="#ffd166" stroke-width="2" points="${L.map((x, i) => `${cx(i)},${cy(x.cum)}`).join(' ')}"/>${L.map((x, i) => `<circle cx="${cx(i)}" cy="${cy(x.cum)}" r="3" fill="#ffd166"/>`).join('')}`;
  s += `<line x1="${PADL}" x2="${W - 40}" y1="${cy(0.8)}" y2="${cy(0.8)}" stroke="#ffd166" stroke-dasharray="4 4" opacity="0.6"/><text x="${W - 38}" y="${cy(0.8) + 3}" class="zd-ax">80%</text><text x="${W - 38}" y="${cy(1) + 8}" class="zd-ax">100%</text>`;
  return `<div class="zd-chart"><div class="zd-ct">${title}<span class="zd-leg"><span><i style="background:#ffd166"></i>누적 %</span></span></div><svg viewBox="0 0 ${W} ${H}" class="zd-svg">${s}</svg></div>`;
}
function ctlChart(c, spec, title) {
  if (c.type === 'none') return `<div class="zd-empty">${title} — 표본 ${c.n}개 (8개 이상이면 관리도를 그립니다)</div>`;
  const P = c.points, bad = new Set(c.viol.map((v) => v.i)), xb = c.type === 'xbar-r';
  const ys = [...P.map((p) => p.x), c.ucl, c.lcl, ...(!xb ? [spec?.lsl, spec?.usl].filter((v) => v != null) : [])];
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const pad = (y1 - y0) * 0.12 || 1; y0 -= pad; y1 += pad;
  const x0 = 0, x1 = Math.max(1, P.length - 1), hl = (v, col, lab, dash = '') => `<line x1="${PADL}" x2="${W - PADR - 34}" y1="${sy(v, y0, y1)}" y2="${sy(v, y0, y1)}" stroke="${col}" stroke-width="1.2" ${dash ? `stroke-dasharray="${dash}"` : ''}/><text x="${W - PADR - 32}" y="${sy(v, y0, y1) + 3}" class="zd-ax" fill="${col}">${lab}</text>`;
  let s = axes(x0, x1, y0, y1, { ylab: (v) => fx(v, Math.abs(y1 - y0) < 2 ? 2 : 1) });
  s += hl(c.ucl, '#ff7a7a', 'UCL', '5 3') + hl(c.cl, '#7fd6ff', 'CL') + hl(c.lcl, '#ff7a7a', 'LCL', '5 3');
  if (!xb) { if (spec?.usl != null) s += hl(spec.usl, '#f5b82e', 'USL', '2 3'); if (spec?.lsl != null) s += hl(spec.lsl, '#f5b82e', 'LSL', '2 3'); }
  const X = (i) => PADL + (i / x1) * (W - PADL - PADR - 34);
  s += `<polyline fill="none" stroke="#cfe6f0" stroke-width="1.4" points="${P.map((p, i) => `${X(i)},${sy(p.x, y0, y1)}`).join(' ')}"/>`;
  s += P.map((p, i) => `<circle cx="${X(i)}" cy="${sy(p.x, y0, y1)}" r="${bad.has(p.i) ? 4 : 2.6}" fill="${bad.has(p.i) ? '#ff4d4d' : '#cfe6f0'}"><title>${xb ? `부분군 ${i + 1}` : `표본 ${i + 1}`} · ${fx(p.x, 3)}</title></circle>`).join('');
  // 범위(R / MR) 막대 (아래 띠)
  const rs = P.filter((p) => p.r != null), rmax = Math.max(c.rucl, ...rs.map((p) => p.r)) || 1;
  const rH = 60; let r = `<line x1="${PADL}" x2="${W - PADR - 34}" y1="${rH - 4 - (c.rucl / rmax) * (rH - 10)}" y2="${rH - 4 - (c.rucl / rmax) * (rH - 10)}" stroke="#ff7a7a" stroke-dasharray="5 3"/><text x="${W - PADR - 32}" y="${rH - 1 - (c.rucl / rmax) * (rH - 10)}" class="zd-ax" fill="#ff7a7a">UCL</text>`;
  r += rs.map((p) => `<rect x="${X(P.indexOf(p)) - 2}" y="${rH - 4 - (p.r / rmax) * (rH - 10)}" width="4" height="${(p.r / rmax) * (rH - 10)}" fill="${p.r > c.rucl ? '#ff4d4d' : '#7fb8cc'}"/>`).join('');
  r += `<text x="${PADL - 4}" y="${rH / 2}" class="zd-ax" text-anchor="end">${xb ? 'R' : 'MR'}</text>`;
  return `<div class="zd-chart"><div class="zd-ct">${title}<span class="zd-leg"><span>${xb ? `X̄-R · 부분군 ${c.n}개 × ${P.length}군` : `I-MR · 표본 ${P.length}개`}</span><span>CL ${fx(c.cl, 3)} · UCL ${fx(c.ucl, 3)} · LCL ${fx(c.lcl, 3)}</span></span></div>
    <svg viewBox="0 0 ${W} ${H}" class="zd-svg">${s}</svg><svg viewBox="0 0 ${W} ${rH}" class="zd-svg zd-r">${r}</svg></div>`;
}
function scatter(units, xk, yk, spec, xl, yl) {
  const P = units.filter((u) => Number.isFinite(u.x[xk]) && Number.isFinite(u.y[yk]));
  if (P.length < 3) return `<div class="zd-empty">산점도 — 표본이 부족합니다</div>`;
  const xs = P.map((u) => u.x[xk]), ys = [...P.map((u) => u.y[yk]), spec?.lsl, spec?.usl].filter((v) => v != null);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); const px = (x1 - x0) * 0.06 || 1, py = (y1 - y0) * 0.08 || 1; x0 -= px; x1 += px; y0 -= py; y1 += py;
  let s = axes(x0, x1, y0, y1, { ylab: (v) => fx(v, Math.abs(y1 - y0) < 2 ? 2 : 1), xlab: (v) => fx(v, Math.abs(x1 - x0) < 2 ? 2 : 1) });
  for (const [v, lab] of [[spec?.usl, 'USL'], [spec?.lsl, 'LSL']]) if (v != null) s += `<line x1="${PADL}" x2="${W - PADR}" y1="${sy(v, y0, y1)}" y2="${sy(v, y0, y1)}" stroke="#f5b82e" stroke-dasharray="2 3"/><text x="${W - PADR - 2}" y="${sy(v, y0, y1) - 3}" class="zd-ax" text-anchor="end" fill="#f5b82e">${lab}</text>`;
  s += P.map((u) => `<circle cx="${sx(u.x[xk], x0, x1).toFixed(1)}" cy="${sy(u.y[yk], y0, y1).toFixed(1)}" r="${u.ng ? 3.6 : 2.4}" fill="${u.ng ? '#ff4d4d' : '#5ab0ff'}" opacity="${u.ng ? 0.95 : 0.6}"><title>${esc(u.id)} · x ${u.x[xk]} · y ${u.y[yk]}${u.ng ? ` · NG ${esc(u.kind ?? '')}` : ''}</title></circle>`).join('');
  const p = pearson(xs, P.map((u) => u.y[yk]));
  if (p.r != null) s += `<line x1="${sx(x0, x0, x1)}" y1="${sy(p.a + p.b * x0, y0, y1)}" x2="${sx(x1, x0, x1)}" y2="${sy(p.a + p.b * x1, y0, y1)}" stroke="#ffd166" stroke-width="1.6" clip-path="url(#zdclip)"/>`;
  const clip = `<clipPath id="zdclip"><rect x="${PADL}" y="${PADT}" width="${W - PADL - PADR}" height="${H - PADT - PADB}"/></clipPath>`;
  return `<div class="zd-chart"><div class="zd-ct">산점도 — ${esc(xl.label)}${xl.unit ? ` (${esc(xl.unit)})` : ''} × ${esc(yl.label)} (${esc(yl.unit)})<span class="zd-leg"><span><i style="background:#5ab0ff"></i>양품</span><span><i style="background:#ff4d4d"></i>NG</span><span><i style="background:#ffd166"></i>회귀선</span><span>r = ${fx(p.r, 3)} · R² = ${fx(p.r * p.r, 3)} · n = ${p.n}</span></span></div><svg viewBox="0 0 ${W} ${H}" class="zd-svg">${clip}${s}</svg></div>`;
}

// 그래프 해석 상자 — 데이터에서 뽑은 판정 · 근거 · 조치
function insight(I, title) {
  if (!I) return '';
  return `<div class="zd-ins ${I.tone}"><div class="zd-ins-h">🧭 ${title} 해석 <b>${esc(I.head)}</b></div>
    <ul>${I.items.map((x) => `<li class="${x.tone}"><b>${esc(x.k)}</b> ${esc(x.t)}</li>`).join('')}</ul>
    ${I.acts.length ? `<div class="zd-ins-a"><b>권장 조치</b><ol>${I.acts.map((a) => `<li>${esc(a)}</li>`).join('')}</ol></div>` : ''}</div>`;
}

// ── 탭 ─────────────────
function liveTab(sim, z, K, o) {
  const pr = K.progress(z), cells = liveCells(sim, z), hist = K.hist.filter((h) => h[z]);
  const run = cells.filter((c) => c.state === 'BUSY').length, bad = cells.filter((c) => ['DOWN', 'MAINT'].includes(c.state)).length;
  const prog = `<div class="zd-prog"><div class="zd-pl"><b>${esc(pr.label)}</b> ${pr.done.toLocaleString('ko-KR')} / ${pr.target.toLocaleString('ko-KR')}${pr.uph ? ` · 설계 ${pr.uph} UPH` : ''}</div>
    <div class="zd-pbar"><i style="width:${Math.min(100, pr.pct * 100)}%"></i>${pr.expect != null ? `<em style="left:${pr.expect * 100}%" title="경과 시간 기준 기대 진행"></em>` : ''}</div>
    <small>${pct(pr.pct)}${pr.expect != null ? ` · 경과 시간 기준 기대 ${pct(pr.expect)} (${pr.pct >= pr.expect ? '<span class="good">앞섬</span>' : '<span class="bad">뒤처짐</span>'})` : ''}${pr.order ? ` · 현재 오더 ${esc(pr.order.id)} ${pr.order.done}/${pr.order.target} (납기 ${clk(pr.order.due)})` : ''}</small></div>`;
  const rows = cells.map((c) => { const [lab, tone] = ST[c.state] ?? [c.state, 'muted']; return `<tr><td>${esc(c.name)}</td><td>${chip(c.hold ? esc(c.hold) : lab, c.hold ? 'warn' : tone)}</td><td>${bar(c.progress, '#37a0ff', 110)} ${c.progress ? pct(c.progress, 0) : ''}</td><td>${bar(c.health / 100, healthCol(c.health), 90)} ${Math.round(c.health)}%</td><td class="zd-item">${esc(c.item)}</td><td class="num">${c.done.toLocaleString('ko-KR')}</td></tr>`; }).join('');
  const series = hist.length ? [['OEE', '#ffd166', 'OEE'], ['가동률', '#3ddc84', 'A'], ['성능', '#37a0ff', 'P'], ['품질', '#ff8a5c', 'Q']].map(([n, col, k]) => ({ name: n, col, w: k === 'OEE' ? 2.4 : 1.3, pts: hist.map((h) => [h.t, h[z][k]]), last: pct(hist.at(-1)[z][k], 0) })) : [];
  const ids = Object.keys(hist.at(-1)?.[z]?.h ?? {}), pal = ['#5ab0ff', '#3ddc84', '#ffd166', '#ff8a5c', '#b89bff', '#7fe0d6', '#ff6b9a', '#c9d2dc', '#9be15d'];
  const hs = ids.map((id, i) => ({ name: id, col: pal[i % pal.length], w: 1.2, pts: hist.filter((h) => h[z].h[id] != null).map((h) => [h.t, h[z].h[id]]), last: `${hist.at(-1)[z].h[id]}%` }));
  return `<div class="imp-tiles zd-tiles">${tile('OEE (지금까지)', pct(o.OEE), `가동률 ${pct(o.A, 0)} × 성능 ${pct(o.P, 0)} × 품질 ${pct(o.Q, 0)}`)}${tile('가동 셀', `${run} / ${cells.length}`, bad ? `<span class="bad">고장·정비 ${bad}</span>` : '고장·정비 없음')}${tile(o.quality.label, `${o.quality.good.toLocaleString('ko-KR')}`, `판정 ${o.quality.judged.toLocaleString('ko-KR')} · ${pct(o.Q, 1)}`)}${tile('품질 표본', K.units[z].length, `관리도·산점도용 (최근 600)`)}</div>
    ${prog}
    <div class="zd-two">${lineChart(series, { title: 'OEE · 가동률 · 성능 · 품질 추세', ylab: (v) => `${Math.round(v * 100)}%` })}${lineChart(hs, { y0: 0, y1: 100, title: '셀 건강도 추세 (IoT · 예지정비 기준)', ylab: (v) => `${Math.round(v)}` })}</div>
    <table class="od-tbl zd-tbl"><thead><tr><th>셀</th><th>상태</th><th>사이클 진행률</th><th>건강도</th><th>작업 중 제품</th><th>처리 수</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function oeeTab(sim, z, K, o) {
  const st = zdState, loss = K.lossPareto(z, o), ng = K.ngPareto(z), L = st.ptab === 'ng' ? ng : loss;
  const pmT = o.rows.filter((r) => !r.standby).reduce((a, r) => a + r.t.pm, 0);
  const cellRows = o.rows.map((r) => {
    const segs = BUCKET_UI.map(([k, lab, col]) => (r.tot && r.t[k] ? `<i style="width:${(r.t[k] / r.tot) * 100}%;background:${col}" title="${lab} ${mins(r.t[k])}"></i>` : '')).join('');
    return `<tr class="${r.standby ? 'muted' : ''}"><td>${esc(r.name)}${r.standby ? ' <small>(재작업 대기 셀 — Zone 합계 제외)</small>' : ''}</td><td class="num">${pct(r.A, 0)}</td><td class="num">${pct(r.P, 0)}</td><td class="num"><b>${pct(r.OEE, 0)}</b></td><td class="num">${r.done.toLocaleString('ko-KR')}</td><td class="num">${fx(r.ideal, 1)}초</td><td><span class="zd-stack">${segs}</span></td></tr>`;
  }).join('');
  const lrows = L.map((x, i) => `<tr><td>${i + 1}</td><td>${st.ptab === 'loss' ? `<i class="zd-dot" style="background:${LOSS[x.key].col}"></i>` : ''}${esc(x.label)}${st.ptab === 'loss' ? ` <small>${esc(x.six)}</small>` : ''}</td><td class="num">${st.ptab === 'loss' ? `${x.v.toFixed(1)}분` : `${x.v}건`}</td><td class="num">${pct(x.pct)}</td><td class="num">${pct(x.cum)}</td></tr>`).join('');
  const hist = K.hist.filter((h) => h[z]);
  return `<div class="imp-tiles zd-tiles">${tile('OEE', pct(o.OEE), '정밀조립 라인 OEE (KPI와 같은 값)')}${tile('가동률 A', pct(o.A), '고장 · 준비·교체 · 운영 정지 손실')}${tile('성능 P', pct(o.P), '자재 대기 · 출구 막힘 · 속도 저하 손실')}${tile('품질 Q', pct(o.Q), esc(o.quality.label))}</div>
    <p class="zd-note">ISO 22400-2 기준: OEE = 가동률 × 성능 × 품질. 계획 정비(예지정비·교정 ${mins(pmT)})는 계획 시간에서 빼고, 성능은 처리 수 × 기준 사이클 ÷ 가동 가능 시간입니다.</p>
    <div class="zd-two"><div><div class="seg small zd-seg"><button data-zd-ptab="loss" class="${st.ptab === 'loss' ? 'on' : ''}">손실 시간 (6대 손실)</button><button data-zd-ptab="ng" class="${st.ptab === 'ng' ? 'on' : ''}">NG 유형</button></div>
      ${paretoChart(L, { unit: st.ptab === 'loss' ? '분' : '건', title: st.ptab === 'loss' ? '손실 시간 파레토 (분)' : 'NG 유형 파레토 (건)' })}
      <table class="od-tbl zd-tbl"><thead><tr><th>#</th><th>${st.ptab === 'loss' ? '손실' : 'NG 유형'}</th><th>${st.ptab === 'loss' ? '시간' : '건수'}</th><th>비율</th><th>누적</th></tr></thead><tbody>${lrows || '<tr><td colspan="5">아직 없음</td></tr>'}</tbody></table></div>
      <div>${lineChart(hist.length ? [{ name: 'OEE', col: '#ffd166', w: 2.4, pts: hist.map((h) => [h.t, h[z].OEE]), last: pct(hist.at(-1)[z].OEE, 0) }] : [], { title: 'OEE 추세 (누적)', ylab: (v) => `${Math.round(v * 100)}%` })}
      <div class="zd-legend">${BUCKET_UI.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div></div></div>
    <table class="od-tbl zd-tbl"><thead><tr><th>셀</th><th>가동률</th><th>성능</th><th>OEE</th><th>처리 수</th><th>기준 사이클</th><th>시간 구성</th></tr></thead><tbody>${cellRows}</tbody></table>`;
}
function qaTab(sim, z, K) {
  const st = zdState, spec = QSPEC[z], yk = spec[st.y] ? st.y : Object.keys(spec)[0], S = spec[yk], U = K.units[z].filter((u) => u.y[yk] != null);   // 그 품질 특성이 있는 표본만 (도어트림·e-axle 체결 규격이 다르다)
  const vals = U.map((u) => u.y[yk]), cc = controlChart(vals, { n: 5, lsl: S.lsl ?? null, usl: S.usl ?? null });
  const pairs = topPairs(U).filter((p) => p.y === yk), xk = pairs.some((p) => p.x === st.x) ? st.x : pairs[0]?.x, XL = K.xl[z];
  const viol = [...new Map(cc.viol.map((v) => [`${v.i}:${v.rule}`, v])).values()].slice(-6);
  const ng = U.filter((u) => u.ng).length, lead = pairs[0] ? { label: XL[pairs[0].x]?.label ?? pairs[0].x, r: pairs[0].r } : null;
  const iC = interpretControl(cc, vals, S, lead), iS = xk ? interpretScatter(U, xk, yk, XL[xk] ?? { label: xk, unit: '' }, S) : null;
  return `<div class="seg small zd-seg">${Object.entries(spec).map(([k, s]) => `<button data-zd-y="${k}" class="${k === yk ? 'on' : ''}">${esc(s.label)} (${esc(s.unit)})</button>`).join('')}</div>
    <div class="imp-tiles zd-tiles">${tile('표본', U.length, `NG ${ng} · 최근 600개`)}${tile('평균 · 규격', `${fx(cc.mean, 3)} ${esc(S.unit)}`, `LSL ${S.lsl ?? '-'} · USL ${S.usl ?? '-'}`)}${tile('공정능력 Cp · Cpk', `${fx(cc.cp, 2)} · ${fx(cc.cpk, 2)}`, `σ(군내) ${fx(cc.sigma, 3)} · 1.33 이상 양호`, cc.cpk != null && cc.cpk < 1 ? 'bad' : '')}${tile('관리도 이상', viol.length ? `${new Set(cc.viol.map((v) => v.i)).size}점` : '없음', viol.length ? 'Western Electric 규칙 위반' : '관리 상태', viol.length ? 'bad' : '')}</div>
    <div class="zd-two"><div>${ctlChart(cc, S, `관리도 — ${esc(S.label)}`)}
      <ul class="zd-viol">${viol.map((v) => `<li><b>규칙 ${v.rule}</b> ${cc.type === 'xbar-r' ? '부분군' : '표본'} ${v.i + 1} — ${esc(v.text)}</li>`).join('') || '<li class="muted">위반 없음 — 우연 원인 산포 범위</li>'}</ul>${insight(iC, '관리도')}</div>
      <div>${xk ? scatter(U, xk, yk, S, XL[xk] ?? { label: xk, unit: '' }, S) : '<div class="zd-empty">산점도 — 공정 변수와 짝지을 표본이 12개 이상 쌓이면 표시합니다</div>'}
      <table class="od-tbl zd-tbl zd-pairs"><thead><tr><th>공정 변수 (x)</th><th>상관계수 r</th><th>n</th><th>영향 (기울기)</th></tr></thead><tbody>${pairs.slice(0, 8).map((p) => `<tr data-zd-x="${esc(p.x)}" class="${p.x === xk ? 'sel' : ''}"><td>${esc(XL[p.x]?.label ?? p.x)}${XL[p.x]?.unit ? ` <small>(${esc(XL[p.x].unit)})</small>` : ''}</td><td class="num"><b class="${Math.abs(p.r) >= 0.5 ? 'bad' : Math.abs(p.r) >= 0.3 ? 'warn' : ''}">${fx(p.r, 3)}</b></td><td class="num">${p.n}</td><td class="num">${fx(p.b, 4)} ${esc(S.unit)}/단위</td></tr>`).join('') || '<tr><td colspan="4">표본 수집 중</td></tr>'}</tbody></table>
      <p class="zd-note">|r| ≥ 0.5 강한 상관 · 0.3 ~ 0.5 중간 — 행을 누르면 산점도를 바꿉니다. 상관은 원인을 증명하지 않으므로 계보(🔎 품질 추적)·8D 분석과 함께 봅니다.</p>${insight(iS, '산점도')}</div></div>`;
}

export function zoneDashHTML(sim, { grafana = null } = {}) {
  const K = sim.zkpi; if (!K) return '<p class="vla-note">Zone 운영 분석이 없습니다.</p>';
  K.collectMain();
  const st = zdState, z = ZONES[0], o = K.oee(z);
  const zseg = `<div class="zd-zone1"><b>${ZONE_NAME[z]}</b> <small>OEE ${pct(o.OEE, 0)}</small></div>`;
  const tabs = `<div class="seg qt-tabs">${Object.entries(TABS).map(([k, l]) => `<button data-zd-tab="${k}" class="${st.tab === k ? 'on' : ''}">${l}</button>`).join('')}${grafana ? `<button data-zd-grafana="1" class="zd-gf" title="설비 대시보드(Grafana)의 Zone 운영 분석 — 장기 추세 · 90일 보관">📈 Grafana에서 보기</button>` : ''}</div>`;
  const body = st.tab === 'oee' ? oeeTab(sim, z, K, o) : st.tab === 'qa' ? qaTab(sim, z, K) : liveTab(sim, z, K, o);
  return `${zseg}${tabs}<div class="zd-body">${body}</div>`;
}
export function zoneDashClick(e) {
  const b = e.target.closest('[data-zd-tab],[data-zd-ptab],[data-zd-y],[data-zd-x],[data-zd-grafana]'); if (!b) return null;
  const d = b.dataset, st = zdState;
  if (d.zdTab) st.tab = d.zdTab;
  if (d.zdPtab) st.ptab = d.zdPtab;
  if (d.zdY) { st.y = d.zdY; st.x = null; }
  if (d.zdX) st.x = d.zdX;
  return d.zdGrafana ? { grafana: true } : { render: true };
}
