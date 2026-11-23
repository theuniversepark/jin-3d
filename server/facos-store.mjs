// FacOS 기록 저장 — UNS로 나가는 FacOS 메시지를 실행별 JSONL 파일로 쌓고 REST로 조회한다 (A2A · 결정 · 오더 · 계획 버전)
//   원천: 게이트웨이가 받은 UNS 메시지 (server/mqtt-gateway.mjs setUnsTap) — 화면(시뮬레이션)이 2초마다 발행하는 camtic/metafactory/…
//     _meta/namespace          → 새 실행 시작 (run ID가 바뀌면 새 파일)
//     _facos/state             → 계획 버전 · 상위망 · 온라인 상태가 바뀔 때만 'plan' 한 줄 (메시지 수 같은 카운터 변화는 남기지 않음)
//     _facos/order/{오더}       → 'order' (바뀔 때마다 — 조회는 오더마다 마지막 것)
//     _facos/decision/{종류}    → 'decision' (공장 결정 · 운영 변경 승인자 · 전/후)
//     _facos/a2a/{보낸}/{받는}  → 'a2a' (Agent Gateway 기록 — 인시던트 보고·명령·종료 포함)
//   중복 방지: 화면이 응답을 못 받아 같은 사건을 다시 보내면(js/uns.js outbox) 메시지의 key가 같다 — 그 실행 파일에 이미 있는 key는 다시 쓰지 않는다 (앱 서버를 다시 켠 뒤에도)
//   늦게 온 이전 실행의 사건(메시지의 run이 지금 실행과 다름 — 단계 전환 · 리셋 직전에 못 보낸 것)은 그 실행의 파일에 쓴다
//   파일: <데이터 폴더>/facos/<run>.jsonl · 한 줄 = { seq, at, type, topic, data, key? } · 최근 FACOS_KEEP_RUNS(기본 50)개 실행만 남김
//   REST (앱 서버가 /api/facos/v1/로 중계):
//     GET status · runs · events?run=&type=a2a,decision&since=<seq>&limit=<n> → { run, events, next } · decisions?run= · orders?run= · plans?run= · export?run= (.jsonl 그대로)
import fs from 'node:fs';
import path from 'node:path';
import { loadJsonl } from './jsonl.mjs';

const ROOT = 'camtic/metafactory';
const TYPES = ['run', 'plan', 'order', 'decision', 'a2a'];
const safeRun = (r) => (typeof r === 'string' && /^[\w.-]{1,80}$/.test(r) ? r : null);

