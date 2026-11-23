// 오케스트레이터 인시던트 흐름 도표 — 인시던트 목록 + 스윔레인 흐름도(현장 감지 · 셀 컨트롤러 · 존 오케스트레이터 · 실행 자원).
// 단계(감지 → 셀 자체 조치 → 상위 보고 → 판단 → 명령 → 조치 → 완료 확인)를 시각과 함께 실시간으로 그린다.
// 제어 흐름 탭은 공정·운영 흐름 분석용이다: 계층(FAC · 오케스트레이터 · 셀 컨트롤러 · 실행 자원 · 현장) 사이를 오간 제어·이벤트 흐름의
// 누적 건수·평균 지연, 공정 흐름(투입 → 셀 → 적재)의 실시간 상태, 인시던트 종류별 단계 지연, 제어·이벤트 흐름 기록을 보여 준다.
// 명령 콘솔 탭에서는 상위 계층이 셀 현장으로 긴급·제어 명령을 보내고, 셀별 명령 상태와 명령 이력(전송 → ACK → 완료)을 본다.
import { LANES, STAGES, INCIDENT_TYPES, PRIORITY, prioOf, FLOW_CLASS_LABEL } from './orchestrator.js';
import { fosHTML, a2aHTML, fosClick } from './fosview.js';
import { unsHTML, unsClick, unsInput } from './unsview.js';
import { COMMANDS, CMD_STATE } from './commands.js';
import { ST_LABEL } from './sim.js';
import { STEP_FLOWS, stepFlowSvg, stepCells } from './stepflow.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const KIND = {
  detect: { label: '감지', color: 'var(--o-detect)' }, self: { label: '자체 조치', color: 'var(--o-self)' }, report: { label: '보고', color: 'var(--o-report)' },
  decide: { label: '판단', color: 'var(--o-decide)' }, command: { label: '명령', color: 'var(--o-command)' }, act: { label: '조치', color: 'var(--o-act)' },
  notify: { label: '결과 통보', color: 'var(--o-notify)' }, done: { label: '완료', color: 'var(--o-done)' },
};
// 레인 사이 화살표 이름 (이전 단계 → 이번 단계)
const TABS = { flow: ['인시던트 흐름', '인시던트 보고 · 판단 · 명령 · 조치 흐름'], ctl: ['제어 흐름', '공정·운영 제어 흐름 · 이벤트 흐름 분석'], cmd: ['명령 콘솔', '상위 계층 → 셀 현장 긴급·제어 명령'], fos: ['FacOS 계층', '공장 · 존 · 셀 · 엣지 오케스트레이터·에이전트 (정밀조립Zone)'], a2a: ['A2A 메시지', '공장 ↔ 존 ↔ 셀 A2A 기록 · 결정 요청 · Agent Gateway 가드레일'], uns: ['UNS 토픽 트리', 'ISA-95 통합 네임스페이스 — FacOS 상태·오더·결정·A2A · 셀 OCS · 명령 4단 (MQTT 5)'] };
const FILTERS = { all: '전체', control: '제어', event: '이벤트' };
const CLS_COLOR = { control: 'var(--o-command)', event: 'var(--o-report)', decision: 'var(--o-decide)' };
const laneLabel = (k) => (k === 'fac' ? 'FAC' : LANES.find((l) => l.key === k)?.label ?? k);
// 공정 흐름 상자 색 (셀 상태)
const ST_TONE = { BUSY: 'good', IDLE: 'idle', STARVED: 'idle', NOAMR: 'warn', BLOCKED: 'warn', FULL: 'warn', HOLD: 'warn', PSTOP: 'warn', CSTOP: 'warn', REFILL: 'info', MAINT: 'info', CHECK: 'info', DOWN: 'bad', ESTOP: 'bad', NOPARTS: 'bad', OFF: 'idle' };
const cut = (t, n) => { const w = [...String(t)]; return w.length > n ? w.slice(0, n - 1).join('') + '…' : t; };
// Zone 전체 명령 상태 (명령 콘솔·공정 흐름 공용)
const zoneFlags = (K) => [K.estopAll && ['🛑 전체 비상정지', 'bad'], K.pstopAll && ['✋ 전체 보호정지', 'warn'], K.lineSpeed < 1 && [`🐢 이동 속도 ${Math.round(K.lineSpeed * 100)}%`, 'warn'], K.overrideAll !== 1 && [`⏩ 전체 속도 ${Math.round(K.overrideAll * 100)}%`, 'info'], K.feedHold && ['⛔ 투입 정지', 'warn'], K.evac && ['🏃 이동로봇 대피', 'warn']].filter(Boolean);
const arrowLabel = (a, b) => (a.lane === 'orch' && b.lane === 'cell' ? '명령' : b.kind === 'report' || (a.lane === 'cell' && b.lane === 'orch' && b.kind !== 'notify') ? '보고' : b.kind === 'command' || (a.lane === 'orch' && b.lane === 'exec') ? '명령' : b.lane === 'orch' && b.kind === 'notify' ? '결과 통보' : b.lane === 'orch' ? '완료 보고' : '');

