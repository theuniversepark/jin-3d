// CCTV — 사각지대 없는 배치. 바닥을 1m 간격 점으로 나누고, 카메라에서 각 점까지 시야가 큰 설비(셀·창고 랙·서버 랙)에
// 가리지 않는지 따져 "보이는 점"을 구한 뒤, 아직 안 보이는 점을 가장 많이 덮는 후보 자리부터 차례로 골라(탐욕적 집합 덮개)
// 모든 점이 최소 한 대에 보일 때까지 설치한다. 건물 안은 천장 돔 카메라(높이 7.5m, 반경 9m 어안),
// 입고·출하 트럭 야드는 외벽·야드 가장자리 기둥의 실외 PTZ 돔 카메라(높이 7.5m, 줌 반경 20m).
// 라인 배치(셀 위치)가 바뀌면 다시 계산하고, 같은 배치는 캐시를 쓴다. 렌더링과 분리되어 헤드리스에서도 같은 결과.
// 피지컬AI 단계에서는 CCTV 영상 AI 분석으로 현장 이벤트를 2초 안에 감지한다 (sim.updateFieldEvents).

const STEP = 1;                          // 바닥 점 간격 (m)
const EYE = 0.3;                         // 점 높이 — 바닥 가까이까지 보이는지로 판정 (엄격)
export const CCTV_SPEC = {
  dome: { label: '천장 돔 카메라 (어안 360°)', y: 7.5, R: 9 },
  outdoor: { label: '실외 PTZ 돔 카메라 (줌)', y: 7.5, R: 20 },
};
const cache = new Map();

// 시야를 가리는 큰 설비 (바닥 점유 영역 + 높이)
function obstacles(sim) {
  const ob = [];
  for (const st of sim.stations) {
    if (st.standby) continue;
    const h = st.type === 'source' ? 3.2 : st.type === 'sink' ? 2.6 : 2.9;
    ob.push({ x0: st.x - 2.3, x1: st.x + 2.3, z0: st.z - 2.3, z1: st.z + (st.type === 'source' ? 3.1 : 2.3), h, name: st.name });
  }
  ob.push({ x0: -46.3, x1: -44.1, z0: -6.8, z1: 3.6, h: 5.0, name: '물류 선반' });   // 지게차 통로와 로봇 통로 사이 남북 방향 통과형 선반
  ob.push({ x0: -15.7, x1: -11.3, z0: -15.6, z1: -13.2, h: 2.3, name: '관제 서버 랙' });   // 중앙 관제 디스플레이 가운데 아래
  return ob;
}
// 선분(카메라→점)이 상자(바닥 영역 × 0~h)를 지나는지 — 슬래브 방식
export function blocked(c, p, ob) {
  for (const b of ob) {
    if (p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1) continue;   // 점이 그 설비 위면 판정 제외
    let t0 = 0, t1 = 1;
    for (const [o, d, lo, hi] of [[c.x, p.x - c.x, b.x0, b.x1], [c.y, (p.y ?? EYE) - c.y, 0, b.h], [c.z, p.z - c.z, b.z0, b.z1]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t0 = 2; break; } continue; }
      let a = (lo - o) / d, e = (hi - o) / d; if (a > e) [a, e] = [e, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, e); if (t0 > t1) break;
    }
    if (t0 <= t1 && t1 > 0 && t0 < 1) return true;
  }
  return false;
}
// 한 구역: 바닥 점 · 후보 자리 → 탐욕적으로 덮기
function coverRegion(region, ob) {
  const pts = [];
  for (let x = region.x0; x <= region.x1 + 1e-9; x += STEP) for (let z = region.z0; z <= region.z1 + 1e-9; z += STEP) {
    if (ob.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1)) continue;   // 설비가 서 있는 자리는 사람이 설 수 없다
    pts.push({ x, z });
  }
  const sees = region.cands.map((c) => {
    const s = [];
    pts.forEach((p, i) => { if (Math.hypot(p.x - c.x, p.z - c.z) <= c.R && !blocked(c, p, ob)) s.push(i); });
    return s;
  });
  const covered = new Uint8Array(pts.length), chosen = [];
  let left = pts.length;
  while (left > 0) {
    let best = -1, bn = 0;
    sees.forEach((s, k) => { if (chosen.includes(k)) return; let n = 0; for (const i of s) if (!covered[i]) n++; if (n > bn) { bn = n; best = k; } });
    if (best < 0) break;   // 어떤 후보로도 못 보는 점 (없어야 정상)
    chosen.push(best); for (const i of sees[best]) if (!covered[i]) { covered[i] = 1; left--; }
  }
  const count = new Uint8Array(pts.length);
  for (const k of chosen) for (const i of sees[k]) count[i]++;
  return { pts, count, cams: chosen.map((k) => region.cands[k]), blind: left };
}

