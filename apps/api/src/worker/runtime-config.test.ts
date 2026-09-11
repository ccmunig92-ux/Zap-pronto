import assert from "node:assert/strict";import test from "node:test";
import { loadInboundWorkerRuntimeConfig } from "./runtime-config.js";
const url="postgresql://zap_pronto_worker_runtime:secret@postgres:5432/zap_pronto";
test("worker config is fail closed and bounded",async()=>{
  await assert.rejects(loadInboundWorkerRuntimeConfig({}),/DATABASE_WORKER_URL_REQUIRED/);
  const config=await loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url});
  assert.equal(config.batchSize,10);assert.equal(config.leaseSeconds,60);assert.equal(config.outboundEnabled,false);
  assert.equal(config.capacityAlertPollIntervalMs,60_000);assert.equal(config.capacityAlertDiscoveryPageSize,100);
  assert.equal(config.capacityAlertDiscoveryFailureThreshold,3);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,INBOUND_WORKER_BATCH_SIZE:"0"}),/BATCH_SIZE_INVALID/);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,INBOUND_WORKER_LEASE_SECONDS:"5",
    INBOUND_WORKER_SHUTDOWN_TIMEOUT_MS:"5000"}),/SHUTDOWN_TIMEOUT_INVALID/);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,DATABASE_WORKER_URL_FILE:"x"}),/SOURCE_CONFLICT/);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:"postgresql://zap_pronto_runtime:x@postgres/db"}),/URL_INVALID/);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,OUTBOUND_WORKER_ENABLED:"yes"}),/OUTBOUND_WORKER_ENABLED_INVALID/);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,CAPACITY_ALERT_POLL_INTERVAL_MS:"999"}),/CAPACITY_ALERT_POLL_INTERVAL_MS_INVALID/);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,CAPACITY_ALERT_DISCOVERY_PAGE_SIZE:"101"}),/CAPACITY_ALERT_DISCOVERY_PAGE_SIZE_INVALID/);
  await assert.rejects(loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,CAPACITY_ALERT_DISCOVERY_FAILURE_THRESHOLD:"0"}),/CAPACITY_ALERT_DISCOVERY_FAILURE_THRESHOLD_INVALID/);
  assert.equal((await loadInboundWorkerRuntimeConfig({DATABASE_WORKER_URL:url,OUTBOUND_WORKER_ENABLED:"true"})).outboundEnabled,true);
});
