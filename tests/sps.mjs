// 정밀조립Zone 서열 키팅 · 라인사이드 칸반 검증 (js/sps.js) — 키트 구성(제품마다 4개 · 조립셀 로봇 순서) · 키팅 구역 배치(셀 밖 · 분기 차로 · 클린 부스),
// 부품분류셀 연결(선반 대신 키트 컨베이어 · 정비 자리 · 부품 선반 재고 대상 아님), 피지컬AI ①~⑥이 단계별로 다르게 기록되는지와 셀 대기 시간, 센서값 · 데이터(MQTT 토픽)를 확인한다
// (트레이·피킹 로봇·키트 포켓 동작은 화면 factory.js sortAMMR · sortArm · animSps). 실행: npm test
import { Simulation } from '../js/sim.js';
import { zoneLine, AMMR, effCycle, ZONE_T, MODE_CYCLE_MUL } from '../js/line.js';
import { SPS_SPEC, SPS_SENSORS, SPS_TOPIC, SPS_KITS, SPS_RACKS, SPS_GEO, SPS_SIDE, SPS_LINE, SPS_T, kitSlot, SORT_AMMR, SORT_ARM, sortPlaced, sortGrabbed } from '../js/sps.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

console.log('== 구성 · 배치');
check('키트: 도어트림·e-axle 각 4개(조립셀 로봇 4대 순서) · 흐름 랙 3대 · e-axle 베어링·오일씰은 로트 추적', Object.values(SPS_KITS).every((k) => k.length === 4 && k.every((q) => q[2] >= 0 && q[2] < 3)) && Object.values(SPS_RACKS).every((r) => r.length === 3) && SPS_KITS.eaxle.filter((q) => q[5]).map((q) => q[0]).join() === '베어링,오일씰' && !SPS_KITS.doortrim.some((q) => q[5]));
check('키팅 구역 쪽: 도어트림 +z · e-axle −z (게이트 결정의 주 작업 로봇 쪽) · 라인사이드 칸반 셀 4곳', SPS_SIDE.doortrim === 1 && SPS_SIDE.eaxle === -1 && Object.keys(SPS_LINE).join() === 'DT_ASSY,DT_FAST,EA_ASSY,EA_FAST');
const G = SPS_GEO, B = G.booth;
check('배치: 키트 컨베이어는 셀(±2.3) 밖 · 동쪽 끝이 분기 차로(컨베이어 높이 z에서 x 4.2~)와 떨어짐 · 버퍼 4칸 + 담기 자리 겹치지 않음 · 꺼내는 자리 = AMR 가운데(x 0) · 서쪽 정비 자리(x −3.0)와 떨어짐',
  G.conv.z - G.conv.w / 2 > 2.3 && G.conv.x1 < 2.3 + (G.conv.z - G.conv.w / 2) * (2.9 / 4.6) - 0.5 && G.buf.every((x, i) => i === 0 || x - G.buf[i - 1] >= 0.48) && G.build - 0.23 > G.buf.at(-1) + 0.23 && G.buf[0] === 0 && G.chute.x0 > -3.0 + 0.6 && B.x0 > -3.0 + 0.1);
check('닿는 거리: 부품분류셀 협동로봇(x 0 · z 1.6)이 컨베이어 맨 앞 트레이와 키트 포켓 먼 칸에 모두 닿음 (UR20 1.75m) · 키트 포켓 칸은 제품 쪽 절반에',
  Math.hypot(0.165, G.conv.z - G.armZ) < 1.6 && Object.keys(SPS_KITS).every((p) => [0, 1, 2, 3].every((j) => { const k = kitSlot(p, j); return Math.hypot(k[0], k[2] - SPS_SIDE[p] * G.armZ) < 1.72 && Math.sign(k[2]) === SPS_SIDE[p]; })));
