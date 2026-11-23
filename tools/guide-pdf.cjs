// 사용자 가이드 PDF 만들기 (Electron): docs/USER_GUIDE.md → docs/USER_GUIDE.pdf (화면 상단 「📘」로 내려받는 파일 — js/main.js GUIDE_PDF)
// 상위 meta-factory는 Word 파일을 LibreOffice로 바꾸지만, 여기는 Word 원본이 없어 마크다운을 HTML로 바꿔 Chromium(printToPDF)으로 찍는다.
// 그림은 docs/guide-images/ 의 JPEG를 그대로 넣는다(tools/guide-shots.cjs 가 가로 1600px · 품질 80으로 만든 것 — PDF 15MB 안).
// 실행: npm run guide:pdf   (PDF만) · npm run guide:docx (PDF + Word — LibreOffice soffice 필요)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..'), DOCS = path.join(ROOT, 'docs');
const SRC = path.join(DOCS, 'USER_GUIDE.md'), OUT = path.join(DOCS, 'USER_GUIDE.pdf'), TMP = path.join(DOCS, '.guide-pdf.html');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (() => { let n = 0; return () => `h${++n}`; })();

// 줄 안 꾸밈: `코드` · **굵게** · [글](주소) — 코드 안은 건드리지 않는다
function inline(t) {
  return t.split(/(`[^`]*`)/).map((p) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return `<code>${esc(p.slice(1, -1))}</code>`;
    return esc(p).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, a, u) => (/^https?:/.test(u) ? `<a href="${u}">${a}</a>` : `<span class="ref">${a}</span>`));
  }).join('');
}
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function render(md) {
  const L = md.replace(/<!--[\s\S]*?-->/g, '').split('\n'), out = [], toc = [];
  let i = 0, first = true;
  const list = (indent0) => {   // 들여쓰기(2칸)로 겹친 목록
    const ordered = /^\s*\d+\.\s/.test(L[i]); let h = ordered ? '<ol>' : '<ul>';
    while (i < L.length) {
      const m = L[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/); if (!m || m[1].length < indent0) break;
      if (m[1].length > indent0) { h = h.replace(/<\/li>$/, '') + list(m[1].length) + '</li>'; continue; }
      h += `<li>${inline(m[3])}</li>`; i++;
    }
    return h + (ordered ? '</ol>' : '</ul>');
  };
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if (l.startsWith('```')) { const b = []; i++; while (i < L.length && !L[i].startsWith('```')) b.push(L[i++]); i++; out.push(`<pre>${esc(b.join('\n'))}</pre>`); continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      const n = m[1].length, id = slug();
      if (n === 1 && first) { out.push(`<h1 class="title">${inline(m[2])}</h1>`); first = false; }
      else { if (n <= 3) toc.push([n, id, m[2]]); out.push(`<h${n} id="${id}">${inline(m[2])}</h${n}>`); }
      i++; continue;
    }
    if (/^---+\s*$/.test(l)) { i++; continue; }   // 가로줄은 장 제목이 대신한다
    if ((m = l.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/))) { out.push(`<figure><img src="${m[2]}"><figcaption>${inline(m[1])}</figcaption></figure>`); i++; continue; }
    if (l.startsWith('>')) { const b = []; while (i < L.length && L[i].startsWith('>')) b.push(L[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${inline(b.join(' '))}</blockquote>`); continue; }
    if (l.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(L[i + 1] ?? '')) {
      const head = cells(l); i += 2; const rows = [];
      while (i < L.length && L[i].trim().startsWith('|')) rows.push(cells(L[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) { out.push(list(l.match(/^\s*/)[0].length)); continue; }
    const p = []; while (i < L.length && L[i].trim() && !/^(#{1,4}\s|```|>|!\[|\s*([-*]|\d+\.)\s+|\s*\|)/.test(L[i])) p.push(L[i++]);
    if (!p.length) p.push(L[i++]);   // 어느 꼴에도 안 맞는 줄 — 그대로 문단으로
    out.push(`<p${p[0].startsWith('※') ? ' class="note"' : /^\*\*[^*]+\*\*$/.test(p.join('')) ? ' class="sub"' : ''}>${p.map(inline).join('<br>')}</p>`);   // sub: 굵은 글씨만 있는 줄(작은 제목) — 쪽 끝에 혼자 남지 않게
  }
  // 표지(제목 + 첫 문단 + 안내 상자) 뒤에 차례를 넣는다
  const at = out.findIndex((h) => h.startsWith('<h2'));
  const tocHtml = `<nav><div class="toc-h">차례</div>${toc.map(([n, id, t]) => `<a class="t${n}" href="#${id}">${inline(t)}</a>`).join('')}</nav>`;
  out.splice(at < 0 ? out.length : at, 0, tocHtml);
  return out.join('\n');
}

const CSS = `
@page { size: A4; margin: 16mm 15mm 17mm; }
body { font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', sans-serif; font-size: 9.6pt; line-height: 1.55; color: #1b2330; word-break: keep-all; overflow-wrap: anywhere; }
h1.title { font-size: 21pt; margin: 30mm 0 4mm; color: #12305c; border-bottom: 2.5pt solid #12305c; padding-bottom: 4mm; }
h2 { font-size: 15pt; color: #12305c; border-bottom: 1pt solid #9db2d1; padding-bottom: 1.5mm; margin: 0 0 3mm; break-before: page; }
h3 { font-size: 11.6pt; color: #1d4e89; margin: 6mm 0 2mm; break-after: avoid; }
h4 { font-size: 10.2pt; margin: 4mm 0 1.5mm; break-after: avoid; }
p { margin: 1.6mm 0; } p.note { color: #4a5568; font-size: 8.9pt; } p.sub { margin-top: 4mm; break-after: avoid; }
ul, ol { margin: 1.2mm 0; padding-left: 5.2mm; } li { margin: 0.7mm 0; }
blockquote { margin: 3mm 0; padding: 2.5mm 4mm; background: #f1f5fb; border-left: 3pt solid #1d4e89; color: #2d3748; font-size: 9.2pt; }
code { font-family: Menlo, Consolas, monospace; font-size: 8.3pt; background: #eef1f6; padding: 0 2pt; border-radius: 2pt; word-break: break-all; }
pre { font-family: Menlo, Consolas, monospace; font-size: 8.3pt; background: #f3f5f9; border: 0.5pt solid #d5dbe6; padding: 2.5mm 3mm; white-space: pre-wrap; break-inside: avoid; }
table { border-collapse: collapse; width: 100%; margin: 2.2mm 0 3mm; font-size: 8.7pt; }
th, td { border: 0.5pt solid #b7c2d3; padding: 1.2mm 1.8mm; vertical-align: top; text-align: left; }
th { background: #e4ebf5; color: #12305c; } tr { break-inside: avoid; } thead { display: table-header-group; }
figure { margin: 3mm 0 4mm; text-align: center; break-inside: avoid; }
figure img { max-width: 100%; max-height: 105mm; border: 0.5pt solid #b7c2d3; }
figcaption { font-size: 8.6pt; color: #4a5568; margin-top: 1mm; }
a { color: #1d4e89; text-decoration: none; } .ref { color: #1d4e89; }
nav { break-before: page; } .toc-h { font-size: 15pt; font-weight: 700; color: #12305c; border-bottom: 1pt solid #9db2d1; padding-bottom: 1.5mm; margin-bottom: 3mm; }
nav a { display: block; color: #1b2330; } nav a.t2 { font-weight: 700; margin-top: 2.2mm; } nav a.t3 { padding-left: 6mm; font-size: 9.2pt; }
`;

setTimeout(() => { console.error('TIMEOUT'); process.exitCode = 1; app.quit(); }, 180000);
app.whenReady().then(async () => {
  try {
    const md = fs.readFileSync(SRC, 'utf8');
    const missing = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]).filter((f) => !fs.existsSync(path.join(DOCS, f)));
    if (missing.length) throw new Error(`그림 파일 없음: ${missing.join(', ')}`);
    const title = (md.match(/^#\s+(.*)$/m) ?? [, '사용자 가이드'])[1];
    fs.writeFileSync(TMP, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${render(md)}</body></html>`);
    const w = new BrowserWindow({ show: false, width: 1000, height: 1400 });
    await w.loadFile(TMP);
    await w.webContents.executeJavaScript('Promise.all([...document.images].map((im) => im.decode().catch(() => {}))).then(() => document.fonts.ready).then(() => 1)');
    const foot = `<div style="width:100%;font-size:7pt;color:#667;padding:0 15mm;display:flex;justify-content:space-between;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif"><span>${esc(title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
    const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: foot, generateDocumentOutline: true });
    fs.writeFileSync(OUT, pdf);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    console.log(`PDF: ${path.relative(ROOT, OUT)} (${(pdf.length / 1048576).toFixed(1)}MB · ${pages}쪽)`);
    // Word 파일도 (npm run guide:docx · DOCX=1): 같은 HTML을 LibreOffice(soffice)로 docx로 바꾼다 — 그림은 파일 안에 넣는다. soffice가 없으면 건너뛴다
    if (process.env.DOCX) {
      const { spawnSync } = require('node:child_process');
      const bin = process.env.SOFFICE || 'soffice', docx = path.join(DOCS, 'USER_GUIDE.docx'), tmpDocx = TMP.replace(/\.html$/, '.docx');
      // 그림을 data: 주소로 넣어야 LibreOffice가 연결이 아니라 파일 안에 담는다
      // LibreOffice의 HTML 읽기는 CSS 일부만 따른다 — 그림 폭(쪽 폭 안)은 속성으로 주고, 차례는 한 줄에 하나씩(하위 절은 들여쓰기), 표는 테두리를 속성으로 준다
      const html = fs.readFileSync(TMP, 'utf8')
        .replace(/(<img[^>]*\ssrc=")([^"]+)(")/g, (m, a, src, c) => { const f = path.join(DOCS, decodeURIComponent(src)); return fs.existsSync(f) ? `<img width="640" src="data:image/${/\.png$/i.test(f) ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}"` : m; })
        .replace(/<a class="t(\d)" href="[^"]*">([\s\S]*?)<\/a>/g, (m, n, t) => `<p style="margin:0 0 0 ${(n - 1) * 6}mm">${t}</p>`)
        .replace(/<figcaption>/g, '<p align="center">').replace(/<\/figcaption>/g, '</p>')
        .replace(/<table>/g, '<table border="1" cellpadding="4" cellspacing="0" width="100%">');
      fs.writeFileSync(TMP, html);
      const r = spawnSync(bin, ['--headless', '--infilter=HTML (StarWriter)', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', DOCS, TMP], { encoding: 'utf8' });
      if (r.error || r.status || !fs.existsSync(tmpDocx)) throw new Error(`Word 변환 실패 (${bin}): ${r.error?.message ?? r.stderr ?? ''}`);
      fs.renameSync(tmpDocx, docx);
      console.log(`Word: ${path.relative(ROOT, docx)} (${(fs.statSync(docx).size / 1048576).toFixed(1)}MB)`);
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { fs.rmSync(TMP, { force: true }); app.quit(); }
});
