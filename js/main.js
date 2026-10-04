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
import { PacketCapture } from './pcap.js';
import { ODOO_PRODUCTS, ODOO_LOCS } from './odoo.js';
import { RobotCamWall, COLS as CAM_COLS } from './robotcam.js';
import { GateView } from './gateview.js';
import { EpisodeRecorder, buildEpisodesZip, EP_HZ, SAMPLE } from './vla.js';
import { buildAiosZip, HEADS as AIOS_HEADS, FEATURES as AIOS_FEATURES, SAMPLE_S as AIOS_SAMPLE_S, CHUNK as AIOS_CHUNK, TRAIN_MIN as AIOS_TRAIN_MIN } from './aios.js';
import { zipStore } from './aasx.js';
import { DRONE_SIZING } from './drone.js';
import { CCTVView, CCTV_CLASSES } from './cctvview.js';
import { AI_MODELS } from './cctv.js';
import { NR, STACK } from './net5g.js';
import { OrchView } from './orchview.js';
import { DEFAULT_LINE, normalizeLine, cloneLine, zoneLine, isZone, ZONE_CELLS, ZONE_PRODUCTS, ZONE_MIXES, ZONE_NAME } from './line.js';

// ── 렌더러 ─────────────────────────────
const host = document.getElementById('viewport');
// 렌더러는 GPU 컨텍스트를 잃으면(화면 전환·잠자기·GPU 프로세스 재시작 등) 새로 만들 수 있게 함수로 만든다
const makeRenderer = () => {
  const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(innerWidth, innerHeight);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  return r;
};
let renderer = makeRenderer();
host.prepend(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
host.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();

// ── 카메라: 3D 원근 ─────────────────
const target = new THREE.Vector3(-5.5, 0, 1);   // 건물 가운데 (생산동 + 왼쪽 물류 확장동)
const persp = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 400);
persp.position.set(-10.5, 45, 58);
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
Object.assign(sun.shadow.camera, { left: -58, right: 45, top: 30, bottom: -30, near: 1, far: 120 });
sun.shadow.bias = -0.0005;
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9ec9ff, 0.4);
fill.position.set(30, 20, -20);
scene.add(fill);

// ── 후처리(블룸) ─────────────────────────────
let composer, renderPass, bloom;
const makeComposer = () => {
  const keep = bloom && [bloom.strength, bloom.radius, bloom.threshold];
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.5, 0.9);
  if (keep) [bloom.strength, bloom.radius, bloom.threshold] = keep;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
};
makeComposer();

