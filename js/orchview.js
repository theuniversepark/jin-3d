// 오케스트레이터 인시던트 흐름 도표 — 인시던트 목록 + 스윔레인 흐름도(현장 감지 · 셀 컨트롤러 · 공장 오케스트레이터 · 실행 자원).
// 단계(감지 → 셀 자체 조치 → 상위 보고 → 판단 → 명령 → 조치 → 완료 확인)를 시각과 함께 실시간으로 그린다.
// 명령 콘솔 탭에서는 상위 계층이 셀 현장으로 긴급·제어 명령을 보내고, 셀별 명령 상태와 명령 이력(전송 → ACK → 완료)을 본다.
import { LANES, STAGES, INCIDENT_TYPES, PRIORITY, prioOf } from './orchestrator.js';
import { COMMANDS, CMD_STATE } from './commands.js';
import { ST_LABEL } from './sim.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const KIND = {
  detect: { label: '감지', color: 'var(--o-detect)' }, self: { label: '자체 조치', color: 'var(--o-self)' }, report: { label: '보고', color: 'var(--o-report)' },
  decide: { label: '판단', color: 'var(--o-decide)' }, command: { label: '명령', color: 'var(--o-command)' }, act: { label: '조치', color: 'var(--o-act)' },
  notify: { label: '결과 통보', color: 'var(--o-notify)' }, done: { label: '완료', color: 'var(--o-done)' },
};
// 레인 사이 화살표 이름 (이전 단계 → 이번 단계)
const arrowLabel = (a, b) => (a.lane === 'orch' && b.lane === 'cell' ? '명령' : b.kind === 'report' || (a.lane === 'cell' && b.lane === 'orch' && b.kind !== 'notify') ? '보고' : b.kind === 'command' || (a.lane === 'orch' && b.lane === 'exec') ? '명령' : b.lane === 'orch' && b.kind === 'notify' ? '결과 통보' : b.lane === 'orch' ? '완료 보고' : '');

