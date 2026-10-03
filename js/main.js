import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Simulation, MODES, ST_LABEL } from './sim.js';
import { FactoryAgent } from './agent.js';
import { FactoryView } from './factory.js';
import { UI } from './ui.js';
import { LLMController } from './llm.js';
import { LineDesigner } from './designer.js';
import { renderConcept } from './concept.js';
import { DataHub, PUBLISHER_ID, WRITER_GROUP } from './datahub.js';
import { RobotCamWall, COLS as CAM_COLS } from './robotcam.js';
import { GateView } from './gateview.js';
import { OrchView } from './orchview.js';
import { DEFAULT_LINE, normalizeLine, cloneLine, zoneLine, isZone, ZONE_CELLS, ZONE_PRODUCTS, ZONE_MIXES, ZONE_NAME } from './line.js';

// ── 렌더러 ─────────────────────────────
const host = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
host.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();

// ── 카메라: 3D 원근 ─────────────────
const target = new THREE.Vector3(1, 0, 1);
const persp = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 400);
persp.position.set(-4, 40, 52);
const ctlP = new OrbitControls(persp, labelRenderer.domElement);
ctlP.target.copy(target); ctlP.enableDamping = true; ctlP.maxPolarAngle = Math.PI * 0.47; ctlP.minDistance = 8; ctlP.maxDistance = 120;
labelRenderer.domElement.style.pointerEvents = 'auto';
let camera = persp, controls = ctlP;

// ── 조명 ─────────────────────────────
const hemi = new THREE.HemisphereLight(0xffffff, 0x404850, 1.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-20, 40, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 30, bottom: -30, near: 1, far: 120 });
sun.shadow.bias = -0.0005;
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9ec9ff, 0.4);
fill.position.set(30, 20, -20);
scene.add(fill);

// ── 후처리(블룸) ─────────────────────────────
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.5, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── 시뮬레이션 ─────────────────────────────
const view = new FactoryView(scene);
const hub = new DataHub();
const camWall = new RobotCamWall(scene, renderer);   // 로봇 비전 관제 디스플레이 (피지컬AI 단계)
const orchView = new OrchView(document.getElementById('orchPanel'), document.getElementById('orchBadge'));   // 오케스트레이터 인시던트 흐름도
const ui = new UI();
const llm = new LLMController();
ui.llm = llm;
llm.onChange = () => { ui.renderEngine(); designer?.onLLMChange(); };
// 대화 지시로 혼류 비율이 바뀌면 라인 설정·Zone 카드를 맞춘다 (재시작하지 않고 다음 투입부터 적용)
// 대화창의 지시 항목을 누르면 게이트 도식 (판정 → 수행/거절)
const gateView = new GateView(document.getElementById('gateModal'), document.getElementById('gateBody'), document.getElementById('gateSub'));
document.getElementById('log').addEventListener('click', (e) => {
  const d = e.target.closest('.entry[data-dlg]'); if (!d) return;
  const rec = llm.dialogs?.find((r) => r.id === +d.dataset.dlg);
  if (rec) gateView.show(rec, sim);
});
llm.onMix = (key) => { currentLine = lines.zone = { ...currentLine, mix: key }; saveLines(); renderZoneCard(); designer?.sync(); };
let sim, agent;
let modeKey = 'smart', speed = 3, running = true, labelsOn = true;
const SEED = 20261001;

