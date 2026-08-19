import {createHash} from "node:crypto";
import type {TenantQueryClient} from "../database/tenant-transaction.js";

export interface CapacityAlertPolicy{unitId:string;enabled:boolean;minimumQueued:number|null;sustainedMinutes:number|null;
  version:number;updatedAt:Date|null;replayed?:boolean}
export interface CapacityAlertSnapshot{unitId:string;policyVersion:number;enabled:boolean;minimumQueued:number|null;
  sustainedMinutes:number|null;queuedCount:number;sustainedQueuedCount:number;oldestQueuedAt:Date|null;
  availableCapacity:number;state:"ACTIVE"|"CLEAR";evaluatedAt:Date}
export interface SetCapacityAlertPolicyInput{unitId:string;enabled:boolean;minimumQueued:number;sustainedMinutes:number;
  expectedVersion:number;idempotencyKey:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function normalize(input:Omit<SetCapacityAlertPolicyInput,"idempotencyKey">){const unitId=input.unitId.trim().toLowerCase();
  if(!UUID.test(unitId)||typeof input.enabled!=="boolean"||!Number.isInteger(input.minimumQueued)||input.minimumQueued<1
    ||input.minimumQueued>100||!Number.isInteger(input.sustainedMinutes)||input.sustainedMinutes<1||input.sustainedMinutes>120
    ||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)throw new Error("INVALID_CAPACITY_ALERT_POLICY_REQUEST");
  return{unitId,enabled:input.enabled,minimumQueued:input.minimumQueued,sustainedMinutes:input.sustainedMinutes,expectedVersion:input.expectedVersion}}
export function capacityAlertPolicyFingerprint(input:Omit<SetCapacityAlertPolicyInput,"idempotencyKey">){
  return createHash("sha256").update(JSON.stringify(normalize(input))).digest("hex")}
function unitId(value:string){const normalized=value.trim().toLowerCase();if(!UUID.test(normalized))throw new Error("INVALID_CAPACITY_ALERT_POLICY_REQUEST");return normalized}
export async function getUnitCapacityAlertPolicy(client:TenantQueryClient,requestedUnitId:string):Promise<CapacityAlertPolicy>{
  const result=await client.query(`SELECT unit_id AS "unitId",enabled,minimum_queued AS "minimumQueued",
    sustained_minutes AS "sustainedMinutes",version,updated_at AS "updatedAt" FROM get_unit_capacity_alert_policy($1)`,[unitId(requestedUnitId)]) as{rows:CapacityAlertPolicy[]};
  if(result.rows.length!==1)throw new Error("CAPACITY_ALERT_POLICY_NOT_FOUND");return result.rows[0]!}
export async function setUnitCapacityAlertPolicy(client:TenantQueryClient,input:SetCapacityAlertPolicyInput):Promise<CapacityAlertPolicy>{
  const value=normalize(input),key=input.idempotencyKey.trim();if(key.length<8||key.length>200)throw new Error("INVALID_CAPACITY_ALERT_POLICY_REQUEST");
  const result=await client.query(`SELECT unit_id AS "unitId",enabled,minimum_queued AS "minimumQueued",
    sustained_minutes AS "sustainedMinutes",version,updated_at AS "updatedAt",replayed
    FROM set_unit_capacity_alert_policy($1,$2,$3,$4,$5,$6,$7)`,[value.unitId,value.enabled,value.minimumQueued,
    value.sustainedMinutes,value.expectedVersion,key,capacityAlertPolicyFingerprint(value)]) as{rows:CapacityAlertPolicy[]};
  if(result.rows.length!==1)throw new Error("CAPACITY_ALERT_POLICY_NOT_FOUND");return result.rows[0]!}
export async function getUnitCapacityAlertSnapshot(client:TenantQueryClient,requestedUnitId:string,asOf?:Date):Promise<CapacityAlertSnapshot>{
  if(asOf&&!Number.isFinite(asOf.getTime()))throw new Error("INVALID_CAPACITY_ALERT_SNAPSHOT_REQUEST");
  const result=await client.query(`SELECT unit_id AS "unitId",policy_version AS "policyVersion",enabled,
    minimum_queued AS "minimumQueued",sustained_minutes AS "sustainedMinutes",queued_count AS "queuedCount",
    sustained_queued_count AS "sustainedQueuedCount",oldest_queued_at AS "oldestQueuedAt",
    available_capacity AS "availableCapacity",state,evaluated_at AS "evaluatedAt"
    FROM get_unit_capacity_alert_snapshot($1,$2)`,[unitId(requestedUnitId),asOf?.toISOString()??new Date().toISOString()]) as{rows:CapacityAlertSnapshot[]};
  if(result.rows.length!==1)throw new Error("CAPACITY_ALERT_POLICY_NOT_FOUND");return result.rows[0]!}
