// UNS 토픽 트리 탭 — 오케스트레이터 창 (orchview.js). FacOS가 UNS에 발행한 ISA-95 토픽을 트리로 보고, 토픽을 눌러 마지막 메시지를 본다 (MQTT Explorer와 같은 보기)
import { UNS_LEVELS, UNS_AREAS } from './uns.js';
import { fosClock as clk } from './factoryos.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const unsState = { flt: 'all', sel: null, focus: null, pw: {}, br: null, brDraft: null, brMsg: null, brBusy: false, open: new Set(['camtic', 'camtic/metafactory', 'camtic/metafactory/_facos', 'camtic/metafactory/main']) };
const FLT = { all: '전체', facos: 'FacOS (_facos)', state: '상태 (retain)', cmd: '명령 4단', a2a: 'A2A', telemetry: '설비 요약', quality: '품질 표본', field: '현장 로봇 (_field)' };
const fit = (e, f) => f === 'all' || (f === 'facos' ? e.topic.includes('/_facos/') : f === 'state' ? e.retain : e.kind === f);
const KIND = { meta: '규칙', state: '상태', order: '오더', decision: '결정', a2a: 'A2A', cmd: '명령', telemetry: '설비', kpi: 'KPI', quality: '품질', field: '현장', event: '이벤트' };
const tile = (k, v, sub, tone = '') => `<div class="fos-tile ${tone}"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`;
// 토리 안내 등에서 「이 사건이 남긴 토픽」을 강조 — focus(sim) → { topics, sel, note } (창을 다시 그릴 때마다 불러 실시간으로 늘어남) · null이면 끔
export function unsFocus(fn) { unsState.focus = typeof fn === 'function' ? fn : null; unsState.sel = null; if (fn) unsState.flt = 'all'; }
const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(1)} kB`);

export function unsHTML(sim) {
  const U = sim.uns; if (!U) return '<p class="vla-note">UNS 수집 대기 — 2초마다 트리를 만듭니다.</p>';
  const S = U.summary(), B = U.broker, st = unsState;
  const mq = B.status, brokerTxt = B.on === false && !B.status ? '웹 버전 — 브로커 발행 없음 (트리만)' : B.error ? `발행 실패 — ${B.error}` : mq ? `mqtt://${mq.host}:${mq.port} · 이번 실행 ${B.published}건` : '연결 확인 중';
  const tiles = `<div class="fos-tiles">
    ${tile('토픽', S.topics, `ISA-95 트리 · 루트 ${esc(U.root)}`)}
    ${tile('보존 상태 (retain)', S.retained, '새 구독자가 바로 받는 현재 상태')}
    ${tile('발행 메시지', S.msgs, `${kb(S.bytes)} · 2초 주기 ${S.collects}회`)}
    ${tile('변화 없음 건너뜀', S.suppressed, 'Report by Exception — 상태가 같으면 보내지 않음')}
    ${tile('브로커', mq?.engine === 'mosquitto' ? `Mosquitto ${esc(mq.brokerVersion ?? '')}` : mq?.engine === 'aedes' ? 'aedes' : B.on === false ? '없음' : '-', mq?.engine ? `${mq.mqtt5 ? 'MQTT 5' : 'MQTT 3.1.1'} · ${esc(brokerTxt)}${mq.engineError ? ` · ${esc(mq.engineError)}` : ''}` : esc(brokerTxt), B.error || (mq?.engineError && mq.engine !== 'mosquitto') ? 'warn' : '')}
    ${tile('생존 관리', mq?.uns ? (mq.uns.alive ? '살아 있음' : '죽음 처리') : '-', mq?.uns ? `죽음 ${mq.uns.deaths} · 탄생 ${mq.uns.births} · rebirth ${S.births}` : '게이트웨이 상태 없음 (웹)', mq?.uns && !mq.uns.alive ? 'warn' : '')}</div>`;
  // 트리: 토픽을 / 로 나눠 접고 펼친다
  const E = [...U.tree.values()].filter((e) => fit(e, st.flt)).sort((a, b) => a.topic.localeCompare(b.topic));
  let FX = null; try { FX = st.focus?.(sim) ?? null; } catch { FX = null; }
  const mark = new Set((FX?.topics ?? []).filter((t) => U.tree.has(t))), anc = new Set();
  for (const t of mark) { const p = t.split('/'); for (let i = 1; i < p.length; i++) anc.add(p.slice(0, i).join('/')); }   // 강조 토픽까지 가는 가지는 펼쳐 둔다
  const root = { name: '', path: '', kids: new Map(), e: null, n: 0 };
  for (const e of E) {
    let node = root; const parts = e.topic.split('/');
    parts.forEach((p, i) => { const path = parts.slice(0, i + 1).join('/'); if (!node.kids.has(p)) node.kids.set(p, { name: p, path, kids: new Map(), e: null, n: 0 }); node = node.kids.get(p); node.n++; });
    node.e = e;
  }
  const label = (path) => { const k = path.split('/').at(-1); return UNS_AREAS[k] ? ` <small>${UNS_AREAS[k]} (Area)</small>` : k === '_facos' ? ' <small>공장 오케스트레이터 · Agent Gateway</small>' : k === '_zone' ? ' <small>존 오케스트레이터</small>' : k === '_meta' ? ' <small>토픽 규칙</small>' : ''; };
  const rows = [];
  const walk = (node, depth) => {
    for (const k of [...node.kids.values()]) {
      const has = k.kids.size > 0, open = st.open.has(k.path) || st.flt !== 'all' || anc.has(k.path);
      const e = k.e, age = e ? Math.max(0, Math.round(sim.time - e.t)) : null;
      rows.push(`<div class="uns-row ${(st.sel ?? FX?.sel) === k.path ? 'sel' : ''}${mark.has(k.path) ? ' mark' : anc.has(k.path) ? ' mark-p' : ''}" style="padding-left:${6 + depth * 14}px" data-uns-node="${esc(k.path)}" ${has ? 'data-uns-fold="1"' : ''}>
        <i>${has ? (open ? '▾' : '▸') : '·'}</i><b>${esc(k.name)}</b>${label(k.path)}
        ${e ? `<em class="k-${e.kind}">${KIND[e.kind] ?? e.kind}</em>${e.retain ? '<em class="ret">retain</em>' : ''}<small>${e.n}회 · ${age}초 전</small><code>${esc(e.payload.slice(0, 90))}</code>` : `<small>${k.n}개</small>`}</div>`);
      if (has && open) walk(k, depth + 1);
    }
  };
  walk(root, 0);
  const sel = U.tree.get(st.sel ?? (mark.has(FX?.sel) ? FX.sel : '')) ?? null;
  let json = ''; if (sel) { try { json = JSON.stringify(JSON.parse(sel.payload), null, 2); } catch { json = sel.payload; } }
  const levels = `<table class="vla-t uns-lv"><thead><tr><th>ISA-95 계층</th><th>레벨</th><th>FacOS 계층</th><th>토픽</th></tr></thead><tbody>${UNS_LEVELS.map((l) => `<tr><td><b>${esc(l.level)}</b></td><td>${esc(l.isa)}</td><td>${esc(l.facos)}</td><td><code>${esc(l.topic)}</code></td></tr>`).join('')}</tbody></table>`;
  // Sparkplug B · ACL · 외부 명령 (앱 — 게이트웨이 상태)
  const SP = mq?.sparkplug, A = mq?.acl, CQ = mq?.commands, X = U.ext;
  const spT = SP ? `<table class="vla-t"><thead><tr><th>엣지 노드</th><th>연결</th><th>bdSeq</th><th>seq</th><th>디바이스</th><th>NBIRTH · DBIRTH · DDATA</th><th>재탄생</th></tr></thead><tbody>${SP.edges.map((e) => `<tr><td><b>${esc(e.id)}</b></td><td>${e.connected ? (e.born ? '탄생' : '연결') : '<b class="qt-chip warn">끊김</b>'}</td><td>${e.bdSeq}</td><td>${e.seq}</td><td>${e.devices}</td><td>${e.births} · ${e.dbirths} · ${e.ddata}</td><td>${e.rebirths}</td></tr>`).join('') || '<tr><td colspan="7">설비 요약이 들어오면 존마다 엣지 노드가 탄생합니다</td></tr>'}</tbody></table>
      <p class="qt-ins">주 호스트 <b>${esc(SP.host.id)}</b> ${SP.host.connected ? '연결' : '끊김'} · 탄생 ${SP.host.births}/${SP.host.dbirths} · DDATA ${SP.host.ddata} · seq 누락 ${SP.host.gaps} → 재탄생 요청 ${SP.host.rebirthReq} · NDEATH ${SP.host.ndeaths}${SP.error ? ` · <b class="dn">${esc(SP.error)}</b>` : ''}</p>` : '<p class="vla-note">Sparkplug 엣지 — 앱(맥·윈도우·npm start)에서 동작합니다.</p>';
  const aclT = A ? `<table class="vla-t"><thead><tr><th>계정</th><th>역할</th><th>발행 가능 토픽</th><th>비밀번호</th></tr></thead><tbody>${A.users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.ko)}</td><td><code>camtic/metafactory/${u.role === 'zone' ? esc(u.zone) : '+'}/+/cmd/request</code></td><td>${st.pw[u.name] ? `<code>${esc(st.pw[u.name])}</code>` : `<button type="button" data-uns-pw="${esc(u.name)}">보기</button>`}</td></tr>`).join('')}
      <tr><td><b>(익명)</b></td><td>${A.anonymous === 'none' ? '접속 금지' : '관찰 (읽기 전용)'}</td><td>-</td><td>-</td></tr></tbody></table>
      <p class="qt-ins">ACL ${A.enabled ? '켜짐' : '<b class="dn">꺼짐 (UNS_ACL=off)</b>'}${mq.engine === 'mosquitto' ? ' · Mosquitto가 집행(권한 밖 발행은 버리고 MQTT 5면 사유 0x87로 응답 — 거부 건수는 aedes에서만 셈)' : ''} · 읽기(구독)는 모두 허용 · 거부 ${A.denied}건${A.lastDenied ? ` (최근 ${esc(A.lastDenied.user)} → ${esc(A.lastDenied.topic)})` : ''} · 인증 실패 ${A.authFail} · 앱 내부 계정 ${A.internal}</p>` : '<p class="vla-note">접근 권한 — 앱에서 동작합니다 (웹 버전은 브로커 없음).</p>';
  const cmdT = `<p class="qt-ins">받음 ${CQ?.received ?? 0} · 실행 ${X.applied} · 거부 ${X.rejected + (CQ?.rejected ?? 0)} · 만료 ${CQ?.expired ?? 0} · 대기 ${CQ?.pending ?? 0}${X.last ? ` · 최근 ${esc(X.last.correlationId)} ${X.last.result === 'issued' ? `→ 명령 #${X.last.id}` : `거부 — ${esc(X.last.why)}`}` : ''}</p>
    <pre class="uns-ex">mosquitto_pub -h ${esc(mq?.host ?? '127.0.0.1')} -p ${mq?.port ?? 1883}${mq?.mqtt5 ? ' -V 5 -D publish correlation-data OP-1 -D publish user-property from MES-01' : ''} -u operator -P &lt;비밀번호&gt; \\
  -t '${esc(U.root)}/main/_zone/cmd/request' \\
  -m '{"code":"SPEED","arg":75,"reason":"시험","correlationId":"OP-1"}'</pre>`;
  // 외부 MQTT 5 브로커 연결 (브리지) — 설정은 앱 데이터 폴더 uns/bridge.json
  if (mq && !st.br && !st.brBusy) loadBridge();
  const BR = st.br, D = st.brDraft ?? {}, live = mq ? { on: mq.bridgeConnected, err: mq.bridgeError, ver: mq.bridgeVersion, pub: mq.bridgePublished, rcv: mq.bridgeReceived, url: mq.bridgeUrl } : null;
  const brState = !live ? '' : live.on ? `<b class="qt-chip good">연결됨</b> ${esc(live.url)} · MQTT ${live.ver === 5 ? '5' : '3.1.1'} · 보냄 ${live.pub} · 받은 명령 요청 ${live.rcv}` : live.url ? `<b class="qt-chip ${live.err ? 'bad' : 'warn'}">${live.err ? '오류' : '연결 중'}</b> ${esc(live.url)}${live.err ? ` — ${esc(live.err)}` : ''}` : '<b class="qt-chip">꺼짐</b>';
  const brForm = !mq ? '<p class="vla-note">외부 브로커 연결 — 앱(맥·윈도우·npm start)에서 설정합니다.</p>' : !BR ? '<p class="vla-note">설정 불러오는 중…</p>' : !BR.editable ? `<p class="qt-ins">환경변수 MQTT_BRIDGE_URL로 설정됨 — 화면에서 바꿀 수 없습니다 · ${brState}</p>` : `<div class="uns-bridge">
      <label>주소<input data-br="url" class="ep-in" placeholder="mqtt://broker.local:1883" value="${esc(D.url ?? '')}"/></label>
      <label>계정 (선택)<input data-br="username" class="ep-in" autocomplete="off" value="${esc(D.username ?? '')}"/></label>
      <label>비밀번호<input data-br="password" class="ep-in" type="password" autocomplete="new-password" placeholder="${BR.password ? '저장됨 — 바꿀 때만 입력' : '익명이면 비움'}" value="${esc(D.password ?? '')}"/></label>
      <label>버전<select data-br="version"><option value="5" ${String(D.version ?? 5) === '5' ? 'selected' : ''}>MQTT 5</option><option value="4" ${String(D.version) === '4' ? 'selected' : ''}>MQTT 3.1.1</option></select></label>
      <div class="uns-bridge-row"><label class="chk"><input type="checkbox" data-br="enabled" ${D.enabled ? 'checked' : ''}/> 연결 켜기</label>
        <button type="button" data-br-save ${st.brBusy ? 'disabled' : ''}>💾 저장 · 연결</button>${BR.password ? '<button type="button" data-br-clear>비밀번호 지우기</button>' : ''}</div>
      <p class="qt-ins">${brState}${st.brMsg ? ` · <b class="${st.brMsg.ok ? '' : 'dn'}">${esc(st.brMsg.text)}</b>` : ''}</p>
      <p class="vla-note">내장 브로커(포트 ${mq.port})는 ${mq.engine === 'mosquitto' ? `Mosquitto ${esc(mq.brokerVersion ?? '')} · MQTT 5입니다. 공장 밖 MQTT 5 브로커(사내 · 클라우드)에도 같은 메시지를 내보내려면 여기서 연결하세요 —` : 'aedes · MQTT 3.1.1입니다. 여기서 MQTT 5 브로커에 연결하면'} UNS 메시지가 Correlation Data · Response Topic · Message Expiry · User Property 속성을 달고 함께 나가고, 그 브로커로 들어온 MQTT 5 명령 요청(…/cmd/request)도 받습니다. 내장 브로커가 1883을 쓰므로 같은 PC에서 시험할 외부 브로커는 다른 포트로 띄웁니다 — 예: <code>mosquitto -p 1893</code> → 주소 <code>mqtt://127.0.0.1:1893</code>.</p></div>`;
  const extra = `<div class="fos-grid"><div><h4>MQTT 5 브로커 연결 <small>외부 브로커 브리지 · 설정은 이 PC에 저장 (비밀번호 암호화)</small></h4>${brForm}</div><div></div></div>
    <div class="fos-grid"><div><h4>Sparkplug B 엣지 <small>spBv1.0/metafactory/… → 주 호스트 → {존}/{셀}/telemetry · edge</small></h4>${spT}</div>
      <div><h4>접근 권한 (ACL) <small>쓰기는 역할·존별 · UNS 상태 토픽은 앱만 발행</small></h4>${aclT}
      <h4>외부 명령 요청 <small>{존}/{셀|_zone}/cmd/request → FacOS 명령 경로 → 명령 4단</small></h4>${cmdT}</div></div>`;
  return `${tiles}
    <div class="a2a-bar"><div class="seg small">${Object.entries(FLT).map(([k, l]) => `<button type="button" data-uns-flt="${k}" class="${st.flt === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button type="button" data-uns-all>${st.open.size > 6 ? '▸ 모두 접기' : '▾ 모두 펼치기'}</button><button type="button" data-uns-dl>⬇ 현재 트리 (.json)</button>
      <small>${sim.time != null ? `시뮬레이션 ${clk(sim.time)}` : ''}</small></div>
    ${FX?.note ? `<p class="uns-focus">🔦 ${esc(FX.note)} · 강조 ${mark.size}개</p>` : ''}
    <div class="a2a-b"><div class="uns-tree">${rows.join('') || '<p class="vla-note">아직 토픽이 없습니다.</p>'}</div>
      <div class="a2a-side"><h4>마지막 메시지 <small>${sel ? `${esc(sel.topic)} · ${sel.retain ? 'retain' : '이벤트'} · ${sel.n}회` : '토픽을 누르세요'}</small></h4><pre>${esc(json)}</pre>
        <p class="vla-note">FacOS는 에이전트끼리 직접 묶지 않고 UNS 하나를 봅니다. 상태(셀 OCS · 존 · 오더 · FacOS)는 retain으로 값이 바뀔 때만, 결정 · A2A · 명령은 이벤트로 발행합니다. 명령은 같은 correlationId로 cmd → cmd/ack → cmd/exec → cmd/done을 잇습니다(MQTT 5 브리지에서는 Correlation Data · Response Topic 속성으로도) — 접수 ACK만으로 재개하지 않습니다. 기존 OPC UA PubSub(opcua/json/#) · AAS · 평면 대시보드 토픽(metafactory/…/v1)은 그대로 함께 나갑니다.</p></div></div>
    ${extra}
    <h4>ISA-95 계층 ↔ FacOS ↔ 토픽</h4>${levels}`;
}

function loadBridge() {
  unsState.brBusy = true;
  fetch('/api/uns/bridge').then((r) => r.json()).then((j) => { unsState.br = j; unsState.brDraft = { url: j.url, username: j.username, password: '', version: j.version, enabled: j.enabled }; }).catch(() => {}).finally(() => { unsState.brBusy = false; });
}
function saveBridge(body) {
  unsState.brBusy = true; unsState.brMsg = null;
  fetch('/api/uns/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) { unsState.brMsg = { ok: false, text: j.error ?? `HTTP ${r.status}` }; return; }
    unsState.br = j; unsState.brDraft = { ...unsState.brDraft, password: '' };
    unsState.brMsg = { ok: true, text: j.enabled ? '저장 — 연결 시도 중 (몇 초 뒤 상태가 바뀝니다)' : '저장 — 연결 끔' };
  }).catch((e) => { unsState.brMsg = { ok: false, text: e.message }; }).finally(() => { unsState.brBusy = false; });
}
// 입력 칸 — 다시 그려도 값이 남도록 초안에 담는다 (orchview가 input · change 이벤트를 넘김)
export function unsInput(e) {
  const k = e.target?.dataset?.br; if (!k || !unsState.brDraft) return false;
  unsState.brDraft[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  return e.type === 'change' && (e.target.type === 'checkbox' || e.target.tagName === 'SELECT');
}

export function unsClick(sim, e) {
  const U = sim.uns, t = e.target; if (!U) return false;
  let b;
  if ((b = t.closest('[data-uns-flt]'))) { unsState.flt = b.dataset.unsFlt; return true; }
  if (t.closest('[data-uns-all]')) {
    if (unsState.open.size > 6) unsState.open = new Set(['camtic', 'camtic/metafactory']);
    else for (const k of U.tree.keys()) { const p = k.split('/'); for (let i = 1; i < p.length; i++) unsState.open.add(p.slice(0, i).join('/')); }
    return true;
  }
  if (t.closest('[data-uns-dl]')) {
    const obj = Object.fromEntries([...U.tree.values()].sort((a, b) => a.topic.localeCompare(b.topic)).map((x) => { let p; try { p = JSON.parse(x.payload); } catch { p = x.payload; } return [x.topic, { retain: x.retain, count: x.n, payload: p }]; }));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })); a.download = `UNS_tree_${Math.round(sim.time)}s.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  }
  if (t.closest('[data-br-save]')) { const D = unsState.brDraft ?? {}; saveBridge({ url: D.url ?? '', username: D.username ?? '', version: Number(D.version) || 5, enabled: !!D.enabled, ...(D.password ? { password: D.password } : {}) }); return true; }
  if (t.closest('[data-br-clear]')) { saveBridge({ clearPassword: true }); return true; }
  if ((b = t.closest('[data-uns-pw]'))) {
    const name = b.dataset.unsPw;
    fetch('/api/uns/acl/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => r.json()).then((j) => { if (j.password) unsState.pw[name] = j.password; }).catch(() => {});
    return true;
  }
  if ((b = t.closest('[data-uns-node]'))) {
    const p = b.dataset.unsNode;
    if (b.dataset.unsFold) { unsState.open.has(p) ? unsState.open.delete(p) : unsState.open.add(p); }
    if (U.tree.has(p)) unsState.sel = p;
    return true;
  }
  return false;
}