check('배치: 피킹 길은 컨베이어와 흐름 랙 사이 · 클린 부스는 컨베이어를 덮지 않음(셀 쪽 트임) · 흐름 랙을 덮음', G.lane > G.conv.z + G.conv.w / 2 && G.lane < G.rackZ - G.rackD / 2 && B.z0 > G.conv.z + G.conv.w / 2 && B.z1 > G.rackZ + G.rackD / 2 && B.x0 < Math.min(...G.racks) - G.rackW / 2 && B.x1 > Math.max(...G.racks) + G.rackW / 2);
check('진행 구간: 키팅 피킹(부품 4개 · 0.2씩) → 검증 · 부품분류셀 옮겨 싣기는 부품 4개를 하나씩 (집은 수 ≥ 넣은 수 · 끝에 4개)',
  SPS_T.pick === 0.8 && SPS_T.verify === 1 && [true, false].every((am) => [0.3, 0.5, 0.6, 0.7, 0.8, 0.9].every((p) => sortGrabbed(am, p) >= sortPlaced(am, p)) && sortPlaced(am, 0.99) === 4 && sortPlaced(am, am ? 0.45 : 0.04) === 0)
  && SORT_AMMR.pick[1] < SORT_AMMR.parts[0][0] && SORT_ARM.parts[1] <= SORT_ARM.ret[0]);
check('부품분류셀 사이클: 실제 작업 시간 · 제품 쪽 로봇 1대가 하므로 대수로 줄지 않음 (레거시 18 · 자동화 25 · 피지컬AI 30초)', (() => { const l = zoneLine(), sr = l.stations[0]; const two = effCycle(sr, 'dark'), four = effCycle({ ...sr, robot: { ...sr.robot, count: 4 } }, 'dark'); return sr.kitXfer && two === four && ['traditional', 'smart', 'dark'].every((m, i) => Math.abs(effCycle(sr, m) * MODE_CYCLE_MUL[m] - ZONE_T.SORT[i]) < 1e-9) && ZONE_T.SORT.join() === '18,25,30'; })());

console.log('== 부품분류셀 연결');
const sims = Object.fromEntries(['dark', 'smart', 'traditional'].map((m) => [m, new Simulation(m, 17, { line: zoneLine(), quiet: true })]));
const sortOf = (s) => s.processing.find((x) => x.id === 'SORT');
const D = sortOf(sims.dark);
check('피지컬AI 부품분류셀: 부품 선반 재고·보충 대상 아님(서열 버퍼에서 꺼냄) · 다른 셀은 선반 재고 그대로', D.parts == null && sims.dark.processing.filter((x) => x.id !== 'SORT').every((x) => x.parts === sims.dark.mode.partsCap));
check('AMMR: 대기 자리는 AMR 가운데 맞은편(x 0) · 자기 쪽 키트 컨베이어 앞까지 · 선반 메시 없음 표시(sps)', D.ammrRacks?.length === 2 && D.ammrRacks.every((p) => p.sps && p.slot.x === 0 && Math.abs(p.rack.z) === G.conv.z && Math.abs(p.pick.z) === G.pickZ && Math.abs(p.slot.z) === AMMR.slotZ && Math.sign(p.pick.z) === p.side));
{ // 제품 쪽 AMMR만 움직임: 도어트림이 들어오면 +z 로봇, e-axle이면 −z 로봇 (다른 로봇은 대기 자리)
  const s2 = new Simulation('dark', 5, { line: zoneLine(), quiet: true }), S2 = sortOf(s2), seen = { doortrim: new Set(), eaxle: new Set() };
  for (let t = 0; t < 1500 && (!seen.doortrim.size || !seen.eaxle.size || t < 600); t += 0.1) { s2.step(0.1); if (S2.item?.product && S2.state === 'BUSY') for (const u of S2.ammr) if (u.phase !== 'work' || u.pos > 0) seen[S2.item.product].add(u.side); }
  check('제품별 분담: 도어트림은 +z AMMR만 · e-axle은 −z AMMR만 키트를 가지러 나감 (다른 쪽은 대기)', [...seen.doortrim].join() === '1' && [...seen.eaxle].join() === '-1', `도어트림 ${[...seen.doortrim]} · e-axle ${[...seen.eaxle]}`);
}
check('정비 자리: 셀 서쪽(키팅 구역을 지나지 않음)', D.svc && D.svc.x < D.x - 2.5);

