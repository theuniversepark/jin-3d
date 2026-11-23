// FacOS 계층 탭 · A2A 메시지 탭 — 오케스트레이터 창 (orchview.js)에서 그린다 (정밀조립Zone 하나)
import { OCS, ocsState, EDGE_SKILLS, MSG, epName, KIND_KO, fosClock as clk } from './factoryos.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
export const fosState = { flt: 'all', msg: null };
export const DEC_KIND = { 'due-risk': '납기 위험', policy: '정책 승인 (8D)', timeout: '시간 초과', 'kpi-lever': 'KPI 개선안', 'kpi-revert': '개선안 되돌림', 'aios-policy': 'AIOS 배포', 'aios-rollback': 'AIOS 롤백', mix: '혼류 비율', interval: '투입 간격', expedite: '긴급 조달' };
const tile = (k, v, sub, tone = '') => `<div class="fos-tile ${tone}"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`;
const RULES = [
  ['자율복구 한계', '셀 OCS: AI 운영 정책에 따라 재보정·자율 보정 1회 · 스스로 풀지 못하면 존(Manufacturing Agent)에 영향·증거·필요 지원 보고'],
  ['자원 점유', '정비 인력·AMR은 정밀조립Zone 소속 — 자원 배정·우선순위는 존 오케스트레이터, 오더·납기·계획 변경은 공장 오케스트레이터 결정'],
  ['보고 정책', '셀 → 존은 이상 이벤트만 · 안전(P1)·보안·출하품 영향은 모든 계층에 즉시 동시 통보'],
  ['재개 정책', '접수 ACK만으로 재개하지 않는다 — 결정(대상·권한자·버전·제약·재개 조건) 또는 결과 메시지 뒤'],
  ['수량 정산', '시리얼 단위: 고유 투입 = 공정중 + 합격대기 + HOLD·재작업 + 인계완료 + 폐기 — 오차 0이어야 공장이 오더 종료'],
  ['모델 변경', 'VLA·AIOS 모델: 평가 게이트·트윈 검증 → 카나리·섀도 → 배포 · 롤백 (품질 정책은 8D 승인 → 정책 이력·되돌리기)'],
];

