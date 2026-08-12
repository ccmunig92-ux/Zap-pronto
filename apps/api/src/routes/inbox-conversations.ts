import type{FastifyInstance,FastifyRequest}from"fastify";
import{InboxConversationParamsSchema,InboxConversationSchema,ListInboxMessagesQuerySchema,ListInboxMessagesResponseSchema,ProblemDetailsSchema,
  SendHumanTextMessageRequestSchema,SendHumanTextMessageResponseSchema,InboxMessageParamsSchema,CancelHumanTextMessageRequestSchema,CancelHumanTextMessageResponseSchema,
  type InboxConversationParams,type InboxMessageParams,type ListInboxMessagesQuery,type SendHumanTextMessageRequest,type CancelHumanTextMessageRequest}from"@zap-pronto/contracts";
import{getConversation,listConversationMessages,sendHumanTextMessage,cancelHumanTextMessage}from"@zap-pronto/core/domain/inbox-conversations";
import type{TenantQueryClient,TenantTransactionPool}from"@zap-pronto/core/database/tenant-transaction";
import{protectedRoute}from"../http/protected-route.js";import{InboxConversationRequestError}from"./inbox-conversations-errors.js";
const problems={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,409:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema}as const;
async function unit(client:TenantQueryClient,request:FastifyRequest){try{return(await getConversation(client,(request.params as InboxConversationParams).conversationId)).unitId}
  catch(error){return InboxConversationRequestError.from(error)}}
export function registerInboxConversationRoutes(app:FastifyInstance,pool:TenantTransactionPool){
  app.get("/v1/inbox/conversations/:conversationId",protectedRoute({pool,authorization:{kind:"permission",permission:"conversation.read",scope:{kind:"unit",resolveUnitId:unit}},
    schema:{operationId:"getInboxConversation",params:InboxConversationParamsSchema,response:{200:InboxConversationSchema,...problems}},async handler(client,request,reply){
      try{void reply.header("cache-control","no-store");const row=await getConversation(client,(request.params as InboxConversationParams).conversationId);return{...row,
        updatedAt:row.updatedAt.toISOString(),stateChangedAt:row.stateChangedAt.toISOString(),closedAt:row.closedAt?.toISOString()??null};}catch(error){return InboxConversationRequestError.from(error)}}}));
  app.get("/v1/inbox/conversations/:conversationId/messages",protectedRoute({pool,authorization:{kind:"permission",permission:"conversation.read",scope:{kind:"unit",resolveUnitId:unit}},
    schema:{operationId:"listInboxConversationMessages",params:InboxConversationParamsSchema,querystring:ListInboxMessagesQuerySchema,response:{200:ListInboxMessagesResponseSchema,...problems}},
    async handler(client,request,reply){try{void reply.header("cache-control","no-store");const page=await listConversationMessages(client,{conversationId:(request.params as InboxConversationParams).conversationId,
      ...(request.query as ListInboxMessagesQuery)});return{...page,items:page.items.map(item=>({...item,kind:["TEXT","AUDIO","IMAGE","DOCUMENT","INTERACTIVE"].includes(item.kind)?item.kind:"UNKNOWN",
        createdAt:item.createdAt.toISOString()}))};}catch(error){return InboxConversationRequestError.from(error)}}}));
  app.post("/v1/inbox/conversations/:conversationId/messages",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"message.send",scope:{kind:"unit",resolveUnitId:unit}},
    schema:{operationId:"sendHumanTextMessage",params:InboxConversationParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},
      body:SendHumanTextMessageRequestSchema,response:{202:SendHumanTextMessageResponseSchema,...problems}},async handler(client,request,reply){try{const body=request.body as SendHumanTextMessageRequest;
      const key=request.headers["idempotency-key"];if(typeof key!=="string")throw new Error("INVALID_IDEMPOTENCY_KEY");const conversationId=(request.params as InboxConversationParams).conversationId;
      const result=await sendHumanTextMessage(client,{conversationId,expectedConversationVersion:body.expectedConversationVersion,body:body.body,idempotencyKey:key});
      void reply.status(202);return{...result,conversationId};}catch(error){return InboxConversationRequestError.from(error)}}}));
  app.post("/v1/inbox/conversations/:conversationId/messages/:messageId/cancel",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"message.cancel",scope:{kind:"unit",resolveUnitId:unit}},
    schema:{operationId:"cancelHumanTextMessage",params:InboxMessageParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},
      body:CancelHumanTextMessageRequestSchema,response:{202:CancelHumanTextMessageResponseSchema,...problems}},async handler(client,request,reply){try{const body=request.body as CancelHumanTextMessageRequest;
      const key=request.headers["idempotency-key"];if(typeof key!=="string")throw new Error("INVALID_IDEMPOTENCY_KEY");const params=request.params as InboxMessageParams;
      const result=await cancelHumanTextMessage(client,{conversationId:params.conversationId,messageId:params.messageId,expectedConversationVersion:body.expectedConversationVersion,idempotencyKey:key});
      void reply.status(202);return{...result,conversationId:params.conversationId};}catch(error){return InboxConversationRequestError.from(error)}}}));
}
