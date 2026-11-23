// 제품 추적 관리 (Product Traceability) · 공장 환경 · 불량 원인 분석(RCA) 데이터
// ① 제품 ID (2단 · js/serial.js): 투입 순간 WIP ID(WIP-DT-YYMMDD-000123)를 붙이고 셀을 지날 때마다 계보(genealogy) 단계를 남긴다 →
//    검사·포장셀 최종 검사 합격 때 제품 시리얼(DT-YYMMDD-000045)·GS1 EPC URN(SGTIN)을 발행해 QR 라벨(GS1 Digital Link)로 붙인다
//    단계 = 셀 · 셀 로봇 ID · (레거시) 작업자 · 운반 AMR · 설비 건강도·드리프트·Cpk · VLA 모델 · 공정 측정값 · 그 자리 환경값 — ISA-95 Equipment/Personnel/Material Actual 용어
// ② 공장 환경: 정밀조립Zone 환경 센서 4대(온도·습도·바닥 진동·미세먼지·소음·조도) — 하루 변동 + 임의 보행 + 가끔 공조·진동·분진 이상(excursion)
//    환경 이상은 그 환경에 민감한 공정의 불량 확률을 올린다 (도어트림 조립 = 습도 · e-axle 조립 = 온도 · 부품분류 = 분진·조도) — 평소에는 영향 없음
// ③ 불량 판정(체결셀 토크·각도 전수 검사 NG) → 불량 사례: 계보 + 앞뒤 환경 + 설비·로봇·AMR 상태 + 같은 셀 경유 의심 제품(봉쇄 범위) + AI 원인 분석 순위
// ④ 내려받기: 사례 하나 / 전체 — EPCIS 2.0 JSON-LD 이벤트 · ISA-95 계보 JSON · 학습용 특징 표(CSV, 제품 1행) · 환경 시계열(CSV) · 인과 그래프 · 8D 기록 · LLM 분석 프롬프트
// 시뮬레이션 난수(sim.rand)를 쓰지 않는다 — 환경·측정값은 별도 난수라 기존 생산 흐름이 그대로다. 헤드리스에서도 같은 흐름으로 동작한다.

import { serialsCSV } from './serial.js';
import { serialEpcis } from './epcis.js';

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gaussOf = (r) => () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const r2 = (v, d = 2) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ── 공장 환경 ─────────────────
export const ENV_SPEC = {
  temp: { label: '온도', unit: '°C', lo: 20, hi: 27 },
  rh: { label: '상대습도', unit: '%RH', lo: 35, hi: 58 },
  vib: { label: '바닥 진동', unit: 'mm/s', hi: 2.8 },
  pm: { label: '미세먼지 PM2.5', unit: 'µg/m³', hi: 35 },
  noise: { label: '소음', unit: 'dB(A)', hi: 85 },
  lux: { label: '조도', unit: 'lx', lo: 500 },
};
export const ENV_KEYS = Object.keys(ENV_SPEC);
// 정밀조립Zone 환경 센서 (월드 좌표) — 셀 위치(line.js ZONE_CELLS)와 같은 줄
export const ENV_NODES = [
  { id: 'ENV-01', name: '투입·부품분류 (서쪽)', x: -22, z: 0, base: { temp: -0.6, rh: 1.5 } },
  { id: 'ENV-02', name: '도어트림 라인', x: -2, z: 4.6, base: { temp: 0.2, rh: 0.5 } },
  { id: 'ENV-03', name: 'e-axle 라인', x: -2, z: -4.6, base: { temp: 0.5, rh: -0.5 } },
  { id: 'ENV-04', name: '포장·적재 (동쪽)', x: 18, z: 0, base: { temp: -0.2, rh: 1.0 } },
];
// 환경 이상: 공조(HVAC) 이상 → 습도·온도 상승 · 인근 중량물 작업 → 바닥 진동 · 분진 유입 → 미세먼지
const EXCURSIONS = [
  { kind: 'hvac_rh', label: '공조 제습 이상 — 습도 상승', d: { rh: 15, temp: 0.8 } },
  { kind: 'hvac_temp', label: '공조 냉방 이상 — 온도 상승', d: { temp: 5.2, rh: -3 } },
  { kind: 'vib', label: '인근 중량물 작업 — 바닥 진동', d: { vib: 2.6, noise: 7 } },
  { kind: 'dust', label: '출입문 개방 — 분진 유입·조도 저하', d: { pm: 34, lux: -260 } },
];
// 공정별 환경 민감도 (그 공정의 불량 확률 배율에 들어간다): 기준을 넘은 만큼만
// 도어트림 조립 = 클립·접착 체결이 습도에 민감 · e-axle 조립 = 베어링 압입 억지끼워맞춤이 온도(열팽창)에 민감 · 부품분류 = 비전 인식이 분진·조도에 민감 · 체결 = 진동
export const ENV_SENS = {
  DT_ASSY: { rh: { thr: 57, scale: 3.5 }, vib: { thr: 2.6, scale: 1.2 } },
  EA_ASSY: { temp: { thr: 26.5, scale: 1.4 }, vib: { thr: 2.6, scale: 1.2 } },
  SORT: { pm: { thr: 32, scale: 9 }, lux: { thr: 560, scale: -120 } },
  assembly: { rh: { thr: 57, scale: 3.5 } }, press: { vib: { thr: 2.6, scale: 1 } }, sort: { pm: { thr: 32, scale: 9 } },
};
const sensOf = (st) => ENV_SENS[st.id] ?? ENV_SENS[st.type] ?? {};
// 환경 요인별 불량 배율 기여 (기준 아래면 0)
export function envExcess(st, env) {
  const out = {};
  for (const [k, s] of Object.entries(sensOf(st))) { const v = env?.[k]; if (v == null) continue; const x = (v - s.thr) / s.scale; if (x > 0) out[k] = Math.min(4, x); }
  return out;
}

