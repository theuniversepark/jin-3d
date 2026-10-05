// 출하: 구분 적재장에 포장 완제품이 쌓이면 출하 지게차가 팔레트 단위로 실어 뒷벽 출하 도크 문을 지나
// 건물 밖 트럭 야드의 화물트럭에 상차한다. 트럭이 가득 차면 출발하고, 대기하던 트럭이 빈 도크로 후진 접안하며,
// 새 트럭이 대기 자리로 들어온다. 렌더링과 분리되어 헤드리스 시뮬레이션에서도 같은 흐름으로 동작한다.

// 트럭 야드 배치 (뒷벽 z = -20 바깥): 도크 2개(벽 기둥 x 18·27·36 사이), 가운데 대기 자리, z -40 진출입 도로
export const YARD = {
  wallZ: -20, bays: [22.5, 31.5], waitX: 27, roadZ: -40,
  truckLen: 10.5, truckW: 2.5, cap: 32,      // 트럭 길이·폭(m), 적재 용량(개 = 팔레트 4개 × 8개)
  pallet: 8,                                   // 지게차 1회 운반량 (팔레트 1개)
};
const DOCK_Z = YARD.wallZ - YARD.truckLen / 2 - 0.15;   // 접안 트럭 중심 (뒤쪽 끝이 벽 바로 바깥)
const WAIT_Z = DOCK_Z - 2;
const FWD = 4.2, REV = 1.8;                    // 전진·후진 속도 (m/s)