// 공정 라인 구성 — 정밀조립Zone 두 시나리오(도어트림·e-axle)와 사용자 라인을 각각 저장해 다음 실행 때도 유지
// v4: 정밀조립Zone이 혼류(분기·합류) 구조로 바뀌어 이전 Zone 레시피는 버리고 사용자 라인만 옮긴다
// v5: 부품분류셀 기본 로봇이 SCARA → AMMR(AMR 기반 양팔 로봇)로 바뀌어 이전 Zone 레시피는 버린다
// v6: 포장셀 기본 로봇도 AMMR로 바뀌어 이전 Zone 레시피는 버린다
const LINES_KEY = 'jin3d.lines.v6', OLD_KEYS = ['jin3d.lines.v5', 'jin3d.lines.v4', 'jin3d.lines.v3', 'jin3d.lines.v2'], OLD_LINE_KEY = 'jin3d.line.v1';
const LINE_SLOTS = ['zone', 'custom'];
const slotDefault = (k) => (k === 'custom' ? cloneLine(DEFAULT_LINE) : zoneLine());
function loadLines() {
  const lines = Object.fromEntries(LINE_SLOTS.map((k) => [k, slotDefault(k)]));
  let active = 'zone';
  const valid = (raw, k) => {
    const { line, errors } = normalizeLine(raw);
    return !errors.length && (k === 'custom') === !isZone(line) ? line : null;
  };
  try {
    const saved = JSON.parse(localStorage.getItem(LINES_KEY) ?? 'null');
    if (saved) {
      for (const k of LINE_SLOTS) lines[k] = (saved.lines?.[k] && valid(saved.lines[k], k)) || lines[k];
      if (LINE_SLOTS.includes(saved.active)) active = saved.active;
    } else {
      // 이전 버전에서 편집한 라인은 사용자 라인으로 옮긴다
      const prev = OLD_KEYS.map((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.lines?.custom).find(Boolean);
      const old = prev ?? JSON.parse(localStorage.getItem(OLD_LINE_KEY) ?? 'null');
      if (old) lines.custom = valid(old, 'custom') || lines.custom;
    }
  } catch { /* 저장소 사용 불가 시 기본값 */ }
  return { lines, active };
}
function saveLines() {
  try { localStorage.setItem(LINES_KEY, JSON.stringify({ active: lineSlot, lines })); } catch { /* 저장 실패해도 이번 실행에는 적용 */ }
}
let { lines, active: lineSlot } = loadLines();
let currentLine = lines[lineSlot];
let designer = null;
let changedIds = null;

const LOOK = {
  traditional: { bg: 0x2b2a28, fog: 0x2b2a28, hemi: [0xfff1dc, 0x4a443c, 1.25], sun: [0xffe9c9, 1.7], fill: 0.35, lamps: 0.9, bloom: [0.25, 0.4, 0.96], exposure: 1.0, floor: 0xffffff, wall: 0xc9c2b6 },
  smart: { bg: 0x16202c, fog: 0x16202c, hemi: [0xf2f8ff, 0x37424f, 1.3], sun: [0xffffff, 1.8], fill: 0.5, lamps: 1.0, bloom: [0.4, 0.5, 0.95], exposure: 1.05, floor: 0xd8e2ec, wall: 0xc9ccd1 },
  // 피지컬AI 자율공장: 라벤더 톤의 클린 공장 (고효율 LED) — 자동화 공장보다 아주 조금 어둡게
  dark: { bg: 0x161b2c, fog: 0x161b2c, hemi: [0xf4f2ff, 0x3a4154, 1.27], sun: [0xffffff, 1.76], fill: 0.49, lamps: 0.98, bloom: [0.4, 0.5, 0.95], exposure: 1.03, floor: 0xd4dbea, wall: 0xc9ccd6 },
};

function applyLook() {
  const L = LOOK[modeKey];
  scene.background = new THREE.Color(L.bg);
  scene.fog = new THREE.Fog(L.fog, 70, 160);
  hemi.color.setHex(L.hemi[0]); hemi.groundColor.setHex(L.hemi[1]);
  hemi.intensity = L.hemi[2];
  sun.color.setHex(L.sun[0]); sun.intensity = L.sun[1];
  fill.intensity = L.fill;
  for (const m of view.lampMats) m.emissiveIntensity = L.lamps;
  bloom.strength = L.bloom[0]; bloom.radius = L.bloom[1]; bloom.threshold = L.bloom[2];
  renderer.toneMappingExposure = L.exposure;
  view.floorMat.color.setHex(L.floor);
  document.body.dataset.mode = modeKey;
}

function start(key) {
  modeKey = key;
  sim = new Simulation(key, SEED, { line: currentLine });
  agent = new FactoryAgent(sim);
  view.setup(sim, labelsOn, changedIds);
  view.selected = null;
  hub.reset(sim, view);
  camWall.setup(sim, view);
  orchView.attach(sim);
  applyLook();
  llm.attach(sim, agent);
  ui.reset(sim, agent);
  ui.hideDetail();
  sim.log('info', `${MODES[key].label} 시뮬레이션 시작`, {
    obs: key === 'traditional' ? '작업자 중심 수동 운영, 고정 컨베이어·지게차, 사후보전 체계' : key === 'smart' ? '양쪽 협동로봇 셀·AMR 운반, IoT·MES 연결, 현장 인원 4명' : '무인 운영 — 휴머노이드 4대(정비 2·부품 보충 2), 사족보행 순찰 2대, AMR·AGV, 고효율 LED 조명',
  });
  renderZoneCard();
}

// ── 정밀조립Zone 카드 (왼쪽 패널 위) ─────────────────
const zoneCard = document.getElementById('zoneCard');
const escH = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cellBadge = (id) => `${ZONE_CELLS[id].no}.${ZONE_CELLS[id].label.replace('셀', '')}`;
function renderZoneCard() {
  const zone = isZone(currentLine);
  const seg = `<button data-slot="zone" class="${lineSlot === 'zone' ? 'on' : ''}">정밀조립Zone (혼류)</button><button data-slot="custom" class="${lineSlot === 'custom' ? 'on' : ''}">사용자 라인</button>`;
  let body;
  if (zone) {
    const mixSeg = Object.entries(ZONE_MIXES).map(([k, m]) => `<button data-mix="${k}" class="${k === currentLine.mix ? 'on' : ''}">${escH(m.label)}</button>`).join('');
    const cellRow = (id) => { const c = ZONE_CELLS[id]; return `<div class="zc-cell p-${c.product}" data-cell="${id}"><b>${c.no}</b><span>${escH(c.label)}</span><em>${escH(c.use)}</em><i class="chip" data-chip="${id}"></i></div>`; };
    body = `<div class="zc-sub">혼류 비율 (도어트림 : e-axle)</div>
      <div class="seg small zc-mix">${mixSeg}</div>
      <div class="zc-cells">${cellRow('SORT')}
        <div class="zc-branch"><div class="zc-line p-doortrim"><small>▶ 도어트림 라인 · ${escH(ZONE_PRODUCTS.doortrim.customer)}</small>${cellRow('DT_ASSY')}${cellRow('DT_FAST')}</div>
        <div class="zc-line p-eaxle"><small>▶ e-axle 라인 · ${escH(ZONE_PRODUCTS.eaxle.customer)}</small>${cellRow('EA_ASSY')}${cellRow('EA_FAST')}</div></div>
        ${cellRow('PACK')}</div>
      <div class="zc-amr" id="zcAmr"></div>
      <div class="zc-flow">투입 → 1.분류 → <span class="t-dt">도어트림 2.조립 → 3.체결</span> / <span class="t-ea">e-axle 4.조립 → 5.체결</span> → 6.포장 → 구분 적재</div>`;
  } else body = `<div class="zc-sub">${escH(currentLine.name)} · 공정 ${currentLine.stations.length}개 (공정 설계에서 편집)</div>`;
  zoneCard.innerHTML = `<div class="zc-h"><b>${ZONE_NAME}</b><small>메타팩토리 테스트베드 · 6셀 혼류</small></div>
    <div class="seg small" id="slotSeg">${seg}</div>${body}`;
  updateZoneCard();
}
function updateZoneCard() {
  if (!isZone(currentLine)) return;
  for (const el of zoneCard.querySelectorAll('[data-chip]')) {
    const st = sim.stations.find((s) => s.id === el.dataset.chip);
    const idle = st && st.def.share === 0;
    el.className = 'chip s-' + (idle ? 'OFF' : st.state);
    el.textContent = idle ? '투입 없음' : ST_LABEL[st.state];
  }
  const n = (k) => sim.carriers.filter((c) => c.state === k).length;
  const g = sim.stats.goodBy;
  const amr = document.getElementById('zcAmr');
  if (amr) amr.innerHTML = `양품 도어트림 <b>${g.doortrim ?? 0}</b> · e-axle <b>${g.eaxle ?? 0}</b> · 구분 적재 <b>${sim.fgBy.doortrim}</b> / <b>${sim.fgBy.eaxle}</b>`
    + (sim.carriers.length ? `<br>🛻 AMR ${sim.carriers.length}대 · 적재 운반 <b>${n('line')}</b> · 빈차 복귀 <b>${n('return')}</b> · 대기 <b>${n('park') + n('toSrc') + n('atSrc')}</b>` : '<br>셀 간 물류: 고정 컨베이어 (레거시)');
}
zoneCard.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-slot]');
  if (b && b.dataset.slot !== lineSlot) {
    lineSlot = b.dataset.slot; currentLine = lines[lineSlot];
    saveLines();
    view.selected = null; changedIds = null;
    start(modeKey);
    designer?.sync();
    return;
  }
  const mb = e.target.closest('button[data-mix]');
  if (mb && mb.dataset.mix !== currentLine.mix) {
    currentLine = lines.zone = { ...currentLine, mix: mb.dataset.mix };
    saveLines();
    view.selected = null;
    start(modeKey);
    designer?.sync();
    const w = ZONE_MIXES[currentLine.mix];
    sim.log('act', `혼류 비율 변경 · 도어트림 : e-axle = ${w.label}`, {
      obs: `투입 순서를 비율에 맞춰 평준화 (도어트림 ${w.w.doortrim} : e-axle ${w.w.eaxle})`,
      dec: '1.부품분류셀이 부품 종류를 판별해 제품별 라인으로 분기, 6.포장셀에서 합류',
      act: '시뮬레이션 재시작',
    });
    return;
  }
  const cell = e.target.closest('[data-cell]');
  if (cell) {
    const st = sim.stations.find((s) => s.id === cell.dataset.cell);
    if (st) { view.selected = st.id; ui.showDetail(st); }
  }
});

