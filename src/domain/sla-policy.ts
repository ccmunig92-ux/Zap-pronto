import { createHash } from "node:crypto";
import type { TenantQueryClient } from "../database/tenant-transaction.js";

export const SLA_PRIORITIES=["LOW","NORMAL","HIGH","URGENT"] as const;
export type SlaPriority=typeof SLA_PRIORITIES[number];
export interface SlaPolicyTarget{priority:SlaPriority;targetMinutes:number}
export interface UnitSlaPolicy{unitId:string;version:number;effectiveAt:Date;targets:SlaPolicyTarget[];replayed:boolean}
export interface SetUnitSlaPolicyInput{unitId:string;expectedVersion:number;targets:SlaPolicyTarget[];idempotencyKey:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeTargets(targets:SlaPolicyTarget[]):SlaPolicyTarget[]{
  if(!Array.isArray(targets)||targets.length!==4)throw new Error("INVALID_SLA_POLICY_REQUEST");
  const normalized=targets.map(target=>({priority:target.priority,targetMinutes:target.targetMinutes}))
    .sort((a,b)=>SLA_PRIORITIES.indexOf(a.priority)-SLA_PRIORITIES.indexOf(b.priority));
  if(normalized.some((target,index)=>target.priority!==SLA_PRIORITIES[index]
    ||!Number.isInteger(target.targetMinutes)||target.targetMinutes<1||target.targetMinutes>10080))
    throw new Error("INVALID_SLA_POLICY_REQUEST");
  return normalized;
}
export function slaPolicyFingerprint(input:Omit<SetUnitSlaPolicyInput,"idempotencyKey">){
  const unitId=input.unitId.trim().toLowerCase(),targets=normalizeTargets(input.targets);
  if(!UUID.test(unitId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)throw new Error("INVALID_SLA_POLICY_REQUEST");
  return createHash("sha256").update(JSON.stringify({unitId,expectedVersion:input.expectedVersion,targets})).digest("hex");
}
export async function getUnitSlaPolicy(client:TenantQueryClient,unitId:string):Promise<UnitSlaPolicy>{
  const normalized=unitId.trim().toLowerCase();if(!UUID.test(normalized))throw new Error("INVALID_SLA_POLICY_REQUEST");
  const result=await client.query(`SELECT unit_id AS "unitId",version,effective_at AS "effectiveAt",targets,replayed
    FROM get_unit_sla_policy($1)`,[normalized]) as {rows:UnitSlaPolicy[]};
  if(result.rows.length!==1)throw new Error("SLA_POLICY_NOT_FOUND");return result.rows[0]!;
}
export async function setUnitSlaPolicy(client:TenantQueryClient,input:SetUnitSlaPolicyInput):Promise<UnitSlaPolicy>{
  const unitId=input.unitId.trim().toLowerCase(),idempotencyKey=input.idempotencyKey.trim(),targets=normalizeTargets(input.targets);
  if(!UUID.test(unitId)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0||idempotencyKey.length<8||idempotencyKey.length>200)
    throw new Error("INVALID_SLA_POLICY_REQUEST");
  const fingerprint=slaPolicyFingerprint({unitId,expectedVersion:input.expectedVersion,targets});
  const result=await client.query(`SELECT unit_id AS "unitId",version,effective_at AS "effectiveAt",targets,replayed
    FROM set_unit_sla_policy($1,$2,$3::jsonb,$4,$5)`,[unitId,input.expectedVersion,JSON.stringify(targets),idempotencyKey,fingerprint]) as {rows:UnitSlaPolicy[]};
  if(result.rows.length!==1)throw new Error("SLA_POLICY_NOT_FOUND");return result.rows[0]!;
}
