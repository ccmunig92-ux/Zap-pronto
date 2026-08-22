import type { TenantQueryClient } from "../database/tenant-transaction.js";

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
