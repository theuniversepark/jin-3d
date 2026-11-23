// UNS 브로커 접근 권한(ACL) — 내장 브로커(aedes)의 authenticate · authorizePublish · authorizeSubscribe 에 건다.
// 원칙: 읽기(구독)는 모두 허용 — UNS는 공장 전체가 같은 상태를 보는 공용 공간. 쓰기(발행)는 역할·존마다 정해진 토픽만.
//   observer  (익명 기본)  발행 없음
//   operator  사람 운전자·MES      camtic/metafactory/+/+/cmd/request  (모든 존의 셀·존 명령 요청)
//   zone      외부 존 에이전트     camtic/metafactory/{자기 존}/+/cmd/request  — 다른 존 명령 금지 (FacOS 가드레일 「같은 계층 명령 금지」를 브로커에서도)
//   edge      Sparkplug 엣지 노드  spBv1.0/{group}/(NBIRTH|NDATA|NDEATH)/{자기 id} · (DBIRTH|DDATA|DDEATH)/{자기 id}/+
//   host      Sparkplug 주 호스트  spBv1.0/{group}/NCMD/+ · DCMD/+/+ · spBv1.0/STATE/{자기 id}
//   admin     유지보수               # (기본 계정 없음)
// UNS 상태 토픽(_facos · _zone/state · {셀}/state …)은 앱 서버가 브로커 안에서 직접 발행하므로(권한 검사 밖) 어떤 클라이언트 계정도 쓸 수 없다 — 위조 방지.
// 계정 파일: 데이터 폴더/uns/acl.json — 처음 실행 때 operator · zone-{존} 계정을 무작위 비밀번호로 만든다(앱은 키체인·DPAPI로 암호화해 저장).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configFile } from './secrets.mjs';

export const ZONES = ['main'];   // 존 계정 zone-{존} · Sparkplug 엣지 edge-{존} — jin-3d는 정밀조립 하나
export const ROLES = {
  observer: { ko: '관찰 (읽기 전용)', pub: () => [] },
  operator: { ko: '운전자·MES (모든 존 명령 요청)', pub: () => ['camtic/metafactory/+/+/cmd/request'] },
  zone: { ko: '존 에이전트 (자기 존 명령 요청만)', pub: (u) => [`camtic/metafactory/${u.zone}/+/cmd/request`] },
  edge: { ko: 'Sparkplug 엣지 노드', pub: (u) => ['NBIRTH', 'NDATA', 'NDEATH'].map((t) => `spBv1.0/${u.group ?? 'metafactory'}/${t}/${u.id}`).concat(['DBIRTH', 'DDATA', 'DDEATH'].map((t) => `spBv1.0/${u.group ?? 'metafactory'}/${t}/${u.id}/+`)) },
  host: { ko: 'Sparkplug 주 호스트', pub: (u) => [`spBv1.0/${u.group ?? 'metafactory'}/NCMD/+`, `spBv1.0/${u.group ?? 'metafactory'}/DCMD/+/+`, `spBv1.0/STATE/${u.id}`] },
  admin: { ko: '유지보수 (전체)', pub: () => ['#'] },
};

// MQTT 토픽 일치 — 패턴(+ #)이 실제 토픽을 덮는가
export function topicMatch(pattern, topic) {
  const P = pattern.split('/'), T = topic.split('/');
  for (let i = 0; i < P.length; i++) {
    if (P[i] === '#') return true;
    if (i >= T.length) return false;
    if (P[i] !== '+' && P[i] !== T[i]) return false;
  }
  return P.length === T.length;
}

const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const randPw = () => crypto.randomBytes(12).toString('base64url');

