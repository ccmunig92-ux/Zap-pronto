import {createHash} from "node:crypto";
import type {TenantQueryClient} from "../database/tenant-transaction.js";

export interface UnitOperationalTimezone{unitId:string;timeZone:string;version:number;updatedAt:Date;replayed?:boolean}
export interface SetUnitOperationalTimezoneInput{unitId:string;timeZone:string;expectedVersion:number;idempotencyKey:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function normalize(input:Omit<SetUnitOperationalTimezoneInput,"idempotencyKey">){
  const unitId=input.unitId.trim().toLowerCase(),timeZone=input.timeZone;
  if(!UUID.test(unitId)||typeof timeZone!=="string"||timeZone.trim()!==timeZone||timeZone.length<1||timeZone.length>100||/\s/.test(timeZone)
    ||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)throw new Error("INVALID_UNIT_OPERATIONAL_TIMEZONE_REQUEST");
  return{unitId,timeZone,expectedVersion:input.expectedVersion};
}
export function unitOperationalTimezoneFingerprint(input:Omit<SetUnitOperationalTimezoneInput,"idempotencyKey">){return createHash("sha256").update(JSON.stringify(normalize(input))).digest("hex")}
export async function getUnitOperationalTimezone(client:TenantQueryClient,unitId:string):Promise<UnitOperationalTimezone>{
  const normalized=unitId.trim().toLowerCase();if(!UUID.test(normalized))throw new Error("INVALID_UNIT_OPERATIONAL_TIMEZONE_REQUEST");
  const result=await client.query(`SELECT unit_id AS "unitId",time_zone AS "timeZone",version,updated_at AS "updatedAt" FROM get_unit_operational_timezone($1)`,[normalized])as{rows:UnitOperationalTimezone[]};
  if(result.rows.length!==1)throw new Error("UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND");return result.rows[0]!;
}
export async function setUnitOperationalTimezone(client:TenantQueryClient,input:SetUnitOperationalTimezoneInput):Promise<UnitOperationalTimezone>{
  const normalized=normalize(input),key=input.idempotencyKey.trim();if(key!==input.idempotencyKey||key.length<8||key.length>200)throw new Error("INVALID_UNIT_OPERATIONAL_TIMEZONE_REQUEST");
  const fingerprint=unitOperationalTimezoneFingerprint(normalized),result=await client.query(`SELECT unit_id AS "unitId",time_zone AS "timeZone",version,updated_at AS "updatedAt",replayed FROM set_unit_operational_timezone($1,$2,$3,$4,$5)`,[normalized.unitId,normalized.timeZone,normalized.expectedVersion,key,fingerprint])as{rows:UnitOperationalTimezone[]};
  if(result.rows.length!==1)throw new Error("UNIT_OPERATIONAL_TIMEZONE_NOT_FOUND");return result.rows[0]!;
}