export function fosHTML(sim) {
  const F = sim.fos; if (!F) return '<p class="vla-note">FacOS 계층이 없습니다.</p>';
  const K = F.kpi(), R = K.recon, o = F.orders.find((x) => x.status === 'open' && x.evidenced !== true) ?? F.orders[0];
  const OR = o ? F.main.reconcile(o.id) : null, rate = F.rate(), eta = o && OR && rate > 0 ? sim.time + (o.target - OR.good) / rate : null;
  const tiles = `<div class="fos-tiles">
    ${tile('이상 판단 ≤ 10초', pct(K.judgeRate), K.judgeN ? `평균 ${K.judgeAvg.toFixed(1)}초 · 설비 고장·품질 불량 ${K.judgeN}건` : '아직 이상 없음', K.judgeRate != null && K.judgeRate < 0.9 ? 'warn' : '')}
    ${tile('셀 OCS 명령 검증', `${K.ocsOk} / ${K.ocsRej}`, '승인 / 거부 (정비·보정·현장 명령)')}
    ${tile('수량 정산 (정밀조립)', `오차 ${R?.err ?? '-'}`, R ? `투입 ${R.input} = 공정 ${R.wip} + 합격대기 ${R.pass} + HOLD ${R.hold} + 인계 ${R.handed} + 폐기 ${R.scrap}` : '-', R?.err ? 'bad' : '')}
    ${tile('오더', o ? `${o.id}` : '-', o && OR ? `양품 ${OR.good}/${o.target} · 납기 ${clk(o.due)}${eta ? ` · 예상 ${clk(eta)}` : ''} · 종료 ${K.orders}건` : '-', o?.risk ? 'warn' : '')}
    ${tile('A2A 메시지', K.msgs, `차단 ${K.blocked} · 시간 초과 ${K.timeouts} · 결정 ${K.decisions} · 에스컬레이션 ${K.esc}`)}
    ${tile('상위망', F.online ? '연결' : '단절', F.online ? '공장 ↔ 존 정상' : `Edge Outbox ${K.queued}건 · 승인 범위 안에서 계속`, F.online ? '' : 'bad')}</div>`;
  // 계층 구조: 공장 → 존 → (정밀조립) 셀 OCS → 엣지 스킬
  const reg = F.registry(), fac = reg.filter((r) => r.layer === 'factory'), zm = F.main.agents();
  const zoneBox = (k, title, sub) => `<div class="fos-zone on"><h5>${title}<small>${sub}</small></h5></div>`;
  const ag = (list) => `<div class="fos-agents">${list.map((a) => `<div class="fos-agent ${a.rule ? 'rule' : ''}" title="${esc(a.role)}"><b>${esc(a.name)}</b><small>${esc(a.role)}</small><i>${esc(a.stat ?? '')}</i></div>`).join('')}</div>`;
  const ocsCard = (name, uid, S, raw, c, skills) => { const last = c?.checks[0]; return `<div class="fos-cell s-${OCS[S].tone}"><div class="fos-ch"><b>${esc(name)}</b><i class="uidc">${uid}</i></div>
      <div class="fos-st"><b class="qt-chip ${OCS[S].tone}">${S}</b> ${OCS[S].ko} <small>(${esc(raw)})</small></div>
      <small>명령 검증 승인 ${c?.ok ?? 0} · 거부 ${c?.rej ?? 0}${last ? ` · 최근 ${KIND_KO[last.kind] ?? last.kind} ${last.ok ? '승인' : '거부'}${last.ok ? (last.by ? ` (${esc(last.by)})` : '') : ` — ${esc(last.reason)}`}` : ''}</small>
      <div class="fos-skills">${skills.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>`; };
  const cells = sim.processing.filter((st) => !st.standby).map((st) => ocsCard(st.name, st.uid ?? st.id, ocsState(st), st.state, F.ocs.get(st.id), [...(EDGE_SKILLS[st.type] ?? []), ...(st.vlaCell ? [`VLA ${sim.vla?.versionOf(st.robotUids?.[0]) ?? ''}`] : [])])).join('');
  const tree = `<div class="fos-tree">
    <div class="fos-lv"><em>공장</em><div class="fos-fac"><h5>공장 오케스트레이터 (FacOS) <small>총괄 · 오더·납기·전역 계획·결정 · 계획 버전 ${F.planVersion}</small></h5><div class="fos-chips">${fac.slice(1).map((r) => `<span title="${esc(r.role)}">${esc(r.name)}</span>`).join('')}</div></div></div>
    <div class="fos-lv"><em>존</em><div class="fos-zones">
      ${zoneBox('main', 'Manufacturing Agent', '정밀조립 · 로컬 오케스트레이터 (계층형)')}</div></div>
    <div class="fos-lv"><em>존<br>에이전트</em><div>${ag(zm)}</div></div>
    <div class="fos-lv"><em>셀 OCS<br>· 엣지</em><div class="fos-cells">${cells}</div></div></div>`;
  const ords = F.orders.slice(0, 8).map((x) => { const r = x.recon ?? F.main.reconcile(x.id); return `<tr><td><b>${x.id}</b></td><td>${x.status === 'closed' ? `<b class="qt-chip good">종료</b>` : x.released ? '<b class="qt-chip info">투입 완료</b>' : '<b class="qt-chip warn">진행</b>'}</td><td>${r.good}/${x.target}</td><td>${r.input}</td><td>${r.wip + r.pass}</td><td>${r.hold}</td><td>${r.scrap}</td><td>${clk(x.due)}${x.risk ? ' ⚠' : ''}</td><td>${x.tEnd != null ? `${clk(x.tEnd)}${x.late ? ' (초과)' : ''}` : '-'}</td></tr>`; }).join('');
  const decs = F.decisions.slice(0, 8).map((d) => `<tr><td>${clk(d.t)}</td><td>${esc((DEC_KIND[d.kind] ?? d.kind))}</td><td><b>${esc(d.verdict)}</b> ${esc(d.text)}</td><td>${esc(d.version)}</td><td>${esc(d.constraints || '-')}</td><td>${esc(d.resume || '-')}</td></tr>`).join('');
  return `${tiles}${tree}
    <div class="fos-grid">
      <div><h4>오더 (공장 → Manufacturing Agent) <small>양품 ${o?.target ?? 100}개 단위 · 불량 보충 투입은 같은 오더 · 존 종료 증빙(정산 오차 0) 확인 후 공장이 종료</small></h4>
        <table class="vla-t"><thead><tr><th>오더</th><th>상태</th><th>양품</th><th>고유 투입</th><th>진행</th><th>HOLD</th><th>폐기</th><th>납기</th><th>종료</th></tr></thead><tbody>${ords}</tbody></table></div>
      <div><h4>공장 결정 <small>결정 메시지 필수 필드: 대상 · 권한자 · 버전 · 제약 · 재개 조건</small></h4>
        <table class="vla-t"><thead><tr><th>시각</th><th>요청</th><th>결정</th><th>버전</th><th>제약</th><th>재개 조건</th></tr></thead><tbody>${decs || '<tr><td colspan="6">아직 결정 요청이 없습니다</td></tr>'}</tbody></table></div>
    </div>
    <h4>운영 변경 이력 <small>KPI 개선안 · AIOS 정책 · 운영자 지시 · 8D — 모두 공장 결정을 거쳐 계획 버전을 올린 뒤 적용 (상위망 단절이면 보류, 되돌림·롤백은 자율 조치)</small></h4>
    <table class="vla-t"><thead><tr><th>시각</th><th>종류</th><th>변경</th><th>전 → 후</th><th>승인</th><th>계획</th></tr></thead><tbody>${F.changes.slice(0, 8).map((c) => `<tr><td>${clk(c.t)}</td><td>${esc(DEC_KIND[c.kind] ?? c.kind)}</td><td>${esc(c.title)}</td><td>${c.before || c.after ? `${esc(c.before ?? '-')} → ${esc(c.after ?? '-')}` : '-'}</td><td>${c.verdict === '보류' ? `<b class="qt-chip warn">보류</b> ${esc(c.reason)}` : `${esc(c.verdict)}${c.human ? ` · ${esc(c.by ?? '운영자')}` : c.by ? ` · ${esc(c.by)}` : ''}`}</td><td>${esc(c.version)}</td></tr>`).join('') || '<tr><td colspan="6">아직 운영 변경이 없습니다</td></tr>'}</tbody></table>
    <h4>고정 운영 규칙 6종 <small>llm-wiki 운영 계층 — 수치는 고객 작업표준·장비 사양·계측 후 확정</small></h4>
    <table class="vla-t fos-rules">${RULES.map(([a, b]) => `<tr><td><b>${a}</b></td><td>${b}</td></tr>`).join('')}</table>
    <p class="vla-note">원칙: 명령은 위 → 아래(공장 → 존 → 셀 → 장비), 상태는 아래 → 위, 같은 계층은 핸드셰이크만. 에이전트는 제안하고 오케스트레이터가 권한·인터록·안전 상태를 검증해 확정하며, 안전 PLC가 최종 권한. 계층 구성은 llm-wiki 「팩토리OS 오케스트레이터·에이전트 공장·존·셀 분류」(10/15) — 존 계층·용어는 아직 미확정입니다.</p>`;
}

