// Jin-3D 맥 앱 — 내장 로컬 서버를 띄우고 창에서 시뮬레이터를 연다.
// Claude API 키는 macOS 키체인(safeStorage)으로 암호화해 사용자 데이터 폴더에만 저장한다.
import { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, setApiKey, hasApiKey } from '../server/app-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Jin-3D';
app.setName(APP_NAME);

const keyFile = () => path.join(app.getPath('userData'), 'anthropic-key.bin');
let win = null, origin = null, keySource = null;

function loadStoredKey() {
  try {
    if (fs.existsSync(keyFile()) && safeStorage.isEncryptionAvailable()) {
      const key = safeStorage.decryptString(fs.readFileSync(keyFile()));
      if (key) { setApiKey(key); keySource = 'keychain'; return; }
    }
  } catch (e) { console.error('저장된 키를 읽지 못했습니다:', e.message); }
  keySource = setApiKey(null) ? 'env' : null;
}

function keyStatus() {
  return { hasKey: hasApiKey(), source: keySource, encryption: safeStorage.isEncryptionAvailable() };
}

ipcMain.handle('key:status', () => keyStatus());
ipcMain.handle('key:set', (_e, raw) => {
  const key = String(raw ?? '').trim();
  if (!key) return { ok: false, error: '키를 입력하세요.' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '키체인 암호화를 사용할 수 없습니다.' };
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
  setApiKey(key); keySource = 'keychain';
  return { ok: true, ...keyStatus() };
});
ipcMain.handle('key:clear', () => {
  fs.rmSync(keyFile(), { force: true });
  keySource = setApiKey(null) ? 'env' : null;
  return { ok: true, ...keyStatus() };
});

function buildMenu() {
  const openSettings = () => win?.webContents.send('open-settings');
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

async function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    title: APP_NAME, backgroundColor: '#0d1117', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 21 },
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // 내장 서버 밖으로의 이동은 막고, 외부 링크는 기본 브라우저로 연다.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
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
app.on('child-process-gone', (e, d) => { if (d.type === 'GPU') console.warn(`[Jin-3D] GPU 프로세스 종료 (${d.reason}) — 재시작`); });

app.whenReady().then(async () => {
  loadStoredKey();
  buildMenu();
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: '제조공정 · 스마트팩토리 · 다크팩토리 시뮬레이션 에이전트',
  });
  try {
    process.env.JIN3D_DATA_DIR ??= path.join(app.getPath('userData'), 'data');   // VLA 에피소드 저장 위치
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
