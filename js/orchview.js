// 오케스트레이터 인시던트 흐름 도표 — 인시던트 목록 + 스윔레인 흐름도(현장 감지 · 셀 컨트롤러 · 공장 오케스트레이터 · 실행 자원).
// 단계(감지 → 셀 자체 조치 → 상위 보고 → 판단 → 명령 → 조치 → 완료 확인)를 시각과 함께 실시간으로 그린다.
import { LANES, STAGES, INCIDENT_TYPES } from './orchestrator.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const KIND = {
  detect: { label: '감지', color: 'var(--o-detect)' }, self: { label: '자체 조치', color: 'var(--o-self)' }, report: { label: '보고', color: 'var(--o-report)' },
  decide: { label: '판단', color: 'var(--o-decide)' }, command: { label: '명령', color: 'var(--o-command)' }, act: { label: '조치', color: 'var(--o-act)' },
  notify: { label: '결과 통보', color: 'var(--o-notify)' }, done: { label: '완료', color: 'var(--o-done)' },
};
// 레인 사이 화살표 이름 (이전 단계 → 이번 단계)
const arrowLabel = (a, b) => (b.kind === 'report' || (a.lane === 'cell' && b.lane === 'orch' && b.kind !== 'notify') ? '보고' : b.kind === 'command' || (a.lane === 'orch' && b.lane === 'exec') ? '명령' : b.lane === 'orch' && b.kind === 'notify' ? '결과 통보' : b.lane === 'orch' ? '완료 보고' : '');

export class OrchView {
  constructor(el, badgeEl) {
    this.el = el; this.badge = badgeEl; this.sel = null; this.showCell = true; this.pendingType = null;
    el.addEventListener('click', (e) => {
      const it = e.target.closest('[data-inc]'); if (it) { this.sel = +it.dataset.inc; this.render(); }
      if (e.target.closest('[data-close]')) this.hide();
    });
    el.addEventListener('change', (e) => { if (e.target.id === 'orchShowCell') { this.showCell = e.target.checked; this.render(); } });
  }
  attach(sim) {
    this.sim = sim; this.sel = null;
    sim.orch.onOpen = (inc) => { if (this.pendingType && inc.type === this.pendingType) { this.sel = inc.id; this.pendingType = null; } };
    this.render();
  }
  get open() { return !this.el.classList.contains('hidden'); }
  show(selectType) { this.el.classList.remove('hidden'); if (selectType) { const inc = this.sim.orch.incidents.find((i) => i.type === selectType && i.status === 'open'); if (inc) this.sel = inc.id; else this.pendingType = selectType; } this.render(); }
  hide() { this.el.classList.add('hidden'); }
  toggle() { this.open ? this.hide() : this.show(); }

  tick() {
    const n = this.sim?.orch.openCount() ?? 0;
    this.badge.textContent = n ? String(n) : '';
    this.badge.hidden = !n;
    if (this.open) this.render();
  }

  render() {
    if (!this.sim || !this.open) return;
    const o = this.sim.orch;
    const list = o.incidents.filter((i) => this.showCell || !i.cellResolved);
    if (!this.sel || !o.incidents.some((i) => i.id === this.sel)) this.sel = (list.find((i) => i.status === 'open') ?? list[0])?.id ?? null;
    const inc = o.incidents.find((i) => i.id === this.sel);
    const now = this.sim.time;
    const items = list.map((i) => {
      const T = INCIDENT_TYPES[i.type], dur = (i.tEnd ?? now) - i.t0;
      const st = i.status === 'open' ? ['진행 중', 'open'] : i.cellResolved ? ['셀 자체 해결', 'cell'] : ['해결', 'done'];
      return `<button type="button" class="oi ${i.id === this.sel ? 'sel' : ''} st-${st[1]}" data-inc="${i.id}">
        <span class="oi-ic">${T.icon}</span><span class="oi-t">${esc(i.title)}</span>
        <span class="oi-m">${clock(i.t0)} · ${Math.round(dur)}초</span><span class="oi-s">${st[0]}</span></button>`;
    }).join('') || '<div class="oi-empty">아직 인시던트가 없습니다. ⚡ 설비 고장 주입, ⛔ 자재 공급 차질, ⚠ 현장 이벤트(피지컬AI)로 발생시켜 보세요.</div>';
    this.el.innerHTML = `
      <div class="orch-h"><b>🛰 ${esc(o.name)}</b><small>인시던트 보고 · 판단 · 명령 · 조치 흐름</small>
        <label class="chk"><input type="checkbox" id="orchShowCell" ${this.showCell ? 'checked' : ''}/> 셀 자체 해결 포함</label>
        <button type="button" data-close title="닫기">✕</button></div>
      <div class="orch-b"><div class="orch-list">${items}</div><div class="orch-flow">${inc ? this.flow(inc, now) : ''}</div></div>`;
  }

