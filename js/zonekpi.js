// Zone 운영 분석 — 종합 설비 효율(OEE, ISO 22400-2) · 6대 손실·NG 유형 파레토 · 관리도(X̄-R / I-MR · Western Electric 규칙 1~4) · 공정–품질 상관(산점도·회귀)
//  · 셀 시간 분류 (셀 상태 누적 시간 — sim.js 셀 카운터): 가동 · 고장 · 계획 정비 · 준비·교체 · 운영 정지 · 자재 대기 · 출구 막힘
//    가동률 A = 가동 가능 시간 ÷ 계획 시간 (계획 시간 = 전체 − 계획 정비 · 가동 가능 = 계획 − 고장 − 준비·교체 − 운영 정지)
//    성능 P = 처리 수 × 기준 사이클 ÷ 가동 가능 시간 (자재 대기 · 출구 막힘 · 속도 저하가 여기서 빠진다)
//    품질 Q = 양품 ÷ 판정 수 (재작업·NG 포함)  →  OEE = A × P × Q
//  · 제품 1개 = 품질 표본 1건: 공정 변수(x) + 품질 특성(y) + NG 여부·유형 — 제품 계보(js/trace.js)에서 가져온다 (Zone은 정밀조립 하나 — 상위 meta-factory의 확장 Zone 측정 모델은 없다)
import { PARAM_SPEC } from './trace.js';

