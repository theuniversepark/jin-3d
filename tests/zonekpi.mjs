// Zone 운영 분석 검증 (js/zonekpi.js · js/zonedash.js) — OEE(ISO 22400-2) 계산식 · 6대 손실 파레토 · 관리도 상수·관리 한계·
// Western Electric 규칙 · 공정능력 · 상관계수 · 정밀조립 실제 시뮬레이션 · 대시보드 화면. 실행: npm test
// (상위 meta-factory tests/zonekpi.mjs에서 확장 Zone 측정 모델 · 설계 UPH · UNS 발행(unsZoneKpi) 검사는 뺐다 — Zone이 하나, UNS는 따로)
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { ZoneKpi, controlChart, westernElectric, pareto, pearson, QSPEC, LOSS, interpretControl, interpretScatter } from '../js/zonekpi.js';
import { zoneDashHTML, zdState } from '../js/zonedash.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647), gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

console.log('== 통계 함수');
{
  const p = pareto([{ key: 'a', v: 10 }, { key: 'b', v: 30 }, { key: 'c', v: 0 }, { key: 'd', v: 60 }]);
  check('파레토 — 큰 순 · 0 제외 · 누적 % 단조 증가 → 100%', p.map((x) => x.key).join() === 'd,b,a' && near(p[0].cum, 0.6) && near(p[1].cum, 0.9) && near(p.at(-1).cum, 1));
  const r = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), r2 = pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), r0 = pearson([1, 1, 1], [1, 2, 3]);
  check('피어슨 상관 — 완전 양·음 상관 ±1 · 회귀 기울기 · 분산 0이면 null', near(r.r, 1) && near(r.b, 2) && near(r.a, 0) && near(r2.r, -1) && r0.r === null);
  // X̄-R: 부분군 5 · 정규분포 평균 10 σ 1 → 관리 한계 ≈ 10 ± 3/√5 · R̄ ≈ d2σ(2.326)
  const v = Array.from({ length: 500 }, () => 10 + gauss()), c = controlChart(v, { n: 5, lsl: 7, usl: 13, maxPts: 100 });
  check('X̄-R (부분군 5) — 표본 40개 이상이면 X̄-R · 최근 100군', c.type === 'xbar-r' && c.points.length === 100 && c.n === 5);
  check('X̄-R 관리 한계 = X̄̄ ± A2·R̄ (A2 0.577) · R 상한 = D4·R̄ (2.114) · σ = R̄/d2', near(c.ucl - c.cl, 0.577 * c.rcl, 1e-9) && near(c.rucl, 2.114 * c.rcl, 1e-9) && near(c.sigma, c.rcl / 2.326, 1e-9) && Math.abs(c.cl - 10) < 0.2 && Math.abs(c.sigma - 1) < 0.15, `CL ${c.cl.toFixed(3)} · σ ${c.sigma.toFixed(3)}`);
  check('공정능력 Cp ≈ (13−7)/6σ ≈ 1 · Cpk ≤ Cp', Math.abs(c.cp - 1) < 0.15 && c.cpk <= c.cp + 1e-9, `Cp ${c.cp.toFixed(2)} · Cpk ${c.cpk.toFixed(2)}`);
  const im = controlChart([5, 6, 5, 7, 6, 5, 6, 7, 6, 5], { lsl: 0, usl: 10 });
  check('표본이 적으면(8 ~ 39개) I-MR · 한계 = 평균 ± 2.66·MR̄', im.type === 'i-mr' && near(im.ucl - im.cl, 2.66 * im.rcl, 1e-9) && near(im.rucl, 3.267 * im.rcl, 1e-9));
  check('표본 8개 미만이면 그리지 않음', controlChart([1, 2, 3]).type === 'none');
  const rules = (xs) => new Set(westernElectric(xs, 0, 1).map((x) => x.rule));
  check('Western Electric — 규칙 1(3σ 밖) · 2(3점 중 2점 2σ 밖) · 3(5점 중 4점 1σ 밖) · 4(8점 같은 쪽)', rules([0, 0, 3.5]).has(1) && rules([0, 2.5, 0.2, 2.6]).has(2) && rules([0, 1.5, 1.2, 0.3, 1.4, 1.6]).has(3) && rules([0.2, 0.3, 0.1, 0.5, 0.2, 0.4, 0.3, 0.1]).has(4) && rules([0.5, -0.5, 0.4, -0.3, 0.2, -0.6, 0.1, -0.2]).size === 0);
  const shifted = [...Array.from({ length: 100 }, () => 10 + gauss() * 0.5), ...Array.from({ length: 40 }, () => 11.2 + gauss() * 0.5)];
  const cs = controlChart(shifted, { n: 5, maxPts: 28 });
  check('평균 이동(+2.4σ) 뒤 구간 — 관리도 이상 감지', cs.viol.some((x) => x.i >= 18), cs.viol.map((x) => `${x.i}:${x.rule}`).slice(-4).join(' '));
}