export class OrchView {
  constructor(el, badgeEl) {
    this.el = el; this.badge = badgeEl; this.sel = null; this.showCell = true; this.pendingType = null;
    this.tab = 'flow'; this.built = null; this.target = 'all';
    el.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-tab]'); if (tb) { this.tab = tb.dataset.tab; this.render(); return; }
      const cb = e.target.closest('[data-cmd]');
      if (cb && !cb.disabled) { this.sim.cmd.issue(cb.dataset.cmd, this.target, cb.dataset.arg ? +cb.dataset.arg : null, { by: `${this.sim.orch.name} · 관제 콘솔` }); this.render(); return; }
      const ci = e.target.closest('[data-cinc]'); if (ci) { this.sel = +ci.dataset.cinc; this.tab = 'flow'; this.render(); return; }
      const it = e.target.closest('[data-inc]'); if (it) { this.sel = +it.dataset.inc; this.render(); }
      if (e.target.closest('[data-close]')) this.hide();
    });
    el.addEventListener('change', (e) => {
      if (e.target.id === 'orchShowCell') { this.showCell = e.target.checked; this.render(); }
      if (e.target.id === 'cmdTarget') { this.target = e.target.value; this.render(); }
    });
  }
  attach(sim) {
    this.sim = sim; this.sel = null; this.built = null; this.target = 'all';
    sim.orch.onOpen = (inc) => { if (this.pendingType && inc.type === this.pendingType) { this.sel = inc.id; this.pendingType = null; } };
    this.render();
  }
  get open() { return !this.el.classList.contains('hidden'); }
  show(selectType) {
    this.el.classList.remove('hidden');
    if (selectType === 'cmd') this.tab = 'cmd';
    else if (selectType) { this.tab = 'flow'; const inc = this.sim.orch.incidents.find((i) => i.type === selectType && i.status === 'open'); if (inc) this.sel = inc.id; else this.pendingType = selectType; }
    this.render();
  }
  hide() { this.el.classList.add('hidden'); }
  toggle() { this.open ? this.hide() : this.show(); }

  tick() {
    const n = this.sim?.orch.openCount() ?? 0;
    this.badge.textContent = n ? String(n) : '';
    this.badge.hidden = !n;
    if (this.open) this.render();
  }

  // 머리말·탭·명령 콘솔 틀은 탭이 바뀔 때만 만든다 (선택 상자가 주기 갱신에 닫히지 않게) — 내용만 주기적으로 바꾼다
  build() {
    const o = this.sim.orch;
    this.built = `${this.tab}:${this.sim.mode.key}`;
    const tabs = `<div class="seg small orch-tabs"><button type="button" data-tab="flow" class="${this.tab === 'flow' ? 'on' : ''}">인시던트 흐름</button><button type="button" data-tab="cmd" class="${this.tab === 'cmd' ? 'on' : ''}">명령 콘솔</button></div>`;
    const head = `<div class="orch-h"><b>🛰 ${esc(o.name)}</b>${tabs}<small>${this.tab === 'flow' ? '인시던트 보고 · 판단 · 명령 · 조치 흐름' : '상위 계층 → 셀 현장 긴급·제어 명령'}</small>
      ${this.tab === 'flow' ? `<label class="chk"><input type="checkbox" id="orchShowCell" ${this.showCell ? 'checked' : ''}/> 셀 자체 해결 포함</label>` : ''}
      <button type="button" data-close title="닫기">✕</button></div>`;
    if (this.tab === 'flow') { this.el.innerHTML = head + '<div class="orch-b" data-body></div>'; return; }
    const cells = this.sim.processing.filter((st) => !st.standby).map((st) => `<option value="${esc(st.id)}" ${this.target === st.id ? 'selected' : ''}>${esc(st.name)}</option>`).join('');
    const btn = (code, C, arg) => `<button type="button" class="cb g-${C.group} c-${code}" data-cmd="${code}" ${arg != null ? `data-arg="${arg}"` : ''} title="${esc(C.desc)}"><i>${C.icon}</i>${esc(arg != null ? `${arg}${C.unit}` : C.label)}</button>`;
    const group = (g) => Object.entries(COMMANDS).filter(([, C]) => C.group === g && !C.hidden).map(([code, C]) => C.args
      ? `<div class="cb-args"><span>${C.icon} ${esc(C.label)}</span>${C.args.map((a) => btn(code, C, a)).join('')}</div>` : btn(code, C)).join('');
    this.el.innerHTML = head + `<div class="cmd-b">
      <div class="cmd-ctl">
        <label class="cmd-tg">대상 <select id="cmdTarget"><option value="all" ${this.target === 'all' ? 'selected' : ''}>정밀조립Zone 전체</option>${cells}</select></label>
        <div class="cmd-grp emg"><h4>긴급 명령</h4><div class="cmd-btns">${group('emergency')}</div></div>
        <div class="cmd-grp"><h4>제어 명령</h4><div class="cmd-btns">${group('control')}</div></div>
        <p class="cmd-note" data-link></p>
      </div>
      <div class="cmd-side"><h4>셀 명령 상태</h4><div class="cmd-state" data-state></div><h4>명령 이력 <small>클릭하면 흐름도</small></h4><div class="cmd-hist" data-hist></div></div>
    </div>`;
  }

  // 주기 갱신(0.25초)으로 내용을 다시 그릴 때 스크롤 위치를 지킨다 — 바뀐 것이 없으면 다시 그리지 않는다
  put(el, html, scrollers = []) {
    if (!el || el.dataset.h === html) return;
    const keep = scrollers.map((q) => { const n = q === ':self' ? el : el.querySelector(q); return n ? [q, n.scrollTop, n.scrollLeft] : null; }).filter(Boolean);
    el.innerHTML = html; el.dataset.h = html;
    for (const [q, top, left] of keep) { const n = q === ':self' ? el : el.querySelector(q); if (n) { n.scrollTop = top; n.scrollLeft = left; } }
  }
  render() {
    if (!this.sim || !this.open) return;
    if (this.built !== `${this.tab}:${this.sim.mode.key}`) this.build();
    if (this.tab === 'cmd') return this.renderCmd();
    const o = this.sim.orch;
    // 진행 중 인시던트는 문제 해결 우선순위 순(화재·인명 → 시설 안전 → 생산 정지 → 생산 차질 → 효율·품질), 끝난 것은 최근 순
    const list = o.incidents.filter((i) => this.showCell || !i.cellResolved).sort((a, b) => ((a.status === 'open') ? 0 : 1) - ((b.status === 'open') ? 0 : 1) || (a.status === 'open' && b.status === 'open' ? prioOf(a) - prioOf(b) : 0) || b.t0 - a.t0);
    if (!this.sel || !o.incidents.some((i) => i.id === this.sel)) this.sel = (list.find((i) => i.status === 'open') ?? list[0])?.id ?? null;
    const inc = o.incidents.find((i) => i.id === this.sel);
    const now = this.sim.time;
    const items = list.map((i) => {
      const T = INCIDENT_TYPES[i.type], dur = (i.tEnd ?? now) - i.t0;
      const st = i.status === 'open' ? ['진행 중', 'open'] : i.cellResolved ? ['셀 자체 해결', 'cell'] : ['해결', 'done'];
      return `<button type="button" class="oi ${i.id === this.sel ? 'sel' : ''} st-${st[1]}" data-inc="${i.id}">
        <span class="oi-ic">${T.icon}</span><span class="oi-t"><em class="oi-p p${prioOf(i)}" title="${esc(PRIORITY[prioOf(i)].desc)}">P${prioOf(i)}</em>${esc(i.title)}</span>
        <span class="oi-m">${clock(i.t0)} · ${Math.round(dur)}초</span><span class="oi-s">${st[0]}</span></button>`;
    }).join('') || '<div class="oi-empty">아직 인시던트가 없습니다. ⚡ 설비 고장 주입, ⛔ 자재 공급 차질, ⚠ 현장 이벤트(피지컬AI)로 발생시키거나 명령 콘솔에서 명령을 보내 보세요.</div>';
    this.put(this.el.querySelector('[data-body]'), `<div class="orch-list">${items}</div><div class="orch-flow">${inc ? this.flow(inc, now) : ''}</div>`, ['.orch-list', '.sw-wrap']);
  }

  renderCmd() {
    const s = this.sim, K = s.cmd, all = this.target === 'all';
    if (!all && !s.processing.some((st) => st.id === this.target)) this.target = 'all';
    this.el.querySelectorAll('[data-cmd]').forEach((b) => {
      const C = COMMANDS[b.dataset.cmd];
      b.disabled = !C.scopes.includes(all ? 'all' : 'cell');
      b.classList.toggle('on', b.dataset.cmd === 'SPEED' && (all ? Math.round(K.overrideAll * 100) : Math.round((s.processing.find((x) => x.id === this.target)?.cmd?.override ?? 1) * 100)) === +b.dataset.arg);
    });
    this.el.querySelector('[data-link]').textContent = `전송 경로: ${K.link.via} · 지연 약 ${K.link.delay}초 (비상정지 ${K.link.estop}초)`;
    const flags = [K.estopAll && ['🛑 전체 비상정지', 'bad'], K.pstopAll && ['✋ 전체 보호정지', 'warn'], K.lineSpeed < 1 && [`🐢 이동 속도 ${Math.round(K.lineSpeed * 100)}%`, 'warn'], K.overrideAll !== 1 && [`⏩ 전체 속도 ${Math.round(K.overrideAll * 100)}%`, 'info'], K.feedHold && ['⛔ 투입 정지', 'warn'], K.evac && ['🏃 이동로봇 대피', 'warn']].filter(Boolean);
    const rows = s.processing.filter((st) => !st.standby).map((st) => {
      const k = st.cmd, tags = [];
      if (k?.estop) tags.push(['비상정지', 'bad']);
      if (k?.check > 0) tags.push([`자가진단 ${Math.ceil(k.check)}초`, 'info']);
      if (k?.hold === 'protective') tags.push(['보호정지', 'warn']);
      if (k?.hold === 'cycle') tags.push(['사이클 정지', 'warn']);
      if (k?.safe) tags.push(['감속 25%', 'warn']);
      if (k && k.override !== 1) tags.push([`속도 ${Math.round(k.override * 100)}%`, 'info']);
      return `<div class="cs-row ${this.target === st.id ? 'sel' : ''}"><span>${esc(st.name)}</span><b class="chip s-${st.state}">${esc(ST_LABEL[st.state] ?? st.state)}</b>${tags.filter(([t]) => t !== ST_LABEL[st.state]).map(([t, c]) => `<em class="tg ${c}">${t}</em>`).join('') || (tags.length ? '' : '<em class="tg">정상 운전</em>')}</div>`;
    }).join('');
    this.put(this.el.querySelector('[data-state]'), (flags.length ? `<div class="cs-flags">${flags.map(([t, c]) => `<em class="tg ${c}">${t}</em>`).join('')}</div>` : '') + rows, [':self']);
    const hist = K.list.slice(0, 14).map((c) => {
      const C = COMMANDS[c.code], at = (st) => c.history.find((h) => h.state === st);
      const pipe = ['sent', 'ack', 'done'].map((st) => { const h = at(st); return `<span class="cp ${h ? 'on' : ''}">${CMD_STATE[st]}${h ? ` +${(h.t - c.t).toFixed(1)}s` : ''}</span>`; }).join('<b>›</b>');
      const rej = at('rejected');
      return `<button type="button" class="ch g-${C.group} st-${c.state}" data-cinc="${c.inc?.id ?? ''}">
        <span class="ch-t">#${c.id} ${C.icon} ${esc(s.cmd.label(c))} → ${esc(s.cmd.targetName(c.target))}</span>
        <span class="ch-m">${clock(c.t)} · ${esc(c.by)}${c.why ? ` · ${esc(c.why)}` : ''}</span>
        <span class="ch-p">${rej ? `<span class="cp rej">거부 · ${esc(c.note ?? '')}</span>` : pipe}</span></button>`;
    }).join('') || '<div class="oi-empty">아직 보낸 명령이 없습니다. 왼쪽에서 대상과 명령을 고르세요. 현장 이벤트(사람 진입·연기)가 생기면 오케스트레이터가 자동으로 긴급 명령을 보냅니다.</div>';
    this.put(this.el.querySelector('[data-hist]'), hist, [':self']);
  }

  flow(inc, now) {
    const reached = new Set(inc.steps.map((s) => s.kind));
    const first = (k) => inc.steps.find((s) => s.kind === k);
    const stages = inc.type === 'command' ? STAGES.filter((s) => ['command', 'act', 'done'].includes(s.key)) : STAGES.filter((s) => !(inc.cellResolved && ['report', 'decide', 'command'].includes(s.key)));
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
    return `<div class="of-h"><span>${INCIDENT_TYPES[inc.type].icon} <em class="oi-p p${prioOf(inc)}">${PRIORITY[prioOf(inc)].label}</em> <b>${esc(inc.title)}</b> · 발생 ${clock(inc.t0)} · 출처 ${esc(inc.source)}</span>
        <span class="of-st ${inc.status}">${inc.status === 'open' ? `진행 중 · ${Math.round(dur)}초 경과` : `${inc.cellResolved ? '셀 자체 해결' : '해결'} · 총 ${Math.round(dur)}초`}</span></div>
      <div class="ostp">${stepper}</div><div class="sw-wrap">${svg}</div>`;
  }
}
