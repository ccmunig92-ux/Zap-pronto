import{createHash}from"node:crypto";import type{FastifyInstance}from"fastify";
import{InboxAvailabilityQuerySchema,InboxAvailabilitySchema,SetInboxAvailabilityRequestSchema,SetInboxAvailabilityResponseSchema,ProblemDetailsSchema,
  type InboxAvailabilityQuery,type SetInboxAvailabilityRequest,type InboxAvailability}from"@zap-pronto/contracts";
import type{TenantQueryClient,TenantTransactionPool}from"@zap-pronto/core/database/tenant-transaction";import{protectedRoute}from"../http/protected-route.js";
const problems={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,409:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema}as const;
function commandKey(headers:Record<string,unknown>){const value=headers["idempotency-key"];if(typeof value!=="string"||value.trim()!==value||value.length<8||value.length>200)throw new AvailabilityError(400,"INVALID_REQUEST");return value}
export class AvailabilityError extends Error{constructor(readonly statusCode:400|404|409,readonly code:string){super(code)}static from(error:unknown):never{if(error instanceof AvailabilityError)throw error;
  const code=error instanceof Error?error.message:"";if(code==="INVALID_AVAILABILITY_REQUEST")throw new AvailabilityError(400,"INVALID_REQUEST");
  if(code==="AVAILABILITY_NOT_FOUND")throw new AvailabilityError(404,"RESOURCE_NOT_FOUND");
  if(code==="AVAILABILITY_CONFLICT"||code==="AVAILABILITY_IDEMPOTENCY_CONFLICT"||code==="AVAILABILITY_ACTIVE_WORK_CONFLICT")throw new AvailabilityError(409,"AVAILABILITY_CONFLICT");throw error}}
type AvailabilityRow=Omit<InboxAvailability,"pausedUntil"|"updatedAt">&{pausedUntil:Date|null;updatedAt:Date;replayed?:boolean};
function view(row:AvailabilityRow){return{...row,pausedUntil:row.pausedUntil?.toISOString()??null,updatedAt:row.updatedAt.toISOString()}}
async function read(client:TenantQueryClient,unitId:string){const result=await client.query('SELECT unit_id AS "unitId",user_id AS "userId",status,max_active AS "maxActive",pause_reason AS "pauseReason",paused_until AS "pausedUntil",active_count AS "activeCount",version,updated_at AS "updatedAt" FROM get_actor_unit_availability($1)',[unitId])as{rows:AvailabilityRow[]};
  const row=result.rows[0];if(!row)throw new AvailabilityError(404,"RESOURCE_NOT_FOUND");return view(row)}
export function registerInboxAvailabilityRoutes(app:FastifyInstance,pool:TenantTransactionPool):void{
  app.get("/v1/inbox/availability",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"conversation.read",scope:{kind:"unit",async resolveUnitId(_client,request){return(request.query as InboxAvailabilityQuery).unitId}}},
    schema:{operationId:"getInboxAvailability",querystring:InboxAvailabilityQuerySchema,response:{200:InboxAvailabilitySchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{return await read(client,(request.query as InboxAvailabilityQuery).unitId)}catch(error){return AvailabilityError.from(error)}}}));
  app.post("/v1/inbox/availability",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"conversation.read",scope:{kind:"unit",async resolveUnitId(_client,request){return(request.body as SetInboxAvailabilityRequest).unitId}}},
    schema:{operationId:"setInboxAvailability",headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},body:SetInboxAvailabilityRequestSchema,response:{200:SetInboxAvailabilityResponseSchema,...problems}},
    async handler(client,request,reply){void reply.header("cache-control","no-store");try{const body=request.body as SetInboxAvailabilityRequest,key=commandKey(request.headers),pauseReason=body.pauseReason??null,pausedUntil=body.pausedUntil?new Date(body.pausedUntil).toISOString():null;
      const fingerprint=createHash("sha256").update(JSON.stringify({expectedVersion:body.expectedVersion,maxActive:body.maxActive,pauseReason,pausedUntil,status:body.status,unitId:body.unitId.toLowerCase()})).digest("hex");
      const result=await client.query('SELECT unit_id AS "unitId",user_id AS "userId",status,max_active AS "maxActive",pause_reason AS "pauseReason",paused_until AS "pausedUntil",active_count AS "activeCount",version,updated_at AS "updatedAt",replayed FROM set_actor_unit_availability($1,$2,$3,$4,$5,$6,$7,$8)',
        [body.unitId,body.status,body.maxActive,pauseReason,pausedUntil,body.expectedVersion,key,fingerprint])as{rows:AvailabilityRow[]};const row=result.rows[0];if(!row)throw new Error("AVAILABILITY_NOT_FOUND");return view(row)
    }catch(error){return AvailabilityError.from(error)}}}));
}
