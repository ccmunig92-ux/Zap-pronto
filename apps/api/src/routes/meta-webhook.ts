import { createHash, timingSafeEqual } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { ProblemDetailsSchema } from "@zap-pronto/contracts";
import type { FastifyInstance } from "fastify";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { acceptInboundEnvelope } from "@zap-pronto/core/domain/channel-inbound";
import { classifyMetaCallback } from "@zap-pronto/core/domain/meta-callback";
import { reconcileMetaDeliveryStatus } from "@zap-pronto/core/domain/meta-delivery-status";
import { registerMetaSignedJsonBoundary, MetaSignedJsonError } from "../http/meta-signed-json.js";

export interface MetaWebhookOptions {
  readonly enabled: boolean;
  readonly appSecret?: string;
  readonly verifyToken?: string;
  readonly maxBodyBytes?: number;
}

type QueryRecord = Record<string, unknown>;

function constantEqual(left: string, right: string): boolean {
  const leftDigest=createHash("sha256").update(left,"utf8").digest();
  const rightDigest=createHash("sha256").update(right,"utf8").digest();
  return timingSafeEqual(leftDigest,rightDigest);
}

function verificationQuery(value: unknown): {mode:string;token:string;challenge:string}|undefined {
  if(typeof value!=="object"||value===null||Array.isArray(value))return undefined;
  const query=value as QueryRecord;
  if(Object.keys(query).sort().join(",")!=="hub.challenge,hub.mode,hub.verify_token")return undefined;
  const mode=query["hub.mode"],token=query["hub.verify_token"],challenge=query["hub.challenge"];
  if(typeof mode!=="string"||typeof token!=="string"||typeof challenge!=="string"
    ||challenge.length<1||challenge.length>512||/[\u0000-\u001f\u007f]/.test(challenge))return undefined;
  return {mode,token,challenge};
}

export async function registerMetaWebhookRoutes(app:FastifyInstance,pool:TenantTransactionPool,
  options:MetaWebhookOptions):Promise<void>{
  if(!options.enabled)return;
  if(typeof options.appSecret!=="string"||typeof options.verifyToken!=="string"||
    typeof options.maxBodyBytes!=="number")throw new Error("META_WEBHOOK_CONFIGURATION_INVALID");

  app.route({method:"GET",url:"/v1/webhooks/meta",exposeHeadRoute:false,config:{public:true},
    schema:{operationId:"verifyMetaWebhook",security:[],response:{200:Type.String(),403:ProblemDetailsSchema}},
    handler:async(request,reply)=>{
      const query=verificationQuery(request.query);
      if(!query||query.mode!=="subscribe"||!constantEqual(query.token,options.verifyToken!)){
        return reply.header("cache-control","no-store").status(403).type("application/problem+json").send({
          type:"urn:zap-pronto:error:meta-webhook-verification-rejected",title:"Forbidden",status:403,
          detail:"Meta webhook verification rejected",correlationId:request.id,
        });
      }
      return reply.header("cache-control","no-store").status(200).type("text/plain").send(query.challenge);
    }});

  await registerMetaSignedJsonBoundary(app,{appSecret:options.appSecret,maxBodyBytes:options.maxBodyBytes,
    registerRoutes(scope){scope.route({method:"POST",url:"/v1/webhooks/meta",config:{public:true},
      schema:{operationId:"receiveMetaWebhook",security:[],response:{200:Type.String(),400:ProblemDetailsSchema,
        401:ProblemDetailsSchema,413:ProblemDetailsSchema,415:ProblemDetailsSchema,503:ProblemDetailsSchema}},
      handler:async(request,reply)=>{
        let classified;
        try{classified=classifyMetaCallback(request.body);}
        catch{throw new MetaSignedJsonError(400,"META_WEBHOOK_INVALID_CALLBACK");}
        try{
          for(let index=0;index<classified.statuses.length;index+=1){
            const correlationId=`meta-status:${createHash("sha256").update(`${request.id}\0${index}`).digest("hex")}`;
            await reconcileMetaDeliveryStatus(pool,classified.statuses[index]!,correlationId);
          }
          for(let index=0;index<classified.messages.length;index+=1){
            const correlationId=`meta-webhook:${createHash("sha256").update(`${request.id}\0${index}`).digest("hex")}`;
            await acceptInboundEnvelope(pool,classified.messages[index]!,correlationId);
          }
        }catch{throw new MetaSignedJsonError(503,"META_WEBHOOK_UNAVAILABLE");}
        return reply.status(200).type("text/plain").send("OK");
      }});},
  });
}