// ── 입력 ─────────────────────────────
function segOn(seg, btn) { seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn)); }
document.getElementById('modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  segOn(e.currentTarget, b); start(b.dataset.mode);
});
document.getElementById('speedSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  segOn(e.currentTarget, b); speed = +b.dataset.speed;
});
const playBtn = document.getElementById('playBtn');
playBtn.addEventListener('click', () => { running = !running; playBtn.textContent = running ? '❚❚' : '▶'; });
document.getElementById('btnFault').addEventListener('click', () => {
  const cands = sim.processing.filter((s) => s.state !== 'DOWN' && s.state !== 'MAINT');
  const st = cands[Math.floor(Math.random() * cands.length)];
  if (st) { sim.log('warn', `[시나리오] ${st.name} 고장 주입`, {}); sim.injectFault(st); orchView.show('equipment'); }
});
document.getElementById('btnOrch').addEventListener('click', () => orchView.toggle());
// 상단 비상정지: 발령 중이 아니면 전체 비상정지, 발령 중이면 리셋 명령 (어느 쪽이든 명령 콘솔을 연다)
const btnEstop = document.getElementById('btnEstop'), cmdBanner = document.getElementById('cmdBanner');
btnEstop.addEventListener('click', () => {
  const K = sim.cmd;
  K.issue(K.estopAll ? 'RESET' : 'ESTOP', 'all', null, { by: `${sim.orch.name} · 비상정지 버튼` });
  orchView.show('cmd');
});
function updateCmdUI() {
  const K = sim.cmd, pend = K.active().find((c) => c.code === 'ESTOP' || c.code === 'RESET');
  btnEstop.textContent = K.estopAll ? '🔄 비상정지 리셋' : '🛑 비상정지';
  btnEstop.classList.toggle('armed', K.estopAll);
  const sts = sim.processing.filter((st) => st.cmd?.estop);
  const msg = K.estopAll ? ['🛑 비상정지 발령 — 정밀조립Zone 전체 정지 (로봇·AMR·이동로봇 정지) · 리셋 명령으로 재가동', 'bad']
    : sts.length ? [`🛑 셀 비상정지 — ${sts.map((st) => st.name).join(', ')} · 리셋 필요`, 'bad']
    : sim.processing.some((st) => st.cmd?.check > 0) ? ['🔄 비상정지 해제 — 셀 자가진단 중', 'info']
    : K.pstopAll ? ['✋ 보호정지 — 정밀조립Zone 전체 감속 정지 · 재개 명령 대기', 'warn']
    : K.evac ? ['🏃 이동로봇 대피 중 — 운전 재개 명령으로 복귀', 'warn']
    : pend ? [`📡 ${K.label(pend)} 명령 전송 중…`, 'info'] : null;
  cmdBanner.hidden = !msg;
  if (msg) { cmdBanner.textContent = msg[0]; cmdBanner.className = `cmd-banner ${msg[1]}`; }
}
document.getElementById('btnEvent').addEventListener('click', () => {
  const ev = camWall.injectRandom();
  if (ev) { sim.log('warn', `[시나리오] 현장 이벤트 발생 · ${ev.label}`, { obs: '아직 아무도 인지하지 못한 상태 — 로봇 카메라 영상의 AI 추론으로 감지되면 자율 대응합니다' }); orchView.show('field'); }
});
document.getElementById('btnSupply').addEventListener('click', () => {
  sim.disruptSupply(600); orchView.show('supply');
  sim.log('warn', '[시나리오] 자재 창고 출고 10분 중단', { obs: '협력사 납품 지연 상황 재현' });
});
document.getElementById('btnLabels').addEventListener('click', (e) => {
  labelsOn = !labelsOn; e.currentTarget.classList.toggle('on', labelsOn); view.setLabels(labelsOn);
});
document.getElementById('engineSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  llm.setEnabled(b.dataset.engine === 'llm');
  sim.log('info', llm.enabled ? '대화 기반으로 전환' : '추론 기반으로 전환', {
    obs: llm.enabled ? '추론 기반 에이전트가 계속 운영하고, 입력창 지시를 해석해 공정에 반영' : '추론 기반 에이전트가 모든 판단을 수행',
    act: llm.enabled ? `해석: 내장 해석기${llm.available ? ' + Agent 보조' : ''}` : '',
  });
});
document.getElementById('pauseThink').addEventListener('change', (e) => { llm.pauseWhileThinking = e.target.checked; });
document.getElementById('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (text && llm.chat(text)) input.value = '';
});
document.getElementById('btnReset').addEventListener('click', () => start(modeKey));
document.getElementById('btnCompare').addEventListener('click', () => ui.runCompare(SEED, currentLine));
document.getElementById('closeCompare').addEventListener('click', () => document.getElementById('compare').classList.add('hidden'));

