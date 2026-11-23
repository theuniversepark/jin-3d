// 설비 대시보드 (선택 · 앱 전용 · 정밀조립Zone) — Telegraf → InfluxDB 2 → Grafana 를 Docker로 켜고 끄고 상태를 본다
//   GET  /api/monitor/v1/status   Docker · 컨테이너 · Grafana/InfluxDB 응답 · 최근 1분 수신 건수(측정 종류별) · 주소
//   POST /api/monitor/v1/start    monitoring/ 구성을 데이터 폴더로 복사 · .env(무작위 토큰·비밀번호, 한 번 만든 것은 유지) · docker compose up -d → 준비될 때까지 확인
//   POST /api/monitor/v1/stop     docker compose stop (데이터는 남김)
//   POST /api/monitor/v1/reset?confirm=jin3d-mon   쌓인 데이터(InfluxDB · Grafana 볼륨)를 지우고 다시 켬 — 사용자가 확인한 경우에만 (토큰이 어긋나도 자동으로 지우지 않는다)
// Docker 실행 파일: Finder·시작 메뉴로 띄운 앱은 PATH가 짧아 흔한 위치를 직접 찾는다 (Homebrew · Docker Desktop · 윈도우)
// Docker 엔진이 꺼져 있고 Colima가 설치돼 있으면 「대시보드 켜기」가 colima start로 먼저 켠다 (Docker Desktop은 사용자가 직접 실행)
// 컨테이너는 host.docker.internal(host-gateway)로 앱 MQTT 브로커(127.0.0.1)에 닿는다 — 브로커를 사내망에 열지 않는다. 접속 포트도 127.0.0.1에만
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const MON_PROJECT = 'jin3d-mon';   // 구성 이름 — 컨테이너 · 볼륨 이름 앞에 붙는다 (meta-factory의 metafactory-mon과 겹치지 않게)
export const RESET_CONFIRM = MON_PROJECT;
const PORTS = { grafana: 3310, influx: 8196 };   // meta-factory(3300 · 8186)와 다른 포트 — 두 앱을 같이 켤 수 있다
const DOCKER = [process.env.DOCKER_BIN, 'docker', '/opt/homebrew/bin/docker', '/usr/local/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker', 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'].filter(Boolean);
const COLIMA = [process.env.COLIMA_BIN, 'colima', '/opt/homebrew/bin/colima', '/usr/local/bin/colima'].filter(Boolean);
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Docker.app/Contents/Resources/bin'];

function run(bin, args, { cwd, env, timeout = 120000 } = {}) {
  return new Promise((resolve) => execFile(bin, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout ?? ''), err: String(stderr ?? '') || (err ? err.message : '') })));
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else { fs.writeFileSync(d, fs.readFileSync(s)); if (/\.sh$/.test(e.name)) fs.chmodSync(d, 0o755); }   // 앱 묶음(asar) 안 파일도 읽어서 쓴다 — Docker는 묶음 안을 직접 마운트하지 못한다
  }
}

