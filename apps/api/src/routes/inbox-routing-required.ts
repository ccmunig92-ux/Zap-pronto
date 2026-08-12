import type{FastifyInstance}from"fastify";
import{ListRoutingRequiredQuerySchema,ListRoutingRequiredResponseSchema,ProblemDetailsSchema,
  ResolveRoutingRequiredParamsSchema,ResolveRoutingRequiredRequestSchema,ResolveRoutingRequiredResponseSchema,
  type ListRoutingRequiredQuery,type ResolveRoutingRequiredParams,type ResolveRoutingRequiredRequest}from"@zap-pronto/contracts";
import{listRoutingRequired,resolveRoutingRequired}from"@zap-pronto/core/domain/inbound-routing";
import type{TenantTransactionPool}from"@zap-pronto/core/database/tenant-transaction";
import{protectedRoute}from"../http/protected-route.js";import{InboxRoutingRequiredError}from"./inbox-routing-required-errors.js";
const problems={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,
  409:ProblemDetailsSchema,422:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema}as const;
function key(headers:Record<string,unknown>){const value=headers["idempotency-key"];
  if(typeof value!=="string"||value.trim()!==value||value.length<8||value.length>200)throw new Error("INVALID_IDEMPOTENCY_KEY");return value;}
export function registerInboxRoutingRequiredRoutes(app:FastifyInstance,pool:TenantTransactionPool):void{
  app.get("/v1/inbox/routing-required",protectedRoute({pool,authorization:{kind:"permission",permission:"inbound.routing.read",scope:{kind:"tenant"}},
    schema:{operationId:"listRoutingRequired",querystring:ListRoutingRequiredQuerySchema,response:{200:ListRoutingRequiredResponseSchema,...problems}},
    async handler(client,request,reply){try{const page=await listRoutingRequired(client,request.query as ListRoutingRequiredQuery);
      void reply.header("cache-control","no-store");return{...page,items:page.items.map(item=>({...item,
        occurredAt:item.occurredAt.toISOString(),receivedAt:item.receivedAt.toISOString()}))};}catch(error){return InboxRoutingRequiredError.from(error);}}}));
  app.post("/v1/inbox/routing-required/:receiptId/resolve",protectedRoute({pool,
    authorization:{kind:"permission",permission:"inbound.routing.resolve",scope:{kind:"tenant"}},
    schema:{operationId:"resolveRoutingRequired",params:ResolveRoutingRequiredParamsSchema,
      headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},
      body:ResolveRoutingRequiredRequestSchema,response:{200:ResolveRoutingRequiredResponseSchema,...problems}},
    async handler(client,request,reply){try{const params=request.params as ResolveRoutingRequiredParams;
      const body=request.body as ResolveRoutingRequiredRequest;const result=await resolveRoutingRequired(client,
        {receiptId:params.receiptId,unitId:body.unitId,idempotencyKey:key(request.headers)});
      void reply.header("cache-control","no-store");return{receiptId:result.receiptId,unitId:result.unitId,
        routingStatus:"ROUTED" as const,replayed:result.replayed};}catch(error){return InboxRoutingRequiredError.from(error);}}}));
}
