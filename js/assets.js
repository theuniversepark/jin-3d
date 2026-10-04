// 설비 현황 목록 — 공장에 배치·사용되는 모든 설비와 로봇(사람 제외)을 고유 ID와 함께 모으고, 지금 상태를 한 단어로 정한다.
// 오른쪽 벽 전광판(js/factory.js)이 이 목록을 그린다. 상태 분류(cls): run 가동·운행, idle 대기, charge 충전,
// maint 정비·점검·보충, fault 고장, stop 정지(명령), off 미사용.
import { ST_LABEL } from './sim.js';

export const STATUS_CLASS = { run: '가동', idle: '대기', charge: '충전', maint: '정비', fault: '고장', stop: '정지', off: '미사용' };
const ST_CLS = { BUSY: 'run', STARVED: 'idle', BLOCKED: 'idle', IDLE: 'idle', HOLD: 'idle', NOAMR: 'idle', FULL: 'fault', NOPARTS: 'maint', REFILL: 'maint', DOWN: 'fault', MAINT: 'maint', ESTOP: 'stop', PSTOP: 'stop', CSTOP: 'stop', CHECK: 'maint', OFF: 'off' };
const short = (t, n = 9) => { const s = String(t ?? '').replace(/\s*→.*$/, '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function equipmentList(sim, view = null) {
  const out = [], K = sim.cmd, halted = K?.estopAll || K?.pstopAll;
  const add = (uid, name, group, text, cls) => uid && out.push({ uid, name, group, text, cls });
  const stStatus = (st) => [ST_LABEL[st.state] ?? st.state, ST_CLS[st.state] ?? 'idle'];
  // 셀 설비
  const src = sim.stations[0], sink = sim.stations[sim.stations.length - 1];
  add(src.uid, '자재 투입 AS/RS', '설비', ...stStatus(src));
  for (const st of sim.processing) add(st.uid, st.name.replace(/\s*\(.*\)$/, ''), '설비', ...stStatus(st));
  add(sink.uid, sim.zone ? '구분 적재장' : '완제품 적재장', '설비', ...stStatus(sink));
  // 셀 로봇
  const legacy = sim.mode.key === 'traditional';
  for (const st of sim.processing) (st.robotUids ?? []).forEach((uid, i) => {
    const kind = st.def.robot.kind, u = st.ammr?.[i], name = `${st.name.replace(/셀.*$/, '')} ${({ ammr: 'AMMR', cobot: '협동로봇', articulated: '6축로봇', scara: 'SCARA', gantry: '갠트리', humanoid: '휴머노이드' })[kind] ?? kind}`;
    if (legacy) return add(uid, name, '셀 로봇', '수작업 대체', 'off');
    if (st.state === 'DOWN') return add(uid, name, '셀 로봇', '고장 정지', 'fault');
    if (['ESTOP', 'PSTOP', 'CSTOP'].includes(st.state)) return add(uid, name, '셀 로봇', ST_LABEL[st.state], 'stop');
    if (st.state === 'MAINT') return add(uid, name, '셀 로봇', '정비중', 'maint');
    if (u && u.phase !== 'work') return add(uid, name, '셀 로봇', u.phase === 'pick' ? '선반 부품 피킹' : '선반 왕복', 'run');
    add(uid, name, '셀 로봇', st.state === 'BUSY' ? '작업 중' : '대기', st.state === 'BUSY' ? 'run' : 'idle');
  });
  const arms = view?.stationViews?.find((v) => v.st === sink)?.parts.arms;
  (sim.sinkRobotUids ?? []).forEach((uid, i) => {
    const A = arms?.[i ? 'eaxle' : 'doortrim'], name = `적재 로봇 (${i ? 'e-axle' : '도어트림'})`;
    if (legacy) return add(uid, name, '셀 로봇', '수작업 대체', 'off');
    if (halted) return add(uid, name, '셀 로봇', '정지 (명령)', 'stop');
    add(uid, name, '셀 로봇', A?.cyc ? '적재 중' : '대기', A?.cyc ? 'run' : 'idle');
  });
  // 이동 로봇
  const mover = (m, name, group, fn) => {
    if (!m.uid) return;
    if (halted && !m.charging) return add(m.uid, name, group, '정지 (명령)', 'stop');
    const r = fn(m); add(m.uid, name, group, ...r);
  };
  for (const c of sim.carriers) mover(c, `운반 ${c.id}`, '물류', (m) => m.blockedOn ? ['진로 대기', 'idle'] : ({ line: ['운반 중', 'run'], return: ['빈차 복귀', 'run'], toSrc: ['투입 이동', 'run'], docking: ['투입 진입', 'run'], atSrc: ['적재 대기', 'idle'], park: ['대기', 'idle'] })[m.state] ?? ['대기', 'idle']);
  const vehicle = (m) => m.charging ? [`충전 ${m.battery.toFixed(0)}%`, 'charge'] : m.task ? [short(m.task), 'run'] : ['대기', 'idle'];
  for (const v of sim.vehicles) mover(v, v.kind === 'agv' ? `${v.id}` : `${v.id} (유인)`, '물류', vehicle);
  for (const f of sim.forklifts) mover(f, f.receiver ? (f.auto ? '입고 자율 지게차' : '입고 지게차 (유인)') : f.auto ? '출하 자율 지게차' : '출하 지게차 (유인)', '물류', vehicle);
  for (const h of sim.techs) if (h.uid) mover(h, h.kind === 'humanoid' ? `정비 휴머노이드 ${h.id.slice(-1)}` : `정비 로봇 ${h.id.slice(-1)}`, '로봇', (m) => m.task ? [short(m.task), /수리|정비|보정/.test(m.task) ? 'maint' : 'run'] : ['대기', 'idle']);
  for (const h of sim.helpers) mover(h, `물류 휴머노이드 ${h.id.slice(-1)}`, '로봇', (m) => m.task ? [short(m.task), 'run'] : ['대기', 'idle']);
  for (const q of sim.quads) mover(q, `사족보행 ${q.id.slice(-1)}`, '로봇', (m) => m.charging ? [`충전 ${m.battery.toFixed(0)}%`, 'charge'] : m.scanning ? ['점검 중', 'maint'] : m.moving ? ['순찰 이동', 'run'] : m.task ? [short(m.task), 'run'] : ['대기', 'idle']);
  for (const d of sim.drones ?? []) {
    if (!d.uid) continue;
    const [t, c] = d.mode === 'charge' ? [`충전 ${d.battery.toFixed(0)}%`, 'charge'] : d.mode === 'mission' ? [d.arrived ? '사고 현장 중계' : '사고 현장 출동', 'maint'] : d.mode === 'return' ? ['귀환', 'run'] : d.hover > 0 ? ['상공 점검', 'maint'] : d.y < 0.5 ? ['대기', 'idle'] : ['순찰 비행', 'run'];
    add(d.uid, '순찰 드론', '로봇', halted && d.y > 0.5 ? '정지 비행' : t, halted && d.y > 0.5 ? 'stop' : c);
  }
  // Private 5G 기지국 (gNB): PCI · 접속 단말 (자동화·피지컬AI)
  if (sim.net?.on) sim.net.plan.cells.forEach((c, i) => { const n = sim.net.ues.filter((u) => u.serv === i).length; add(c.id, `5G 기지국 PCI ${c.pci}`, '통신', `정상 · 단말 ${n}대`, n ? 'run' : 'idle'); });
  return out;
}