// ── 시뮬레이션 ─────────────────────────────
const view = new FactoryView(scene);
const hub = new DataHub();
const camWall = new RobotCamWall(scene, renderer);   // 로봇 비전 관제 디스플레이 (피지컬AI 단계)
const cctvView = new CCTVView(scene, () => camWall.renderer, scene);   // CCTV 전광판 · CCTV 영상 창
const epRec = new EpisodeRecorder(view, camWall, hub);   // VLA 에피소드 기록기 (피지컬AI 단계)
view.epRec = epRec;
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
  cctvView.setup(sim, view);
  epRec.attach(sim);
  orchView.attach(sim);
  window.__cctvRefresh?.();
  window.__netRefresh?.();   // 라인·단계가 바뀌면 CCTV 배치 요약도 다시
  if (typeof designer !== 'undefined' && designer) designer.render();   // AMMR 선택 가능 여부가 단계마다 다르다
  applyLook();
  llm.attach(sim, agent);
  ui.reset(sim, agent);
  ui.hideDetail();
  sim.log('info', `${MODES[key].label} 시뮬레이션 시작`, {
    obs: key === 'traditional' ? '작업자 중심 수동 운영, 고정 컨베이어·지게차, 사후보전 체계' : key === 'smart' ? `양쪽 협동로봇 셀·AMR 운반, IoT·MES 연결, 현장 인원 ${sim.peopleOnSite()}명 (출하 지게차 운전 포함)` : '무인 운영 — 휴머노이드 4대(정비 2·부품 보충 2), 사족보행 순찰 2대, AMR·AGV, 고효율 LED 조명',
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
    + (sim.carriers.length ? `<br>🛻 AMR ${sim.carriers.length}대 · 적재 운반 <b>${n('line')}</b> · 빈차 복귀 <b>${n('return')}</b> · 대기 <b>${n('park') + n('toSrc') + n('docking') + n('atSrc')}</b>` : '<br>셀 간 물류: 고정 컨베이어 (레거시)')
    + `<br>🚚 입고 · 창고 원자재 <b>${sim.whRaw}</b>${sim.partsTracked ? ` · 부품 <b>${sim.whParts}</b>` : ''} · 입고 트럭 <b>${sim.inbound.stats.trucks}</b>대${sim.inbound.docked ? ' · 하차 중' : sim.inbound.trucks.length ? ' · 입차 중' : sim.inbound.orders.length ? ' · 발주됨' : ''}`;
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
// ── Odoo ERP 연동 창: 발주 · 재고 · 설비보전 + 실시간 Odoo 연결 ─────────────────
const odooModal = document.getElementById('odooModal'), odooBody = document.getElementById('odooBody');
let odooTab = 'po', odooTimer = null, odooSrv = null, odooNote = '', odooSyncT = 0, odooBusy = false;
const won = (v) => `${Math.round(v).toLocaleString('ko-KR')}원`;
const fclk = (tt) => tt == null ? '-' : [3600, 60, 1].map((d, i) => String(Math.floor((Math.floor(tt) + 8 * 3600) / d) % (i ? 60 : 24)).padStart(2, '0')).join(':');
const pcode = (k) => ODOO_PRODUCTS[k]?.code ?? k, lname = (k) => ODOO_LOCS[k]?.name ?? k;
async function odooStatus() { if (hub.noServer) { odooSrv = null; return; } try { odooSrv = await (await fetch('/api/odoo/status')).json(); } catch { odooSrv = null; } }
function renderOdoo() {
  const E = sim.erp;
  if (!E?.on) { odooBody.innerHTML = '<div class="dh-note">레거시 공장은 ERP 연동이 없습니다 (수기 발주·장부). 자동화·피지컬AI 단계에서 Odoo와 연동합니다.</div>'; return; }
  const S = E.stats(), Q = E.quant, n = (v) => Math.round(v).toLocaleString('ko-KR');
  const st = (x) => `<span class="od-st ${x === 'done' || x === 'purchase' ? 'done' : x === 'new' ? 'new' : 'wait'}">${{ done: '완료', assigned: '준비됨', purchase: '구매오더', progress: '진행 중', new: '신규' }[x] ?? x}</span>`;
  const tabs = { po: `🧾 발주 (구매오더 ${S.po})`, stock: `📦 재고 (전표 ${E.db.picking.length})`, mr: `🔧 설비보전 (정비요청 ${S.mr})`, live: '🔗 실시간 Odoo 연결', log: '📜 연동 로그' };
  let body = '';
  if (odooTab === 'po') body = `<table class="od-tbl"><tr><th>구매오더</th><th>공급사</th><th>주문 시각</th><th>품목 (주문 / 입고)</th><th>금액</th><th>입고 전표</th><th>트럭</th><th>상태</th></tr>
    ${E.db.po.slice(0, 40).map((p) => `<tr><td>${p.name}</td><td>${escH(p.partner)}</td><td>${fclk(p.date_order)}</td><td>${p.lines.map((l) => `${pcode(l.product)} ${n(l.qty)} / ${n(l.received)}`).join('<br>')}</td><td>${won(p.amount)}</td><td>${p.receipt}</td><td>${p.truck ?? '발주됨'}</td><td>${p.received ? st('done') : st('purchase')}</td></tr>`).join('') || '<tr><td colspan="8">아직 구매오더가 없습니다 — 물류 선반 재고가 재주문점 아래로 내려가면 WMS가 발주합니다</td></tr>'}</table>
    <div class="cmp-note">재주문 규칙(stock.warehouse.orderpoint): ${E.orderpoints.map((o) => `${pcode(o.product)} @ ${lname(o.location)} 최소 ${n(o.min)} · 최대 ${n(o.max)}`).join(' / ')} — 재고 + 발주분이 최소 아래면 최대까지 발주 (트럭 4팔레트 한도)</div>`;
  else if (odooTab === 'stock') body = `<table class="od-tbl"><tr><th>로케이션</th>${Object.keys(ODOO_PRODUCTS).map((k) => `<th>${pcode(k)}</th>`).join('')}</tr>
    ${['rackRaw', 'rackParts', 'feeder', 'cells', 'output', 'customer'].map((k) => `<tr><td>${lname(k)}</td>${Object.keys(ODOO_PRODUCTS).map((p) => `<td>${Q[k][p] ? n(Q[k][p]) : '·'}</td>`).join('')}</tr>`).join('')}</table>
    <table class="od-tbl" style="margin-top:8px"><tr><th>전표</th><th>유형</th><th>근거</th><th>품목</th><th>출발 → 도착</th><th>시각</th><th>상태</th></tr>
    ${E.db.picking.slice(0, 40).map((p) => `<tr><td>${p.name}</td><td>${{ incoming: '입고', internal: '내부 이동', production: '생산 입고', outgoing: '출고' }[p.type]}</td><td>${escH(p.origin ?? '')}</td><td>${p.lines.map((l) => `${pcode(l.product)} ${n(l.done)}${l.qty !== l.done ? ` / ${n(l.qty)}` : ''}${l.trips ? ` (${l.trips}회)` : ''}`).join('<br>')}</td><td>${lname(p.lines[0]?.from ?? p.from)} → ${lname(p.lines[0]?.to ?? p.to)}</td><td>${fclk(p.done ?? p.created)}</td><td>${st(p.state)}</td></tr>`).join('')}</table>`;
  else if (odooTab === 'mr') body = `<table class="od-tbl"><tr><th>정비요청</th><th>설비 (일련번호)</th><th>유형</th><th>요청</th><th>담당</th><th>소요</th><th>단계</th><th>내용</th></tr>
    ${E.db.mr.slice(0, 40).map((m) => `<tr><td>${m.ref}</td><td>${escH(m.equipmentName)} (${m.equipment})</td><td>${m.type === 'corrective' ? '긴급 (고장)' : '예방'}</td><td>${fclk(m.request_date)}</td><td>${m.tech ?? '-'}</td><td>${m.stage === 'done' ? `${Math.round(m.duration * 60)}분` : '-'}</td><td>${st(m.stage)}</td><td>${escH(m.description)}</td></tr>`).join('') || '<tr><td colspan="8">정비요청이 없습니다</td></tr>'}</table>
    <div class="cmp-note">설비 ${S.equipment}대 등록 (셀·셀 로봇·운반 AMR·AGV·지게차·휴머노이드·사족보행·드론, 일련번호 = 설비 고유 ID). 정비요청이 많은 설비: ${E.db.equipment.filter((e) => e.requests).sort((a, b) => b.requests - a.requests).slice(0, 4).map((e) => `${e.name} ${e.requests}건 (${Math.round(e.downtime * 60)}분)`).join(' · ') || '-'}</div>`;
  else if (odooTab === 'live') {
    const v = odooSrv;
    body = hub.noServer ? '<div class="dh-note">웹·공유 페이지에서는 서버가 없어 실시간 Odoo 연동을 쓸 수 없습니다 — 시뮬레이션 Odoo로 기록합니다. 맥 앱이나 npm start로 실행하세요.</div>'
      : `<div class="od-live"><div><b>서버 게이트웨이</b> (server/odoo-gateway.mjs → Odoo 외부 API JSON-RPC <code>/jsonrpc</code>) · ${v ? (v.configured ? `설정됨 — ${escH(v.url)} · DB ${escH(v.db)} · ${escH(v.user)}${v.connected ? ` · <b class="ok">연결됨</b> (Odoo ${escH(v.version ?? '')}, uid ${v.uid})` : ' · 미연결'}` : '<b class="bad">설정 없음</b>') : '확인 중…'}</div>
        <div class="row"><input id="odUrl" placeholder="https://mycompany.odoo.com" value="${escH(v?.url ?? '')}"/><input id="odDb" placeholder="데이터베이스" value="${escH(v?.db ?? '')}"/><input id="odUser" placeholder="로그인 (이메일)" value="${escH(v?.user ?? '')}"/><input id="odKey" type="password" placeholder="${v?.hasKey ? 'API 키 (저장됨 — 바꿀 때만 입력)' : 'API 키'}"/><button data-od="config">설정</button></div>
        <div class="row"><label class="chk"><input type="checkbox" id="odLive" ${E.live ? 'checked' : ''}/> 실시간 Odoo로 보내기 (2초마다 묶음 전송)</label> · 보낸 이벤트 ${n(E.sent)} · 대기 ${n(E.outbox.length)}${v ? ` · Odoo 적용 ${n(v.sent)} · 실패 ${n(v.failed)}` : ''}</div>
        ${v?.lastError ? `<div class="bad">최근 오류: ${escH(v.lastError)}</div>` : ''}${odooNote ? `<div>${escH(odooNote)}</div>` : ''}
        ${v?.created && Object.keys(v.created).length ? `<div>Odoo에 생성: ${Object.entries(v.created).map(([k, c]) => `${k} ${n(c)}`).join(' · ')}</div>` : ''}</div>
      <div class="cmp-note">• 필요한 Odoo 앱: 구매 · 재고 · 설비보전 (Community 무료판에 포함, Odoo 16~18). API 키: Odoo 사용자 설정 → 계정 보안 → API 키. 키는 서버 메모리(또는 .env의 ODOO_API_KEY)에만 두고 화면으로 돌려보내지 않습니다.<br>
      • 처음 보낼 때 마스터 데이터(제품 4종 · 로케이션 · 공급사/고객사 · 재주문 규칙 · 설비 ${S.equipment}대 · 기초 재고)를 만들고, 이후 구매오더 확정 → 입고 검증, 내부 이동·생산 입고·출고 검증, 정비요청 생성·단계 변경을 순서대로 적용합니다. 체크하는 순간까지 쌓인 이벤트부터 보냅니다.</div>`;
  } else body = `<table class="od-tbl"><tr><th>시각</th><th>내용</th></tr>${E.log.map((l) => `<tr><td>${fclk(l.t)}</td><td>${escH(l.text)}</td></tr>`).join('')}</table>`;
  odooBody.innerHTML = `<div class="od-grid">
      <div class="od-kpi"><span>구매오더</span><b>${n(S.po)}건</b><small>진행 중 ${S.poOpen} · ${won(S.amount)}</small></div>
      <div class="od-kpi"><span>재고 전표</span><b>${n(S.receipts + S.internals + S.productions + S.deliveries)}건</b><small>입고 ${S.receipts} · 내부 ${S.internals} · 생산 ${S.productions} · 출고 ${S.deliveries}</small></div>
      <div class="od-kpi"><span>물류 선반 재고</span><b>${n(Q.rackRaw.raw)} · ${n(Q.rackParts.parts)}</b><small>RM-BOX · PT-KIT (확정 기준)</small></div>
      <div class="od-kpi"><span>정비요청</span><b>${n(S.mr)}건</b><small>긴급 ${S.corrective} · 예방 ${S.preventive} · 진행 ${S.mrOpen}</small></div></div>
    <div class="od-tabs">${Object.entries(tabs).map(([k, v]) => `<button data-odtab="${k}" class="${odooTab === k ? 'on' : ''}">${v}</button>`).join('')}</div>${body}
    <div class="cmp-note">${E.live ? '🔗 실시간 Odoo에도 보내는 중' : '시뮬레이션 Odoo (내장) — 같은 모델(purchase.order · stock.picking · stock.quant · maintenance.request)·전표 번호로 기록'} · 내부 이동·생산 입고는 10분(공장 시계)마다 한 전표</div>`;
}
document.getElementById('btnOdoo').addEventListener('click', () => {
  odooModal.classList.remove('hidden'); odooStatus().then(renderOdoo); renderOdoo();
  clearInterval(odooTimer); odooTimer = setInterval(() => { if (!odooModal.classList.contains('hidden') && !odooBody.contains(document.activeElement)) odooStatus().then(renderOdoo); }, 1500);
});
document.getElementById('closeOdoo').addEventListener('click', () => { odooModal.classList.add('hidden'); clearInterval(odooTimer); });
odooBody.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-odtab]'); if (t) { odooTab = t.dataset.odtab; return renderOdoo(); }
  if (e.target.closest('[data-od="config"]')) {
    const body = { url: document.getElementById('odUrl').value, db: document.getElementById('odDb').value, user: document.getElementById('odUser').value, key: document.getElementById('odKey').value };
    try { odooSrv = await (await fetch('/api/odoo/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); odooNote = '설정을 서버에 저장했습니다 (API 키는 서버 메모리에만)'; } catch (err) { odooNote = `설정 실패: ${err.message}`; }
    renderOdoo();
  }
});
odooBody.addEventListener('change', (e) => { if (e.target.id === 'odLive') { sim.erp.live = e.target.checked; odooNote = e.target.checked ? '실시간 전송 시작' : '실시간 전송 중지 (이벤트는 쌓아 둠)'; e.target.blur(); renderOdoo(); } });
// 실시간 전송: 2초마다 쌓인 이벤트를 서버 게이트웨이로 (실패하면 그대로 두고 다음에 다시)
async function odooSyncTick(rdt) {
  const E = sim.erp; if (!E?.live || hub.noServer || odooBusy) return;
  odooSyncT += rdt; if (odooSyncT < 2 || (E.masterSent && !E.outbox.length)) return; odooSyncT = 0; odooBusy = true;
  const withMaster = !E.masterSent, batch = [...(withMaster ? [E.master] : []), ...E.outbox.slice(0, 300)];
  try {
    const r = await fetch('/api/odoo/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) });
    const out = await r.json(); odooSrv = out.status ?? odooSrv;
    if (r.ok) { E.outbox.splice(0, batch.length - (withMaster ? 1 : 0)); E.masterSent = true; E.sent += batch.length; odooNote = `${out.applied}건 적용`; } else odooNote = `전송 실패: ${out.error}`;
  } catch (err) { odooNote = `전송 실패: ${err.message}`; }
  finally { odooBusy = false; }
}

// ── 패킷 덤프: 캡처 상태·통계·버튼 (데이터 연동 창) ─────────────────
let pcapNote = '';
function pcapHtml() {
  const P = hub.pcap, S = P.stats, H = P.hosts(), n = (v) => v.toLocaleString('ko-KR');
  const state = P.full ? '<b class="bad">용량 한도(200MB) 도달 — 자동 중지</b>' : P.on ? `<b class="ok">⏺ 캡처 중</b> · ${P.duration.toFixed(0)}초 (공장 시계)` : S.packets ? '중지됨' : '대기';
  return `<div class="grid2">
    <span>상태</span><b>${state}</b>
    <span>캡처 지점</span><b>MQTT 브로커 NIC <code>10.20.0.10:1883</code> — 양방향(클라이언트 → 브로커 · 브로커 → 구독자), Ethernet · IPv4 · TCP · MQTT 3.1.1</b>
    <span>패킷</span><b>${n(S.packets)}개 (→ 브로커 ${n(S.up)} · 브로커 → ${n(S.down)}) · ${kb(P.bytes)}</b>
    <span>MQTT</span><b>PUBLISH 발행 ${n(S.publishUp)} · 구독자 전달 ${n(S.publishDown)} · PUBACK ${n(S.puback)} · CONNECT ${n(S.connect)} · SUBSCRIBE ${n(S.subscribe)} · PING ${n(S.ping)}</b>
    <span>영상</span><b>${P.video === false ? '끔' : `프레임 ${n(S.video)}개`} — CCTV·로봇 카메라 JPEG를 OPC UA ua-data ByteString(base64)으로 1초마다 (<code>…/Video_&lt;카메라&gt;</code>)</b>
    <span>호스트</span><b>FACOS 10.20.0.20 · 설비·셀 LAN 10.20.1.x ${H.lan} · 5G 이동 로봇 10.45.x.x ${H['5g']} · CCTV 10.20.2.x ${H.cam}</b></div>
    <div class="dh-save">
      ${P.on ? '<button data-pcap="stop"><b>⏹ 캡처 중지</b><small>지금까지 기록 유지</small></button>' : '<button data-pcap="start"><b>⏺ 캡처 시작</b><small>새로 기록 (이전 기록 지움)</small></button>'}
      <button data-pcap="save"><b>💾 .pcap 저장</b><small>Wireshark · tcpdump로 열기</small></button>
      <label class="chk"><input type="checkbox" id="pcapVideo" ${P.video === false ? '' : 'checked'} ${P.on ? 'disabled' : ''}/> 영상 포함 (CCTV·로봇 카메라)</label></div>
    <div class="dh-note">${escH(pcapNote)}</div>
    <div class="cmp-note">• Wireshark 필터 예: <code>mqtt</code> · <code>mqtt.msgtype == 3</code>(PUBLISH) · <code>mqtt.topic contains "Commands"</code>(상위 명령) · <code>ip.src == 10.45.0.0/16</code>(5G 로봇 업링크) · <code>mqtt.topic contains "Video_"</code>(영상). PUBLISH 페이로드는 OPC UA PubSub JSON — 우클릭 → Follow → TCP Stream으로 볼 수 있습니다.<br>
    • 캡처는 발행할 때만 기록합니다(📡 발행 체크). 5G 로봇 패킷은 무선 지연(약 8ms, 핸드오버 중이면 버퍼 대기만큼 더)이 반영된 시각입니다. 헤드리스 시험: <code>npm test</code>(tests/pcap.mjs) — 체크섬·TCP 순서번호·MQTT 짝 검증.</div>`;
}
// 영상 프레임: 캡처 중이면 1초마다 CCTV 한 대 + 로봇 카메라 한 대를 JPEG로 찍어 OPC UA 메시지로 발행
hub.pcap = new PacketCapture();
let pcapVidT = 0, pcapCam = 0, pcapBot = 0, pcapSeq = 0;
const pcapCv = document.createElement('canvas'); pcapCv.width = 320; pcapCv.height = 180;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
function pcapPublishFrame(key, kind, cam, w, h, bytes, simT, extra = {}, ip = null) {
  const t = hub.iso(simT), name = `Video_${cam.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const msg = { MessageId: crypto.randomUUID?.() ?? `${Date.now()}`, MessageType: 'ua-data', PublisherId: PUBLISHER_ID, WriterGroupName: WRITER_GROUP,
    Messages: [{ DataSetWriterId: 0, DataSetWriterName: name, SequenceNumber: ++pcapSeq, Timestamp: t, MessageType: 'ua-keyframe',
      Payload: { CameraId: { Value: cam, SourceTimestamp: t }, Encoding: { Value: 'image/jpeg', SourceTimestamp: t }, Width: { Value: w, SourceTimestamp: t }, Height: { Value: h, SourceTimestamp: t },
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { Value: v, SourceTimestamp: t }])), Image: { Type: 'ByteString', Value: b64(bytes), SourceTimestamp: t } } }] };
  hub.pcap.publish({ key, kind, ip, topic: hub.topic('data', name), payload: JSON.stringify(msg), tMs: hub.epochMs + simT * 1000, subs: kind === 'cam' ? [] : [hub.topic('data', 'Commands')], video: true });
}
function pcapVideoTick(rdt) {
  // 개별 캡처: 그 자산의 카메라(이동 로봇 · 셀 로봇 손목/머리 카메라)를 1초마다 JPEG로 그 자산이 발행
  if (!glLost) for (const [key, AP] of hub.assetPcaps) {
    if (!AP.on || AP.video === false || !AP.cam) continue;
    AP.camT += rdt; if (AP.camT < 1) continue; AP.camT = 0;
    const simT = sim.time, pr = camWall.captureFrame(AP.cam, 160, 120), kind = AP.only.kind;
    pr?.then((bytes) => { if (!bytes || !AP.on) return; const n0 = hub.pcap; hub.pcap = AP; try { pcapPublishFrame(key, kind, `Robot_${key}`, 160, 120, bytes, simT, {}, AP.only.ip); } finally { hub.pcap = n0; } });
  }
  const P = hub.pcap; if (!P.on || P.video === false || glLost) return;
  pcapVidT += rdt; if (pcapVidT < 1) return; pcapVidT = 0;
  const simT = sim.time, cams = sim.cctv?.cams ?? [];
  if (cams.length && !cctvView.lost) {
    const c = cams[pcapCam++ % cams.length], r = cctvView.renderPanel(c.id, pcapCv);
    if (r) pcapCv.toBlob((bl) => bl?.arrayBuffer().then((ab) => pcapPublishFrame(`CCTV-${c.id}`, 'cam', `CCTV_${c.id}`, 320, 180, new Uint8Array(ab), simT, { Place: r.place, Detections: r.dets.length })), 'image/jpeg', 0.7);
  }
  if (camWall.on && camWall.list?.length) {
    const f = camWall.list[pcapBot++ % camWall.list.length], pr = camWall.captureFrame(f.ref, 160, 120);
    const a = f.ref.type === 'mover' ? hub.assets.find((x) => x.mover?.id === f.ref.id) : null, ue = a ? sim.net?.ueOf(a.mover) : null;
    const ca = a ?? hub.assets.filter((x) => x.kind === 'CellRobot' && x.parent === f.ref.stationId)[f.ref.idx ?? 0];
    pr?.then((bytes) => bytes && pcapPublishFrame(ca ? ca.id : f.ref.stationId ?? 'Cell', ue ? '5g' : 'lan', `Robot_${ca ? ca.id : `${f.ref.stationId}_${f.ref.idx ?? 0}`}`, 160, 120, bytes, simT, {}, ca ? hub.ipOf(ca) : null));
  }
}
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
      <section class="span2"><h4>📦 패킷 덤프 (pcap · Wireshark)</h4>${pcapHtml()}</section>
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
  const pb = e.target.closest('button[data-pcap]');
  if (pb) {
    const P = hub.pcap, a = pb.dataset.pcap;
    if (a === 'start') { P.start(hub.epochMs + sim.time * 1000, { video: document.getElementById('pcapVideo')?.checked !== false }); pcapNote = '캡처 시작 — 이후 발행되는 메시지가 패킷으로 기록됩니다'; }
    else if (a === 'stop') { P.stop(); pcapNote = '캡처 중지 — .pcap으로 저장할 수 있습니다'; }
    else if (a === 'save') {
      if (hub.shared) pcapNote = '공유 페이지에서는 브라우저 보안 정책으로 파일 내려받기가 막혀 있습니다. 맥 앱이나 npm start로 실행한 화면에서 저장하세요.';
      else if (!P.stats.packets) pcapNote = '아직 캡처한 패킷이 없습니다. 캡처를 시작하고 시뮬레이션을 잠시 돌린 뒤 저장하세요.';
      else {
        const blob = new Blob([P.build()], { type: 'application/vnd.tcpdump.pcap' }), name = `${hub.fileBase()}_mqtt.pcap`, l = document.createElement('a');
        l.href = URL.createObjectURL(blob); l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(l.href), 5000);
        pcapNote = `저장: ${name} (${kb(blob.size)}) — Wireshark에서 열면 MQTT로 디코딩됩니다`;
      }
    }
    return renderData();
  }
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
  // CCTV 전광판 칸을 누르면 그 CCTV 영상 창
  if (cctvView.group.visible) { const b = ray.intersectObject(cctvView.screen, false)[0]; if (b?.uv) { const id = cctvView.boardCamAt(b.uv); if (id) { closePopups('cctvPanel'); openCctv(id); return; } } }
  // 로봇 비전 관제 화면의 영상 칸을 누르면 그 로봇을 선택한다
  if (camWall.group.visible) {
    const w = ray.intersectObject(camWall.screen, false)[0];
    if (w?.uv && camWall.list?.length) {
      const col = Math.min(CAM_COLS - 1, Math.floor(w.uv.x * CAM_COLS)), row = w.uv.y > 0.5 ? 0 : 1;
      const f = camWall.list[row * CAM_COLS + col];
      if (f) { closePopups('detail'); view.selected = f.ref.type === 'cell' ? f.ref.stationId : null; view.selectRobot(f.ref); ui.showRobot(); robotTimer = 1; return; }
    }
  }
  // 로봇(셀 로봇·AMR·AGV·휴머노이드·사족보행)을 누르면 관절·센서 텔레메트리, 설비를 누르면 설비 상세
  const hit = view.pick(ray.intersectObjects(view.pickTargets(), true));
  if (hit?.type === 'cctv') { closePopups('cctvPanel'); openCctv(hit.id); return; }
  if (hit?.type === 'gnb') { closePopups('gnbPanel'); openGnb(hit.id); return; }
  closePopups('detail');   // 로봇·설비를 누르거나 빈 곳을 누르면 CCTV·기지국 창은 닫는다
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
// 팝업 창(로봇·설비 정보, CCTV 영상, 5G 기지국 정보) — 창 바깥을 누르면 닫는다
// 3D 화면은 누름과 뗌 위치가 같을 때만(드래그 회전·이동은 닫지 않음) 위 pointerup에서 처리하고, 그 밖의 화면(패널·버튼 등)은 누르는 순간 닫는다
function closePopups(keep = null) {
  if (keep !== 'detail' && !document.getElementById('detail').classList.contains('hidden')) { view.selected = null; view.selectRobot(null); ui.hideDetail(); }
  if (keep !== 'cctvPanel' && !cctvPanel.hidden) { cctvPanel.hidden = true; cctvSel = null; }
  if (keep !== 'gnbPanel' && !gnbPanel.hidden) { gnbPanel.hidden = true; gnbSel = null; view.selectGnb(null); }
}
document.addEventListener('pointerdown', (e) => {
  const t = e.target; if (!(t instanceof Element)) return;
  if (t === labelRenderer.domElement || labelRenderer.domElement.contains(t) || t === renderer.domElement) return;   // 3D 화면은 pointerup에서
  const inside = ['detail', 'cctvPanel', 'gnbPanel'].find((id) => document.getElementById(id)?.contains(t));
  closePopups(inside ?? null);
}, true);
// ── 개별 패킷 캡처 (로봇·설비 정보 창) ─────────────────
// 대상: 이동 로봇(5G) · 셀 로봇(LAN) · 설비·셀(LAN) — DataHub 자산 하나의 MQTT 연결만 따로 기록해 그 자산 이름의 .pcap으로 저장
let assetPcapNote = { key: null, text: '' }, assetPcapVideo = true;
document.addEventListener('change', (e) => { if (e.target.id === 'pcapAssetVideo') assetPcapVideo = e.target.checked; });
function pcapAsset() {
  const tel = view.telemetry, ref = tel?.ref;
  if (ref?.type === 'mover') { const a = hub.assets.find((x) => x.mover?.id === ref.id); return a ? { a, cam: ref } : null; }
  if (ref?.type === 'cell') { const a = hub.assets.filter((x) => x.kind === 'CellRobot' && x.parent === ref.stationId)[ref.idx ?? 0]; return a ? { a, cam: ref } : null; }
  const st = ui.detailSt; if (st && !ui.robotMode) { const a = hub.assets.find((x) => x.id === st.id); return a ? { a, cam: st.def?.robot?.count ? { type: 'cell', stationId: st.id, idx: 0 } : null } : null; }
  return null;
}
function renderPcapBox() {
  const box = document.getElementById('pcapBox'); if (!box) return;
  const T = pcapAsset();
  if (!T) { box.innerHTML = '<div class="pnote">이 대상은 데이터 연동 자산이 아니라 개별 패킷 캡처를 할 수 없습니다 (유인 장비·사람 등).</div>'; return; }
  const t = hub.assetTarget(T.a), P = hub.assetPcaps.get(t.key), S = P?.stats, n = (v) => v.toLocaleString('ko-KR');
  const ip = P?.clients.get(t.key)?.ip?.join('.') ?? (t.kind === '5g' ? '10.45.x.x (5G 단말)' : '10.20.1.x (유선 LAN)');
  const state = !P ? '대기' : P.full ? '<span class="rec">용량 한도 — 자동 중지</span>' : P.on ? `<span class="rec">⏺ 캡처 중</span> ${P.duration.toFixed(0)}초` : `중지됨 · ${P.duration.toFixed(0)}초`;
  box.innerHTML = `<div class="ph">📦 패킷 캡처 (이 자산만) · ${state}</div>
    <div>클라이언트 <b>${escH(t.key)}</b> · ${escH(ip)} ↔ 브로커 10.20.0.10:1883 · MQTT 3.1.1 (AAS → OPC UA PubSub JSON)</div>
    ${S ? `<div>패킷 ${n(S.packets)} (→ 브로커 ${n(S.up)} · 브로커 → ${n(S.down)}) · 발행 PUBLISH ${n(S.publishUp)} · 받은 명령 ${n(S.publishDown)} · PUBACK ${n(S.puback)} · 영상 ${n(S.video)}프레임 · PING ${n(S.ping)} · ${kb(P.bytes)}</div>` : ''}
    <div class="prow">${P?.on ? '<button type="button" data-act="pcapStop">⏹ 캡처 중지</button>' : '<button type="button" data-act="pcapStart">⏺ 캡처 시작</button>'}
      <button type="button" data-act="pcapSave">💾 pcap 저장</button>
      <label class="chk"><input type="checkbox" id="pcapAssetVideo" ${(P?.on ? P.video !== false : assetPcapVideo) ? 'checked' : ''} ${P?.on ? 'disabled' : ''}/> 카메라 영상 포함</label></div>
    ${assetPcapNote.key === t.key && assetPcapNote.text ? `<div class="pnote">${escH(assetPcapNote.text)}</div>` : ''}
    <div class="pnote">창을 닫아도 캡처는 계속됩니다(다시 열면 이어서 보임). 전체 캡처는 📡 데이터 연동 → 패킷 덤프.</div>`;
}
ui.onDetailRendered = renderPcapBox;
function pcapAssetAction(act) {
  const T = pcapAsset(); if (!T) return;
  const t = hub.assetTarget(T.a);
  let P = hub.assetPcaps.get(t.key);
  if (act === 'pcapStart') {
    P = new PacketCapture(); hub.assetPcaps.set(t.key, P);
    P.start(hub.epochMs + sim.time * 1000, { video: assetPcapVideo, only: t }); P.cam = T.cam; P.camT = 0;
    assetPcapNote = { key: t.key, text: '캡처 시작 — 이 자산이 보내고 받는 MQTT 패킷만 기록합니다' };
  } else if (act === 'pcapStop') { P?.stop(); assetPcapNote = { key: t.key, text: '캡처 중지 — pcap으로 저장할 수 있습니다' }; }
  else if (act === 'pcapSave') {
    if (hub.shared) assetPcapNote = { key: t.key, text: '공유 페이지에서는 브라우저 보안 정책으로 파일 내려받기가 막혀 있습니다. 맥 앱이나 npm start로 실행한 화면에서 저장하세요.' };
    else if (!P?.stats.packets) assetPcapNote = { key: t.key, text: '아직 캡처한 패킷이 없습니다. 캡처를 시작하고 시뮬레이션을 잠시 돌린 뒤 저장하세요.' };
    else {
      const blob = new Blob([P.build()], { type: 'application/vnd.tcpdump.pcap' }), name = `${hub.fileBase()}_${t.key}.pcap`, l = document.createElement('a');
      l.href = URL.createObjectURL(blob); l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(l.href), 5000);
      assetPcapNote = { key: t.key, text: `저장: ${name} (${kb(blob.size)}) — Wireshark에서 MQTT로 디코딩됩니다` };
    }
  }
  renderPcapBox();
}
ui.onDetailAction = (act, st) => {
  if (act === 'pcapStart' || act === 'pcapStop' || act === 'pcapSave') return pcapAssetAction(act);
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
  const cs = getComputedStyle(document.body), w = cur.width, rightGap = parseFloat(cs.getPropertyValue('--rx')) || 364, leftX = parseFloat(cs.getPropertyValue('--lx')) || 314;
  const rects = { left: { l: leftX, r: leftX + w, t: cur.top, b: cur.bottom }, right: { l: innerWidth - rightGap - w, r: innerWidth - rightGap, t: cur.top, b: cur.bottom } };
  const hit = (a) => !(a.r < rb.l || a.l > rb.r || a.b < rb.t || a.t > rb.b);
  const dist = (a) => Math.abs((a.l + a.r) / 2 - (rb.l + rb.r) / 2);
  const now = right ? 'right' : 'left', other = right ? 'left' : 'right';
  if (!hit(rects[now])) return;
  if (!hit(rects[other]) || dist(rects[other]) > dist(rects[now])) detailEl.classList.toggle('side-right', other === 'right');
}

// ── CCTV 커버리지 지도 (바닥 색 · 감시 반경 · 요약 카드) ─────────────────
const cctvBtn = document.getElementById('btnCctv'), cctvCard = document.getElementById('cctvCard');
function renderCctvCard() {
  const p = sim.cctv, S = p.stats, dark = modeKey === 'dark';
  cctvCard.innerHTML = `<b>📹 CCTV ${p.cams.length}대 · 사각지대 ${S.blind}곳 (${((1 - S.coverage) * 100).toFixed(1)}%)</b>
    <span>건물 안 천장 돔 ${S.inside}대 · 트럭 야드 실외 PTZ ${S.outside}대 · 바닥 ${S.points.toLocaleString('ko-KR')}개 지점(1m) 중 ${(S.coverage * 100).toFixed(1)}% 감시 · 2대 이상 이중 감시 ${(S.redundancy * 100).toFixed(0)}%</span>
    <span>${dark ? '피지컬AI: CCTV 에이전트가 영상 AI 분석으로 현장 이벤트 2초 안 감지 → 메인 오케스트레이터 보고 · 이력 관리' : 'CCTV 녹화·관제 (AI 영상 분석은 피지컬AI 단계)'} · 바닥 빨강 = 사각지대 · 연두 = 1대 · 초록 = 2대 이상</span>
    <span><button type="button" id="cctvOpen">📺 CCTV 영상·이벤트 이력 열기</button> 카메라·전광판을 눌러도 열립니다</span>`;
  document.getElementById('cctvOpen').onclick = () => openCctv(sim.cctv.cams[0].id);
}
window.__cctvRefresh = () => { if (!cctvCard.hidden) renderCctvCard(); };
cctvBtn.addEventListener('click', () => { const on = !cctvBtn.classList.contains('on'); cctvBtn.classList.toggle('on', on); view.setCCTVMap(on); cctvCard.hidden = !on; if (on) renderCctvCard(); });

// ── Private 5G: 기지국 배치·커버리지·핸드오버·무손실 업링크 요약 카드 ─────────────────
const netBtn = document.getElementById('btnNet5g'), netCard = document.getElementById('net5gCard');
function renderNetCard() {
  const net = sim.net;
  if (!net?.on) { netCard.innerHTML = `<b>📶 Private 5G</b><span>레거시 공장은 5G 특화망이 없습니다 (자동화·피지컬AI 단계에서 운영)</span>`; return; }
  const P = net.plan, S = P.stats, Q = net.summary(), n = (v) => Math.round(v).toLocaleString('ko-KR');
  const kinds = {}; for (const u of net.ues) kinds[u.kindLabel] = (kinds[u.kindLabel] ?? 0) + 1;
  netCard.innerHTML = `<b>📶 Private 5G 특화망 · 기지국 ${P.cells.length}대 · 음영지역 ${S.holes}곳</b>
    <span>${NR.band} ${NR.fc}GHz · ${NR.bwMHz}MHz · 천장 소형 셀 ${NR.txDbm}dBm — 건물 안 ${n(S.points)}개 지점(2m) 최저 RSRP <b class="ok">${S.minRsrp.toFixed(1)}dBm</b> (설계 ${NR.design} · 최소 ${NR.require}) · 평균 ${S.avgRsrp.toFixed(1)} · SINR ≥ 0dB ${(S.sinrOk * 100).toFixed(0)}% · 핸드오버 겹침 영역 ${(S.hoZone * 100).toFixed(0)}%</span>
    <span class="pci">PCI ${P.cells.map((c) => `${c.id.slice(4)}:${c.pci}`).join(' · ')} — 셀마다 고유 · 이웃 셀 PSS(PCI mod 3) 최적 배정 (같은 mod 3 경계 ${((S.mod3.conflictBorder / S.mod3.border) * 100).toFixed(1)}%, 모서리 접촉만)</span>
    <span>5G 모뎀 ${Q.ues}대 (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' · ')}) — 핸드오버 <b>${n(Q.ho)}</b>회 · 성공 <b class="ok">${(Q.hoOk * 100).toFixed(1)}%</b> · 평균 중단 ${Q.avgHoMs.toFixed(0)}ms · 핑퐁 ${Q.pingpong} · 무선 링크 실패 ${Q.rlf}</span>
    <span>업링크 MQTT ${n(Q.sent)}건 (${(Q.bytes / 1e6).toFixed(1)}MB) → 브로커 도착 ${n(Q.delivered)}건 · 전송 중 ${Q.inflight} · <b class="ok">유실 ${Q.lost}건</b> · 핸드오버 버퍼 포워딩 ${n(Q.fwd)}건</span>
    <span>${STACK}</span>
    <div class="ho">${net.log.slice(0, 8).map((h) => `${[3600, 60, 1].map((d, i) => String(Math.floor((Math.floor(h.t) + 8 * 3600) / d) % (i ? 60 : 24)).padStart(2, '0')).join(':')} ${h.ue} PCI ${h.from} → ${h.to} (${h.rsrpFrom} → ${h.rsrpTo}dBm) · 중단 ${h.ms}ms · 포워딩 ${h.fwd}건 ${h.ok ? '✓' : '✗'}`).join('<br>') || '핸드오버 기록 없음'}</div>`;
}
// 5G 기지국을 누르면: PCI·무선 사양·서비스 영역·이웃 셀·접속 단말·업링크·핸드오버 (1초마다 갱신)
const gnbPanel = document.getElementById('gnbPanel');
let gnbSel = null, gnbT = 0, gnbPrev = null;
function openGnb(id) { gnbSel = id; gnbPanel.hidden = false; gnbPrev = null; view.selectGnb(id); renderGnb(); }
document.getElementById('gnbClose').onclick = () => { gnbPanel.hidden = true; gnbSel = null; view.selectGnb(null); };
function renderGnb() {
  const net = sim.net, idx = net?.plan?.cells.findIndex((c) => c.id === gnbSel) ?? -1;
  if (!net?.on || idx < 0) { gnbPanel.hidden = true; gnbSel = null; view.selectGnb(null); return; }
  const I = net.cellInfo(idx), c = I.c, S = I.S, n = (v) => Math.round(v).toLocaleString('ko-KR'), t = sim.time;
  const rate = gnbPrev && t > gnbPrev.t ? ((S.rxB - gnbPrev.b) * 8) / (t - gnbPrev.t) / 1000 : null; gnbPrev = { t, b: S.rxB };
  const clk = (tt) => [3600, 60, 1].map((d, i) => String(Math.floor((Math.floor(tt) + 8 * 3600) / d) % (i ? 60 : 24)).padStart(2, '0')).join(':');
  const kinds = {}; for (const u of I.ues) kinds[u.kindLabel] = (kinds[u.kindLabel] ?? 0) + 1;
  document.getElementById('gnbTitle').textContent = `📶 ${c.id} · PCI ${c.pci}`;
  document.getElementById('gnbSub').textContent = `5G NR 소형 셀 (gNB) · ${NR.band} · 상태 정상 · 접속 단말 ${I.ues.length}대`;
  const row = (k, v, cls = '') => `<span>${k}</span><b class="${cls}">${v}</b>`;
  document.getElementById('gnbBody').innerHTML = `
    <div class="gnb-sec"><h4>식별 · 무선 사양</h4><div class="gnb-grid">
      ${row('PCI (물리 셀 ID)', `${c.pci} = 3 × SSS ${c.sss} + PSS ${c.pci % 3}`)}
      ${row('대역 · 대역폭', `${NR.band} ${NR.fc}GHz (이음5G 특화망) · ${NR.bwMHz}MHz · SCS ${NR.scs}kHz (273 RB)`)}
      ${row('송신 출력 · 안테나', `${NR.txDbm}dBm · ${NR.gainDbi}dBi (천장 무지향)`)}
      ${row('설치 위치', `x ${c.x} · z ${c.z} m · 높이 ${c.y}m (천장 브래킷)`)}
      ${row('핸드오버 설정', `A3 오프셋 ${NR.a3}dB · TTT ${NR.ttt * 1000}ms · Xn 핸드오버 · PDCP 버퍼 포워딩`)}
    </div></div>
    <div class="gnb-sec"><h4>서비스 영역 (이 셀이 최강인 영역)</h4><div class="gnb-grid">
      ${row('면적', `약 ${n(I.area)}m² (2m 격자 ${n(I.area / 4)}지점) · 설계 반경 ${NR.R}m`)}
      ${row('RSRP 평균 / 최저', `${I.avgRsrp.toFixed(1)} / ${I.minRsrp.toFixed(1)} dBm (설계 ${NR.design})`, I.minRsrp >= NR.design ? 'ok' : 'warn')}
      ${row('SINR 평균', `${I.avgSinr.toFixed(1)} dB (인접 셀 ${NR.load * 100}% 부하 간섭)`)}
    </div></div>
    <div class="gnb-sec"><h4>이웃 셀 ${I.neighbors.length}개</h4><table><tr><th>셀</th><th>PCI</th><th>맞닿은 경계</th><th>PCI mod 3</th><th>핸드오버 →</th></tr>
      ${I.neighbors.sort((a, b) => b.border - a.border).map((x) => `<tr><td>${x.c.id}</td><td>${x.c.pci}</td><td>${x.border}m</td><td class="${x.conflict ? 'warn' : 'ok'}">${x.conflict ? '같음 (모서리)' : '다름'}</td><td>${x.hoTo}회</td></tr>`).join('')}</table></div>
    <div class="gnb-sec"><h4>접속 단말 ${I.ues.length}대 ${Object.entries(kinds).map(([k, v]) => `· ${k} ${v}`).join(' ')}</h4><table><tr><th>로봇</th><th>종류</th><th>RSRP</th><th>SINR</th><th>상태</th></tr>
      ${I.ues.map((u) => `<tr><td>${u.uid ?? u.id}</td><td>${u.kindLabel}</td><td>${u.rsrp.toFixed(1)}</td><td>${u.sinr.toFixed(1)}</td><td>${u.hoUntil >= 0 ? '<span class="warn">핸드오버 진입 중</span>' : '연결'}</td></tr>`).join('') || '<tr><td colspan="5">접속한 단말 없음</td></tr>'}</table></div>
    <div class="gnb-sec"><h4>업링크 · 핸드오버</h4><div class="gnb-grid">
      ${row('업링크 수신 (MQTT)', `${n(S.rx)}건 · ${(S.rxB / 1e6).toFixed(1)}MB${rate != null ? ` · 현재 ${rate.toFixed(0)} kbps` : ''}`)}
      ${row('핸드오버 들어옴 / 나감', `${n(S.hoIn)} / ${n(S.hoOut)}회 · 나가는 핸드오버 실패 ${S.hoFail}회`, S.hoFail ? 'warn' : 'ok')}
      ${row('접속 단말 업링크', `송신 ${n(I.ues.reduce((a, u) => a + u.sent, 0))} · 도착 ${n(I.ues.reduce((a, u) => a + u.delivered, 0))} · 버퍼 ${I.ues.reduce((a, u) => a + u.buf, 0)} · 유실 ${I.ues.reduce((a, u) => a + u.sent - u.delivered - u.buf, 0)}건`, I.ues.some((u) => u.sent - u.delivered - u.buf) ? 'warn' : 'ok')}
    </div>
    <div style="margin-top:4px">${I.log.map((h) => `${clk(h.t)} ${h.ue} PCI ${h.from} → ${h.to} · ${h.rsrpFrom} → ${h.rsrpTo}dBm · 중단 ${h.ms}ms · 포워딩 ${h.fwd}건`).join('<br>') || '최근 핸드오버 없음'}</div></div>`;
}
let netT = 0, pcapBoxT = 0;
window.__netRefresh = () => { if (!netCard.hidden) renderNetCard(); };
netBtn.addEventListener('click', () => { const on = !netBtn.classList.contains('on'); netBtn.classList.toggle('on', on); view.setNetMap(on); netCard.hidden = !on; if (on) { cctvBtn.classList.remove('on'); view.setCCTVMap(false); cctvCard.hidden = true; renderNetCard(); } });
cctvBtn.addEventListener('click', () => { if (cctvBtn.classList.contains('on') && netBtn.classList.contains('on')) { netBtn.classList.remove('on'); view.setNetMap(false); netCard.hidden = true; } });

// ── CCTV 영상 창: 실시간 영상 + AI 검출 + CCTV 에이전트 이벤트 이력 ─────────────────
const cctvPanel = document.getElementById('cctvPanel'), cctvCv = document.getElementById('cctvCanvas');
let cctvSel = null, cctvT = 0, cctvOnlyThis = false;
function openCctv(id) { cctvSel = id; cctvPanel.hidden = false; cctvT = 1; renderCctvPanel(true); }
document.getElementById('cctvClose').addEventListener('click', () => { cctvPanel.hidden = true; cctvSel = null; });
cctvPanel.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cctv]'); if (!b) return;
  const a = b.dataset.cctv, cams = sim.cctv.cams, i = cams.findIndex((c) => c.id === cctvSel);
  if (a === 'prev' || a === 'next') { cctvSel = cams[(i + (a === 'next' ? 1 : cams.length - 1)) % cams.length].id; renderCctvPanel(true); }
  else if (a === 'left' || a === 'right') cctvView.pan(cctvSel, a === 'left' ? 0.6 : -0.6);
  else if (a === 'only') { cctvOnlyThis = !cctvOnlyThis; renderCctvPanel(true); }
  else if (a === 'go') { openCctv(b.dataset.cam); }
  else if (a === 'csv') {
    const rows = [['번호', '시각', '구분', '카메라', '위치', '클래스', '모델', '신뢰도', '인시던트', '상태', '처리 시간(초)', '결과', '비고']];
    for (const r of sim.cctvAgent?.history ?? []) rows.push([r.no, hub.iso(r.t), { report: '감지·보고', verify: '교차 확인', record: '영상 확보' }[r.kind], r.cam, cctvView.place(sim.cctv.cams.find((c) => c.id === r.cam) ?? {}), r.cls, AI_MODELS[r.model]?.name ?? '', r.conf ?? '', r.inc ? `#${r.inc.id} ${r.inc.title}` : '', r.status === 'open' ? '진행 중' : '종료', r.dur != null ? r.dur.toFixed(1) : '', r.result ?? '', r.note ?? '']);
    const csv = '\ufeff' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a2 = document.createElement('a'); a2.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a2.download = `CCTV_이벤트이력_${epRec.runId}.csv`; a2.click(); setTimeout(() => URL.revokeObjectURL(a2.href), 4000);
  }
});
function renderCctvPanel(force) {
  if (!cctvSel || cctvPanel.hidden) return;
  const res = cctvView.renderPanel(cctvSel, cctvCv); if (!res) return;
  const c = res.cam, ag = sim.cctvAgent, dark = modeKey === 'dark';
  document.getElementById('cctvTitle').textContent = `📹 ${c.id} · ${res.place}`;
  document.getElementById('cctvSub').textContent = `${c.region === 'inside' ? '천장 돔 카메라 (어안 360° · 디워핑 뷰)' : '실외 PTZ 돔 카메라'} · 설치 높이 ${c.y}m · 감시 반경 ${c.R}m · 위치 x ${c.x.toFixed(1)}, z ${c.z.toFixed(1)}`;
  const cnt = {}; for (const d of res.dets) cnt[d.cls] = (cnt[d.cls] ?? 0) + 1;
  document.getElementById('cctvDet').innerHTML = dark
    ? `<div class="cc-models">${Object.entries(AI_MODELS).map(([k, m]) => `<span class="cc-m${res.dets.some((d) => d.model === k) ? ' on' : ''}" style="--c:${m.color}" title="${escV(m.desc)}">${escV(m.name)}</span>`).join('')}</div>
       <div class="cc-cnt">${Object.entries(cnt).map(([k, n]) => `<b style="color:${CCTV_CLASSES[k]?.color}">${CCTV_CLASSES[k]?.ko ?? k} ${n}</b>`).join(' · ') || '검출 없음'} <small>(트랙 ID·신뢰도는 영상 상자에)</small></div>`
    : '<div class="cc-cnt">녹화·관제 — AI 영상 분석(객체 검출·추적·이상 분할·연기 검출·침입 규칙)과 CCTV 에이전트는 피지컬AI 단계</div>';
  if (!force && cctvPanel.querySelector('.cc-hist:hover')) return;   // 이력을 보는 동안은 표를 고정
  const st = ag?.stats(), hist = (ag?.history ?? []).filter((r) => !cctvOnlyThis || r.cam === c.id || r.cams?.includes(c.id)).slice(0, 40);
  document.getElementById('cctvHist').innerHTML = !ag?.on ? '<p class="vla-note">CCTV 에이전트는 피지컬AI 단계에서 동작합니다.</p>' : `
    <div class="cc-hh"><b>CCTV 에이전트 이벤트 이력</b><small>전체 ${st.total}건 · 감지·보고 ${st.reports} · 교차 확인 ${st.verify} · 영상 확보 ${st.records} · 진행 중 ${st.open} — 대응·관리는 메인 오케스트레이터</small>
      <button type="button" data-cctv="only" class="${cctvOnlyThis ? 'on' : ''}">이 카메라만</button><button type="button" data-cctv="csv" ${window.JIN3D_SHARED ? 'disabled' : ''}>⬇ CSV</button></div>
    <div class="cc-hist"><table class="vla-t"><thead><tr><th>번호</th><th>시각</th><th>구분</th><th>카메라</th><th>클래스 · 모델</th><th>신뢰도</th><th>오케스트레이터 인시던트</th><th>상태 · 처리</th></tr></thead><tbody>
    ${hist.map((r) => `<tr><td>${r.no}</td><td>${fclock(r.t)}</td><td class="${r.kind === 'report' ? 'p-rejected' : ''}">${{ report: '감지·보고', verify: '교차 확인', record: '영상 확보' }[r.kind]}</td><td><button type="button" class="cc-cam" data-cctv="go" data-cam="${r.cam}">${r.cam}</button></td><td class="ins" title="${escV(r.note)}">${escV(r.cls)} · ${escV(AI_MODELS[r.model]?.name ?? '')}</td><td>${r.conf != null ? r.conf.toFixed(2) : '-'}</td><td class="ins" title="${escV(r.inc?.title ?? '')}">${r.inc ? `#${r.inc.id} ${escV(r.inc.title)}` : '-'}</td><td class="${r.status === 'open' ? 'p-train' : 'p-done'}" title="${escV(r.result ?? '')}">${r.status === 'open' ? '진행 중' : `종료 · ${fdur(r.dur)}`}</td></tr>`).join('') || '<tr><td colspan="8">아직 없음 — 하단 "⚠ 현장 이벤트"로 발생시킬 수 있습니다</td></tr>'}</tbody></table></div>`;
}

