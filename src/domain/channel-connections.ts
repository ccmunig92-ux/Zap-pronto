import type { TenantQueryClient } from "../database/tenant-transaction.js";
import { createHash } from "node:crypto";

import type { ChannelScope } from "./contracts.js";
export interface AdminChannelConnection { id:string; type:"WHATSAPP"; scope:ChannelScope; displayName?:string; wabaId:string; phoneNumberId:string; status:string; secretConfigured:boolean; unitIds:string[]; }
function mapRow(row: any): AdminChannelConnection { return { id:row.id,type:"WHATSAPP",scope:row.scope, ...(row.displayName?{displayName:row.displayName}:{}), wabaId:row.wabaId,phoneNumberId:row.phoneNumberId,status:row.status,secretConfigured:Boolean(row.secretConfigured),unitIds:Array.isArray(row.unitIds)?row.unitIds:[] }; }
export async function listChannelConnections(client: TenantQueryClient): Promise<AdminChannelConnection[]> {
  const result=await client.query(`SELECT c.id,c.scope,c.display_name AS "displayName",COALESCE(c.waba_id,'') AS "wabaId",c.external_account_id AS "phoneNumberId",c.status,
    (c.secret_reference IS NOT NULL AND length(btrim(c.secret_reference))>0) AS "secretConfigured",
    COALESCE((SELECT array_agg(m.unit_id ORDER BY m.unit_id) FROM channel_connection_units m WHERE m.tenant_id=c.tenant_id AND m.channel_connection_id=c.id),'{}') AS "unitIds"
    FROM channel_connections c WHERE c.type='WHATSAPP' ORDER BY c.id`) as {rows:any[]};
  return result.rows.map(mapRow);
}

export interface SetChannelConnectionMetadataInput {
  id?: string; scope: ChannelScope; displayName?: string; wabaId: string; phoneNumberId: string;
  status: "ACTIVE" | "DEGRADED" | "DISCONNECTED"; secretReference: string; unitIds: string[];
  idempotencyKey: string;
}
export interface SetChannelConnectionMetadataResult extends AdminChannelConnection { replayed: boolean }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_ID=/^\d{6,32}$/;
const SECRET_REFERENCE=/^[A-Za-z0-9._-]{1,128}$/;
export function channelConnectionMetadataFingerprint(input: Omit<SetChannelConnectionMetadataInput,"idempotencyKey">): string {
  const id=input.id?.trim().toLowerCase() ?? null, units=[...input.unitIds].map(value=>value.trim().toLowerCase()).sort();
  if ((id!==null&&!UUID.test(id))||!META_ID.test(input.wabaId)||!META_ID.test(input.phoneNumberId)
    || !SECRET_REFERENCE.test(input.secretReference)||input.displayName!==undefined&&(!input.displayName.trim()||input.displayName!==input.displayName.trim())
    || units.some(unit=>!UUID.test(unit)) || new Set(units).size!==units.length || units.length>100
    )
    throw new Error("INVALID_CHANNEL_CONNECTION_REQUEST");
  if (input.scope==="CORPORATE"&&units.length!==0 || input.scope==="SINGLE_UNIT"&&units.length!==1 || input.scope==="SELECTED_UNITS"&&units.length<1)
    throw new Error("INVALID_CHANNEL_CONNECTION_REQUEST");
  return createHash("sha256").update(JSON.stringify({id,scope:input.scope,displayName:input.displayName??null,wabaId:input.wabaId,
    phoneNumberId:input.phoneNumberId,status:input.status,secretReference:input.secretReference,unitIds:units})).digest("hex");
}
export async function setChannelConnectionMetadata(client: TenantQueryClient, input: SetChannelConnectionMetadataInput): Promise<SetChannelConnectionMetadataResult> {
  const normalized={...(input.id===undefined?{}:{id:input.id.trim().toLowerCase()}),scope:input.scope,
    ...(input.displayName===undefined?{}:{displayName:input.displayName.trim()}),wabaId:input.wabaId.trim(),phoneNumberId:input.phoneNumberId.trim(),status:input.status,
    secretReference:input.secretReference.trim(),unitIds:[...input.unitIds].map(unit=>unit.trim().toLowerCase()).sort()};
  const fingerprint=channelConnectionMetadataFingerprint(normalized);
  const result=await client.query(`SELECT id,scope,display_name AS "displayName",waba_id AS "wabaId",external_account_id AS "phoneNumberId",status,
      (secret_reference IS NOT NULL AND length(btrim(secret_reference))>0) AS "secretConfigured",unit_ids AS "unitIds",replayed
    FROM set_channel_connection_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [normalized.id??null,normalized.scope,normalized.displayName??null,normalized.wabaId,normalized.phoneNumberId,normalized.status,
      normalized.secretReference,JSON.stringify(normalized.unitIds),input.idempotencyKey,fingerprint,"WHATSAPP"]);
  const rows=(result as { rows: any[] }).rows;
  if (rows.length!==1) throw new Error("CHANNEL_CONNECTION_NOT_FOUND");
  return { ...mapRow(rows[0]!), replayed: Boolean(rows[0].replayed) };
}
