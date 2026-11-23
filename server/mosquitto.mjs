// 내장 MQTT 5 브로커 — Eclipse Mosquitto 2.x (EPL-2.0 OR EDL-1.0) 를 앱 서버의 자식 프로세스로 띄운다.
//   실행 파일: vendor/mosquitto/<platform>-<arch>/ (맥 darwin-arm64: Homebrew 2.1.2 + OpenSSL · cJSON dylib, 경로를 @executable_path로 바꿔 함께 넣음 ·
//              윈도우 win32-x64: 공식 설치본 2.1.2에서 mosquitto.exe · 필요한 DLL · vcruntime140.dll만 꺼냄) — 패키지에서는 app.asar.unpacked
//              환경변수 MOSQUITTO_BIN이 있으면 그것, 없으면 시스템 설치본(/opt/homebrew/sbin · C:\Program Files\mosquitto)도 찾는다
//   설정: 데이터 폴더 uns/mosquitto/ 에 mosquitto.conf · passwd(PBKDF2-SHA512 $7$) · acl 을 만든다 (0600) — 계정·권한은 server/uns-acl.mjs 역할표 그대로
//   종료: 앱 서버가 끝나면 함께 끝낸다. 지난 실행이 남긴 브로커(pid 파일)는 시작할 때 정리한다
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = (p) => p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);   // 패키지 안의 실행 파일은 asar 밖에 있다
const EXE = process.platform === 'win32' ? 'mosquitto.exe' : 'mosquitto';

export function findMosquitto() {
  const cands = [process.env.MOSQUITTO_BIN, unpacked(path.join(ROOT, 'vendor', 'mosquitto', `${process.platform}-${process.arch}`, EXE)),
    ...(process.platform === 'win32' ? ['C:\\Program Files\\mosquitto\\mosquitto.exe'] : ['/opt/homebrew/sbin/mosquitto', '/usr/local/sbin/mosquitto', '/usr/sbin/mosquitto'])].filter(Boolean);
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return { bin: c, bundled: c.includes(`${path.sep}vendor${path.sep}mosquitto${path.sep}`) }; } catch { /* 다음 후보 */ } }
  return null;
}

// Mosquitto 비밀번호 파일 한 줄 — $7$<반복>$<salt 64바이트 base64>$<PBKDF2-SHA512 64바이트 base64> (mosquitto_passwd 2.x와 같은 형식)
export function passwdLine(name, pw) {
  const salt = crypto.randomBytes(64), it = 1000;
  return `${name}:$7$${it}$${salt.toString('base64')}$${crypto.pbkdf2Sync(String(pw), salt, it, 64, 'sha512').toString('base64')}`;
}
// ACL 파일 — 앞부분(user 없음) = 익명, user 블록마다 읽기 전체 + 역할별 쓰기
export function aclText({ anonymous = 'observer', users = [] }) {
  const L = ['# UNS ACL (server/uns-acl.mjs 역할표에서 자동 생성 — 손으로 고치지 마세요)'];
  if (anonymous === 'all') L.push('# 접근 권한 꺼짐 (UNS_ACL=off) — 익명도 읽기 · 쓰기', 'topic readwrite #', 'topic read $SYS/#');
  else if (anonymous !== 'none') L.push('# 익명 = 관찰 (읽기 전용)', 'topic read #', 'topic read $SYS/#');
  for (const u of users) {
    L.push('', `user ${u.name}`, 'topic read #', 'topic read $SYS/#');
    for (const p of u.write ?? []) L.push(p === '#' ? 'topic readwrite #' : `topic write ${p}`);
  }
  return `${L.join('\n')}\n`;
}