// ── 데이터 연동 (기준 시계 · AAS · OPC UA PubSub over MQTT · 파일 저장) ─────────────────
const dataModal = document.getElementById('datahub'), dataBody = document.getElementById('dataBody');
let dataTimer = null, dataNote = '';
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const FORMATS = [
  ['json', 'JSON', 'AAS JSON 직렬화 (셸·서브모델·개념 설명, 자산별 최근 60개 기록 + 전체는 CSV 참조)'],
  ['xml', 'XML', 'AAS XML 스키마 v3.0 (네임스페이스 admin-shell.io/aas/3/0), JSON과 같은 구성'],
  ['rdf', 'RDF', 'AAS RDF 매핑 · Turtle(.ttl), JSON과 같은 구성'],
  ['csv', 'CSV', '시계열·이벤트 긴 형식 (타임스탬프·자산·항목·값·단위)'],
  ['aml', 'AutomationML', 'CAEX 3.0 공장 계층 + AAS id + 최신 값, CSV 시계열 참조'],
];
function renderData() {
  const st = hub.stats(), mq = hub.mqtt, ms = mq.status;
  const kinds = hub.assets.reduce((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
  const kindLabel = { Factory: '라인', Station: '설비·셀', CellRobot: '셀 로봇', AMR: '운반 AMR', AGV: 'AGV', Forklift: '지게차', Humanoid: '휴머노이드', Quadruped: '사족보행', MaintenanceRobot: '정비로봇' };
  const broker = hub.shared ? '<b class="bad">공유 페이지에서는 사용할 수 없음</b> — 데이터 수집만 합니다. MQTT 발행과 파일 저장은 맥 앱이나 npm start로 실행하세요'
    : hub.noServer ? '<b class="bad">웹 버전에서는 사용할 수 없음</b> — 데이터 수집과 파일 저장은 됩니다. MQTT 발행은 맥 앱이나 npm start로 실행하세요'
    : mq.available === false ? '<b class="bad">연결 안 됨</b> — 서버(npm start 또는 맥 앱) 없이 열려 있어 수집·저장만 합니다'
    : !ms ? '확인 중…' : ms.listening ? `<b class="ok">실행 중</b> · mqtt://${ms.host}:${ms.port} · 구독 클라이언트 ${ms.clients}개` : `<b class="bad">시작 실패</b> — ${escH(ms.error ?? '')}`;
  const preview = hub.lastMsg ? JSON.stringify(hub.lastMsg.msg, null, 1).slice(0, 1600) : '(아직 발행 전)';
  dataBody.innerHTML = `
    <div class="dh-grid">
      <section><h4>🕒 기준 시계 (동기화)</h4><div class="grid2">
        <span>현재 기준 시각 (UTC)</span><b>${hub.iso()}</b>
        <span>기준점</span><b>시뮬레이션 0초 = ${hub.iso(0)}</b>
        <span>실행 ID</span><b>${hub.runId}</b>
        <span>적용 범위</span><b>운영 데이터 · 이벤트 · OPC UA 메시지 · 저장 파일 전부</b></div></section>
      <section><h4>📥 수집</h4><div class="grid2">
        <span>수집 주기</span><b><select id="dhInterval">${[1, 5, 10, 30].map((v) => `<option value="${v}"${v === hub.interval ? ' selected' : ''}>${v}초 (시뮬레이션 시간)</option>`).join('')}</select></b>
        <span>자산 (AAS)</span><b>${st.assets}개 · 항목 ${st.fields}개</b>
        <span>수집 회차 / 데이터 포인트</span><b>${st.samples.toLocaleString()}회 / ${st.points.toLocaleString()}개</b>
        <span>이벤트</span><b>${st.events.toLocaleString()}건</b>
        <span>기간</span><b>${st.from ? `${st.from.slice(11, 19)} ~ ${st.to.slice(11, 19)} UTC` : '-'}</b></div>
        <div class="dh-kinds">${Object.entries(kinds).map(([k, n]) => `<i>${kindLabel[k] ?? k} ${n}</i>`).join('')}</div></section>
      <section class="span2"><h4>📡 OPC UA PubSub (Part 14, JSON) over MQTT</h4><div class="grid2">
        <span>내장 MQTT 브로커</span><b>${broker}</b>
        <span>발행</span><b><label class="chk"><input type="checkbox" id="dhPub" ${hub.publishOn ? 'checked' : ''}/> 수집할 때마다 발행</label> · 보낸 메시지 ${mq.sent.toLocaleString()}개${ms ? ` · ${kb(ms.bytes)}` : ''}${ms?.bridgeUrl ? ` · 외부 브로커 ${escH(ms.bridgeUrl)} ${ms.bridgeConnected ? '연결됨' : '미연결'}` : ''}</b>
        <span>데이터 토픽</span><b><code>opcua/json/data/${PUBLISHER_ID}/${WRITER_GROUP}/&lt;자산 id&gt;</code> (ua-data · ua-keyframe)</b>
        <span>메타데이터 토픽</span><b><code>opcua/json/metadata/${PUBLISHER_ID}/${WRITER_GROUP}/&lt;자산 id&gt;</code> (ua-metadata · retain, AAS semanticId 포함)</b>
        <span>상위 명령</span><b><code>opcua/json/data/${PUBLISHER_ID}/${WRITER_GROUP}/Commands</code> (명령 상태가 바뀔 때마다: 전송 · 수신 확인 · 실행 · 완료/거부)</b>
        <span>이벤트 · AAS 모델</span><b><code>opcua/json/data/${PUBLISHER_ID}/${WRITER_GROUP}/Events</code> · <code>aas/${PUBLISHER_ID}/environment</code> (retain)</b></div>
        <details><summary>마지막 NetworkMessage — <code>${escH(hub.lastMsg?.topic ?? '')}</code></summary><pre class="dh-pre">${escH(preview)}</pre></details></section>
      <section class="span2"><h4>💾 저장 (현재까지 수집한 데이터)</h4>
        <div class="dh-save">${FORMATS.map(([k, n, d]) => `<button data-fmt="${k}"><b>${n}</b><small>${d}</small></button>`).join('')}</div>
        <div class="dh-note">${escH(dataNote)}</div></section>
    </div>
    <div class="cmp-note">• 자산마다 AAS(IDTA Part 1 v3.0)를 두고 서브모델 Nameplate · TechnicalData · OperationalData(실시간) · TimeSeries(IDTA 02008)로 구성합니다. 각 OPC UA 필드는 메타데이터에 AAS id·서브모델 id·idShort·semanticId를 담아 AAS 모델과 연결됩니다.<br>
    • 외부 PC에서 받으려면 서버를 <code>MQTT_HOST=0.0.0.0</code>으로 실행하거나 <code>MQTT_BRIDGE_URL</code>로 사내 브로커에 함께 발행합니다. MQTT Explorer 등에서 <code>opcua/json/#</code>를 구독해 확인할 수 있습니다.<br>
    • 값은 시뮬레이션 결과이며, 자산 정보의 제조사명은 "가상 자산"으로 표시됩니다.</div>`;
}
document.getElementById('btnData').addEventListener('click', () => {
  dataModal.classList.remove('hidden'); dataNote = '';
  hub.refreshStatus().then(renderData); renderData();
  clearInterval(dataTimer); dataTimer = setInterval(() => { hub.refreshStatus().then(() => { if (!dataModal.classList.contains('hidden') && !dataBody.contains(document.activeElement)) renderData(); }); }, 1500);
});
document.getElementById('closeData').addEventListener('click', () => { dataModal.classList.add('hidden'); clearInterval(dataTimer); });
dataBody.addEventListener('change', (e) => {
  if (e.target.id === 'dhInterval') { hub.interval = +e.target.value; e.target.blur(); renderData(); }
  if (e.target.id === 'dhPub') { hub.publishOn = e.target.checked; e.target.blur(); renderData(); }
});
dataBody.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fmt]'); if (!b) return;
  if (hub.shared) { dataNote = '공유 페이지에서는 브라우저 보안 정책으로 파일 내려받기가 막혀 있습니다. 맥 앱이나 npm start로 실행한 화면에서 저장하세요.'; return renderData(); }
  if (!hub.samples.length) { dataNote = '아직 수집된 데이터가 없습니다. 시뮬레이션을 잠시 돌린 뒤 저장하세요.'; return renderData(); }
  const out = hub.download(b.dataset.fmt);
  dataNote = out ? `저장: ${out.name} (${kb(out.bytes)})${b.dataset.fmt === 'aml' ? ' — 시계열은 같은 이름의 CSV를 함께 저장해 두면 연결됩니다' : ''}` : '';
  renderData();
});