export class FactoryEnv {
  constructor(sim, seed) {
    this.sim = sim; this.r = mulberry((seed * 2654435761 + 99) >>> 0); this.g = gaussOf(this.r);
    this.walk = ENV_NODES.map(() => ({ temp: 0, rh: 0, vib: 0, pm: 0, noise: 0, lux: 0 }));
    this.now = ENV_NODES.map(() => ({}));
    this.acc = 0; this.sampleAcc = 0; this.series = []; this.exc = null; this.excLog = [];
    this.nextExc = 1500 + this.r() * 2400;   // 첫 이상은 25 ~ 65분 뒤
    this.tick(0);
  }
  // 지금 이상(excursion) 세기 0~1 (오르는 2분 · 유지 · 내리는 3분)
  excLevel(t) {
    const e = this.exc; if (!e) return 0;
    const a = t - e.t0, b = e.t1 - t; if (a < 0 || b < -180) return 0;
    return Math.max(0, Math.min(1, a / 120, b >= 0 ? 1 : 1 + b / 180));
  }
  update(dt) {
    this.acc += dt; if (this.acc < 1 - 1e-9) return;   // 0.1초 × 10 = 0.9999… (여유 없이 비교하면 1.1초마다)
    const step = this.acc; this.acc = 0; this.tick(step);
    this.sampleAcc += step;
    if (this.sampleAcc >= 10) { this.sampleAcc = 0; this.series.push({ t: this.sim.time, nodes: this.now.map((v) => ({ ...v })) }); if (this.series.length > 2160) this.series.shift(); }   // 10초 · 6시간
  }
  tick(step) {
    const s = this.sim, t = s.time;
    // 환경 이상 발생·종료
    if (!this.exc && t >= this.nextExc) {
      const E = EXCURSIONS[Math.floor(this.r() * EXCURSIONS.length)], node = Math.floor(this.r() * ENV_NODES.length), dur = 480 + this.r() * 540;
      this.exc = { ...E, node, t0: t, t1: t + dur, id: `EXC-${String(this.excLog.length + 1).padStart(3, '0')}` };
      this.excLog.unshift(this.exc); if (this.excLog.length > 40) this.excLog.pop();
      if (!s.quiet) s.log?.('warn', `공장 환경 이상 — ${E.label}`, { obs: `${ENV_NODES[node].id} ${ENV_NODES[node].name} 부근 · 약 ${Math.round(dur / 60)}분`, act: '환경 데이터 제품 계보에 기록 (불량 원인 분석에 반영)' });
    }
    if (this.exc && t > this.exc.t1 + 180) { this.exc.ended = t; this.exc = null; this.nextExc = t + 2400 + this.r() * 3000; }
    const lvl = this.excLevel(t);
    const busy = (x, z, R) => s.processing.filter((st) => st.state === 'BUSY' && Math.hypot(st.x - x, st.z - z) < R).length;
    const amrNear = (x, z) => (s.carriers ?? []).filter((c) => c.moving && Math.hypot(c.x - x, c.z - z) < 5).length;
    ENV_NODES.forEach((n, i) => {
      const w = this.walk[i], k = Math.min(1, step / 300);
      // 평균 회귀 임의 보행 (시정수 5분)
      for (const [key, sd] of [['temp', 0.35], ['rh', 1.4], ['vib', 0.12], ['pm', 2.2], ['noise', 1.0], ['lux', 18]]) w[key] += -w[key] * k + sd * Math.sqrt(k * 2) * this.g();
      const day = Math.sin((2 * Math.PI * (t + 1800)) / 5400), slow = Math.sin((2 * Math.PI * t) / 7200 + 1);   // 90분 · 2시간 주기 (공조 사이클)
      const near = this.exc && this.exc.node === i ? 1 : this.exc ? 0.45 : 0, d = this.exc?.d ?? {}, ex = (key) => (d[key] ?? 0) * lvl * near;
      const temp = 23.4 + (n.base.temp ?? 0) + 0.9 * day + w.temp + ex('temp');
      const v = {
        temp, rh: 47 + (n.base.rh ?? 0) + 4 * slow - 1.2 * (temp - 23.4) + w.rh + ex('rh'),
        vib: Math.max(0.15, 0.55 + 0.18 * busy(n.x, n.z, 7) + 0.22 * amrNear(n.x, n.z) + w.vib + ex('vib')),
        pm: Math.max(2, 11 + w.pm + ex('pm')), noise: 66 + 1.4 * busy(n.x, n.z, 9) + w.noise + ex('noise'), lux: 760 + w.lux + ex('lux'),
      };
      for (const key of ENV_KEYS) this.now[i][key] = r2(v[key], key === 'vib' ? 2 : 1);
    });
  }
  nodeAt(x, z) { let b = 0, bd = Infinity; ENV_NODES.forEach((n, i) => { const d = Math.hypot(n.x - x, n.z - z); if (d < bd) { bd = d; b = i; } }); return b; }
  at(x, z) { const i = this.nodeAt(x, z); return { node: ENV_NODES[i].id, ...this.now[i] }; }
  // 정밀조립Zone 평균 (전광판·요약)
  avg() { const o = {}; for (const k of ENV_KEYS) o[k] = r2(this.now.reduce((a, v) => a + v[k], 0) / this.now.length, 1); return o; }
  window(t0, t1) { return this.series.filter((x) => x.t >= t0 && x.t <= t1); }
}

// ── 공정 측정값 (셀 종류별 — 체결셀은 판정 규격과 함께) ─────────────────
export const PARAM_SPEC = {
  sort: { visionScore: { label: '부품 인식 점수', unit: '', lsl: 0.9 }, pickForce: { label: '피킹 파지력', unit: 'N', lsl: 8, usl: 22 } },
  assembly: { pressForce: { label: '압입·안착 하중', unit: 'kN', lsl: 2.2, usl: 3.4 }, seatDepth: { label: '안착 깊이', unit: 'mm', lsl: 11.6, usl: 12.4 } },
  screw: { torque: { label: '체결 토크', unit: 'N·m', lsl: 4.0, usl: 5.0 }, angle: { label: '체결 각도', unit: '°', lsl: 20, usl: 40 } },
  fasten: { torque: { label: '체결 토크', unit: 'N·m', lsl: 78, usl: 92 }, angle: { label: '체결 각도', unit: '°', lsl: 30, usl: 60 } },
  pack: { labelGrade: { label: 'QR 판독 등급 (A4~F0)', unit: '', lsl: 2 } },   // ISO/IEC 15415 — C(2) 이상 합격
};
const NOMINAL = { visionScore: 0.97, pickForce: 15, pressForce: 2.8, seatDepth: 12.0, torque: null, angle: null, labelGrade: 4 };

export const productCode = (p) => ({ doortrim: 'DT', eaxle: 'EA' })[p] ?? 'WP';
const GS1_PREFIX = '8800000';   // 가상 GS1 업체코드 (880 = 대한민국) — 시뮬레이션용