console.log('== 피지컬AI · 자동화 · 레거시 (대상물 3000개 · 9초마다 투입 · 도어트림/e-axle 번갈아)');
const run = (s, n) => {
  const S = s.sps, st = (id) => ({ id }), out = [];
  for (let k = 0; k < n; k++) {
    const p = k % 2 ? 'eaxle' : 'doortrim', it = { id: `T-${k}`, product: p }, A = p === 'doortrim' ? 'DT_ASSY' : 'EA_ASSY', F = p === 'doortrim' ? 'DT_FAST' : 'EA_FAST';
    it.sortExtra = S.plan(st('SORT'), it); S.done(st('SORT'), it); it.loaded = !!it.kitLoaded;
    it.assyExtra = S.plan(st(A), it); S.done(st(A), it);
    it.fastExtra = S.plan(st(F), it); S.done(st(F), it);
    for (let t = 0; t < 9; t += 0.5) { s.time += 0.5; S.build(0.5); S.refillLine(); }
    out.push(it);
  }
  return out;
};
const sent = []; sims.dark.sps.onItem = (x) => sent.push(x);
const R = Object.fromEntries(Object.entries(sims).map(([m, s]) => [m, run(s, 3000)]));
const stt = (m) => sims[m].sps.stats;
check('키트 흐름: 부품분류셀에서 AMR에 실음(kitLoaded) → 조립셀에서 다 씀(kitUsed) · 버퍼는 3개 넘지 않음', Object.values(R).every((a) => a.every((it) => it.loaded && it.kitUsed && it.kit?.parts.length === 4)) && Object.values(sims).every((s) => Object.values(s.sps.side).every((sd) => sd.queue.length <= SPS_SPEC.bufCap)));
check('변형: 도어트림 좌/우 · 색상 · e-axle 감속비 — 키트마다 정해짐', R.dark.filter((x) => x.product === 'doortrim').some((x) => /^LH/.test(x.kit.variant)) && R.dark.filter((x) => x.product === 'doortrim').some((x) => /^RH/.test(x.kit.variant)) && R.dark.filter((x) => x.product === 'eaxle').every((x) => /감속비/.test(x.kit.variant)));
check('① 범용 파지: 피지컬AI = VLA(신뢰도) · 자동화 = 레일 협동로봇 표시등 피킹 · 레거시 = 작업자', R.dark.every((it) => it.kit.pick.method.startsWith('VLA') && it.kit.pick.conf >= 0.95) && R.smart.every((it) => it.kit.pick.method.startsWith('레일')) && R.traditional.every((it) => it.kit.pick.method === '작업자 키팅'));
check('② 빈 피킹: 피지컬AI만 집기 실패를 스스로 다시 집음', stt('dark').graspRetry > 0 && stt('smart').graspRetry === 0 && stt('traditional').graspRetry === 0, `다시 집음 ${stt('dark').graspRetry}회`);
// 조립셀까지 새는 비율은 키트 2만 개로 (3000개는 놓침 수가 수십 건이라 자동화·레거시 차이가 흔들린다)
const leak = (m) => { const S = new Simulation(m, 23, { line: zoneLine(), quiet: true }).sps; let n = 0; for (let k = 0; k < 20000; k++) n += S.makeKit(k % 2 ? 'eaxle' : 'doortrim').missed ? 1 : 0; return n; };
const L3 = { dark: leak('dark'), smart: leak('smart'), traditional: leak('traditional') };
check('③ 키트 검증: 피지컬AI는 잘못 담은 키트를 모두 검증에서 잡음 · 자동화는 같은 무게 좌/우·색상을 조립셀까지 놓침 · 레거시는 더 놓침',
  stt('dark').errors > 0 && stt('dark').missed === 0 && stt('smart').missed > 0 && stt('smart').caught > 0 && L3.dark === 0 && L3.traditional > L3.smart * 1.3,
  `3000개 조립셀에서 발견 ${stt('dark').missed}/${stt('smart').missed}/${stt('traditional').missed} (잘못 담음 ${stt('dark').errors}/${stt('smart').errors}/${stt('traditional').errors}) · 2만 개 ${L3.dark}/${L3.smart}/${L3.traditional}`);