// ── 공장 진화 컨셉 (레거시 → 자동화 → 피지컬AI 자율) ─────────────────
const conceptModal = document.getElementById('concept'), conceptBody = document.getElementById('conceptBody');
function showConcept(busy = false) {
  renderConcept(conceptBody, { current: modeKey, res: ui.cachedCompare(SEED, currentLine), lineName: currentLine.name, busy });
}
document.getElementById('btnConcept').addEventListener('click', () => { conceptModal.classList.remove('hidden'); showConcept(); });
document.getElementById('closeConcept').addEventListener('click', () => conceptModal.classList.add('hidden'));
conceptBody.addEventListener('click', (e) => {
  const st = e.target.closest('button[data-stage]');
  if (st) {
    const b = document.querySelector(`#modeSeg button[data-mode="${st.dataset.stage}"]`);
    segOn(document.getElementById('modeSeg'), b); start(st.dataset.stage);
    conceptModal.classList.add('hidden');
    return;
  }
  if (e.target.closest('button[data-calc]')) {
    showConcept(true);
    setTimeout(() => { ui.computeCompare(SEED, currentLine); showConcept(); }, 30);
  }
});

// 설비 선택
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
labelRenderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
labelRenderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  // 로봇 비전 관제 화면의 영상 칸을 누르면 그 로봇을 선택한다
  if (camWall.group.visible) {
    const w = ray.intersectObject(camWall.screen, false)[0];
    if (w?.uv && camWall.list?.length) {
      const col = Math.min(CAM_COLS - 1, Math.floor(w.uv.x * CAM_COLS)), row = w.uv.y > 0.5 ? 0 : 1;
      const f = camWall.list[row * CAM_COLS + col];
      if (f) { view.selected = f.ref.type === 'cell' ? f.ref.stationId : null; view.selectRobot(f.ref); ui.showRobot(); robotTimer = 1; return; }
    }
  }
  // 로봇(셀 로봇·AMR·AGV·휴머노이드·사족보행)을 누르면 관절·센서 텔레메트리, 설비를 누르면 설비 상세
  const hit = view.pick(ray.intersectObjects(view.pickTargets(), true));
  if (hit && hit.type !== 'station') {
    view.selected = hit.type === 'cell' ? hit.stationId : null;
    view.selectRobot(hit); ui.showRobot(); robotTimer = 1;
    return;
  }
  view.selectRobot(null);
  const st = hit && (sim.stations.find((s) => s.id === hit.id) ?? sim.standby.find((s) => s.id === hit.id));
  if (st) { view.selected = hit.id; ui.showDetail(st); }
  else { view.selected = null; ui.hideDetail(); }
});
ui.onDetailAction = (act, st) => {
  if (act === 'fault') { sim.log('warn', `[시나리오] ${st.name} 고장 주입`, {}); sim.injectFault(st); }
  if (act === 'pm') {
    if (sim.requestTech(st, 'pm')) sim.log('act', `[수동 지시] ${st.name} 정비`, { act: '정비 인력 배정' });
  }
  if (act === 'close') { view.selected = null; view.selectRobot(null); ui.hideDetail(); }
  if (act === 'robotSave' && view.telemetry && hub.shared) ui.robotSaved('공유 페이지에서는 브라우저 보안 정책으로 파일 내려받기가 막혀 있습니다. 맥 앱이나 npm start로 실행한 화면에서 저장하세요.');
  else if (act === 'robotSave' && view.telemetry) {
    const fmt = document.getElementById('rbFmt').value;
    try {
      const out = hub.downloadRobot(view.telemetry, fmt);
      ui.robotSaved(`저장: ${out.name} (${out.bytes > 1048576 ? (out.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(out.bytes / 1024)) + ' KB'})`);
    } catch (e) { ui.robotSaved(`저장 실패: ${e.message}`); }
  }
};

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  persp.aspect = innerWidth / innerHeight; persp.updateProjectionMatrix();
});

