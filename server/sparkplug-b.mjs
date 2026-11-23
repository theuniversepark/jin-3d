// Sparkplug B (Eclipse Sparkplug 3.0 · ISO/IEC 20237:2023) 페이로드 — protobuf 인코딩·디코딩 (의존성 없이 필요한 필드만)
//   Payload { 1 timestamp(uint64) · 2 metrics(repeated Metric) · 3 seq(uint64) }
//   Metric  { 1 name(string) · 2 alias(uint64) · 3 timestamp(uint64) · 4 datatype(uint32) · 7 is_null(bool)
//             값: 10 int_value(uint32) · 11 long_value(uint64) · 12 float_value(float) · 13 double_value(double) · 14 boolean_value(bool) · 15 string_value(string) }
// 주제(토픽): spBv1.0/{group}/{NBIRTH|NDATA|NDEATH|NCMD|DBIRTH|DDATA|DDEATH|DCMD}/{edge}[/{device}] · 주 호스트 상태 spBv1.0/STATE/{host} (JSON)
export const SPB = 'spBv1.0';
export const DT = { Int8: 1, Int16: 2, Int32: 3, Int64: 4, UInt8: 5, UInt16: 6, UInt32: 7, UInt64: 8, Float: 9, Double: 10, Boolean: 11, String: 12, DateTime: 13, Text: 14 };
const INT32 = new Set([DT.Int8, DT.Int16, DT.Int32, DT.UInt8, DT.UInt16, DT.UInt32]), INT64 = new Set([DT.Int64, DT.UInt64, DT.DateTime]);

// ── 쓰기 ─────────────────
function varint(out, v) {
  v = Math.floor(Number(v));
  if (v < 0) v += 2 ** 64;   // 음수 int64 — 이 구현은 2^53 안의 값만 정확
  while (v >= 128) { out.push((v % 128) | 128); v = Math.floor(v / 128); }
  out.push(v);
}
const key = (out, field, wire) => varint(out, field * 8 + wire);
function bytesField(out, field, buf) { key(out, field, 2); varint(out, buf.length); for (const b of buf) out.push(b); }
const strField = (out, field, s) => bytesField(out, field, Buffer.from(String(s), 'utf8'));

function encodeMetric(m) {
  const o = [];
  if (m.name != null) strField(o, 1, m.name);
  if (m.alias != null) { key(o, 2, 0); varint(o, m.alias); }
  if (m.timestamp != null) { key(o, 3, 0); varint(o, m.timestamp); }
  key(o, 4, 0); varint(o, m.type);
  const v = m.value;
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) { key(o, 7, 0); o.push(1); return o; }
  if (INT32.has(m.type)) { key(o, 10, 0); varint(o, (Math.trunc(v) >>> 0)); }
  else if (INT64.has(m.type)) { key(o, 11, 0); varint(o, v); }
  else if (m.type === DT.Float) { key(o, 12, 5); const b = Buffer.alloc(4); b.writeFloatLE(v); o.push(...b); }
  else if (m.type === DT.Double) { key(o, 13, 1); const b = Buffer.alloc(8); b.writeDoubleLE(v); o.push(...b); }
  else if (m.type === DT.Boolean) { key(o, 14, 0); o.push(v ? 1 : 0); }
  else strField(o, 15, v);
  return o;
}
export function encodePayload({ timestamp = Date.now(), metrics = [], seq = null } = {}) {
  const out = [];
  key(out, 1, 0); varint(out, timestamp);
  for (const m of metrics) bytesField(out, 2, encodeMetric(m));
  if (seq != null) { key(out, 3, 0); varint(out, seq); }
  return Buffer.from(out);
}

// ── 읽기 ─────────────────
function reader(buf) {
  let i = 0;
  const vi = () => { let v = 0, mul = 1, b; do { if (i >= buf.length) throw new Error('varint 끝남'); b = buf[i++]; v += (b & 127) * mul; mul *= 128; } while (b & 128); return v; };
  return {
    done: () => i >= buf.length,
    tag: () => { const k = vi(); return [Math.floor(k / 8), k % 8]; },
    varint: vi,
    bytes: () => { const n = vi(); if (i + n > buf.length) throw new Error('길이 초과'); const s = buf.subarray(i, i + n); i += n; return s; },
    fixed: (n) => { if (i + n > buf.length) throw new Error('길이 초과'); const s = buf.subarray(i, i + n); i += n; return s; },
    skip(w) { if (w === 0) vi(); else if (w === 1) i += 8; else if (w === 2) i += vi(); else if (w === 5) i += 4; else throw new Error(`wire ${w}`); },
  };
}
function decodeMetric(buf) {
  const r = reader(buf), m = { value: undefined };
  while (!r.done()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 2) m.name = r.bytes().toString('utf8');
    else if (f === 2 && w === 0) m.alias = r.varint();
    else if (f === 3 && w === 0) m.timestamp = r.varint();
    else if (f === 4 && w === 0) m.type = r.varint();
    else if (f === 7 && w === 0) { if (r.varint()) m.value = null; }
    else if (f === 10 && w === 0) m.value = r.varint();
    else if (f === 11 && w === 0) m.value = r.varint();
    else if (f === 12 && w === 5) m.value = r.fixed(4).readFloatLE(0);
    else if (f === 13 && w === 1) m.value = r.fixed(8).readDoubleLE(0);
    else if (f === 14 && w === 0) m.value = !!r.varint();
    else if (f === 15 && w === 2) m.value = r.bytes().toString('utf8');
    else r.skip(w);
  }
  if ([DT.Int8, DT.Int16, DT.Int32].includes(m.type) && typeof m.value === 'number') m.value = m.value | 0;   // uint32 → 부호 있는 값
  return m;
}
export function decodePayload(buf) {
  const r = reader(Buffer.from(buf)), p = { metrics: [] };
  while (!r.done()) {
    const [f, w] = r.tag();
    if (f === 1 && w === 0) p.timestamp = r.varint();
    else if (f === 2 && w === 2) p.metrics.push(decodeMetric(r.bytes()));
    else if (f === 3 && w === 0) p.seq = r.varint();
    else r.skip(w);
  }
  return p;
}

// 주제 풀이 — spBv1.0/{group}/{type}/{edge}[/{device}]
export function parseTopic(t) {
  const p = t.split('/'); if (p[0] !== SPB) return null;
  if (p[1] === 'STATE') return { type: 'STATE', host: p[2] };
  return p.length >= 4 ? { group: p[1], type: p[2], edge: p[3], device: p[4] ?? null } : null;
}
export const topicOf = (group, type, edge, device = null) => [SPB, group, type, edge, ...(device ? [device] : [])].join('/');