const writePriv = (f, t) => { fs.writeFileSync(f, t, { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch { /* 윈도우 */ } };
// 지난 실행이 남긴 브로커 정리 (앱이 강제 종료됐을 때) — 정리했으면 true
export const cleanupStale = (dir) => killStale(path.join(dir, 'mosquitto.pid'));
function killStale(pidFile) {
  let pid; try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { return false; }
  if (!pid || pid === process.pid) return false;
  try {
    if (process.platform !== 'win32') { const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim(); if (!/mosquitto/.test(comm)) return false; }
    else { const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }); if (!/mosquitto/i.test(out)) return false; }
    process.kill(pid); return true;
  } catch { return false; /* 이미 없음 */ }
}

// opts: { bin, host, port, dir, anonymous, users: [{ name, password, write: [패턴] }] } → { proc, version, log, stop() }
export async function startMosquitto({ bin, host = '127.0.0.1', port, dir, anonymous = 'observer', users = [], timeoutMs = 6000 }) {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* 윈도우 */ }
  const conf = path.join(dir, 'mosquitto.conf'), pw = path.join(dir, 'passwd'), acl = path.join(dir, 'acl'), pidFile = path.join(dir, 'mosquitto.pid');
  killStale(pidFile);
  writePriv(pw, `${users.map((u) => passwdLine(u.name, u.password)).join('\n')}\n`);
  writePriv(acl, aclText({ anonymous, users }));
  const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
  writePriv(conf, [`# Jin-3D 내장 MQTT 5 브로커 (server/mosquitto.mjs 자동 생성)`, 'per_listener_settings false', `listener ${port} ${host}`, 'protocol mqtt',
    `allow_anonymous ${anonymous === 'none' ? 'false' : 'true'}`, `password_file ${q(pw)}`, `acl_file ${q(acl)}`, 'persistence false', 'log_dest stderr', 'log_type error', 'log_type warning', 'log_type notice', 'log_type information',
    'sys_interval 5', 'max_queued_messages 5000', ''].join('\n'));
  const binDir = path.dirname(bin);
  const proc = spawn(bin, ['-c', conf], { cwd: binDir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` } });
  const log = [], st = { version: null, exited: null };
  const onLine = (l) => { log.push(l); if (log.length > 200) log.shift(); const v = /mosquitto version ([\d.]+) (starting|running)/.exec(l); if (v) st.version = v[1]; };
  let buf = ''; proc.stderr.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/^\d+: /, '')); buf = buf.slice(i + 1); } });
  try { fs.writeFileSync(pidFile, String(proc.pid)); } catch { /* */ }
  const kill = () => { try { proc.kill(); } catch { /* */ } };
  process.once('exit', kill);
  // 신호로 끝날 때(kill · Ctrl+C · 터미널 닫힘)는 Node가 exit 이벤트를 내지 않는다 — 브로커를 먼저 끝내고, 다른 처리기가 없으면 같은 신호로 다시 끝낸다
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { const h = () => { kill(); process.removeListener(sig, h); if (process.listenerCount(sig) === 0) process.kill(process.pid, sig); }; process.on(sig, h); }
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => { kill(); reject(new Error(`Mosquitto 시작 시간 초과 — ${log.slice(-3).join(' / ')}`)); }, timeoutMs);
    proc.once('error', (e) => { clearTimeout(to); reject(e); });
    proc.once('exit', (code) => { st.exited = code; clearTimeout(to); reject(new Error(`Mosquitto 종료 (코드 ${code}) — ${log.slice(-3).join(' / ') || '실행 파일 · DLL 확인'}`)); });
    const chk = setInterval(() => { if (log.some((l) => / running$/.test(l))) { clearInterval(chk); clearTimeout(to); resolve(); } }, 50);
  });
  proc.removeAllListeners('exit'); proc.on('exit', (code) => { st.exited = code; });
  return { proc, log, get version() { return st.version; }, get exited() { return st.exited; }, stop: () => new Promise((r) => { if (st.exited != null) return r(); proc.once('exit', () => r()); kill(); setTimeout(r, 2000); try { fs.rmSync(pidFile); } catch { /* */ } }) };
}