// ── 로봇 텔레메트리 패널 위치: 선택한 로봇이 패널에 가려지면 반대쪽(왼쪽 ↔ 오른쪽)으로 옮긴다 ─────────────────
const detailEl = document.getElementById('detail');
const _p = new THREE.Vector3();
function robotScreenRect() {
  const obj = view.telemetry?.R?.obj; if (!obj) return null;
  obj.getWorldPosition(_p);
  const pts = [0, 1.6].map((dy) => { const v = _p.clone(); v.y += dy; v.project(camera); return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, z: v.z }; });
  if (pts.some((q) => q.z > 1)) return null;   // 카메라 뒤쪽
  const pad = 50;
  return { l: Math.min(...pts.map((q) => q.x)) - pad, r: Math.max(...pts.map((q) => q.x)) + pad, t: Math.min(...pts.map((q) => q.y)) - pad, b: Math.max(...pts.map((q) => q.y)) + pad };
}
function placeRobotPanel() {
  const rb = robotScreenRect(); if (!rb) return;
  const cur = detailEl.getBoundingClientRect(), right = detailEl.classList.contains('side-right');
  const w = cur.width, rightGap = innerWidth <= 1100 ? 304 : 364, leftX = innerWidth <= 1100 ? 270 : 314;
  const rects = { left: { l: leftX, r: leftX + w, t: cur.top, b: cur.bottom }, right: { l: innerWidth - rightGap - w, r: innerWidth - rightGap, t: cur.top, b: cur.bottom } };
  const hit = (a) => !(a.r < rb.l || a.l > rb.r || a.b < rb.t || a.t > rb.b);
  const dist = (a) => Math.abs((a.l + a.r) / 2 - (rb.l + rb.r) / 2);
  const now = right ? 'right' : 'left', other = right ? 'left' : 'right';
  if (!hit(rects[now])) return;
  if (!hit(rects[other]) || dist(rects[other]) > dist(rects[now])) detailEl.classList.toggle('side-right', other === 'right');
}