export class OrchView {
  constructor(el, badgeEl) {
    this.el = el; this.badge = badgeEl; this.sel = null; this.showCell = true; this.pendingType = null;
    this.tab = 'flow'; this.built = null; this.target = 'all'; this.flt = 'all'; this.ctlView = 'steps';
    el.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-tab]'); if (tb) { this.tab = tb.dataset.tab; this.render(); return; }
      if ((this.tab === 'fos' || this.tab === 'a2a') && fosClick(this.sim, e)) { this.render(true); return; }
      if (this.tab === 'uns' && unsClick(this.sim, e)) { this.render(true); return; }
      const fb = e.target.closest('[data-flt]'); if (fb) { this.flt = fb.dataset.flt; this.render(); return; }
      const vb = e.target.closest('[data-cview]'); if (vb) { this.ctlView = vb.dataset.cview; this.render(); return; }
      const jb = e.target.closest('[data-step]'); if (jb) { this.el.querySelector(`[data-stepbox="${jb.dataset.step}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      const cb = e.target.closest('[data-cmd]');
      if (cb && !cb.disabled) { this.sim.cmd.issue(cb.dataset.cmd, this.target, cb.dataset.arg ? +cb.dataset.arg : null, { by: `${this.sim.orch.name} · 관제 콘솔` }); this.render(); return; }
      const ci = e.target.closest('[data-cinc]'); if (ci) { this.sel = +ci.dataset.cinc; this.tab = 'flow'; this.render(); return; }
      const it = e.target.closest('[data-inc]'); if (it) { this.sel = +it.dataset.inc; this.render(); }
      if (e.target.closest('[data-close]')) this.hide();
    });
    el.addEventListener('input', (e) => { if (this.tab === 'uns') unsInput(e); });
    el.addEventListener('change', (e) => {
      if (this.tab === 'uns' && unsInput(e)) { this.render(true); return; }
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
    if (selectType === 'cmd' || selectType === 'ctl') this.tab = selectType;
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

  builtKey() { return `${this.tab}:${this.sim.mode.key}:${this.tab === 'ctl' ? `${this.ctlView}:${this.sim.zone}` : ''}`; }
  // 머리말·탭·명령 콘솔 틀은 탭이 바뀔 때만 만든다 (선택 상자가 주기 갱신에 닫히지 않게) — 내용만 주기적으로 바꾼다
  build() {
    const o = this.sim.orch;
    this.built = this.builtKey();
    this.el.classList.toggle('fos-wide', this.tab === 'fos' || this.tab === 'a2a' || this.tab === 'uns');   // FacOS 계층 · A2A · UNS는 넓게
    const tabs = `<div class="seg small orch-tabs">${Object.entries(TABS).map(([k, [t]]) => `<button type="button" data-tab="${k}" class="${this.tab === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    const flts = `<div class="seg small orch-flt" title="제어: 위 계층 → 아래 계층 명령 · 자체 조치 · 조치 / 이벤트: 아래 계층 → 위 계층 감지 · 보고 · 결과 통보">${Object.entries(FILTERS).map(([k, t]) => `<button type="button" data-flt="${k}" class="${this.flt === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    const head = `<div class="orch-h"><b>🛰 ${esc(o.name)}</b>${tabs}<small>${TABS[this.tab][1]}</small>
      ${this.tab === 'flow' ? `<label class="chk"><input type="checkbox" id="orchShowCell" ${this.showCell ? 'checked' : ''}/> 셀 자체 해결 포함</label>` : ''}${this.tab === 'ctl' ? flts : ''}
      <button type="button" data-close title="닫기">✕</button></div>`;
    if (this.tab === 'flow') { this.el.innerHTML = head + '<div class="orch-b" data-body></div>'; return; }
    if (this.tab === 'fos' || this.tab === 'a2a' || this.tab === 'uns') { this.el.innerHTML = head + '<div class="fos-b" data-fos></div>'; return; }
    const views = `<div class="seg small ctl-views">${[['steps', '공정별 제어 흐름도'], ['analysis', '흐름 분석']].map(([k, t]) => `<button type="button" data-cview="${k}" class="${this.ctlView === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    if (this.tab === 'ctl' && this.ctlView === 'steps') {
      // 셀 단위 공정별 플로우 차트 (적응가공존 Cell 시나리오 [부록] 표현 방식): STEP마다 4레인 흐름도, 셀 상태와 연결
      this.el.innerHTML = head + `<div class="sf-bar">${views}<div class="sf-jump">${STEP_FLOWS.map((st) => `<button type="button" data-step="${st.no}">STEP${st.no} <b data-stepst="${st.no}"></b></button>`).join('')}</div>
        <small>실선 = 레인 안 순서 · <i class="k-control">주황 점선 = 제어(지시·허가)</i> · <i class="k-event">파랑 점선 = 이벤트(회신·보고)</i> · <i class="k-exc">빨강 = 예외·불량 분기</i> · 초록 상자 = 지금 진행 중</small></div>
        <div class="sf-body" data-steps>${STEP_FLOWS.map((st) => `<section class="sf-step" data-stepbox="${st.no}"><h4>STEP${st.no}. ${esc(st.title)} <span data-stepcells="${st.no}"></span></h4><div data-stepsvg="${st.no}"></div></section>`).join('')}</div>`;
      return;
    }
    if (this.tab === 'ctl') {
      this.el.innerHTML = head + `<div class="sf-bar">${views}</div><div class="ctl-b">
        <div class="ctl-main">
          <h4>제어·이벤트 계층 흐름 <small>누적 건수 · 평균 지연 · 선 굵기 = 건수</small></h4>
          <div class="ctl-svg" data-layer></div>
          <h4>공정 흐름 <small>셀 상태 · 선 위 숫자 = 운반 중 대상물 · 진행 중 인시던트·명령</small></h4>
          <div class="ctl-svg" data-proc></div>
        </div>
        <div class="ctl-side">
          <h4>단계 지연 분석 <small>해결된 인시던트 · 발생 후 평균 도달 시간</small></h4>
          <div data-stage></div>
          <h4>흐름 기록 <small>클릭하면 인시던트 흐름</small></h4>
          <div class="ctl-jr" data-journal></div>
        </div>
      </div>`;
      return;
    }
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
  render(force = false) {
    if (!this.sim || !this.open) return;
    if (this.built !== this.builtKey()) this.build();
    if (this.tab === 'cmd') return this.renderCmd();
    if (this.tab === 'ctl') return this.renderCtl();
    if (this.tab === 'uns') { const b = this.el.querySelector('[data-fos]'); if (!force && b?.querySelector('button:hover, .uns-row:hover, .uns-bridge :focus')) return; return this.put(b, unsHTML(this.sim), [':self', '.uns-tree']); }
    if (this.tab === 'fos' || this.tab === 'a2a') { const b = this.el.querySelector('[data-fos]'); if (!force && b?.querySelector('button:hover, .a2a-row:hover')) return; return this.put(b, this.tab === 'fos' ? fosHTML(this.sim) : a2aHTML(this.sim), [':self', '.a2a-list']); }
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
    const flags = zoneFlags(K);
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

  renderCtl() {
    const o = this.sim.orch, f = this.flt;
    this.el.querySelectorAll('[data-flt]').forEach((b) => b.classList.toggle('on', b.dataset.flt === f));
    if (this.ctlView === 'steps') return this.renderSteps();
    this.put(this.el.querySelector('[data-layer]'), this.layerSvg());
    this.put(this.el.querySelector('[data-proc]'), this.procSvg(), [':self']);
    // 단계 지연: 종류별 해결 건수와 발생 후 각 단계까지 평균 시간 (셀 자체 해결은 보고·판단·명령을 건너뛴다)
    const keys = ['report', 'decide', 'command', 'act', 'done'], avg = (S, k) => (S.hit[k] ? `${(S.at[k] / S.hit[k]).toFixed(1)}s` : '–');
    const rows = Object.entries(o.stages).sort((a, b) => b[1].n - a[1].n).map(([type, S]) => `<tr><th>${INCIDENT_TYPES[type]?.icon ?? ''} ${esc(INCIDENT_TYPES[type]?.label ?? type)}</th><td>${S.n}${S.cell ? `<small> (셀 ${S.cell})</small>` : ''}</td>${keys.map((k) => `<td>${avg(S, k)}</td>`).join('')}</tr>`).join('');
    this.put(this.el.querySelector('[data-stage]'), rows
      ? `<table class="ctl-st"><thead><tr><th>종류</th><th>건수</th>${keys.map((k) => `<th>${{ report: '보고', decide: '판단', command: '명령', act: '조치', done: '완료' }[k]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="oi-empty">아직 해결된 인시던트가 없습니다.</div>');
    const jr = o.journal.filter((j) => f === 'all' || j.cls === f).slice(0, 80).map((j) => `<button type="button" class="jr c-${j.cls}" data-cinc="${j.inc}" title="${esc(j.text)}">
        <span class="jr-m">${clock(j.t)} <em style="color:${CLS_COLOR[j.cls]}">${FLOW_CLASS_LABEL[j.cls]}</em> ${j.from && j.from !== j.to ? `${esc(laneLabel(j.from))} → ` : ''}${esc(laneLabel(j.to))} · ${KIND[j.kind]?.label ?? j.kind} <em class="oi-p p${j.prio}">P${j.prio}</em> #${j.inc}</span>
        <span class="jr-t">${esc(j.text)}</span></button>`).join('') || '<div class="oi-empty">아직 기록된 흐름이 없습니다. 고장 주입·공급 차질·현장 이벤트를 발생시키거나 명령 콘솔에서 명령을 보내 보세요.</div>';
    this.put(this.el.querySelector('[data-journal]'), jr, [':self']);
  }

  renderSteps() {
    const s = this.sim;
    if (!s.zone) { this.put(this.el.querySelector('[data-steps]'), '<div class="oi-empty">공정별 제어 흐름도는 정밀조립Zone 라인에서 제공합니다. 왼쪽 위에서 정밀조립Zone (혼류)을 고르세요.</div>'); return; }
    const tone = (state) => ST_TONE[state] ?? 'idle';
    for (const st of STEP_FLOWS) {
      const cells = stepCells(st, s);
      const worst = cells.find((c) => tone(c.state) === 'bad') ?? cells.find((c) => tone(c.state) === 'warn') ?? cells[0];
      const dot = this.el.querySelector(`[data-stepst="${st.no}"]`);
      if (dot) dot.className = `sf-dot t-${worst ? tone(worst.state) : 'idle'}`;
      this.put(this.el.querySelector(`[data-stepcells="${st.no}"]`), cells.map((c) => `<em class="tg sf-c t-${tone(c.state)}">${esc(c.name)} · ${esc(c.label)}</em>`).join(''));
      this.put(this.el.querySelector(`[data-stepsvg="${st.no}"]`), stepFlowSvg(st, s, this.flt));
    }
  }

  // 계층 흐름도: 노드 = FAC(업무 기록) · 오케스트레이터 · 셀 컨트롤러 · 실행 자원 · 현장 감지, 선 = 레인 사이 흐름(제어 실선 · 이벤트 점선 · 판단 보라)
  layerSvg() {
    const s = this.sim, o = s.orch, f = this.flt, W = 640, H = 330, NW = 184, NH = 48;
    const fac = s.fac?.on;
    const N = {
      fac: { x: 320, y: 30, label: 'FAC (FACOS 업무 기록)', sub: '발주·재고·설비보전' },
      orch: { x: 320, y: 120, label: '존 오케스트레이터', sub: o.name },
      cell: { x: 104, y: 210, label: '셀 컨트롤러', sub: '셀 자체 조치' },
      exec: { x: 536, y: 210, label: '실행 자원', sub: '정비·AGV·휴머노이드·사족보행' },
      field: { x: 320, y: 296, label: '현장 감지', sub: '로봇·센서·카메라' },
    };
    if (!fac) delete N.fac;
    const flows = Object.values(o.flows), inner = {}, origin = {};
    for (const x of flows) {
      if (!x.from) (origin[x.to] ??= 0, origin[x.to] += x.n);
      else if (x.from === x.to) { const b = (inner[x.to] ??= { control: 0, event: 0, decision: 0 }); b[x.cls] += x.n; }
    }
    // 같은 방향(레인 → 레인) 흐름은 선 하나로 합친다 — 계층을 건너는 흐름은 방향으로 분류되어 대개 한 종류, 같은 계층(셀 ↔ 실행 자원)만 여러 종류
    const by = {};
    for (const x of flows) {
      if (!x.from || x.from === x.to || !N[x.from] || !N[x.to]) continue;
      const e = (by[`${x.from}>${x.to}`] ??= { from: x.from, to: x.to, n: 0, dt: 0, cls: {}, kinds: {} });
      e.n += x.n; e.dt += x.dt; e.cls[x.cls] = (e.cls[x.cls] ?? 0) + x.n;
      for (const [k, n] of Object.entries(x.kinds)) e.kinds[k] = (e.kinds[k] ?? 0) + n;
    }
    const edges = Object.values(by).map((e) => {
      const cs = Object.entries(e.cls).sort((a, b) => b[1] - a[1]);
      return { ...e, main: cs[0][0], has: cs.map(([c]) => c), label: `${cs.length > 1 ? cs.map(([c, n]) => `${FLOW_CLASS_LABEL[c]} ${n}`).join('·') : `${e.n}건`} · ${(e.dt / e.n).toFixed(1)}s`,   // 종류는 선 색·점선으로 구분 (한 종류면 건수만)
        full: `${cs.map(([c, n]) => `${FLOW_CLASS_LABEL[c]} ${n}`).join(' · ')} · 평균 지연 ${(e.dt / e.n).toFixed(1)}초`,
        tip: Object.entries(e.kinds).map(([k, n]) => `${KIND[k]?.label ?? k} ${n}`).join(' · ') };
    });
    if (fac) {
      const q = s.fac.seq;
      edges.push({ from: 'orch', to: 'fac', main: 'event', has: ['event'], n: q.mr + q.mrp + q.in, label: `정비요청 ${q.mr} · 생산입고 ${q.mrp} · 입고 ${q.in}`, tip: '공장 → FAC: 정비요청·생산 입고·입고 완료 기록' });
      edges.push({ from: 'fac', to: 'orch', main: 'control', has: ['control'], n: q.po + q.int + q.out, label: `발주 ${q.po} · 출고 ${q.int} · 출하 ${q.out}`, tip: 'FAC → 공장: 발주·창고 출고·출하 지시' });
    }
    const max = Math.max(1, ...edges.map((e) => e.n));
    const clip = (a, dx, dy) => { const t = Math.min(NW / 2 / Math.abs(dx || 1e-9), NH / 2 / Math.abs(dy || 1e-9)); return [a.x + dx * t, a.y + dy * t]; };
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" class="sw ctl" role="img" aria-label="제어·이벤트 계층 흐름도">
      <defs>${Object.entries(CLS_COLOR).map(([k, c]) => `<marker id="ca-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('')}</defs>`;
    let labels = '';   // 글자는 선 위에 그린다
    for (const e of edges) {
      const a = N[e.from], b = N[e.to], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), px = -dy / L, py = dx / L;
      const back = !!by[`${e.to}>${e.from}`] || (e.to === 'fac' || e.from === 'fac'), off = back ? 7 : 0;   // 양방향이면 나란히 비켜 그린다 (수직 방향이 진행 방향 기준이라 반대 방향 선은 반대쪽으로 비켜진다)
      const [sx, sy] = clip(a, dx, dy), [ex, ey] = clip(b, -dx, -dy);
      const dim = f !== 'all' && !e.has.includes(f), w = e.n ? 1.2 + 2.6 * Math.sqrt(e.n / max) : 1, C = CLS_COLOR[e.main];
      const x1 = sx + px * off, y1 = sy + py * off, x2 = ex + px * off, y2 = ey + py * off;
      // 글자는 출발 쪽에 두어 반대 방향 글자와 겹치지 않게 · 선 바깥쪽으로 비켜 놓는다 (가로선은 더 출발 쪽으로 — 가운데 세로선과 겹치지 않게)
      const lt = Math.abs(dy) < 1 ? 0.12 : Math.abs(dx) < 1 ? 0.2 : 0.45, lx = x1 + (x2 - x1) * lt + px * Math.sign(off || 1) * 10, ly = y1 + (y2 - y1) * lt + py * Math.sign(off || 1) * 10;
      const anchor = Math.abs(dy) < 1 ? (dx > 0 ? 'start' : 'end') : Math.abs(px) < 0.2 ? 'middle' : (px * Math.sign(off || 1) > 0 ? 'start' : 'end');
      svg += `<g class="ce ${dim ? 'dim' : ''} ${e.n ? '' : 'zero'}"><title>${esc(laneLabel(e.from))} → ${esc(laneLabel(e.to))} · ${esc(e.full ?? e.label)}${e.tip ? `\n${esc(e.tip)}` : ''}</title>
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C}" stroke-width="${w.toFixed(2)}" ${e.main === 'event' ? 'stroke-dasharray="5 3"' : ''} marker-end="url(#ca-${e.main})"/></g>`;
      labels += `<text x="${lx}" y="${ly + 3.5}" text-anchor="${anchor}" class="al ce ${dim ? 'dim' : ''}" style="fill:${C}"><title>${esc(laneLabel(e.from))} → ${esc(laneLabel(e.to))} · ${esc(e.full ?? e.label)}${e.tip ? `\n${esc(e.tip)}` : ''}</title>${esc(e.label)}</text>`;
    }
    for (const [k, n] of Object.entries(N)) {
      const b = inner[k], st = [origin[k] && `발생 ${origin[k]}`, b?.control && `내부 제어 ${b.control}`, b?.event && `내부 이벤트 ${b.event}`, b?.decision && `${k === 'orch' ? '판단·완료' : '완료'} ${b.decision}`].filter(Boolean).join(' · ');
      svg += `<g class="cn l-${k}"><title>${esc(n.label)} — ${esc(n.sub)}${st ? `\n${esc(st)}` : ''}</title><rect x="${n.x - NW / 2}" y="${n.y - NH / 2}" width="${NW}" height="${NH}" rx="8"/>
        <text x="${n.x}" y="${n.y - 9}" text-anchor="middle" class="ln">${esc(n.label)}</text>
        <text x="${n.x}" y="${n.y + 4}" text-anchor="middle" class="ls">${esc(cut(n.sub, 26))}</text>
        <text x="${n.x}" y="${n.y + 17}" text-anchor="middle" class="cnn">${esc(st)}</text></g>`;
    }
    svg += labels + `<g class="cl" transform="translate(8 ${H - 6})"><text class="ls">주황 실선 = 제어 (아래로: 명령·조치) · 파랑 점선 = 이벤트 (위로: 감지·보고·결과 통보) · 숫자 = 누적 건수 · 평균 지연 (마우스를 올리면 내역)</text></g></svg>`;
    return svg;
  }

  // 공정 흐름도: 투입 → 셀 → 적재 연결 그래프 (분기·합류는 층으로 정렬). 상자 = 셀 상태 · 선 = 운반 중 대상물
  procSvg() {
    const s = this.sim, o = s.orch, K = s.cmd, src = s.stations[0], sink = s.stations[s.stations.length - 1];
    // 층: 투입에서 가장 긴 경로 길이 (합류 지점이 뒤 층에 오게)
    const depth = new Map([[src, 0]]);
    for (let k = 0; k < s.stations.length; k++) for (const c of s.conveyors) if (depth.has(c.from)) depth.set(c.to, Math.max(depth.get(c.to) ?? 0, depth.get(c.from) + 1));
    const cols = [];
    for (const [st, d] of depth) (cols[d] ??= []).push(st);
    cols.forEach((c) => c.sort((a, b) => a.idx - b.idx));
    const rows = Math.max(...cols.map((c) => c.length)), CW = 132, RH = 64, BW = 98, BH = 50, W = cols.length * CW, top = 6, H = top + rows * RH;
    const pos = new Map();
    cols.forEach((c, i) => c.forEach((st, j) => pos.set(st, { x: i * CW + CW / 2, y: top + (rows - c.length) * RH / 2 + j * RH + RH / 2 })));
    const openInc = (st) => o.incidents.find((i) => i.status === 'open' && (i.key === `fail:${st.id}` || i.key === `rack:${st.id}` || i.key === `cal:${st.id}` || (st === src && i.key === 'supply')));
    const cmdOn = (st) => K.active().find((c) => c.target === st.id);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:${Math.min(W, 560)}px" class="sw ctl proc" role="img" aria-label="공정 흐름도">
      <defs><marker id="pa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--o-line)"/></marker></defs>`;
    for (const c of s.conveyors) {
      const a = pos.get(c.from), b = pos.get(c.to);
      if (!a || !b) continue;
      const sx = a.x + BW / 2, ex = b.x - BW / 2, mx = (sx + ex) / 2, n = c.items.length;
      svg += `<path d="M${sx},${a.y} C${mx},${a.y} ${mx},${b.y} ${ex},${b.y}" class="ar ${n ? 'busy' : ''}" marker-end="url(#pa)"/>`;
      if (n) svg += `<g class="pq"><title>운반 중 ${s.useAMR ? 'AMR' : '대상물'} ${n}${s.useAMR ? '대' : '개'}</title><circle cx="${mx}" cy="${(a.y + b.y) / 2}" r="7"/><text x="${mx}" y="${(a.y + b.y) / 2 + 3.2}" text-anchor="middle">${n}</text></g>`;
    }
    for (const [st, p] of pos) {
      const tone = ST_TONE[st.state] ?? 'idle', inc = openInc(st), cm = cmdOn(st);
      const done = st === src ? `투입 ${s.stats.released}` : st === sink ? `적재 ${st.c.processed}` : `처리 ${st.c.processed}${st.c.fails ? ` · 고장 ${st.c.fails}` : ''}`;
      const tags = [st.cmd?.estop && '비상정지', st.cmd?.hold === 'protective' && '보호정지', st.cmd?.hold === 'cycle' && '사이클정지', st.cmd?.safe && '감속', st.cmd && st.cmd.override !== 1 && `속도 ${Math.round(st.cmd.override * 100)}%`].filter(Boolean);
      const mark = inc ? `${INCIDENT_TYPES[inc.type].icon} ` : cm ? `${COMMANDS[cm.code].icon} ` : '';
      svg += `<g class="pn t-${tone} ${inc ? 'inc' : ''}" ${inc ? `data-cinc="${inc.id}"` : ''}><title>${esc(st.name)} · ${esc(ST_LABEL[st.state] ?? st.state)} · ${esc(done)}${tags.length ? ` · ${tags.join(' · ')}` : ''}${inc ? `\n진행 중: ${esc(inc.title)} (클릭하면 인시던트 흐름)` : ''}${cm ? `\n명령 #${cm.id} ${esc(K.label(cm))} · ${CMD_STATE[cm.state]}` : ''}</title>
        <rect x="${p.x - BW / 2}" y="${p.y - BH / 2}" width="${BW}" height="${BH}" rx="7"/>
        <text x="${p.x}" y="${p.y - 10}" text-anchor="middle" class="pt">${esc(mark + cut(st.name, 9))}</text>
        <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" class="ps">${esc(ST_LABEL[st.state] ?? st.state)}${tags.length ? ` · ${esc(tags[0])}` : ''}</text>
        <text x="${p.x}" y="${p.y + 17}" text-anchor="middle" class="pc">${esc(done)}</text></g>`;
    }
    svg += `</svg>`;
    const flags = zoneFlags(K);
    return (flags.length ? `<div class="cs-flags">${flags.map(([t, c]) => `<em class="tg ${c}">${t}</em>`).join('')}</div>` : '') + svg;
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
