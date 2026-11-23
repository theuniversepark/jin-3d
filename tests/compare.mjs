// 3단계 8시간 비교(js/compare.js) — 화면 루프와 같은 0.1초 고정 간격(SIM_DT)으로 계산하는지,
// 계산이 늦게 끝난 이전 라인이 새 라인 결과를 덮어쓰지 않는지(라인별 보관), 디지털트윈 비교(혼합형 · 관제 · KPI 개선 · AIOS)도 같은 간격인지. 실행: npm test
import fs from 'node:fs';
import { Simulation, SIM_DT } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { compareMode, compareModes } from '../js/compare.js';
import { UI } from '../js/ui.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const read = (f) => fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');

console.log('== 3단계 비교 — 화면과 같은 0.1초 간격');
{
  const r = await compareMode('smart', 20261001, undefined, 0.5);
  const s = new Simulation('smart', 20261001, { quiet: true }), ag = new FactoryAgent(s);
  for (let i = 0; i < Math.round(1800 / SIM_DT); i++) { s.step(SIM_DT); ag.update(SIM_DT); }
  const k = s.kpi();
  check('비교 계산 = 0.1초 간격 직접 운전 (양품 · OEE · 의사결정)', r.k.good === k.good && r.k.OEE === k.OEE && r.decisions === ag.decisions, `양품 ${r.k.good} / ${k.good}`);
  check('화면 루프 간격 상수 0.1초', SIM_DT === 0.1);
  check('ui.js에 0.25초 간격 계산이 남아 있지 않음', !/step\(0\.25\)/.test(read('ui.js')));
  // Worker가 없는 환경(node)에서는 화면 스레드 계산으로 넘어가 같은 결과
  const all = await compareModes(['traditional', 'smart'], 20261001, undefined, 0.25), one = await compareMode('smart', 20261001, undefined, 0.25);
  check('Worker 없이도 단계별 결과가 같음', all.smart.k.good === one.k.good && all.smart.decisions === one.decisions && all.traditional.k.good >= 0, `자동화 양품 ${all.smart.k.good}`);
}

console.log('== 디지털트윈 비교 실행도 0.1초 간격');
{
  for (const f of ['multiagent.js', 'fleet.js', 'impact.js', 'aios.js']) {
    const steps = [...read(f).matchAll(/\.step\(([^)]*)\)/g)].map((m) => m[1].trim());
    check(`${f} — step 간격이 모두 0.1초`, steps.length > 0 && steps.every((x) => x === '0.1' || x === 'SIM_DT'), steps.join(' · '));
  }
}

console.log('== 3단계 비교 — 늦게 끝난 이전 라인이 새 라인 결과를 덮어쓰지 않음');
{
  const workers = [], original = globalThis.Worker, doc = globalThis.document;
  globalThis.Worker = class { constructor() { workers.push(this); } postMessage(m) { this.msg = m; } terminate() {}
    finish() { const n = this.msg.line.name === 'line-A' ? 11 : 22; this.onmessage({ data: { res: { decisions: n, k: { good: n, uph: n, OEE: 0.8, A: 0.9, Q: 0.99, ppm: 0, failures: 0, pm: 0, cal: 0, avgWip: 1, kwhPerUnit: 1, people: 2 } } } }); } };
  const body = { innerHTML: '' };
  globalThis.document = { getElementById: (id) => (id === 'compare' ? { classList: { remove() {} } } : body) };
  try {
    const ui = Object.create(UI.prototype), A = { name: 'line-A', stations: [] }, B = { name: 'line-B', stations: [] };
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
    ui.runCompare(1, A); ui.runCompare(1, B);
    check('단계마다 Worker 하나 (라인 2개 × 3단계)', workers.length === 6, `${workers.length}개`);
    workers.slice(3).forEach((w) => w.finish()); await flush();
    const showB = body.innerHTML.includes('line-B');
    workers.slice(0, 3).forEach((w) => w.finish()); await flush();
    check('B 결과 표시 뒤 A가 끝나도 창은 B 그대로', showB && body.innerHTML.includes('line-B') && !body.innerHTML.includes('line-A'));
    check('라인별 결과 보관 (A·B 모두 캐시)', ui.cachedCompare(1, A)?.smart.k.good === 11 && ui.cachedCompare(1, B)?.smart.k.good === 22 && !ui.comparing(1, A) && !ui.comparing(1, B));
  } finally { globalThis.Worker = original; globalThis.document = doc; }
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