// ── 하단 시나리오 버튼 경보: 고장·공급 차질·현장 이벤트가 진행 중이면 해당 버튼이 깜빡이고 건수를 보여 준다 ─────────────────
const alarmBtns = { fault: document.getElementById('btnFault'), supply: document.getElementById('btnSupply'), event: document.getElementById('btnEvent') };
function updateAlarmButtons() {
  const n = {
    fault: sim.processing.filter((st) => st.state === 'DOWN').length,
    supply: sim.supplyAlarm ? 1 : 0,
    event: (sim.fieldEvents ?? []).filter((e) => !e.cleared).length,
  };
  for (const [k, b] of Object.entries(alarmBtns)) {
    b.classList.toggle(`alarm-${k}`, n[k] > 0);
    if (n[k] > 0) b.dataset.count = k === 'supply' ? (sim.supplyDisrupted ? `${Math.ceil((sim.supplyDisruptedUntil - sim.time) / 60)}분` : '복구 중') : `${n[k]}건`;
    else delete b.dataset.count;
  }
}

// ── 루프 ─────────────────────────────
const clock = new THREE.Clock();
let uiTimer = 0, screenTimer = 0, robotTimer = 0, camTimer = 0;
const clockEl = document.getElementById('clock');
function frame() {
  const rdt = Math.min(clock.getDelta(), 0.1);
  if (running && !llm.holdSim) {
    let left = rdt * speed;
    while (left > 1e-6) {
      const h = Math.min(0.1, left);
      sim.step(h); agent.update(h);
      left -= h;
    }
    llm.update();
  }
  hub.tick(rdt);
  view.update(rdt, running, speed);
  controls.update();
  uiTimer += rdt; screenTimer += rdt;
  if (uiTimer > 0.25) { uiTimer = 0; ui.update(); view.updateLabels(); updateZoneCard(); orchView.tick(); gateView.tick(); updateAlarmButtons(); updateCmdUI(); clockEl.title = `기준 시계 (UTC) ${hub.iso()} · 모든 데이터·메시지가 이 시각을 씁니다`; }
  robotTimer += rdt;
  if (view.telemetry && robotTimer > 0.12) { robotTimer = 0; ui.renderRobot(view.telemetry.snapshot(), hub.robotCounts(view.telemetry)); }
  // 피지컬AI: 로봇 정보 창에 그 로봇 카메라의 실시간 영상 (약 10fps)
  camTimer += rdt;
  if (view.telemetry && ui.robotMode && camTimer > 0.1) {
    camTimer = 0;
    const box = document.getElementById('rbCamBox'), cv = document.getElementById('rbCam');
    const shown = modeKey === 'dark' && box && cv && camWall.renderRobotView(view.telemetry.ref, cv, (() => { const t = Math.floor(sim.time) + 8 * 3600; return [t / 3600 % 24, t / 60 % 60, t % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); })());
    if (box) box.hidden = !shown;
  }
  if (view.telemetry && ui.robotMode) placeRobotPanel();
  if (screenTimer > 0.6 && modeKey !== 'traditional') { screenTimer = 0; view.drawScreen(sim.kpi(), agent.lastThought); }
  camWall.update(rdt);
  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frame);
}

