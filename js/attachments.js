// 첨부 파일을 Claude에 보낼 형태로 변환한다.
// 이미지·PDF는 그대로(이미지는 축소), 텍스트류는 문자열로, 엑셀은 시트별 CSV, 워드는 본문 텍스트로.
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.tsv,.json,.xlsx,.xlsm,.xls,.docx,.hwp,.hwpx';
const MAX_PDF = 25 * 1024 * 1024;
const MAX_TEXT = 150000;
const MAX_EDGE = 1568;   // 긴 변 기준 — 도면 판독에 충분하면서 토큰을 아낀다

const ext = (name) => name.split('.').pop().toLowerCase();
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const keepPng = file.type === 'image/png' && scale === 1 && file.size < 3.5 * 1024 * 1024;
  if (keepPng || (scale === 1 && file.size < 3.5 * 1024 * 1024 && ['image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) {
    return { kind: 'image', media_type: file.type, data: toBase64(await file.arrayBuffer()), note: `${bmp.width}×${bmp.height}` };
  }
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
  const data = c.toDataURL('image/jpeg', 0.9).split(',')[1];
  return { kind: 'image', media_type: 'image/jpeg', data, note: `${bmp.width}×${bmp.height} → ${w}×${h} 축소` };
}

let mammothLoading = null;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  mammothLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/mammoth/mammoth.browser.min.js';
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => reject(new Error('워드 변환 모듈을 불러오지 못했습니다.'));
    document.head.appendChild(s);
  });
  return mammothLoading;
}

function asText(text, note) {
  const truncated = text.length > MAX_TEXT;
  return { kind: 'text', text: truncated ? text.slice(0, MAX_TEXT) : text, truncated, note: truncated ? `${note} · 앞 ${MAX_TEXT.toLocaleString()}자만 전송` : note };
}

export async function prepareFile(file) {
  const e = ext(file.name);
  const base = { name: file.name, size: file.size, sizeText: fmtSize(file.size) };
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(e)) return { ...base, ...(await prepareImage(file)) };
  if (e === 'pdf') {
    if (file.size > MAX_PDF) throw new Error(`${file.name}: PDF는 ${fmtSize(MAX_PDF)} 이하만 첨부할 수 있습니다.`);
    return { ...base, kind: 'pdf', data: toBase64(await file.arrayBuffer()), note: 'PDF' };
  }
  if (['txt', 'md', 'csv', 'tsv', 'json'].includes(e)) return { ...base, ...asText(await file.text(), e.toUpperCase()) };
  if (['xlsx', 'xlsm', 'xls'].includes(e)) {
    const XLSX = await import('../vendor/xlsx/xlsx.mjs');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const parts = wb.SheetNames.map((n) => `### 시트: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`);
    return { ...base, ...asText(parts.join('\n\n'), `엑셀 ${wb.SheetNames.length}개 시트 → CSV`) };
  }
  if (e === 'docx') {
    const mammoth = await loadMammoth();
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { ...base, ...asText(value, '워드 본문 텍스트') };
  }
  if (e === 'hwp' || e === 'hwpx') throw new Error(`${file.name}: 한글(HWP) 파일은 직접 읽을 수 없습니다. 한글에서 PDF로 저장한 뒤 첨부해 주세요.`);
  throw new Error(`${file.name}: 지원하지 않는 형식입니다 (PDF·이미지·엑셀·워드·텍스트 지원).`);
}
