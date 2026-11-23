// 화면 보간 — 시뮬레이션은 0.1초 고정 간격으로만 진행하고(같은 시드면 컴퓨터·화면 주사율과 상관없이 같은 결과),
// 그 사이 프레임은 직전 간격과 지금 간격의 위치·진행률을 섞어 그린다. 1배속 60fps면 6프레임마다 한 간격이라 그대로 그리면 23cm씩 끊겨 보인다.
// 쓰는 법: 프레임의 마지막 간격 직전에 capture(대상) → 그리기 전 apply(대상, 남은 비율) → 그린 뒤 restore(). 시뮬레이션 값은 그리는 동안만 바뀌고 바로 돌아온다.
// 대상: x·y·z(이동체) · progress(셀 진행률). 크게 뛴 값(순간 이동 3m 넘음 · 진행률이 되돌아감 = 다음 사이클)은 섞지 않는다.
// 저장된 값만 섞는다 — 트럭(shipping.js Truck)처럼 x·z가 계산 속성(야드 좌표 lx·lz → 월드 좌표)이면 x·z 대신 lx·lz를 섞는다.
//   계산 속성에 섞은 값을 쓰면 setter가 월드 좌표를 야드 좌표 자리에 넣어 트럭이 건물 안으로 들어가고, 되돌릴 때 실제 위치까지 망가졌다
const JUMP2 = 9;
const isData = (o, k) => { for (let p = o; p; p = Object.getPrototypeOf(p)) { const d = Object.getOwnPropertyDescriptor(p, k); if (d) return 'value' in d && d.writable !== false; } return false; };
// 좌표 키 [x, y, z, progress] — 저장된 값이 아니면 l접두 저장 값(lx …), 그것도 없으면 null(섞지 않음)
const keysOf = (o) => ['x', 'y', 'z', 'progress'].map((k) => (isData(o, k) ? k : k !== 'progress' && isData(o, `l${k}`) ? `l${k}` : null));
export class StepInterp {
  constructor() { this.prev = new WeakMap(); this.saved = []; }
  capture(objs) {
    this.prev = new WeakMap();
    for (const o of objs) if (o) { const K = keysOf(o); this.prev.set(o, { K, v: K.map((k) => (k ? o[k] : undefined)) }); }
  }
  apply(objs, a) {
    this.restore();
    if (!(a >= 0 && a < 1)) return;   // a = 0도 섞는다(= 직전 간격 위치) — 0에서 현재 위치를 그리면 다음 프레임에 직전 위치로 돌아가 뒤로 튄다
    for (const o of objs) {
      const P = o && this.prev.get(o); if (!P) continue;
      const { K, v: p } = P, cur = K.map((k) => (k ? o[k] : undefined)), out = cur.slice();
      if (Number.isFinite(cur[0]) && Number.isFinite(cur[2]) && Number.isFinite(p[0]) && Number.isFinite(p[2]) && (cur[0] - p[0]) ** 2 + (cur[2] - p[2]) ** 2 <= JUMP2) {
        for (let i = 0; i < 3; i++) if (Number.isFinite(cur[i]) && Number.isFinite(p[i])) out[i] = p[i] + (cur[i] - p[i]) * a;
      }
      if (Number.isFinite(cur[3]) && Number.isFinite(p[3]) && cur[3] >= p[3]) out[3] = p[3] + (cur[3] - p[3]) * a;
      if (!out.some((x, i) => x !== cur[i])) continue;
      this.saved.push([o, K, cur]);
      K.forEach((k, i) => { if (k && out[i] !== cur[i]) o[k] = out[i]; });
    }
  }
  restore() {
    for (const [o, K, cur] of this.saved) K.forEach((k, i) => { if (k && cur[i] !== undefined) o[k] = cur[i]; });
    this.saved.length = 0;
  }
}
