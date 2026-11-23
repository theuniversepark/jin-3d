-- 센서 DB (TimescaleDB) — 앱 센서 서버(SQLite)와 같은 구조 · 시각은 공장 기준 시계(PTP) 기준 UTC
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS sensor (
  id TEXT PRIMARY KEY, zone TEXT, cell TEXT, cell_name TEXT, edge TEXT, gateway TEXT, zone_server TEXT,
  type TEXT, cat TEXT, label TEXT, metric TEXT, unit TEXT, iface TEXT, rate REAL, x REAL, z REAL, spec TEXT, warn JSONB, alarm JSONB, birth_at TIMESTAMPTZ DEFAULT now());
-- Telegraf postgresql 출력이 측정값을 적재하는 표 (measurement = sensor_reading)
CREATE TABLE IF NOT EXISTS sensor_reading (
  time TIMESTAMPTZ NOT NULL, s TEXT NOT NULL, m TEXT, u TEXT, zone TEXT, cell TEXT, v DOUBLE PRECISION, e DOUBLE PRECISION);
SELECT create_hypertable('sensor_reading', 'time', if_not_exists => TRUE, chunk_time_interval => INTERVAL '6 hours');
CREATE INDEX IF NOT EXISTS sensor_reading_s_time ON sensor_reading (s, time DESC);
-- 1분 연속 집계 · 보존 정책 (원시 48시간 · 1분 집계 30일 — 앱 센서 서버와 같은 기준)
CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_1m WITH (timescaledb.continuous) AS
  SELECT time_bucket('1 minute', time) AS bucket, s, zone, cell, m, count(*) AS n, avg(v) AS avg, min(v) AS min, max(v) AS max
  FROM sensor_reading GROUP BY bucket, s, zone, cell, m WITH NO DATA;
SELECT add_continuous_aggregate_policy('sensor_1m', start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute', schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
SELECT add_retention_policy('sensor_reading', INTERVAL '48 hours', if_not_exists => TRUE);
SELECT add_retention_policy('sensor_1m', INTERVAL '30 days', if_not_exists => TRUE);
-- 경보 (규칙은 센서 서버 · Grafana 경보에서)
CREATE TABLE IF NOT EXISTS sensor_alarm (id BIGSERIAL PRIMARY KEY, time TIMESTAMPTZ NOT NULL, s TEXT, level TEXT, v DOUBLE PRECISION, rule JSONB, cleared_at TIMESTAMPTZ);
