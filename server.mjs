// 브라우저용 실행: npm start → http://localhost:8765
//   API 키: ANTHROPIC_API_KEY 환경변수 또는 .env 파일. CLAUDE_AUTH=subscription 이면 키 대신 이 맥의 claude 로그인(Pro/Max 구독)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { loadEnvFile } = await import('./server/env-file.mjs');
loadEnvFile(path.join(ROOT, '.env'));   // 서버 모듈을 불러오기 전에 읽는다

const { startServer, hasApiKey } = await import('./server/app-server.mjs');
const { MODEL } = await import('./server/llm-agent.mjs');
const { port } = await startServer({ port: Number(process.env.PORT) || 8765 });
console.log(`피지컬AI 실증 메타팩토리 → http://localhost:${port}`);
const { mqttStatus } = await import('./server/mqtt-gateway.mjs');
const mq = mqttStatus();
console.log(mq.listening ? `MQTT 브로커 → mqtt://${mq.host}:${mq.port} (OPC UA PubSub JSON: opcua/json/#)` : `MQTT 브로커 시작 실패: ${mq.error}`);
console.log(hasApiKey() ? `Claude 에이전트 활성 (${MODEL}${process.env.CLAUDE_AUTH === 'subscription' ? ', 구독' : ''})` : 'ANTHROPIC_API_KEY 없음 — 정책 기반 에이전트만 사용 가능 (.env 또는 환경변수로 설정)');
