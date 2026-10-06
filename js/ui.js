// HTML 오버레이 UI — KPI, 추이 차트, 에이전트 로그, 설비 상세, 모드 비교
import { Simulation, MODES, ST_LABEL, RAW_CAP, FG_CAP } from './sim.js';
import { STATION_TYPES, ROBOT_KINDS } from './line.js';
import { FactoryAgent } from './agent.js';

const $ = (id) => document.getElementById(id);
const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (v) => Math.round(v).toLocaleString('ko-KR');
const JOINT_COLORS = ['#37a0ff', '#3ddc84', '#f5b82e', '#ff6b6b', '#b89bff', '#2bd4c6', '#ff9a3d', '#e86bd0'];

const MODE_DESC = {
  traditional: ['1단계 · 레거시 공장', '사람이 일하고 사람이 판단합니다. 작업자 수작업과 고정 컨베이어·지게차 물류, 고장 후에야 대응하는 사후보전, 육안 검사, Push형 투입으로 재공이 쌓입니다.'],
  smart: ['2단계 · 자동화 공장', '로봇·AMR이 일하고 사람이 감시합니다. 양쪽 협동로봇 셀, AMR 운반, IoT·MES·디지털트윈 연결로 예지보전·Pull 투입·SPC 보정을 자동 수행하고, 소수 인원이 모니터링·정비합니다.'],
  dark: ['3단계 · 피지컬AI 자율공장', 'AI가 판단하고 로봇의 몸으로 실행합니다. 휴머노이드가 정비·부품 보충을, 사족보행 로봇이 열화상·진동 순찰 점검을 맡고, 고효율 LED 조명 아래 24시간 무인 가동합니다. 사람은 원격 관제만 합니다.'],
};

