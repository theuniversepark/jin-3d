// 렌더러에 노출하는 최소 API — 키 원문은 메인 프로세스 밖으로 나오지 않는다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jin3d', {
  isApp: true,
  platform: process.platform,   // 'darwin'(맥) · 'win32'(윈도우) — 화면 문구·단축키 표기를 운영체제에 맞춘다
  keyStatus: () => ipcRenderer.invoke('key:status'),
  setApiKey: (key) => ipcRenderer.invoke('key:set', key),
  clearApiKey: () => ipcRenderer.invoke('key:clear'),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
});