// ── 제품 추적 ─────────────────
export class ProductTrace {
  constructor(sim, seed = 1) {
    this.sim = sim; this.r = mulberry((seed * 40503 + 7) >>> 0); this.g = gaussOf(this.r);
    this.env = new FactoryEnv(sim, seed);
    const d = new Date(); this.ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    this.seq = {}; this.byId = new Map(); this.recent = []; this.cases = []; this.caseSeq = 0;
    this.stats = { released: 0, ok: 0, ng: 0, escaped: 0, cases: 0, top1: 0, top3: 0 };
    this.rawLot = 1; this.rawLotN = 0;
    sim.trace = this;
  }
  update(dt) { this.env.update(dt); }
  // 불량 확률 환경 배율 (sim.completeCycle) — 기준 넘은 환경 요인 합 · 정책(환경 인터록 공정 보상) 반영
  envMul(st) {
    const ex = envExcess(st, this.env.at(st.x, st.z)), comp = this.sim.qpolicy?.envComp ?? {};
    let m = 1; for (const [k, x] of Object.entries(ex)) m += x * (comp[k] ? 0.15 : 1);
    return m;
  }
  // 사이클 배율: 환경 인터록 정책이 걸린 공정은 기준을 넘는 동안 공정 시간을 늘려 보상한다 (경화·안정화 대기)
  cycleFactor(st) {
    const comp = this.sim.qpolicy?.envComp; if (!comp) return 1;
    const ex = envExcess(st, this.env.at(st.x, st.z));
    return Object.keys(ex).some((k) => comp[k]) ? 1.12 : 1;
  }
  serialOf(product) {
    const c = productCode(product), n = (this.seq[c] = (this.seq[c] ?? 0) + 1);
    return { serial: `${c}-${this.ymd}-${String(n).padStart(6, '0')}`, epc: `urn:epc:id:sgtin:${GS1_PREFIX}.${c === 'DT' ? '100001' : c === 'EA' ? '100002' : '100009'}.${n}` };
  }
  rec(item) { const k = item?.wip ?? item?.serial; return k ? this.byId.get(k) ?? null : null; }
  // 투입: WIP ID 부여 (시리얼 서비스가 없으면 — 기본 라인 — 예전처럼 투입 때 시리얼) · 원자재 로트(투입 40개마다 새 로트)
  release(item, car) {
    if (++this.rawLotN > 40) { this.rawLot++; this.rawLotN = 1; }
    const s = this.sim, H = s.serials, id = H ? { wip: H.wipId(item.product), serial: null, epc: null } : { wip: null, ...this.serialOf(item.product) };
    if (H) item.wip = id.wip; else item.serial = id.serial;
    const r = { ...id, item: item.id, product: item.product, t0: s.time, tEnd: null, status: 'wip', amr: car?.uid ?? null, lot: `RM-${this.ymd}-${String(this.rawLot).padStart(3, '0')}`, mode: s.mode.key, steps: [], inspection: null, truth: null };
    H?.adopt(r, 'main');
    this.byId.set(id.wip ?? id.serial, r); this.recent.push(r); this.stats.released++;
    s.fos?.orderFor(r);   // 공장 오케스트레이터 오더 (불량 보충 투입은 같은 오더)
    if (this.recent.length > 3000) { const old = this.recent.shift(); if (!this.cases.some((c) => c.wip === old.wip && c.serial === (old.serial ?? old.wip))) { this.byId.delete(old.wip); if (old.serial) this.byId.delete(old.serial); } }
    return r;
  }
  // 셀 투입 (sim.updateStation) — 그 순간 설비·로봇·AMR·환경
  enter(st, item) {
    const r = this.rec(item); if (!r || item.scrap) return;
    const s = this.sim, car = item.carrier, a = s.assess(st), env = this.env.at(st.x, st.z);
    const op = s.mode.key === 'traditional' ? s.workers.filter((w) => w.station === st).map((w) => w.id) : [];
    r.steps.push({
      st: st.uid ?? st.id, id: st.id, name: st.name, type: st.type, tIn: s.time, tOut: null, cycle: null,
      robots: st.def.robot?.kind && st.def.robot.kind !== 'none' && s.mode.key !== 'traditional' ? [...(st.robotUids ?? [])] : [], robotKind: s.mode.key === 'traditional' ? 'human' : st.def.robot?.kind ?? 'none',
      operators: op, vla: st.vlaCell && st.robotUids?.length ? s.vla?.versionOf(st.robotUids[0]) : null, aios: s.aios?.on ? s.aios.version : null,
      health: r2(st.health, 1), drift: r2(st.drift, 3), cpk: r2(a.cpk, 2), amr: car?.uid ?? null, amrBattery: car ? r2(car.battery, 0) : null, env, envMul: r2(this.envMul(st), 3),
      params: {}, defect: false, risk: null, sensors: s.sensors?.cellSnapshot(st.id) ?? null,   // 그 셀 센서의 지금 값 (센서망 js/sensors.js — 같은 기준 시계)
    });
  }
  // 셀 작업 끝 (sim.completeCycle) — 공정 측정값 · 이 셀에서 생긴 불량(시뮬레이션 정답 라벨, 화면·AI에는 숨김) · 이 셀 불량 확률(모델)
  done(st, item, made, risk) {
    const r = this.rec(item); if (!r) return; const p = r.steps.findLast((x) => x.id === st.id && x.tOut == null); if (!p) return;
    p.tOut = this.sim.time; p.cycle = r2(p.tOut - p.tIn, 1); p.defect = !!made; p.risk = risk;
    const spec = PARAM_SPEC[st.type] ?? {}, g = this.g, sev = 1 + (st.drift ?? 0) * 2 + (100 - st.health) / 60;
    for (const [k, S] of Object.entries(spec)) {
      const nom = NOMINAL[k] ?? ((S.lsl ?? 0) + (S.usl ?? 0)) / 2, span = ((S.usl ?? nom * 1.1) - (S.lsl ?? nom * 0.9)) || 1;
      let v = nom + g() * span * 0.08 * sev;
      if (made && k === 'pressForce') v = S.lsl - span * (0.05 + this.r() * 0.2);   // 이 셀에서 불량: 안착 하중 미달
      if (made && k === 'seatDepth') v = S.usl + span * (0.03 + this.r() * 0.15);
      if (made && k === 'visionScore') v = 0.78 + this.r() * 0.1;   // 분류 오인식
      if (k === 'visionScore') v = Math.min(0.999, v);
      p.params[k] = r2(v, k === 'visionScore' ? 3 : 2);
    }
    if (st.type === 'pack' && r.mark) p.params.labelGrade = { A: 4, B: 3, C: 2, D: 1, F: 0 }[r.mark.grade];   // 실제 판독 검증 등급 (js/serial.js)
  }
  // 체결셀 토크·각도 전수 판정 (sim.completeCycle inspect) — result: OK · NG (잡힌 불량) · MISS (못 잡은 불량 — 결과는 OK로 보이고 정답 라벨만 남음)
  inspect(st, item, result) {
    const r = this.rec(item); if (!r) return null; const p = r.steps.findLast((x) => x.id === st.id && x.tOut == null);
    const spec = PARAM_SPEC[st.type] ?? PARAM_SPEC.fasten, T = spec.torque, A = spec.angle, g = this.g;
    const origin = r.steps.find((x) => x.defect)?.id ?? null;   // 정답: 불량이 생긴 셀
    let torque = (T.lsl + T.usl) / 2 + g() * (T.usl - T.lsl) * 0.1, angle = (A.lsl + A.usl) / 2 + g() * (A.usl - A.lsl) * 0.1, mode = null;
    if (result === 'NG') {
      if (origin === 'SORT' || /sort/i.test(origin ?? '')) { angle = A.usl + (A.usl - A.lsl) * (0.08 + this.r() * 0.3); mode = '체결 각도 상한 초과 — 나사산 불일치(부품 오삽입 의심)'; }
      else { torque = T.lsl - (T.usl - T.lsl) * (0.06 + this.r() * 0.3); mode = '체결 토크 하한 미달 — 안착 불량(조립 위치 편차 의심)'; }
    }
    const ins = { st: st.uid ?? st.id, name: st.name, t: this.sim.time, result: result === 'NG' ? 'NG' : 'OK', torque: r2(torque, 2), angle: r2(angle, 1), spec: { torque: [T.lsl, T.usl], angle: [A.lsl, A.usl] }, mode };
    r.inspection = ins; r.truth = origin;
    if (p) { p.tOut = this.sim.time; p.cycle = r2(p.tOut - p.tIn, 1); p.params = { torque: ins.torque, angle: ins.angle }; p.result = ins.result; }
    if (result === 'NG') { r.status = 'ng'; r.tEnd = this.sim.time; r.loc = 'quarantine'; this.stats.ng++; return this.openCase(r, st); }   // 시리얼 없이 WIP ID로 배출함 격리
    return null;
  }
  // 적재장 도착 (출하 대기) — 못 잡은 불량은 유출
  finish(item) {
    const r = this.rec(item); if (!r || r.status !== 'wip') return;
    r.tEnd = this.sim.time; if (item.defect) { r.status = 'escaped'; this.stats.escaped++; } else { r.status = 'ok'; this.stats.ok++; }
    this.sim.serials?.toFG(r);   // 구분 적재장 = 출하 대기 재고 (시리얼 단위)
  }