// ── A2A 메시지 (시퀀스) — 공장 ↔ 정밀조립 존 ↔ 셀 OCS · 실행 자원 ─────────────────
const COLS = [['factory', '공장 (FacOS)'], ['zone:main', '정밀조립 존'], ['cell', '셀 OCS · 실행 자원']];
const colOf = (ep) => { const i = COLS.findIndex(([k]) => k === ep); return i >= 0 ? i : ep.startsWith('cell:') || ep.startsWith('res:') ? 2 : 0; };
const FLT = { all: '전체', incident: '인시던트', handshake: '핸드셰이크·알림', decision: '결정 요청·결정', command: '명령·오더', blocked: '차단·시간 초과' };
const fit = (m, f) => f === 'all' || (f === 'incident' ? m.type.startsWith('incident.') || m.subject?.incident != null : f === 'blocked' ? m.status === 'blocked' || m.status === 'timeout' : f === 'handshake' ? ['handshake', 'notify'].includes(MSG[m.type]?.cls) : f === 'decision' ? m.type === 'decision.request' || m.type === 'decision' : f === 'command' ? m.type === 'command' || m.type.startsWith('order.') || m.type === 'broadcast' : true);
// 서버 FacOS 기록 (앱 — server/facos-store.mjs): 실행별 data/facos/<run>.jsonl · 웹 버전은 서버가 없어 화면 기록만
const fosSrv = (sim) => { const S = sim.uns?.broker?.facos; if (!S) return '<small>서버 기록 없음 (웹 버전 — 화면 기록만)</small>';
  return `<a class="fos-srv" href="/api/facos/v1/export${S.run ? `?run=${encodeURIComponent(S.run)}` : ''}" download title="서버에 쌓인 이 실행의 FacOS 기록 (A2A · 결정 · 오더 · 계획 버전)">⬇ 서버 기록 ${S.written ? `${S.seq}줄` : ''}</a><small>data/facos/${esc(S.file ?? '-')} · A2A ${S.counts?.a2a ?? 0} · 결정 ${S.counts?.decision ?? 0} · 오더 ${S.counts?.order ?? 0} · 계획 ${S.counts?.plan ?? 0}${S.error ? ` · <b class="dn">${esc(S.error)}</b>` : ''}</small>`; };