const ea = (m) => R[m].filter((x) => x.product === 'eaxle');
check('④ 로트 추적: 피지컬AI는 e-axle 키트 모두 집으면서 판독 → 제품 계보(item.lots) · 자동화는 다시 스캔 · 레거시는 기록 누락',
  ea('dark').every((x) => x.kit.trace === '집으면서 판독' && x.lots?.bearing) && stt('smart').rescans > 0 && stt('smart').traceGap === 0 && stt('traditional').traceGap > 0, `다시 스캔 ${stt('smart').rescans} · 누락 ${stt('traditional').traceGap}`);
check('⑤ 개봉·청정: 피지컬AI는 이물 노출 없음 · 작업자 개봉(자동화·레거시)은 이물 노출', stt('dark').fod === 0 && stt('smart').fod + stt('traditional').fod > 0 && stt('traditional').fod >= stt('smart').fod, `${stt('dark').fod}/${stt('smart').fod}/${stt('traditional').fod}`);
check('⑥ 결품: 흐름 랙 보충 문턱 피지컬AI(35%) > 자동화(25%) > 레거시(빈 칸) — 레거시만 키팅이 멈춤', SPS_SPEC.reorder.dark > SPS_SPEC.reorder.smart && stt('dark').replenish > 0 && stt('smart').replenish > 0 && stt('dark').stockouts === 0 && stt('smart').stockouts === 0 && stt('traditional').stockouts > 0,
  `보충 ${stt('dark').replenish}/${stt('smart').replenish}/${stt('traditional').replenish} · 결품 ${stt('dark').stockouts}/${stt('smart').stockouts}/${stt('traditional').stockouts}`);
const wait = (m) => sum(R[m], (x) => x.sortExtra + x.assyExtra + x.fastExtra);
check('셀 대기 시간(키트 대기 · 조립셀 키트 오류 발견 · 공용 부품 결품): 피지컬AI < 자동화 < 레거시', wait('dark') < wait('smart') && wait('smart') < wait('traditional'), `${wait('dark').toFixed(0)} / ${wait('smart').toFixed(0)} / ${wait('traditional').toFixed(0)}초`);
check('라인사이드 투빈 칸반: 자동화·레거시는 카드로 보충(밀크런 · 작업자) · 피지컬AI는 셀 선반·물류 휴머노이드(칸반 카드 없음)', stt('smart').kanban > 0 && stt('traditional').kanban > 0 && stt('dark').kanban === 0 && Object.values(sims.smart.sps.line).every((L) => L.refills > 0), `칸반 ${stt('smart').kanban}/${stt('traditional').kanban} · 결품 ${stt('smart').lineStockouts}/${stt('traditional').lineStockouts}`);
check('키트 기록 · 데이터 묶음 (…/part · …/event · 최근 200건) · 레거시는 전송 없음', sims.dark.sps.records.length === 60 && sent.filter((x) => x.topic === `${SPS_TOPIC}/part`).length === 3000 && sent.some((x) => x.topic === `${SPS_TOPIC}/event`) && !(sims.traditional.sps.outbox?.length) && sims.dark.sps.outbox.length <= 200);

console.log('== 센서값');
const s = sims.dark; s.sps.acc = 1; s.sps.tick(0); const v = { ...s.sps.latest };
check('센서 8종 · 모두 숫자 · 서열 버퍼 0~3 · 클린 부스 입자: 피지컬AI < 레거시', SPS_SENSORS.length === 8 && SPS_SENSORS.every((x) => Number.isFinite(v[x.key])) && v.bufDT >= 0 && v.bufDT <= 3 && v.bufEA <= 3 && v.particle < 8000,
  `버퍼 ${v.bufDT}/${v.bufEA} · 입자 ${v.particle}`);
const T = sims.traditional; T.sps.acc = 1; T.sps.tick(0);
check('레거시: 센서 데이터 전송 없음 (화면 내부값만)', T.sps.hist.length === 0);

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