export function planCCTV(sim) {
  const key = JSON.stringify(sim.stations.filter((s) => !s.standby).map((s) => [s.type, Math.round(s.x * 10), Math.round(s.z * 10)]));
  if (cache.has(key)) return cache.get(key);
  const ob = obstacles(sim);
  const grid = (x0, x1, z0, z1, step, y, R, kind, extra = {}) => { const c = []; for (let x = x0; x <= x1 + 1e-9; x += step) for (let z = z0; z <= z1 + 1e-9; z += step) c.push({ x, y, z, R, kind, ...extra }); return c; };
  const D = CCTV_SPEC.dome, O = CCTV_SPEC.outdoor;
  // 건물 안: 천장 2m 격자 후보
  const inside = coverRegion({ x0: -50.6, x1: 37.6, z0: -19.6, z1: 19.6, cands: grid(-50, 36, -18, 18, 2, D.y, D.R, 'dome') }, ob);   // 왼쪽 확장동(물류존) 포함
  // 입고 트럭 야드: 왼쪽 확장동 외벽(x −51.4)과 야드 가장자리 기둥 후보
  const yardIn = coverRegion({ x0: -92, x1: -52, z0: -44, z1: -4, cands: [
    ...grid(-51.4, -51.4, -18, 18, 3, O.y, O.R, 'wall', { face: -Math.PI / 2 }),
    ...grid(-92.5, -92.5, -44, -4, 4, O.y, O.R, 'pole'), ...grid(-91, -53, -45, -45, 4, O.y, O.R, 'pole'), ...grid(-91, -53, -2.5, -2.5, 4, O.y, O.R, 'pole'),
    ...grid(-87, -79, -38, -22, 8, O.y, O.R, 'pole')] }, []);   // 야드 서쪽 안쪽 기둥 (트럭 진출입 차로·회전 구역·대기 자리를 비켜)
  // 출하 트럭 야드: 뒷벽 바깥(z −20.4)과 야드 가장자리 기둥 후보
  const yardOut = coverRegion({ x0: 15, x1: 47, z0: -47, z1: -21, cands: [
    ...grid(16, 37, -20.4, -20.4, 3, O.y, O.R, 'wall', { face: Math.PI }),
    ...grid(48.5, 48.5, -47, -21, 4, O.y, O.R, 'pole'), ...grid(14, 14, -47, -24, 4, O.y, O.R, 'pole'), ...grid(16, 46, -48.5, -48.5, 4, O.y, O.R, 'pole')] }, []);
  const regions = { inside, yardIn, yardOut };
  const cams = [];
  for (const [rk, r] of Object.entries(regions)) for (const c of r.cams) cams.push({ ...c, region: rk, id: `CC-${String(cams.length + 1).padStart(2, '0')}` });
  const all = Object.values(regions), P = all.reduce((a, r) => a + r.pts.length, 0);
  const seen = all.reduce((a, r) => a + r.count.reduce((x, v) => x + (v > 0 ? 1 : 0), 0), 0);
  const dbl = all.reduce((a, r) => a + r.count.reduce((x, v) => x + (v > 1 ? 1 : 0), 0), 0);
  const plan = {
    cams, regions, obstacles: ob,
    stats: { points: P, coverage: seen / P, redundancy: dbl / P, blind: P - seen, inside: inside.cams.length, outside: yardIn.cams.length + yardOut.cams.length,
      insideCoverage: inside.count.reduce((x, v) => x + (v > 0 ? 1 : 0), 0) / inside.pts.length },
  };
  cache.set(key, plan);
  return plan;
}

