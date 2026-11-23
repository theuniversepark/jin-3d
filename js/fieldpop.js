// 현장 대응 팝업 — 현장 이벤트가 감지되면 화면 아래에 로봇 창을 띄운다
//   🔍 감지 로봇: 이벤트를 처음 본 카메라(로봇 카메라 · CCTV)의 실시간 영상 + 감지 결과 + 서버 전송(detect · 영상 클립)
//   🚑 대응 로봇: 출동한 로봇 카메라 영상 + 임무 · 위치 · 배터리 · 현장까지 거리 + 서버 전송(ack · 2초마다 status · done)
//   🐕 추적 사족보행(사람 진입): 카메라 영상 + 진입자 거리 · 행동 · 동선 · 출구 + 동선 지도 + 서버 전송(status · 행동 보고 track · done)
//   서버 전송 줄은 sim.fieldTx 기록 그대로 — uns.js가 같은 기록을 UNS {존}/_field/{로봇}/… 토픽으로 발행한다
import { fieldTopic, UNS_ROOT } from './uns.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ROLE = { detect: ['🔍', '감지 로봇', '이벤트를 처음 본 카메라'], respond: ['🚑', '대응 로봇', '배정된 로봇 · 현장 처리'], escort: ['🐕', '추적 사족보행', '진입자를 4m 거리로 따라가며 보고'] };
const KIND = { detect: '감지 이벤트', clip: '영상 클립', ack: '배정 응답', status: '상태', track: '행동 보고', done: '종료 보고' };
const STATE = { look: '두리번거림', walk: '걷는 중', stop: '멈춰 섬', left: '구역 이탈' };
const PHASE = { approach: '뒤에서 접근 중', chase: '동선 따라 따라잡는 중', follow: '추적 중' };
const W = 320, H = 180, KEEP = 8;   // 영상 크기 · 해결 뒤 남겨 두는 시간(초)
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
const compass = (deg) => ['북', '북동', '동', '남동', '남', '남서', '서', '북서'][Math.round((((180 - deg) % 360) + 360) % 360 / 45) % 8];   // 화면 위(−z)가 북

