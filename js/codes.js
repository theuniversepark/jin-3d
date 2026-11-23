// 2차원 코드 인코더 — QR 코드(ISO/IEC 18004, 바이트 모드 · 오류 정정 M · 1~10형) · Data Matrix(ISO/IEC 16022 ECC200, ASCII 인코딩 · 정사각 10~48)
// 제품 라벨(유연생산 C06 · 정밀조립 검사·포장셀) = QR + GS1 Digital Link, 금속 직접 각인(적응가공 CMM 셀) = GS1 DataMatrix (FNC1 + AI 원소 문자열)
// 외부 라이브러리 없이 만든다 (앱·웹 버전·공유 아티팩트 모두 오프라인) — 판독 검증은 tests/serial.mjs가 ZXing 디코더로 한다
// 결과는 boolean 2차원 배열 m[y][x] (true = 어두운 모듈) · 여백(quiet zone)은 그리는 쪽(drawCode)이 붙인다

// ── 갈루아체 GF(256) · 리드-솔로몬 ─────────────────
function gf(poly) {
  const exp = new Uint8Array(512), log = new Uint8Array(256);
  let x = 1; for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= poly; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
  return { exp, mul };
}
// 생성 다항식 근 α^b … α^(b+n−1) 로 나눈 나머지 (오류 정정 부호어 n개)
function rsRemainder(data, n, F, b) {
  let g = [1];
  for (let i = 0; i < n; i++) { const r = F.exp[i + b], ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= F.mul(g[j], r); } g = ng; }
  const rem = new Array(n).fill(0);
  for (const d of data) { const f = d ^ rem[0]; rem.shift(); rem.push(0); if (f) for (let j = 0; j < n; j++) rem[j] ^= F.mul(g[j + 1], f); }
  return rem;
}
const QR_GF = gf(0x11d), DM_GF = gf(0x12d);
const utf8 = (s) => [...new TextEncoder().encode(s)];

