// Private 5G (이음5G 특화망) — 음영지역 없는 기지국(소형 셀) 배치, 이동 로봇 5G 모뎀(UE), 핸드오버, 무손실 업링크.
// ① 배치: 건물 안 바닥을 2m 간격 점으로 나누고, 천장 후보 자리(4m 격자)마다 3GPP TR 38.901 InF(실내 공장) 경로손실로 RSRP를 계산한다.
//    큰 설비(셀·선반·서버 랙)가 시선을 가리면 NLOS 식을 쓴다. 설계 기준(RSRP ≥ −80dBm, 셀 반경 18m 이내 — 로봇 밀도·용량)을
//    만족하지 못하는 점을 가장 많이 덮는 자리부터 골라(탐욕적 집합 덮개) 모든 점이 덮일 때까지 기지국을 단다.
// ② PCI: 기지국마다 고유한 물리 셀 ID(PCI = 3 × SSS + PSS, 0~1007). 이웃 기지국끼리는 PCI mod 3(PSS)이 겹치지 않게 칠한다.
// ③ UE: AMR·AGV·자율 지게차·휴머노이드·사족보행·드론·AMMR마다 5G 모뎀. 100ms마다 모든 셀의 RSRP를 재고(L3 필터),
//    A3 이벤트(인접 셀 > 서빙 셀 + 3dB, TTT 160ms)가 나면 Xn 핸드오버를 한다. 실행 중(약 30~45ms) 올라온 패킷은 PDCP 버퍼에 담았다가
//    타깃 셀로 포워딩해 순서대로 보낸다 → 유실 0. 데이터: AAS 모델 → OPC UA PubSub JSON 메시지 → MQTT(QoS 1) → 5G NR → UPF → 브로커.
// 렌더링과 분리되어 헤드리스 시뮬레이션에서도 같은 흐름으로 동작한다 (모드: 자동화·피지컬AI).
import { blocked } from './cctv.js';

