// 피지컬AI 실증 메타팩토리 맥·윈도우 앱 — 내장 로컬 서버를 띄우고 창에서 시뮬레이터를 연다.
// Claude API 키는 safeStorage(맥 키체인 · 윈도우 DPAPI)로 암호화해 사용자 데이터 폴더에만 저장한다.
import { envLoaded } from './env.mjs';   // .env 를 서버 모듈보다 먼저 읽는다 — 이 줄이 맨 위여야 한다
import { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, setApiKey, hasApiKey } from '../server/app-server.mjs';
import { setSecretCodec } from '../server/secrets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = '피지컬AI 실증 메타팩토리';
const IS_MAC = process.platform === 'darwin';
app.setName(APP_NAME);
// 사용자 데이터 폴더는 이름을 바꾸기 전(Jin-3D) 그대로 둔다 — 저장된 API 키·녹화·에피소드를 이어서 쓴다
app.setPath('userData', path.join(app.getPath('appData'), 'Jin-3D'));

const keyFile = () => path.join(app.getPath('userData'), 'anthropic-key.bin');
let win = null, origin = null, keySource = null, keyUnreadable = false;

function loadStoredKey() {
  try {
    if (fs.existsSync(keyFile()) && safeStorage.isEncryptionAvailable()) {
      const key = safeStorage.decryptString(fs.readFileSync(keyFile()));
      if (key) { setApiKey(key); keySource = 'keychain'; return; }
    }
  } catch (e) {
    // 앱 이름을 바꾸기 전(Jin-3D)에 저장한 키는 키체인 항목 이름이 달라 풀리지 않는다 — 설정 창에서 다시 입력하라고 알린다 (파일은 새로 저장할 때 덮어쓴다)
    keyUnreadable = true; console.error('저장된 키를 읽지 못했습니다 — ⚙ 설정에서 다시 입력하세요:', e.message);
  }
  keySource = setApiKey(null) ? 'env' : null;
}

function keyStatus() {
  return { hasKey: hasApiKey(), source: keySource, encryption: safeStorage.isEncryptionAvailable(), unreadable: keyUnreadable && !hasApiKey(), subscription: process.env.CLAUDE_AUTH === 'subscription', envFile: envLoaded.length > 0 };
}

ipcMain.handle('key:status', () => keyStatus());
ipcMain.handle('key:set', (_e, raw) => {
  const key = String(raw ?? '').trim();
  if (!key) return { ok: false, error: '키를 입력하세요.' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: IS_MAC ? '키체인 암호화를 사용할 수 없습니다.' : '윈도우 데이터 보호(DPAPI) 암호화를 사용할 수 없습니다.' };
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
  setApiKey(key); keySource = 'keychain'; keyUnreadable = false;
  return { ok: true, ...keyStatus() };
});
ipcMain.handle('key:clear', () => {
  fs.rmSync(keyFile(), { force: true }); keyUnreadable = false;
  keySource = setApiKey(null) ? 'env' : null;
  return { ok: true, ...keyStatus() };
});

function buildMenu() {
  const openSettings = () => win?.webContents.send('open-settings');
  if (!IS_MAC) return buildWinMenu(openSettings);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `${APP_NAME} 정보` },
        { type: 'separator' },
        { label: 'Agent API 키 설정…', accelerator: 'Cmd+,', click: openSettings },
        { type: 'separator' },
        { role: 'hide', label: `${APP_NAME} 가리기` },
        { role: 'hideOthers', label: '기타 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: `${APP_NAME} 종료` },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '실행 복귀' }, { type: 'separator' },
        { role: 'cut', label: '오려두기' }, { role: 'copy', label: '복사하기' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '전체 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '시뮬레이션 다시 불러오기' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    { role: 'windowMenu', label: '윈도우' },
  ]));
}

