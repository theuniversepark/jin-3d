// 3단계 비교 Worker — 단계 하나를 8시간 헤드리스 운전해 KPI를 돌려준다 (js/compare.js)
import { compareMode } from './compare.js';
self.onmessage = async (e) => {
  const { key, seed, line, hours } = e.data;
  try { self.postMessage({ res: await compareMode(key, seed, line, hours) }); } catch (err) { self.postMessage({ error: String(err?.message ?? err) }); }
};
