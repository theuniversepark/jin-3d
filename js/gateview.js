// 운영자 지시 게이트 도식 — 대화창의 지시 항목을 누르면 조치마다 한 줄씩
// 지시 → 해석 → 대상 확인 → 안전 규칙 → 실행 가능성 → 영향 평가 → 판정 ◇ → (수행) 명령 전송 → 셀 수신 확인 → 실행·완료
//                                                                            (거절) 거절 → 운영자 통보(사유·대안)
// 을 그린다. 지난 길은 색으로, 가지 않은 갈래는 흐리게. 명령 진행(ACK·완료)은 열려 있는 동안 실시간으로 갱신한다.
import { GATE_STEPS } from './gate.js';
import { CMD_STATE } from './commands.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const ICON = { pass: '✓', warn: '⚠', fail: '✗', skip: '·', pending: '⏳', cur: '…' };
const VERDICT = { approve: ['수행', 'pass'], reject: ['거절', 'fail'], answer: ['응답', 'pass'], pending: ['Agent 해석 중', 'pending'], delegated: ['Agent로 전환', 'pending'] };
// 노드 안 글자: 10자씩 2줄
const wrap = (t, n = 10, max = 2) => { const w = [...String(t ?? '')], a = []; for (let i = 0; i < w.length && a.length < max; i += n) a.push(w.slice(i, i + n).join('')); if (w.length > n * max) a[max - 1] = a[max - 1].slice(0, n - 1) + '…'; return a; };

