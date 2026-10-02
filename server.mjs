// 브라우저용 실행: npm start → http://localhost:8765
//   API 키: ANTHROPIC_API_KEY 환경변수 또는 .env 파일
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { startServer, hasApiKey } = await import('./server/app-server.mjs');
const { MODEL } = await import('./server/llm-agent.mjs');
const { port } = await startServer({ port: Number(process.env.PORT) || 8765 });
console.log(`Jin-3D → http://localhost:${port}`);
const { mqttStatus } = await import('./server/mqtt-gateway.mjs');
const mq = mqttStatus();
console.log(mq.listening ? `MQTT 브로커 → mqtt://${mq.host}:${mq.port} (OPC UA PubSub JSON: opcua/json/#)` : `MQTT 브로커 시작 실패: ${mq.error}`);
console.log(hasApiKey() ? `Claude 에이전트 활성 (${MODEL})` : 'ANTHROPIC_API_KEY 없음 — 규칙 기반 에이전트만 사용 가능 (.env 또는 환경변수로 설정)');
