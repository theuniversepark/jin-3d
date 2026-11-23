// 3단계 8시간 비교 계산 — 화면과 같은 0.1초 고정 간격(SIM_DT)으로 헤드리스 운전한다 (같은 시드·라인이면 화면과 같은 조건)
// 단계마다 Worker 하나(js/compareworker.js)에서 돌려 화면이 멈추지 않는다. Worker를 못 쓰면 화면 스레드에서 잘게 나눠 돈다.
import { Simulation, SIM_DT } from './sim.js';
import { FactoryAgent } from './agent.js';

// 한 단계 운전 — chunk마다 yieldFn(진행률)을 기다린다 (없으면 한 번에)
export async function compareMode(key, seed, line, hours = 8, yieldFn = null) {
  const s = new Simulation(key, seed, { quiet: true, line }), ag = new FactoryAgent(s), N = Math.round((hours * 3600) / SIM_DT);
  for (let i = 0; i < N; i++) { s.step(SIM_DT); ag.update(SIM_DT); if (yieldFn && i % 3000 === 2999) await yieldFn(i / N); }
  return { k: s.kpi(), decisions: ag.decisions };
}
function inWorker(key, seed, line, hours) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./compareworker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { w.terminate(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.res); };
    w.onerror = (e) => { w.terminate(); e.preventDefault?.(); reject(new Error(e.message || 'Worker 실행 실패')); };
    w.postMessage({ key, seed, line, hours });
  });
}
export async function compareModes(keys, seed, line, hours = 8) {
  const plain = line == null ? undefined : JSON.parse(JSON.stringify(line));   // Worker로 넘길 수 있는 순수 데이터
  let out;
  try { out = typeof Worker === 'function' ? await Promise.all(keys.map((k) => inWorker(k, seed, plain, hours))) : null; } catch { out = null; }
  if (!out) { out = []; for (const k of keys) out.push(await compareMode(k, seed, plain, hours, () => new Promise((r) => setTimeout(r, 0)))); }
  return Object.fromEntries(keys.map((k, i) => [k, out[i]]));
}
