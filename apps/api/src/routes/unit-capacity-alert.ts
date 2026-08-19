import type { FastifyInstance } from "fastify";
import {
  InboxCapacityAlertQuerySchema,
  InboxCapacityAlertSnapshotSchema,
  ProblemDetailsSchema,
  SetUnitCapacityAlertPolicyRequestSchema,
  SetUnitCapacityAlertPolicyResponseSchema,
  UnitCapacityAlertPolicyParamsSchema,
  UnitCapacityAlertPolicySchema,
  type InboxCapacityAlertQuery,
  type SetUnitCapacityAlertPolicyRequest,
} from "@zap-pronto/contracts";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import {getUnitCapacityAlertPolicy,getUnitCapacityAlertSnapshot,setUnitCapacityAlertPolicy,type CapacityAlertPolicy} from "@zap-pronto/core";
import { protectedRoute } from "../http/protected-route.js";

const problems={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,409:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema}as const;

export class CapacityAlertError extends Error{
  constructor(readonly statusCode:400|404|409,readonly code:string){super(code)}
  static from(error:unknown):never{if(error instanceof CapacityAlertError)throw error;const code=error instanceof Error?error.message:"";
    if(code==="INVALID_CAPACITY_ALERT_POLICY_REQUEST")throw new CapacityAlertError(400,"INVALID_REQUEST");
    if(code==="CAPACITY_ALERT_POLICY_NOT_FOUND")throw new CapacityAlertError(404,"RESOURCE_NOT_FOUND");
    if(code==="CAPACITY_ALERT_POLICY_CONFLICT"||code==="CAPACITY_ALERT_POLICY_IDEMPOTENCY_CONFLICT")throw new CapacityAlertError(409,"CAPACITY_ALERT_POLICY_CONFLICT");throw error}
}
function commandKey(headers:Record<string,unknown>){const value=headers["idempotency-key"];if(typeof value!=="string"||value.trim()!==value||value.length<8||value.length>200)throw new CapacityAlertError(400,"INVALID_REQUEST");return value}
function policyView(row:CapacityAlertPolicy){return{unitId:row.unitId,mode:row.enabled?"ENABLED"as const:"DISABLED"as const,minimumQueued:row.minimumQueued,sustainedMinutes:row.sustainedMinutes,version:row.version,updatedAt:row.updatedAt?.toISOString()??null}}

export function registerUnitCapacityAlertRoutes(app:FastifyInstance,pool:TenantTransactionPool):void{
  app.get("/v1/units/:unitId/capacity-alert-policy",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"sla_alert.read",scope:{kind:"unit",async resolveUnitId(_c,r){return(r.params as{unitId:string}).unitId}}},schema:{operationId:"getUnitCapacityAlertPolicy",params:UnitCapacityAlertPolicyParamsSchema,response:{200:UnitCapacityAlertPolicySchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{return policyView(await getUnitCapacityAlertPolicy(client,(request.params as{unitId:string}).unitId))}catch(error){return CapacityAlertError.from(error)}}}));
  app.post("/v1/units/:unitId/capacity-alert-policy",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"sla_alert.manage",scope:{kind:"unit",async resolveUnitId(_c,r){return(r.params as{unitId:string}).unitId}}},schema:{operationId:"setUnitCapacityAlertPolicy",params:UnitCapacityAlertPolicyParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},body:SetUnitCapacityAlertPolicyRequestSchema,response:{200:SetUnitCapacityAlertPolicyResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{const unitId=(request.params as{unitId:string}).unitId,body=request.body as SetUnitCapacityAlertPolicyRequest,key=commandKey(request.headers),enabled=body.mode==="ENABLED";
    const row=await setUnitCapacityAlertPolicy(client,{unitId,enabled,minimumQueued:body.minimumQueued,sustainedMinutes:body.sustainedMinutes,expectedVersion:body.expectedVersion,idempotencyKey:key});return{...policyView(row),replayed:Boolean(row.replayed)}}catch(error){return CapacityAlertError.from(error)}}}));
  app.get("/v1/inbox/capacity-alert",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"sla_alert.read",scope:{kind:"unit",async resolveUnitId(_c,r){return(r.query as InboxCapacityAlertQuery).unitId}}},schema:{operationId:"getInboxCapacityAlert",querystring:InboxCapacityAlertQuerySchema,response:{200:InboxCapacityAlertSnapshotSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{const row=await getUnitCapacityAlertSnapshot(client,(request.query as InboxCapacityAlertQuery).unitId);return{...row,oldestQueuedAt:row.oldestQueuedAt?.toISOString()??null,evaluatedAt:row.evaluatedAt.toISOString()}}catch(error){return CapacityAlertError.from(error)}}}));
}
