// Claude 기반 공장 운영 에이전트 (서버) — 프롬프트·도구·검증·턴 루프는 브라우저와 같이 쓰는 js/agentcore.js에 있다.
// 여기서는 Anthropic SDK 클라이언트(API 키) 또는 Claude 구독(claude CLI)으로 한 턴을 돌린다.
import { runAgentTurn as runCore, MODEL, SYSTEM_PROMPT, buildTools, validate, buildUserMessage } from '../js/agentcore.js';

export { MODEL };

/**
 * 한 번의 에이전트 턴을 실행한다 (API 키).
 * @returns {{ text, actions, rejected, usage, costUSD, model, stopReason }}
 */
export const runAgentTurn = (client, payload) => runCore((params) => client.beta.messages.create(params), payload);

// 구독(CLAUDE_AUTH=subscription) 경로: 같은 도구를 앱 내장 MCP 도구로 넘기고 루프는 claude CLI 가 돈다.
// 검증·승인 결과는 API 경로와 같다. 구독이라 호출 비용(costUSD)은 0 으로 둔다.
export async function runAgentTurnSub(payload) {
  const { runClaude, toolServer } = await import('./claude-sub.mjs');
  const { snapshot } = payload;
  const actions = [], rejected = [], pending = new Set();
  const tools = buildTools(snapshot.stations.map((st) => st.id)).map((t) => ({
    ...t,
    run: (input) => {
      const err = validate(t.name, input, snapshot, pending);
      if (err) { rejected.push({ name: t.name, input, error: err }); return { error: `거부됨: ${err}` }; }
      actions.push({ name: t.name, input });
      return '승인됨 — 시뮬레이션에 적용 예정';
    },
  }));
  const out = await runClaude({
    system: SYSTEM_PROMPT,
    content: buildUserMessage(payload),
    model: MODEL,
    effort: payload.operatorMessage || payload.urgent ? 'medium' : 'low',
    servers: { factory: toolServer('factory', tools) },
    maxTurns: 6,
  });
  const text = out.stopReason === 'refusal' ? '요청이 안전 정책으로 거절되어 이번 주기에는 조치를 하지 않았습니다.' : out.text;
  return { text, actions, rejected, usage: out.usage, costUSD: 0, model: out.model, stopReason: out.stopReason };
}