export const ZONES = ['main'];
export const ZONE_NAME = { main: '정밀조립Zone' };
// 6대 손실 (설비 고장 · 준비·조정 · 공전·순간정지 · 속도 저하 · 공정 불량 · 초기 수율) → 시뮬레이터 셀 상태로 나눔
export const LOSS = {
  down: { label: '설비 고장', six: '설비 고장', col: '#ff5a5a' },
  setup: { label: '준비·교체 (품목 전환·공구 교환)', six: '준비·조정', col: '#f5b82e' },
  stop: { label: '운영 정지 (비상·보호·셀 정지)', six: '준비·조정', col: '#d08cff' },
  idle: { label: '자재 대기 (공전)', six: '공전·순간정지', col: '#7fb8cc' },
  blocked: { label: '출구 막힘 (다음 공정 대기)', six: '공전·순간정지', col: '#5b8fd9' },
  speed: { label: '속도 저하 (사이클 지연·재작업 사이클)', six: '속도 저하', col: '#3fc1c9' },
  defect: { label: '불량·재작업', six: '공정 불량', col: '#ff8a5c' },
};
export const PLANNED = { pm: '계획 정비 (예지정비·교정 — OEE 계획 시간에서 제외)' };
const BUCKETS = ['busy', 'down', 'pm', 'setup', 'stop', 'idle', 'blocked'];
// 품질 특성 (y) 규격 — 관리도·산점도 기준선
export const QSPEC = {
  main: {   // 제품마다 체결 규격이 다르다 (도어트림 나사 체결 · e-axle 볼트 체결) — 섞으면 관리도가 의미 없음
    dt_torque: { label: '도어트림 체결 토크', unit: 'N·m', product: 'doortrim', ...lim(PARAM_SPEC.screw.torque) }, dt_angle: { label: '도어트림 체결 각도', unit: '°', product: 'doortrim', ...lim(PARAM_SPEC.screw.angle) },
    ea_torque: { label: 'e-axle 체결 토크', unit: 'N·m', product: 'eaxle', ...lim(PARAM_SPEC.fasten.torque) }, ea_angle: { label: 'e-axle 체결 각도', unit: '°', product: 'eaxle', ...lim(PARAM_SPEC.fasten.angle) },
  },
};
function lim(s) { return { lsl: s.lsl, usl: s.usl }; }
const r3 = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export class ZoneKpi {
  constructor(sim) {
    this.sim = sim; sim.zkpi = this;
    this.reset();
  }
  reset() {
    this.units = { main: [] };   // 품질 표본 (최근 600개)
    this.xl = { main: {} };   // 공정 변수 이름 · 단위
    this.hist = []; this.lastSnap = -Infinity; this.out = [];   // 추세 (30초마다) · 설비 대시보드로 보낼 품질 표본
    this.feedOn = false; this.mainSeen = new Set();
  }
  // ── OEE ─────────────────
  // 셀 행: { id, name, t, done, ideal, A, P, Q?, OEE } · Zone: 라인 OEE (KPI 화면과 같은 값)
  cellRows() {
    const s = this.sim;
    {
      const T = Math.max(1, s.time), m = s.mode;
      return (s.processing ?? []).filter((st) => !st.standby).map((st) => {
        const c = st.c, t = { busy: c.busy ?? 0, down: c.down ?? 0, pm: c.maint ?? 0, setup: 0, stop: c.stop ?? 0, idle: c.starved ?? 0, blocked: c.blocked ?? 0 };
        const known = Object.values(t).reduce((a, b) => a + b, 0); t.idle += Math.max(0, T - known);   // 상태를 따로 세지 않는 순간(대상물 출구 대기 등)은 공전으로
        return this.row(st.id, st.name, t, c.processed ?? 0, st.def.cycle * (m.cycleMul ?? 1));
      });
    }
  }
  row(id, name, t, done, ideal) {
    const tot = BUCKETS.reduce((a, b) => a + t[b], 0), plan = tot - t.pm, run = Math.max(0, plan - t.down - t.setup - t.stop);
    const A = plan > 0 ? run / plan : 1, P = run > 0 ? Math.min(1, (done * ideal) / run) : 0;
    return { id, name, t: { ...t }, tot, plan, run, done, ideal, A, P, speedLoss: Math.max(0, t.busy - done * ideal) };
  }
  quality() { const k = this.sim.kpi(); return { good: k.good, judged: k.out + k.rejected, Q: k.Q, label: '체결 전수 검사 양품률' }; }
  oee(zone) {
    const rows = this.cellRows(zone), q = this.quality(zone), R = rows.filter((r) => !r.standby);
    const plan = R.reduce((a, r) => a + r.plan, 0), run = R.reduce((a, r) => a + r.run, 0), eff = R.reduce((a, r) => a + r.done * r.ideal, 0);
    let A = plan > 0 ? run / plan : 1, P = run > 0 ? Math.min(1, eff / run) : 0, Q = q.Q;
    if (zone === 'main') { const k = this.sim.kpi(); A = k.A; P = k.P; Q = k.Q; }   // 정밀조립은 라인 OEE (KPI 화면과 같은 값)
    for (const r of rows) r.Q = Q, r.OEE = r.A * r.P * Q;
    return { zone, A, P, Q, OEE: A * P * Q, rows, quality: q, ideal: Math.max(0, ...R.map((r) => r.ideal)) };
  }
  // 손실 파레토 (분) — 셀 합계 · 불량 손실 = (판정 − 양품) × Zone 기준 사이클(가장 긴 셀)
  lossPareto(zone, o = this.oee(zone)) {
    const v = { down: 0, setup: 0, stop: 0, idle: 0, blocked: 0, speed: 0, defect: 0 };
    for (const r of o.rows.filter((x) => !x.standby)) { v.down += r.t.down; v.setup += r.t.setup; v.stop += r.t.stop; v.idle += r.t.idle; v.blocked += r.t.blocked; v.speed += r.speedLoss; }
    v.defect = Math.max(0, o.quality.judged - o.quality.good) * o.ideal;
    return pareto(Object.entries(v).map(([k, x]) => ({ key: k, label: LOSS[k].label, six: LOSS[k].six, v: x / 60 })));
  }
  ngPareto(zone) {
    const s = this.sim, m = {};
    if (zone === 'main') {
      for (const c of s.trace?.cases ?? []) { const k = String(c.inspection?.mode ?? (c.kind === 'sample' ? '출하 전 샘플 재검 NG' : '기타')).split(' — ')[0].replace(/\s*\(.*\)$/, ''); m[k] = (m[k] ?? 0) + 1; }
      if (s.trace?.stats.escaped) m['유출 (검사 미검출 — 출하 후 발견)'] = s.trace.stats.escaped;
    }
    return pareto(Object.entries(m).map(([label, v]) => ({ key: label, label, v })));
  }
  // 생산 진행률: 교대(8시간) 계획 · 공장 오케스트레이터(FacOS)가 있으면 현재 오더
  progress(zone) {
    const s = this.sim, shift = 8 * 3600, el = Math.min(1, s.time / shift);
    if (zone === 'main') {
      const o = s.fos?.order, R = o ? s.fos.main?.reconcile?.(o.id) : null, ideal = s.idealCycle || 30, target = Math.round(shift / ideal);
      return { label: '교대 계획 (설계 UPH 기준)', done: s.stats.good, target, pct: s.stats.good / target, expect: el, order: o ? { id: o.id, done: R?.good ?? 0, target: o.target, due: o.due } : null };
    }
  }
  // 추세 (30초마다 — 대시보드 시계열 · 설비 대시보드 발행)
  tick() {
    const s = this.sim; if (s.time - this.lastSnap < 30) return; this.lastSnap = s.time;
    this.collectMain();
    const snap = { t: s.time };
    for (const z of ZONES) {
      const o = this.oee(z), cells = s.processing.filter((x) => !x.standby);
      snap[z] = { A: o.A, P: o.P, Q: o.Q, OEE: o.OEE, h: Object.fromEntries(cells.map((c) => [c.id, Math.round(c.health)])) };
    }
    this.hist.push(snap); if (this.hist.length > 960) this.hist.shift();
  }

  // ── 품질 표본 ─────────────────
  push(zone, u) {
    const L = this.units[zone]; L.push(u); if (L.length > 600) L.shift();
    if (this.feedOn) { this.out.push({ zone, ...u }); if (this.out.length > 2000) this.out.splice(0, this.out.length - 2000); }
  }
  drain() { return this.out.splice(0); }
  label(zone, key, label, unit = '') { this.xl[zone][key] ??= { label, unit }; }
  // 정밀조립: 제품 계보(셀별 공정 측정값·건강도·드리프트·환경)를 표본으로 — 체결 전수 검사 토크·각도가 품질 특성
  collectMain() {
    const T = this.sim.trace; if (!T) return;
    for (const r of T.recent) {
      if (r.status === 'wip' || !r.inspection || this.mainSeen.has(r.item)) continue;
      this.mainSeen.add(r.item); if (this.mainSeen.size > 5000) this.mainSeen = new Set([...this.mainSeen].slice(-2500));
      const x = {};
      for (const p of r.steps) {
        if (p.result != null) continue;   // 체결 전수 검사 셀 자신의 토크·각도는 품질 특성(y)
        for (const [k, v] of Object.entries(p.params ?? {})) if (Number.isFinite(v)) { x[`${p.id}_${k}`] = v; const S = Object.values(PARAM_SPEC).find((o) => o[k])?.[k]; this.label('main', `${p.id}_${k}`, `${p.name} ${S?.label ?? k}`, S?.unit ?? ''); }
        if (Number.isFinite(p.health)) { x[`${p.id}_health`] = p.health; this.label('main', `${p.id}_health`, `${p.name} 건강도`, '%'); }
        if (Number.isFinite(p.drift)) { x[`${p.id}_drift`] = p.drift; this.label('main', `${p.id}_drift`, `${p.name} 드리프트`, ''); }
      }
      const e = r.steps.at(-1)?.env; if (e) { for (const [k, lb, un] of [['temp', '환경 온도', '°C'], ['rh', '습도', '%'], ['vib', '바닥 진동', 'mm/s']]) if (Number.isFinite(e[k])) { x[`env_${k}`] = e[k]; this.label('main', `env_${k}`, lb, un); } }
      const ng = r.inspection.result === 'NG' || r.status === 'escaped';
      this.push('main', { t: r.tEnd ?? r.inspection.t, id: r.serial ?? r.wip, product: r.product, x, y: r.product === 'eaxle' ? { ea_torque: r.inspection.torque, ea_angle: r.inspection.angle } : { dt_torque: r.inspection.torque, dt_angle: r.inspection.angle }, ng, kind: ng ? String(r.inspection.mode ?? '유출').split(' — ')[0] : null });
    }
  }
}

