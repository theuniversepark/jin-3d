// 구간별 성능 표시 — 프레임 루프(main.js frame)를 구간으로 나눠 CPU 시간과 그리기 호출(draw call)을 잰다
// P 키로 켜고 끔 · 꺼져 있을 때는 재지 않는다 · window.__perf.snapshot()으로 지난 측정 구간 평균·p95·p99를 돌려준다 (tools/perf-sample.cjs)
// GPU 시간은 따로 재지 않는다 — 프레임 간격(fps)이 CPU 합계보다 크게 길면 그 차이가 GPU·합성 대기
export const PERF_SECTIONS = [
  ['sim', '시뮬레이션 진행'], ['anim', '3D 동작 갱신'], ['ui', '패널·UI 갱신'], ['ep', '에피소드 기록'], ['dash', '대시보드 패널'], ['rbcam', '로봇 카메라 창'], ['cctvp', 'CCTV 영상 창'],
  ['matrix', '객체 위치 계산'], ['walls', '로봇 비전 전광판'], ['cctv', 'CCTV 전광판'], ['rec', '자동 녹화'],
  ['main', '메인 화면 렌더'], ['labels', '라벨(CSS2D)'], ['etc', '기타'],
];
const KEEP = 600;   // 최근 프레임 수 (60fps 기준 10초)

export class PerfMeter {
  constructor(getRenderer) {
    this.getRenderer = getRenderer; this.on = false;
    this.el = document.createElement('div'); this.el.id = 'perfHud'; this.el.hidden = true; document.body.appendChild(this.el);
    this.reset();
  }
  reset() { this.frames = []; this.cur = null; this.last = undefined; this.drawT = 0; }   // last도 비운다 — 남겨 두면 껐다 켠 뒤 첫 프레임 간격에 재지 않던 시간이 통째로 들어가 평균 fps가 낮게 나왔다
  toggle(v = !this.on) {
    this.on = v; this.el.hidden = !v; this.reset();
    const r = this.getRenderer(); if (r) r.info.autoReset = !v;   // 켜져 있으면 한 프레임 동안의 여러 렌더(보조 화면·후처리)를 모두 더한다
  }
  // 프레임 시작: 구간 기록을 새로 연다
  begin() {
    if (!this.on) return;
    const now = performance.now(), r = this.getRenderer();
    if (r) { r.info.autoReset = false; r.info.reset(); }
    this.cur = { t0: now, gap: this.last ? now - this.last : 0, ms: {}, calls: {}, tri: 0, callsAll: 0 };
    this.last = now;
  }
  // 구간 하나를 재며 실행 — 같은 키는 한 프레임 안에서 더한다
  run(key, fn) {
    if (!this.on || !this.cur) return fn();
    const r = this.getRenderer(), c0 = r?.info.render.calls ?? 0, t0 = performance.now();
    try { return fn(); } finally {
      const c = this.cur; c.ms[key] = (c.ms[key] ?? 0) + performance.now() - t0;
      const dc = (r?.info.render.calls ?? 0) - c0; if (dc) c.calls[key] = (c.calls[key] ?? 0) + dc;
    }
  }
  end() {
    if (!this.on || !this.cur) return;
    const c = this.cur, r = this.getRenderer(); this.cur = null;
    c.cpu = performance.now() - c.t0;
    c.ms.etc = Math.max(0, c.cpu - Object.entries(c.ms).reduce((s, [k, v]) => s + (k === 'etc' ? 0 : v), 0));
    if (r) { c.callsAll = r.info.render.calls; c.tri = r.info.render.triangles; c.geo = r.info.memory.geometries; c.tex = r.info.memory.textures; c.prog = r.info.programs?.length ?? 0; }
    this.frames.push(c); if (this.frames.length > KEEP) this.frames.shift();
    if ((this.drawT += c.gap) > 500) { this.drawT = 0; this.draw(); }
  }
  // 최근 n프레임 요약 (첫 프레임은 간격이 없어 뺀다)
  snapshot(n = KEEP) {
    const F = this.frames.slice(-n).filter((f) => f.gap > 0); if (!F.length) return null;
    const avg = (f) => F.reduce((s, x) => s + f(x), 0) / F.length;
    const pct = (f, q) => { const a = F.map(f).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))]; }, p95 = (f) => pct(f, 0.95);
    const last = F[F.length - 1], r1 = (x) => Math.round(x * 100) / 100;
    return {
      frames: F.length, fps: r1(1000 / avg((f) => f.gap)), gapAvg: r1(avg((f) => f.gap)), gapP95: r1(p95((f) => f.gap)), gapP99: r1(pct((f) => f.gap, 0.99)), gapMax: r1(Math.max(...F.map((f) => f.gap))),
      cpuAvg: r1(avg((f) => f.cpu)), cpuP95: r1(p95((f) => f.cpu)), cpuP99: r1(pct((f) => f.cpu, 0.99)),
      sections: Object.fromEntries(PERF_SECTIONS.map(([k, label]) => [k, { label, avg: r1(avg((f) => f.ms[k] ?? 0)), p95: r1(p95((f) => f.ms[k] ?? 0)), max: r1(Math.max(...F.map((f) => f.ms[k] ?? 0))), calls: Math.round(avg((f) => f.calls[k] ?? 0)) }])),
      callsAvg: Math.round(avg((f) => f.callsAll)), callsMax: Math.max(...F.map((f) => f.callsAll)), triAvg: Math.round(avg((f) => f.tri)),
      geometries: last.geo, textures: last.tex, programs: last.prog,
      pixelRatio: this.getRenderer()?.getPixelRatio(), size: [innerWidth, innerHeight],
    };
  }
  draw() {
    const s = this.snapshot(120); if (!s) return;
    const rows = PERF_SECTIONS.map(([k]) => s.sections[k]).filter((v) => v.avg >= 0.05 || v.calls);
    const td = (v, d = 2) => `<td>${typeof v === 'number' ? v.toFixed(d) : v}</td>`;
    this.el.innerHTML = `<b>${s.fps.toFixed(0)} fps</b> · 간격 ${s.gapAvg.toFixed(1)}ms (p95 ${s.gapP95.toFixed(1)} · p99 ${s.gapP99.toFixed(1)}) · CPU ${s.cpuAvg.toFixed(1)}ms (p95 ${s.cpuP95.toFixed(1)})<br>`
      + `draw ${s.callsAvg} (최대 ${s.callsMax}) · 삼각형 ${(s.triAvg / 1e6).toFixed(2)}M · 지오메트리 ${s.geometries} · 텍스처 ${s.textures} · 셰이더 ${s.programs}`
      + `<table><tr><th>구간</th><th>평균ms</th><th>p95ms</th><th>draw</th><th></th></tr>`
      + rows.map((v) => `<tr><td>${v.label}</td>${td(v.avg)}${td(v.p95)}${td(v.calls || '')}<td><i style="width:${Math.min(100, v.avg / s.gapAvg * 100).toFixed(0)}px"></i></td></tr>`).join('')
      + `</table><small>P 키: 끄기</small>`;
  }
}