console.log('== OEE 계산 (가짜 셀 — 숫자로 확인)');
{
  // 셀 1개: 계획 정비 100초 · 고장 60 · 운영 정지 40 · 가동 600 · 자재 대기 150 · 막힘 50 = 1000초 · 처리 50개 × 기준 10초 · 양품 45 / 판정 50
  const st = { id: 'C03', name: '시험 셀', c: { busy: 600, down: 60, maint: 100, stop: 40, starved: 150, blocked: 50, processed: 50 }, def: { cycle: 10 } };
  const sim = { time: 1000, mode: { cycleMul: 1 }, processing: [st, { ...st, id: 'SB', standby: true }], kpi: () => ({ good: 45, out: 45, rejected: 5, A: 800 / 900, P: 500 / 800, Q: 0.9 }) };
  const K = new ZoneKpi(sim), o = K.oee('main'), r = o.rows.find((x) => x.id === 'C03');
  check('셀 시간 분류 — 계획 정비·고장·운영 정지·가동·자재 대기·막힘 (예비 셀 제외)', o.rows.length === 1 && r.t.pm === 100 && r.t.down === 60 && r.t.stop === 40 && r.t.busy === 600 && r.t.idle === 150 && r.t.blocked === 50, JSON.stringify(r.t));
  check('셀 가동률 A = (900 − 60 − 40) / 900 · 성능 P = 50 × 10 / 800 · 품질 Q = 45 / 50', near(r.A, 800 / 900) && near(r.P, 500 / 800) && near(o.Q, 0.9) && near(r.OEE, (800 / 900) * (500 / 800) * 0.9), `A ${r.A.toFixed(3)} · P ${r.P.toFixed(3)} · Q ${o.Q} · OEE ${r.OEE.toFixed(3)}`);
  sim.time = 1100; const r2 = K.oee('main').rows[0];
  check('상태를 따로 세지 않은 시간(100초)은 공전(자재 대기)으로', r2.t.idle === 250 && near(r2.tot, 1100));
  const L = K.lossPareto('main', o), m = Object.fromEntries(L.map((x) => [x.key, x.v]));
  check('손실 파레토(분) — 자재 대기 150초 · 속도 저하(가동 600 − 50×10) 100초 · 고장 60 · 막힘 50 · 불량 5개×10초 · 운영 정지 40', near(m.idle, 2.5) && near(m.speed, 100 / 60) && near(m.down, 1) && near(m.blocked, 50 / 60) && near(m.defect, 50 / 60) && near(m.stop, 40 / 60) && L[0].key === 'idle' && near(L.at(-1).cum, 1));
  check('손실 6대 손실 분류 라벨', L.every((x) => LOSS[x.key]?.six));
}

