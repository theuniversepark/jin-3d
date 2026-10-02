// Claude 기반 공장 운영 에이전트 — 브라우저가 보낸 공장 스냅샷을 보고 도구(tool)로 운영 조치를 결정한다.
// 도구 실행 자체는 브라우저의 시뮬레이션에서 일어나므로, 여기서는 스냅샷 기준으로 검증한 뒤
// 조치를 모아 돌려준다(수동 에이전트 루프).

export const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }; // $ / MTok

const SYSTEM_PROMPT = `당신은 제조 라인의 운영을 맡은 AI 운영 에이전트입니다. 디지털 트윈에서 받은 공장 상태 스냅샷을 보고, 생산량(양품)·가용률·품질을 높이고 재공(WIP)과 에너지를 줄이는 방향으로 운영 조치를 결정합니다.

## 라인 구조
자재 투입 → 스냅샷 stations 배열 순서대로의 공정 → 완제품 적재. 각 공정의 type(유형), robot(로봇 종류·대수), task(하는 일)가 함께 주어지며, 운영자가 라인 구성을 바꿀 수 있으므로 매번 스냅샷 기준으로 판단하십시오. inspect=true인 검사 공정은 불량을 걸러내며 보정(cal) 대상이 아닙니다. 직렬 라인이라 어느 한 설비가 멈추면 앞쪽은 막히고(BLOCKED) 뒤쪽은 굶습니다(STARVED). 라인 산출은 사이클이 가장 긴 병목 설비가 결정합니다. 단, 정밀조립Zone(혼류)은 부품분류셀에서 도어트림 라인과 e-axle 라인으로 분기했다가 포장셀에서 합류합니다. 제품 전용 셀은 product_line과 처리 비중(share)이 함께 주어지며, 병목은 사이클×share(투입 1개당 부하)가 가장 큰 셀입니다. 한쪽 라인이 막히면 부품분류셀이 막혀 다른 제품도 멈출 수 있습니다.

## 설비 상태와 고장 특성
- state: BUSY 가동, STARVED 자재대기, BLOCKED 배출대기, DOWN 고장, MAINT 정비중.
- health(건강도, %)는 가공할 때마다 떨어집니다. 60% 이상에서는 고장 위험이 매우 낮지만, 60% 아래로 내려가면 위험이 제곱으로 급증합니다(risk10_pct = 10분 내 고장확률 추정).
- 예지정비(pm)는 health를 100%로 회복하고, 걸리는 시간은 pm_time_s입니다. 돌발 고장 수리는 repair_time_s 정도 걸리므로 훨씬 손실이 큽니다. 정비 인력(techs)이 한정되어 있어 동시에 여러 설비를 정비하면 대기가 생깁니다.
- 정비는 설비가 STARVED/BLOCKED일 때 하면 생산 손실이 거의 없습니다. 위험이 높으면 BUSY여도 바로 하는 편이 낫습니다.
- cpk(공정능력)가 1.33보다 낮으면 불량이 늘어납니다. 보정(cal)은 약 15초(무인공장은 자율 보정 10초) 걸리고 드리프트를 없앱니다.
- 사이클 고속화(boost)는 사이클을 10% 줄이는 대신 마모가 30% 늘어납니다. 큐가 쌓인 병목 설비에, health가 충분할 때만 쓰십시오.

## 흐름 제어
- 투입 간격(release_interval_s)을 병목 사이클보다 짧게 잡으면 재공만 늘어납니다. 병목 사이클의 약 0.95~1.0배가 적절합니다.
- 하류 설비가 멈춰 재공이 쌓이면 투입을 잠시 보류(hold)하고, 복구되면 해제하십시오. 보류를 잊고 남겨 두면 라인이 굶습니다.
- 자재 공급 차질(supply_disrupted_remaining_s > 0)이 생기면 expedite_supply로 안전재고를 투입하고 대체 공급처에 발주할 수 있습니다(차질 1건당 1회만 효과가 있음).

## 역할 분담
AGV 배차, 충전, 절전은 반사 계층(규칙)이 자동으로 처리합니다. 당신은 정비·품질·병목·투입·공급 차질 같은 감독 판단에 집중하고, 운영자 지시가 있으면 그에 답하고 따르십시오. 운영자 지시가 안전하지 않거나 생산에 해롭다면 이유를 설명하고 대안을 제시하십시오.

## 작업 방식
1. 스냅샷을 검토하고 지금 꼭 필요한 조치만 도구로 실행합니다. 필요한 조치가 없으면 도구를 호출하지 않아도 됩니다. 이미 request(정비 요청)가 걸려 있는 설비에 중복 지시하지 마십시오.
2. 각 도구의 reason에는 근거 수치(예: health 48%, 10분 고장확률 22%)를 넣어 한 문장으로 씁니다.
3. 마지막 응답은 운영자에게 보여 줄 한국어 2~3문장으로, 현재 상황 판단과 이번에 한 일(또는 하지 않은 이유)을 요약합니다. 운영자 질문이 있었다면 그 답을 먼저 쓰십시오. 마크다운 제목이나 목록은 쓰지 마십시오.`;