export const NR = {
  band: 'n79', fc: 4.75, bwMHz: 100, scs: 30, nRE: 3276,       // 이음5G 4.72~4.82GHz · 100MHz · 30kHz (273RB)
  txDbm: 24, gainDbi: 5, nfDb: 7, y: 7.2,                       // 실내 소형 셀: 24dBm, 안테나 5dBi, 천장 7.2m
  design: -80, require: -100, rlf: -112, R: 18,                // 설계 RSRP · 서비스 최소 RSRP · 무선 링크 실패 · 셀 반경(용량)
  a3: 3, ttt: 0.16, hoMs: [30, 45], period: 0.1, load: 0.5,     // A3 오프셋 · Time-To-Trigger · 핸드오버 실행 시간 · 측정 주기 · 인접 셀 부하
  daps: true,                                                   // DAPS 핸드오버 (Rel-16): 실행 중에도 소스 셀로 계속 보내 끊김 0ms — 지연 10ms 요구
};
// ── 지연 요구 10ms (p99, 로봇 → 5GC UPF 단방향 업링크) ─────────────────
// 3GPP TS 22.104(공장 자동화) · TR 38.824(URLLC) 기준 구성: TDD DSUUU(2.5ms 주기, 상향 우세 — 이음5G 공장 업링크 영상)·30kHz,
// 설정 그랜트(Configured Grant, SR 없음), HARQ BLER 10%(p99에 재전송 1회), DAPS 핸드오버(끊김 0ms, Rel-16).
// p99 지연 = 고정 지연(TDD 정렬 · 슬롯 전송 · gNB 처리 · HARQ 1회 · 전달망 · UPF) + 스케줄링 경쟁(UL 그랜트/슬롯) + 부하 대기(M/M/1 꼬리)
export const LAT = {
  req: 10, target: 9,                         // 요구(ms) · 부하 분산 목표(여유 1ms)
  periodMs: 2.5, ulSlotsPerMs: 1.2, ulFrac: 0.6, overhead: 0.85, seMax: 5.5, mtuBits: 12000,
  grantsPerSlot: 6,                           // UL 슬롯 하나에 줄 수 있는 그랜트 수 (PDCCH CORESET 용량)
  fixed: { align: 1.0, tx: 0.5, proc: 1.0, harq: 2.5, transport: 0.6, upf: 0.3 },   // ms
};
LAT.fixedMs = Object.values(LAT.fixed).reduce((a, b) => a + b, 0);   // 5.9ms
// 로봇 종류별 업링크 (활동 중): 텔레메트리 10Hz 320B + 카메라 영상(H.264). 쉬는 중(주차·충전·대기)은 영상 끔
export const UE_LOAD = {
  carrier: { cams: 1, mbps: 2.0, label: '전방 카메라 1대' }, agv: { cams: 1, mbps: 2.0, label: '전방 카메라 1대' },
  forklift: { cams: 2, mbps: 3.5, label: '포크·후방 카메라 2대' }, quadruped: { cams: 2, mbps: 5.0, label: '스테레오·열화상 2대' },
  drone: { cams: 1, mbps: 4.0, label: '짐벌 카메라 1대' },
  humanoid: { cams: 4, mbps: 8.5, label: '머리 스테레오 4 + 양손 1.5×2 + 등 1.5' }, ammr: { cams: 4, mbps: 8.5, label: '머리 스테레오 4 + 양손 1.5×2 + 등 1.5' },
};
const TELE_MBPS = 0.0256;
// 상향 SINR (링크 예산): 단말 23dBm을 전 대역 RE에 나눠 보낸다고 볼 때 gNB 수신 전력 − 잡음(NF 5dB) − 간섭 여유(IoT 3dB).
// 경로손실은 하향 RSRP에서 거꾸로 구한다 (PL = RE당 송신 전력 + 안테나 이득 − RSRP)
export const ulSinr = (rsrpDb) => { const pl = NR.txDbm - 10 * Math.log10(NR.nRE) + NR.gainDbi - rsrpDb; return 23 - 10 * Math.log10(NR.nRE) + NR.gainDbi - pl - (-174 + 10 * Math.log10(NR.scs * 1e3) + 5) - 3; };
// 스펙트럼 효율 (링크 적응 근사: 0.75·log2(1+SINR), 최대 5.5 b/s/Hz) — 셀 상향 용량 = 100MHz × 0.6 × SE × 0.85
export const specEff = (sinrDb) => Math.max(0.2, Math.min(LAT.seMax, 0.75 * Math.log2(1 + Math.pow(10, sinrDb / 10))));
// 셀 하나의 p99 지연 (ms): ues = [{ mbps, se }]
export function cellLatency(ues) {
  const n = ues.length; if (!n) return { p99: LAT.fixedMs, rho: 0, sched: 0, queue: 0, n: 0, mbps: 0 };
  const bwHz = NR.bwMHz * 1e6 * LAT.ulFrac * LAT.overhead;
  const rho = ues.reduce((a, u) => a + (u.mbps * 1e6) / (bwHz * u.se), 0);            // 상향 자원 점유율
  const mbps = ues.reduce((a, u) => a + u.mbps, 0), seAvg = mbps / Math.max(1e-9, ues.reduce((a, u) => a + u.mbps / u.se, 0));
  const nAct = ues.filter((u) => u.mbps > 0.1).length;                                // 영상을 보내는 단말만 그랜트 경쟁 (텔레메트리는 설정 그랜트로 충분)
  const sched = Math.max(0, Math.ceil(nAct / LAT.grantsPerSlot) - 1) / LAT.ulSlotsPerMs;  // 그랜트 차례를 기다리는 슬롯
  const mu = (bwHz * seAvg) / LAT.mtuBits;                                             // 패킷/초
  const queue = rho >= 1 ? Infinity : rho > 0.01 ? (Math.log(rho / 0.01) / (mu * (1 - rho))) * 1000 : 0;   // M/M/1 대기 99% 꼬리
  return { p99: LAT.fixedMs + sched + queue, rho, sched, queue, n, nAct, mbps };
}
// 임계 대수: 같은 종류 로봇만 한 셀에 있을 때 p99 ≤ 10ms를 지키는 최대 대수 (평균 SINR 기준)
// rsrpDb: 셀 안 단말의 하향 RSRP (설계 기준 −80dBm → 상향 SINR로 바꿔 계산)
export function maxRobots(kind, rsrpDb = NR.design, req = LAT.req) {
  const L = UE_LOAD[kind], se = specEff(ulSinr(rsrpDb)); let n = 0;
  while (n < 400 && cellLatency(Array.from({ length: n + 1 }, () => ({ mbps: L.mbps + TELE_MBPS, se }))).p99 <= req) n++;
  return n;
}
const STEP = 2, UE_Y = 1.0, WALL_DB = 0;
const L10 = Math.log10, RE_DBM = NR.txDbm - 10 * L10(NR.nRE);                         // 자원 요소(RE)당 송신 전력
const NOISE = -174 + 10 * L10(NR.scs * 1e3) + NR.nfDb;                                  // RE당 잡음 (dBm)
const dbm2mw = (d) => Math.pow(10, d / 10), mw2dbm = (m) => 10 * L10(Math.max(m, 1e-30));
// 3GPP TR 38.901 InF-SL (Indoor Factory, 성긴 설비·낮은 안테나 아님) — LOS / NLOS
export function pathLoss(d3, los) {
  const d = Math.max(1, d3), lo = 31.84 + 21.5 * L10(d) + 19.0 * L10(NR.fc);
  return los ? lo : Math.max(lo, 33 + 25.5 * L10(d) + 20 * L10(NR.fc));
}
export function rsrp(cell, p, ob) {
  const d3 = Math.hypot(cell.x - p.x, cell.y - (p.y ?? UE_Y), cell.z - p.z);
  const los = !blocked({ x: cell.x, y: cell.y, z: cell.z }, p, ob);
  return { v: RE_DBM + NR.gainDbi - pathLoss(d3, los) - WALL_DB, los };
}
const cache = new Map();