export function makeMonitorApi({ dir, src, mqttPort = () => 1883, fetchImpl = globalThis.fetch } = {}) {
  const env = { ...process.env, PATH: [...new Set([...(process.env.PATH ?? '').split(path.delimiter), ...PATH_EXTRA])].filter(Boolean).join(path.delimiter) };
  const rt = { docker: null, compose: null, checked: 0, job: null };
  async function findDocker(force = false) {
    if (!force && rt.docker !== null && Date.now() - rt.checked < 60000) return rt.docker;
    rt.checked = Date.now(); rt.docker = ''; rt.compose = null;
    for (const b of DOCKER) {
      const v = await run(b, ['--version'], { env, timeout: 8000 }); if (!v.ok) continue;
      const c = await run(b, ['compose', 'version', '--short'], { env, timeout: 8000 });
      rt.docker = b; rt.version = v.out.trim(); rt.compose = c.ok ? c.out.trim() : null; break;
    }
    return rt.docker;
  }
  // .env — 처음 한 번 무작위로 만들고 유지 (InfluxDB는 처음 켤 때만 초기화하므로 토큰이 바뀌면 안 된다)
  function envFile() {
    const f = path.join(dir, '.env'), cur = {};
    try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) cur[m[1]] = m[2]; } } catch { /* 처음 */ }
    const rnd = (n) => crypto.randomBytes(n).toString('base64url');
    const next = { JIN3D_INFLUX_TOKEN: cur.JIN3D_INFLUX_TOKEN || rnd(32), JIN3D_INFLUX_PASSWORD: cur.JIN3D_INFLUX_PASSWORD || rnd(18), JIN3D_GRAFANA_PASSWORD: cur.JIN3D_GRAFANA_PASSWORD || rnd(15), JIN3D_MQTT_PORT: String(mqttPort() ?? 1883), JIN3D_GRAFANA_PORT: String(PORTS.grafana), JIN3D_INFLUX_PORT: String(PORTS.influx) };
    fs.writeFileSync(f, Object.entries(next).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    return next;
  }
  const compose = (args, timeout) => run(rt.docker, ['compose', '-p', MON_PROJECT, '--env-file', '.env', '-f', 'compose.yml', ...args], { cwd: dir, env, timeout });
  const up = async (u) => { try { const r = await fetchImpl(u, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; } };
  async function counts() {
    let tok = null; try { tok = fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/JIN3D_INFLUX_TOKEN=(.*)/)?.[1]; } catch { return null; }
    if (!tok) return null;
    try {
      const q = 'from(bucket: "raw") |> range(start: -1m) |> group(columns: ["_measurement"]) |> count() |> keep(columns: ["_measurement", "_value"])';
      const r = await fetchImpl(`http://127.0.0.1:${PORTS.influx}/api/v2/query?org=jin3d`, { method: 'POST', headers: { Authorization: `Token ${tok}`, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' }, body: q, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const out = {}; let hm = -1, hv = -1;   // 주석 CSV — 머리줄에서 열 위치를 찾는다 (열 순서는 정해져 있지 않다)
      for (const line of (await r.text()).split(/\r?\n/)) {
        const c = line.split(','); if (c.includes('_measurement') && c.includes('_value')) { hm = c.indexOf('_measurement'); hv = c.indexOf('_value'); continue; }
        if (hm >= 0 && c[hm] && /^\d+$/.test(c[hv] ?? '')) out[c[hm]] = (out[c[hm]] ?? 0) + Number(c[hv]);
      }
      return out;
    } catch { return null; }
  }
  async function status() {
    await findDocker();
    let containers = [];
    if (rt.docker && rt.compose && fs.existsSync(path.join(dir, 'compose.yml'))) {
      const r = await compose(['ps', '--format', 'json'], 15000);
      if (r.ok) containers = r.out.trim().split('\n').filter(Boolean).flatMap((l) => { try { const j = JSON.parse(l); return Array.isArray(j) ? j : [j]; } catch { return []; } }).map((c) => ({ service: c.Service, state: c.State, status: c.Status }));
    }
    const [g, i] = await Promise.all([up(`http://127.0.0.1:${PORTS.grafana}/api/health`), up(`http://127.0.0.1:${PORTS.influx}/health`)]);
    return { docker: rt.docker ? { bin: rt.docker, version: rt.version, compose: rt.compose } : null, containers, grafana: g, influx: i, counts: g && i ? await counts() : null,
      url: `http://127.0.0.1:${PORTS.grafana}/`, job: rt.job, mqttPort: mqttPort() };
  }
  async function start({ reset = false } = {}) {
    if (rt.job?.running) return rt.job;
    rt.job = { running: true, step: 'Docker 확인', t0: new Date().toISOString(), ok: null, error: null, reset };
    (async () => {
      try {
        if (!(await findDocker(true))) throw new Error('Docker를 찾을 수 없습니다 — Docker Desktop(또는 Colima)을 설치·실행한 뒤 다시 누르세요');
        if (!rt.compose) throw new Error('docker compose가 없습니다 — Docker Desktop을 쓰거나 compose 플러그인을 설치하세요');
        const engineUp = async () => (await run(rt.docker, ['info', '--format', '{{.ServerVersion}}'], { env, timeout: 15000 })).ok;
        if (!(await engineUp())) {
          let colima = null; for (const b of COLIMA) if ((await run(b, ['version'], { env, timeout: 8000 })).ok) { colima = b; break; }
          if (!colima) throw new Error('Docker 엔진이 꺼져 있습니다 — Docker Desktop을 먼저 실행하세요');
          rt.job.step = 'Docker 엔진 켜기 (colima start · 1분 안팎)';
          const c = await run(colima, ['start'], { env, timeout: 300000 });
          if (!c.ok || !(await engineUp())) throw new Error(`Colima를 켜지 못했습니다 — 터미널에서 colima start를 실행해 보세요 (${(c.err || c.out).split('\n').filter(Boolean).slice(-1)[0] ?? '응답 없음'})`);
          rt.job.colimaStarted = true;
        }
        rt.job.step = '구성 파일 준비'; copyDir(src, dir); envFile();
        if (reset) {   // 사용자가 「데이터 초기화」를 확인한 경우만 — 이 구성의 이름 있는 볼륨(influx-data · grafana-data)을 지운다
          rt.job.step = '대시보드 데이터 지우기 (사용자 확인)';
          const d = await compose(['down', '-v'], 300000); if (!d.ok) throw new Error(`docker compose down 실패 — ${d.err.split('\n').filter(Boolean).slice(-2).join(' / ')}`);
        }
        rt.job.step = '컨테이너 시작 (처음이면 이미지 내려받기로 몇 분)';
        const r = await compose(['up', '-d'], 900000); if (!r.ok) throw new Error(`docker compose up 실패 — ${r.err.split('\n').filter(Boolean).slice(-2).join(' / ')}`);
        await compose(['restart', 'telegraf', 'grafana'], 180000);   // 수집 규칙(telegraf.conf) · 대시보드 JSON이 바뀌었을 수 있다 — 다시 읽게 (Grafana는 처음 등록한 대시보드를 계속 써서 다시 시작해야 새 파일을 반영)
        rt.job.step = 'Grafana · InfluxDB 준비 확인';
        const ready = async () => { for (let k = 0; k < 90; k++) { if ((await up(`http://127.0.0.1:${PORTS.grafana}/api/health`)) && (await up(`http://127.0.0.1:${PORTS.influx}/health`))) return true; await new Promise((res) => setTimeout(res, 2000)); } return false; };
        if (!(await ready())) throw new Error('3분 안에 Grafana·InfluxDB가 응답하지 않습니다 — 「대시보드 켜기」를 한 번 더 누르거나 Docker 상태를 확인하세요');
        // 토큰 확인: InfluxDB 저장 공간은 처음 켤 때만 초기화된다 — 데이터 폴더의 .env가 새로 만들어졌으면 토큰이 어긋난다.
        // 쌓인 데이터를 자동으로 지우지 않는다: 멈추고 알린다 (.env 복원 또는 사용자가 확인하는 「데이터 초기화」)
        const tok = fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/JIN3D_INFLUX_TOKEN=(.*)/)?.[1];
        const auth = await fetchImpl(`http://127.0.0.1:${PORTS.influx}/api/v2/buckets?org=jin3d`, { headers: { Authorization: `Token ${tok}` }, signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch(() => 0);
        if (auth === 401) {
          rt.job.authMismatch = true;
          throw new Error('저장 공간 토큰이 맞지 않습니다 — 쌓인 데이터는 지우지 않고 멈췄습니다. 데이터 폴더의 monitoring/.env를 이전 것으로 되돌리거나, 데이터를 버려도 되면 「데이터 초기화」를 누르세요');
        }
        rt.job = { ...rt.job, running: false, ok: true, step: '완료' }; return;
      } catch (e) { rt.job = { ...rt.job, running: false, ok: false, error: e.message }; }
    })();
    return rt.job;
  }
  async function stop() {
    if (!(await findDocker()) || !fs.existsSync(path.join(dir, 'compose.yml'))) return { ok: false, error: '켜진 대시보드가 없습니다' };
    const r = await compose(['stop'], 120000); return r.ok ? { ok: true } : { ok: false, error: r.err.slice(-300) };
  }
  async function reset(confirm) {
    if (confirm !== RESET_CONFIRM) return { ok: false, error: `데이터 초기화는 확인값이 필요합니다 (confirm=${RESET_CONFIRM})` };
    return start({ reset: true });
  }
  const route = async (method, pathname, query = new URLSearchParams()) => {
    const p = pathname.replace(/^\/api\/monitor\/v1\/?/, '');
    if (p === '' || p === 'status') return { code: 200, body: await status() };
    if (p === 'start' && method === 'POST') return { code: 202, body: await start() };
    if (p === 'stop' && method === 'POST') return { code: 200, body: await stop() };
    if (p === 'reset' && method === 'POST') { const r = await reset(query.get('confirm')); return { code: r.ok === false ? 400 : 202, body: r }; }
    return null;
  };
  return { route, status, start, stop, reset, envFile, _rt: rt };
}
