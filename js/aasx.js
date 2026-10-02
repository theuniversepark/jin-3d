// AASX 패키지 (IDTA AAS Part 5, OPC Open Packaging Conventions) — 무압축 ZIP으로 만든다.
//   [Content_Types].xml · _rels/.rels → aasx/aasx-origin → (aas-spec) aasx/<이름>/<이름>.aas.xml
//   보조 파일(aas-suppl)은 aas-spec 파트의 관계 파일로 연결한다.
const enc = new TextEncoder();
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// files: [{ path, data(문자열|Uint8Array) }] → Uint8Array (ZIP, 저장 방식 0 = 무압축)
export function zipStore(files) {
  const parts = [], central = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.path), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let p = 0; for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rels = (items) => `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="${REL_NS}">\n${items.map((r, i) => `  <Relationship Type="${r.type}" Target="${r.target}" Id="R${(i + 1).toString(16).padStart(8, '0')}" />`).join('\n')}\n</Relationships>\n`;

// name: 파일 이름 바탕(영문), xml: AAS XML 직렬화, suppl: [{ path(패키지 안 절대 경로), data, contentType }]
export function buildAASX(name, xml, suppl = []) {
  const spec = `/aasx/${name}/${name}.aas.xml`;
  const exts = new Map([['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']]);
  for (const s of suppl) exts.set(s.path.split('.').pop(), s.contentType);
  const files = [
    { path: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n${[...exts].map(([e, t]) => `  <Default Extension="${e}" ContentType="${t}" />`).join('\n')}\n  <Override PartName="/aasx/aasx-origin" ContentType="text/plain" />\n</Types>\n` },
    { path: '_rels/.rels', data: rels([{ type: 'http://admin-shell.io/aasx/relationships/aasx-origin', target: '/aasx/aasx-origin' }]) },
    { path: 'aasx/aasx-origin', data: 'Intentionally empty.' },
    { path: 'aasx/_rels/aasx-origin.rels', data: rels([{ type: 'http://admin-shell.io/aasx/relationships/aas-spec', target: spec }]) },
    { path: spec.slice(1), data: xml },
  ];
  if (suppl.length) {
    files.push({ path: `aasx/${name}/_rels/${name}.aas.xml.rels`, data: rels(suppl.map((s) => ({ type: 'http://admin-shell.io/aasx/relationships/aas-suppl', target: s.path }))) });
    for (const s of suppl) files.push({ path: s.path.slice(1), data: s.data });
  }
  return zipStore(files);
}