export function plan5G(sim) {
  const key = JSON.stringify(sim.stations.filter((s) => !s.standby).map((s) => [s.type, Math.round(s.x * 10), Math.round(s.z * 10)]));
  if (cache.has(key)) return cache.get(key);
  const ob = sim.cctv.obstacles, B = { x0: -50.6, x1: 37.6, z0: -19.6, z1: 19.6 };
  const pts = [];
  for (let x = B.x0; x <= B.x1 + 1e-9; x += STEP) for (let z = B.z0; z <= B.z1 + 1e-9; z += STEP) pts.push({ x, z });
  const cands = [];
  // 천장 후보: 설비 위는 피하고, 천장 CCTV 돔과는 CLEAR(2.5m) 이상 떨어뜨린다 (같은 자리에 겹쳐 달지 않음 · 카메라 시야를 가리지 않게)
  const domes = sim.cctv.cams.filter((c) => c.region === 'inside'), CLEAR = 2.5;
  for (let x = -48; x <= 36; x += 4) for (let z = -18; z <= 18; z += 4) {
    if (ob.some((b) => x > b.x0 - 0.5 && x < b.x1 + 0.5 && z > b.z0 - 0.5 && z < b.z1 + 0.5)) continue;
    if (domes.some((c) => Math.hypot(c.x - x, c.z - z) < CLEAR)) continue;
    cands.push({ x, y: NR.y, z });
  }
  const R = cands.map((c) => pts.map((p) => rsrp(c, p, ob).v));
  const ok = (k, i) => R[k][i] >= NR.design && Math.hypot(cands[k].x - pts[i].x, cands[k].z - pts[i].z) <= NR.R;
  const covered = new Uint8Array(pts.length), chosen = [];
  let left = pts.length;
  while (left > 0) {
    let best = -1, bn = 0;
    cands.forEach((c, k) => { if (chosen.includes(k)) return; let n = 0; for (let i = 0; i < pts.length; i++) if (!covered[i] && ok(k, i)) n++; if (n > bn) { bn = n; best = k; } });
    if (best < 0) break;
    chosen.push(best); for (let i = 0; i < pts.length; i++) if (!covered[i] && ok(best, i)) { covered[i] = 1; left--; }
  }
  const cells = chosen.map((k, n) => ({ ...cands[k], idx: n, id: `gNB-${String(n + 1).padStart(2, '0')}`, k }));
  // 이웃(1차 인접): 최강 셀 서비스 영역이 맞닿은 셀 — 핸드오버가 일어나는 경계를 공유한다. 가중치 = 맞닿은 경계 길이(2m 칸 수)
  const srv0 = pts.map((p, i) => { let bk = 0, bv = -Infinity; for (const c of cells) if (R[c.k][i] > bv) { bv = R[c.k][i]; bk = c.idx; } return bk; });
  const W = cells.map(() => new Map()), NZ = Math.round((B.z1 - B.z0) / STEP) + 1;
  pts.forEach((p, i) => { for (const j of [i + 1, i + NZ]) { if (j >= pts.length || (j === i + 1 && (i + 1) % NZ === 0)) continue; const a = srv0[i], b = srv0[j]; if (a !== b) { W[a].set(b, (W[a].get(b) ?? 0) + 1); W[b].set(a, (W[b].get(a) ?? 0) + 1); } } });
  // PCI = 3 × SSS + PSS — 이웃끼리 PSS(PCI mod 3)가 같으면 동기 신호가 서로 간섭한다: 같은 PSS인 경계 길이 합이 최소가 되게 되추적으로 칠한다
  const order = cells.map((c) => c.idx).sort((a, b) => [...W[b].values()].reduce((x, y) => x + y, 0) - [...W[a].values()].reduce((x, y) => x + y, 0));
  const col = new Array(cells.length).fill(-1); let bestCol = null, bestConf = Infinity, tries = 0;
  const solve = (k, conf) => {
    if (++tries > 300000 || conf >= bestConf) return;
    if (k === order.length) { bestConf = conf; bestCol = [...col]; return; }
    const a = order[k];
    for (const v of [0, 1, 2]) { let add = 0; for (const [b, w] of W[a]) if (col[b] === v) add += w; col[a] = v; solve(k + 1, conf + add); col[a] = -1; if (bestConf === 0) return; }
  };
  solve(0, 0);
  const borderAll = cells.reduce((x, c) => x + [...W[c.idx].values()].reduce((y, w) => y + w, 0), 0) / 2;
  cells.forEach((c, n) => { c.sss = 40 + n; c.pci = 3 * c.sss + bestCol[n]; c.neighbors = [...W[n].keys()]; c.border = Object.fromEntries(W[n]); });
  const mod3 = { conflictBorder: bestConf, border: borderAll, pairs: cells.reduce((x, c) => x + c.neighbors.filter((b) => b > c.idx && cells[b].pci % 3 === c.pci % 3).length, 0) };
  // 점마다 최강 셀 RSRP·SINR(인접 셀 50% 부하 간섭)·겹침 수
  const best = new Float32Array(pts.length), sinr = new Float32Array(pts.length), server = new Int16Array(pts.length), overlap = new Uint8Array(pts.length);
  pts.forEach((p, i) => {
    let bv = -Infinity, bk = -1, I = 0;
    for (const c of cells) { const v = R[c.k][i]; if (v > bv) { bv = v; bk = c.idx; } if (v >= -90) overlap[i]++; }
    for (const c of cells) if (c.idx !== bk) I += dbm2mw(R[c.k][i]) * NR.load;
    best[i] = bv; server[i] = bk; sinr[i] = bv - mw2dbm(I + dbm2mw(NOISE));
  });
  let minR = Infinity, sumR = 0, sinrOk = 0, ho = 0;
  for (let i = 0; i < pts.length; i++) { minR = Math.min(minR, best[i]); sumR += best[i]; if (sinr[i] >= 0) sinrOk++; if (overlap[i] >= 2) ho++; }
  // 셀마다 1m 격자 RSRP 지도 (UE 측정은 지도에서 읽는다 — 매 측정마다 시선 계산을 다시 하지 않음)
  const G = { x0: B.x0, z0: B.z0, nx: Math.round(B.x1 - B.x0) + 1, nz: Math.round(B.z1 - B.z0) + 1 };
  for (const c of cells) {
    c.map = new Float32Array(G.nx * G.nz);
    for (let ix = 0; ix < G.nx; ix++) for (let iz = 0; iz < G.nz; iz++) c.map[ix * G.nz + iz] = rsrp(c, { x: G.x0 + ix, z: G.z0 + iz }, ob).v;
  }
  const plan = {
    cells, pts, best, sinr, server, overlap, obstacles: ob, grid: G,
    stats: { points: pts.length, cells: cells.length, holes: pts.filter((p, i) => best[i] < NR.require).length, design: pts.filter((p, i) => best[i] >= NR.design).length / pts.length,
      minRsrp: minR, avgRsrp: sumR / pts.length, sinrOk: sinrOk / pts.length, hoZone: ho / pts.length, mod3 },
  };
  cache.set(key, plan);
  return plan;
}

