import type{FastifyInstance}from"fastify";
import{ListInboxTeamAvailabilityQuerySchema,ListInboxTeamAvailabilityResponseSchema,ProblemDetailsSchema,type ListInboxTeamAvailabilityQuery}from"@zap-pronto/contracts";
import{listTeamAvailability}from"@zap-pronto/core/domain/team-availability";
import type{TenantTransactionPool}from"@zap-pronto/core/database/tenant-transaction";
import{protectedRoute}from"../http/protected-route.js";

const problems={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema}as const;
export class TeamAvailabilityError extends Error{constructor(readonly statusCode:400|404,readonly code:string){super(code)}static from(error:unknown):never{const code=error instanceof Error?error.message:"";
  if(code==="INVALID_TEAM_AVAILABILITY_REQUEST"||code==="TEAM_AVAILABILITY_CURSOR_INVALID")throw new TeamAvailabilityError(400,"INVALID_REQUEST");
  if(code==="TEAM_AVAILABILITY_NOT_FOUND")throw new TeamAvailabilityError(404,"RESOURCE_NOT_FOUND");throw error}}

export function registerInboxTeamAvailabilityRoute(app:FastifyInstance,pool:TenantTransactionPool):void{
  app.get("/v1/inbox/team-availability",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"availability.supervise",scope:{kind:"unit",async resolveUnitId(_client,request){return(request.query as ListInboxTeamAvailabilityQuery).unitId}}},
    schema:{operationId:"listInboxTeamAvailability",querystring:ListInboxTeamAvailabilityQuerySchema,response:{200:ListInboxTeamAvailabilityResponseSchema,...problems}},async handler(client,request,reply){void reply.header("cache-control","no-store");try{const query=request.query as ListInboxTeamAvailabilityQuery;
      const page=await listTeamAvailability(client,{unitId:query.unitId,...(query.limit!==undefined?{limit:query.limit}:{}),...(query.status!==undefined?{status:query.status}:{}),...(query.cursor!==undefined?{cursor:query.cursor}:{})});
      return{items:page.items.map(item=>({...item,pausedUntil:item.pausedUntil?.toISOString()??null,updatedAt:item.updatedAt.toISOString()})),...(page.nextCursor?{nextCursor:page.nextCursor}:{})};
    }catch(error){return TeamAvailabilityError.from(error)}}}));
}