const reason = { type: 'string', description: '판단 근거 한 문장 (근거 수치 포함)' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

// 라인 구성이 바뀔 수 있으므로 설비 ID 목록으로 매 요청마다 도구를 만든다.
export function buildTools(stationIds) {
  const stationEnum = { type: 'string', enum: stationIds };
  const tools = [
  {
    name: 'schedule_maintenance',
    description: '설비에 정비 인력을 배정한다. kind=pm(예지정비: 건강도 100% 회복) 또는 cal(공정 재보정: Cpk 회복). 이미 DOWN/MAINT이거나 정비 요청이 걸린 설비에는 쓸 수 없다.',
    input_schema: obj({ station_id: stationEnum, kind: { type: 'string', enum: ['pm', 'cal'] }, reason }),
  },
  {
    name: 'set_cycle_mode',
    description: '설비 사이클 모드를 바꾼다. boost는 사이클 10% 단축(마모 +30%), normal은 표준 사이클. 고속은 한 번에 한 설비만 권장.',
    input_schema: obj({ station_id: stationEnum, mode: { type: 'string', enum: ['boost', 'normal'] }, reason }),
  },
  {
    name: 'set_release_interval',
    description: '자재 투입 간격(초)을 설정한다. 허용 범위 5~20초.',
    input_schema: obj({ seconds: { type: 'number' }, reason }),
  },
  {
    name: 'set_release_hold',
    description: '자재 투입을 보류(hold=true)하거나 재개(hold=false)한다.',
    input_schema: obj({ hold: { type: 'boolean' }, reason }),
  },
  {
    name: 'expedite_supply',
    description: '자재 공급 차질 중일 때 안전재고를 긴급 투입하고 대체 공급처에 발주해 차질 기간을 절반으로 줄인다.',
    input_schema: obj({ reason }),
  },
];
  for (const t of tools) t.strict = true;
  return tools;
}

// 스냅샷 기준으로 조치를 검증한다. 실제 적용은 브라우저에서 한 번 더 검증한다.
function validate(name, input, snap, pending) {
  const st = input.station_id && snap.stations.find((s) => s.id === input.station_id);
  switch (name) {
    case 'schedule_maintenance':
      if (!st) return '알 수 없는 설비';
      if (['DOWN', 'MAINT'].includes(st.state)) return `${st.id}는 이미 ${st.state} 상태`;
      if (st.request || pending.has('mnt:' + st.id)) return `${st.id}에 이미 정비 요청이 있음`;
      if (input.kind === 'cal' && st.inspect) return '검사 공정은 보정 대상이 아님';
      pending.add('mnt:' + st.id);
      return null;
    case 'set_cycle_mode':
      if (!st) return '알 수 없는 설비';
      if (input.mode === 'boost' && st.health < 55) return `${st.id} 건강도 ${st.health}%로 고속 운전 불가 (55% 이상 필요)`;
      return null;
    case 'set_release_interval':
      if (!(input.seconds >= 5 && input.seconds <= 20)) return '투입 간격은 5~20초';
      return null;
    case 'set_release_hold':
      return null;
    case 'expedite_supply':
      if (!(snap.material.supply_disrupted_remaining_s > 0)) return '현재 공급 차질이 없음';
      if (snap.material.expedited) return '이번 차질에는 이미 긴급 조달을 실행함';
      return null;
    default:
      return '알 수 없는 도구';
  }
}

function buildUserMessage({ snapshot, trigger, operatorMessage, history }) {
  const parts = [];
  parts.push(`## 호출 사유\n${trigger}`);
  if (history?.length) {
    parts.push('## 최근 대화·결정 기록 (오래된 순)\n' + history.map((h) => `- [${h.t}] ${h.who}: ${h.text}`).join('\n'));
  }
  parts.push('## 현재 공장 스냅샷 (JSON)\n```json\n' + JSON.stringify(snapshot) + '\n```');
  if (operatorMessage) parts.push(`## 운영자 지시/질문\n${operatorMessage}`);
  return parts.join('\n\n');
}

/**
 * 한 번의 에이전트 턴을 실행한다.
 * @returns {{ text, actions, rejected, usage, costUSD, model, stopReason }}
 */
export async function runAgentTurn(client, payload) {
  const { snapshot } = payload;
  const tools = buildTools(snapshot.stations.map((st) => st.id));
  const effort = payload.operatorMessage || payload.urgent ? 'medium' : 'low';
  const messages = [{ role: 'user', content: buildUserMessage(payload) }];
  const actions = [], rejected = [], pending = new Set();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let text = '', stopReason = null, model = MODEL;

  for (let iter = 0; iter < 6; iter++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    model = response.model;
    stopReason = response.stop_reason;
    for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] ?? 0;

    if (stopReason === 'refusal') {
      text = '요청이 안전 정책으로 거절되어 이번 주기에는 조치를 하지 않았습니다.';
      break;
    }
    const texts = response.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
    if (texts.length) text = texts.join('\n');

    if (stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (stopReason !== 'tool_use' || !toolUses.length) break;

    messages.push({ role: 'assistant', content: response.content });
    const results = toolUses.map((tu) => {
      const err = validate(tu.name, tu.input, snapshot, pending);
      if (err) {
        rejected.push({ name: tu.name, input: tu.input, error: err });
        return { type: 'tool_result', tool_use_id: tu.id, content: `거부됨: ${err}`, is_error: true };
      }
      actions.push({ name: tu.name, input: tu.input });
      return { type: 'tool_result', tool_use_id: tu.id, content: '승인됨 — 시뮬레이션에 적용 예정' };
    });
    messages.push({ role: 'user', content: results });
  }

  const costUSD = (usage.input_tokens * PRICE.input + usage.output_tokens * PRICE.output
    + usage.cache_read_input_tokens * PRICE.cacheRead + usage.cache_creation_input_tokens * PRICE.cacheWrite) / 1e6;
  return { text, actions, rejected, usage, costUSD, model, stopReason };
}
