# 센서망 운영 배포 (오픈소스 스택)

앱(맥 앱·`npm start`)은 같은 구조를 내장 구성으로 실행합니다.

- 공장 중앙 MQTT 브로커: Eclipse Mosquitto (앱 내장 · 대비 aedes)
- 센서 서버: 별도 프로세스(`server/sensor-server.mjs`)
- 센서 DB: SQLite(`node:sqlite`)

이 폴더는 실제 공장 서버에 올리는 운영용 구성입니다.

| 계층 | 앱 (내장) | 운영 (이 폴더) |
|---|---|---|
| 센서 → 셀 엣지 | 화면 시뮬레이션 (js/sensors.js) | IO-Link 마스터 · Modbus · LoRaWAN(ChirpStack) |
| 엣지 게이트웨이 | 시뮬레이션 | Node-RED (`nodered/flows_gateway.json`) · linuxptp Boundary Clock |
| 존 서버 → 공장 중앙 | Eclipse Mosquitto (앱 내장) | Eclipse Mosquitto 브리지 (`mosquitto/mosquitto.conf`) |
| 센서 서버 | server/sensor-server.mjs (MQTT.js) | Telegraf (`telegraf/telegraf.conf`) |
| 센서 DB | SQLite | TimescaleDB (`timescaledb/init.sql` — 하이퍼테이블, 1분 연속 집계, 보존 정책) |
| 대시보드 | 앱 🌡 센서 창 | Grafana (`grafana/`) |
| 시간 동기 | PTP 잔차 모델 | linuxptp ptp4l/phc2sys (`ptp/`) · chrony |

## 실행 방법

```bash
echo "SENSOR_DB_PASSWORD=<강한 암호>" > .env
docker compose up -d
```

- Grafana는 http://<서버>:3000 에서 열립니다. 처음 로그인 계정은 admin/admin이며 바로 바꾸세요.
- Node-RED는 http://<서버>:1880 에서 열립니다.

## 앱 시뮬레이션 데이터를 이 스택으로 보내기

앱을 실행할 때 `MQTT_BRIDGE_URL=mqtt://<서버>:1883`을 지정합니다. 앱 내장 브로커에 발행되는 메시지가 같은 토픽으로 이 Mosquitto에도 발행됩니다.

## 메시지 형식

- 측정값 묶음: `metafactory/sensors/v1/{zone}/{cell}` — 1초 묶음, `spec: metafactory/sensor-batch/1.0`
  - `readings[]`: 센서 ID(`s`), 지표(`m`), 값(`v`), 단위(`u`), 기준 시계 µs 타임스탬프(`ts`), 동기 잔차 µs(`e`)
  - `hops`: 엣지, 게이트웨이, 존 서버, 공장 중앙을 지난 시각
- 센서 메타: `metafactory/sensors/v1/{zone}/{cell}/birth` — retain으로 발행 (Sparkplug B의 BIRTH 개념)

## 시간 동기

- 공장 중앙: Grandmaster
- 엣지 게이트웨이: Boundary Clock
- 셀 엣지: Ordinary Clock

PTP 도메인은 24, 하드웨어 타임스탬프를 씁니다. 하드웨어 타임스탬프가 없는 장비는 chrony(NTP)로 동기합니다.

모든 타임스탬프가 같은 기준 시계를 쓰므로, 제품 계보, AAS/OPC UA, 품질 통신 같은 다른 데이터와 같은 시간 축으로 묶어 조회할 수 있습니다.

## 확인 상태

이 폴더의 구성 파일은 작성만 했고, 실제 docker 환경에서 실행해 확인하지는 않았습니다. 이미지 버전은 고정해 두었습니다.

운영에 쓰기 전에 아래를 적용하세요.

- MQTT 인증·TLS
- DB 암호
- Grafana 관리자 암호
