// 앱 시작 때 .env 읽기 — 서버 모듈(server/*.mjs)을 불러오기 전에 실행되어야 해서 electron/main.mjs 가 가장 먼저 import 한다
// (server/claude-sub.mjs 는 불러올 때 환경변수를 복사해 둔다).
// 찾는 순서(먼저 읽은 값이 이긴다 · 이미 있는 환경변수는 그대로):
//   1. 사용자 데이터 폴더의 .env — 맥 ~/Library/Application Support/Jin-3D/.env · 윈도우 %APPDATA%\Jin-3D\.env (패키징한 앱은 여기에 둔다)
//   2. 프로젝트 폴더의 .env — 개발 실행(npm run app)일 때만. 패키징한 앱 묶음에는 .env 를 넣지 않는다(package.json --ignore)
import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/env-file.mjs';

export const USER_DATA = path.join(app.getPath('appData'), 'Jin-3D');   // electron/main.mjs 의 userData 와 같은 폴더
export const envFiles = [path.join(USER_DATA, '.env'), ...(app.isPackaged ? [] : [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')])];
export const envLoaded = envFiles.map((file) => ({ file, names: loadEnvFile(file) })).filter((e) => e.names.length);
