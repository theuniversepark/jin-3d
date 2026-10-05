// 입고: 공급사 화물트럭이 원자재·부품 팔레트를 싣고 와 물류존(왼쪽 확장동) 옆 왼쪽 벽 입고 도크에 후진 접안하면,
// 입고 지게차가 팔레트를 하나씩 내려 자재창고 랙(원자재)·부품 랙(부품)에 넣는다. 다 내리면 트럭은 떠난다.
// WMS가 창고 재고(재고 + 발주·운송 중)가 재주문점 아래로 떨어지면 트럭을 발주하고, 리드타임 뒤 트럭이 들어온다.
// 자재 공급 차질 중에는 공급사 납품이 멈춰 트럭이 오지 않는다. 창고 재고는 AGV(자재 투입)·휴머노이드(셀 부품)가 꺼내 쓴다.
// 렌더링과 분리되어 헤드리스 시뮬레이션에서도 같은 흐름으로 동작한다.
import { Truck, YARD } from './shipping.js';

export const INBOUND = {
  wallX: -51, dockZ: -14.5,          // 입고 도크: 왼쪽 확장동 벽(x −51) 문 중심
  roadX: -69, roadZ: -40, waitZ: -28, // 야드 남북 도로(x −69 부근)와 동서 진입로(z −40)
  pallets: 4,                          // 트럭 1대 팔레트 수
  // 입고 지게차 운행 구간(확장동 왼쪽 벽을 따라 남북으로 난 진한 회색 통로): 도크 ↔ 물류 선반 서쪽 면(입고 칸) ↔ 대기 주차 칸.
  // 물류 선반은 이 통로와 자재 투입존 왼쪽 로봇 통로(x −35.5) 사이에 남북으로 서 있는 통과형 선반 —
  // 지게차는 서쪽 면에 넣고, AGV·휴머노이드는 동쪽 면에서 꺼낸다. 다른 이동체 경로는 이 통로를 지나지 않는다
  zone: { x0: -50.8, z0: -18.6, x1: -46.4, z1: 4.3 },
  park: { x: -48.6, z: -17.6, heading: Math.PI },   // 입고 지게차 대기 주차 (통로 북쪽 끝 뒷벽 쪽, 북쪽을 향해 반듯이)
};
// 물류 선반 위치: 입고 지게차 통로(x −50.8 ~ −46.4)와 로봇 통로(x −35.5) 사이, 남북으로 (길이 10.2m · 깊이 2.1m)
// 서쪽 면(x −46.25) = 지게차 입고, 동쪽 면(x −44.15) = AGV·휴머노이드 출고
export const WH_RACK = { x: -45.2, z: -1.6 };
// 물류 선반(자재창고 랙): 왼쪽 2열 × 3단 = 원자재 6칸, 오른쪽 2열 × 3단 = 부품 6칸. 한 칸 = 입고 팔레트 1개
// 선반이 거의 비면(재주문점) 트럭을 발주하고, 트럭이 도착해 다시 채운다 — 채움 → 배달로 줄어듦 → 소진 직전 재입고의 순환
export const WH = {
  rawPallet: 40, partsPallet: 240,     // 입고 팔레트 1개 = 선반 1칸 (원자재 박스 2단 = AGV 2회분 · 부품 빈 6개)
  slots: 6,                            // 자재별 선반 칸 수
  rawCap: 240, partsCap: 1440,         // 선반 가득 (6칸)
  rawReorder: 80, partsReorder: 360,   // 재주문점 — 선반 1.5~2칸 남으면 발주 (재고 + 발주·운송분)
  rawTarget: 240, partsTarget: 1440,   // 발주 목표: 선반 가득
  lead: 60,                            // 발주 → 트럭 출발까지 (시뮬레이션 초)
};
const DOCK_X = INBOUND.wallX - YARD.truckLen / 2 - 0.15;   // 접안 트럭 중심 (뒤쪽 끝이 벽 바로 바깥)
const NB = INBOUND.roadX - 1.5, SB = INBOUND.roadX + 1.5;  // 북행(입차) · 남행(출차) 차로