export function makeFacosStore({ dir, keep = Number(process.env.FACOS_KEEP_RUNS) || 50 }) {
  const st = { run: null, file: null, seq: 0, counts: {}, lastAt: null, plan: null, written: 0, error: null, pruned: 0, duplicates: 0, late: 0, keys: new Set() };
  const fileOf = (run) => path.join(dir, `${run}.jsonl`);
  const runs = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => { const s = fs.statSync(path.join(dir, f)); return { run: f.slice(0, -6), bytes: s.size, modified: s.mtime.toISOString() }; }).sort((a, b) => b.modified.localeCompare(a.modified)); } catch { return []; } };
  const prune = () => { for (const r of runs().slice(keep)) { if (r.run === st.run) continue; try { fs.rmSync(fileOf(r.run)); st.pruned++; } catch { /* */ } } };
  const append = (type, topic, data, key = null) => {
    if (!st.file) return;
    if (key) { if (st.keys.has(key)) { st.duplicates++; return; } st.keys.add(key); }
    const line = { seq: ++st.seq, at: new Date().toISOString(), type, topic, data, ...(key ? { key } : {}) };
    try { fs.appendFileSync(st.file, `${JSON.stringify(line)}\n`); st.counts[type] = (st.counts[type] ?? 0) + 1; st.written++; st.lastAt = line.at; } catch (e) { st.error = e.message; if (key) st.keys.delete(key); st.seq--; }   // 못 썼으면 key를 기억하지 않는다 — 다시 오면 다시 쓴다
  };
  // 지금 실행이 아닌 실행의 파일에 한 줄 (늦게 온 이전 실행의 사건) — 그 파일의 번호 · key를 읽어 이어 쓴다
  const appendLate = (run, type, topic, data, key) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = fileOf(run), old = loadJsonl(f).items.filter(Boolean);
      if (key && old.some((x) => x.key === key)) { st.duplicates++; return; }
      const at = new Date().toISOString(), lines = old.length ? [] : [{ seq: 1, at, type: 'run', topic: `${ROOT}/_meta/namespace`, data: { run, version: null, root: ROOT } }];
      lines.push({ seq: (old.at(-1)?.seq ?? lines.length) + 1, at, type, topic, data, ...(key ? { key } : {}) });
      fs.appendFileSync(f, lines.map((x) => `${JSON.stringify(x)}\n`).join('')); st.written++; st.late++; st.lastAt = at;
    } catch (e) { st.error = e.message; }
  };
  const open = (run, meta) => {
    fs.mkdirSync(dir, { recursive: true });
    st.run = run; st.file = fileOf(run); st.plan = null; st.counts = {};
    const old = loadJsonl(st.file).items.filter(Boolean);   // 같은 실행이 이어지면(앱 서버 재시작 · rebirth) 번호를 이어 간다
    st.seq = old.at(-1)?.seq ?? 0; st.keys = new Set(old.map((x) => x.key).filter(Boolean));
    for (const x of old) st.counts[x.type] = (st.counts[x.type] ?? 0) + 1;
    if (!old.length) append('run', `${ROOT}/_meta/namespace`, { run, version: meta?.version ?? null, root: meta?.root ?? ROOT });
    prune();
  };

  // 게이트웨이 → 여기 (UNS 루트 토픽만)
  function tap(topic, payload, meta = null) {
    if (!topic.startsWith(`${ROOT}/`)) return;
    const rest = topic.slice(ROOT.length + 1);
    let d; try { d = JSON.parse(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8')); } catch { return; }
    if (rest === '_meta/namespace') { const r = safeRun(d.run); if (r && r !== st.run) open(r, d); return; }
    const key = typeof meta?.key === 'string' && meta.key ? meta.key.slice(0, 200) : null, run = safeRun(meta?.run);
    const ev = rest.startsWith('_facos/decision/') ? 'decision' : rest.startsWith('_facos/a2a/') ? 'a2a' : null;
    if (ev && run && run !== st.run) return appendLate(run, ev, topic, d, key);
    if (!st.file) return;
    if (rest === '_facos/state') {
      const key = JSON.stringify([d.planVersion ?? null, d.online ?? null, d.upstream ?? null]);
      if (key === st.plan) return;
      st.plan = key; return append('plan', topic, { planVersion: d.planVersion ?? null, online: d.online ?? null, upstream: d.upstream ?? null, reason: d.reason ?? null, ts: d.ts ?? null });
    }
    if (rest.startsWith('_facos/order/')) return append('order', topic, d);
    if (ev) return append(ev, topic, d, key);
  }

  const read = (run) => { const r = safeRun(run) ?? st.run; return r ? { run: r, items: loadJsonl(fileOf(r)).items.filter(Boolean) } : { run: null, items: [] }; };
  function route(method, pathname, q) {
    const sub = pathname.replace(/^\/api\/facos\/v1\/?/, '');
    if (method !== 'GET') return { code: 405, body: { error: '읽기 전용' } };
    if (sub === '' || sub === 'status') return { code: 200, body: status() };
    if (sub === 'runs') return { code: 200, body: { dir, keep, runs: runs() } };
    if (q.get('run') && !safeRun(q.get('run'))) return { code: 400, body: { error: 'run 형식 오류' } };
    const R = read(q.get('run'));
    if (sub === 'export') return { code: 200, raw: R.items.map((x) => JSON.stringify(x)).join('\n') + (R.items.length ? '\n' : ''), type: 'application/x-ndjson', name: `FacOS_${R.run ?? 'none'}.jsonl` };
    if (sub === 'events') {
      const types = (q.get('type') ?? '').split(',').filter((t) => TYPES.includes(t)), since = Number(q.get('since')) || 0, limit = Math.min(5000, Number(q.get('limit')) || 500);
      const ev = R.items.filter((x) => x.seq > since && (!types.length || types.includes(x.type))).slice(0, limit);
      return { code: 200, body: { run: R.run, events: ev, next: ev.at(-1)?.seq ?? since } };
    }
    if (sub === 'decisions') return { code: 200, body: { run: R.run, decisions: R.items.filter((x) => x.type === 'decision').map((x) => ({ seq: x.seq, at: x.at, ...x.data })) } };
    if (sub === 'plans') return { code: 200, body: { run: R.run, plans: R.items.filter((x) => x.type === 'plan').map((x) => ({ seq: x.seq, at: x.at, ...x.data })) } };
    if (sub === 'orders') { const m = new Map(); for (const x of R.items) if (x.type === 'order') m.set(x.data.id ?? x.topic, { seq: x.seq, at: x.at, ...x.data }); return { code: 200, body: { run: R.run, orders: [...m.values()] } }; }
    return { code: 404, body: { error: '없는 경로' } };
  }
  const status = () => ({ dir, keep, run: st.run, file: st.file ? path.basename(st.file) : null, seq: st.seq, counts: st.counts, written: st.written, duplicates: st.duplicates, late: st.late, lastAt: st.lastAt, error: st.error, runs: runs().length });
  return { tap, route, status };
}