  flow(inc, now) {
    const reached = new Set(inc.steps.map((s) => s.kind));
    const first = (k) => inc.steps.find((s) => s.kind === k);
    const stages = STAGES.filter((s) => !(inc.cellResolved && ['report', 'decide', 'command'].includes(s.key)));
    const stepper = stages.map((s, i) => {
      const f = first(s.key) ?? (s.key === 'act' && inc.cellResolved ? inc.steps.find((x) => x.lane === 'cell' && x.kind === 'act') : null);
      const on = !!f, cur = !on && stages.slice(0, i).every((p) => reached.has(p.key) || (inc.cellResolved && p.key === 'act'));
      return `<div class="os ${on ? 'on' : ''} ${cur && inc.status === 'open' ? 'cur' : ''}"><i>${on ? '✓' : i + 1}</i><span>${s.label}</span><small>${f ? `+${(f.t - inc.t0).toFixed(1)}s` : ''}</small></div>`;
    }).join('<b class="os-ar">›</b>');
    // 스윔레인 SVG
    const W = 640, colW = (W - 64) / 4, x0 = 64, rowH = 58, top = 46, BH = 50;
    const cx = (lane) => x0 + LANES.findIndex((l) => l.key === lane) * colW + colW / 2;
    const H = top + inc.steps.length * rowH + 18;
    // 상자 폭(약 14자)에 맞춰 최대 3줄로 접고, 넘치면 말줄임 (전체 문장은 마우스를 올리면 보인다)
    const wrap = (t, n = 14, max = 3) => { const a = [], w = [...t]; for (let i = 0; i < w.length && a.length < max; i += n) a.push(w.slice(i, i + n).join('')); if (w.length > n * max) a[max - 1] = a[max - 1].slice(0, n - 1) + '…'; return a; };
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" class="sw" role="img" aria-label="인시던트 처리 흐름도">
      <defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--o-line)"/></marker></defs>`;
    LANES.forEach((l, i) => {
      const x = x0 + i * colW;
      svg += `<rect x="${x + 2}" y="0" width="${colW - 4}" height="${H}" rx="8" class="lane l-${l.key}"/>
        <text x="${x + colW / 2}" y="17" text-anchor="middle" class="ln">${esc(l.key === 'orch' ? (inc.cellResolved ? '오케스트레이터' : '오케스트레이터') : l.label)}</text>
        <text x="${x + colW / 2}" y="32" text-anchor="middle" class="ls">${esc(l.sub)}</text>`;
    });
    inc.steps.forEach((s, i) => {
      const y = top + i * rowH, x = cx(s.lane), K = KIND[s.kind] ?? KIND.act, bw = colW - 14;
      const last = i === inc.steps.length - 1 && inc.status === 'open';
      if (i > 0) {
        const p = inc.steps[i - 1], px = cx(p.lane), py = top + (i - 1) * rowH;
        if (p.lane !== s.lane) {
          const dir = Math.sign(x - px), sx = px + dir * (bw / 2), ex = x - dir * (bw / 2);
          svg += `<path d="M${sx},${py + BH / 2} C${(sx + ex) / 2},${py + BH / 2} ${(sx + ex) / 2},${y + BH / 2} ${ex},${y + BH / 2}" class="ar" marker-end="url(#arw)"/>`;
          const lab = arrowLabel(p, s);
          if (lab) svg += `<text x="${(sx + ex) / 2}" y="${(py + y) / 2 + BH / 2 + 4}" text-anchor="middle" class="al">${lab}</text>`;
        } else svg += `<line x1="${x}" y1="${py + BH}" x2="${x}" y2="${y - 2}" class="ar" marker-end="url(#arw)"/>`;
      }
      svg += `<text x="6" y="${y + 16}" class="tm">+${(s.t - inc.t0).toFixed(1)}s</text><text x="6" y="${y + 29}" class="tm2">${clock(s.t)}</text>
        <g class="${last ? 'cur' : ''}"><title>${esc(K.label)} · ${esc(s.text)}</title><rect x="${x - bw / 2}" y="${y}" width="${bw}" height="${BH}" rx="7" class="bx" style="--k:${K.color}"/>
        <text x="${x - bw / 2 + 7}" y="${y + 12}" class="bk" style="fill:${K.color}">${K.label}</text>`;
      wrap(s.text).forEach((ln, k) => { svg += `<text x="${x - bw / 2 + 7}" y="${y + 24 + k * 10.5}" class="bt">${esc(ln)}</text>`; });
      svg += `</g>`;
    });
    svg += `</svg>`;
    const dur = (inc.tEnd ?? now) - inc.t0;
    return `<div class="of-h"><span>${INCIDENT_TYPES[inc.type].icon} <b>${esc(inc.title)}</b> · 발생 ${clock(inc.t0)} · 출처 ${esc(inc.source)}</span>
        <span class="of-st ${inc.status}">${inc.status === 'open' ? `진행 중 · ${Math.round(dur)}초 경과` : `${inc.cellResolved ? '셀 자체 해결' : '해결'} · 총 ${Math.round(dur)}초`}</span></div>
      <div class="ostp">${stepper}</div><div class="sw-wrap">${svg}</div>`;
  }
}