export class FieldPops {
  // o: { el, sim(), camWall, cctvView, clock(t), dark(), video(card), dest() }
  constructor(o) {
    Object.assign(this, o);
    this.cards = new Map(); this.hide = new Set(); this.t = 0; this.camT = 0; this.rr = 0; this.evId = null;
    this.el.addEventListener('click', (e) => {
      const x = e.target.closest('[data-fp-x]'); if (x) { this.hide.add(x.dataset.fpX); this.sync(true); return; }
      const m = e.target.closest('[data-fp-min]'); if (m) { const c = this.cards.get(m.dataset.fpMin); if (c) { c.min = !c.min; c.userMin = true; c.el.classList.toggle('min', c.min); } }
    });
  }
  // 지금 보여 줄 이벤트: 해결 안 된 것 중 가장 최근에 감지된 것 → 없으면 방금(8초 안) 해결된 것
  pick() {
    const s = this.sim(), L = (s?.fieldLog ?? []).filter((e) => e.detected && (!e.cleared || s.time - (e.tClear ?? s.time) < KEEP));
    return L.sort((a, b) => (!!a.cleared - !!b.cleared) || (b.tDetect - a.tDetect))[0] ?? null;
  }
  roles(ev) {
    const s = this.sim(), out = [];
    const det = ev.detRef;
    out.push({ role: 'detect', key: `${ev.id}:detect`, ref: det?.type === 'cctv' ? null : det, cctv: det?.type === 'cctv' ? det.id : null, name: det?.type === 'cctv' ? `CCTV ${det.id}` : String(ev.detectedBy ?? '') });
    const m = ev.responder && s.movers.find((x) => x.id === ev.responder);
    if (m) out.push({ role: ev.escort?.q === m ? 'escort' : 'respond', key: `${ev.id}:resp`, ref: { type: 'mover', id: m.id }, m, name: m.id });
    return out.filter((r) => !this.hide.has(r.key));
  }
  tick(rdt) {
    this.t += rdt; this.camT += rdt;
    if (this.t >= 0.25) { this.t = 0; this.sync(); }
    if (this.camT >= 0.12 && this.cards.size) { this.camT = 0; this.drawCam(); }   // 영상은 한 번에 한 창씩 돌아가며 (창마다 약 3~4fps)
  }
  sync(force) {
    const s = this.sim(), ev = s ? this.pick() : null;
    if (!ev) { if (this.cards.size) { this.el.innerHTML = ''; this.cards.clear(); } this.el.hidden = true; this.evId = null; return; }
    if (ev.id !== this.evId) { this.el.innerHTML = ''; this.cards.clear(); this.evId = ev.id; }
    // 토리 안내 중에는 창을 접어 둔다(이름 · 역할만) — 토리가 비추는 현장 · 여는 창을 가리지 않게 · 사용자가 직접 펴거나 접은 창은 그대로
    const te = document.querySelector('.tori'), tour = !!te && !te.classList.contains('mini');   // 토리 말풍선이 열려 있는 동안 (body.tori-tour는 토리가 창을 띄운 동안만이라 출동 장면에서 풀린다)
    if (tour !== this.tourOn) { this.tourOn = tour; for (const c of this.cards.values()) if (!c.userMin) { c.min = tour; c.el.classList.toggle('min', c.min); } }
    const want = this.roles(ev), keys = new Set(want.map((r) => r.key));
    for (const [k, c] of this.cards) if (!keys.has(k) || c.role !== want.find((r) => r.key === k)?.role) { c.el.remove(); this.cards.delete(k); }
    for (const r of want) {
      let c = this.cards.get(r.key);
      if (!c) {
        const [ic, nm, sub] = ROLE[r.role], el = document.createElement('div');
        el.className = `fp-card fp-${r.role}`;
        el.innerHTML = `<div class="fp-h"><span class="fp-badge">${ic} ${nm}</span><b class="fp-name"></b><button type="button" data-fp-min="${r.key}" title="접기 · 펴기">–</button><button type="button" data-fp-x="${r.key}" title="이 창 닫기 (이번 이벤트 동안)">✕</button></div>
          <div class="fp-sub">${esc(sub)}</div>
          <div class="fp-body"><div class="fp-cam"><canvas width="${W}" height="${H}"></canvas><div class="fp-nocam" hidden>카메라 영상 없음</div></div>
          <div class="fp-grid"></div>${r.role === 'escort' ? '<canvas class="fp-map" width="300" height="96"></canvas>' : ''}
          <div class="fp-tx"><div class="fp-tx-h"></div><ol></ol><div class="fp-vid"></div></div></div>`;
        this.el.appendChild(el);
        if (tour) { el.classList.add('min'); }
        c = { ...r, el, min: tour, cv: el.querySelector('.fp-cam canvas'), nocam: el.querySelector('.fp-nocam'), grid: el.querySelector('.fp-grid'), map: el.querySelector('.fp-map'), txh: el.querySelector('.fp-tx-h'), ol: el.querySelector('.fp-tx ol'), vid: el.querySelector('.fp-vid'), seen: 0 };
        this.cards.set(r.key, c);
      }
      Object.assign(c, r); this.fill(c, ev);
    }
    this.el.hidden = !this.cards.size;
  }
  rows(c, ev) {
    const s = this.sim(), r1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-'), R = [], sev = ev.cleared ? ['✅ 해결', 'ok'] : ['⚠ 처리 중', 'warn'];
    if (c.role === 'detect') {
      R.push(['이벤트', `${ev.label} (${ev.cls})`], ['신뢰도', (ev.conf ?? 0).toFixed(2)], ['감지 시각', this.clock(ev.tDetect)], ['위치', `x ${r1(ev.x)} · z ${r1(ev.z)}`]);
      const m = c.ref?.type === 'mover' ? s.movers.find((x) => x.id === c.ref.id) : null;
      if (ev.detDist != null) R.push(['감지 거리', `${r1(ev.detDist)} m (감지 당시)`]);
      if (m) R.push(['지금 거리', `${r1(Math.hypot(m.x - ev.x, m.z - ev.z))} m`], ['지금 하는 일', m.task ?? '대기']);
      R.push(['인시던트', `${ev.inc?.id ?? '-'} · ${sev[0]}`, sev[1]]);
      return R;
    }
    const m = c.m, st = [...(ev.tx ?? [])].reverse().find((x) => x.kind === 'status' && x.robot === m.id)?.body;
    const bat = Math.round(m.battery ?? 100), d = Math.hypot(m.x - ev.x, m.z - ev.z), deg = Math.round(((m.heading ?? 0) * 180 / Math.PI + 360) % 360);
    if (c.role === 'respond') {
      R.push(['임무', m.task ?? '복귀'], ['상태', ev.cleared ? '처리 완료' : m.moving ? '현장으로 이동 중' : d < 3 ? '현장 처리 중' : '대기'], ['위치', `x ${r1(m.x)} · z ${r1(m.z)} · ${compass(deg)}쪽`], ['속도', `${m.moving ? (m.speed ?? 0).toFixed(1) : '0.0'} m/s`], ['배터리', `${bat}%`, bat < 25 ? 'warn' : ''], ['현장까지', `${r1(d)} m`], ['인시던트', `${ev.inc?.id ?? '-'} · ${sev[0]}`, sev[1]]);
      return R;
    }
    const E = ev.escort, Wk = ev.walk, gap = d, minGap = E?.minGap != null && E.minGap < 99 ? E.minGap : null;
    const state = Wk?.done || ev.cleared ? 'left' : Wk?.phase;
    const last = ev.acts?.at(-1);
    R.push(['단계', ev.cleared ? '추적 종료 · 순찰 복귀' : PHASE[E?.phase] ?? '-'], ['위치', `x ${r1(m.x)} · z ${r1(m.z)} · ${compass(deg)}쪽`], ['속도', `${m.moving ? (m.speed ?? 0).toFixed(1) : '0.0'} m/s`], ['배터리', `${bat}%`, bat < 25 ? 'warn' : ''],
      ['진입자 거리', `${r1(gap)} m (유지 ${st?.keepGap ?? 4} m${minGap != null ? ` · 최소 ${r1(minGap)} m` : ''})`, gap < 3.5 && !ev.cleared ? 'warn' : ''],
      ['진입자 행동', STATE[state] ?? '-'], ['진입자 동선', `${r1(Wk?.dist ?? 0)} m · 기록 ${ev.trail?.length ?? 0}점`], ['나가는 길', Wk ? `${Wk.exitX > 0 ? '오른쪽' : '왼쪽'} 세로 통로 · ${Wk.az === 'F' ? '앞' : '뒤'} 통로` : '-'],
      ['행동 보고', `${ev.acts?.length ?? 0}건${last ? ` — ${last.what}` : ''}`]);
    return R;
  }
  fill(c, ev) {
    c.el.querySelector('.fp-name').textContent = c.name;
    const g = this.rows(c, ev).map(([k, v, cls]) => `<span>${esc(k)}</span><b class="${cls ?? ''}">${esc(v)}</b>`).join('');
    if (c.grid.dataset.h !== g) { c.grid.innerHTML = g; c.grid.dataset.h = g; }
    // 서버 전송: 이 로봇이 이번 이벤트로 보낸 메시지 (최근 5건 · 새 것은 잠깐 밝게)
    const role = c.role === 'detect' ? 'detect' : c.role, mine = (ev.tx ?? []).filter((m) => m.role === role);
    const dest = this.dest?.() ?? 'UNS 토픽 트리에 기록';
    const tot = mine.reduce((a, m) => a + (m.kind === 'clip' ? m.body.bytes : m.bytes), 0);
    const h = `📡 서버 전송 · ${mine.length}건 · ${kb(tot)} <small>${esc(dest)}</small>`;
    if (c.txh.dataset.h !== h) { c.txh.innerHTML = h; c.txh.dataset.h = h; }
    const fresh = mine.length > c.seen ? mine.slice(c.seen).map((m) => m.seq) : []; c.seen = mine.length;
    // 2초마다 오는 상태(status)는 최신 1건만 맨 위에 — 그 아래 감지 · 클립 · 배정 응답 · 행동 보고 · 종료를 최근 순으로 (상태에 묻히지 않게)
    const lastSt = mine.findLast((m) => m.kind === 'status'), rest = mine.filter((m) => m.kind !== 'status').slice(lastSt ? -4 : -5).reverse();
    const li = [...(lastSt ? [lastSt] : []), ...rest].map((m) => {
      const tp = fieldTopic(m).replace(`${UNS_ROOT}/`, '');
      const sz = m.kind === 'clip' ? `${kb(m.body.bytes)} · ${m.body.codec} ${m.body.resolution} ${m.body.seconds}초` : `${m.bytes} B`;
      const what = m.kind === 'track' ? m.body.action : m.kind === 'status' ? (m.body.person ? `거리 ${m.body.gap} m · 진입자 ${STATE[m.body.person.state] ?? '-'}` : `현장까지 ${m.body.distToEvent} m · 배터리 ${m.body.battery}%`) : m.kind === 'detect' ? `${m.body.cls} ${m.body.conf}` : m.kind === 'done' ? `결과 ${m.body.result} · ${m.body.duration}초` : m.kind === 'ack' ? '임무 수락' : '';
      return `<li class="${fresh.includes(m.seq) ? 'new' : ''}"><time>${this.clock(m.t)}</time><b>▲ ${KIND[m.kind] ?? m.kind}</b><code>${esc(tp)}</code><small>${esc(sz)}${m.kind === 'status' ? ` · retain · 2초마다 (${mine.filter((x) => x.kind === 'status').length}회)` : ' · QoS 1'}${what ? ` · ${esc(what)}` : ''}</small></li>`;
    }).join('');
    if (c.ol.dataset.h !== li) { c.ol.innerHTML = li || '<li><small>보낼 메시지 대기 중…</small></li>'; c.ol.dataset.h = li; }
    const v = this.video?.(c) ?? ''; if (c.vid.textContent !== v) c.vid.textContent = v;
    if (c.map) this.drawMap(c, ev);
  }
  // 동선 지도: 진입자 지나온 길(주황) · 사족보행 위치(청록) · 셀(회색) · 나가는 쪽(▶)
  drawMap(c, ev) {
    const s = this.sim(), g = c.map.getContext('2d'), w = c.map.width, h = c.map.height, m = c.m, T = ev.trail ?? [];
    const pts = [...T, { x: m.x, z: m.z }, { x: ev.x, z: ev.z }];
    const x0 = Math.min(...pts.map((p) => p.x)) - 6, x1 = Math.max(...pts.map((p) => p.x)) + 6, z0 = Math.min(...pts.map((p) => p.z)) - 4, z1 = Math.max(...pts.map((p) => p.z)) + 4;
    const k = Math.min(w / (x1 - x0), h / (z1 - z0)), ox = (w - (x1 - x0) * k) / 2, oz = (h - (z1 - z0) * k) / 2, P = (p) => [ox + (p.x - x0) * k, oz + (p.z - z0) * k];
    g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(8,14,22,0.85)'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(150,170,190,0.25)';
    for (const st of s.stations ?? []) { if (st.x < x0 - 3 || st.x > x1 + 3 || (st.z ?? 0) < z0 - 3 || (st.z ?? 0) > z1 + 3) continue; const [a, b] = P({ x: st.x - 2, z: (st.z ?? 0) - 2 }); g.fillRect(a, b, 4 * k, 4 * k); }
    if (T.length > 1) { g.strokeStyle = '#ff9a3d'; g.lineWidth = 2; g.beginPath(); T.forEach((p, i) => { const [a, b] = P(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.lineTo(...P(ev)); g.stroke(); }
    const dot = (p, col, r) => { const [a, b] = P(p); g.fillStyle = col; g.beginPath(); g.arc(a, b, r, 0, Math.PI * 2); g.fill(); };
    if (T[0]) dot(T[0], '#ffcf8a', 3);
    dot(ev, '#ff5a3d', 4.5); dot(m, '#37e8ff', 4.5);
    g.font = '10px sans-serif'; g.fillStyle = '#c9d6e2'; g.fillText('━ 진입자 동선  ● 진입자  ● 사족보행', 6, h - 6);
  }
  drawCam() {
    if (!this.dark()) { for (const c of this.cards.values()) { c.cv.hidden = true; c.nocam.hidden = false; } return; }
    const list = [...this.cards.values()].filter((c) => !c.min); if (!list.length) return;
    const c = list[this.rr++ % list.length];
    let ok = null;
    try { ok = c.cctv ? this.cctvView.renderPanel(c.cctv, c.cv) : c.ref ? this.camWall.renderRobotView(c.ref, c.cv, this.clock(this.sim().time)) : null; } catch { ok = null; }
    c.cv.hidden = !ok; c.nocam.hidden = !!ok;
  }
}
