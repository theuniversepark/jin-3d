// MQTT 게이트웨이 — 내장 MQTT 브로커(aedes)로 OPC UA PubSub(JSON) 메시지를 발행한다.
// 브라우저(시뮬레이션)가 만든 NetworkMessage를 /api/mqtt/publish로 받아 브로커에 그대로 싣는다.
//   MQTT_HOST (기본 127.0.0.1) · MQTT_PORT (기본 1883) — 외부 PC에서 받으려면 MQTT_HOST=0.0.0.0
//   MQTT_BRIDGE_URL — 지정하면 같은 메시지를 외부 브로커(예: mqtt://broker.local:1883)에도 발행
import net from 'node:net';
import { Aedes } from 'aedes';

let broker = null, tcp = null, bridge = null;
const state = { listening: false, host: null, port: null, error: null, clients: 0, published: 0, bytes: 0, bridgeUrl: null, bridgeConnected: false, bridgeError: null, startedAt: null };

export async function startMqtt({ host = process.env.MQTT_HOST || '127.0.0.1', port = Number(process.env.MQTT_PORT) || 1883, bridgeUrl = process.env.MQTT_BRIDGE_URL } = {}) {
  if (broker) return state;
  broker = await Aedes.createBroker();
  broker.on('client', () => { state.clients = broker.connectedClients; });
  broker.on('clientDisconnect', () => { state.clients = broker.connectedClients; });
  tcp = net.createServer(broker.handle);
  await new Promise((resolve) => {
    tcp.once('error', (err) => {
      state.error = err.code === 'EADDRINUSE' ? `포트 ${port}이(가) 이미 사용 중입니다 (다른 Jin-3D나 브로커가 실행 중일 수 있음)` : err.message;
      resolve();
    });
    tcp.listen(port, host, () => { Object.assign(state, { listening: true, host, port, startedAt: new Date().toISOString() }); resolve(); });
  });
  if (bridgeUrl) {
    state.bridgeUrl = bridgeUrl.replace(/\/\/[^@/]*@/, '//***@');   // 자격 증명은 상태에 노출하지 않는다
    try {
      const { connect } = await import('mqtt');
      bridge = connect(bridgeUrl, { clientId: `jin3d-bridge-${process.pid}`, reconnectPeriod: 5000 });
      bridge.on('connect', () => { state.bridgeConnected = true; state.bridgeError = null; });
      bridge.on('close', () => { state.bridgeConnected = false; });
      bridge.on('error', (e) => { state.bridgeError = e.message; });
    } catch (e) { state.bridgeError = e.message; }
  }
  return state;
}

export const mqttStatus = () => ({ ...state });

// messages: [{ topic, payload(문자열), retain }]
export function mqttPublish(messages) {
  if (!broker) return 0;
  let n = 0;
  for (const m of messages) {
    if (typeof m?.topic !== 'string' || typeof m?.payload !== 'string' || !m.topic || m.topic.length > 512) continue;
    const payload = Buffer.from(m.payload, 'utf8');
    // aedes 1.2는 retain 발행을 저장만 하고 이미 구독 중인 클라이언트에는 보내지 않는다 (MQTT 3.1.1 §3.3.1.3 위반).
    // retain 메시지는 저장소에 직접 넣고(새 구독자용), 같은 내용을 일반 메시지로 발행한다(기존 구독자용).
    if (m.retain) broker.persistence.storeRetained({ cmd: 'publish', topic: m.topic, payload, qos: 0, retain: true, dup: false, brokerId: broker.id, brokerCounter: 0 }).catch(() => {});
    broker.publish({ cmd: 'publish', topic: m.topic, payload, qos: 0, retain: false, dup: false }, () => {});
    if (bridge?.connected) bridge.publish(m.topic, payload, { qos: 0, retain: !!m.retain });
    state.published++; state.bytes += payload.length; n++;
  }
  return n;
}
