import type {TenantQueryClient} from "../database/tenant-transaction.js";
import type {AvailabilityPauseReason,AvailabilityStatus} from "./availability.js";

export type TeamAvailabilityRole="TENANT_ADMIN"|"UNIT_MANAGER"|"SUPERVISOR"|"ATTENDANT";
export interface TeamAvailabilityItem{userId:string;displayName:string;role:TeamAvailabilityRole;status:AvailabilityStatus;
  maxActive:number;activeCount:number;remainingCapacity:number;pauseReason:AvailabilityPauseReason|null;
  pausedUntil:Date|null;updatedAt:Date}
export interface ListTeamAvailabilityInput{unitId:string;limit?:number;status?:AvailabilityStatus;cursor?:string}
export interface TeamAvailabilityPage{items:TeamAvailabilityItem[];nextCursor?:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL=/^[A-Za-z0-9_-]+$/;
type Cursor={v:1;scope:"UNIT_TEAM_AVAILABILITY";unitId:string;statusFilter:AvailabilityStatus|null;displayName:string;userId:string};
function decodeCursor(value:string|undefined,unitId:string,status:AvailabilityStatus|undefined):Cursor|null{
  if(!value)return null;if(value.length>1024||!BASE64URL.test(value))throw new Error("INVALID_TEAM_AVAILABILITY_REQUEST");
  try{const bytes=Buffer.from(value,"base64url");if(bytes.toString("base64url")!==value)throw new Error();
    const parsed=JSON.parse(bytes.toString("utf8")) as Record<string,unknown>;
    if(Object.keys(parsed).sort().join(",")!=="displayName,scope,statusFilter,unitId,userId,v"||parsed.v!==1
      ||parsed.scope!=="UNIT_TEAM_AVAILABILITY"||parsed.unitId!==unitId||parsed.statusFilter!==(status??null)
      ||typeof parsed.displayName!=="string"||parsed.displayName.length<1||parsed.displayName.length>160
      ||typeof parsed.userId!=="string"||!UUID.test(parsed.userId))throw new Error();return parsed as unknown as Cursor;
  }catch{throw new Error("INVALID_TEAM_AVAILABILITY_REQUEST")}
}
export async function listTeamAvailability(client:TenantQueryClient,input:ListTeamAvailabilityInput):Promise<TeamAvailabilityPage>{
  const unitId=input.unitId.trim().toLowerCase(),limit=input.limit??25;
  if(!UUID.test(unitId)||!Number.isInteger(limit)||limit<1||limit>100
    ||(input.status!==undefined&&!(["AVAILABLE","PAUSED","OFFLINE"] as const).includes(input.status)))
    throw new Error("INVALID_TEAM_AVAILABILITY_REQUEST");
  const anchor=decodeCursor(input.cursor,unitId,input.status);
  const result=await client.query(`SELECT user_id AS "userId",display_name AS "displayName",role,status,
    max_active AS "maxActive",active_count AS "activeCount",remaining_capacity AS "remainingCapacity",
    pause_reason AS "pauseReason",paused_until AS "pausedUntil",updated_at AS "updatedAt"
    FROM list_unit_team_availability($1,$2,$3,$4,$5)`,[unitId,limit+1,input.status??null,anchor?.displayName??null,anchor?.userId??null]) as {rows:TeamAvailabilityItem[]};
  const items=result.rows.slice(0,limit),last=items.at(-1);return{items,...(result.rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({
    v:1,scope:"UNIT_TEAM_AVAILABILITY",unitId,statusFilter:input.status??null,displayName:last.displayName,userId:last.userId})).toString("base64url")}:{})};
}
