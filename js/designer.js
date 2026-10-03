// 공정 설계 도크 (오른쪽 하단) — 자연어 요청(Claude) 또는 직접 편집으로 라인 초안을 만들고,
// 변경 내역·예상 지표를 확인한 뒤 적용한다.
import { STATION_TYPES, ROBOT_KINDS, LAYOUTS, MAX_STATIONS, MAX_ROBOTS, cloneLine, normalizeLine, diffLines, lineMetrics, effCycle, defaultLineFor, isZone, layoutLabel, ZONE_CELLS, ZONE_NAME, ammrAllowed, robotForMode } from './line.js';
import { prepareFile, ACCEPT } from './attachments.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const opts = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(v.label)}</option>`).join('');

export class LineDesigner {
  constructor({ llm, getLine, getMode, onApply }) {
    this.getMode = getMode ?? (() => 'smart');
    this.llm = llm; this.getLine = getLine; this.onApply = onApply;
    this.open = false; this.busy = false;
    this.note = null;   // { summary, warnings, errors, source }
    this.draft = cloneLine(getLine());
    this.cost = 0;
    this.files = [];      // 변환된 첨부 파일

    const picker = $('dockFile');
    picker.accept = ACCEPT;
    $('dockAttach').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { this.addFiles([...picker.files]); picker.value = ''; });
    const dock = $('lineDock');
    dock.addEventListener('dragover', (e) => { e.preventDefault(); dock.classList.add('drop'); });
    dock.addEventListener('dragleave', () => dock.classList.remove('drop'));
    dock.addEventListener('drop', (e) => { e.preventDefault(); dock.classList.remove('drop'); this.addFiles([...e.dataTransfer.files]); });
    $('dockFiles').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-rm]'); if (!b) return;
      this.files.splice(+b.dataset.rm, 1); this.renderFiles();
    });
    $('dockSummary').addEventListener('click', (e) => { if (e.target.closest('[data-open-key]')) $('btnSettings')?.click(); });
    $('lineName').addEventListener('input', (e) => { this.draft.name = e.target.value; this.renderPreview(); });
    $('lineLayout').addEventListener('change', (e) => { this.draft.layout = e.target.value; this.renderPreview(); });

    $('dockToggle').addEventListener('click', () => this.setOpen(!this.open));
    $('dockForm').addEventListener('submit', (e) => { e.preventDefault(); this.ask($('dockInput').value.trim()); });
    $('stAdd').addEventListener('click', () => this.addStation());
    $('dockDefault').addEventListener('click', () => {
      this.draft = defaultLineFor(this.getLine());
      this.note = { summary: `${isZone(this.draft) ? `${ZONE_NAME} 기본 셀 레시피` : '기본 라인'} 초안을 불러왔습니다. 적용을 눌러야 반영됩니다.` };
      this.render();
    });
    $('dockRevert').addEventListener('click', () => { this.draft = cloneLine(this.getLine()); this.note = null; this.render(); });
    $('dockApply').addEventListener('click', () => this.apply());
    const list = $('stList');
    list.addEventListener('input', (e) => this.onField(e));
    list.addEventListener('change', (e) => this.onField(e, true));
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-op]'); if (!b) return;
      const i = +b.closest('.st-card').dataset.i, st = this.draft.stations;
      if (b.dataset.op === 'up' && i > 0) [st[i - 1], st[i]] = [st[i], st[i - 1]];
      if (b.dataset.op === 'down' && i < st.length - 1) [st[i + 1], st[i]] = [st[i], st[i + 1]];
      if (b.dataset.op === 'del') st.splice(i, 1);
      this.render();
    });
    this.render();
  }

  // Claude 연결 상태가 바뀌었을 때(키 저장·삭제) — 남아 있던 '미연결' 안내를 지우고 다시 그린다
  onLLMChange() {
    if (this.llm.available && this.note?.noLLM) {
      this.note = { summary: 'Agent가 연결되었습니다. 요청이나 첨부 파일을 다시 보내 주세요.', applied: true };
    }
    this.render();
  }

  // 외부에서 라인이 바뀌었을 때(적용 직후·시작 시)
  sync() { this.draft = cloneLine(this.getLine()); this.note = null; this.render(); }

  setOpen(on) {
    this.open = on;
    document.body.classList.toggle('dock-open', on);
    this.render();
  }

  addStation() {
    if (this.draft.stations.length >= MAX_STATIONS || isZone(this.draft)) return;
    const n = this.draft.stations.length;
    this.draft.stations.splice(Math.max(0, n - 1), 0, { id: `NEW${n + 1}`, type: 'assembly', name: '신규 조립', robot: { kind: 'cobot', count: 1 }, cycle: 8, task: '부품 체결·조립' });
    this.render();
  }

  onField(e, rerender = false) {
    const el = e.target, card = el.closest('.st-card'); if (!card || !el.dataset.f) return;
    const s = this.draft.stations[+card.dataset.i], f = el.dataset.f;
    if (f === 'name' || f === 'task') s[f] = el.value;
    else if (f === 'type') {
      const prevDefault = STATION_TYPES[s.type];
      s.type = el.value;
      const T = STATION_TYPES[s.type];
      if (!s.task || s.task === prevDefault.task) s.task = T.task;
      s.cycle = T.cycle;
      if (!s.name || s.name === prevDefault.label) s.name = T.label;
    }
    else if (f === 'kind') { if (ROBOT_KINDS[el.value]?.darkOnly && !ammrAllowed(this.getMode())) { this.render(); return; }
      s.robot.kind = el.value; s.robot.count = el.value === 'none' ? 0 : Math.max(1, s.robot.count); }
    else if (f === 'count') s.robot.count = Math.max(0, Math.min(MAX_ROBOTS, Math.round(+el.value || 0)));
    else if (f === 'cycle') s.cycle = +el.value;
    if (rerender || ['type', 'kind', 'count'].includes(f)) this.render(); else this.renderPreview();
  }

  async addFiles(list) {
    for (const f of list.slice(0, 10 - this.files.length)) {
      const slot = { name: f.name, sizeText: '', loading: true };
      this.files.push(slot); this.renderFiles();
      try { Object.assign(slot, await prepareFile(f), { loading: false }); }
      catch (e) { this.files.splice(this.files.indexOf(slot), 1); this.note = { errors: [e.message] }; this.setOpen(true); }
      this.renderFiles();
    }
  }

  renderFiles() {
    $('dockFiles').innerHTML = this.files.map((f, i) => `<span class="chip-file${f.truncated ? ' warn' : ''}" title="${esc(f.note ?? '')}">
      ${f.kind === 'image' ? '🖼' : f.kind === 'pdf' ? '📕' : '📄'} ${esc(f.name)} <small>${f.loading ? '변환 중…' : esc(f.sizeText)}</small>
      <button type="button" data-rm="${i}" title="첨부 취소">✕</button></span>`).join('');
    $('dockFiles').classList.toggle('has', this.files.length > 0);
  }

  needKeyNote() {
    return {
      errors: ['Agent가 연결되어 있지 않아 자연어 요청과 파일 분석을 할 수 없습니다. 아래 목록을 직접 편집하거나 API 키를 설정하세요.'],
      needKey: !!window.jin3d,
      noLLM: true,
    };
  }

  async ask(text) {
    if (this.busy) return;
    const files = this.files.filter((f) => !f.loading);
    if (!text && !files.length) return;
    if (!this.llm.available) { this.note = this.needKeyNote(); this.setOpen(true); return; }
    if (!text) text = '첨부 파일의 공정·레이아웃 내용을 바탕으로 라인 컨셉을 잡아 새 라인을 설계해 줘.';
    this.busy = true; this.setOpen(true);
    $('dockStatus').innerHTML = `<span class="spin"></span>${files.length ? `첨부 ${files.length}개를 분석해 ` : ''}Agent가 공정 컨셉을 설계하는 중… “${esc(text)}”`;
    try {
      const attachments = files.map(({ name, kind, media_type, data, text: t, note }) => ({ name, kind, media_type, data, text: t, note }));
      const res = await fetch('/api/line', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: this.draft, request: text, attachments }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      this.cost += out.costUSD;
      this.draft = out.line;
      this.note = {
        summary: out.summary, extracted: out.extracted, warnings: out.warnings, source: 'claude', request: text,
        files: files.map((f) => f.name),
        errors: out.feasible ? out.errors : [...(out.errors ?? []), '요청을 그대로 반영할 수 없어 초안을 바꾸지 않았습니다.'],
      };
      $('dockInput').value = '';
      this.files = []; this.renderFiles();
    } catch (e) {
      this.note = { errors: [`Agent 요청 실패: ${e.message}`] };
    } finally {
      this.busy = false;
      this.render();
    }
  }

  apply() {
    const { line, errors, warnings } = normalizeLine(this.draft);
    if (errors.length) { this.note = { ...this.note, errors }; this.render(); return; }
    const diff = diffLines(this.getLine(), line);
    if (!diff.length) { this.note = { summary: '바뀐 내용이 없습니다.' }; this.render(); return; }
    this.onApply(line, diff, { warnings, request: this.note?.request, files: this.note?.files });
    this.note = { summary: `적용 완료 — ${diff.length}건 변경. 3D 공장과 시뮬레이션이 새 라인으로 다시 시작되었습니다.`, applied: true };
    this.draft = cloneLine(line);
    this.render();
  }

  render() {
    const cur = this.getLine();
    $('dockLineName').textContent = cur.name;
    $('dockArrow').textContent = this.open ? '▼' : '▲';
    $('lineDock').classList.toggle('open', this.open);
    $('dockInput').placeholder = this.llm.available ? '요청 입력 또는 📎 공정도·레이아웃 파일 첨부' : 'Agent 미연결 — 펼쳐서 직접 편집하거나 API 키 설정';
    $('dockSend').disabled = this.busy;
    if (!this.open) return;
    if (!this.busy) $('dockStatus').innerHTML = '';
    $('lineName').value = this.draft.name ?? '';
    // 정밀조립Zone은 셀이 바닥에 고정되어 있어 레이아웃·셀 구성·순서·유형은 잠그고 레시피만 편집한다
    const zone = isZone(this.draft);
    $('lineLayout').innerHTML = zone
      ? `<option value="zone" selected>${esc(layoutLabel('zone'))}</option>`
      : Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}"${k === (this.draft.layout ?? 'straight') ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
    $('lineLayout').disabled = zone;
    const changed = new Map(diffLines(cur, normalizeLine(this.draft).line).filter((d) => d.id).map((d) => [d.id, d.kind]));
    const mode = this.getMode(), ammrOk = ammrAllowed(mode);
    // AMMR은 피지컬AI 단계에서만 고를 수 있다
    const robotOpts = (sel) => Object.entries(ROBOT_KINDS).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}${v.darkOnly && !ammrOk ? ' disabled' : ''}>${esc(v.label)}${v.darkOnly && !ammrOk ? ' — 피지컬AI 전용' : ''}</option>`).join('');
    $('stList').innerHTML = this.draft.stations.map((s, i) => {
      const tag = changed.get(s.id);
      return `<div class="st-card ${tag ?? ''}" data-i="${i}">
        <div class="r"><b class="no">${zone ? ZONE_CELLS[s.id]?.no ?? i + 1 : i + 1}</b>
          <input data-f="name" value="${esc(s.name)}" maxlength="20" title="공정명" />
          <select data-f="type" title="${zone ? '셀 유형은 고정' : '공정 유형'}" ${zone ? 'disabled' : ''}>${opts(STATION_TYPES, s.type)}</select>
          ${tag ? `<em class="tag">${tag === 'add' ? '추가' : '변경'}</em>` : ''}
          ${zone ? `<span class="ops cell-use" title="셀 용도">${esc(ZONE_CELLS[s.id]?.use ?? '')}</span>` : '<span class="ops"><button data-op="up" title="앞으로">↑</button><button data-op="down" title="뒤로">↓</button><button data-op="del" title="삭제">✕</button></span>'}
        </div>
        <div class="r">
          <select data-f="kind" title="${!ammrOk && ROBOT_KINDS[s.robot.kind]?.darkOnly ? `이 셀은 피지컬AI 단계에서 ${ROBOT_KINDS[s.robot.kind].short} — 레거시·자동화 단계에서는 협동로봇으로 운영` : '로봇 종류'}">${robotOpts(robotForMode(s.robot, mode).kind)}</select>${!ammrOk && ROBOT_KINDS[s.robot.kind]?.darkOnly ? `<small class="ammr-note" title="피지컬AI 단계에서는 ${ROBOT_KINDS[s.robot.kind].short}">피지컬AI: ${ROBOT_KINDS[s.robot.kind].short}</small>` : ''}
          <label>대수<input data-f="count" type="number" min="0" max="${MAX_ROBOTS}" value="${s.robot.count}" ${s.robot.kind === 'none' ? 'disabled' : ''} /></label>
          <label>기준<input data-f="cycle" type="number" min="2" max="40" step="0.5" value="${s.cycle}" />초</label>
          <span class="eff" data-eff="${i}"></span>
        </div>
        <div class="r"><input class="task" data-f="task" value="${esc(s.task)}" maxlength="60" placeholder="이 공정이 하는 일" /></div>
      </div>`;
    }).join('');
    $('stAdd').disabled = this.draft.stations.length >= MAX_STATIONS || zone;
    $('stAdd').title = zone ? `${ZONE_NAME}은 셀 구성이 고정입니다. 사용자 라인에서 공정을 추가할 수 있습니다.` : '';
    this.renderPreview();
  }

  renderPreview() {
    const cur = this.getLine();
    const { line, errors, warnings } = normalizeLine(this.draft);
    const diff = diffLines(cur, line);
    const a = lineMetrics(cur, this.getMode()), b = lineMetrics(line, this.getMode());
    const bn = b.bottleneck?.id;
    line.stations.forEach((s, i) => {
      const el = document.querySelector(`[data-eff="${i}"]`);
      if (el) { el.textContent = `실효 ${effCycle(s, this.getMode()).toFixed(1)}초${s.id === bn ? ' · 병목' : ''}`; el.classList.toggle('bn', s.id === bn); }
    });
    const arrow = (x, y, f = (v) => v) => (f(x) === f(y) ? `<b>${f(y)}</b>` : `${f(x)} → <b>${f(y)}</b>`);
    $('dockMetrics').innerHTML = `
      <div><span>${isZone(line) ? '셀' : '공정'}</span>${arrow(a.stations, b.stations)}</div>
      <div><span>로봇</span>${arrow(a.robots, b.robots)}</div>
      <div><span>병목</span>${arrow(a.bottleneck?.name ?? '-', b.bottleneck?.name ?? '-')}</div>
      <div><span>이론 UPH</span>${arrow(a.uph, b.uph, (v) => Math.round(v))}</div>`;
    const n = this.note ?? {};
    const allErrors = [...(n.errors ?? []), ...errors.filter((e) => !(n.errors ?? []).includes(e))];
    const allWarn = [...new Set([...(n.warnings ?? []), ...warnings])];
    $('dockSummary').innerHTML = [
      n.summary ? `<div class="sum ${n.applied ? 'ok' : ''}">${n.source === 'claude' ? `<b>Agent${n.files?.length ? ' 컨셉' : ''}</b> · ` : ''}${esc(n.summary)}</div>` : '',
      n.extracted?.length ? `<details class="ext" open><summary>📄 파일에서 읽은 내용 (${n.files?.length ?? 0}개 파일)</summary><ul>${n.extracted.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '',
      diff.length ? `<ul class="diff">${diff.map((d) => `<li class="${d.kind}">${esc(d.text)}</li>`).join('')}</ul>` : (n.applied ? '' : '<div class="muted">현재 라인과 같습니다. 요청을 입력하거나 아래 목록을 편집하세요.</div>'),
      allWarn.length ? `<ul class="warn">${allWarn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '',
      allErrors.length ? `<ul class="err">${allErrors.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '',
      n.needKey ? '<button type="button" class="key-link" data-open-key>⚙ Agent API 키 설정 열기 (⌘,)</button>' : '',
    ].join('');
    $('dockApply').disabled = !diff.length || errors.length > 0 || this.busy;
    $('dockApply').textContent = diff.length ? `적용 (${diff.length}건)` : '적용';
    $('dockCost').textContent = this.cost ? `설계 호출 비용 약 $${this.cost.toFixed(3)}` : '';
  }
}