// ── 양쪽 패널 숨기기/보이기 (버튼 ◀ ▶, 단축키 [ ]) — 상태는 브라우저에 기억 ─────────────────
const sidePanels = { left: document.getElementById('tglLeft'), right: document.getElementById('tglRight') };
function setSide(side, hide) {
  document.body.classList.toggle(`hide-${side}`, hide);
  const b = sidePanels[side], name = side === 'left' ? '왼쪽 패널(정밀조립Zone)' : '오른쪽 패널(자율운영 에이전트)', key = side === 'left' ? '[' : ']';
  b.textContent = (side === 'left') === hide ? '▶' : '◀';
  b.title = `${name} ${hide ? '보이기' : '숨기기'} · 단축키 ${key}`;
  try { localStorage.setItem(`jin3d.hide.${side}`, hide ? '1' : '0'); } catch { /* 저장소 없음 */ }
}
for (const side of ['left', 'right']) {
  let h = false; try { h = localStorage.getItem(`jin3d.hide.${side}`) === '1'; } catch { /* 무시 */ }
  setSide(side, h);
  sidePanels[side].addEventListener('click', () => setSide(side, !document.body.classList.contains(`hide-${side}`)));
}
// 방향키: 화면 중앙 고정점(회전 중심)을 화면 방향 기준으로 바닥 위에서 이동 — ↑↓ 앞뒤, ←→ 좌우, Shift = 빠르게
const panKeys = new Set();
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === '[') setSide('left', !document.body.classList.contains('hide-left'));
  else if (e.key === ']') setSide('right', !document.body.classList.contains('hide-right'));
  else if (e.key.startsWith('Arrow')) { panKeys.add(e.key); e.preventDefault(); }
});
addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow')) panKeys.delete(e.key); });
addEventListener('blur', () => { panKeys.clear(); shiftHeld = false; });
const panF = new THREE.Vector3(), panR = new THREE.Vector3(), panD = new THREE.Vector3();
function keyPan(rdt, shift) {
  if (!panKeys.size) return;
  const cam = controls.object, tg = controls.target;
  panF.subVectors(tg, cam.position).setY(0);
  if (panF.lengthSq() < 1e-6) panF.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0);   // 위에서 똑바로 내려다볼 때
  panF.normalize(); panR.set(-panF.z, 0, panF.x);
  const f = (panKeys.has('ArrowUp') ? 1 : 0) - (panKeys.has('ArrowDown') ? 1 : 0), r = (panKeys.has('ArrowRight') ? 1 : 0) - (panKeys.has('ArrowLeft') ? 1 : 0);
  if (!f && !r) return;
  const sp = Math.max(6, cam.position.distanceTo(tg) * 0.35) * (shift ? 2.5 : 1) * rdt;   // 멀리서 볼수록 빠르게 (초당 시야 거리의 35%)
  panD.copy(panF).multiplyScalar(f).addScaledVector(panR, r).normalize().multiplyScalar(sp);
  // 공장·트럭 야드 밖으로 너무 멀리 가지 않게
  panD.x = Math.max(-100, Math.min(70, tg.x + panD.x)) - tg.x; panD.z = Math.max(-55, Math.min(35, tg.z + panD.z)) - tg.z;
  tg.add(panD); cam.position.add(panD);
}
let shiftHeld = false;
addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftHeld = true; });
addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftHeld = false; });

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