export class InboundYard {
  constructor(sim) {
    this.sim = sim; this.trucks = []; this.orders = []; this.seq = 0;
    this.stats = { trucks: 0, raw: 0, parts: 0 };
  }
  get docked() { return this.trucks.find((t) => t.state === 'dock'); }
  get dockBusy() { return this.trucks.some((t) => t.state === 'dock' || t.state === 'toDock' || (t.state === 'depart' && t.z > -24)); }
  // 운송 중·도착 대기 중인 팔레트 (발주분 포함)
  onOrder(type) {
    const n = (list) => list.filter((p) => p === type).length;
    return this.orders.reduce((a, o) => a + n(o.pallets), 0) + this.trucks.filter((t) => t.state !== 'depart').reduce((a, t) => a + n(t.pallets) , 0);
  }
  update(dt) {
    const s = this.sim;
    // WMS 발주: 원자재·부품 재고(+발주분)가 재주문점 아래면 트럭 1대분을 발주한다 (동시에 2대까지)
    const rawPos = s.whRaw + this.onOrder('raw') * WH.rawPallet;
    const partsPos = s.partsTracked ? s.whParts + this.onOrder('parts') * WH.partsPallet : Infinity;
    if ((rawPos < WH.rawReorder || partsPos < WH.partsReorder) && this.orders.length + this.trucks.filter((t) => t.state !== 'depart').length < 2) {
      // 필요한 만큼만 싣는다 (목표 재고까지 모자란 팔레트 수, 트럭 4팔레트 한도 — 더 모자란 쪽 우선)
      // 재주문점 가까이(1.5배 이하) 내려온 자재만 싣는다 — 자재마다 선반이 비었다 다시 차는 순환이 보이도록
      let raw = rawPos < WH.rawReorder * 1.5 ? Math.max(0, Math.ceil((WH.rawTarget - rawPos) / WH.rawPallet)) : 0;
      let parts = s.partsTracked && partsPos < WH.partsReorder * 1.5 ? Math.max(0, Math.ceil((WH.partsTarget - partsPos) / WH.partsPallet)) : 0;
      while (raw + parts > INBOUND.pallets) { if (raw / WH.rawTarget * WH.rawPallet > parts / WH.partsTarget * WH.partsPallet) raw--; else parts--; }
      if (raw + parts === 0) raw = 1;
      const pallets = [...Array(raw).fill('raw'), ...Array(parts).fill('parts')];
      this.orders.push({ t: s.time, due: s.time + WH.lead, pallets });
      s.erp?.purchase(this.orders.at(-1));   // Odoo: 구매오더 확정 + 입고 예정
      s.log('plan', 'WMS 자재 발주', { obs: `창고 원자재 ${s.whRaw}개${s.partsTracked ? ` · 부품 ${s.whParts}개` : ''} (발주 포함 재주문점 미달)`, act: `공급사 트럭 1대 — 원자재 ${raw}팔레트${parts ? ` · 부품 ${parts}팔레트` : ''}` });
    }
    // 납기 도래 발주 → 트럭 출발 (공급 차질 중에는 납품 지연)
    for (const o of this.orders) {
      if (o.sent || s.time < o.due || s.supplyDisrupted) continue;
      o.sent = true;
      const t = new Truck(`입고트럭-${++this.seq}`, -111, INBOUND.roadZ - 1.5, Math.PI / 2);
      t.pallets = [...o.pallets]; t.load = t.pallets.length; t.inbound = true;
      t.go([{ x: NB - 4, z: INBOUND.roadZ - 1.5 }, { x: NB, z: INBOUND.roadZ + 3 }, { x: NB, z: INBOUND.waitZ }], 'arrive');
      this.trucks.push(t); s.erp?.dispatched(o, t);
    }
    this.orders = this.orders.filter((o) => !o.sent);
    for (const t of this.trucks) {
      if (!t.update(dt)) continue;
      if (t.state === 'arrive') t.state = 'wait';
      else if (t.state === 'toDock') { t.state = 'dock'; t.x = DOCK_X; t.z = INBOUND.dockZ; t.heading = -Math.PI / 2;   // 도크에 반듯이 정렬
        s.log('info', `${t.id} 입고 도크 접안`, { obs: `원자재 ${t.pallets.filter((p) => p === 'raw').length}팔레트 · 부품 ${t.pallets.filter((p) => p === 'parts').length}팔레트`, act: '입고 지게차 하차 시작' }); }
      else if (t.state === 'depart') t.state = 'gone';
    }
    this.trucks = this.trucks.filter((t) => t.state !== 'gone');
    // 대기 트럭 → 빈 도크로 후진 접안: 북쪽으로 도크 앞을 지나 서쪽으로 돌아 도크 중심선(z = 도크) 위에 반듯이 선 뒤,
    // 그 선을 따라 곧게 후진해 적재함 뒤를 도크 문에 맞춘다 (출하 도크와 같은 방식)
    const w = this.trucks.find((t) => t.state === 'wait');
    if (w && !this.dockBusy) w.go([
      { x: NB, z: INBOUND.dockZ + 4.5 }, { x: NB - 2.5, z: INBOUND.dockZ + 4.2 }, { x: NB - 7, z: INBOUND.dockZ + 2.2 }, { x: NB - 11, z: INBOUND.dockZ + 0.4 }, { x: NB - 15, z: INBOUND.dockZ },
      { x: DOCK_X - 8, z: INBOUND.dockZ, rev: true }, { x: DOCK_X, z: INBOUND.dockZ, rev: true },
    ], 'toDock');
    // 다 내린 트럭은 출차 (남행 차로 → 진입로 → 서쪽)
    const d = this.docked;
    if (d && !d.pallets.length && !(d.reserved > 0)) {
      s.erp?.receiptDone(d);   // Odoo: 입고 확정 (검수 완료)
      d.go([{ x: SB + 3, z: INBOUND.dockZ }, { x: SB, z: INBOUND.dockZ - 5 }, { x: SB, z: INBOUND.roadZ + 1.5 }, { x: SB - 5, z: INBOUND.roadZ + 1.5 }, { x: -113, z: INBOUND.roadZ + 1.5 }], 'depart');
      this.stats.trucks++;
      s.log('ok', `${d.id} 하차 완료 · 출차`, { obs: `창고 원자재 ${s.whRaw}개${s.partsTracked ? ` · 부품 ${s.whParts}개` : ''}`, act: '입고 도크 비움' });
    }
  }
}