// 위치(x,z)를 보는 카메라 (시야 가림 반영) — 현장 이벤트 AI 감지에 쓴다
export function camerasSeeing(plan, x, z) {
  return plan.cams.filter((c) => Math.hypot(x - c.x, z - c.z) <= c.R && (c.region !== 'inside' || !blocked(c, { x, z }, plan.obstacles)));
}

// ── CCTV 영상 AI 파이프라인 (피지컬AI) — 이벤트 유형별로 맞는 모델을 쓴다 ─────────────────
// 실제 공장 CCTV 분석에 쓰는 구성: 실시간 객체 검출(YOLO 계열) + 다중 객체 추적(ByteTrack) + 바닥 이상 분할(세그멘테이션)
// + 연기·화재 전용 검출 모델 + 지오펜스 침입 규칙. 이 디지털트윈에서는 장면의 실제 위치·크기를 카메라로 투영해
// 각 모델이 내놓을 출력(상자·마스크·트랙 ID·신뢰도)을 만들어 보여 준다 (렌더 영상에 신경망을 직접 돌리지는 않는다).
export const AI_MODELS = {
  detect: { name: 'YOLO11 객체 검출', desc: '사람·휴머노이드·지게차·AGV/AMR·트럭·사족보행·드론 · 640px 실시간', color: '#37e8ff' },
  track: { name: 'ByteTrack 다중 객체 추적', desc: '프레임 간 같은 객체에 같은 트랙 ID — 체류·이동 경로', color: '#8fb3c9' },
  seg: { name: 'YOLO11-seg 바닥 이상 분할', desc: '누유·이물질 영역 마스크 · 면적 추정', color: '#ff7a3d' },
  fire: { name: '연기·화재 검출 (YOLO11 · D-Fire 데이터셋 학습)', desc: '연기·불꽃 조기 경보', color: '#ff5a5a' },
  zone: { name: '지오펜스 침입 규칙', desc: '무인 구역 안 사람 검출 → 침입 경보 (로봇 작업 구역)', color: '#f5b82e' },
};
export const EVENT_MODEL = { leak: 'seg', debris: 'seg', smoke: 'fire', intrusion: 'zone' };