// ── GPU 컨텍스트 손실 복구 ─────────────────────────────
// 다른 화면·데스크톱으로 옮겼다 돌아오거나, 잠자기·외장 모니터 전환·GPU 프로세스 재시작이 있으면
// WebGL 컨텍스트가 사라져 3D 화면이 하얗게 비고 라벨만 남는다. 손실 동안은 GPU 작업을 멈추고
// (시뮬레이션은 계속), 브라우저가 컨텍스트를 돌려주면 이어 그리고, 1.5초 안에 안 돌려주면 렌더러를 새로 만든다.
const glNote = document.getElementById('glNote');
let glLost = false, glTimer = 0, glRebuilds = 0;
function watchContext(r) {
  r.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (r !== renderer) return;
    glLost = true; camWall.lost = true; cctvView.lost = true; glNote.hidden = false;
    console.warn('[Jin-3D] WebGL 컨텍스트 손실 — 복구 대기');
    clearTimeout(glTimer); glTimer = setTimeout(rebuildRenderer, 1500);
  });
  r.domElement.addEventListener('webglcontextrestored', () => {
    if (r !== renderer) return;
    clearTimeout(glTimer); glRecovered('복원');
  });
}
function glRecovered(how) {
  glLost = false; camWall.lost = false; cctvView.lost = false; glNote.hidden = true;
  composer.setSize(innerWidth, innerHeight);
  scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
  console.info(`[Jin-3D] WebGL 컨텍스트 ${how} 완료`);
}
function rebuildRenderer() {
  if (!glLost) return;
  let r;
  try { r = makeRenderer(); } catch (e) {   // GPU가 아직 준비 안 됨 — 잠시 뒤 다시
    console.warn('[Jin-3D] 렌더러 재생성 실패, 재시도', e.message);
    glTimer = setTimeout(rebuildRenderer, 2000); return;
  }
  const old = renderer;
  renderer = r; watchContext(r);
  old.domElement.replaceWith(r.domElement);
  try { old.dispose(); } catch { /* 이미 잃은 컨텍스트 */ }
  camWall.renderer = r; camWall.panelRT = camWall.capRT = null;
  renderer.toneMappingExposure = old.toneMappingExposure;
  makeComposer();
  glRebuilds++;
  glRecovered(`재생성(${glRebuilds}회)`);
}
watchContext(renderer);
// 창이 다시 보일 때 컨텍스트가 조용히 사라져 있는 경우도 잡는다
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !glLost && renderer.getContext().isContextLost()) {
    glLost = true; camWall.lost = true; cctvView.lost = true; glNote.hidden = false; rebuildRenderer();
  }
});