export function a2aHTML(sim) {
  const F = sim.fos; if (!F) return '';
  const st = fosState, L = F.bus.log.filter((m) => m.type !== 'ack' && fit(m, st.flt)).slice(0, 80), sel = F.bus.log.find((m) => m.msgId === st.msg) ?? L[0];
  const rows = L.map((m) => {
    const a = colOf(m.from), b = colOf(m.to), lo = Math.min(a, b), hi = Math.max(a, b), C = MSG[m.type]?.cls ?? 'event';
    const cells = COLS.map((_, i) => `<i class="${i === a ? 'from' : ''} ${i === b ? `to ${b > a ? 'r' : 'l'}` : ''} ${i > lo && i < hi ? 'span' : ''} ${i >= lo && i <= hi && a !== b ? 'on' : ''}"></i>`).join('');
    return `<div class="a2a-row c-${C} st-${m.status} ${sel === m ? 'sel' : ''}" data-fos-msg="${m.msgId}"><small>${clk(m.t)}</small><div class="a2a-lanes">${cells}</div><span><b>${MSG[m.type]?.ko ?? m.type}</b> ${esc(m.text)}${m.status === 'blocked' ? ` <em class="dn">⛔ 가드레일 차단 — ${esc(m.why)}</em>` : m.status === 'timeout' ? ' <em class="dn">⏱ 시간 초과 → 공장 에스컬레이션</em>' : m.status === 'queued' ? ' <em class="wn">📦 Outbox 대기</em>' : ''}</span></div>`;
  }).join('');
  const json = sel ? JSON.stringify((({ msgId, seq, corr, from, to, type, subject, body, authority, planVersion, t, status }) => ({ msgId, seq, corr, from, to, type, subject, body, authority, planVersion, t: clk(t), status }))(sel), null, 2) : '';
  return `<div class="a2a-bar"><div class="seg small">${Object.entries(FLT).map(([k, l]) => `<button type="button" data-fos-flt="${k}" class="${st.flt === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button type="button" data-fos-net>${F.online ? '🔌 상위망 단절 시험' : '🔗 상위망 복구 (Outbox 전송)'}</button><button type="button" data-fos-guard>🛡 가드레일 시험 (셀 → 공장 건너뛰기)</button><button type="button" data-fos-dl>⬇ 메시지 기록 (.jsonl)</button>${fosSrv(sim)}
      <small>메시지 ${F.bus.stats.sent} · 차단 ${F.bus.stats.blocked} · 시간 초과 ${F.bus.stats.timeouts} · Outbox ${F.bus.outbox.length}</small></div>
    <div class="a2a-b"><div class="a2a-seq"><div class="a2a-head"><small></small><div class="a2a-lanes">${COLS.map(([, l]) => `<b>${l}</b>`).join('')}</div><span>메시지</span></div><div class="a2a-list">${rows || '<p class="vla-note">아직 메시지가 없습니다.</p>'}</div></div>
      <div class="a2a-side"><h4>메시지 계약 <small>${sel ? `${epName(sel.from)} → ${epName(sel.to)}` : ''}</small></h4><pre>${esc(json)}</pre>
        <p class="vla-note">명령은 바로 아래 계층으로만(공장 → 존 → 셀), 상태·결정 요청은 바로 위 계층으로만 — 셀 OCS가 존을 건너 공장에 직접 보고하거나 같은 계층끼리 명령하면 Agent Gateway 가드레일이 계층 권한표로 막습니다. 상위망이 끊기면 공장으로 가는 메시지는 Outbox에 쌓이고 승인 범위 안에서 계속하며, 검사 결과가 오지 않은 샘플 로트는 HOLD로 둡니다(자동 OK 금지).</p></div></div>`;
}
export function fosClick(sim, e) {
  const F = sim.fos, t = e.target; if (!F) return false;
  let b;
  if ((b = t.closest('[data-fos-flt]'))) { fosState.flt = b.dataset.fosFlt; return true; }
  if ((b = t.closest('[data-fos-msg]'))) { fosState.msg = b.dataset.fosMsg; return true; }
  if (t.closest('[data-fos-net]')) { F.setOnline(!F.online); return true; }
  if (t.closest('[data-fos-guard]')) { const st = sim.processing[0]; F.bus.send(`cell:${st?.id ?? 'C01'}`, 'factory', 'status', { subject: { cell: st?.uid ?? st?.id }, text: `시험: 셀 OCS ${st?.id ?? ''}가 존을 건너 공장에 직접 상태 보고` }); return true; }   // 단일 Zone — 존 ↔ 존 상대가 없어 계층 건너뛰기로 시험
  if (t.closest('[data-fos-dl]')) {
    const lines = [...F.bus.log].reverse().map((m) => JSON.stringify((({ msgId, seq, corr, from, to, type, subject, body, authority, planVersion, t, status, text }) => ({ msgId, seq, corr, from, to, type, subject, body, authority, planVersion, t, status, text }))(m))).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines], { type: 'application/x-ndjson' })); a.download = `A2A_messages_${F.bus.seq}.jsonl`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  }
  return false;
}