  // ── 불량 사례 ─────────────────
  // 출하 전 샘플 재검 NG (검사·포장셀 최종 검사대 — js/serial.js judge) — 계보로 원인 분석 · 8D (AI 적중 통계에서는 뺀다: 체결 전수 검사 사례와 따로 센다)
  openSampleCase(r, it) {
    r.inspection2 = { by: '검사·포장셀 샘플 재검', sample: it.id, result: 'NG', t: this.sim.time };
    return this.openCase(r, { uid: 'PACK-SAMPLE', id: 'QIS', name: `샘플 재검 ${it.id}` }, 'sample');
  }
  openCase(r, st, kind = 'inline') {
    const s = this.sim, id = `NG-${this.ymd}-${String(++this.caseSeq).padStart(4, '0')}`;
    const t0 = r.t0 - 120, t1 = s.time + 60;
    const c = {
      id, kind, serial: r.serial ?? r.wip, wip: r.wip ?? null, product: r.product, order: r.order ?? null, t: s.time, detectedAt: st.uid ?? st.id, detectedName: st.name, mode: s.mode.key, inspection: kind === 'sample' ? { ...r.inspection, result: 'NG', mode: '출하 전 샘플 재검 NG (검사·포장셀 최종 검사대)', sample: r.inspection2 } : r.inspection,
      equipment: s.processing.map((x) => ({ st: x.uid ?? x.id, id: x.id, name: x.name, state: x.state, health: r2(x.health, 1), drift: r2(x.drift, 3), cpk: r2(s.assess(x).cpk, 2), processed: x.c.processed, defects: x.c.defects, fails: x.c.fails })),
      envWindow: { t0, t1 }, excursions: this.env.excLog.filter((e) => e.t0 <= t1 && (e.ended ?? s.time) >= t0).map((e) => ({ id: e.id, kind: e.kind, label: e.label, node: ENV_NODES[e.node].id, t0: e.t0, t1: e.t1 })),
      suspects: this.suspects(r), rca: null, capa: null,
    };
    c.rca = analyze(this, r);
    const top = c.rca.causes[0];
    if (kind === 'inline') { this.stats.cases++; if (top?.station === r.truth) this.stats.top1++; if (c.rca.causes.slice(0, 3).some((x) => x.station === r.truth)) this.stats.top3++; } else this.stats.sampleNg = (this.stats.sampleNg ?? 0) + 1;
    this.cases.unshift(c); if (this.cases.length > 200) this.cases.pop();
    if (kind === 'inline') this.sim.fac?.qual?.('q.ng', { key: c.id, serial: c.serial, product: c.product, station: c.detectedName, mode: c.inspection?.mode ?? '', torque: c.inspection?.torque ?? null, angle: c.inspection?.angle ?? null });   // 체결 전수 검사 NG → (앱) ERPNext 부적합
    s.capa?.onDefect(c, r);
    return c;
  }
  // 봉쇄 범위: 원인 후보 셀을 같은 시간대(앞뒤 10분)에 지난 다른 제품 — 출하 보류·재검 대상
  suspects(r) {
    const ids = new Set(r.steps.filter((p) => p.result == null && p.type !== 'pack').map((p) => p.id)), t = r.t0;
    return this.recent.filter((x) => x !== r && Math.abs(x.t0 - t) < 600 && x.steps.some((p) => ids.has(p.id))).slice(-30).map((x) => ({ serial: x.serial ?? x.wip, status: x.status, via: x.steps.filter((p) => ids.has(p.id)).map((p) => p.st) }));
  }
  ngRate(t0, t1 = this.sim.time) { const xs = this.recent.filter((x) => x.tEnd != null && x.tEnd >= t0 && x.tEnd <= t1); return xs.length ? xs.filter((x) => x.status === 'ng' || x.status === 'escaped').length / xs.length : 0; }
}