// ── 이동 로봇 5G 모뎀 (UE) ─────────────────
const KIND = { carrier: '운반 AMR', agv: 'AGV', forklift: '자율 지게차', humanoid: '휴머노이드', quadruped: '사족보행', drone: '순찰 드론', ammr: 'AMMR' };
class UE {
  constructor(net, id, uid, kind, pos) {
    this.net = net; this.id = id; this.uid = uid; this.kind = kind; this.pos = pos;
    this.imsi = `450${String(net.ues.length + 1).padStart(12, '0')}`;   // MCC 450 (대한민국)
    this.serv = null; this.F = new Float64Array(net.plan.cells.length).fill(-140); this.meas = null; this.cand = null; this.tttT = 0;
    this.hoUntil = -1; this.hoTarget = null; this.hos = []; this.hoN = 0; this.pingpong = 0; this.rlf = 0; this.weak = 0;
    this.seq = 0; this.sent = 0; this.delivered = 0; this.buf = 0; this.fwd = 0; this.lost = 0; this.dup = 0; this.bytes = 0; this.maxDelay = 0; this.lastSeq = 0;
    this.acc = 0; this.ooo = 0;
    this.lat = LAT.fixedMs; this.maxLat = 0; this.latViol = 0; this.lb = 0;   // p99 지연 · 최대 · 10ms 초과 측정 수 · 부하 분산 핸드오버
  }
  get kindLabel() { return KIND[this.kind] ?? this.kind; }
  get servCell() { return this.serv != null ? this.net.plan.cells[this.serv] : null; }
}