// ── 통계 함수 (화면·시험 공용) ─────────────────
export function pareto(items) {
  const L = items.filter((x) => x.v > 0).sort((a, b) => b.v - a.v), tot = L.reduce((a, b) => a + b.v, 0); let c = 0;
  return L.map((x) => ({ ...x, pct: tot ? x.v / tot : 0, cum: tot ? (c += x.v) / tot : 0 }));
}
const A2 = { 2: 1.88, 3: 1.023, 4: 0.729, 5: 0.577, 6: 0.483, 7: 0.419, 8: 0.373, 9: 0.337, 10: 0.308 };
const D3 = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0.076, 8: 0.136, 9: 0.184, 10: 0.223 };
const D4 = { 2: 3.267, 3: 2.574, 4: 2.282, 5: 2.114, 6: 2.004, 7: 1.924, 8: 1.864, 9: 1.816, 10: 1.777 };
const D2 = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.97, 10: 3.078 };
// 관리도: 부분군 n개로 8군 이상이면 X̄-R, 아니면 I-MR (최근 maxPts 점) · 관리 한계는 창 안 전체로 · 규격(lsl·usl)이 있으면 Cp·Cpk
export function controlChart(vals, { n = 5, lsl = null, usl = null, maxPts = 25 } = {}) {
  const v = vals.filter(Number.isFinite);
  if (v.length < 8) return { type: 'none', n: v.length, points: [], viol: [] };
  if (v.length >= n * 8) {
    const groups = []; for (let i = Math.max(0, v.length - n * maxPts - ((v.length - n * maxPts) % n || 0)); i + n <= v.length; i += n) groups.push(v.slice(i, i + n));
    const G = groups.slice(-maxPts), xs = G.map((g) => g.reduce((a, b) => a + b, 0) / n), rs = G.map((g) => Math.max(...g) - Math.min(...g));
    const cl = xs.reduce((a, b) => a + b, 0) / xs.length, rbar = rs.reduce((a, b) => a + b, 0) / rs.length, sigmaX = (A2[n] * rbar) / 3, sigma = rbar / D2[n];
    const pts = xs.map((x, i) => ({ i, x, r: rs[i] }));
    return finish({ type: 'xbar-r', n, points: pts, cl, ucl: cl + A2[n] * rbar, lcl: cl - A2[n] * rbar, rcl: rbar, rucl: D4[n] * rbar, rlcl: D3[n] * rbar, sigmaX, sigma, mean: cl, count: v.length }, lsl, usl);
  }
  const w = v.slice(-maxPts * 2), mr = w.slice(1).map((x, i) => Math.abs(x - w[i])), mrbar = mr.reduce((a, b) => a + b, 0) / Math.max(1, mr.length), cl = w.reduce((a, b) => a + b, 0) / w.length, sigma = mrbar / 1.128;
  return finish({ type: 'i-mr', n: 1, points: w.map((x, i) => ({ i, x, r: i ? mr[i - 1] : null })), cl, ucl: cl + 2.66 * mrbar, lcl: cl - 2.66 * mrbar, rcl: mrbar, rucl: 3.267 * mrbar, rlcl: 0, sigmaX: sigma, sigma, mean: cl, count: v.length }, lsl, usl);
}
function finish(c, lsl, usl) {
  c.viol = westernElectric(c.points.map((p) => p.x), c.cl, c.sigmaX);
  for (const p of c.points) if (p.r != null && p.r > c.rucl + 1e-12) c.viol.push({ i: p.i, rule: 'R', text: '범위(R) 관리 한계 초과 — 산포 증가' });
  c.lsl = lsl; c.usl = usl;
  if (c.sigma > 0) { c.cp = lsl != null && usl != null ? (usl - lsl) / (6 * c.sigma) : null; c.cpk = Math.min(usl != null ? (usl - c.mean) / (3 * c.sigma) : Infinity, lsl != null ? (c.mean - lsl) / (3 * c.sigma) : Infinity); if (!Number.isFinite(c.cpk)) c.cpk = null; }
  return c;
}
// Western Electric 규칙 1~4 (중심선 cl · 점의 표준편차 s)
export function westernElectric(xs, cl, s) {
  const out = []; if (!(s > 0)) return out;
  const z = xs.map((x) => (x - cl) / s), side = (k) => Math.sign(z[k]);
  for (let i = 0; i < z.length; i++) {
    if (Math.abs(z[i]) > 3) out.push({ i, rule: 1, text: '1점이 3σ 관리 한계 밖' });
    if (i >= 2) { const w = [i - 2, i - 1, i]; for (const sd of [1, -1]) if (w.filter((k) => z[k] * sd > 2).length >= 2 && z[i] * sd > 2) out.push({ i, rule: 2, text: '연속 3점 중 2점이 같은 쪽 2σ 밖' }); }
    if (i >= 4) { const w = [i - 4, i - 3, i - 2, i - 1, i]; for (const sd of [1, -1]) if (w.filter((k) => z[k] * sd > 1).length >= 4 && z[i] * sd > 1) out.push({ i, rule: 3, text: '연속 5점 중 4점이 같은 쪽 1σ 밖' }); }
    if (i >= 7) { const sd = side(i); if (sd && [0, 1, 2, 3, 4, 5, 6, 7].every((d) => side(i - d) === sd)) out.push({ i, rule: 4, text: '연속 8점이 중심선 같은 쪽' }); }
  }
  return out;
}
export function pearson(xs, ys) {
  const P = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), n = P.length;
  if (n < 3) return { n, r: null };
  const mx = P.reduce((a, p) => a + p[0], 0) / n, my = P.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of P) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return { n, r: null };
  const b = sxy / sxx; return { n, r: sxy / Math.sqrt(sxx * syy), b, a: my - b * mx, mx, my };
}
// 공정 변수 × 품질 특성 상관 — |r| 큰 순 (표본 minN개 이상)
export function topPairs(units, { minN = 12 } = {}) {
  if (!units.length) return [];
  const xk = [...new Set(units.flatMap((u) => Object.keys(u.x)))], yk = [...new Set(units.flatMap((u) => Object.keys(u.y)))], out = [];
  for (const x of xk) for (const y of yk) { const p = pearson(units.map((u) => u.x[x]), units.map((u) => u.y[y])); if (p.r != null && p.n >= minN) out.push({ x, y, ...p }); }
  return out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

// ── 그래프 해석 (데이터 기반 문장) — 관리도 · 산점도. 문장은 평문(화면에서 이스케이프), tone = good · warn · bad
const nd = (v) => (Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 1 ? 2 : 3);
const fm = (v, d = nd(v)) => Number(v).toFixed(d);
const sgn = (v, d = nd(v)) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}`;
const PHI = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp((-z * z) / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };   // 표준정규 누적분포
const slopeOf = (ys) => { const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; ys.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; syy += (y - my) ** 2; }); return { b: sxx ? sxy / sxx : 0, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0 }; };
// 조사(이/가 · 은/는 · 과/와 · 을/를) — 마지막 글자 받침으로 고른다 (괄호 속 단위는 건너뜀 · 영문자·숫자는 읽는 소리 기준)
const josa = (w, a, b) => { const t = String(w).replace(/\s*\([^)]*\)\s*$/, '').trim(), c = t.at(-1) ?? '', k = c.charCodeAt(0); const bat = k >= 0xac00 && k <= 0xd7a3 ? (k - 0xac00) % 28 !== 0 : /[LMNRlmnr013678]/.test(c); return `${w}${bat ? a : b}`; };
const worst = (a) => (a.includes('bad') ? 'bad' : a.includes('warn') ? 'warn' : 'good');

export function interpretControl(c, vals, spec = {}, lead = null) {
  if (!c || c.type === 'none') return null;
  const u = spec.unit ?? '', xb = c.type === 'xbar-r', W = xb ? '부분군' : '표본', P = c.points.map((p) => p.x), N = P.length, sx = c.sigmaX;
  const items = [], acts = [], uniq = new Set(c.viol.map((v) => v.i)), by = (r) => c.viol.filter((v) => v.rule === r);
  // 1) 안정성
  if (!uniq.size) items.push({ k: '안정성', tone: 'good', t: `관리 상태 — 최근 ${N}개 ${josa(W, '이', '가')} 모두 관리 한계(LCL ${fm(c.lcl)} ~ UCL ${fm(c.ucl)} ${u}) 안에 있고 비랜덤 패턴이 없습니다. 지금 보이는 흔들림은 우연 원인 변동입니다.` });
  else {
    const r1 = by(1), hi = r1.filter((v) => P[v.i] > c.ucl).length, lo = r1.length - hi, recent = [...uniq].some((i) => i >= N - 5);
    const parts = [r1.length && `한계 밖 ${r1.length}점(UCL 위 ${hi} · LCL 아래 ${lo})`, by(2).length && `2σ 밖 몰림 ${new Set(by(2).map((v) => v.i)).size}회`, by(3).length && `1σ 밖 몰림 ${new Set(by(3).map((v) => v.i)).size}회`, by(4).length && `중심선 한쪽 연속 8점 ${new Set(by(4).map((v) => v.i)).size}회`, by('R').length && `범위(${xb ? 'R' : 'MR'}) 한계 초과 ${by('R').length}점`].filter(Boolean);
    items.push({ k: '안정성', tone: 'bad', t: `관리 이탈 — ${parts.join(' · ')}. 우연 변동으로 보기 어려운 특별 원인이 있습니다.${recent ? ' 최근 5개 안에서도 신호가 나와 지금 진행 중인 변화입니다.' : ' 최근 5개에는 신호가 없어 일시적이었을 수 있습니다.'}` });
  }
  // 2) 평균 이동 · 추세
  const k = Math.max(3, Math.min(8, Math.floor(N / 3))), lastM = P.slice(-k).reduce((a, b) => a + b, 0) / k, d = sx > 0 ? (lastM - c.cl) / sx : 0, tr = slopeOf(P), drift = tr.b * (N - 1);
  let moved = false;
  if (sx > 0 && Math.abs(drift) / sx >= 1.5 && Math.abs(tr.r) >= 0.5) { moved = true; items.push({ k: '추세', tone: 'warn', t: `${drift > 0 ? '증가' : '감소'} 추세 — 구간 전체에서 평균이 약 ${sgn(drift)} ${u}(${sgn(drift / sx, 1)}σ) 움직였습니다(추세 상관 ${fm(tr.r, 2)}). 공구 마모·열 변위처럼 서서히 진행하는 원인의 모양입니다.` }); }
  else if (Math.abs(d) >= 1) { moved = true; items.push({ k: '평균', tone: Math.abs(d) >= 2 ? 'bad' : 'warn', t: `최근 ${k}개 ${W} 평균 ${fm(lastM)} ${u}${u ? '로' : '이'} 중심선보다 ${sgn(d, 1)}σ ${d > 0 ? '높습니다' : '낮습니다'} — 평균이 이동했습니다.` }); }
  else items.push({ k: '평균', tone: 'good', t: `최근 ${k}개 ${W} 평균 ${fm(lastM)} ${u} — 중심선(${fm(c.cl)})과 ${sgn(d, 1)}σ 차이로 평균 이동은 없습니다.` });
  // 3) 산포
  const R = c.points.filter((p) => p.r != null).map((p) => p.r), rk = R.slice(-k), rr = c.rcl > 0 && rk.length ? rk.reduce((a, b) => a + b, 0) / rk.length / c.rcl : 1;
  const spread = by('R').length > 0 || rr >= 1.5;
  items.push(spread ? { k: '산포', tone: 'warn', t: rr >= 1.5 ? `산포 증가 — 최근 ${xb ? 'R' : 'MR'} 평균이 전체 평균의 ${fm(rr, 1)}배${by('R').length ? `, 범위 한계 초과 ${by('R').length}점` : ''}. 같은 조건에서 값이 더 들쭉날쭉해졌습니다.` : `범위(${xb ? 'R' : 'MR'}) 한계 초과 ${by('R').length}점 — ${xb ? '부분군 안에서' : '이웃한 표본 사이에'} 값이 크게 튄 곳이 있습니다(최근 ${k}개 산포는 평균의 ${fm(rr, 1)}배 — ${rr < 0.8 ? '지금은 오히려 안정' : '지속적인 산포 증가는 아님'}).` } : { k: '산포', tone: 'good', t: `산포 안정 — 최근 ${xb ? 'R' : 'MR'} 평균이 전체 평균의 ${fm(rr, 1)}배입니다.` });
  // 4) 공정능력 · 규격
  const lsl = spec.lsl ?? null, usl = spec.usl ?? null, two = lsl != null && usl != null, V = vals.filter(Number.isFinite);
  const oos = V.filter((v) => (usl != null && v > usl) || (lsl != null && v < lsl)).length;
  if (c.cpk != null && c.sigma > 0) {
    const ppm = ((usl != null ? 1 - PHI((usl - c.mean) / c.sigma) : 0) + (lsl != null ? PHI((lsl - c.mean) / c.sigma) : 0)) * 1e6;
    const level = (x) => (x >= 1.67 ? ['매우 우수', 'good'] : x >= 1.33 ? ['양호', 'good'] : x >= 1 ? ['보통 — 여유 부족', 'warn'] : ['부족 — 규격 밖 제품이 계속 나올 수준', 'bad']);
    const mV = V.reduce((a, b) => a + b, 0) / V.length, sV = Math.sqrt(V.reduce((a, b) => a + (b - mV) ** 2, 0) / Math.max(1, V.length - 1));
    const ppk = sV > 0 ? Math.min(usl != null ? (usl - mV) / (3 * sV) : Infinity, lsl != null ? (mV - lsl) / (3 * sV) : Infinity) : null;
    const lvC = level(c.cpk), lvP = ppk != null && Number.isFinite(ppk) ? level(ppk) : null, gap = lvP && ppk < c.cpk - 0.2;
    const lv = [lvC[0], worst([lvC[1], gap ? lvP[1] : 'good', oos ? 'warn' : 'good'])];
    let t = `Cpk ${fm(c.cpk, 2)}${two ? ` · Cp ${fm(c.cp, 2)}` : ''} → ${lvC[0]}(군내 산포 기준). 정규분포 가정 시 규격 밖 예상 ${ppm >= 1000 ? `${fm(ppm / 1e4, 2)}%` : `${Math.round(ppm)} ppm`} (실제 ${V.length}개 중 ${oos}개 규격 밖).`;
    if (gap) t += ` 그러나 전체 산포로 계산한 Ppk ${fm(ppk, 2)}(${lvP[0]}) — Cpk보다 낮아, 시간에 따라 평균·산포가 바뀌어 실제 성능이 단기 능력보다 나쁩니다.`;
    if (two && c.cp - c.cpk >= 0.2) t += ` 산포보다 중심 치우침이 문제입니다 — 평균이 규격 중앙보다 ${sgn(c.mean - (usl + lsl) / 2)} ${u} ${c.mean > (usl + lsl) / 2 ? 'USL' : 'LSL'} 쪽. 중심만 맞춰도 Cpk가 Cp(${fm(c.cp, 2)})까지 오릅니다.`;
    else if (two && c.cp < 1.33) t += ' 중심은 맞지만 산포 자체가 공차에 비해 큽니다.';
    if ((usl != null && c.ucl > usl) || (lsl != null && c.lcl < lsl)) t += ' 관리 한계가 규격 밖까지 걸쳐 있어, 관리 상태여도 불량이 나올 수 있습니다.';
    if (uniq.size) t += ' (관리 상태가 아니므로 이 Cpk는 앞으로의 성능을 대표하지 못합니다.)';
    items.push({ k: '공정능력', tone: lv[1], t });
    if (two && c.cp - c.cpk >= 0.2) acts.push(`중심 조정: 목표값 대비 ${sgn(-(c.mean - (usl + lsl) / 2))} ${u} 보정(오프셋)으로 Cpk 개선`);
    if (c.cpk < 1.33 && !(two && c.cp - c.cpk >= 0.2)) acts.push(uniq.size ? '특별 원인을 먼저 없앤 뒤 공정능력을 다시 평가' : '안정하지만 능력 부족 — 설비·조건 개선으로 변동 자체를 줄이거나 규격 타당성 검토');
  } else if (lsl != null || usl != null) {   // 능력 지수를 못 구해도(산포 0 등) 실제 규격 이탈은 그대로 판정한다
    const flat = !(c.sigma > 0);
    items.push({ k: '공정능력', tone: oos ? 'bad' : 'warn', t: `${flat ? '값의 산포가 0이라' : '규격이 한쪽뿐이거나 산포를 구할 수 없어'} Cpk를 계산할 수 없습니다 — 능력이 충분하다고 판단할 근거가 없습니다. 실제 ${V.length}개 중 ${oos}개 규격 밖${oos ? '입니다' : ''}.` });
    if (flat) acts.push('측정값이 모두 같음 — 측정기·데이터 수집(고정값·포화·통신 끊김)부터 확인');
    if (oos) acts.push('규격 밖 제품 격리(🔎 품질 추적) 후 원인 조사 · 중심 보정');
  }
  if (moved) acts.push('평균 이동·추세: 신호가 시작된 시점 전후의 공구 교체·마모, 보정값, 자재 로트, 셋업·품목 전환 이력 확인');
  if (by(1).length && !moved) acts.push('돌발 점: 해당 제품 시리얼을 🔎 품질 추적 계보에서 확인(설비·작업자·자재)');
  if (spread) acts.push('산포 증가: 클램핑·지그 고정, 진동, 측정 반복성(게이지 R&R) 점검');
  if (lead && Math.abs(lead.r) >= 0.3) acts.push(`원인 후보: 상관이 가장 큰 공정 변수 「${lead.label}」(r = ${fm(lead.r, 2)}) — 옆 산점도로 확인`);
  if (oos && !acts.some((a) => a.startsWith('규격 밖'))) acts.unshift(`규격 밖 ${oos}개 — 해당 제품 격리·재검사(🔎 품질 추적)`);
  if (!acts.length) acts.push('현 조건 유지 — 관리도를 계속 감시하고, 신호가 나오면 그 시점부터 원인 조사');
  const tone = worst(items.map((i) => i.tone));
  const head = uniq.size ? `특별 원인 신호 ${uniq.size}점 — 조사 필요` : oos ? `규격 밖 ${oos}개 / ${V.length}개 — 조치 필요` : tone === 'good' ? '안정 · 능력 충분' : moved ? '관리 한계 안이지만 평균이 움직이는 중' : '관리 상태이지만 개선 여지';
  return { tone, head, items, acts };
}

export function interpretScatter(units, xk, yk, xl = {}, spec = {}) {
  const P = units.filter((v) => Number.isFinite(v.x[xk]) && Number.isFinite(v.y[yk])), n = P.length;
  const xs = P.map((v) => v.x[xk]), ys = P.map((v) => v.y[yk]), p = pearson(xs, ys), xu = xl.unit ?? '', yu = spec.unit ?? '', XN = xl.label ?? xk, YN = spec.label ?? yk;
  if (p.r == null) return n >= 3 ? { tone: 'warn', head: '변동이 없어 상관을 계산할 수 없음', items: [{ k: '데이터', tone: 'warn', t: `${XN} 또는 ${YN} 값이 모두 같습니다.` }], acts: [] } : null;
  const a = Math.abs(p.r), r2 = p.r * p.r, t = (p.r * Math.sqrt(n - 2)) / Math.sqrt(Math.max(1e-12, 1 - r2)), sig = Math.abs(t) >= 2;
  const lv = a >= 0.7 ? '강한' : a >= 0.5 ? '뚜렷한' : a >= 0.3 ? '중간 정도의' : a >= 0.1 ? '약한' : '거의 없는';
  const items = [], acts = [];
  items.push({ k: '관계', tone: a >= 0.5 && sig ? 'bad' : a >= 0.3 && sig ? 'warn' : 'good', t: a < 0.1 ? `상관이 거의 없습니다(r = ${fm(p.r, 3)}) — ${josa(XN, '은', '는')} ${YN}의 변동을 설명하지 못합니다.` : `${lv} ${p.r > 0 ? '양(+)' : '음(−)'}의 상관(r = ${fm(p.r, 3)}) — ${josa(XN, '이', '가')} 클수록 ${josa(YN, '이', '가')} ${p.r > 0 ? '커집니다' : '작아집니다'}. ${YN} 변동의 ${Math.round(r2 * 100)}%를 ${josa(XN, '이', '가')} 설명합니다(R²).` });
  items.push({ k: '신뢰도', tone: sig ? 'good' : 'warn', t: sig ? `통계적으로 유의합니다(t = ${fm(t, 2)}, n = ${n}) — 우연으로 보기 어렵습니다.${n < 20 ? ' 다만 표본이 20개 미만이라 더 모아 확인하세요.' : ''}` : `유의하지 않습니다(t = ${fm(t, 2)}, n = ${n}) — 우연일 수 있으니 표본을 더 모은 뒤 판단하세요.` });
  const xmin = Math.min(...xs), xmax = Math.max(...xs), dy = p.b * (xmax - xmin), lsl = spec.lsl ?? null, usl = spec.usl ?? null, tol = lsl != null && usl != null ? usl - lsl : null;
  items.push({ k: '영향 크기', tone: tol && Math.abs(dy) / tol >= 0.25 && sig ? 'warn' : 'good', t: `${XN} 1${xu ? ` ${xu}` : ' 단위'} 증가마다 ${YN} ${sgn(p.b)} ${yu}. 관측 범위(${fm(xmin)} ~ ${fm(xmax)}${xu ? ` ${xu}` : ''})에서 ${josa(YN, '이', '가')} 약 ${sgn(dy)} ${yu} 달라지며${tol ? `, 이는 공차(${fm(tol)} ${yu})의 ${Math.round((Math.abs(dy) / tol) * 100)}%입니다` : ''}.` });
  // 규격 도달 지점 (회귀선 기준)
  if (sig && a >= 0.3 && p.b) {
    const span = xmax - xmin || 1, now = xs.at(-1), hits = [[usl, 'USL'], [lsl, 'LSL']].filter(([L]) => L != null).map(([L, nm]) => ({ nm, x: (L - p.a) / p.b })).filter((h) => h.x >= xmin - span && h.x <= xmax + span && (p.b > 0 ? h.nm === 'USL' : h.nm === 'LSL'));
    for (const h of hits) {
      const yNow = p.a + p.b * now, over = h.nm === 'USL' ? yNow >= usl : yNow <= lsl, left = Math.abs(h.x - now);   // 회귀선 예측값을 한계와 직접 비교 (기울기 부호와 무관)
      items.push({ k: '한계 도달', tone: over ? 'bad' : 'warn', t: `회귀선상 ${XN} ≈ ${fm(h.x)}${xu ? ` ${xu}` : ''}에서 ${josa(YN, '이', '가')} ${h.nm}(${fm(h.nm === 'USL' ? usl : lsl)} ${yu})에 닿습니다. 최근 표본의 ${josa(XN, '은', '는')} ${fm(now)}${over ? ` — 회귀선 예측 ${fm(yNow)} ${yu}로 이미 넘었습니다` : ` — ${fm(left)} 남았습니다`}.` });
      acts.push(`「${XN}」 관리 기준: ${fm(h.x)}${xu ? ` ${xu}` : ''} 전에 교체·보정하도록 기준값으로 검토 (여유를 두려면 더 앞당김)`);
    }
  }
  // 양품 · NG 비교
  const ng = P.filter((v) => v.ng), ok = P.filter((v) => !v.ng);
  if (ng.length >= 2 && ok.length >= 2) {
    const m = (L) => L.reduce((s, v) => s + v.x[xk], 0) / L.length, sd = Math.sqrt(ok.reduce((s, v) => s + (v.x[xk] - m(ok)) ** 2, 0) / Math.max(1, ok.length - 1)) || 1;
    const S = [...P].sort((A, B) => A.x[xk] - B.x[xk]), q = Math.max(2, Math.floor(n / 4)), rate = (L) => L.filter((v) => v.ng).length / L.length, lo = rate(S.slice(0, q)), hi = rate(S.slice(-q)), dz = (m(ng) - m(ok)) / sd;
    items.push({ k: 'NG', tone: Math.abs(dz) >= 1 ? 'warn' : 'good', t: `NG ${ng.length}개의 ${XN} 평균 ${fm(m(ng))} vs 양품 ${fm(m(ok))}(${sgn(dz, 1)}σ). ${XN} 하위 25%의 NG 비율 ${Math.round(lo * 100)}% · 상위 25% ${Math.round(hi * 100)}%${Math.abs(hi - lo) >= 0.15 ? ` — ${hi > lo ? '높은' : '낮은'} 쪽에서 NG가 몰립니다` : ' — 뚜렷한 차이 없음'}.` });
  } else if (ng.length) items.push({ k: 'NG', tone: 'good', t: `NG ${ng.length}개 — 양품과 비교하기에 아직 적습니다.` });
  // 이상점
  const res = P.map((v, i) => ys[i] - (p.a + p.b * xs[i])), se = Math.sqrt(res.reduce((s, e) => s + e * e, 0) / Math.max(1, n - 2)), out = res.filter((e) => se > 0 && Math.abs(e) > 3 * se).length;
  if (out) items.push({ k: '이상점', tone: 'warn', t: `회귀선에서 3σ 넘게 벗어난 점 ${out}개 — ${XN} 말고 다른 원인이 겹친 제품일 수 있습니다(점에 마우스를 올려 시리얼 확인).` });
  if (a >= 0.3 && sig) acts.push('상관은 원인을 증명하지 않음 — 조건을 바꿔 보는 실험이나 🔎 품질 추적 계보·8D로 인과 확인');
  else acts.push('이 변수로는 설명이 부족함 — 아래 상관표에서 |r|이 더 큰 변수를 눌러 확인');
  const tone = worst(items.map((i) => i.tone));
  return { tone, head: a >= 0.5 && sig ? `${XN} → ${YN} 영향 큼 (R² ${Math.round(r2 * 100)}%)` : a >= 0.3 && sig ? `${josa(XN, '이', '가')} ${YN}에 일부 영향` : `${josa(XN, '과', '와')} ${YN}의 관계 약함`, items, acts };
}