console.log('== 정밀조립 실제 시뮬레이션 (자동화 · 1시간)');
const s = new Simulation('smart', 4, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
for (let t = 0; t < 3600; t += 0.1) { s.step(0.1); ag.update(0.1); }
const K = s.zkpi, o = K.oee('main'), k = s.kpi();
check('정밀조립 OEE = KPI 화면 라인 OEE (A·P·Q 같은 값)', near(o.OEE, k.A * k.P * k.Q, 1e-9) && near(o.A, k.A) && near(o.Q, k.Q), `OEE ${(o.OEE * 100).toFixed(1)}%`);
check('셀 행 6개 (예비 제외) · 시간 합 = 경과 시간', o.rows.length === s.processing.filter((x) => !x.standby).length && o.rows.every((r) => near(r.tot, s.time, 1)));
K.collectMain(); const U = K.units.main;
check('품질 표본 = 체결 검사 마친 제품 · 제품별 품질 특성(도어트림 나사 · e-axle 볼트 규격 따로)', U.length > 50 && U.every((u) => (u.product === 'eaxle' ? 'ea_torque' in u.y : 'dt_torque' in u.y)) && !U.some((u) => 'ea_torque' in u.y && 'dt_torque' in u.y), `${U.length}개`);
check('검사 셀 자신의 토크·각도는 공정 변수(x)에 넣지 않음', U.every((u) => !Object.keys(u.x).some((x) => /_FAST_(torque|angle)$/.test(x))));
const cdt = controlChart(U.map((u) => u.y.dt_torque), { lsl: QSPEC.main.dt_torque.lsl, usl: QSPEC.main.dt_torque.usl });
check('도어트림 토크 관리도 — 중심선이 규격(4.0 ~ 5.0 N·m) 안', cdt.type !== 'none' && cdt.cl > 4 && cdt.cl < 5, `${cdt.type} CL ${cdt.cl?.toFixed(3)} · Cpk ${cdt.cpk?.toFixed(2)}`);
const ngp = K.ngPareto('main');
check('NG 유형 파레토 합 = 불량 사례 수 + 유출', ngp.reduce((a, x) => a + x.v, 0) === s.trace.cases.length + s.trace.stats.escaped, ngp.map((x) => `${x.label} ${x.v}`).join(' · '));
const pr = K.progress('main');
check('진행률 — 교대 계획(설계 UPH) · 경과 시간 기대치 (공장 오더는 FacOS가 있을 때만)', pr.target > 0 && pr.done === s.stats.good && near(pr.expect, 3600 / 28800, 1e-3) && (s.fos ? pr.order != null : pr.order === null));
check('추세 기록 30초마다', K.hist.length >= 100 && K.hist.every((h) => h.main && Number.isFinite(h.main.OEE)));
for (const tab of ['live', 'oee', 'qa']) { zdState.tab = tab; const h = zoneDashHTML(s); check(`Zone 대시보드 「${tab}」 — 그려짐 · NaN/undefined 없음 · SVG 차트`, h.length > 5000 && !/NaN|undefined|Infinity/.test(h.replace(/<[^>]+>/g, ' ')) && /<svg/.test(h)); }
check('Zone 고르는 단추 없음 (정밀조립Zone 하나) · 이름 표시', !/data-zd-zone/.test(zoneDashHTML(s)) && /정밀조립Zone/.test(zoneDashHTML(s)));
for (let t = 0; t < 600; t += 0.1) { s.step(0.1); ag.update(0.1); }

console.log('== 그래프 해석 (관리도 · 산점도)');
{
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }, gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const SP = { label: '보어', unit: 'µm', lsl: -15, usl: 15 }, txt = (I) => JSON.stringify(I);
  const stable = Array.from({ length: 30 }, (_, i) => [0.6, -0.4, 1.1, -0.9, 0.2, -1.2, 0.8, -0.1, 0.4, -0.7][i % 10] * 2), Is = interpretControl(controlChart(stable, SP), stable, SP);
  check('안정 · 중심 맞음 · Cpk 높음 → good · 「관리 상태」 · 조치 = 현 조건 유지', Is.tone === 'good' && /관리 상태/.test(txt(Is)) && /현 조건 유지/.test(Is.acts.join()), Is.head);
  const shift = [...Array.from({ length: 20 }, () => gauss()), ...Array.from({ length: 10 }, () => 6 + gauss())], Ish = interpretControl(controlChart(shift, SP), shift, SP, { label: '공구 마모', r: 0.62 });
  check('후반 평균 이동 → 평균/추세 경고 · 공구·보정 이력 조치 · 원인 후보 변수', Ish.tone !== 'good' && Ish.items.some((i) => ['평균', '추세'].includes(i.k) && i.tone !== 'good') && /공구 교체/.test(Ish.acts.join()) && /공구 마모/.test(Ish.acts.join()), Ish.head);
  const off = Array.from({ length: 30 }, () => 9 + gauss()), Io = interpretControl(controlChart(off, SP), off, SP);
  check('중심 치우침(Cp ≫ Cpk) → USL 쪽 · 중심 조정 조치', /USL 쪽/.test(txt(Io)) && /중심 조정/.test(Io.acts.join()));
  check('표본 8개 미만 → 해석 없음', interpretControl(controlChart([1, 2, 3], SP), [1, 2, 3], SP) === null);
  const U2 = Array.from({ length: 40 }, (_, i) => { const w = 10 + i * 1.5, y = -10 + 0.4 * w + gauss() * 1.2; return { id: `S${i}`, x: { vb: w }, y: { bore: y }, ng: y > 15 }; });
  const Isc = interpretScatter(U2, 'vb', 'bore', { label: '마모 VB', unit: 'µm' }, SP);
  check('강한 양의 상관 → 유의 · 기울기 · 공차 대비 영향 · USL 도달 지점 · NG가 높은 쪽에 몰림', /강한 양\(\+\)/.test(txt(Isc)) && Isc.items.some((i) => i.k === '신뢰도' && i.tone === 'good') && Isc.items.some((i) => i.k === '한계 도달') && /높은 쪽에서 NG/.test(txt(Isc)) && /관리 기준/.test(Isc.acts.join()), Isc.head);
  const U3 = Array.from({ length: 40 }, (_, i) => ({ id: `R${i}`, x: { vb: rnd() * 50 }, y: { bore: gauss() * 3 }, ng: false }));
  const Iw = interpretScatter(U3, 'vb', 'bore', { label: '마모 VB', unit: 'µm' }, SP);
  check('무관한 변수 → 관계 약함 · 다른 변수 확인 조치 · 한계 도달 없음', /관계 약함/.test(Iw.head) && /상관표/.test(Iw.acts.join()) && !Iw.items.some((i) => i.k === '한계 도달'), Iw.head);
  // Codex 검수 5 — 음의 기울기: x가 커질수록 y가 LSL로 내려감. 한계 전 · 일치 · 후 (양의 기울기 USL도 같은 방식)
  const lim = (b, xs, L) => interpretScatter(xs.map((x, i) => ({ id: `L${i}`, x: { w: x }, y: { d: b > 0 ? x - 30 + 20 : 50 - x }, ng: false })), 'w', 'd', { label: '마모', unit: 'µm' }, { label: '치수', unit: 'mm', ...L }).items.find((i) => i.k === '한계 도달');
  const xsTo = (last) => Array.from({ length: 40 }, (_, i) => 1 + (i * (last - 1)) / 39);
  const nb = [lim(-1, xsTo(25), { lsl: 20 }), lim(-1, xsTo(30), { lsl: 20 }), lim(-1, xsTo(40), { lsl: 20 })], pb = [lim(1, xsTo(25), { usl: 20 }), lim(1, xsTo(40), { usl: 20 })];
  check('한계 도달 — 음의 기울기 LSL: 전 = 남음 · 일치 · 후 = 이미 넘음 (양의 기울기 USL도)', nb[0]?.tone === 'warn' && /5\.00 남았습니다/.test(nb[0].t) && nb[1]?.tone === 'bad' && nb[2]?.tone === 'bad' && /이미 넘었습니다/.test(nb[2].t) && pb[0]?.tone === 'warn' && pb[1]?.tone === 'bad', [...nb, ...pb].map((x) => x?.t.split('— ')[1]).join(' | '));
  // Codex 검수 6 — 산포 0인데 전부 규격 밖
  const flat = Array(40).fill(20), If = interpretControl(controlChart(flat, SP), flat, SP);
  check('산포 0 · 전부 규격 밖 → bad · 「규격 밖 40개」 · 능력 충분 아님 · 측정기 확인 조치', If.tone === 'bad' && /규격 밖 40개/.test(If.head) && !/능력 충분/.test(txt(If)) && /측정기/.test(If.acts.join()), If.head);
  const flatIn = Array(40).fill(1), Ifi = interpretControl(controlChart(flatIn, SP), flatIn, SP);
  check('산포 0 · 규격 안 → 「능력 충분」 단정 안 함 (warn)', Ifi.tone === 'warn' && !/능력 충분/.test(Ifi.head), Ifi.head);
  zdState.tab = 'qa'; const hq = zoneDashHTML(s);
  check('품질·상관 탭 — 관리도·산점도 해석 상자 2개 · NaN/undefined 없음', (hq.match(/class="zd-ins /g) ?? []).length === 2 && /관리도 해석/.test(hq) && /산점도 해석/.test(hq) && !/NaN|undefined|Infinity/.test(hq.replace(/<[^>]+>/g, ' ')));
}

console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
