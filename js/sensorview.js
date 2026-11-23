// 센서망 창 — 수집 흐름도(센서 → 셀 엣지 → 엣지 게이트웨이 → 존 서버 → 공장 중앙 → 센서 서버 → 센서 DB) · 존·셀별 센서 값 · 시간 동기 · 센서 서버/DB · 센서 목록 · 오픈소스
import { SENSOR_TYPES, SENSOR_CAT, LAYERS, SENSOR_ZONE_LABEL as ZL } from './sensors.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const n0 = (v) => Math.round(v ?? 0).toLocaleString('ko-KR');
const fmt = (v) => (v == null ? '-' : Math.abs(v) >= 1000 ? n0(v) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const clk = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const LV = { ok: '정상', warn: '주의', alarm: '경보' };
const TABS = { flow: '🔀 수집 흐름', zone: '🏭 존·셀 센서', sync: '⏱ 시간 동기', server: '🗄 센서 서버·DB', catalog: '📋 센서 목록', oss: '🧩 오픈소스' };
export const sensorState = { tab: 'flow', zone: 'main', show3d: true };
// 오픈소스: 앱에 직접 적용(실행 중) · 운영 배포 패키지(deploy/sensors — docker compose)
export const OSS = [
  ['MQTT 브로커 (공장 UNS)', 'Eclipse Mosquitto (EPL-2.0/EDL) · 대비 aedes (MIT)', 'Eclipse Mosquitto (EPL-2.0/EDL)', '앱 내장 브로커가 센서 묶음을 받아 센서 서버에 전달'],
  ['MQTT 클라이언트', 'MQTT.js (MIT)', 'MQTT.js · Telegraf mqtt_consumer (MIT)', '센서 서버가 metafactory/sensors/v1/# 구독'],
  ['센서 DB', 'SQLite · node:sqlite (Public Domain · MIT)', 'TimescaleDB (Apache-2.0 Community) · PostgreSQL', '측정값 · 1분 집계 · 경보 · 계층 지연'],
  ['엣지 흐름·프로토콜 변환', '— (화면 시뮬레이션)', 'Node-RED (Apache-2.0) · node-red-contrib-modbus', '필드버스 → MQTT · 특징 추출 · 묶음'],
  ['수집 에이전트', '—', 'Telegraf (MIT)', 'MQTT → TimescaleDB 적재'],
  ['시간 동기', '기준 시계 모델 (PTP 잔차)', 'linuxptp ptp4l/phc2sys (GPL-2.0) · chrony (GPL-2.0)', 'Grandmaster(중앙) → Boundary(게이트웨이) → Ordinary(엣지)'],
  ['Sparkplug B', '토픽·BIRTH 개념 (JSON)', 'Eclipse Tahu (EPL-2.0)', '센서 메타(birth) · 상태 인식'],
  ['OPC UA', 'DataHub OPC UA PubSub JSON (자체 구현)', 'open62541 (MPL-2.0)', '설비 제어기 값(토크·하중·용접 전류)'],
  ['LoRaWAN', '타임스탬프 모델', 'ChirpStack (MIT)', '배터리 무선 센서(누유·출입문)'],
  ['대시보드', '이 창', 'Grafana (AGPL-3.0)', '존·셀 센서 대시보드'],
  ['IO-Link', '—', 'IODD 기기 기술 파일 (IO-Link 컨소시엄 공개 규격)', '진동·RTD·유량 센서 파라미터'],
];

export function sensorHTML(sim, srv) {
  const N = sim.sensors; if (!N) return '<p class="vla-note">센서망이 없습니다.</p>';
  const st = sensorState, S = N.summary();
  const byCat = {}; for (const sn of N.sensors) byCat[sn.cat] = (byCat[sn.cat] ?? 0) + 1;
  const live = srv?.status;
  const tile = (k, v, sub) => `<div class="imp-tile"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`;
  const tiles = `<div class="imp-tiles">
    ${tile('센서', S.sensors, Object.entries(byCat).map(([k, v]) => `${SENSOR_CAT[k]} ${v}`).join(' · '))}
    ${tile('수집 계층', `${S.edges} · ${S.gateways} · ${S.zones}`, '셀 엣지 · 엣지 게이트웨이 · 존 서버')}
    ${tile('측정값', n0(N.stats.readings), `묶음 ${n0(N.stats.batches)} · ${(N.stats.bytes / 1048576).toFixed(1)}MB 발행`)}
    ${tile('경보', `<em class="${S.lv.alarm ? 'dn' : S.lv.warn ? 'mid' : 'up'}">${S.lv.alarm} · ${S.lv.warn}</em>`, '경보 · 주의 (센서 기준값)')}
    ${tile('시간 동기 (PTP)', `${S.maxErrUs.toFixed(2)}µs`, '기준 시계 대비 최대 잔차 (게이트웨이·엣지)')}
    ${tile('센서 서버 · DB', live ? `<em class="up">${n0(live.db.readings)}행</em>` : '<em class="mid">시뮬레이션</em>', live ? `${(live.db.bytes / 1048576).toFixed(1)}MB · ${live.ingest.ratePerS.toFixed(0)}값/초 · 경보 ${live.db.alarmsActive}` : srv?.error ? esc(srv.error) : '서버 없는 화면 — 맥 앱·npm start에서 별도 프로세스로 실행')}</div>`;
  const tabs = `<div class="seg qt-tabs">${Object.entries(TABS).map(([k, l]) => `<button data-sn-tab="${k}" class="${st.tab === k ? 'on' : ''}">${l}</button>`).join('')}<label class="chk sn-3d"><input type="checkbox" data-sn-3d ${st.show3d ? 'checked' : ''}/> 3D 센서 위치 표시</label></div>`;
  const body = st.tab === 'zone' ? zoneTab(N) : st.tab === 'sync' ? syncTab(N) : st.tab === 'server' ? serverTab(N, srv) : st.tab === 'catalog' ? catalogTab(N) : st.tab === 'oss' ? ossTab() : flowTab(N, S, srv);
  return `${tiles}${tabs}${body}`;
}

function flowTab(N, S, srv) {
  const cnt = { sensor: `${S.sensors}개`, edge: `${S.edges}대`, gateway: `${S.gateways}대`, zone: `${S.zones}대`, central: '1식', server: srv?.status ? '실행 중' : '시뮬레이션', db: srv?.status ? `${n0(srv.status.db.readings)}행` : '-' };
  const lat = { edge: '1초 묶음', gateway: `${(S.lat.gw * 1000).toFixed(1)}ms`, zone: `${(S.lat.zone * 1000).toFixed(1)}ms`, central: `${(S.lat.central * 1000).toFixed(1)}ms`, server: `${(S.lat.ingest * 1000).toFixed(1)}ms` };
  const boxes = LAYERS.map((L, i) => `${i ? `<i class="sn-arrow">→<small>${lat[L.key] ?? ''}</small></i>` : ''}<div class="sn-box ${L.key}"><b>${L.label}</b><em>${cnt[L.key]}</em><small>${esc(L.what)}</small></div>`).join('');
  const zoneRows = Object.values(N.zoneSrv).map((Z) => {
    const gws = N.gateways.filter((g) => g.zone === Z.zone);
    return `<tr><td><b>${esc(Z.label)}</b><br><small>${Z.ip.join('.')}</small></td><td>${gws.map((g) => `<span class="sn-node" title="${g.ip.join('.')}">${g.id} <small>엣지 ${g.edges}</small></span>`).join('')}</td><td>${N.edges.filter((e) => e.zone === Z.zone).map((e) => `<span class="sn-node" title="${e.ip.join('.')} · ${esc(e.cellName)}">${esc(e.cell)} <small>${e.sensors.length}</small></span>`).join('')}</td></tr>`;
  }).join('');
  return `<h3>수집 흐름 <small>센서가 측정 → 셀 엣지(특징 추출·묶음) → 엣지 게이트웨이(프로토콜 변환·저장 후 전달) → 존 서버 → 공장 중앙 MQTT(UNS) → 센서 서버(별도 프로세스) → 센서 DB(별도) · 화살표 아래 = 평균 전달 지연(기준 시계)</small></h3>
    <div class="sn-flow">${boxes}</div>
    <table class="vla-t sn-layers"><thead><tr><th>계층</th><th>하는 일</th><th>통신</th><th>오픈소스</th></tr></thead><tbody>${LAYERS.map((L) => `<tr><td><b>${L.label}</b></td><td>${esc(L.what)}</td><td>${esc(L.proto)}</td><td>${esc(L.oss)}</td></tr>`).join('')}</tbody></table>
    <h3>계층 구성 <small>존 서버 → 엣지 게이트웨이 → 셀 엣지(센서 수) · 주소: 엣지 10.20.3.x · 게이트웨이 10.20.4.x · 존 서버 10.20.5.x · 브로커 10.20.0.10 · 센서 서버 별도 프로세스</small></h3>
    <table class="vla-t"><thead><tr><th>존 서버</th><th>엣지 게이트웨이</th><th>셀 엣지 (센서 수)</th></tr></thead><tbody>${zoneRows}</tbody></table>
    <p class="vla-note">토픽: <code>metafactory/sensors/v1/{존}/{셀}</code>(1초 묶음 · 측정값마다 기준 시계 µs 타임스탬프·동기 잔차 · 계층별 통과 시각) · <code>…/birth</code>(센서 메타 · retain — Sparkplug B BIRTH 개념). DataHub 전체 캡처를 켜면 같은 메시지가 pcap에도 기록됩니다.</p>`;
}

function zoneTab(N) {
  const st = sensorState, zs = Object.keys(N.zoneSrv);
  const seg = `<div class="seg imp-win">${zs.map((z) => `<button data-sn-zone="${z}" class="${st.zone === z ? 'on' : ''}">${ZL[z]} <small>${N.sensors.filter((q) => q.zone === z).length}</small></button>`).join('')}</div>`;
  const edges = N.edges.filter((e) => e.zone === st.zone);
  const rows = edges.map((e) => `<tr><td><b>${esc(e.cellName)}</b><br><small>${e.id} · ${e.gateway}</small></td><td class="sn-chips">${e.sensors.map((sn) => { const L = N.latest.get(sn.id), lv = L?.lv ?? 'ok', H = N.hist.get(sn.id) ?? [];
    return `<span class="sn-chip ${lv}" title="${esc(sn.label)} · ${esc(SENSOR_TYPES[sn.type].spec)} · ${sn.iface} · ${sn.rate}초 · ${sn.id}">${esc(sn.label)} <b>${L ? fmt(L.v) : '-'}</b> ${esc(sn.unit)}${spark(H)}</span>`; }).join('')}</td></tr>`).join('');
  const al = N.alarms.filter((a) => N.sensors.find((q) => q.id === a.sensor)?.zone === st.zone).slice(0, 8);
  return `${seg}<table class="vla-t"><thead><tr><th>셀 · 엣지</th><th>센서 (최근 값 · 최근 60회 추이)</th></tr></thead><tbody>${rows}</tbody></table>
    <h4 class="qt-h">최근 경보·주의</h4>${al.length ? `<table class="vla-t"><tbody>${al.map((a) => `<tr><td>${clk(a.t)}</td><td><b class="qt-chip ${a.level === 'alarm' ? 'bad' : 'warn'}">${LV[a.level]}</b></td><td>${esc(a.where)} · ${esc(a.label)}</td><td>${fmt(a.v)} ${esc(a.unit)}</td></tr>`).join('')}</tbody></table>` : '<p class="vla-note">없음</p>'}`;
}
function spark(H) {
  if (H.length < 2) return '';
  const lo = Math.min(...H), hi = Math.max(...H), w = 46, h = 12, d = hi - lo || 1;
  return `<svg class="sn-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="currentColor" stroke-width="1" points="${H.map((v, i) => `${(i / (H.length - 1)) * w},${h - ((v - lo) / d) * (h - 2) - 1}`).join(' ')}"/></svg>`;
}

function syncTab(N) {
  const row = (id, role, ip, c, note) => `<tr><td><b>${id}</b></td><td>${role}</td><td>${ip}</td><td>${c ? c.method : '-'}</td><td>${c ? `${c.err >= 0 ? '+' : ''}${c.err.toFixed(3)}µs` : '0 (기준)'}</td><td>${note}</td></tr>`;
  const gws = N.gateways.map((g) => row(g.id, 'Boundary Clock', g.ip.join('.'), g.clock, `1초 동기 · σ ${g.clock.sigma}µs`)).join('');
  const eds = [...N.edges].sort((a, b) => Math.abs(b.clock.err) - Math.abs(a.clock.err)).slice(0, 12).map((e) => row(e.id, 'Ordinary Clock', e.ip.join('.'), e.clock, `→ ${e.gateway}`)).join('');
  return `<h3>시간 동기 <small>모든 센서 타임스탬프는 공장 기준 시계(PTP Grandmaster = 공장 중앙 = DataHub 기준 시계)로 찍혀 AAS · OPC UA · 제품 계보 · 품질 통신 pcap · 설비 이벤트와 같은 시간 축에 놓입니다</small></h3>
    <table class="vla-t"><thead><tr><th>시계</th><th>역할</th><th>주소</th><th>방식</th><th>기준 대비 잔차</th><th>비고</th></tr></thead><tbody>
    ${row('CENTRAL-GM', 'Grandmaster (기준 시계)', '10.20.0.40', null, `기준 시각 ${new Date(N.epochMs).toISOString()} = 시뮬레이션 0초`)}${gws}${eds}</tbody></table>
    <p class="vla-note">• 측정값 오차 = 엣지 잔차 + 게이트웨이 잔차 (유선 PTP · 1µs 이내) · 배터리 무선 센서(LoRaWAN: 누유·출입문)는 게이트웨이 수신 시각(NTP · 수 ms)<br>
    • 같은 순간 조회: 센서 서버 <code>GET /api/sensors/v1/align?t=&lt;ISO&gt;&window=5</code> — 제품 계보의 셀 통과 시각 · 불량 판정 시각 · 설비 고장 시각을 넣으면 그 순간 전 센서 값<br>
    • 제품 계보: 셀 투입 순간 그 셀 센서 값을 함께 기록 → RCA 특징 표(features.csv)에 <code>{셀}_sns_{지표}</code> 열</p>`;
}

function serverTab(N, srv) {
  const S = srv?.status, L = srv?.latency;
  if (!S) return `<p class="vla-note">${srv?.error ? `센서 서버 연결 안 됨 — ${esc(srv.error)}` : '서버가 없는 화면(웹·공유 페이지)입니다.'} 맥 앱이나 <code>npm start</code>로 실행하면 앱 서버가 센서 서버를 <b>별도 프로세스</b>로 띄우고, 센서 서버는 공장 중앙 MQTT를 구독해 <b>별도 SQLite DB</b>(데이터 폴더/sensors/sensors.db)에 저장합니다. 단독 실행: <code>npm run sensor-server</code>.</p>
    <p class="vla-note">이 화면은 같은 수집 흐름(엣지 · 게이트웨이 · 존 서버 · 기준 시계)을 시뮬레이션합니다 — 측정값 ${n0(N.stats.readings)}개 · 묶음 ${n0(N.stats.batches)}개.</p>`;
  return `<table class="vla-t"><tbody>
    <tr><td>서버</td><td>${esc(S.server)} · pid ${S.pid} · MQTT ${S.mqtt.connected ? '<b class="qt-chip good">구독 중</b>' : '<b class="qt-chip bad">끊김</b>'} <code>${esc(S.mqtt.topic)}</code></td></tr>
    <tr><td>DB</td><td>${esc(S.db.engine)} · <code>${esc(S.db.path)}</code> · ${(S.db.bytes / 1048576).toFixed(2)}MB</td></tr>
    <tr><td>테이블</td><td>sensor ${n0(S.db.sensors)} · reading ${n0(S.db.readings)} · batch ${n0(S.db.batches)} · agg_1m ${n0(S.db.agg1m)} · 진행 중 경보 ${S.db.alarmsActive}</td></tr>
    <tr><td>수집</td><td>${S.ingest.ratePerS.toFixed(0)}값/초 · 메시지 ${n0(S.ingest.msgs)} · 오류 ${S.ingest.errors} · 마지막 측정 ${S.ingest.last ?? '-'}</td></tr>
    <tr><td>보존</td><td>원시값 ${S.retention.rawHours}시간 · 1분 집계 ${S.retention.agg1mDays}일 (기준 시계)</td></tr>
    ${L ? `<tr><td>계층 지연 (DB)</td><td>엣지→게이트웨이 ${L.hopMs.edgeToGateway?.toFixed(2)}ms · 게이트웨이→존 ${L.hopMs.gatewayToZone?.toFixed(2)}ms · 존→중앙 ${L.hopMs.zoneToCentral?.toFixed(2)}ms · 중앙→서버 ${L.hopMs.centralToServer?.toFixed(2)}ms · 엣지 시계 잔차 평균 ${L.clockUs.edgeAvg?.toFixed(3)}µs</td></tr>` : ''}
    </tbody></table>
    <p class="vla-note">REST: <code>/api/sensors/v1/status · sensors · latest · readings?sensor= · agg?sensor= · alarms?active=1 · align?t= · latency · export.csv</code> — <a href="/api/sensors/v1/export.csv" target="_blank">CSV 내보내기</a></p>`;
}

function catalogTab(N) {
  const cnt = {}; for (const sn of N.sensors) cnt[sn.type] = (cnt[sn.type] ?? 0) + 1;
  const lim = (o) => (o ? [o.lo != null ? `< ${o.lo}` : '', o.hi != null ? `> ${o.hi}` : ''].filter(Boolean).join(' · ') : '-');
  return `<table class="vla-t"><thead><tr><th>분류</th><th>센서</th><th>지표</th><th>사양</th><th>현장 연결</th><th>주기</th><th>주의</th><th>경보</th><th>배치</th></tr></thead><tbody>
    ${Object.entries(SENSOR_TYPES).map(([k, T]) => `<tr><td>${SENSOR_CAT[T.cat]}</td><td><b>${esc(T.label)}</b></td><td>${T.metric} (${esc(T.unit)})</td><td>${esc(T.spec)}</td><td>${esc(T.iface)}</td><td>${T.rate}초</td><td>${lim(T.warn)}</td><td>${lim(T.alarm)}</td><td>${cnt[k] ?? 0}</td></tr>`).join('')}</tbody></table>`;
}
function ossTab() {
  return `<table class="vla-t"><thead><tr><th>영역</th><th>앱에 적용 (실행 중)</th><th>운영 배포 (deploy/sensors)</th><th>쓰임</th></tr></thead><tbody>${OSS.map((r) => `<tr><td><b>${r[0]}</b></td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('')}</tbody></table>
    <p class="vla-note">운영 배포 패키지: <code>deploy/sensors/</code> — docker compose(Mosquitto · Node-RED · Telegraf · TimescaleDB · Grafana) · 게이트웨이 Node-RED 흐름 · TimescaleDB 스키마(하이퍼테이블 · 1분 연속 집계) · linuxptp/chrony 설정. 라이선스는 각 프로젝트 기준입니다.</p>`;
}

export function sensorClick(e) {
  const b = (q) => e.target.closest(q);
  let x;
  if ((x = b('[data-sn-tab]'))) { sensorState.tab = x.dataset.snTab; return true; }
  if ((x = b('[data-sn-zone]'))) { sensorState.zone = x.dataset.snZone; return true; }
  if ((x = b('[data-sn-3d]'))) { sensorState.show3d = x.checked; return true; }
  return false;
}