// ── 루프 ─────────────────────────────
const clock = new THREE.Clock();
let uiTimer = 0, screenTimer = 0, robotTimer = 0, camTimer = 0, vlaTimer = 0;
const clockEl = document.getElementById('clock');
function frame() {
  requestAnimationFrame(frame);   // 한 프레임에서 예외가 나도 루프는 계속
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
  pcapVideoTick(rdt);
  odooSyncTick(rdt);
  view.update(rdt, running, speed);
  keyPan(rdt, shiftHeld);
  netT += rdt; if (netT > 1 && !netCard.hidden) { netT = 0; renderNetCard(); }
  gnbT += rdt; if (gnbT > 1 && gnbSel) { gnbT = 0; renderGnb(); }
  controls.update();
  uiTimer += rdt; screenTimer += rdt;
  if (uiTimer > 0.25) { uiTimer = 0; ui.update(); view.updateLabels(); updateZoneCard(); orchView.tick(); gateView.tick(); updateAlarmButtons(); updateCmdUI(); clockEl.title = `기준 시계 (UTC) ${hub.iso()} · 모든 데이터·메시지가 이 시각을 씁니다`; }
  robotTimer += rdt;
  if (view.telemetry && robotTimer > 0.12) { robotTimer = 0; ui.renderRobot(view.telemetry.snapshot(), hub.robotCounts(view.telemetry)); }
  pcapBoxT += rdt; if (pcapBoxT > 0.5 && ui.robotMode && !document.getElementById('detail').classList.contains('hidden') && !document.getElementById('pcapBox')?.contains(document.activeElement)) { pcapBoxT = 0; renderPcapBox(); }
  // 피지컬AI: 로봇 정보 창에 그 로봇 카메라의 실시간 영상 (약 10fps)
  camTimer += rdt;
  if (view.telemetry && ui.robotMode && camTimer > 0.1) {
    camTimer = 0;
    const box = document.getElementById('rbCamBox'), cv = document.getElementById('rbCam');
    const shown = modeKey === 'dark' && box && cv && camWall.renderRobotView(view.telemetry.ref, cv, (() => { const t = Math.floor(sim.time) + 8 * 3600; return [t / 3600 % 24, t / 60 % 60, t % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); })());
    if (box) box.hidden = !shown;
  }
  if (view.telemetry && ui.robotMode) placeRobotPanel();
  if (screenTimer > 0.6 && modeKey !== 'traditional') { screenTimer = 0; view.drawScreen(sim.kpi(), agent.lastThought, { hub: hub.stats(), msgs: hub.msgs, bytes: hub.bytes }); }
  epRec.update();
  vlaTimer += rdt; if (vlaTimer > 0.5) { vlaTimer = 0; renderVla(); renderAios(); aiosUpload(); renderFacos(); renderFacosView(); }
  cctvT += rdt; if (cctvSel && cctvT > 0.12) { cctvT = 0; renderCctvPanel(); }
  if (!glLost) {
    try {
      camWall.update(rdt);
      cctvView.update(rdt);
      composer.render();
    } catch (e) { if (!frame.errAt || performance.now() - frame.errAt > 5000) { frame.errAt = performance.now(); console.error('[Jin-3D] 렌더 오류', e); } }
  }
  labelRenderer.render(scene, camera);
}

start('smart');
frame();

