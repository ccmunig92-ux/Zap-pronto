import {createHash} from "node:crypto";
import type {TenantQueryClient} from "../database/tenant-transaction.js";

export const ASSIGNMENT_POLICY_MODES=["OBSERVE","ENFORCE_NEW_ASSIGNMENTS"] as const;
export type AssignmentPolicyMode=typeof ASSIGNMENT_POLICY_MODES[number];
export interface AssignmentPolicyReadiness{operationalMembers:number;effectiveSchedules:number;missingSchedules:number;timezoneConfigured:boolean;ready:boolean}
export interface AssignmentPolicyRecord{unitId:string;mode:AssignmentPolicyMode;version:number;updatedAt:Date;replayed:boolean}
export interface UnitAssignmentPolicy extends AssignmentPolicyRecord{readiness:AssignmentPolicyReadiness}
export interface SetUnitAssignmentPolicyInput{unitId:string;mode:AssignmentPolicyMode;expectedVersion:number;idempotencyKey:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function normalized(input:{unitId:string;mode:AssignmentPolicyMode;expectedVersion:number}){const unitId=input.unitId.trim().toLowerCase();
  if(!UUID.test(unitId)||!ASSIGNMENT_POLICY_MODES.includes(input.mode)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)throw new Error("INVALID_ASSIGNMENT_POLICY_REQUEST");
  return{unitId,mode:input.mode,expectedVersion:input.expectedVersion}}
export function assignmentPolicyFingerprint(input:Omit<SetUnitAssignmentPolicyInput,"idempotencyKey">){return createHash("sha256").update(JSON.stringify(normalized(input))).digest("hex")}
type PolicyRow=AssignmentPolicyRecord;
async function readiness(client:TenantQueryClient,unitId:string):Promise<AssignmentPolicyReadiness>{const result=await client.query(`SELECT operational_members AS "operationalMembers",effective_schedules AS "effectiveSchedules",missing_schedules AS "missingSchedules",timezone_configured AS "timezoneConfigured",ready FROM get_unit_assignment_policy_readiness($1)`,[unitId]) as{rows:AssignmentPolicyReadiness[]};
  if(result.rows.length!==1)throw new Error("ASSIGNMENT_POLICY_NOT_FOUND");return result.rows[0]!}
export async function getUnitAssignmentPolicy(client:TenantQueryClient,unitId:string):Promise<UnitAssignmentPolicy>{const value=normalized({unitId,mode:"OBSERVE",expectedVersion:1});
  const result=await client.query(`SELECT unit_id AS "unitId",mode,version,updated_at AS "updatedAt",false AS replayed FROM get_unit_assignment_policy($1)`,[value.unitId]) as{rows:PolicyRow[]};
  if(result.rows.length!==1)throw new Error("ASSIGNMENT_POLICY_NOT_FOUND");return{...result.rows[0]!,readiness:await readiness(client,value.unitId)}}
export async function setUnitAssignmentPolicy(client:TenantQueryClient,input:SetUnitAssignmentPolicyInput):Promise<AssignmentPolicyRecord>{const value=normalized(input),idempotencyKey=input.idempotencyKey.trim();
  if(idempotencyKey.length<8||idempotencyKey.length>200)throw new Error("INVALID_ASSIGNMENT_POLICY_REQUEST");const fingerprint=assignmentPolicyFingerprint(value);
  const result=await client.query(`SELECT unit_id AS "unitId",mode,version,updated_at AS "updatedAt",replayed FROM set_unit_assignment_policy($1,$2,$3,$4,$5)`,[value.unitId,value.mode,value.expectedVersion,idempotencyKey,fingerprint]) as{rows:PolicyRow[]};
  if(result.rows.length!==1)throw new Error("ASSIGNMENT_POLICY_NOT_FOUND");return result.rows[0]!}
