import type { FastifyInstance } from "fastify";
import {
  ClaimHandoffParamsSchema, ClaimHandoffRequestSchema, ClaimHandoffResponseSchema,
  ResolveHandoffRequestSchema,ResolveHandoffResponseSchema,
  RequeueHandoffRequestSchema,RequeueHandoffResponseSchema,
  ReopenHandoffRequestSchema,ReopenHandoffResponseSchema,
  TransferHandoffRequestSchema,TransferHandoffResponseSchema,ListInboxTransferCandidatesResponseSchema,
  TakeoverHandoffRequestSchema,TakeoverHandoffResponseSchema,
  ListHandoffsQuerySchema,ListActiveHandoffsQuerySchema,ListSupervisedHandoffsQuerySchema,ListResolvedHandoffsQuerySchema,ListResolvedHandoffsResponseSchema, ListHandoffsResponseSchema, ProblemDetailsSchema,
  type ClaimHandoffParams, type ClaimHandoffRequest,type ResolveHandoffRequest,type RequeueHandoffRequest,type ReopenHandoffRequest,type TransferHandoffRequest,type TakeoverHandoffRequest,type ListActiveHandoffsQuery,type ListSupervisedHandoffsQuery,type ListResolvedHandoffsQuery, type ListHandoffsQuery,
} from "@zap-pronto/contracts";
import { claimHandoff,resolveHandoff,requeueHandoff,reopenHandoff,resolveReopenUnit,listTransferCandidates,transferHandoff,transferFingerprint,takeoverHandoff,resolveTakeoverUnit, listHandoffs, listActiveHandoffs,listSupervisedHandoffs,listResolvedHandoffs, type InboxHandoff } from "@zap-pronto/core/domain/handoffs";
import type { TenantQueryClient, TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { protectedRoute } from "../http/protected-route.js";
import { InboxHandoffRequestError } from "./inbox-handoffs-errors.js";

function commandKey(headers: Record<string, unknown>): string {
  const value = headers["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 200) {
    throw new Error("INVALID_IDEMPOTENCY_KEY");
  }
  return value.trim();
}

async function inboxHandoff(client: TenantQueryClient, handoffId: string): Promise<InboxHandoff> {
  const result = await client.query(`
    SELECT h.id, h.conversation_id AS "conversationId", h.service_case_id AS "serviceCaseId",
      h.unit_id AS "unitId", contact.display_name AS "contactName", h.reason, h.priority, h.status,
      h.assigned_user_id AS "assignedUserId", h.requested_at AS "requestedAt", h.queued_at AS "queuedAt",
      h.sla_due_at AS "slaDueAt", CASE WHEN h.sla_due_at IS NULL THEN NULL WHEN h.sla_due_at<=now() THEN 'OVERDUE'
        WHEN h.sla_due_at<=now()+interval '15 minutes' THEN 'DUE_SOON' ELSE 'ON_TRACK' END AS "slaStatus",
      conversation.automation_status AS "automationStatus", h.version
    FROM human_handoffs h
    JOIN conversations conversation ON conversation.tenant_id=h.tenant_id AND conversation.id=h.conversation_id
    JOIN contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
    WHERE h.id=$1
  `, [handoffId]) as { rows: InboxHandoff[] };
  const handoff = result.rows[0];
  if (!handoff) throw InboxHandoffRequestError.notFound();
  return handoff;
}

async function handoffUnit(client: TenantQueryClient, handoffId: string): Promise<string> {
  return (await inboxHandoff(client, handoffId)).unitId;
}
async function scalarUnit(client:TenantQueryClient,text:string,values:unknown[]):Promise<string>{const result=await client.query(text,values) as{rows:{unitId:string|null}[]};
  const unit=result.rows[0]?.unitId;if(!unit)throw InboxHandoffRequestError.notFound();return unit}

function view(item: InboxHandoff) {
  return { ...item, requestedAt: item.requestedAt.toISOString(),
    queuedAt: item.queuedAt?.toISOString() ?? null, slaDueAt: item.slaDueAt?.toISOString() ?? null };
}

const problems = { 400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema,
  404: ProblemDetailsSchema, 409: ProblemDetailsSchema, 500: ProblemDetailsSchema, 503: ProblemDetailsSchema } as const;

export function registerInboxHandoffRoutes(app: FastifyInstance, pool: TenantTransactionPool): void {
  app.get("/v1/inbox/resolved",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"handoff.history.read",scope:{kind:"unit",
    async resolveUnitId(_client,request){return(request.query as ListResolvedHandoffsQuery).unitId}}},schema:{operationId:"listResolvedInboxHandoffs",
      querystring:ListResolvedHandoffsQuerySchema,response:{200:ListResolvedHandoffsResponseSchema,...problems}},async handler(client,request,reply){
      void reply.header("cache-control","no-store");try{const page=await listResolvedHandoffs(client,request.query as ListResolvedHandoffsQuery);
        return{...page,items:page.items.map(item=>({...item,resolvedAt:item.resolvedAt.toISOString()}))};
      }catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.get("/v1/inbox/active", protectedRoute({pool,authorization:{kind:"permission",permission:"conversation.read",scope:{kind:"unit",
    async resolveUnitId(_client,request){return(request.query as ListActiveHandoffsQuery).unitId}}},schema:{operationId:"listActiveInboxHandoffs",querystring:ListActiveHandoffsQuerySchema,
    response:{200:ListHandoffsResponseSchema,...problems}},async handler(client,request,reply){try{void reply.header("cache-control","no-store");const page=await listActiveHandoffs(client,request.query as ListActiveHandoffsQuery);
      return{...page,items:page.items.map(view)}}catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.get("/v1/inbox/supervised",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"handoff.takeover",scope:{kind:"unit",
    async resolveUnitId(_client,request){return(request.query as ListSupervisedHandoffsQuery).unitId}}},schema:{operationId:"listSupervisedInboxHandoffs",
    querystring:ListSupervisedHandoffsQuerySchema,response:{200:ListHandoffsResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{
      const page=await listSupervisedHandoffs(client,request.query as ListSupervisedHandoffsQuery);return{...page,items:page.items.map(view)}}catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.get("/v1/inbox/handoffs", protectedRoute({
    pool,
    authorization: { kind: "permission", permission: "handoff.read", scope: {
      kind: "unit", async resolveUnitId(_client, request) {
        return (request.query as ListHandoffsQuery).unitId;
      },
    } },
    schema: { operationId: "listHandoffs", querystring: ListHandoffsQuerySchema,
      response: { 200: ListHandoffsResponseSchema, ...problems } },
    async handler(client, request, reply) {
      try {
        void reply.header("cache-control", "no-store");
        const page = await listHandoffs(client, request.query as ListHandoffsQuery);
        return { ...page, items: page.items.map(view) };
      } catch (error) { return InboxHandoffRequestError.from(error); }
    },
  }));

  app.post("/v1/inbox/handoffs/:handoffId/claim", protectedRoute({
    pool,
    noStore: true,
    authorization: { kind: "permission", permission: "handoff.claim", scope: {
      kind: "unit", async resolveUnitId(client, request) {
        return handoffUnit(client, (request.params as ClaimHandoffParams).handoffId);
      },
    } },
    schema: { operationId: "claimHandoff", params: ClaimHandoffParamsSchema,
      headers: { type: "object", required: ["idempotency-key"],
        properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 200 } } },
      body: ClaimHandoffRequestSchema, response: { 200: ClaimHandoffResponseSchema, ...problems } },
    async handler(client, request, reply) {
      void reply.header("cache-control", "no-store");
      try {
        const params = request.params as ClaimHandoffParams;
        const body = request.body as ClaimHandoffRequest;
        const handoff = await inboxHandoff(client, params.handoffId);
        const result = await claimHandoff(client, { handoffId: params.handoffId,
          expectedVersion: body.expectedVersion, idempotencyKey: commandKey(request.headers) });
        return { handoff: view({ ...handoff, status: result.status, version: result.version,
          automationStatus: result.automationStatus ?? "HUMAN_ACTIVE",
          assignedUserId: result.assignedUserId ?? handoff.assignedUserId }), replayed: result.replayed ?? false };
      } catch (error) {
        if(error instanceof Error&&error.message==="ASSIGNEE_OUTSIDE_SHIFT")throw InboxHandoffRequestError.outsideShift();
        return InboxHandoffRequestError.from(error);
      }
    },
  }));
  app.post("/v1/inbox/handoffs/:handoffId/resolve",protectedRoute({pool,noStore:true,
    authorization:{kind:"permission",permission:"handoff.resolve",scope:{kind:"unit",async resolveUnitId(client,request){return handoffUnit(client,(request.params as ClaimHandoffParams).handoffId)}}},
    schema:{operationId:"resolveInboxHandoff",params:ClaimHandoffParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},
      body:ResolveHandoffRequestSchema,response:{200:ResolveHandoffResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{
      const params=request.params as ClaimHandoffParams,body=request.body as ResolveHandoffRequest;return await resolveHandoff(client,{handoffId:params.handoffId,
        expectedVersion:body.expectedVersion,disposition:body.disposition,idempotencyKey:commandKey(request.headers)});}catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.post("/v1/inbox/handoffs/:handoffId/requeue",protectedRoute({pool,noStore:true,
    authorization:{kind:"permission",permission:"handoff.requeue",scope:{kind:"unit",async resolveUnitId(client,request){return handoffUnit(client,(request.params as ClaimHandoffParams).handoffId)}}},
    schema:{operationId:"requeueInboxHandoff",params:ClaimHandoffParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},
      body:RequeueHandoffRequestSchema,response:{200:RequeueHandoffResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{
      const params=request.params as ClaimHandoffParams,body=request.body as RequeueHandoffRequest;return await requeueHandoff(client,{handoffId:params.handoffId,
      expectedVersion:body.expectedVersion,idempotencyKey:commandKey(request.headers)});}catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.post("/v1/inbox/handoffs/:handoffId/reopen",protectedRoute({pool,noStore:true,
    authorization:{kind:"permission",permission:"handoff.reopen",scope:{kind:"unit",async resolveUnitId(client,request){const id=(request.params as ClaimHandoffParams).handoffId,
      body=request.body as ReopenHandoffRequest,key=commandKey(request.headers),unitId=await resolveReopenUnit(client,{handoffId:id,expectedVersion:body.expectedVersion,reason:body.reason,idempotencyKey:key});
      if(!unitId)throw InboxHandoffRequestError.notFound();return unitId}}},schema:{operationId:"reopenInboxHandoff",params:ClaimHandoffParamsSchema,
      headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},body:ReopenHandoffRequestSchema,
      response:{200:ReopenHandoffResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{const params=request.params as ClaimHandoffParams,
      body=request.body as ReopenHandoffRequest;return await reopenHandoff(client,{handoffId:params.handoffId,expectedVersion:body.expectedVersion,reason:body.reason,
        idempotencyKey:commandKey(request.headers)})}catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.get("/v1/inbox/handoffs/:handoffId/transfer-candidates",protectedRoute({pool,noStore:true,
    authorization:{kind:"permission",permission:"handoff.transfer",scope:{kind:"unit",async resolveUnitId(client,request){const id=(request.params as ClaimHandoffParams).handoffId;
      return scalarUnit(client,'SELECT resolve_inbox_handoff_transfer_catalog_unit($1) AS "unitId"',[id])}}},
    schema:{operationId:"listInboxHandoffTransferCandidates",params:ClaimHandoffParamsSchema,response:{200:ListInboxTransferCandidatesResponseSchema,...problems}},
    async handler(client,request,reply){void reply.header("cache-control","no-store");try{return await listTransferCandidates(client,(request.params as ClaimHandoffParams).handoffId)}
      catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.post("/v1/inbox/handoffs/:handoffId/transfer",protectedRoute({pool,noStore:true,
    authorization:{kind:"permission",permission:"handoff.transfer",scope:{kind:"unit",async resolveUnitId(client,request){const id=(request.params as ClaimHandoffParams).handoffId,
      body=request.body as TransferHandoffRequest,key=commandKey(request.headers),fingerprint=transferFingerprint({handoffId:id,expectedVersion:body.expectedVersion,targetUserId:body.targetUserId,reason:body.reason});
      return scalarUnit(client,'SELECT resolve_inbox_handoff_transfer_unit($1,$2,$3,$4,$5,$6) AS "unitId"',[id,body.expectedVersion,body.targetUserId,body.reason,key,fingerprint])}}},
    schema:{operationId:"transferInboxHandoff",params:ClaimHandoffParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},
      body:TransferHandoffRequestSchema,response:{200:TransferHandoffResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{
      const params=request.params as ClaimHandoffParams,body=request.body as TransferHandoffRequest;return await transferHandoff(client,{handoffId:params.handoffId,expectedVersion:body.expectedVersion,
        targetUserId:body.targetUserId,reason:body.reason,idempotencyKey:commandKey(request.headers)})}catch(error){return InboxHandoffRequestError.from(error)}}}));
  app.post("/v1/inbox/handoffs/:handoffId/takeover",protectedRoute({pool,noStore:true,
    authorization:{kind:"permission",permission:"handoff.takeover",scope:{kind:"unit",async resolveUnitId(client,request){const id=(request.params as ClaimHandoffParams).handoffId,
      body=request.body as TakeoverHandoffRequest,key=commandKey(request.headers),unitId=await resolveTakeoverUnit(client,{handoffId:id,expectedVersion:body.expectedVersion,idempotencyKey:key});
      if(!unitId)throw InboxHandoffRequestError.notFound();return unitId}}},
    schema:{operationId:"takeoverInboxHandoff",params:ClaimHandoffParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},
      body:TakeoverHandoffRequestSchema,response:{200:TakeoverHandoffResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{
      const params=request.params as ClaimHandoffParams,body=request.body as TakeoverHandoffRequest;return await takeoverHandoff(client,{handoffId:params.handoffId,expectedVersion:body.expectedVersion,
        idempotencyKey:commandKey(request.headers)})}catch(error){return InboxHandoffRequestError.from(error)}}}));
}