export function makeAcl({ file = null, anonymous = process.env.UNS_ACL_ANON || 'observer', enabled = process.env.UNS_ACL !== 'off' } = {}) {
  const internal = new Map();   // 앱 안의 클라이언트(Sparkplug 엣지·호스트) — 실행마다 새 비밀번호, 파일에 남기지 않음
  const st = { enabled, anonymous, denied: 0, lastDenied: null, authFail: 0, file };
  let users = [], store = null;
  const load = () => {
    if (!file) return;
    let raw = {}; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 처음 */ }
    const list = Array.isArray(raw.users) ? raw.users.filter((u) => u?.name && ROLES[u.role]) : null;
    users = list ?? [{ name: 'operator', role: 'operator' }, ...ZONES.map((z) => ({ name: `zone-${z}`, role: 'zone', zone: z }))];
    store = configFile(file, { users: [] }, users.map((u) => `pw:${u.name}`));
    let changed = !list;
    for (const u of users) if (!store.cfg[`pw:${u.name}`]) { store.cfg[`pw:${u.name}`] = randPw(); changed = true; }
    store.cfg.users = users;
    if (typeof raw.anonymous === 'string' && (ROLES[raw.anonymous] || raw.anonymous === 'none')) st.anonymous = raw.anonymous;
    if (raw.anonymous == null) { store.cfg.anonymous = st.anonymous; changed = true; }
    if (changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); store.save(); }
  };
  load();
  const findUser = (name, pw) => {
    const iu = internal.get(name); if (iu) return iu.pw === String(pw ?? '') ? iu : null;
    const u = users.find((x) => x.name === name); if (!u || !store) return null;
    const want = String(store.cfg[`pw:${u.name}`] ?? ''); const a = Buffer.from(hash(pw ?? '', u.name)), b = Buffer.from(hash(want, u.name));
    return want && crypto.timingSafeEqual(a, b) ? u : null;
  };
  const allowedPub = (u) => (ROLES[u?.role]?.pub(u) ?? []);
  const canPublish = (user, topic) => { if (!st.enabled) return true; if (topic.startsWith('$')) return false; return allowedPub(user).some((p) => topicMatch(p, topic)); };
  const deny = (client, topic, why) => { st.denied++; st.lastDenied = { at: new Date().toISOString(), client: client?.id, user: client?.uns?.name ?? '(익명)', role: client?.uns?.role ?? st.anonymous, topic, why }; };

  return {
    status: () => ({ ...st, users: users.map((u) => ({ name: u.name, role: u.role, zone: u.zone ?? null, ko: ROLES[u.role].ko })), internal: internal.size }),
    password: (name) => (users.some((u) => u.name === name) ? String(store?.cfg[`pw:${name}`] ?? '') : null),
    // 앱 안 클라이언트 계정 발급
    mint(role, id, extra = {}) { const name = `_${role}-${id}`; let u = internal.get(name); if (!u) { u = { name, role, id, pw: randPw(), ...extra }; internal.set(name, u); } return { username: name, password: u.pw }; },   // 같은 역할·ID는 같은 계정 (Mosquitto 계정 파일에 미리 써 둠)
    // Mosquitto 계정·ACL 파일용 — 파일 계정 + 앱 내부 계정, 역할별 쓰기 패턴
    brokerUsers() {
      const out = [];
      for (const u of users) { const pw = String(store?.cfg[`pw:${u.name}`] ?? ''); if (pw) out.push({ name: u.name, password: pw, write: ROLES[u.role].pub(u) }); }
      for (const u of internal.values()) out.push({ name: u.name, password: u.pw, write: ROLES[u.role]?.pub(u) ?? [] });
      return out;
    },
    get anonymous() { return st.enabled ? st.anonymous : 'observer'; },
    get enabled() { return st.enabled; },
    canPublish,
    hooks() {
      return {
        authenticate: (client, username, password, cb) => {
          if (!st.enabled) return cb(null, true);
          if (username == null || username === '') {
            if (st.anonymous === 'none') { st.authFail++; const e = new Error('익명 접속 금지'); e.returnCode = 5; return cb(e, false); }
            client.uns = { name: null, role: st.anonymous }; return cb(null, true);
          }
          const u = findUser(username, password?.toString());
          if (!u) { st.authFail++; const e = new Error('계정 또는 비밀번호 오류'); e.returnCode = 4; return cb(e, false); }
          client.uns = u; cb(null, true);
        },
        authorizePublish: (client, packet, cb) => {
          if (!client) return cb(null);   // 브로커가 보내는 오래된 LWT
          if (packet.topic.startsWith('$SYS')) return cb(new Error('$SYS 예약 토픽'));
          if (!st.enabled) return cb(null);
          const u = client.uns ?? { role: st.anonymous };
          if (canPublish(u, packet.topic)) return cb(null);
          deny(client, packet.topic, `${ROLES[u.role]?.ko ?? u.role} 권한 밖`);
          cb(new Error(`발행 권한 없음: ${packet.topic}`));   // aedes는 이때 연결을 끊는다 (MQTT 3.1.1 — 거부 응답이 없음)
        },
        authorizeSubscribe: (client, sub, cb) => cb(null, sub),   // 읽기는 모두 허용
      };
    },
  };
}
