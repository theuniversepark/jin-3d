// 배포 캐시 어긋남 방지 — index.html에 앱 파일별 버전(내용 해시)을 붙인다.
// GitHub Pages는 파일마다 따로 10분 캐시(max-age=600)하므로, 배포 직후 새 index.html과 캐시에 남은 예전 js가 섞이면
// 시작 단계에서 멈출 수 있다. 그래서 js/*.js를 import map으로 `./js/x.js?v=<해시>`에 연결하고(모듈 안의 상대 import도 같은 표를 탄다),
// 진입 스크립트(js/main.js)와 css/style.css에도 ?v=를 붙인다. 내용이 바뀐 파일만 주소가 바뀌어 새로 받는다.
// 실행: node tools/stamp-version.mjs        (index.html 갱신)
//       node tools/stamp-version.mjs --check (갱신이 필요하면 실패 — npm test에서 확인)
// 커밋 전 자동 실행: .githooks/pre-commit (git config core.hooksPath .githooks)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const hash = (rel) => crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 10);

const files = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).sort();
const map = { three: './vendor/three/three.module.js', 'three/webgpu': './vendor/three/three.webgpu.js', 'three/addons/': './vendor/three/addons/' };   // three/webgpu: 안내 아바타 토리 전용 캔버스 (js/tori.js)
for (const f of files) map[`./js/${f}`] = `./js/${f}?v=${hash(`js/${f}`)}`;
const json = `{ "imports": {\n${Object.entries(map).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n    } }`;

const before = fs.readFileSync(HTML, 'utf8');
let after = before.replace(/(<script type="importmap">\s*)[\s\S]*?(\s*<\/script>)/, `$1${json}$2`);
after = after.replace(/(<link rel="stylesheet" href="css\/style\.css)(\?v=[0-9a-f]+)?(")/, `$1?v=${hash('css/style.css')}$3`);
after = after.replace(/(<script type="module" src="js\/main\.js)(\?v=[0-9a-f]+)?(")/, `$1?v=${hash('js/main.js')}$3`);
for (const [what, ok] of [['import map', after.includes('"./js/main.js"')], ['style.css', /css\/style\.css\?v=/.test(after)], ['main.js 진입', /src="js\/main\.js\?v=/.test(after)]]) {
  if (!ok) { console.error(`stamp-version: index.html에서 ${what} 자리를 찾지 못했습니다`); process.exit(1); }
}

if (process.argv.includes('--check')) {
  if (after !== before) { console.error('stamp-version: index.html 버전이 최신이 아닙니다 — node tools/stamp-version.mjs 를 실행하세요'); process.exit(1); }
  console.log(`stamp-version: 최신 (js ${files.length}개 · css)`);
} else if (after !== before) { fs.writeFileSync(HTML, after); console.log(`stamp-version: index.html 갱신 (js ${files.length}개 · css)`); }
else console.log('stamp-version: 바뀐 파일 없음');