// 입고 지게차 작업 배정 — 접안한 트럭에서 팔레트 하나를 내려 창고 랙에 넣는다 (랙이 차 있어도 랙 앞 임시 적치로 받아 트럭을 묶어 두지 않는다)
export function planReceiver(sim, f) {
  const t = sim.inbound.docked; if (!t) return false;
  const k = t.pallets.length - 1 - (t.reserved ?? 0); if (k < 0) return false;
  const type = t.pallets[k];
  t.reserved = (t.reserved ?? 0) + 1;
  const legacy = sim.mode.key === 'traditional';
  // 도크 앞(벽에서 2.7m)에서 트럭 쪽을 보고 서서 포크를 적재함 높이로 올린 뒤 들어가 팔레트를 들고, 포크를 올린 채 반듯이 후진해 나온 뒤 돈다
  const dock = { x: INBOUND.wallX + 2.7, z: INBOUND.dockZ, aisle: 'B', name: '입고 도크' };
  const inside = { x: INBOUND.wallX + 0.6, z: INBOUND.dockZ, aisle: 'B', name: `${t.id} 적재함` };
  const put = type === 'raw' ? sim.loc.WH_IN : sim.loc.WH_PARTS_IN;   // 선반 서쪽 면의 원자재(남쪽)·부품(북쪽) 칸
  const name = type === 'raw' ? '원자재' : '부품';
  f.setTask(`${name} 팔레트 하차 ← ${t.id}`, [
    { go: dock, via: [] },
    { go: inside, via: [] },
    { wait: legacy ? 7 : 4, done: () => { t.pallets.splice(t.pallets.lastIndexOf(type), 1); t.reserved = Math.max(0, t.reserved - 1); t.load = t.pallets.length; f.load = { type, n: type === 'raw' ? WH.rawPallet : WH.partsPallet }; } },
    { go: dock, via: [], rev: true },
    { go: put, via: [{ x: put.x, z: Math.min(put.z - 3, INBOUND.dockZ + 2) }] },   // 지게차 통로를 따라 남쪽으로 곧게 내려가 선반 서쪽 면에 넣는다
    { wait: legacy ? 6 : 4, done: () => {
      if (type === 'raw') { sim.whRaw += WH.rawPallet; sim.inbound.stats.raw += WH.rawPallet; }
      else { sim.whParts += WH.partsPallet; sim.inbound.stats.parts += WH.partsPallet; }
      sim.erp?.received(t, type, type === 'raw' ? WH.rawPallet : WH.partsPallet);
      f.load = null;
    } },
    // 대기 주차: 통로 북쪽 끝 주차 칸 — 칸 남쪽 앞(칸 중심선)으로 갔다가 북쪽으로 곧게 들어가 반듯이 선다
    { go: { ...f.home, z: f.home.z + 3 }, via: [] },
    { go: f.home, via: [] },
  ]);
  return true;
}