designer = new LineDesigner({
  llm,
  getLine: () => currentLine,
  getMode: () => modeKey,
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
// 에피소드 서버 저장이 가능한지 (맥 앱·npm start) — 정적 호스팅·공유 페이지는 브라우저 보관만
if (!window.JIN3D_SHARED && !window.JIN3D_NO_SERVER) fetch('/api/status').then((r) => r.json()).then((j) => { epRec.server = !!j.episodes; }).catch(() => {});

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
// ── VLA 데이터·학습 파이프라인 창 ─────────────────
const vlaModal = document.getElementById('vlaModal'), vlaBody = document.getElementById('vlaBody');
let vlaDir = null;
document.getElementById('btnVla').addEventListener('click', () => {
  vlaModal.classList.remove('hidden'); renderVla(true);
  if (epRec.server) fetch('/api/episodes').then((r) => r.json()).then((j) => { vlaDir = j; }).catch(() => {});
});
document.getElementById('closeVla').addEventListener('click', () => vlaModal.classList.add('hidden'));
vlaModal.addEventListener('click', async (e) => {
  if (e.target === vlaModal) return vlaModal.classList.add('hidden');
  if (e.target.closest('[data-train]')) { if (!sim.vla.startTraining(true)) sim.log('info', 'VLA 학습 요청 보류', { obs: sim.vla.job ? '이미 학습·배포 진행 중' : '새 에피소드가 5개 이상 필요' }); renderVla(true); return; }
  const b = e.target.closest('[data-dl]'); if (!b || b.disabled) return;
  const uid = b.dataset.dl, eps = epRec.list(uid), pick = b.dataset.one ? eps.slice(-1) : eps;
  if (!pick.length) return;
  b.disabled = true; const old = b.textContent; b.textContent = '묶는 중…';
  const zip = await buildEpisodesZip(uid, pick, epRec.runId);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  a.download = `${uid}_${b.dataset.one ? pick[0].id : `episodes_${pick.length}`}_${epRec.runId}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  b.textContent = old; b.disabled = false;
});
const escV = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function renderVla(force) {
  if (vlaModal.classList.contains('hidden') && !force) return;
  const P = sim.vla;
  if (!P?.on) { vlaBody.innerHTML = '<p class="vla-note">VLA 파이프라인은 피지컬AI 단계에서만 동작합니다.</p>'; return; }
  if (vlaBody.matches(':hover') && vlaBody.querySelector('button:hover')) return;   // 누르는 중에는 다시 그리지 않는다
  const robots = epRec.robots(), j = P.job, last = P.jobs[0], need = 200 * (P.backoff ?? 1);
  const okRate = P.allEps ? Math.round((P.okEps / P.allEps) * 100) : 0;
  const recNow = epRec.rec.size, frames = robots.reduce((a, R) => a + epRec.list(R.uid).reduce((b, e) => b + e.frames.length, 0), 0);
  const deployed = robots.filter((R) => P.versionOf(R.uid) === P.label(P.latest)).length;
  const act = j?.phase ?? 'idle', shared = !!window.JIN3D_SHARED;
  const stage = (ic, title, val, sub, on) => `<div class="vs ${on ? 'on' : ''}"><i>${ic}</i><b>${title}</b><span>${val}</span><small>${sub}</small></div>`;
  const kindKo = (k) => (k === 'ammr' ? 'AMMR' : k === 'humanoid' ? '휴머노이드' : k === 'cobot' ? '협동로봇' : '6축로봇');
  vlaBody.innerHTML = `
    <div class="vla-flow">
      ${stage('🤖', '1 로봇 수집', `기록 중 ${recNow}대 · 누적 ${epRec.total}개`, `VLA 로봇 ${robots.length}대 · 작업 사이클 ${SAMPLE}번에 1번`, recNow > 0)}<b class="va">›</b>
      ${stage('🧹', '2 AI-ready 정제', `${EP_HZ}Hz · 카메라 ${frames}장`, '관절·TCP·그리퍼·작업 단계 · 지시·성공 라벨 · UTC 동기', recNow > 0)}<b class="va">›</b>
      ${stage('🎞', '3 에피소드', `성공률 ${okRate}%`, `성공 ${P.okEps} / 전체 ${P.allEps}`, false)}<b class="va">›</b>
      ${stage('🗄', '4 서버 저장', epRec.server ? `${epRec.uploaded}개 · ${(epRec.bytes / 1048576).toFixed(1)}MB` : '브라우저 보관', epRec.server ? escV(`…/${(vlaDir?.dir ?? 'data/episodes').split(/[\\/]/).slice(-2).join('/')}/<로봇 ID>/*.zip`) : '서버 없음 (웹·공유) — 파일로 내려받아 보관', epRec.uploaded > 0)}<b class="va">›</b>
      ${stage('🧠', '5 VLA 학습', act === 'train' ? `에폭 ${j.epoch}/${j.epochs} · loss ${j.loss.at(-1) ?? '-'}` : `다음 학습까지 ${Math.max(0, need - P.newEps)}개`, act === 'train' ? `${j.label} 미세조정 · 에피소드 ${j.episodes}개` : `새 에피소드 ${P.newEps}개 누적`, act === 'train')}<b class="va">›</b>
      ${stage('✅', '6 평가 게이트', j?.val != null ? `${j.val}% (이전 ${j.prevVal}%)` : last?.val != null ? `${last.label} ${last.val}%` : '-', '검증 성공률 +0.3%p 이상이면 배포', act === 'eval')}<b class="va">›</b>
      ${stage('🚀', '7 로봇 배포', `${P.label(P.latest)} · ${deployed}/${robots.length}대`, act === 'canary' ? `카나리 ${j.canary} 모니터링` : act === 'rollout' ? `OTA ${j.rollout.length}/${j.rollout.length + j.queue.length}대` : '추론 모델 → 로봇 (OTA)', act === 'canary' || act === 'rollout')}
    </div>
    <div class="vla-actions"><button type="button" data-train ${j ? 'disabled' : ''}>🧠 지금 학습 시작</button><span class="vla-note">자동: 새 에피소드 ${need}개마다 학습. 학습은 시뮬레이션이고 에피소드 데이터는 실제 기록입니다. 모델 버전마다 VLA 셀 사이클 1.5%·불량 10% 개선(최대 5단계).</span></div>
    <div class="vla-grid">
      <div><h4>학습·배포 이력</h4><table class="vla-t"><thead><tr><th>모델</th><th>상태</th><th>에피소드</th><th>loss</th><th>검증</th><th>배포</th></tr></thead><tbody>
        ${P.jobs.map((x) => `<tr><td><b>${x.label}</b></td><td class="p-${x.phase}">${({ train: `학습 ${x.epoch}/${x.epochs}`, eval: '평가 중', canary: '카나리', rollout: '배포 중', done: '배포 완료', rejected: '평가 미달' })[x.phase]}</td><td>${x.episodes}</td><td>${x.loss.at(-1) ?? '-'}</td><td>${x.val != null ? x.val + '%' : '-'}</td><td>${x.rollout.length}대</td></tr>`).join('')}
        <tr><td><b>v1.0</b></td><td>기본 모델</td><td>-</td><td>-</td><td>86.0%</td><td>${robots.length}대</td></tr></tbody></table></div>
      <div><h4>로봇별 에피소드 <small>${shared ? '공유 페이지에서는 다운로드할 수 없습니다 (맥 앱·웹 버전에서)' : '⬇ 전체 = 보관 에피소드(최근 30개), ⬇ 1개 = 최근 에피소드 — zip(메타·스텝 JSONL·카메라 JPEG)'}</small></h4>
        <table class="vla-t"><thead><tr><th>ID</th><th>셀 · 로봇</th><th>모델</th><th>보관 / 누적</th><th>성공률</th><th>최근 지시</th><th></th></tr></thead><tbody>
        ${robots.map((R) => { const eps = epRec.list(R.uid), st = P.robotStats.get(R.uid), le = eps.at(-1), dis = !eps.length || shared ? 'disabled' : ''; return `<tr><td><b class="uidc">${R.uid}</b></td><td>${escV(R.st.name.replace(/\s*\(.*\)$/, ''))} · ${kindKo(R.r.kind)}</td><td>${P.versionOf(R.uid)}</td><td>${eps.length} / ${st?.n ?? 0}</td><td>${st?.n ? Math.round((st.ok / st.n) * 100) + '%' : '-'}</td><td class="ins" title="${escV(le?.instruction)}">${escV(le?.instruction ?? '-')}</td><td class="dl"><button type="button" data-dl="${R.uid}" ${dis}>⬇ 전체</button><button type="button" data-dl="${R.uid}" data-one="1" ${dis}>⬇ 1개</button></td></tr>`; }).join('')}</tbody></table></div>
    </div>`;
}

// ── AIOS 공장 운영 AI 창 ─────────────────
const aiosModal = document.getElementById('aiosModal'), aiosBody = document.getElementById('aiosBody');
const aiosUp = { n: 0, bytes: 0, busy: false };
let aiosDir = null;
document.getElementById('btnAios').addEventListener('click', () => {
  aiosModal.classList.remove('hidden'); renderAios(true);
  if (epRec.server) fetch('/api/aios').then((r) => r.json()).then((j) => { aiosDir = j; }).catch(() => {});
});
document.getElementById('closeAios').addEventListener('click', () => aiosModal.classList.add('hidden'));
aiosModal.addEventListener('click', (e) => {
  if (e.target === aiosModal) return aiosModal.classList.add('hidden');
  const P = sim.aios;
  if (e.target.closest('[data-aios-train]')) { if (!P.startTraining(true)) sim.log('info', 'AIOS 학습 요청 보류', { obs: P.job ? '이미 학습·배포 진행 중' : '새 운영 샘플이 30개(5분) 이상 필요' }); renderAios(true); return; }
  const b = e.target.closest('[data-aios-dl]'); if (!b || b.disabled) return;
  const last = P.samples.at(-1)?.t ?? 0, range = b.dataset.aiosDl === 'recent' ? [last - 600, last] : null;
  const zip = buildAiosZip(P, zipStore, (t) => hub.iso(t), epRec.runId, range);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  a.download = `AIOS_ops_${range ? 'recent10m' : `${P.samples.length}samples`}_${P.version}_${epRec.runId}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
// 10분 묶음이 생길 때마다 서버(data/aios/)에 올린다
function aiosUpload() {
  const P = sim.aios; if (!P?.on || !epRec.server || aiosUp.busy) return;
  const c = P.chunks.find((x) => !x.up); if (!c) return;
  c.up = true; aiosUp.busy = true;
  const zip = buildAiosZip(P, zipStore, (t) => hub.iso(t), epRec.runId, [c.t - (AIOS_CHUNK - 1) * AIOS_SAMPLE_S, c.t]);
  fetch(`/api/aios?id=${epRec.runId}_${c.id}`, { method: 'POST', body: zip }).then((r) => { if (r.ok) { aiosUp.n++; aiosUp.bytes += zip.length; } })
    .catch(() => {}).finally(() => { aiosUp.busy = false; });
}
function renderAios(force) {
  if (aiosModal.classList.contains('hidden') && !force) return;
  const P = sim.aios;
  if (!P?.on) { aiosBody.innerHTML = '<p class="vla-note">AIOS는 피지컬AI 단계에서 동작합니다.</p>'; return; }
  if (aiosBody.querySelector('button:hover')) return;
  const j = P.job, act = j?.phase ?? 'idle', last = P.jobs.find((x) => x.result), need = AIOS_TRAIN_MIN * P.backoff;
  const tw = j?.phase === 'twin' && j.twin?.total ? Math.round((j.twin.steps / j.twin.total) * 100) : null;
  const stage = (ic, title, val, sub, on) => `<div class="vs aios ${on ? 'on' : ''}"><i>${ic}</i><b>${title}</b><span>${val}</span><small>${sub}</small></div>`;
  const ph = { train: (x) => `학습 ${x.epoch}/${x.epochs}`, twin: () => '트윈 검증', shadow: () => '섀도 모드', verify: () => '적용 · 효과 확인', done: () => '배포 완료', rejected: () => '배포 안 함', rollback: () => '롤백' };
  const S = P.samples.slice(-8).reverse(), shared = !!window.JIN3D_SHARED;
  const dirTxt = `…/${(aiosDir?.dir ?? 'data/aios').split(/[\\/]/).slice(-2).join('/')}/*.zip`;
  aiosBody.innerHTML = `
    <div class="vla-flow">
      ${stage('🏭', '1 현장 데이터 수집', `샘플 ${P.total}개 · ${AIOS_SAMPLE_S}초 주기`, '생산·설비·물류(AMR·AGV)·에너지·품질 + 인시던트·운영 의사결정', true)}<b class="va">›</b>
      ${stage('🧹', '2 AI-ready 정제', `특징 ${AIOS_FEATURES.length}종 · 셀 ${sim.processing.length}×5`, '고정 스키마 · UTC 동기 · 보상 라벨 · 전이(상태·행동·보상)', true)}<b class="va">›</b>
      ${stage('📚', '3 운영 데이터셋', `전이 ${Math.max(0, P.samples.length - 1)} · 이벤트 ${P.events.length}`, `의사결정 ${P.decisions.length}건 · 10분 묶음 ${P.chunks.length}개`, false)}<b class="va">›</b>
      ${stage('🗄', '4 서버 저장', epRec.server ? `${aiosUp.n}묶음 · ${(aiosUp.bytes / 1048576).toFixed(1)}MB` : '브라우저 보관', epRec.server ? escV(dirTxt) : '서버 없음 (웹·공유) — 파일로 내려받아 보관', aiosUp.n > 0)}<b class="va">›</b>
      ${stage('🧠', '5 AIOS 학습', act === 'train' ? `에폭 ${j.epoch}/${j.epochs} · loss ${j.loss.at(-1) ?? '-'}` : `다음 학습까지 ${Math.max(0, need - P.newSamples)}개`, act === 'train' ? `${j.label} · 정책 헤드 ${AIOS_HEADS.length}개` : `새 샘플 ${P.newSamples}개 누적 (30분마다)`, act === 'train')}<b class="va">›</b>
      ${stage('🧪', '6 트윈 검증', tw != null ? `시뮬레이션 ${tw}%` : last ? `UPH ${last.result.uphCur} → ${last.result.uphCand}` : '-', tw != null ? '현재 vs 후보 정책 · 20분 × 2' : last ? `${last.label} · 생산 ${last.result.gain >= 0 ? '+' : ''}${last.result.gain}% · 에너지 ${last.result.eGain >= 0 ? '+' : ''}${last.result.eGain}%` : '디지털트윈에서 현재·후보 정책 비교', act === 'twin')}<b class="va">›</b>
      ${stage('🚀', '7 오케스트레이터 배포', `AIOS ${P.version}`, act === 'shadow' ? `${j.label} 섀도 모드 (추천만)` : act === 'verify' ? `${j.label} 적용 · 실측 효과 확인 중` : '운영 정책 → 피지컬AI 오케스트레이터', act === 'shadow' || act === 'verify')}
    </div>
    <div class="vla-actions"><button type="button" data-aios-train ${j ? 'disabled' : ''}>🧠 지금 학습 시작</button>
      <button type="button" data-aios-dl="all" ${shared || !P.samples.length ? 'disabled' : ''}>⬇ 운영 데이터셋 (보관 ${Math.round(P.samples.length * AIOS_SAMPLE_S / 60)}분)</button>
      <button type="button" data-aios-dl="recent" ${shared || !P.samples.length ? 'disabled' : ''}>⬇ 최근 10분</button>
      <span class="vla-note">${shared ? '공유 페이지에서는 다운로드할 수 없습니다 (맥 앱·웹 버전에서). ' : ''}학습은 데이터 기반 정책 탐색(시뮬레이션), 트윈 검증·배포 후 효과는 실제 시뮬레이션 측정값입니다.</span></div>
    <div class="vla-grid">
      <div><h4>운영 정책 (오케스트레이터 적용 값)</h4><table class="vla-t"><thead><tr><th>정책 헤드</th><th>v1.0</th><th>현재 ${P.version}</th><th>의미</th></tr></thead><tbody>
        ${AIOS_HEADS.map((h) => `<tr><td><b>${h.label}</b></td><td>${h.base}${h.unit}</td><td class="${P.policy[h.key] !== h.base ? 'p-done' : ''}">${P.policy[h.key]}${h.unit}</td><td class="ins" title="${escV(h.desc)}">${escV(h.desc)}</td></tr>`).join('')}</tbody></table>
        <h4>학습·배포 이력</h4><table class="vla-t"><thead><tr><th>모델</th><th>상태</th><th>샘플</th><th>트윈 UPH</th><th>실측 UPH</th><th>학습 근거</th></tr></thead><tbody>
        ${P.jobs.map((x) => `<tr><td><b>${x.label}</b></td><td class="p-${x.phase === 'shadow' || x.phase === 'verify' || x.phase === 'twin' ? 'train' : x.phase === 'rollback' ? 'rejected' : x.phase}">${ph[x.phase](x)}</td><td>${x.samples}</td><td>${x.result ? `${x.result.uphCur}→${x.result.uphCand}` : '-'}</td><td>${x.after ? `${x.after.before}→${x.after.uph}` : '-'}</td><td class="ins" title="${escV(x.why.join(' · ') || x.reason || '')}">${escV(x.why.join(' · ') || x.reason || '-')}</td></tr>`).join('')}
        <tr><td><b>v1.0</b></td><td>규칙 기반 초기 정책</td><td>-</td><td>-</td><td>-</td><td class="ins">-</td></tr></tbody></table></div>
      <div><h4>최근 운영 데이터 <small>10초 샘플 · AI-ready 시계열 (UTC)</small></h4><table class="vla-t"><thead><tr><th>시각</th><th>UPH</th><th>OEE</th><th>재공</th><th>전력</th><th>AMR 대기</th><th>열린 인시던트</th><th>보상</th></tr></thead><tbody>
        ${S.map((x) => `<tr><td>${hub.iso(x.t).slice(11, 19)}</td><td>${x.uph}</td><td>${x.oee}%</td><td>${x.wip}</td><td>${x.power_kw}kW</td><td>${x.src_noamr_s}s</td><td>${x.incidents_open}</td><td>${x.reward}</td></tr>`).join('') || '<tr><td colspan="8">수집 대기 중…</td></tr>'}</tbody></table>
        <h4>최근 인시던트 <small>감지 → 판단 → 완료 시간</small></h4><table class="vla-t"><thead><tr><th>시각</th><th>유형</th><th>내용</th><th>판단</th><th>완료</th></tr></thead><tbody>
        ${P.events.slice(-6).reverse().map((e) => `<tr><td>${hub.iso(e.t).slice(11, 19)}</td><td>${escV(e.type)}</td><td class="ins" title="${escV(e.title)}">${escV(e.title)}</td><td>${e.decide_s != null ? `${e.decide_s}s` : '셀 자체'}</td><td>${e.resolve_s}s</td></tr>`).join('') || '<tr><td colspan="5">아직 없음</td></tr>'}</tbody></table></div>
    </div>`;
}

// ── FACOS 공장 운영 SW 통합 표시 (피지컬AI) ─────────────────
// 운영자 지시 → AIOS → 오케스트레이터 → 자율 에이전트 → 명령 센터 → 셀·게이트 → VLA → 현장 감지 → DataHub 를 한 줄로, 계층마다 실시간 상태와 해당 창 바로가기
const facosEl = document.getElementById('facos');
try { if (localStorage.getItem('jin3d.facos.min') === '1') facosEl.classList.add('min'); } catch { /* 저장소 없음 */ }
facosEl.addEventListener('click', (e) => {
  if (e.target.closest('.fc-brand')) { facosEl.classList.toggle('min'); try { localStorage.setItem('jin3d.facos.min', facosEl.classList.contains('min') ? '1' : '0'); } catch { /* 무시 */ } return; }
  const c = e.target.closest('[data-open]'); if (!c) return;
  if (c.dataset.open.startsWith('facos:')) openFacosView(c.dataset.open.slice(6)); else document.getElementById(c.dataset.open)?.click();
});
const AIOS_PH = { train: '학습 중', twin: '트윈 검증', shadow: '섀도', verify: '배포 확인' };
const VLA_PH = { train: '학습 중', eval: '평가', canary: '카나리', rollout: 'OTA 배포' };
function renderFacos() {
  if (modeKey !== 'dark') return;
  const s = sim, K = s.cmd, P = s.aios, V = s.vla;
  const open = s.orch.openCount(), evs = (s.fieldEvents ?? []).filter((e) => !e.cleared).length;
  const cells = s.processing.filter((st) => !st.standby), busy = cells.filter((st) => st.state === 'BUSY').length, down = cells.filter((st) => st.state === 'DOWN').length;
  const gates = cells.filter((st) => st.gateCount).reduce((a, st) => a + Object.values(st.gateCount).reduce((x, y) => x + y, 0), 0);
  const vrob = s.processing.filter((st) => st.vlaCell).reduce((a, st) => a + (st.robotUids?.length ?? 0), 0);
  const cmd = K.estopAll || s.processing.some((st) => st.cmd?.estop) ? ['비상정지 발령', 'bad'] : K.pstopAll ? ['보호정지', 'warn'] : K.lineSafe || K.evac || K.feedHold ? ['제한 운전', 'warn'] : ['정상', 'ok'];
  const mq = hub.mqtt;
  const L = [
    ['💬', '운영자 지시', llm.enabled ? '대화 기반' : '추론 기반', 'ok', null, '추론 기반: 내장 규칙 자율 운영 · 대화 기반: 지시 → 지시 게이트(해석·대상·안전·실행 가능성·영향) → 반영 (js/llm.js · js/dialog.js · js/gate.js)'],
    ['🏭', 'AIOS', `${P.version}${P.job ? ` · ${AIOS_PH[P.job.phase] ?? ''}` : ''}`, P.job ? 'act' : 'ok', 'btnAios', '공장 운영 AI — 운영 데이터 → 정책 학습 → 트윈 검증 → 오케스트레이터 배포 (js/aios.js)'],
    ['🛰', '오케스트레이터', open ? `인시던트 ${open}건` : '인시던트 없음', open ? 'warn' : 'ok', 'btnOrch', '인시던트 감지 → 셀 자체 조치 → 보고 → 판단 → 명령 → 조치 → 완료 확인 (js/orchestrator.js)'],
    ['🤖', '자율 에이전트', `의사결정 ${agent.decisions}건`, 'ok', 'facos:agent', '관찰 → 판단 → 실행: 예지정비·자율 보정·투입 제어·병목 최적화·공급 차질·AGV 배차·절전 (js/agent.js)'],
    ['📡', '명령 센터', cmd[0], cmd[1], 'btnOrch', '상위 긴급·제어 명령: 전송 → 셀 ACK → 실행 → 완료, 인터록 (js/commands.js)'],
    ['🚦', '셀·게이트', `가동 ${busy}/${cells.length}${down ? ` · 고장 ${down}` : ''} · 판별 ${gates}`, down ? 'warn' : 'ok', 'facos:cell', '셀 컨트롤러 · 분류·포장 게이트 판별 → 로봇 역할(주 작업/보조) 결정 (js/sim.js)'],
    ['🧠', 'VLA', `${V.label(V.latest)} · ${vrob}대${V.job ? ` · ${VLA_PH[V.job.phase] ?? ''}` : ''}`, V.job ? 'act' : 'ok', 'btnVla', '로봇 VLA 추론 모델 — 에피소드 → 학습 → 평가 → 카나리 → OTA 배포 (js/vla.js)'],
    ['👁', '현장 감지', evs ? `이벤트 ${evs}건` : `CCTV ${s.cctv.cams.length} · 드론 ${s.drones.length} · 사족 ${s.quads.length}`, evs ? 'warn' : 'ok', 'facos:sense', '사각지대 없는 CCTV AI 영상 분석 · 로봇 비전 AI 이벤트 감지 · 순찰 드론 · 사족보행 열화상·진동 점검 (js/cctv.js · js/robotcam.js · js/drone.js)'],
    ['🗄', 'DataHub', mq.available ? `MQTT ${mq.sent.toLocaleString('ko-KR')}건` : `AAS · 수집 ${hub.samples.length}`, mq.available && mq.failed ? 'warn' : 'ok', 'btnData', '기준 시계(UTC) · AAS · OPC UA PubSub over MQTT · AASX 저장 (js/datahub.js)'],
  ];
  const html = `<button type="button" class="fc-brand" title="FACOS — 피지컬AI 공장 운영 SW (누르면 접기/펴기)"><b>FACOS</b><small>공장 운영 SW</small></button>` + L.map(([ic, nm, val, cls, open, tip], i) =>
    `${i ? '<i class="fc-arw">›</i>' : ''}<button type="button" class="fc-l ${cls}" ${open ? `data-open="${open}"` : 'disabled'} title="${escV(tip)}"><span class="fc-n"><i class="fc-ic">${ic}</i>${nm}</span><span class="fc-v">${escV(val)}</span></button>`).join('');
  if (html !== facosEl.dataset.h) { facosEl.dataset.h = html; facosEl.innerHTML = html; }
}

// ── FACOS 계층 상세: 자율 에이전트 · 셀·게이트 · 현장 감지 (데이터 기반 진행 결과) ─────────────────
const fcModal = document.getElementById('facosModal'), fcBody = document.getElementById('facosBody'), fcTitle = document.getElementById('facosTitle');
let fcView = null;
const fclock = (t) => { const x = Math.floor(t) + 8 * 3600; return `${String(Math.floor(x / 3600) % 24).padStart(2, '0')}:${String(Math.floor(x / 60) % 60).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const fdur = (s) => (s == null ? '-' : s >= 60 ? `${(s / 60).toFixed(1)}분` : `${s.toFixed(1)}초`);
const pct = (v) => `${Math.round(v * 100)}%`;
const tile = (k, v, sub = '') => `<div class="fc-tile"><small>${k}</small><b>${v}</b>${sub ? `<i>${sub}</i>` : ''}</div>`;
const bars = (rows, unit = '건') => { const mx = Math.max(1, ...rows.map((r) => r[1])); return `<div class="fc-bars">${rows.map(([k, v, c]) => `<div class="fc-bar"><span>${escV(k)}</span><i style="width:${(v / mx) * 100}%;${c ? `background:${c}` : ''}"></i><b>${v}${unit}</b></div>`).join('')}</div>`; };
// UPH 추이 (최근 10분 이동 UPH, 1분 간격) — 막대
function uphSpark() {
  const h = sim.history.filter((x, i) => i % 3 === 0).slice(-40); if (h.length < 2) return '<p class="vla-note">추이 수집 중…</p>';
  const mx = Math.max(1, ...h.map((x) => x.uph)), W = 100 / h.length;
  return `<svg class="fc-spark" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="시간당 생산 추이">${h.map((x, i) => `<rect x="${i * W + 0.15}" y="${32 - (x.uph / mx) * 30}" width="${W - 0.3}" height="${(x.uph / mx) * 30}" fill="#3fd0c9"><title>${fclock(x.t)} · UPH ${Math.round(x.uph)} · OEE ${pct(x.oee)}</title></rect>`).join('')}</svg><div class="fc-axis"><span>${fclock(h[0].t)}</span><span>최대 UPH ${Math.round(mx)}</span><span>${fclock(h.at(-1).t)}</span></div>`;
}
function viewAgent() {
  const A = agent, k = sim.kpi(), s = sim;
  const bott = s.processing.filter((st) => !st.standby).reduce((b, st) => { const c = st.def.cycle * s.mode.cycleMul * st.speedMul * (st.def.share ?? 1); return c > b.c ? { c, st } : b; }, { c: 0, st: null });
  const saving = s.processing.filter((st) => st.powerSave).length, avgH = s.processing.reduce((a, st) => a + st.health, 0) / s.processing.length;
  const cats = Object.entries(A.byCat).sort((a, b) => b[1] - a[1]);
  return `<div class="fc-tiles">
      ${tile('의사결정', `${A.decisions}건`, `${fdur(s.time)} 동안`)}${tile('예지정비', `${k.pm}건`, `고장 ${k.failures}건`)}${tile('품질 보정', `${k.cal}건`, `유출 ${k.escaped}건 · ${Math.round(k.ppm)} ppm`)}
      ${tile('투입 간격', `${s.releaseInterval.toFixed(2)}초`, bott.st ? `병목 ${bott.st.name} ${bott.c.toFixed(1)}초` : '')}${tile('평균 재공', `${k.avgWip.toFixed(1)}개`, `현재 ${k.wip}개`)}${tile('평균 건강도', `${avgH.toFixed(0)}%`, `절전 셀 ${saving}개`)}${tile('OEE', pct(k.OEE), `가동 ${pct(k.A)} · 양품 ${pct(k.Q)}`)}${tile('에너지', `${k.kwhPerUnit.toFixed(3)} kWh/개`, `${k.energy.toFixed(1)} kWh`)}
    </div>
    <div class="vla-grid"><div><h4>분류별 의사결정</h4>${cats.length ? bars(cats) : '<p class="vla-note">아직 의사결정이 없습니다.</p>'}<h4>시간당 생산 추이 <small>최근 10분 이동 UPH</small></h4>${uphSpark()}</div>
    <div><h4>최근 판단 근거와 실행 <small>관찰 → 판단 → 실행</small></h4><table class="vla-t"><thead><tr><th>시각</th><th>분류</th><th>판단</th><th>관찰 · 근거</th><th>실행</th></tr></thead><tbody>
      ${A.history.slice(-14).reverse().map((d) => `<tr><td>${fclock(d.t)}</td><td>${escV(d.cat)}</td><td class="ins" title="${escV(d.title)}"><b>${escV(d.title)}</b></td><td class="ins" title="${escV([d.obs, d.dec].filter(Boolean).join(' · '))}">${escV([d.obs, d.dec].filter(Boolean).join(' · ') || '-')}</td><td class="ins" title="${escV(d.act ?? '')}">${escV(d.act ?? '-')}</td></tr>`).join('') || '<tr><td colspan="5">아직 없음</td></tr>'}</tbody></table></div></div>`;
}
function viewCells() {
  const s = sim, T = Math.max(1, s.time), cells = s.processing.filter((st) => !st.standby);
  const mixW = ZONE_MIXES[s.line.mix]?.w, mixSum = mixW ? Object.values(mixW).reduce((a, b) => a + b, 0) : 0;
  const gates = cells.filter((st) => st.def.type === 'sort' || st.def.type === 'pack');
  const PCOL = { doortrim: '#f0a030', eaxle: '#9a6bff' };
  const gateCard = (st) => {
    const c = st.gateCount ?? {}, n = Object.values(c).reduce((a, b) => a + b, 0);
    const rows = Object.keys(ZONE_PRODUCTS).map((p) => [`${ZONE_PRODUCTS[p].label} ${n ? pct((c[p] ?? 0) / n) : '-'}${mixSum ? ` (목표 ${pct((mixW[p] ?? 0) / mixSum)})` : ''}`, c[p] ?? 0, PCOL[p]]);
    const lead = Object.entries(st.leadCount ?? {});
    return `<div class="fc-card"><h4>🚦 ${escV(st.name)} 게이트 <small>판별 ${n}건 · 현재: ${escV(st.item && st.gate?.id === st.item.id ? st.gate.text : '대기')}</small></h4>
      ${bars(rows)}
      <div class="fc-sub">주 작업 배정: ${lead.map(([u, v]) => `<b>${escV(u)}</b> ${v}회`).join(' · ') || '-'}</div>
      <table class="vla-t"><thead><tr><th>시각</th><th>대상물</th><th>판별 결정</th><th>주 작업 로봇</th></tr></thead><tbody>
      ${(st.gateLog ?? []).slice(-6).reverse().map((g) => `<tr><td>${fclock(g.t)}</td><td>#${g.item}</td><td style="color:${PCOL[g.product] ?? 'inherit'}">${escV(g.text)}</td><td>${escV(g.lead.join(', '))}</td></tr>`).join('') || '<tr><td colspan="4">아직 없음</td></tr>'}</tbody></table></div>`;
  };
  return `<h4>셀별 진행 결과 <small>${fdur(T)} 누적 · 이용률은 최근 90초 평균</small></h4><table class="vla-t"><thead><tr><th>ID</th><th>셀</th><th>상태</th><th>이용률</th><th>처리</th><th>불량</th><th>고장</th><th>건강도</th><th>자재대기</th><th>배출대기</th><th>정지·정비</th><th>실효 사이클</th></tr></thead><tbody>
    ${cells.map((st) => `<tr><td><b class="uidc">${escV(st.uid ?? st.id)}</b></td><td>${escV(st.name)}</td><td>${escV(ST_LABEL[st.state] ?? st.state)}</td><td>${pct(st.ema)}</td><td>${st.c.processed}</td><td>${st.c.defects}</td><td>${st.c.fails}</td><td style="color:${st.health > 60 ? '#8ff0b8' : st.health > 40 ? '#ffc65a' : '#ff7b7b'}">${st.health.toFixed(0)}%</td><td>${pct(st.c.starved / T)}</td><td>${pct(st.c.blocked / T)}</td><td>${pct((st.c.down + st.c.maint) / T)}</td><td>${(st.def.cycle * s.mode.cycleMul * st.speedMul * (s.vla?.cycleFactor(st) ?? 1)).toFixed(1)}초</td></tr>`).join('')}</tbody></table>
    ${gates.length ? `<div class="fc-cards">${gates.map(gateCard).join('')}</div>` : '<p class="vla-note">이 라인에는 분류·포장 게이트 셀이 없습니다.</p>'}`;
}
function viewSense() {
  const s = sim, L = s.fieldLog ?? [], det = L.filter((e) => e.detected), done = L.filter((e) => e.cleared && e.tClear != null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const st = s.stats, scans = s.scanLog ?? [];
  const resp = (e) => e.responder ?? (e.type === 'intrusion' ? '주변 셀 감속 · 원격 관제' : '-');
  return `<div class="fc-tiles">
      ${tile('현장 이벤트', `${L.length}건`, `감지 ${det.length} · 처리 ${done.length}`)}${tile('평균 감지 시간', fdur(avg(det.map((e) => e.tDetect - e.t0))), '발생 → 카메라 AI 인식')}${tile('평균 처리 시간', fdur(avg(done.map((e) => e.tClear - e.t0))), '발생 → 해소')}${tile('평균 추론 신뢰도', det.length ? avg(det.map((e) => e.conf)).toFixed(2) : '-')}
      ${tile('CCTV (사각지대 없음)', `${s.cctv.cams.length}대`, `감시 ${(s.cctv.stats.coverage * 100).toFixed(1)}% · 이중 감시 ${(s.cctv.stats.redundancy * 100).toFixed(0)}% · CCTV 감지 ${L.filter((e) => e.cctv).length}건`)}${tile('사족보행 순찰 점검', `${st.scans ?? 0}회`, `예지정비 ${st.scan_예지정비 ?? 0} · 재보정 ${st.scan_재보정 ?? 0}`)}${tile('드론 사고 현장 출동', `${s.stats.droneMissions ?? 0}회`, (() => { const ds = s.orch.incidents.filter((i) => i.drone).map((i) => i.drone.dt); return ds.length ? `평균 도착 ${fdur(avg(ds))} · 순찰 지점 ${s.drones.reduce((a, d) => a + (d.visits ?? 0), 0)}곳` : `순찰 지점 ${s.drones.reduce((a, d) => a + (d.visits ?? 0), 0)}곳`; })())}
    </div>
    ${(() => { const Z = DRONE_SIZING, ps = s.dronePatrolStats(), arr = s.orch.incidents.filter((i) => i.drone).map((i) => i.drone.dt).sort((a, b) => a - b), none = s.drones.length && !s.drones.some((d) => d.available);
      return `<div class="fc-card"><h4>🛸 드론 운용 대수 산정 <small>시설 크기(순찰 주기) · 인시던트 출동률 기준 → <b>${Z.chosen}대 운영</b> (현재 ${s.drones.length}대)</small></h4>
      <table class="vla-t"><thead><tr><th>대수</th><th>순찰 재방문 평균</th><th>재방문 p95 (≤${Z.criteria.revisitP95}초)</th><th>도착 p95</th><th>20초 안 도착 (≥${Z.criteria.arrive20}%)</th><th>가용 0대 시간 (≤${Z.criteria.noneMax}%)</th><th>판정</th></tr></thead><tbody>
      ${Z.rows.map((r) => { const ok = r.revisitP95 <= Z.criteria.revisitP95 && r.arrive20 >= Z.criteria.arrive20 && r.none <= Z.criteria.noneMax; return `<tr${r.n === Z.chosen ? ' style="background:rgba(63,208,201,.14)"' : ''}><td><b>${r.n}대</b></td><td>${r.revisit}초</td><td class="${r.revisitP95 <= Z.criteria.revisitP95 ? 'p-done' : 'p-rejected'}">${r.revisitP95}초</td><td>${r.arriveP95}초</td><td class="${r.arrive20 >= Z.criteria.arrive20 ? 'p-done' : 'p-rejected'}">${r.arrive20}%</td><td class="${r.none <= Z.criteria.noneMax ? 'p-done' : 'p-rejected'}">${r.none}%</td><td>${r.n === Z.chosen ? '✅ 선택 (최소 충족)' : ok ? '충족 (여유)' : '미달'}</td></tr>`; }).join('')}
      <tr><td><b>실측</b></td><td>${ps ? fdur(ps.mean) : '-'}</td><td>${ps ? fdur(ps.p95) : '-'}</td><td>${arr.length ? fdur(arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))]) : '-'}</td><td>${arr.length ? Math.round((arr.filter((x) => x <= 20).length / arr.length) * 100) + '%' : '-'}</td><td>${none ? '지금 가용 0대' : '가용 있음'}</td><td>운영 중 측정</td></tr></tbody></table>
      <div class="fc-sub">측정 조건: 자연 고장·결품 + 현장 이벤트 시간당 6건 + 90분마다 10분 공급 차질, 3시간 × 3회. 현장 이벤트 2배(12건/시간)에서도 3대는 재방문 p95 ${Z.stress.n3.revisitP95}초 · 20초 안 도착 ${Z.stress.n3.arrive20}% · 가용 0대 ${Z.stress.n3.none}% (2대는 p95 ${Z.stress.n2.revisitP95}초 · ${Z.stress.n2.none}%). 순찰 구간을 대수만큼 나눠 맡고, 인시던트는 가장 가까운 가용 드론이 출동합니다.</div></div>`; })()}
    <h4>현장 이벤트 처리 결과 <small>로봇 카메라 AI 감지 → 오케스트레이터 → 대응</small></h4><table class="vla-t"><thead><tr><th>발생</th><th>유형</th><th>감지 로봇</th><th>신뢰도</th><th>감지까지</th><th>드론 확인</th><th>대응</th><th>해소까지</th><th>상태</th></tr></thead><tbody>
      ${L.slice(-8).reverse().map((e) => `<tr><td>${fclock(e.t0)}</td><td>${escV(e.label)}</td><td>${escV(e.detectedBy ?? '-')}</td><td>${e.conf?.toFixed(2) ?? '-'}</td><td>${e.detected ? fdur(e.tDetect - e.t0) : '-'}</td><td>${escV(e.droneBy ?? '-')}${e.inc?.drone ? ` (+${fdur(e.inc.drone.dt)})` : ''}</td><td class="ins" title="${escV(resp(e))}">${escV(resp(e))}</td><td>${e.cleared && e.tClear != null ? fdur(e.tClear - e.t0) : '-'}</td><td class="${e.cleared ? 'p-done' : e.detected ? 'p-train' : 'p-rejected'}">${e.cleared ? '해소' : e.detected ? '대응 중' : '미감지'}</td></tr>`).join('') || '<tr><td colspan="9">아직 없음 — 하단 "⚠ 현장 이벤트"로 발생시킬 수 있습니다</td></tr>'}</tbody></table>
    <div class="vla-grid"><div><h4>사족보행 순찰 점검 <small>열화상·진동 스캔 결과</small></h4><table class="vla-t"><thead><tr><th>시각</th><th>로봇</th><th>셀</th><th>건강도</th><th>편차</th><th>결과</th></tr></thead><tbody>
      ${scans.slice(-8).reverse().map((x) => `<tr><td>${fclock(x.t)}</td><td>${escV(x.by)}</td><td>${escV(x.st)}</td><td>${x.health}%</td><td>${x.drift}%</td><td class="${x.result === '정상' ? 'p-done' : x.result === '점검 생략' ? '' : 'p-rejected'}">${escV(x.result)}</td></tr>`).join('') || '<tr><td colspan="6">아직 없음</td></tr>'}</tbody></table></div>
    <div><h4>순찰 드론</h4><table class="vla-t"><thead><tr><th>드론</th><th>상태</th><th>배터리</th><th>순찰 지점</th><th>사고 현장 출동</th><th>비행 시간</th></tr></thead><tbody>
      ${s.drones.map((d) => `<tr><td><b class="uidc">${escV(d.uid ?? d.id)}</b></td><td class="ins" title="${escV(d.task)}">${escV(d.task)}</td><td>${Math.round(d.battery)}%</td><td>${d.visits ?? 0}곳</td><td>${d.missions ?? 0}회</td><td>${fdur(d.flight ?? 0)}</td></tr>`).join('') || '<tr><td colspan="6">드론 없음</td></tr>'}</tbody></table>
      <h4>최근 드론 순찰</h4><table class="vla-t"><thead><tr><th>시각</th><th>드론</th><th>점검 지점</th><th>배터리</th></tr></thead><tbody>
      ${(s.droneVisits ?? []).slice(-6).reverse().map((v) => `<tr><td>${fclock(v.t)}</td><td>${escV(v.by)}</td><td>${escV(v.where)}</td><td>${v.battery}%</td></tr>`).join('') || '<tr><td colspan="4">아직 없음</td></tr>'}</tbody></table></div></div>`;
}
const FC_VIEWS = { agent: ['🤖 자율 에이전트 · 진행 결과', '관찰 → 판단 → 실행 의사결정과 운영 지표', viewAgent], cell: ['🚦 셀·게이트 · 진행 결과', '셀별 생산·상태 누적과 분류·포장 게이트 판별 (혼류)', viewCells], sense: ['👁 현장 감지 · 진행 결과', '로봇 비전 AI 이벤트 감지·대응, 사족보행 순찰 점검, 순찰 드론', viewSense] };
function openFacosView(k) { fcView = k; fcModal.classList.remove('hidden'); renderFacosView(true); }
function renderFacosView(force) {
  if (!fcView || fcModal.classList.contains('hidden')) return;
  if (!force && fcBody.querySelector(':hover')) return;   // 마우스를 올려 둔 동안은 고정 (툴팁 유지)
  if (modeKey !== 'dark') { fcModal.classList.add('hidden'); return; }
  const [t, sub, fn] = FC_VIEWS[fcView];
  fcTitle.innerHTML = `${t} <small>FACOS · ${sub}</small>`;
  fcBody.innerHTML = fn();
}
document.getElementById('closeFacos').addEventListener('click', () => { fcModal.classList.add('hidden'); fcView = null; });
fcModal.addEventListener('click', (e) => { if (e.target === fcModal) { fcModal.classList.add('hidden'); fcView = null; } });

window.__twin = { cctvView, epRec, get sim() { return sim; }, get agent() { return agent; }, view, ui, hub, camWall, orchView, persp, ctlP, llm };