export class Private5G {
  constructor(sim) {
    this.sim = sim; this.on = sim.mode.key !== 'traditional' && !sim.twin;
    this.ues = []; this.t = 0; this.next = 0; this.rng = 0x5eed5;
    this.stats = { ho: 0, hoFail: 0, pingpong: 0, rlf: 0, sent: 0, delivered: 0, lost: 0, fwd: 0, hoMs: 0, bytes: 0, lbHo: 0, lbBlock: 0, latViol: 0, latSamples: 0, maxLat: 0 };
    this.lbOn = true; this.nextLb = 0;   // 부하 분산 (MLB) 켜짐
    this.log = [];
    if (!this.on) return;
    this.plan = plan5G(sim);
    this.cellStats = this.plan.cells.map(() => ({ rx: 0, rxB: 0, hoIn: 0, hoOut: 0, hoFail: 0, to: new Map() }));   // 기지국별 업링크 수신·핸드오버 (배치는 캐시 공유라 통계는 시뮬레이션마다 따로)
    const add = (id, uid, kind, pos) => this.ues.push(new UE(this, id, uid, kind, pos));
    for (const c of sim.carriers) add(c.id, c.uid, 'carrier', () => ({ x: c.x, y: UE_Y, z: c.z, m: c }));
    for (const v of sim.vehicles) if (v.kind === 'agv') add(v.id, v.uid, 'agv', () => ({ x: v.x, y: UE_Y, z: v.z, m: v }));
    for (const f of sim.forklifts ?? []) if (f.auto) add(f.id, f.uid, 'forklift', () => ({ x: f.x, y: 1.6, z: f.z, m: f }));
    for (const h of [...sim.helpers, ...sim.techs.filter((t) => t.kind === 'humanoid')]) add(h.id, h.uid, 'humanoid', () => ({ x: h.x, y: 1.5, z: h.z, m: h }));
    for (const q of sim.quads) add(q.id, q.uid, 'quadruped', () => ({ x: q.x, y: 0.6, z: q.z, m: q }));
    for (const d of sim.drones ?? []) add(d.id, d.uid, 'drone', () => ({ x: d.x, y: Math.max(0.3, d.y), z: d.z, m: d }));
    for (const st of sim.processing) (st.ammr ?? []).forEach((u, i) => add(`${st.name} AMMR #${i + 1}`, st.robotUids?.[i] ?? `${st.id}-${i + 1}`, 'ammr', () => ({ x: st.x + (u.side ?? 0) * 1.1, y: 1.3, z: st.z, u })));
    this.byMover = new Map(this.ues.map((u) => [u.pos().m ?? u.pos().u, u]));
    for (const u of this.ues) this.measure(u, true);
  }
  ueOf(obj) { return this.byMover?.get(obj) ?? null; }
  // 단말 추가 (시험·증설 검토용: 로봇을 더 들였을 때) — pos()는 { x, y, z, m }
  addUE(id, uid, kind, pos) { const u = new UE(this, id, uid, kind, pos); this.ues.push(u); this.measure(u, true); u.mbps = this.demand(u); this.admit(u); return u; }
  // 단말 업링크 수요(Mbps): 움직이거나 일하는 중이면 카메라 영상 전부, 쉬는 중이면 10%
  demand(u) {
    const p = u.pos(), m = p.m, L = UE_LOAD[u.kind] ?? { mbps: 1 };
    const active = m ? (m.moving || (m.task && !m.chgNow && !m.charging) || m.state === 'line' || m.mode === 'mission' || m.mode === 'patrol') : true;
    return TELE_MBPS + (active ? L.mbps : 0);   // 쉬는 중(주차·충전·대기)은 영상을 끄고 텔레메트리만
  }
  cellOf(u) { return u.hoUntil >= 0 ? u.hoTarget : u.serv; }   // 핸드오버 중인 단말은 옮겨 갈 셀 부하로 센다 (DAPS라 패킷은 끊기지 않음)
  // 셀별 지연 (지금 접속 단말 기준) — extra: 이 셀에 단말 하나를 더하거나(+) 뺄 때(−) 예상
  cellLoad(idx, add = null, remove = null) {
    const list = [];
    for (const u of this.ues) { if (u === remove) continue; if (this.cellOf(u) === idx) list.push({ mbps: u.mbps ?? this.demand(u), se: specEff(ulSinr(u.F[idx])) }); }
    if (add) list.push({ mbps: add.mbps ?? this.demand(add), se: specEff(ulSinr(add.F[idx] ?? -110)) });
    return cellLatency(list);
  }
  // 셀의 임계 대수 (지금 단말 구성·SINR로 p99 ≤ 10ms를 지키는 최대 대수): 평균 단말을 하나씩 더해 본다
  cellCapacity(idx) {
    const us = this.ues.filter((u) => this.cellOf(u) === idx), base = us.map((u) => ({ mbps: u.mbps ?? this.demand(u), se: specEff(ulSinr(u.F[idx])) }));
    const avg = base.length ? { mbps: base.reduce((a, b) => a + b.mbps, 0) / base.length, se: base.reduce((a, b) => a + b.se, 0) / base.length } : { mbps: UE_LOAD.carrier.mbps, se: specEff(ulSinr(NR.design)) };
    let n = 0; while (n < 400 && cellLatency(Array.from({ length: n + 1 }, () => avg)).p99 <= LAT.req) n++;
    return { max: n, now: us.length, avgMbps: avg.mbps };
  }
  // 부하 분산 (MLB, 3GPP SON): p99가 목표(9ms)를 넘거나 임계 대수를 넘는 셀에서, 이웃 셀 신호가 충분하고(≥ −95dBm)
  // 옮겨도 이웃 셀 p99가 목표 안인 단말을 골라 이웃 셀로 핸드오버(DAPS) — 신호 손해가 가장 작은 단말부터
  balance() {
    const cells = this.plan.cells, loads = cells.map((_, i) => this.cellLoad(i));
    this.cellLat = loads;
    for (let i = 0; i < cells.length; i++) {
      if (loads[i].p99 <= LAT.target) continue;
      const cands = [];
      for (const u of this.ues) {
        if (u.serv !== i || u.hoUntil >= 0) continue;
        for (let n = 0; n < cells.length; n++) {
          if (n === i || u.F[n] < -95) continue;
          const after = this.cellLoad(n, u);
          if (after.p99 > LAT.target) continue;
          cands.push({ u, n, loss: u.F[i] - u.F[n], after });
        }
      }
      cands.sort((a, b) => a.loss - b.loss);
      // 목표 지연 안으로 들어올 때까지 한 번에 여러 대 (같은 단말 · 다시 꽉 찬 이웃 셀은 건너뜀)
      const moved = new Set();
      for (const c of cands) {
        if (loads[i].p99 <= LAT.target) break;
        if (moved.has(c.u) || this.cellLoad(c.n, c.u).p99 > LAT.target) continue;
        moved.add(c.u); c.u.lbHold = { from: i, until: this.sim.time + 5 }; this.startHO(c.u, c.n, 'load'); this.stats.lbHo++; c.u.lb++;
        loads[i] = this.cellLoad(i); loads[c.n] = this.cellLoad(c.n);
      }
    }
  }
  // 접속(RRC 연결) 수락 제어: 가장 센 셀이 받으면 목표를 넘으면, 신호가 충분한(≥ −95dBm) 다른 셀 중 여유 있는 셀로 연결
  admit(u) {
    if (!this.lbOn || this.cellLoad(u.serv, u).p99 <= LAT.target) return;
    const alt = [...u.F.keys()].filter((n) => n !== u.serv && u.F[n] >= -95).sort((a, b) => u.F[b] - u.F[a]).find((n) => this.cellLoad(n, u).p99 <= LAT.target);
    if (alt != null) { u.lbHold = { from: u.serv, until: this.sim.time + 5 }; u.serv = alt; this.stats.lbAdmit = (this.stats.lbAdmit ?? 0) + 1; }
  }
  noise() { this.rng = (this.rng * 1103515245 + 12345) & 0x7fffffff; return (this.rng / 0x7fffffff - 0.5) * 3; }   // 측정 잡음 ±1.5dB (별도 난수 — 시뮬레이션 난수 순서를 바꾸지 않음)
  // 셀 n의 RSRP: 바닥 로봇은 셀별 RSRP 지도, 드론(설비 위 비행)은 3D 거리 LOS 경로손실
  level(n, p) {
    const c = this.plan.cells[n], G = this.plan.grid;
    if (p.y > 3) return RE_DBM + NR.gainDbi - pathLoss(Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z), true);
    const ix = Math.max(0, Math.min(G.nx - 1, Math.round(p.x - G.x0))), iz = Math.max(0, Math.min(G.nz - 1, Math.round(p.z - G.z0)));
    return c.map[ix * G.nz + iz];
  }
  // 모든 셀 RSRP 측정 → L3 필터 (k=4, a=0.5)
  measure(u, first = false) {
    const p = u.pos(), cells = this.plan.cells;
    let bi = 0;
    for (let n = 0; n < cells.length; n++) {
      const m = this.level(n, p) + this.noise();
      u.F[n] = first ? m : 0.5 * u.F[n] + 0.5 * m;
      if (u.F[n] > u.F[bi]) bi = n;
    }
    if (first || u.serv == null) { u.serv = bi; }
    // 서빙 셀 SINR (인접 셀 50% 부하 간섭)
    let I = 0; for (let n = 0; n < cells.length; n++) if (n !== u.serv) I += dbm2mw(u.F[n]) * NR.load;
    u.rsrp = u.F[u.serv]; u.sinr = u.rsrp - mw2dbm(I + dbm2mw(NOISE));
    u.nbr = bi !== u.serv ? bi : [...u.F.keys()].filter((n) => n !== u.serv).sort((a, b) => u.F[b] - u.F[a])[0];
    return bi;
  }
  update(dt) {
    if (!this.on || !this.ues.length) return;
    const s = this.sim; this.t = s.time;
    const meas = s.time >= this.next; if (meas) this.next = s.time + NR.period;
    for (const u of this.ues) {
      // 업링크 트래픽: 10Hz 상태(위치·작업·배터리) OPC UA PubSub 델타 프레임 (약 320B, MQTT QoS 1)
      u.acc += dt * 10;
      while (u.acc >= 1) { u.acc -= 1; this.uplink(u, 320); }
      if (u.hoUntil >= 0) {   // 핸드오버 실행 중: 타깃 셀 RACH·경로 전환 끝나면 버퍼 포워딩
        if (s.time >= u.hoUntil) this.completeHO(u);
        continue;
      }
      if (!meas) continue;
      const bi = this.measure(u);
      u.mbps = this.demand(u);
      const cells = this.plan.cells;
      // A3: 인접 셀이 서빙 셀보다 3dB 넘게 강한 상태가 TTT(160ms) 이어지면 핸드오버 (TTT 동안 대상이 바뀌면 다시 셈)
      // 수락 제어: 옮겨 갈 셀이 이 단말을 받으면 p99가 목표(9ms)를 넘는 경우 거절 — 서빙 신호가 서비스 최소(−100dBm) 아래면 예외.
      // 부하 분산으로 옮긴 단말은 5초 동안 원래(혼잡) 셀로 A3 복귀하지 않는다 (핑퐁 방지)
      const held = u.lbHold && this.sim.time < u.lbHold.until && u.lbHold.from === bi;
      if (bi !== u.serv && u.F[bi] > u.F[u.serv] + NR.a3 && !held) {
        if (u.cand !== bi) { u.cand = bi; u.tttT = 0; }
        u.tttT += NR.period;
        if (u.tttT >= NR.ttt - 1e-9) {
          if (this.lbOn && u.F[u.serv] >= NR.require && this.cellLoad(bi, u).p99 > LAT.target) { this.stats.lbBlock++; u.tttT = 0; }
          else this.startHO(u, bi);
        }
      } else { u.cand = null; u.tttT = 0; }
      // 무선 링크 실패 감시 (Qout −112dBm 1초) — 음영지역이 없으면 일어나지 않아야 한다
      if (u.F[u.serv] < NR.rlf) { u.weak += NR.period; if (u.weak >= 1) { u.rlf++; this.stats.rlf++; u.weak = 0; u.serv = bi; } } else u.weak = 0;
      void cells;
    }
    if (meas) {
      if (this.lbOn) this.balance();   // 측정마다(100ms) 부하 분산 — 목표(9ms)를 넘는 셀만
      this.sampleLatency();
    }
  }
  // 지연 측정 (100ms마다): 단말마다 서빙 셀 p99 지연 — 10ms 초과 수를 센다 (DAPS라 핸드오버 중에도 소스 셀 지연)
  sampleLatency() {
    const cells = this.plan.cells, L = cells.map((_, i) => this.cellLoad(i)); this.cellLat = L;
    for (const u of this.ues) {
      const l = L[this.cellOf(u)]?.p99 ?? LAT.fixedMs, hoPenalty = u.hoUntil >= 0 && !NR.daps ? u.hoMs : 0;
      u.lat = l + hoPenalty; u.maxLat = Math.max(u.maxLat, u.lat);
      this.stats.latSamples++; this.stats.maxLat = Math.max(this.stats.maxLat, u.lat);
      if (u.lat > LAT.req) { u.latViol++; this.stats.latViol++; }
    }
  }
  startHO(u, target, reason = 'a3') {
    const s = this.sim, c0 = this.plan.cells[u.serv], c1 = this.plan.cells[target];
    const ms = NR.hoMs[0] + (this.noise() + 1.5) / 3 * (NR.hoMs[1] - NR.hoMs[0]);
    u.hoTarget = target; u.hoUntil = s.time + ms / 1000; u.hoFrom = u.serv; u.hoT0 = s.time; u.hoMs = ms;
    u.hoRec = { t: s.time, from: c0.pci, to: c1.pci, fromId: c0.id, toId: c1.id, rsrpFrom: Math.round(u.F[u.serv] * 10) / 10, rsrpTo: Math.round(u.F[target] * 10) / 10, ms: Math.round(ms), fwd: 0, ok: true, reason, daps: NR.daps };
    u.cand = null; u.tttT = 0;
  }
  completeHO(u) {
    const s = this.sim, r = u.hoRec;
    if (u.F[u.hoTarget] < NR.rlf) { r.ok = false; this.stats.hoFail++; this.cellStats[u.hoFrom].hoFail++; }   // 타깃 셀이 너무 약하면 실패 (재설정)
    // 핸드오버 동안 PDCP 버퍼에 쌓인 패킷 → Xn 데이터 포워딩으로 타깃 셀이 순서대로 전달 (유실 없음)
    r.fwd = u.buf; u.fwd += u.buf; this.stats.fwd += u.buf;
    u.maxDelay = Math.max(u.maxDelay, u.hoMs + 4);
    while (u.buf > 0) { u.buf--; u.delivered++; this.stats.delivered++; }
    const back = u.hos[0] && u.hos[0].from === r.to && s.time - u.hos[0].t < 1;
    if (back) { u.pingpong++; this.stats.pingpong++; }
    this.cellStats[u.hoFrom].hoOut++; this.cellStats[u.hoFrom].to.set(u.hoTarget, (this.cellStats[u.hoFrom].to.get(u.hoTarget) ?? 0) + 1); this.cellStats[u.hoTarget].hoIn++; this.cellStats[u.hoTarget].rx += r.fwd; this.cellStats[u.hoTarget].rxB += r.fwd * 320;
    u.serv = u.hoTarget; u.hoUntil = -1; u.hoTarget = null; u.hoN++; this.stats.ho++; this.stats.hoMs += r.ms;
    u.hos.unshift(r); if (u.hos.length > 20) u.hos.pop();
    this.log.unshift({ ...r, ue: u.uid ?? u.id }); if (this.log.length > 60) this.log.pop();
  }
  // MQTT PUBLISH (QoS 1) 한 건: 핸드오버 중이면 PDCP 버퍼, 아니면 바로 브로커 도착(PUBACK)
  uplink(u, bytes) {
    u.seq++; u.sent++; u.bytes += bytes; this.stats.sent++; this.stats.bytes += bytes;
    if (u.hoUntil >= 0 && !NR.daps) { u.buf++; return; }   // DAPS가 아니면 핸드오버 동안 버퍼 (끊김) — DAPS는 소스 셀로 계속 보낸다
    if (u.F[u.serv] < NR.rlf) { u.buf++; return; }   // 링크가 약하면 재전송 대기 (QoS 1) — 붙으면 보낸다
    u.delivered++; this.stats.delivered++;
    const cs = this.cellStats[u.serv]; cs.rx++; cs.rxB += bytes;
  }
  // DataHub(AAS → OPC UA → MQTT) 메시지가 이동 로봇에서 나갈 때 — 그 로봇의 5G 모뎀으로 보낸다
  publish(mover, bytes) { const u = this.ueOf(mover); if (u) this.uplink(u, bytes); return u; }
  // 기지국 한 대의 현재 상태 (기지국을 누르면 나오는 창)
  cellInfo(idx) {
    const P = this.plan, c = P.cells[idx], S = this.cellStats[idx];
    let n = 0, sum = 0, min = Infinity, sinr = 0;
    P.pts.forEach((p, i) => { if (P.server[i] === idx) { n++; sum += P.best[i]; min = Math.min(min, P.best[i]); sinr += P.sinr[i]; } });
    const ues = this.ues.filter((u) => (u.hoUntil >= 0 ? u.hoTarget : u.serv) === idx);
    return { c, S, area: n * 4, avgRsrp: n ? sum / n : NaN, minRsrp: min, avgSinr: n ? sinr / n : NaN, ues, lat: this.cellLoad(idx), cap: this.cellCapacity(idx),
      neighbors: c.neighbors.map((k) => ({ c: P.cells[k], border: c.border[k] * 2, conflict: P.cells[k].pci % 3 === c.pci % 3, hoTo: S.to.get(k) ?? 0 })),
      log: this.log.filter((h) => h.fromId === c.id || h.toId === c.id).slice(0, 8) };
  }
  summary() {
    const S = this.stats, inflight = this.ues.reduce((a, u) => a + u.buf, 0);
    const L = this.cellLat ?? [], worst = L.reduce((a, l) => Math.max(a, l.p99), 0);
    return { ues: this.ues.length, ho: S.ho, hoFail: S.hoFail, hoOk: S.ho ? (S.ho - S.hoFail) / S.ho : 1, pingpong: S.pingpong, rlf: S.rlf, avgHoMs: S.ho ? S.hoMs / S.ho : 0,
      lbHo: S.lbHo, lbBlock: S.lbBlock, latViol: S.latViol, latSamples: S.latSamples, maxLat: S.maxLat, worstCellP99: worst, daps: NR.daps,
      sent: S.sent, delivered: S.delivered, inflight, lost: S.sent - S.delivered - inflight, fwd: S.fwd, bytes: S.bytes };
  }
}
export const STACK = 'AAS(IDTA) 서브모델 → OPC UA PubSub JSON(ua-data) → MQTT 3.1.1 QoS 1 → 5G NR n79(4.75GHz) 업링크 → 5GC UPF → MQTT 브로커';