// ── QR 코드 ─────────────────
// 오류 정정 M — 형별 [블록당 오류 정정 부호어, [블록 수, 블록당 데이터 부호어] …]
const QR_M = [null,
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
  [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
const QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const QR_MASK = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];

export function qrMatrix(text) {
  const bytes = utf8(text);
  let ver = 1;
  const dataCw = (v) => QR_M[v][1].reduce((a, [n, k]) => a + n * k, 0);
  for (; ver <= 10; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCw(ver) * 8) break;
  if (ver > 10) throw new Error(`QR: 내용이 너무 깁니다 (${bytes.length}바이트)`);
  // 비트열: 바이트 모드 0100 · 글자 수 · 데이터 · 종료 0000 · 바이트 맞춤 · 채움 0xEC 0x11
  const cap = dataCw(ver) * 8, bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let p = 0; data.length < dataCw(ver); p++) data.push(p % 2 ? 0x11 : 0xec);
  // 블록 나누기 · 오류 정정 · 교차 배치
  const [ecn, groups] = QR_M[ver], blocks = []; let o = 0;
  for (const [n, k] of groups) for (let i = 0; i < n; i++) { const d = data.slice(o, o + k); o += k; blocks.push({ d, e: rsRemainder(d, ecn, QR_GF, 0) }); }
  const cw = [], maxK = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxK; i++) for (const b of blocks) if (i < b.d.length) cw.push(b.d[i]);
  for (let i = 0; i < ecn; i++) for (const b of blocks) cw.push(b.e[i]);

  const size = ver * 4 + 17, m = Array.from({ length: size }, () => new Array(size).fill(false)), fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { m[y][x] = !!v; fn[y][x] = true; };
  // 위치 찾기 무늬 + 분리 띠
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4);
  }
  // 정렬 무늬
  const al = QR_ALIGN[ver];
  for (const ay of al) for (const ax of al) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === al.at(-1)) || (ax === al.at(-1) && ay === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // 타이밍 무늬
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  // 형식 정보 자리 예약 · 어두운 모듈 · 형별 정보(7형 이상)
  const format = (mask) => {
    const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = (i) => (b >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, 1);
  };
  format(0);
  if (ver >= 7) {
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const v = (b >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, v); set(c, a, v); }
  }
  // 데이터 배치 (오른쪽 아래부터 두 열씩 지그재그 · 6번 열 건너뜀)
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (fn[y][x]) continue;
      if (i < cw.length * 8) m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
      i++;
    }
  }
  // 마스크 8종 중 벌점이 가장 낮은 것
  const apply = (k) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && QR_MASK[k](x, y)) m[y][x] = !m[y][x]; };
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) { apply(k); format(k); const p = penalty(m); if (p < bestP) { bestP = p; best = k; } apply(k); }
  apply(best); format(best);
  return m;
}
function penalty(m) {
  const n = m.length; let p = 0, dark = 0;
  const line = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b <= n; b++) { if (b < n && get(a, b) === get(a, b - 1)) run++; else { if (run >= 5) p += run - 2; run = 1; } }
      for (let b = 0; b + 11 <= n; b++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  line((a, b) => m[a][b]); line((a, b) => m[b][a]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
  for (const r of m) for (const c of r) if (c) dark++;
  return p + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
}

// ── Data Matrix ECC200 ─────────────────
// 정사각 기호 [한 변, 데이터 영역 한 변(구역당), 구역 수(한 방향), 데이터 부호어, 오류 정정 부호어] — 48×48까지는 리드-솔로몬 블록 1개
const DM_SIZES = [[10, 8, 1, 3, 5], [12, 10, 1, 5, 7], [14, 12, 1, 8, 10], [16, 14, 1, 12, 12], [18, 16, 1, 18, 14], [20, 18, 1, 22, 18],
  [22, 20, 1, 30, 20], [24, 22, 1, 36, 24], [26, 24, 1, 44, 28], [32, 14, 2, 62, 36], [36, 16, 2, 86, 42], [40, 18, 2, 114, 48], [44, 20, 2, 144, 56], [48, 22, 2, 174, 68]];
export const FNC1 = 'è';   // GS1 DataMatrix 시작 표시 (ASCII 부호어 232) — 문자열 맨 앞에 둔다
export const GS = '\u001d';     // 가변 길이 AI 뒤 구분자 (ASCII 29)
// ASCII 인코딩: 숫자 두 개 = 130 + 값 · 문자 = 코드 + 1 · 확장 문자 = 235, 코드 − 127 · FNC1 = 232
function dmEncode(text) {
  const out = [], cs = [...text];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], d = cs[i + 1];
    if (c === FNC1) { out.push(232); continue; }
    if (/\d/.test(c) && d && /\d/.test(d)) { out.push(130 + Number(c + d)); i++; continue; }
    const code = c.charCodeAt(0); if (code > 255) throw new Error('DataMatrix: ASCII·Latin-1 문자만');
    if (code > 127) out.push(235, code - 127); else out.push(code + 1);
  }
  return out;
}
export function dataMatrix(text) {
  const data = dmEncode(text), spec = DM_SIZES.find((s) => s[3] >= data.length);
  if (!spec) throw new Error(`DataMatrix: 내용이 너무 깁니다 (${data.length}부호어)`);
  const [size, reg, nreg, ndata, necc] = spec;
  // 채움: 첫 채움 129, 그다음은 253 상태 난수화
  for (let first = true; data.length < ndata; first = false) {
    const pos = data.length + 1, t = 129 + ((149 * pos) % 253) + 1;
    data.push(first ? 129 : t > 254 ? t - 254 : t);
  }
  const cw = [...data, ...rsRemainder(data, necc, DM_GF, 1)];
  // 부호어 → 매핑 행렬 (ISO/IEC 16022 부록 F "유타" 배치)
  const nrow = reg * nreg, ncol = reg * nreg, A = Array.from({ length: nrow }, () => new Array(ncol).fill(0));
  const mod = (r, c, ch, bit) => { if (r < 0) { r += nrow; c += 4 - ((nrow + 4) % 8); } if (c < 0) { c += ncol; r += 4 - ((ncol + 4) % 8); } A[r][c] = 10 * ch + bit; };
  const utah = (r, c, ch) => { mod(r - 2, c - 2, ch, 1); mod(r - 2, c - 1, ch, 2); mod(r - 1, c - 2, ch, 3); mod(r - 1, c - 1, ch, 4); mod(r - 1, c, ch, 5); mod(r, c - 2, ch, 6); mod(r, c - 1, ch, 7); mod(r, c, ch, 8); };
  const corner = (ch, pts) => pts.forEach(([r, c], k) => mod(r, c, ch, k + 1));
  let ch = 1, r = 4, c = 0;
  do {
    if (r === nrow && c === 0) corner(ch++, [[nrow - 1, 0], [nrow - 1, 1], [nrow - 1, 2], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (r === nrow - 2 && c === 0 && ncol % 4) corner(ch++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 4], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1]]);
    if (r === nrow - 2 && c === 0 && ncol % 8 === 4) corner(ch++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (r === nrow + 4 && c === 2 && !(ncol % 8)) corner(ch++, [[nrow - 1, 0], [nrow - 1, ncol - 1], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 3], [1, ncol - 2], [1, ncol - 1]]);
    do { if (r < nrow && c >= 0 && !A[r][c]) utah(r, c, ch++); r -= 2; c += 2; } while (r >= 0 && c < ncol);
    r += 1; c += 3;
    do { if (r >= 0 && c < ncol && !A[r][c]) utah(r, c, ch++); r += 2; c -= 2; } while (r < nrow && c >= 0);
    r += 3; c += 1;
  } while (r < nrow || c < ncol);
  if (!A[nrow - 1][ncol - 1]) { A[nrow - 1][ncol - 1] = A[nrow - 2][ncol - 2] = 1; }
  const dark = (v) => (v === 1 ? true : v >= 10 ? ((cw[Math.floor(v / 10) - 1] >>> (8 - (v % 10))) & 1) === 1 : false);
  // 매핑 행렬 + 구역마다 찾기 무늬(왼쪽·아래 실선 L · 위·오른쪽 점선)
  const m = Array.from({ length: size }, () => new Array(size).fill(false)), rs = reg + 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ly = y % rs, lx = x % rs;
    if (lx === 0 || ly === rs - 1) m[y][x] = true;
    else if (ly === 0) m[y][x] = lx % 2 === 0;
    else if (lx === rs - 1) m[y][x] = ly % 2 === 1;
    else m[y][x] = dark(A[Math.floor(y / rs) * reg + ly - 1][Math.floor(x / rs) * reg + lx - 1]);
  }
  return m;
}