export class GateView {
  constructor(modal, body, sub) {
    this.modal = modal; this.body = body; this.sub = sub; this.rec = null;
    modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close-gate]')) this.hide(); });
  }
  get open() { return !this.modal.classList.contains('hidden'); }
  show(rec, sim) { this.rec = rec; this.sim = sim; this.modal.classList.remove('hidden'); this.render(); }
  hide() { this.modal.classList.add('hidden'); this.rec = null; }
  tick() { if (this.open && this.rec) this.render(); }

  render() {
    const rec = this.rec; if (!rec) return;
    const items = [...rec.items, ...(rec.agentItems ?? []).filter((x) => !rec.items.includes(x))];
    this.sub.textContent = `${clock(rec.t)} · 운영자 지시 "${rec.text}" · 조치 ${items.length}건`;
    const html = items.map((it, i) => this.row(it, i)).join('') || '<p class="g-empty">조치가 없습니다.</p>';
    const legend = `<div class="g-legend"><span class="pass">✓ 통과</span><span class="warn">⚠ 주의 (수행하되 영향 표시)</span><span class="fail">✗ 거절 사유</span><span class="skip">· 도달하지 않음</span><span class="cur">… 진행 중</span></div>`;
    if (html !== this.last) { this.last = html; this.body.innerHTML = legend + html; }
  }

  // 수행 갈래 단계: 명령이면 전송 → 셀 수신 확인 → 완료, 그 밖에는 즉시 적용 → 완료 / 응답
  execSteps(it) {
    const v = it.gate.verdict;
    if (v === 'answer') return [{ label: '상태 조회', text: '스냅샷 조회', status: 'pass' }, { label: '응답', text: it.result?.text, status: 'pass' }];
    if (it.action?.type === 'command' || it.cmd) {
      const c = it.cmd, at = (s) => c?.history.find((h) => h.state === s);
      const st = (s, prev) => (v !== 'approve' ? 'skip' : at(s) ? 'pass' : at('rejected') ? 'fail' : prev ? 'cur' : 'skip');
      const ack = at('ack'), done = at('done'), rej = at('rejected');
      return [
        { label: '명령 전송', text: c ? `#${c.id} ${c.by.includes('Agent') ? 'Agent' : '운영자'} → 셀` : '', status: st('sent', true), t: at('sent') },
        { label: '셀 수신 확인', text: rej ? `거부: ${c.note}` : ack ? `ACK +${(ack.t - c.t).toFixed(1)}s` : '응답 대기', status: rej ? 'fail' : st('ack', !!at('sent')), t: ack },
        { label: '실행 · 완료', text: done ? `${c.note ?? '완료'}`.slice(0, 40) : c?.state === 'exec' ? '실행 중' : '', status: rej ? 'skip' : st('done', !!ack), t: done },
      ];
    }
    return [{ label: '즉시 적용', text: it.result?.text, status: v === 'approve' ? 'pass' : 'skip' }, { label: '완료', text: v === 'approve' ? '다음 투입부터 반영' : '', status: v === 'approve' ? 'pass' : 'skip' }];
  }

  row(it, i) {
    const g = it.gate, v = g.verdict, [vLabel, vCls] = VERDICT[v] ?? ['?', 'skip'];
    const W = 1130, NW = 100, NH = 56, GAP = 12, X0 = 8, Y1 = 30, Y2 = Y1 + NH + 34, H = Y2 + NH + 12;
    const x = (col) => X0 + col * (NW + GAP);
    const node = (col, y, label, text, status, extra = '') => {
      const lines = wrap(text);
      return `<g class="gn s-${status}" ${extra}><title>${esc(label)} · ${esc(text)}</title>
        <rect x="${x(col)}" y="${y}" width="${NW}" height="${NH}" rx="9"/>
        <text x="${x(col) + 8}" y="${y + 16}" class="gl">${ICON[status] ?? ''} ${esc(label)}</text>
        ${lines.map((l, k) => `<text x="${x(col) + 8}" y="${y + 32 + k * 12}" class="gt">${esc(l)}</text>`).join('')}</g>`;
    };
    const mk = (cls) => `url(#gArw-${cls}-${i})`;
    const arrow = (x1, y1, x2, y2, cls) => `<path d="M${x1},${y1} L${x2},${y2}" class="ga ${cls}" marker-end="${mk(cls)}"/>`;
    // 게이트 단계 (판정이 일찍 나면 뒤 단계는 도달하지 않음)
    const byKey = Object.fromEntries(g.checks.map((c) => [c.key, c]));
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" class="gsvg" role="img" aria-label="지시 게이트 흐름">
      <defs>${['on', 'fail', 'off', 'pend'].map((c) => `<marker id="gArw-${c}-${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="gm ${c}"/></marker>`).join('')}</defs>`;
    svg += node(0, Y1, '운영자 지시', it.clause ?? '', 'pass');
    GATE_STEPS.forEach((s, k) => {
      const c = byKey[s.key], st = c ? c.status : 'skip';
      svg += arrow(x(k) + NW, Y1 + NH / 2, x(k + 1) - 2, Y1 + NH / 2, c ? (c.status === 'fail' ? 'fail' : 'on') : 'off');
      svg += node(k + 1, Y1, s.label, c ? c.text : '도달하지 않음', st === 'pending' ? 'pending' : st);
    });
    // 판정 ◇
    const dx = x(6) + NW / 2, dy = Y1 + NH / 2, R = 30;
    svg += arrow(x(5) + NW, dy, dx - R - 2, dy, v === 'reject' ? 'fail' : 'on');
    svg += `<g class="gd s-${vCls}"><title>판정 · ${esc(vLabel)}${g.reason ? ` — ${esc(g.reason)}` : ''}</title><path d="M${dx},${dy - R} L${dx + R},${dy} L${dx},${dy + R} L${dx - R},${dy} Z"/><text x="${dx}" y="${dy - 3}" text-anchor="middle" class="gl">판정</text><text x="${dx}" y="${dy + 11}" text-anchor="middle" class="gt">${esc(vLabel)}</text></g>`;
    // 수행 갈래 (위)
    const ex = this.execSteps(it), took = v === 'approve' || v === 'answer';
    svg += arrow(dx + R, dy, x(7) - 2, dy, took ? 'on' : 'off');
    ex.forEach((s, k) => { if (k) svg += arrow(x(6 + k) + NW, dy, x(7 + k) - 2, dy, s.status === 'skip' ? 'off' : s.status === 'fail' ? 'fail' : 'on'); svg += node(7 + k, Y1, s.label, s.text ?? '', took ? s.status : 'skip'); });
    svg += `<text x="${x(7)}" y="${Y1 - 8}" class="gb ${took ? 'on' : ''}">수행</text>`;
    // 거절 갈래 (아래)
    const rej = v === 'reject', pend = v === 'pending' || v === 'delegated';
    svg += `<path d="M${dx},${dy + R} L${dx},${Y2 + NH / 2} L${x(7) - 2},${Y2 + NH / 2}" class="ga ${rej ? 'fail' : pend ? 'pend' : 'off'}" marker-end="${mk(rej ? 'fail' : pend ? 'pend' : 'off')}"/>`;
    svg += node(7, Y2, pend ? 'Agent 해석' : '거절', pend ? (v === 'delegated' ? 'Agent가 조치로 전환' : '해석 요청 중') : g.reason ?? '', rej ? 'fail' : pend ? 'pending' : 'skip');
    svg += arrow(x(7) + NW, Y2 + NH / 2, x(8) - 2, Y2 + NH / 2, rej ? 'fail' : 'off');
    svg += node(8, Y2, '운영자 통보', rej ? g.alt ?? '대화창에 사유 표시' : pend ? '결과는 대화창에' : '', rej ? 'warn' : pend ? 'pending' : 'skip');
    svg += `<text x="${x(7)}" y="${Y2 - 8}" class="gb ${rej ? 'bad' : ''}">${pend ? 'Agent' : '거절'}</text></svg>`;
    // 단계별 상세
    const detail = GATE_STEPS.map((s) => { const c = byKey[s.key]; return `<li class="s-${c?.status ?? 'skip'}"><b>${ICON[c?.status ?? 'skip']} ${s.label}</b><span>${esc(c?.text ?? '도달하지 않음 (앞 단계에서 판정)')}</span></li>`; }).join('');
    const prog = it.cmd ? ['sent', 'ack', 'exec', 'done', 'rejected'].map((sname) => { const h = it.cmd.history.find((x) => x.state === sname); return h ? `<span class="cp on">${CMD_STATE[sname]} ${clock(h.t)}</span>` : ''; }).join('') : '';
    return `<section class="g-row v-${vCls}">
      <div class="g-head"><span class="g-no">${i + 1}</span><b>${esc(g.summary ?? it.clause)}</b><em class="g-v ${vCls}">${esc(vLabel)}</em><small>해석: ${esc(it.source)}</small></div>
      <div class="g-svg">${svg}</div>
      <ul class="g-detail">${detail}
        <li class="s-${vCls}"><b>${v === 'reject' ? '✗ 거절 사유' : '◇ 판정'}</b><span>${esc(v === 'reject' ? `${g.reason}${g.alt ? ` — 대안: ${g.alt}` : ''}` : v === 'approve' ? `수행 · ${it.result?.text ?? ''}` : v === 'answer' ? it.result?.text ?? '' : g.reason ?? '')}</span></li>
        ${prog ? `<li class="s-pass"><b>명령 진행</b><span>${prog}</span></li>` : ''}
        ${it.reply ? `<li class="s-pending"><b>Agent 답변</b><span>${esc(it.reply)}</span></li>` : ''}</ul>
    </section>`;
  }
}