// ── CCTV 에이전트 — 영상 감시 · 메인 오케스트레이터 보고 · 이벤트 이력 관리 ─────────────────
// 현장 이벤트를 영상 AI로 감지하면 메인 오케스트레이터에 보고하고(인시던트 생성·대응은 오케스트레이터 담당),
// 이미 다른 경로(IoT·로봇·드론)로 보고된 인시던트가 CCTV 화면에 잡히면 "영상 확보" 기록만 남긴다.
// 이력에는 감지 시각·카메라·모델·신뢰도·위치·연결 인시던트를 쓰고, 오케스트레이터가 인시던트를 닫으면 결과·소요 시간을 채운다.
export class CCTVAgent {
  constructor(sim) {
    this.sim = sim; this.history = []; this.seq = 0; this.t = 0; this.byInc = new Map();
    this.on = sim.mode.key === 'dark' && !sim.twin;
  }
  add(e) {
    const rec = { no: `EV-${String(++this.seq).padStart(4, '0')}`, t: this.sim.time, status: 'open', ...e };
    this.history.unshift(rec); if (this.history.length > 400) this.history.pop();
    if (rec.inc) this.byInc.set(rec.inc.id, [...(this.byInc.get(rec.inc.id) ?? []), rec]);
    return rec;
  }
  update(dt) {
    if (!this.on) return;
    this.t += dt; if (this.t < 0.5) return; this.t = 0;
    const s = this.sim, plan = s.cctv;
    // 1) 현장 이벤트: 영상 AI로 감지 → 메인 오케스트레이터에 보고 (2초 확인 후)
    for (const ev of s.fieldEvents ?? []) {
      if (ev.cleared || ev.cctvLogged) continue;
      const cams = camerasSeeing(plan, ev.x, ev.z); if (!cams.length) continue;
      const cam = cams.sort((a, b) => Math.hypot(a.x - ev.x, a.z - ev.z) - Math.hypot(b.x - ev.x, b.z - ev.z))[0], model = EVENT_MODEL[ev.type] ?? 'detect';
      const conf = Math.round((0.86 + ((ev.id * 7) % 10) / 100) * 100) / 100;
      if (!ev.detected && s.time - ev.t0 >= 2) {
        ev.cctv = cam.id;
        s.detectFieldEvent(ev, `CCTV 에이전트 (${cam.id})`, conf);
        ev.cctvLogged = true;
        this.add({ kind: 'report', cam: cam.id, cams: cams.map((c) => c.id), model, cls: ev.cls, label: ev.label, conf, x: ev.x, z: ev.z, inc: ev.inc, note: `${AI_MODELS[model].name} → 메인 오케스트레이터 보고` });
        s.orch.step(ev.inc, 'field', 'report', `CCTV 에이전트 보고: ${cam.id} 영상 · ${AI_MODELS[model].name} · ${ev.cls} ${conf.toFixed(2)} · 이력 등록`);
      } else if (ev.detected) {   // 다른 경로로 먼저 감지됨 → 교차 확인·영상 확보만
        ev.cctvLogged = true;
        this.add({ kind: 'verify', cam: cam.id, cams: cams.map((c) => c.id), model, cls: ev.cls, label: ev.label, conf, x: ev.x, z: ev.z, inc: ev.inc, note: `${ev.detectedBy} 감지를 영상으로 교차 확인 · 영상 확보` });
      }
    }
    // 2) 다른 인시던트(설비 고장·결품·공급 차질): 화면에 잡히면 영상 확보 기록 (보고·대응은 이미 오케스트레이터가 진행)
    for (const inc of s.orch.incidents) {
      if (inc.status !== 'open' || !inc.where || inc.type === 'field' || this.byInc.has(inc.id)) continue;
      const cams = camerasSeeing(plan, inc.where.x, inc.where.z); if (!cams.length) continue;
      this.add({ kind: 'record', cam: cams[0].id, cams: cams.map((c) => c.id), model: 'detect', cls: { equipment: '설비 정지', parts: '선반 결품', supply: '입고 지연' }[inc.type] ?? inc.type, label: inc.title, conf: null, x: inc.where.x, z: inc.where.z, inc, note: '오케스트레이터 인시던트 · 영상 기록 확보' });
    }
    // 3) 이력 상태 동기화: 오케스트레이터가 인시던트를 닫으면 결과·소요 시간 기록
    for (const r of this.history) {
      if (r.status !== 'open' || !r.inc || r.inc.status === 'open') continue;
      r.status = 'closed'; r.tEnd = r.inc.tEnd ?? s.time; r.dur = r.tEnd - r.inc.t0;
      r.result = r.inc.steps.at(-1)?.text ?? '종료';
    }
  }
  stats() {
    const h = this.history, rep = h.filter((r) => r.kind === 'report');
    return { total: h.length, reports: rep.length, verify: h.filter((r) => r.kind === 'verify').length, records: h.filter((r) => r.kind === 'record').length, open: h.filter((r) => r.status === 'open').length };
  }
}