// ── AI 원인 분석 (설명 가능한 베이즈 분해) ─────────────────
// 불량 하나: 그 제품이 지난 셀마다 "그 순간 그 셀의 불량 확률"(설비 건강도·공정 드리프트·환경 배율·VLA 모델)을 계보에서 다시 계산해
// 사후 확률(셀별 비중)을 구하고, 각 셀 비중을 요인(설비 열화 · 공정 드리프트 · 환경 요인별)의 로그 기여로 나눈다.
// 같은 셀을 지난 최근 제품의 불량률(모집단 근거) · 운반 AMR별 불량률 · 원자재 로트 불량률을 함께 비교한다. 검사 NG 모드(토크 미달·각도 초과)도 근거로 쓴다.
export const FACTOR = {
  health: { label: '설비 열화 (건강도 저하)', icon: '⚙' },
  drift: { label: '공정 드리프트 (재보정 필요)', icon: '◎' },
  base: { label: '공정 고유 산포', icon: '·' },
  temp: { label: '환경 — 온도', icon: '🌡' }, rh: { label: '환경 — 습도', icon: '💧' }, vib: { label: '환경 — 바닥 진동', icon: '〰' },
  pm: { label: '환경 — 미세먼지', icon: '🌫' }, lux: { label: '환경 — 조도', icon: '💡' }, noise: { label: '환경 — 소음', icon: '🔊' },
  amr: { label: '운반 AMR', icon: '🚚' }, lot: { label: '원자재 로트', icon: '📦' },
};
export function analyze(T, r) {
  const steps = r.steps.filter((p) => p.result == null && p.risk != null);
  const causes = [];
  const ngMode = r.inspection?.mode ?? '';
  // 사전 확률 = 그 순간 셀 불량 확률 × 검사 NG 모드 우도 (각도 초과 = 부품 오삽입 → 분류셀 · 토크 미달 = 안착 불량 → 조립셀) → 정규화한 사후 확률
  const like = (p) => (/각도/.test(ngMode) ? (p.type === 'sort' ? 3 : 0.5) : /토크/.test(ngMode) ? (p.type === 'assembly' || p.type === 'pressfit' ? 3 : 0.5) : 1);
  const tot = steps.reduce((a, p) => a + p.risk * like(p), 0) || 1;
  for (const p of steps) {
    const post = (p.risk * like(p)) / tot;
    const H = Math.log(1 + (100 - p.health) / 50), D = Math.log(1 + p.drift * 1.5), ex = envExcess({ id: p.id, type: p.type }, p.env);
    const parts = [['health', H], ['drift', D], ...Object.entries(ex).map(([k, x]) => [k, Math.log(1 + x)]), ['base', 0.25]];
    const sum = parts.reduce((a, [, v]) => a + v, 0) || 1;
    const pop = popRate(T, p.id, r.t0);
    for (const [k, v] of parts) {
      if (v / sum < 0.12 && k !== 'base') continue;
      const ev = [`${p.name} 통과 ${clockOf(p.tIn)} · 이 셀 불량 확률 ${(p.risk * 100).toFixed(2)}% (사후 비중 ${(post * 100).toFixed(0)}%)`];
      if (k === 'health') ev.push(`건강도 ${p.health}% (불량 배율 ×${(1 + (100 - p.health) / 50).toFixed(2)})`);
      if (k === 'drift') ev.push(`드리프트 ${(p.drift * 100).toFixed(1)}% · Cpk ${p.cpk}`);
      if (ENV_SPEC[k]) { const S = ENV_SPEC[k]; ev.push(`${p.env.node} ${S.label} ${p.env[k]}${S.unit} (관리 기준 ${S.hi != null ? `≤ ${S.hi}` : `≥ ${S.lo}`}${S.unit})`); }
      if (pop.n >= 5) ev.push(`최근 1시간 이 셀 경유 ${pop.n}개 중 불량 ${pop.ng}개 (${(pop.rate * 100).toFixed(1)}%)`);
      causes.push({ station: p.id, st: p.st, name: p.name, factor: k, label: `${p.name} · ${FACTOR[k].label}`, score: post * (v / sum), evidence: ev });
    }
  }
  // AMR · 원자재 로트: 같은 AMR·로트 제품의 불량률이 전체보다 뚜렷이 높으면 후보로
  const fleet = rateBy(T, (x) => true, r.t0), byAmr = r.amr ? rateBy(T, (x) => x.amr === r.amr, r.t0) : null, byLot = rateBy(T, (x) => x.lot === r.lot, r.t0);
  const z = (a, b) => (a && a.n >= 8 && b.n ? (a.rate - b.rate) / Math.sqrt(Math.max(1e-6, (b.rate * (1 - b.rate)) / a.n)) : 0);
  const zA = z(byAmr, fleet), zL = z(byLot, fleet);
  causes.push({ station: null, st: r.amr, name: r.amr ?? '-', factor: 'amr', label: `${r.amr ?? 'AMR 없음'} · 운반 AMR`, score: Math.max(0.005, Math.min(0.4, (zA - 1) * 0.08)), evidence: [byAmr ? `${r.amr} 운반 ${byAmr.n}개 중 불량 ${byAmr.ng}개 (${(byAmr.rate * 100).toFixed(1)}%) — 전체 ${(fleet.rate * 100).toFixed(1)}% · z ${zA.toFixed(2)}` : '컨베이어 운반 (AMR 없음)'] });
  causes.push({ station: null, st: r.lot, name: r.lot, factor: 'lot', label: `${r.lot} · 원자재 로트`, score: Math.max(0.004, Math.min(0.4, (zL - 1) * 0.08)), evidence: [`같은 로트 ${byLot.n}개 중 불량 ${byLot.ng}개 (${(byLot.rate * 100).toFixed(1)}%) — 전체 ${(fleet.rate * 100).toFixed(1)}% · z ${zL.toFixed(2)}`] });
  const S = causes.reduce((a, c) => a + c.score, 0) || 1;
  for (const c of causes) c.score = r2(c.score / S, 3);
  causes.sort((a, b) => b.score - a.score);
  const top = causes[0];
  // 셀 단위 합 (원인 셀 순위)
  const bySt = {}; for (const c of causes) if (c.station) bySt[c.station] = (bySt[c.station] ?? 0) + c.score;
  const stations = Object.entries(bySt).sort((a, b) => b[1] - a[1]).map(([id, v]) => ({ id, score: r2(v, 3) }));
  const why = top ? fiveWhy(r, top) : [];
  return { model: 'Bayes-genealogy RCA v1 (설명 가능 · 계보 기반 사후 확률 분해)', causes: causes.slice(0, 8), stations, top: top ? { station: top.station, factor: top.factor, label: top.label, score: top.score } : null, confidence: top ? r2(top.score / Math.max(1e-6, top.score + (causes[1]?.score ?? 0)), 2) : 0, why };
}
const clockOf = (t) => { const s = Math.floor(t) + 8 * 3600; return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function popRate(T, stId, t) { const xs = T.recent.filter((x) => x.tEnd != null && x.t0 > t - 3600 && x.t0 <= t + 60 && x.steps.some((p) => p.id === stId)); const ng = xs.filter((x) => x.status === 'ng' || x.status === 'escaped').length; return { n: xs.length, ng, rate: xs.length ? ng / xs.length : 0 }; }
function rateBy(T, f, t) { const xs = T.recent.filter((x) => x.tEnd != null && x.t0 > t - 3600 && f(x)); const ng = xs.filter((x) => x.status === 'ng' || x.status === 'escaped').length; return { n: xs.length, ng, rate: xs.length ? ng / xs.length : 0 }; }
function fiveWhy(r, top) {
  const ins = r.inspection, p = r.steps.find((x) => x.id === top.station);
  const w = [`왜 NG인가? — ${ins?.name ?? '검사'} ${ins?.mode ?? '판정 규격 이탈'} (토크 ${ins?.torque} N·m · 각도 ${ins?.angle}°)`];
  if (p) w.push(`왜 규격을 벗어났나? — ${p.name}에서 ${p.type === 'sort' ? '부품 오인식·오분류' : '안착·압입 불량'} 발생 추정 (계보 사후 비중 1위)`);
  if (top.factor === 'health') w.push(`왜 ${p?.name}에서? — 설비 건강도 ${p?.health}%로 열화 · 마모로 동작 정밀도 저하`, '왜 열화가 방치됐나? — 예지정비 착수 기준보다 건강도가 높아 정비 대기 중이었음', '근본 원인 — 예지정비 착수 기준(건강도)이 이 공정의 품질 민감도에 비해 낮음');
  else if (top.factor === 'drift') w.push(`왜 ${p?.name}에서? — 공정 드리프트 ${((p?.drift ?? 0) * 100).toFixed(1)}% · Cpk ${p?.cpk}`, '왜 드리프트가 남았나? — 재보정 시작 Cpk 기준보다 높아 보정 전이었음', '근본 원인 — 재보정 시작 Cpk 기준이 낮음 (SPC 관리 한계 조정 필요)');
  else if (ENV_SPEC[top.factor]) { const S = ENV_SPEC[top.factor]; w.push(`왜 ${p?.name}에서? — 작업 순간 ${S.label} ${p?.env?.[top.factor]}${S.unit} (관리 기준 이탈)`, `왜 환경이 벗어났나? — 공장 환경 이상(공조·진동·분진) 발생 구간`, `근본 원인 — 환경 이탈 시 공정 보상(인터록) 규칙이 없음`); }
  else if (top.factor === 'amr') w.push('왜 운반 중? — 같은 AMR 운반 제품 불량률이 높음', '근본 원인 — AMR 적재부·주행 충격 점검 주기 부족');
  else if (top.factor === 'lot') w.push('왜 이 로트? — 같은 원자재 로트 불량률이 높음', '근본 원인 — 수입검사 샘플링 부족');
  else if (top.factor === 'base') w.push(`왜 ${p?.name}에서? — 설비 건강도 ${p?.health}% · 드리프트 ${((p?.drift ?? 0) * 100).toFixed(1)}% · 환경 모두 정상 범위`, '근본 원인 — 설비 상태·환경으로 설명되지 않는 공정 고유 산포 (지그·그리퍼·작업 방법 개선 대상)');
  return w;
}

// ── 내려받기 (AI 원인 분석용 데이터) ─────────────────
const CBV = 'https://ref.gs1.org/cbv/';
const STEP_BIZ = { source: 'commissioning', sort: 'sorting', assembly: 'assembling', pressfit: 'assembling', screw: 'inspecting', fasten: 'inspecting', pack: 'packing' };
// EPCIS 2.0 JSON-LD 문서 (제품 계보 이벤트) — 투입(commissioning) · 셀 통과(ObjectEvent bizStep) · 검사(inspecting + disposition) · 센서값(sensorElementList)
export function epcisDoc(T, recs, iso) {
  const ev = [];
  const loc = (id) => `urn:epc:id:sgln:${GS1_PREFIX}.00001.${id}`;
  for (const r of recs) {
    // 2단 ID: 시리얼 발행 전 단계는 WIP ID(사내 URI), 발행 뒤는 SGTIN EPC — 발행 순간 commissioning(WIP ↔ 시리얼 연결)
    const wipUri = r.wip ? `urn:mf:wip:${r.wip}` : r.epc, idAt = (t) => (r.epc && (r.tSerial == null || t >= r.tSerial) ? r.epc : wipUri);
    ev.push({ type: 'ObjectEvent', eventTime: iso(r.t0), eventTimeZoneOffset: '+09:00', epcList: [wipUri], action: 'ADD', bizStep: `${CBV}BizStep-${r.wip ? 'creating_class_instance' : 'commissioning'}`, disposition: `${CBV}Disp-active`, readPoint: { id: loc('AS-01') },
      'mf:wip': r.wip ?? null, 'mf:product': r.product, 'mf:materialLot': r.lot, 'mf:carrier': r.amr });
    if (r.wip && r.epc) ev.push({ type: 'ObjectEvent', eventTime: iso(r.tSerial), eventTimeZoneOffset: '+09:00', epcList: [r.epc], action: 'ADD', bizStep: `${CBV}BizStep-commissioning`, disposition: `${CBV}Disp-active`, readPoint: { id: loc(r.mark?.at ?? 'PACK') },
      'mf:wip': r.wip, 'mf:serial': r.serial, 'mf:symbol': 'QR (GS1 Digital Link)', 'mf:verifyGrade': r.mark?.grade ?? null, 'mf:digitalLink': r.mark?.data ?? null });
    for (const p of r.steps) {
      const bs = STEP_BIZ[p.type] ?? 'assembling';
      const e = { type: 'ObjectEvent', eventTime: iso(p.tOut ?? p.tIn), eventTimeZoneOffset: '+09:00', epcList: [idAt(p.tOut ?? p.tIn)], action: 'OBSERVE', bizStep: `${CBV}BizStep-${bs}`,
        disposition: p.result === 'NG' ? `${CBV}Disp-non_conformant` : `${CBV}Disp-in_progress`, readPoint: { id: loc(p.st) }, bizLocation: { id: loc('ZONE-MAIN') },
        sensorElementList: [{ sensorMetadata: { time: iso(p.tIn), deviceID: `urn:epc:id:giai:${GS1_PREFIX}.${p.env.node}` }, sensorReport: [
          { type: 'gs1:Temperature', value: p.env.temp, uom: 'CEL' }, { type: 'gs1:AbsoluteHumidity', value: p.env.rh, uom: 'A93', 'mf:relativeHumidity': true },
          { type: 'gs1:Illuminance', value: p.env.lux, uom: 'LUX' }, { type: 'mf:Vibration', value: p.env.vib, uom: 'mm/s' }, { type: 'mf:PM25', value: p.env.pm, uom: 'ug/m3' }] }],
        'mf:equipmentActual': { id: p.st, name: p.name, health: p.health, drift: p.drift, cpk: p.cpk }, 'mf:robots': p.robots, 'mf:operators': p.operators, 'mf:vlaModel': p.vla, 'mf:carrier': p.amr,
        'mf:cycleTime': p.cycle, 'mf:processParameters': p.params };
      ev.push(e);
    }
    if (r.status === 'ok' || r.status === 'escaped') ev.push({ type: 'ObjectEvent', eventTime: iso(r.tEnd), eventTimeZoneOffset: '+09:00', epcList: [idAt(r.tEnd)], action: 'OBSERVE', bizStep: `${CBV}BizStep-storing`, disposition: `${CBV}Disp-sellable_not_accessible`, readPoint: { id: loc('PL-01') } });
  }
  return { '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld', { mf: 'https://meta-factory.example/epcis/ext#' }], type: 'EPCISDocument', schemaVersion: '2.0', creationDate: iso(T.sim.time), epcisBody: { eventList: ev } };
}
// ISA-95 계보 (Material/Equipment/Personnel Actual)
export function genealogy(r, iso) {
  return { productSerial: r.serial ?? null, wipId: r.wip ?? null, epc: r.epc ?? null, mark: r.mark ? { symbol: r.mark.symbol, cell: r.mark.at, grade: r.mark.grade, tries: r.mark.tries, digitalLink: r.mark.data } : null, materialDefinition: r.product, materialLot: r.lot, startTime: iso(r.t0), endTime: r.tEnd != null ? iso(r.tEnd) : null, status: r.status,
    segments: r.steps.map((p) => ({ processSegment: p.name, equipmentActual: [{ id: p.st, health: p.health, drift: p.drift, cpk: p.cpk }, ...p.robots.map((u) => ({ id: u, class: p.robotKind, vlaModel: p.vla }))],
      personnelActual: p.operators.map((o) => ({ id: o })), materialActual: [{ id: r.serial ?? r.wip, use: 'Produced' }, { id: r.lot, use: 'Consumed' }], carrier: p.amr, start: iso(p.tIn), end: p.tOut != null ? iso(p.tOut) : null,
      parameters: p.params, environment: p.env, result: p.result ?? null })), inspection: r.inspection };
}
// 학습용 특징 표: 제품 1행 — 셀마다 건강도·드리프트·Cpk·사이클·측정값·환경, 운반 AMR, 로트, 라벨(ng · 원인 셀 정답)
export function featuresCSV(T, recs) {
  const ids = [...new Set(recs.flatMap((r) => r.steps.map((p) => p.id)))];
  const pk = {}; for (const r of recs) for (const p of r.steps) for (const k of Object.keys(p.params)) (pk[p.id] ??= new Set()).add(k);
  const sk = {}; for (const r of recs) for (const p of r.steps) for (const k of Object.keys(p.sensors ?? {})) (sk[p.id] ??= new Set()).add(k);   // 셀 센서 값 열 (센서망이 있을 때)
  const head = ['serial', 'wip_id', 'product', 'mode', 'material_lot', 'amr', 't_release_s', 'lead_time_s', 'status', 'label_ng', 'label_root_cause_station', 'inspect_torque', 'inspect_angle',
    ...ids.flatMap((id) => [`${id}_health`, `${id}_drift`, `${id}_cpk`, `${id}_cycle_s`, `${id}_vla`, ...ENV_KEYS.map((k) => `${id}_env_${k}`), ...[...(pk[id] ?? [])].map((k) => `${id}_${k}`), ...[...(sk[id] ?? [])].map((k) => `${id}_sns_${k}`)])];
  const rows = recs.filter((r) => r.status !== 'wip').map((r) => {
    const by = Object.fromEntries(r.steps.map((p) => [p.id, p]));
    return [r.serial ?? '', r.wip ?? '', r.product, r.mode, r.lot, r.amr ?? '', r2(r.t0, 1), r.tEnd != null ? r2(r.tEnd - r.t0, 1) : '', r.status, r.status === 'ng' || r.status === 'escaped' ? 1 : 0, r.truth ?? '', r.inspection?.torque ?? '', r.inspection?.angle ?? '',
      ...ids.flatMap((id) => { const p = by[id]; return p ? [p.health, p.drift, p.cpk, p.cycle ?? '', p.vla ?? '', ...ENV_KEYS.map((k) => p.env[k]), ...[...(pk[id] ?? [])].map((k) => p.params[k] ?? ''), ...[...(sk[id] ?? [])].map((k) => p.sensors?.[k] ?? '')] : Array(5 + ENV_KEYS.length + (pk[id]?.size ?? 0) + (sk[id]?.size ?? 0)).fill(''); })];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function envCSV(T, rows, iso) {
  const head = ['time', 't_s', ...ENV_NODES.flatMap((n) => ENV_KEYS.map((k) => `${n.id}_${k}`))];
  return [head, ...rows.map((x) => [iso(x.t), r2(x.t, 0), ...x.nodes.flatMap((v) => ENV_KEYS.map((k) => v[k]))])].map((r) => r.map(csvCell).join(',')).join('\n');
}
// 인과 그래프 (DoWhy GCM 등에 바로 넣을 수 있는 노드·엣지)
export const CAUSAL_GRAPH = {
  nodes: ['env_temp', 'env_rh', 'env_vib', 'env_pm', 'env_lux', 'health', 'drift', 'vla_level', 'amr', 'material_lot', 'process_params', 'defect', 'inspect_torque', 'inspect_angle', 'label_ng'],
  edges: [['env_temp', 'defect'], ['env_rh', 'defect'], ['env_vib', 'defect'], ['env_pm', 'defect'], ['env_lux', 'defect'], ['health', 'defect'], ['drift', 'defect'], ['vla_level', 'defect'], ['amr', 'defect'], ['material_lot', 'defect'],
    ['health', 'process_params'], ['drift', 'process_params'], ['defect', 'process_params'], ['defect', 'inspect_torque'], ['defect', 'inspect_angle'], ['inspect_torque', 'label_ng'], ['inspect_angle', 'label_ng']],
  note: '셀마다 같은 구조 (셀 접두사: SORT_ · DT_ASSY_ · EA_ASSY_ …). defect는 잠재 변수 — label_root_cause_station이 시뮬레이션 정답',
};
export function rcaPrompt(c) {
  return `# 불량 원인 분석 요청 (${c.id} · ${c.serial})

당신은 자동차 부품 조립 라인의 품질 엔지니어입니다. 첨부 데이터로 이 불량의 근본 원인을 분석하고 8D 형식으로 답하세요.

- 판정: ${c.detectedName} ${c.inspection?.mode ?? ''} (토크 ${c.inspection?.torque} N·m, 각도 ${c.inspection?.angle}°, 규격 토크 ${c.inspection?.spec?.torque?.join('~')} · 각도 ${c.inspection?.spec?.angle?.join('~')})
- 파일: case.json(사례 전체) · genealogy_isa95.json(계보) · epcis_events.jsonld(EPCIS 2.0 이벤트) · features.csv(최근 제품 1행 특징 · label_ng) · environment.csv(환경 시계열 10초) · equipment.csv(판정 순간 설비 상태) · causal_graph.json
- 참고: 시뮬레이터 내장 AI 분석 1순위 = ${c.rca?.top?.label ?? '-'} (비중 ${((c.rca?.top?.score ?? 0) * 100).toFixed(0)}%)

요청
1. features.csv에서 label_ng=1과 0을 비교해 원인 후보(셀·설비 상태·환경·AMR·로트)를 순위로 제시 (근거 수치 포함)
2. 이 제품의 계보(genealogy)에서 가장 가능성 높은 원인 셀과 요인, 5 Why
3. 봉쇄 범위(case.json suspects) 제품의 처리 권고
4. 영구 대책과 재발 방지 — 운영 정책으로 바꿀 값(예: 예지정비 착수 건강도, 재보정 Cpk 기준, 환경 인터록 기준)
`;
}
export function caseFiles(T, c, iso) {
  const r = T.byId.get(c.wip ?? c.serial), near = T.recent.filter((x) => x.status !== 'wip' && Math.abs(x.t0 - (r?.t0 ?? c.t)) < 3600);
  const eq = ['st,name,state,health,drift,cpk,processed,defects,fails', ...c.equipment.map((e) => [e.st, e.name, e.state, e.health, e.drift, e.cpk, e.processed, e.defects, e.fails].map(csvCell).join(','))].join('\n');
  const manifest = { schema: 'meta-factory/rca-case/1.0', case: c.id, serial: c.serial, created: iso(T.sim.time), mode: c.mode, standards: ['GS1 EPCIS 2.0 / CBV 2.0 (JSON-LD)', 'ISA-95 (IEC 62264) Material/Equipment/Personnel Actual', '8D problem solving', 'AIAG-VDA FMEA Action Priority (D7)'],
    files: ['case.json', 'genealogy_isa95.json', 'epcis_events.jsonld', 'features.csv', 'environment.csv', 'equipment.csv', 'causal_graph.json', 'capa_8d.json', 'prompt_rca.md', 'README.md'] };
  return [
    { path: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { path: 'case.json', data: JSON.stringify({ ...c, product_record: r ? stripTruth(r) : null, capa: c.capa ? capaJSON(c.capa) : null }, null, 2) },
    { path: 'genealogy_isa95.json', data: JSON.stringify(r ? genealogy(stripTruth(r), iso) : null, null, 2) },
    { path: 'epcis_events.jsonld', data: JSON.stringify(epcisDoc(T, r ? [r] : [], iso), null, 2) },
    { path: 'features.csv', data: featuresCSV(T, near) },
    { path: 'environment.csv', data: envCSV(T, T.env.window(c.envWindow.t0 - 480, c.envWindow.t1), iso) },
    { path: 'equipment.csv', data: eq },
    { path: 'causal_graph.json', data: JSON.stringify(CAUSAL_GRAPH, null, 2) },
    { path: 'capa_8d.json', data: JSON.stringify(c.capa ? capaJSON(c.capa) : null, null, 2) },
    { path: 'prompt_rca.md', data: rcaPrompt(c) },
    { path: 'README.md', data: README },
  ];
}
export function allFiles(T, iso) {
  const recs = T.recent.slice(-1500);
  return [
    { path: 'manifest.json', data: JSON.stringify({ schema: 'meta-factory/rca-dataset/1.0', created: iso(T.sim.time), products: recs.length, cases: T.cases.length, stats: T.stats }, null, 2) },
    { path: 'features.csv', data: featuresCSV(T, recs) },
    { path: 'environment.csv', data: envCSV(T, T.env.series, iso) },
    { path: 'epcis_events.jsonld', data: JSON.stringify(epcisDoc(T, recs.slice(-400).map(stripTruth), iso)) },
    { path: 'cases.json', data: JSON.stringify(T.cases.map((c) => ({ ...c, capa: c.capa ? capaJSON(c.capa) : null })), null, 2) },
    { path: 'capa_8d.json', data: JSON.stringify((T.sim.capa?.list ?? []).map(capaJSON), null, 2) },
    { path: 'policies.json', data: JSON.stringify(T.sim.capa?.policies ?? [], null, 2) },
    { path: 'causal_graph.json', data: JSON.stringify(CAUSAL_GRAPH, null, 2) },
    ...(T.sim.serials ? [{ path: 'serial_events.jsonld', data: JSON.stringify(serialEpcis(T.sim.serials, iso)) }, { path: 'serials.csv', data: serialsCSV(T.sim.serials) }] : []),
    { path: 'README.md', data: README },
  ];
}
// 계보 기록의 정답 라벨(불량이 생긴 셀)은 features.csv label_root_cause_station에만 둔다 (AI 평가용) — 사례 JSON에는 남기지 않음
const stripTruth = (r) => ({ ...r, truth: undefined, steps: r.steps.map(({ defect, risk, ...p }) => p) });
export const capaJSON = (k) => ({ id: k.id, title: k.title, status: k.status, opened: k.t0, closed: k.tEnd ?? null, cause: k.cause, cases: k.cases, steps: k.steps, actions: k.actions, horizontal: k.horizontal, fmea: k.fmea, effect: k.effect ?? null });
const README = `# 메타팩토리 불량 원인 분석(RCA) 데이터

시뮬레이터(정밀조립Zone)에서 품질검사 NG가 나온 제품의 추적 데이터를 AI가 원인 분석할 수 있게 정리한 묶음입니다.

## 파일
- manifest.json — 스키마 버전 · 사례 ID · 적용 표준
- case.json — 사례 전체: 판정(토크·각도·규격·NG 모드) · 제품 계보 · 판정 순간 설비 상태 · 환경 이상 · 봉쇄 범위(의심 제품) · 내장 AI 분석 · 8D
- genealogy_isa95.json — ISA-95(IEC 62264) 용어의 계보: 공정 구간마다 Equipment/Personnel/Material Actual · 공정 측정값 · 환경
- epcis_events.jsonld — GS1 EPCIS 2.0 JSON-LD: 투입(commissioning) → 셀 통과(sorting · assembling · inspecting · packing) → 적재, 센서값은 sensorElementList, 확장 필드 접두사 mf:
- features.csv — 학습용 특징 표 (제품 1행). label_ng(불량 여부) · label_root_cause_station(시뮬레이션 정답 — 불량이 생긴 셀) · 셀마다 건강도·드리프트·Cpk·사이클·VLA 모델·환경·측정값
- environment.csv — 정밀조립Zone 환경 센서 4대 10초 시계열 (온도 °C · 상대습도 %RH · 바닥 진동 mm/s · PM2.5 µg/m³ · 소음 dB(A) · 조도 lx)
- equipment.csv — 판정 순간 셀 상태 · causal_graph.json — 인과 그래프(DoWhy GCM 등) · capa_8d.json — 8D 기록 · prompt_rca.md — LLM 분석 요청문

## 쓰는 법 (예)
- 표 학습: pandas로 features.csv를 읽어 label_ng 분류(그래디언트 부스팅 + SHAP)로 원인 특징 순위
- 인과 분석: DoWhy gcm.attribute_anomalies에 causal_graph.json 구조를 넣어 이상 기여 분해
- LLM: prompt_rca.md와 case.json · features.csv를 함께 첨부
- EPCIS 검증: OpenEPCIS 도구로 epcis_events.jsonld 스키마 확인

ID 2단: 투입 = WIP ID(WIP-DT-YYMMDD-일련번호) · 검사·포장셀 합격 = 제품 시리얼(제품코드 DT 도어트림 · EA e-axle-YYMMDD-일련번호, GS1 AI 21). 체결 검사 NG품은 시리얼 없이 WIP ID로 남습니다(features.csv serial 빈칸 · wip_id).
EPC는 가상 GS1 업체코드(${GS1_PREFIX}) SGTIN이고, 시리얼 발행 전 이벤트는 사내 URI(urn:mf:wip:…)를 씁니다. serial_events.jsonld · serials.csv = 시리얼 발행·포장(SSCC)·출하·보류·처분 이벤트. 측정값·환경값은 시뮬레이션 값입니다.

`;