// 트럭: 위치(x,z)는 차체 중심, heading은 운전석이 향하는 방향 (이동체와 같은 규약: 0 = +z)
export class Truck {
  constructor(id, x, z, heading) { Object.assign(this, { id, x, z, heading, load: 0, by: {}, state: 'arrive', route: [], bay: null }); }
  // 경로점: { x, z, rev } — rev면 후진 (차체 방향은 진행 반대)
  go(points, state) { this.route = points.map((p) => ({ ...p })); this.state = state; }
  update(dt) {
    let rem = dt;
    while (rem > 0 && this.route.length) {
      const p = this.route[0], dx = p.x - this.x, dz = p.z - this.z, d = Math.hypot(dx, dz);
      const v = p.rev ? REV : FWD;
      if (d < 1e-3) { this.route.shift(); continue; }
      // 차체 방향은 진행 방향(후진이면 반대)으로 부드럽게 돈다
      const want = Math.atan2(dx, dz) + (p.rev ? Math.PI : 0);
      let dh = ((want - this.heading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      this.heading += Math.sign(dh) * Math.min(Math.abs(dh), rem * 0.9);
      const step = Math.min(d, v * rem);
      this.x += (dx / d) * step; this.z += (dz / d) * step; rem -= step / v;
      if (step >= d - 1e-6) this.route.shift();
    }
    this.moving = this.route.length > 0;
    return !this.route.length;
  }
}

export class TruckYard {
  constructor(sim) {
    this.sim = sim; this.seq = 0; this.trucks = []; this.gone = 0;
    // 시작: 두 도크에 빈 트럭이 접안해 있고 한 대가 대기 중
    for (const bx of YARD.bays) { const t = this.spawn(bx, DOCK_Z); t.state = 'dock'; t.bay = bx; }
    const w = this.spawn(YARD.waitX, WAIT_Z); w.state = 'wait';
    this.nextArrive = null;
  }
  spawn(x, z) { const t = new Truck(`화물트럭-${++this.seq}`, x, z, Math.PI); this.trucks.push(t); return t; }
  docked(bx) { return this.trucks.find((t) => t.bay === bx && t.state === 'dock'); }
  // 지게차가 실을 트럭: 접안해 있고 자리가 남은 트럭 중 많이 실린 쪽 (빨리 채워 출발시킨다)
  loadable() { return this.trucks.filter((t) => t.state === 'dock' && t.load + (t.reserved ?? 0) < YARD.cap).sort((a, b) => b.load - a.load)[0] ?? null; }

  update(dt) {
    const s = this.sim;
    for (const t of this.trucks) {
      const arrived = t.update(dt);
      if (!arrived) continue;
      if (t.state === 'arrive') { t.state = 'wait'; s.log('info', `${t.id} 대기 자리 도착`, { obs: '출하 트럭 야드 대기' }); }
      else if (t.state === 'toDock') { t.state = 'dock'; s.log('info', `${t.id} 도크 ${this.bayNo(t.bay)} 접안`, { obs: '후진 접안 완료 · 상차 대기' }); }
      else if (t.state === 'depart') { t.state = 'gone'; }
    }
    this.trucks = this.trucks.filter((t) => t.state !== 'gone');
    // 빈 도크(앞 트럭이 충분히 빠져나감)로 대기 트럭을 넣는다
    for (const bx of YARD.bays) {
      // 떠나는 트럭이 도로까지 빠져나가 옆으로 비킨 뒤에 들어간다 (대기 트럭 경로와 겹치지 않게)
      const busy = this.trucks.some((t) => (t.bay === bx && (t.state === 'dock' || t.state === 'toDock')) || (t.state === 'depart' && t.bayLeft === bx && t.x < bx + 14));
      const w = this.trucks.find((t) => t.state === 'wait');
      if (busy || !w) continue;
      const side = Math.sign(bx - YARD.waitX);
      w.bay = bx;
      w.go([{ x: YARD.waitX, z: YARD.roadZ + 4 }, { x: bx + side * 7, z: YARD.roadZ - 1 }, { x: bx + side * 1.5, z: YARD.roadZ + 4, rev: true }, { x: bx, z: DOCK_Z - 6, rev: true }, { x: bx, z: DOCK_Z, rev: true }], 'toDock');
      this.nextArrive ??= s.time + 15;   // 대기 자리가 비면 새 트럭을 부른다
    }
    if (this.nextArrive != null && s.time >= this.nextArrive && !this.trucks.some((t) => t.state === 'wait' || t.state === 'arrive')) {
      const t = this.spawn(80, YARD.roadZ);
      t.heading = -Math.PI / 2;
      t.go([{ x: YARD.waitX + 9, z: YARD.roadZ }, { x: YARD.waitX + 2, z: YARD.roadZ - 2 }, { x: YARD.waitX, z: YARD.roadZ + 4, rev: true }, { x: YARD.waitX, z: WAIT_Z, rev: true }], 'arrive');
      this.nextArrive = null;
    } else if (this.nextArrive == null && !this.trucks.some((t) => t.state === 'wait' || t.state === 'arrive')) this.nextArrive = s.time + 15;
  }
  bayNo(bx) { return YARD.bays.indexOf(bx) + 1; }

  // 지게차가 팔레트를 트럭에 내려놓았을 때
  unload(t, n, product) {
    const s = this.sim;
    t.reserved = Math.max(0, (t.reserved ?? 0) - n);
    t.load += n; if (product) t.by[product] = (t.by[product] ?? 0) + n;
    (t.pallets ??= []).push(product ?? 'fg');   // 3D 적재함에 놓이는 팔레트 순서
    s.stats.shipped += n; s.erp?.ship(t, n, product);
    if (t.load >= YARD.cap) {
      const bx = t.bay;
      t.go([{ x: bx, z: YARD.roadZ + 3 }, { x: bx + 4, z: YARD.roadZ }, { x: 90, z: YARD.roadZ }], 'depart');
      t.bay = null; t.bayLeft = bx;
      s.stats.trucks = (s.stats.trucks ?? 0) + 1; s.erp?.shipDone(t);   // Odoo: 출고 확정
      const mix = Object.entries(t.by).map(([k, v]) => `${k === 'doortrim' ? '도어트림' : k === 'eaxle' ? 'e-axle' : k} ${v}`).join(' · ');
      s.log('ok', `${t.id} 만재 출발`, { obs: `적재 ${t.load}/${YARD.cap}개${mix ? ` (${mix})` : ''}`, act: `도크 ${this.bayNo(bx)} 비움 → 대기 트럭 접안` });
    }
  }
}

// 출하 지게차 작업 배정 — 제품 구역에 팔레트 기준 이상 쌓이면 한 팔레트씩 트럭으로 옮긴다
export function planForklift(sim, f) {
  const yard = sim.yard, m = sim.mode;
  const trigger = m.key === 'traditional' ? 16 : YARD.pallet;   // 레거시는 많이 쌓인 뒤에야 움직인다 (작업자 판단)
  let product = null, avail;
  if (sim.zone) {
    const p = ['doortrim', 'eaxle'].filter((k) => sim.fgBy[k] >= trigger).sort((a, b) => sim.fgBy[b] - sim.fgBy[a])[0];
    if (!p) return false;
    product = p; avail = sim.fgBy[p];
  } else {
    if (sim.fgStock < trigger) return false;
    avail = sim.fgStock;
  }
  const t = yard.loadable(); if (!t) return false;
  const n = Math.min(avail, YARD.pallet, YARD.cap - t.load - (t.reserved ?? 0));
  if (n <= 0) return false;
  t.reserved = (t.reserved ?? 0) + n;
  const pick = product === 'eaxle' ? sim.loc.PICK_EA : sim.loc.PICK_DT;
  // 도크 앞(벽에서 2.6m)에서 트럭 쪽을 보고 서서 포크를 적재함 높이로 올린 뒤 들어가고, 내려놓으면 포크를 넣은 채 반듯이 후진해 나온 뒤 돈다
  const bx = t.bay, dock = { x: bx, z: YARD.wallZ + 2.6, aisle: 'B', name: `출하 도크 ${yard.bayNo(bx)}` };
  const inside = { x: bx, z: YARD.wallZ + 0.7, aisle: 'B', name: `${t.id} 적재함` };   // 도크 레벨러 끝에서 포크를 적재함에 넣어 내려놓는다
  const pName = product === 'eaxle' ? 'e-axle' : product === 'doortrim' ? '도어트림' : '완제품';
  f.setTask(`${pName} 출하 → ${t.id}`, [
    { go: pick },
    { wait: m.key === 'traditional' ? 8 : 5, done: () => {
      const k = Math.min(n, product ? sim.fgBy[product] : sim.fgStock);
      if (product) sim.fgBy[product] -= k;
      sim.fgStock -= k; f.load = { type: 'fg', n: k, product };
    } },
    { go: dock },
    { go: inside, via: [] },
    { wait: m.key === 'traditional' ? 6 : 4, done: () => {
      const k = f.load?.n ?? 0; f.load = null;
      if (t.state === 'dock') yard.unload(t, k, product);
      else { sim.fgStock += k; if (product) sim.fgBy[product] += k; t.reserved = 0; }   // 그 사이 트럭이 떠났으면 되돌린다
    } },
    { go: dock, via: [], rev: true },
    // 복귀: 도크 앞 줄을 따라 곧장 옆의 대기 자리(두 출하 도크 사이)로 — 통로까지 내려갔다 올라오지 않고 지나쳤다 되돌아오지도 않는다 (서면 벽 쪽을 보고 주차)
    { go: f.home, via: [] },
  ]);
  sim.log(m.agentActive ? 'act' : 'warn', `출하 지게차 배차 → ${t.id}`, {
    obs: sim.zone ? `구분 적재장 ${pName} ${avail}개 (기준 ${trigger}개)` : `완제품 ${avail}개`,
    dec: `트럭 ${t.id} 적재 ${t.load}/${YARD.cap}개`,
    act: `${f.id} 팔레트 ${n}개 → 도크 ${yard.bayNo(bx)}`,
  });
  return true;
}