function fmtClock(t) {
  const s = Math.floor(t) + 8 * 3600;
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60;
  return `${d ? `D+${d} ` : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export class UI {
  constructor() {
    this.lastLogId = 0;
    this.onDetailAction = null;
    this.detailSt = null;
    for (const id of ['chartUph', 'chartOee']) {
      const c = $(id);
      c.addEventListener('pointermove', (e) => { c._hx = e.offsetX / c.clientWidth; });
      c.addEventListener('pointerleave', () => { c._hx = null; });
    }
    $('detail').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b && this.onDetailAction) this.onDetailAction(b.dataset.act, this.detailSt);
    });
  }

  reset(sim, agent) {
    this.sim = sim; this.agent = agent;
    this.lastLogId = 0;
    $('log').innerHTML = '';
    const [t, d] = MODE_DESC[sim.mode.key];
    $('modeDesc').innerHTML = `<b>${t}</b>${d}`;
    $('agentName').textContent = agent.name;
    this.renderEngine();
    $('agentAvatar').textContent = sim.mode.agentActive ? 'AI' : '반장';
    const pill = $('agentPill');
    pill.textContent = sim.mode.agentActive ? '자율 운영' : '수동';
    pill.classList.toggle('off', !sim.mode.agentActive);
    this.update();
  }

  update() {
    const sim = this.sim, k = sim.kpi();
    const imp = k.impact, top = imp?.rows.find((r) => r.oeePts > 0.001), hzWip = imp?.rows.find((r) => r.key === 'hazard')?.wip ?? 0, pend = sim.impact?.advisor.pending ?? [], best = [...pend].sort((a, b) => (b.twin?.recommend === 'apply' ? (b.twin.uphCand - b.twin.uphCur) / Math.max(1, b.twin.uphCur) + 1 : 0) - (a.twin?.recommend === 'apply' ? (a.twin.uphCand - a.twin.uphCur) / Math.max(1, a.twin.uphCur) + 1 : 0))[0];
    $('clock').textContent = fmtClock(sim.time);
    const kpi = (label, val, unit = '', sub = '', cls = '') =>
      `<div class="kpi ${cls}"><div class="k">${label}</div><div class="v">${val}<small>${unit}</small></div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    $('kpis').innerHTML = [
      kpi('양품 생산', num(k.good), '개', sim.zone ? `도어트림 ${num(sim.stats.goodBy.doortrim ?? 0)} · e-axle ${num(sim.stats.goodBy.eaxle ?? 0)}` : `출하 ${num(k.shipped)}개`),
      kpi('시간당 생산', num(k.uphRecent), 'UPH', `누적 평균 ${num(k.uph)}`),
      `<div class="kpi wide"><div class="k">설비종합효율 OEE</div><div class="v">${pct(k.OEE)}</div>
        ${top ? `<div class="imp-top1">손실 1위 ${top.label} −${(top.oeePts * 100).toFixed(1)}%p · UPH −${Math.round(top.uph)}</div>` : ''}
        <div class="apq"><div>가용률 ${pct(k.A, 0)}<i style="--w:${k.A * 100}%"></i></div><div>성능 ${pct(k.P, 0)}<i style="--w:${k.P * 100}%"></i></div><div>품질 ${pct(k.Q, 1)}<i style="--w:${k.Q * 100}%"></i></div></div></div>`,
      kpi('불량 유출', num(k.ppm), 'ppm', `검출·배출 ${k.rejected}개`),
      kpi('재공 WIP', k.wip, '개', `평균 ${k.avgWip.toFixed(1)}${imp && hzWip > 0.005 ? ` · 이벤트 +${hzWip.toFixed(2)}` : ''}`),
      kpi('전력', k.powerKW.toFixed(0), 'kW', `${k.kwhPerUnit.toFixed(2)} kWh/개${imp ? ` · 낭비 ${imp.kpi.wasteKwh.toFixed(1)}kWh` : ''}`),
      kpi('현장 인원', k.people, '명', sim.mode.key === 'dark' ? `휴머노이드 ${sim.techs.length + sim.helpers.length} · 사족보행 ${sim.quads.length}` : sim.mode.key === 'smart' ? '모니터링 중심' : '공정별 배치'),
      kpi('고장', k.failures, '회', `예지정비 ${k.pm} · 보정 ${k.cal}`),
      kpi('자재 / 완제품', `${k.raw}`, `/${RAW_CAP}`, `완제품 ${k.fg}/${FG_CAP}${sim.supplyDisrupted ? ' · <span style="color:#ff8a8a">공급 차질</span>' : ''}`),
      // 의사결정 지원: 개선 제안이 있으면 적용 여부를 묻는다 (누르면 KPI 영향·개선 창)
      pend.length ? `<div class="kpi wide imp-pend" data-open-impact>💡 개선 제안 ${pend.length}건 — ${best.title}${best.twin?.recommend === 'apply' ? ` (트윈 검증 UPH ${Math.round(best.twin.uphCur)} → ${Math.round(best.twin.uphCand)})` : ''} · <b>적용하시겠습니까?</b></div>` : '',
    ].join('');
    $('uphNow').textContent = num(k.uphRecent);
    $('oeeNow').textContent = pct(k.OEE);
    this.drawSpark($('chartUph'), sim.history.map((h) => [h.t, h.uph]), (v) => num(v) + ' UPH', 0);
    this.drawSpark($('chartOee'), sim.history.map((h) => [h.t, h.oee * 100]), (v) => v.toFixed(1) + '%', 0, 100);

    $('agentCount').textContent = this.agent.decisions;
    this.renderEngine();
    $('thought').innerHTML = this.llm?.enabled
      ? `<b>운영</b> · ${this.agent.arch === 'hybrid' ? (() => { const H = this.agent.status(); return `혼합형 다중 에이전트 — 정비·품질·흐름 에이전트 제안 ${H.proposed} · 메인 승인 ${H.approved} · 보류 ${H.deferred} · 충돌 ${H.conflicts} · 평균 지연 ${H.avgLat.toFixed(1)}초`; })() : '추론 기반 에이전트가 정비·품질·흐름·물류를 계속 판단합니다'} — ${this.agent.lastThought}<br><b>대화</b> · 입력창 지시를 해석해 공정에 반영합니다 (예: 포장셀 속도 75% · 도어트림 2:1 · e-axle 조립셀 예방정비)`
      : sim.mode.agentActive
      ? `<b>현재 판단</b> · ${this.agent.lastThought}`
      : '<b>수동 운영</b> · 설비 데이터가 수집되지 않아 고장·자재 부족을 사람이 발견한 뒤에 대응합니다.';
    this.renderLogs();
    if (this.detailSt) this.renderDetail();
  }

  renderLogs() {
    const fresh = this.sim.logs.filter((l) => l.id > this.lastLogId).reverse();
    if (!fresh.length) return;
    const box = $('log');
    for (const l of fresh) {
      const d = document.createElement('div');
      d.className = 'entry ' + l.level + (l.dlg ? ' dlg' : '');
      if (l.dlg) { d.dataset.dlg = l.dlg; d.title = '누르면 지시 게이트(판정·수행/거절 과정) 도식'; }
      const row = (tag, txt) => (txt ? `<div class="r"><em>${tag}</em>${esc(txt)}</div>` : '');
      const tags = l.level === 'llm' ? ['지시', 'Agent', '결과'] : l.level === 'chat' ? ['운영자'] : l.level === 'dialog' ? ['지시', '해석', '반영'] : ['관찰', '판단', '실행'];
      const tg = l.level === 'dialog' ? ['지시', '게이트', '판정'] : tags;
      d.innerHTML = `<div class="h"><span>${esc(l.title)}</span><time>${fmtClock(l.t)}</time></div>${row(tg[0], l.obs)}${row(tg[1] ?? '판단', l.dec)}${row(tg[2] ?? '실행', l.act)}${l.dlg && l.level === 'dialog' ? '<div class="g-hint">▸ 게이트 도식 보기</div>' : ''}`;
      box.prepend(d);
    }
    this.lastLogId = this.sim.logs[0].id;
    while (box.children.length > 80) box.lastChild.remove();
  }

  renderEngine() {
    const llm = this.llm, sim = this.sim;
    if (!llm || !sim) return;
    const seg = $('engineSeg');
    const canLLM = sim.mode.agentActive;   // 대화 기반: 내장 해석기로 언제나 사용 (Claude는 연결되어 있으면 보조)
    seg.querySelector('[data-engine="llm"]').disabled = !canLLM;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.engine === 'llm') === llm.enabled));
    document.body.classList.toggle('llm-on', llm.enabled);
    $('agentName').textContent = llm.enabled ? `${this.agent.name} · 대화 기반` : this.agent.name;
    $('agentAvatar').textContent = llm.enabled ? '💬' : sim.mode.agentActive ? 'AI' : '반장';
    $('chatInput').disabled = $('chatSend').disabled = !llm.enabled;
    const st = $('llmStatus');
    st.classList.toggle('busy', llm.inFlight);
    let msg;
    const helper = llm.available ? `Agent 연결됨` : '내장 해석기 (Agent 미연결)';
    if (!sim.mode.agentActive) msg = '레거시 공장은 데이터 수집이 없어 대화 기반을 쓸 수 없습니다';
    else if (!llm.enabled) msg = `대화 기반: 추론 기반 운영 + 입력 지시 해석·반영 · ${helper}`;
    else if (llm.inFlight || llm.calls) msg = `${llm.inFlight ? '' : '대기 · '}${llm.status || '준비'} · Agent 해석 ${llm.calls}회 · 약 $${llm.costUSD.toFixed(3)}`;
    else msg = `대화 기반 · 입력창 지시를 공정에 반영합니다 · ${helper}`;
    st.innerHTML = (llm.inFlight ? '<span class="spin"></span>' : '') + esc(msg);
  }

  // 단일 시리즈 스파크라인 + 호버 판독
  drawSpark(c, pts, fmt, min0 = 0, max0 = null) {
    const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (pts.length < 2) {
      g.fillStyle = '#6c7a89'; g.font = '11px sans-serif'; g.fillText('데이터 수집 중…', 6, H / 2 + 4);
      return;
    }
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const hi = max0 ?? (Math.max(...pts.map((p) => p[1])) * 1.15 || 1);
    const lo = min0;
    const X = (t) => 4 + ((t - t0) / (t1 - t0 || 1)) * (W - 8);
    const Y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 10);
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
    for (const f of [0.5, 1]) { const y = Y(lo + (hi - lo) * f); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(55,160,255,0.28)'); grad.addColorStop(1, 'rgba(55,160,255,0)');
    g.beginPath(); pts.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v))));
    g.lineTo(X(t1), H); g.lineTo(X(t0), H); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); pts.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v))));
    g.strokeStyle = '#37a0ff'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    let idx = pts.length - 1;
    if (c._hx != null) idx = Math.round(Math.max(0, Math.min(1, c._hx)) * (pts.length - 1));
    const [ht, hv] = pts[idx];
    const x = X(ht), y = Y(hv);
    if (c._hx != null) { g.strokeStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    g.fillStyle = '#37a0ff'; g.strokeStyle = '#10161e'; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); g.stroke();
    if (c._hx != null) {
      const label = `${fmtClock(ht)}  ${fmt(hv)}`;
      g.font = '11px sans-serif';
      const w = g.measureText(label).width + 10;
      const lx = Math.min(W - w, Math.max(0, x - w / 2));
      g.fillStyle = 'rgba(10,14,20,0.9)'; g.fillRect(lx, 0, w, 17);
      g.fillStyle = '#e8edf2'; g.fillText(label, lx + 5, 12);
    }
  }

  showDetail(st) { this.robotMode = false; $('detail').classList.remove('robot'); this.detailSt = st; $('detail').classList.remove('hidden'); this.renderDetail(); }
  hideDetail() { this.detailSt = null; this.robotMode = false; $('detail').classList.add('hidden'); $('detail').classList.remove('robot'); }

  // ── 로봇 텔레메트리 패널 (관절·센서 실시간) ─────────────────
  showRobot() {
    this.detailSt = null; this.robotMode = true;
    const el = $('detail');
    el.classList.remove('hidden'); el.classList.add('robot');
    el.innerHTML = `<h3><span id="rbTitle">로봇</span><button data-act="close">✕</button></h3>
      <div class="rb-status" id="rbStatus"></div>
      <div class="rb-cam" id="rbCamBox" hidden><div class="rb-camtabs" id="rbCamTabs"></div><canvas id="rbCam" width="480" height="270"></canvas><small class="rb-rec" id="rbRec"></small></div>
      <div id="rbJoints"></div>
      <canvas id="rbChart" width="640" height="150"></canvas>
      <div id="rbSections"></div>
      <div class="pcap-box" id="pcapBox"></div>
      <div class="rb-save">
        <div class="rb-h">💾 누적 데이터 저장 (AAS)</div>
        <div class="rb-count" id="rbCount"></div>
        <div class="rb-save-row">
          <select id="rbFmt" title="저장 형식">
            <option value="aasx">AASX 패키지 (AAS Part 5, 권장)</option>
            <option value="json">AAS JSON</option>
            <option value="xml">AAS XML</option>
            <option value="rdf">AAS RDF (Turtle)</option>
          </select>
          <select id="rbVer" title="AAS 메타모델 버전 — XML·RDF 네임스페이스 (3.1: BaSyx SDK 2.x 등 최신 도구 · 3.0: 구버전 도구)">
            <option value="3.1">AAS v3.1</option>
            <option value="3.0">AAS v3.0</option>
          </select>
          <button type="button" data-act="robotSave">저장</button>
        </div>
        <div class="rb-save-note" id="rbSaveNote"></div>
      </div>
      <div class="rb-note">관절값·위치·속도는 3D 모델에서 매 프레임 읽은 값이고, 토크·온도·전류·센서값은 움직임·부하·설비 상태로 계산한 시뮬레이션 값입니다.</div>`;
    this.onDetailRendered?.();
  }
  robotSaved(text) { const el = $('rbSaveNote'); if (el) el.textContent = text; }
  renderRobot(d, counts) {
    if (!this.robotMode) return;
    if (counts && $('rbCount')) $('rbCount').innerHTML = `AAS 자산 <b>${esc(counts.assetId)}</b> · 운영 기록 <b>${counts.op.toLocaleString()}</b>개 (실행 시작부터 ${counts.interval}초 간격) · 정밀 기록 <b>${counts.detail.toLocaleString()}</b>개 (로봇 선택 후 1초 간격)`;
    if (!d) { $('rbTitle').textContent = '선택한 로봇이 현재 화면에 없습니다'; return; }
    $('rbTitle').textContent = d.title;
    const row = ([k, v, cls]) => `<span>${esc(k)}</span><b class="${cls ?? ''}">${esc(v)}</b>`;
    $('rbStatus').innerHTML = `<div class="grid">${d.status.map(row).join('')}</div>`;
    const J = d.joints ?? [];
    $('rbJoints').innerHTML = J.length ? `<table class="rb-j"><thead><tr><th></th><th>관절</th><th>위치</th><th>속도</th><th>토크</th><th>온도</th></tr></thead><tbody>${J.map((j, i) => {
      const u = j.unit === 'deg' ? '°' : 'mm', vu = j.unit === 'deg' ? '°/s' : 'mm/s';
      const tq = j.torque ?? 0;
      return `<tr><td><i class="dot" style="background:${JOINT_COLORS[i % JOINT_COLORS.length]}"></i></td><td>${esc(j.name)}</td>
        <td class="num">${(Math.abs(j.value) < 0.05 ? 0 : j.value).toFixed(1)}${u}<div class="rng"><i style="left:${Math.max(0, Math.min(100, j.frac * 100))}%"></i></div></td>
        <td class="num">${(Math.abs(j.vel) < 0.5 ? 0 : j.vel).toFixed(0)}${vu}</td>
        <td class="num"><div class="tq"><i style="width:${tq}%;background:${tq > 80 ? '#ff5a5a' : tq > 60 ? '#f5b82e' : '#3ddc84'}"></i></div>${tq.toFixed(0)}%</td>
        <td class="num ${j.temp > 60 ? 'warn' : ''}">${j.temp != null ? j.temp.toFixed(1) + '°C' : '-'}</td></tr>`;
    }).join('')}</tbody></table>` : '';
    $('rbChart').style.display = J.length ? '' : 'none';
    if (J.length) this.drawJointChart($('rbChart'), d.hist);
    $('rbSections').innerHTML = d.sections.map((sec) => `<div class="rb-sec"><div class="rb-h">${esc(sec.title)}</div><div class="grid">${sec.rows.map(row).join('')}</div></div>`).join('');
  }
  drawJointChart(c, hist) {
    const g = c.getContext('2d'), w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (h * i) / 4); g.lineTo(w, (h * i) / 4); g.stroke(); }
    g.fillStyle = 'rgba(169,180,192,0.8)'; g.font = '18px sans-serif';
    g.fillText('관절 위치 추이 (가동 범위 대비, 최근 12초)', 8, 20);
    if (hist.length < 2) return;
    const n = hist[0].length, N = 120;
    for (let j = 0; j < n; j++) {
      g.strokeStyle = JOINT_COLORS[j % JOINT_COLORS.length]; g.lineWidth = 2.5; g.beginPath();
      hist.forEach((row, i) => {
        const x = w - ((hist.length - 1 - i) / (N - 1)) * w, y = h - 6 - Math.max(0, Math.min(1, row[j])) * (h - 32);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    }
  }

  // Odoo 설비보전: 이 설비의 정비요청 이력 (설비 등록 일련번호 · 진행 중 요청 · 최근 요청)
  erpLine(st) {
    const E = this.sim.erp; if (!E?.on) return '';
    const e = E.equipmentOf(st.id) ?? E.equipmentOf(st.uid), mrs = E.db.mr.filter((m) => m.equipment === e?.serial_no);
    if (!e) return '';
    const open = mrs.find((m) => m.stage !== 'done'), last = mrs[0];
    return `<div class="note">🏢 Odoo 설비보전 · 설비 ${esc(e.serial_no)} — 정비요청 ${mrs.length}건 (누적 ${Math.round(e.downtime * 60)}분)${open ? ` · <b>${open.ref} ${open.type === 'corrective' ? '긴급' : '예방'} ${open.stage === 'progress' ? '진행 중' : '신규'}</b>` : last ? ` · 최근 ${last.ref} 완료` : ''}</div>`;
  }
  renderDetail() {
    const st = this.detailSt, sim = this.sim;
    const el = $('detail');
    if (st.standby) {
      const u = st.def.usedBy;
      el.innerHTML = `<h3>${esc(st.name)}<button data-act="close">✕</button></h3>
        <div class="task">${st.def.cycle ? `${STATION_TYPES[st.type].label} · ` : ''}미사용 — ${esc(u.customer)} ${esc(u.label)} 시나리오 전용${st.def.task ? `<br>하는 일: ${esc(st.def.task)}` : ''}</div>
        <div class="note">현재 시나리오의 셀 경로에 포함되지 않아 정지 상태입니다. 왼쪽 위 ${esc(u.label)} 시나리오로 전환하면 가동됩니다.</div>`;
      return;
    }
    if (!st.def.cycle) {
      const isSrc = st.type === 'source';
      el.innerHTML = `<h3>${st.name}<button data-act="close">✕</button></h3>
        <div class="grid"><span>상태</span><b>${ST_LABEL[st.state]}</b>
        <span>${isSrc ? '자재 재고' : '완제품 적재'}</span><b>${isSrc ? `${sim.rawStock}/${RAW_CAP}` : `${sim.fgStock}/${FG_CAP}`}</b>
        <span>${isSrc ? '투입 간격' : '누적 입고'}</span><b>${isSrc ? sim.releaseInterval.toFixed(1) + '초' : st.c.processed + '개'}</b>
        <span>${isSrc ? '운송 중' : '출하 완료'}</span><b>${isSrc ? sim.inboundRaw + '개' : sim.stats.shipped + '개'}</b></div>`;
      return;
    }
    const a = sim.assess(st);
    const col = st.health > 60 ? '#3ddc84' : st.health > 40 ? '#f5b82e' : '#ff5a5a';
    const rep = st.state === 'DOWN' || st.state === 'MAINT'
      ? `<span>남은 작업</span><b>${st.techOnSite ? Math.max(0, st.repairRemaining).toFixed(0) + '초' : '인력 이동 중'}</b>` : '';
    const rb = st.def.robot.count ? `${ROBOT_KINDS[st.def.robot.kind].label} ${st.def.robot.count}대${sim.mode.key === 'traditional' ? ' → 수작업' : ''}` : '로봇 없음';
    el.innerHTML = `<h3>${esc(st.name)}<button data-act="close">✕</button></h3>
      <div class="task">${STATION_TYPES[st.type].label} · ${rb}<br>하는 일: ${esc(st.def.task)}</div>
      <div class="bar"><i style="width:${st.health}%;background:${col}"></i></div>
      <div class="grid">
        <span>상태</span><b>${ST_LABEL[st.state]}${st.speedMul < 1 ? ' · 고속' : ''}${st.powerSave ? ' · 절전' : ''}</b>
        <span>건강도</span><b>${st.health.toFixed(1)}%</b>
        <span>잔여수명 RUL</span><b>${a.rul.toFixed(0)}분</b>
        <span>10분 고장확률</span><b>${pct(a.risk10)}</b>
        <span>공정능력 Cpk</span><b>${a.cpk.toFixed(2)}</b>
        <span>가동률</span><b>${pct(a.util)}</b>
        <span>사이클</span><b>${(st.def.cycle * sim.mode.cycleMul * st.speedMul).toFixed(1)}초</b>
        <span>처리 / 불량</span><b>${st.c.processed} / ${st.c.defects}</b>
        <span>고장 횟수</span><b>${st.c.fails}</b>
        ${st.parts != null ? `<span>부품 재고</span><b>${st.parts}/${sim.mode.partsCap}${st.partsReq ? (st.partsReq.helper ? ' · 보충 중' : ' · 보충 요청') : ''}</b>` : ''}
        ${st.lastScan != null ? `<span>최근 순찰 점검</span><b>${Math.round((sim.time - st.lastScan) / 60)}분 전</b>` : ''}
        <span>고장·정비 시간</span><b>${Math.round(st.c.down + st.c.maint)}초</b>
        ${rep}
      </div>
      ${sim.mode.key === 'traditional' ? '<div class="note">※ 레거시 공장에는 센서가 없어 건강도·RUL은 현장에서 보이지 않는 시뮬레이션 내부값입니다.</div>' : ''}
      ${this.erpLine(st)}
      <div class="btns"><button data-act="fault">⚡ 고장 주입</button><button data-act="pm">🔧 정비 지시</button></div>
      <div class="pcap-box" id="pcapBox"></div>`;
    this.onDetailRendered?.();
  }

  // 3개 단계 헤드리스 시뮬레이션 (동일 시드, 8시간) — 같은 라인이면 결과를 재사용한다
  computeCompare(seed, line, HOURS = 8) {
    const sig = JSON.stringify([seed, line]);
    if (this.cmpCache?.sig === sig) return this.cmpCache.res;
    const res = {};
    for (const key of Object.keys(MODES)) {
      const s = new Simulation(key, seed, { quiet: true, line }), ag = new FactoryAgent(s);
      for (let i = 0; i < (HOURS * 3600) / 0.25; i++) { s.step(0.25); ag.update(0.25); }
      res[key] = { k: s.kpi(), decisions: ag.decisions };
    }
    this.cmpCache = { sig, res };
    return res;
  }
  cachedCompare(seed, line) { return this.cmpCache?.sig === JSON.stringify([seed, line]) ? this.cmpCache.res : null; }

  runCompare(seed, line) {
    const modal = $('compare'), body = $('compareBody');
    modal.classList.remove('hidden');
    body.innerHTML = '<p style="color:#a9b4c0">계산 중…</p>';
    setTimeout(() => {
      const HOURS = 8, res = this.computeCompare(seed, line, HOURS);
      const keys = Object.keys(MODES);
      const rows = [
        ['양품 생산량 (개)', (r) => r.k.good, num, 'max'],
        ['시간당 생산 UPH', (r) => r.k.uph, num, 'max'],
        ['OEE', (r) => r.k.OEE, (v) => pct(v), 'max'],
        ['가용률', (r) => r.k.A, (v) => pct(v), 'max'],
        ['품질(수율)', (r) => r.k.Q, (v) => pct(v, 2), 'max'],
        ['불량 유출 (ppm)', (r) => r.k.ppm, num, 'min'],
        ['돌발 고장 (회)', (r) => r.k.failures, num, 'min'],
        ['예지정비 / 보정 (회)', (r) => r.k.pm + r.k.cal, (v, r) => `${r.k.pm} / ${r.k.cal}`, null],
        ['평균 재공 WIP (개)', (r) => r.k.avgWip, (v) => v.toFixed(1), 'min'],
        ['에너지 원단위 (kWh/개)', (r) => r.k.kwhPerUnit, (v) => v.toFixed(3), 'min'],
        ['현장 인원 (명)', (r) => r.k.people, num, 'min'],
        ['인당 생산성 (개/인·시)', (r) => (r.k.people ? r.k.good / r.k.people / HOURS : Infinity), (v) => (isFinite(v) ? v.toFixed(1) : '무인'), 'max'],
        ['에이전트 의사결정 (건)', (r) => r.decisions, num, null],
      ];
      const head = `<tr><th>지표</th>${keys.map((k) => `<th>${MODES[k].label}</th>`).join('')}</tr>`;
      const trs = rows.map(([label, get, fmt, best]) => {
        const vals = keys.map((k) => get(res[k]));
        const target = best === 'max' ? Math.max(...vals) : best === 'min' ? Math.min(...vals) : null;
        return `<tr><td>${label}</td>${keys.map((k, i) => `<td class="${target !== null && vals[i] === target ? 'best' : ''}">${fmt(vals[i], res[k])}</td>`).join('')}</tr>`;
      }).join('');
      const base = res.traditional.k.good;
      const maxG = Math.max(...keys.map((k) => res[k].k.good));
      const bars = keys.map((k) => `<div>${MODES[k].short}</div><div class="b" style="width:${(res[k].k.good / maxG) * 100}%"></div><div>${num(res[k].k.good)}개</div>`).join('');
      const up = (k) => (((res[k].k.good - base) / base) * 100).toFixed(0);
      body.innerHTML = `<div class="cmp-bars">${bars}</div>
        <table class="cmp"><thead>${head}</thead><tbody>${trs}</tbody></table>
        <div class="cmp-note">• 레거시 대비 양품 생산량: 자동화 공장 <b>+${up('smart')}%</b>, 피지컬AI 자율공장 <b>+${up('dark')}%</b><br>
        • 차이의 주요 원인: 예지보전·순찰 선제 감지로 돌발 고장 감소 → 가용률↑, 풀(Pull)방식 투입·병목 최적화 → 재공↓·성능↑, SPC 자율 보정·전수 판정 → 불량 유출↓, 고효율 조명·공조 최소화 → 에너지 원단위↓<br>
        • 대상 라인: <b>${esc(line.name)}</b> (${line.stations.map((x) => esc(x.name)).join(' → ')})<br>
        • 공정 구성은 오른쪽 하단 ‘공정 설계’에서, 운영 파라미터(마모율·고장 위험함수·수리시간 등)는 <code>js/sim.js</code>의 <code>MODES</code>와 <code>js/line.js</code>에서 조정할 수 있습니다. 결과는 예시용 가정값 기반입니다.</div>`;
    }, 30);
  }
}
