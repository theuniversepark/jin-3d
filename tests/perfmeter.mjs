// 구간별 성능 표시(js/perf.js) 검증 — 검수보고서 R13: 껐다 켜면 첫 프레임 간격에 재지 않던 시간이 섞여 평균 fps가 낮게 나왔다
// reset · 켜기에서 지난 프레임 시각(last)을 비우는지, 다시 켠 뒤 첫 간격이 0(요약에서 빠짐)인지, p95/p99 간격을 내는지 본다. 실행: npm test
import fs from 'node:fs';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
globalThis.document = { createElement: () => ({ hidden: true, innerHTML: '' }), body: { appendChild() {} } };
globalThis.innerWidth = 1600; globalThis.innerHeight = 960;
let now = 1000; const realNow = performance.now.bind(performance); performance.now = () => now;
const { PerfMeter } = await import('../js/perf.js');
const info = { autoReset: true, reset() {}, render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
const perf = new PerfMeter(() => ({ info, getPixelRatio: () => 1 }));
const frames = (n, gap) => { for (let k = 0; k < n; k++) { perf.begin(); now += 2; perf.end(); now += gap - 2; } };

console.log('== 성능 측정 재시작 (R13)');
{ const p = Object.create(PerfMeter.prototype); p.last = 123; p.reset(); check('reset() 뒤 지난 프레임 시각(last)이 비어 있음', p.last === undefined, `last=${p.last}`); }
perf.toggle(true); frames(60, 16);
const a = perf.snapshot();
check('첫 측정: 16ms 간격 → 62.5fps', a && Math.abs(a.fps - 62.5) < 0.01 && a.frames === 59, `${a?.fps}fps · ${a?.frames}프레임`);
perf.toggle(false); now += 10_000;   // 꺼 둔 10초 (perf-sample.cjs의 단계 전환 · 몸풀기)
frames(5, 16);
check('꺼져 있는 동안은 재지 않고 last도 건드리지 않음', perf.frames.length === 0 && perf.last === undefined);
perf.toggle(true); perf.begin();
check('다시 켠 뒤 첫 프레임 간격 0 (꺼 둔 시간이 들어가지 않음)', perf.cur.gap === 0, `gap=${perf.cur.gap}ms`);
now += 2; perf.end(); now += 14; frames(60, 16);
const b = perf.snapshot();
check('다시 켠 측정의 평균 fps · 최대 간격이 꺼 둔 시간에 물들지 않음', b && Math.abs(b.fps - 62.5) < 0.01 && b.gapMax === 16, `${b?.fps}fps · 최대 간격 ${b?.gapMax}ms`);
perf.reset(); now += 5000; perf.begin();
check('켜진 채 reset() 해도 다음 첫 간격 0', perf.cur.gap === 0, `gap=${perf.cur.gap}ms`);
perf.end(); perf.reset();
// 느린 프레임이 섞인 분포: 100프레임 중 3프레임만 50ms — p95는 16ms, p99는 50ms
for (let k = 0; k < 101; k++) { perf.begin(); now += 2; perf.end(); now += (k % 34 === 33 ? 50 : 16) - 2; }
const c = perf.snapshot();
check('프레임 간격 p95 · p99 · 최대를 함께 냄', c && c.gapP95 === 16 && c.gapP99 === 50 && c.gapMax === 50 && c.cpuP99 === 2, `p95 ${c?.gapP95} · p99 ${c?.gapP99} · 최대 ${c?.gapMax}`);

console.log('== 측정 도구 (tools/perf-sample.cjs)');
const src = fs.readFileSync(new URL('../tools/perf-sample.cjs', import.meta.url), 'utf8');
check('재기 전에 토리 안내를 접음', /tori\?\.close\?\.\(\)/.test(src) && src.indexOf('tori?.close') < src.indexOf('for (const [name, mode, setup] of SCENES)'));
check('장면마다 p95 · p99 프레임 간격을 출력', src.includes('s.gapP95') && src.includes('s.gapP99'));
performance.now = realNow;
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