// 윈도우 메뉴 — 창 위 메뉴 막대(파일·편집·보기·도움말). 맥 전용 역할(가리기·windowMenu)은 쓰지 않는다
function buildWinMenu(openSettings) {
  const about = () => dialog.showMessageBox(win, {
    type: 'info', title: `${APP_NAME} 정보`, message: APP_NAME,
    detail: `버전 ${app.getVersion()}\n제조공정 · 스마트팩토리 · 다크팩토리 시뮬레이션 에이전트`,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '파일(&F)',
      submenu: [
        { label: 'Agent API 키 설정…', accelerator: 'Ctrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '편집(&E)',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' },
        { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' },
      ],
    },
    {
      label: '보기(&V)',
      submenu: [
        { role: 'reload', label: '시뮬레이션 다시 불러오기' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    { label: '도움말(&H)', submenu: [{ label: `${APP_NAME} 정보`, click: about }] },
  ]));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    title: APP_NAME, backgroundColor: '#0d1117', show: false,
    // 맥은 제목줄을 숨기고 신호등 버튼을 상단 바 안에 둔다. 윈도우는 기본 창틀(제목줄·최소화·닫기)을 쓴다
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 21 } } : {}),
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',   // 안내 아바타(토리)가 첫 인사부터 음성으로 말하게 (js/tori.js)
    },
  });
  win.once('ready-to-show', () => win.show());
  // 내장 서버 밖으로의 이동은 막고, 외부 링크는 기본 브라우저로 연다.
  win.webContents.on('will-navigate', (e, url) => {
    // 문자열 앞부분이 아니라 출처로 비교 — http://127.0.0.1:포트@다른호스트/ 처럼 앞이 같아도 다른 호스트로 가는 주소가 있다
    let same = false; try { same = new URL(url).origin === origin; } catch { /* 잘못된 주소 */ }
    if (!same) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 렌더러 프로세스가 죽어 창이 하얗게 되면 다시 불러온다
  win.webContents.on('render-process-gone', (e, d) => { if (d.reason !== 'clean-exit' && win) win.webContents.reload(); });
  win.on('closed', () => { win = null; });
  await win.loadURL(`${origin}/index.html`);
}

// GPU 컨텍스트를 한 번 잃은 뒤에도 WebGL을 다시 만들 수 있게 (Chromium은 기본적으로 손실이 반복되면 3D API를 막는다)
app.disableDomainBlockingFor3DAPIs();
// GPU 프로세스가 죽으면 Chromium이 다시 띄우고, 페이지는 컨텍스트 손실 처리로 렌더러를 새로 만든다
app.on('child-process-gone', (e, d) => { if (d.type === 'GPU') console.warn(`[피지컬AI 실증 메타팩토리] GPU 프로세스 종료 (${d.reason}) — 재시작`); });

app.whenReady().then(async () => {
  // 개발 실행(npm run app)에서도 Dock에 앱 아이콘 — 패키징한 앱은 build/icon.icns가 들어간다
  const devIcon = path.join(HERE, '..', 'build', 'icon.png');
  if (!app.isPackaged && process.platform === 'darwin' && fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
  for (const e of envLoaded) console.log(`.env 읽음: ${e.file} (${e.names.join(' · ')})`);   // 이름만 — 값은 찍지 않는다
  loadStoredKey();
  buildMenu();
  if (IS_MAC) app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: '제조공정 · 스마트팩토리 · 다크팩토리 시뮬레이션 에이전트',
  });
  try {
    process.env.JIN3D_DATA_DIR ??= path.join(app.getPath('userData'), 'data');   // VLA 에피소드 저장 위치
    // 외부 연동 키(뒤에 붙을 EPCIS 전송 · ERPNext 등)도 API 키와 같은 safeStorage로 암호화해 설정 파일에 둔다 (server/secrets.mjs)
    if (safeStorage.isEncryptionAvailable()) setSecretCodec({ encrypt: (t) => safeStorage.encryptString(t).toString('base64'), decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')) });
    // 고정 포트를 먼저 쓴다 — AAS에 넣은 영상 링크(http://127.0.0.1:47615/videos/…)가 앱을 다시 켜도 그대로 열리게. 이미 쓰이고 있으면 빈 포트
    const { port } = await startServer({ port: 47615, host: '127.0.0.1' }).catch(() => startServer({ port: 0, host: '127.0.0.1' }));
    origin = `http://127.0.0.1:${port}`;
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `내장 서버를 시작하지 못했습니다.\n${e.message}`);
    app.quit();
    return;
  }
  await createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
