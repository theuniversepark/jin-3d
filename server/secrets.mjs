// 외부 연동 설정 파일의 비밀 값 보관 — server/epcis-api.mjs(외부 전송 토큰) · server/erpnext-bridge.mjs(API 키)가 configFile()로 쓴다 (Claude API 키는 electron/main.mjs가 anthropic-key.bin에 따로 암호화).
// 맥·윈도우 앱은 electron/main.mjs가 safeStorage(맥 키체인 · 윈도우 DPAPI) 암호기를 넣어 주고, 파일에는 암호문(enc:…)만 남긴다.
// 암호기가 없는 실행(npm start · 테스트)은 평문으로 두되 이 계정만 읽을 수 있게(0600) 쓴다.
// 예전 평문 파일은 암호기가 있는 실행에서 처음 읽을 때 암호문으로 바꿔 다시 쓴다. 풀 수 없는 암호문(다른 계정·다른 PC)은 지우지 않고 그대로 둔다.
import fs from 'node:fs';

const ENC = 'enc:';
let codec = null;   // { encrypt(text) → base64, decrypt(base64) → text }
export function setSecretCodec(c) { codec = c ?? null; }
export const secretsEncrypted = () => !!codec;

const sealed = new Map();   // 평문 → 암호문 (암호문이 매번 달라 파일이 저장마다 바뀌지 않게)
const seal = (v) => { if (!codec) return v; let s = sealed.get(v); if (!s) { s = ENC + codec.encrypt(v); sealed.set(v, s); } return s; };
const open = (s) => { if (!codec) return null; try { const v = codec.decrypt(s.slice(ENC.length)); sealed.set(v, s); return v; } catch { return null; } };

// 임시 파일에 0600으로 쓴 뒤 이름을 바꾼다 — 쓰다가 앱이 꺼져도 설정 파일이 반쯤 쓰인 채로 남지 않는다
export function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 윈도우 */ }
}

// 설정 파일 하나 — cfg는 평문 값을 담은 일반 객체, save()가 비밀 키만 암호화해 쓴다. forget(k)는 비밀 값을 지운다
export function configFile(file, defaults, secretKeys) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 처음 */ }
  try { fs.chmodSync(file, 0o600); } catch { /* 없음 · 윈도우 */ }
  const cfg = { ...defaults, ...raw }, locked = {};
  let migrate = false;
  for (const k of secretKeys) {
    const v = String(raw[k] ?? '');
    if (v.startsWith(ENC)) { const p = open(v); if (p == null) { cfg[k] = ''; locked[k] = v; } else cfg[k] = p; }
    else if (v && codec) migrate = true;
  }
  const save = () => {
    const out = { ...cfg };
    for (const k of secretKeys) { if (cfg[k]) delete locked[k]; out[k] = cfg[k] ? seal(String(cfg[k])) : (locked[k] ?? ''); }
    writePrivate(file, JSON.stringify(out, null, 1));
  };
  const forget = (k) => { cfg[k] = ''; delete locked[k]; };
  if (migrate) { try { save(); } catch { /* 다음 저장 때 */ } }
  return { cfg, save, forget, locked: (k) => k in locked };
}