start('smart');
frame();

designer = new LineDesigner({
  llm,
  getLine: () => currentLine,
  onApply(line, diff, { warnings, request, files }) {
    currentLine = lines[lineSlot] = line;
    saveLines();
    changedIds = new Set(diff.filter((d) => d.kind !== 'del' && d.id).map((d) => d.id));
    view.selected = null;
    start(modeKey);
    sim.log('act', `공정 변경 적용 · ${line.name}`, {
      obs: [files?.length ? `첨부: ${files.join(', ')}` : '', request ? `요청: ${request}` : '직접 편집'].filter(Boolean).join(' · '),
      dec: diff.map((d) => d.text).join(' / '),
      act: warnings.length ? `주의: ${warnings.join(' / ')}` : '3D 배치와 시뮬레이션을 새 라인으로 재시작',
    });
    setTimeout(() => { changedIds = null; view.stationViews.forEach((sv) => sv.el.classList.remove('changed')); }, 30000);
  },
});
llm.probe();

// ── 맥 앱(Jin-3D) 전용: API 키 설정 ─────────────────
const bridge = window.jin3d;
if (bridge?.isApp) {
  document.body.classList.add('app');
  const modal = document.getElementById('settings');
  const statusEl = document.getElementById('keyStatus');
  const input = document.getElementById('keyInput');
  const showStatus = (st, msg) => {
    statusEl.className = 'key-status ' + (msg ? 'err' : st.hasKey ? 'ok' : '');
    statusEl.textContent = msg || (st.hasKey
      ? `키 설정됨 (${st.source === 'keychain' ? '키체인에 저장' : '환경변수'}) — 대화 기반 Agent를 쓸 수 있습니다`
      : '키가 없습니다 — 추론 기반 에이전트만 사용 가능');
  };
  const open = async () => { modal.classList.remove('hidden'); input.value = ''; showStatus(await bridge.keyStatus()); input.focus(); };
  const afterChange = async (res) => {
    if (!res.ok) return showStatus(res, res.error);
    showStatus(res); input.value = '';
    await llm.probe();
    if (!llm.available && llm.enabled) llm.setEnabled(false);
  };
  bridge.onOpenSettings(open);
  document.getElementById('btnSettings').addEventListener('click', open);
  document.getElementById('closeSettings').addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('keyForm').addEventListener('submit', async (e) => { e.preventDefault(); afterChange(await bridge.setApiKey(input.value)); });
  document.getElementById('keyClear').addEventListener('click', async () => afterChange(await bridge.clearApiKey()));
}
window.__twin = { get sim() { return sim; }, get agent() { return agent; }, view, ui, hub, camWall, orchView, persp, ctlP, llm };
