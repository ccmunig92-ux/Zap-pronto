import type { FastifyInstance } from "fastify";
import { EffectiveStaffShiftQuerySchema, EffectiveStaffShiftSchema, ListShiftMembersResponseSchema,
  ProblemDetailsSchema, SetStaffScheduleRequestSchema, SetStaffScheduleResponseSchema, StaffScheduleParamsSchema,
  StaffScheduleSchema, UnitOperationalTimezoneParamsSchema, type EffectiveStaffShiftQuery,
  type SetStaffScheduleRequest, type StaffSchedule } from "@zap-pronto/contracts";
import type { TenantTransactionPool } from "@zap-pronto/core/database/tenant-transaction";
import { evaluateUnitStaffShift, getUnitShiftSchedule, listUnitShiftMembers, setUnitShiftSchedule,
  type UnitShiftSchedule } from "@zap-pronto/core/domain/shift-schedule";
import { protectedRoute } from "../http/protected-route.js";

const problems={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,
  409:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema} as const;
function key(headers:Record<string,unknown>){const value=headers["idempotency-key"];if(typeof value!=="string"||value.trim()!==value||value.length<8||value.length>200)throw new StaffScheduleError(400,"INVALID_REQUEST");return value}
function view(row:UnitShiftSchedule):StaffSchedule{return{unitId:row.unitId,userId:row.userId,timeZone:row.timeZone,effectiveFrom:row.effectiveFrom,weeklySlots:row.weeklySlots,exceptions:row.exceptions,version:row.version,updatedAt:row.updatedAt.toISOString()}}
export class StaffScheduleError extends Error{constructor(readonly statusCode:400|404|409,readonly code:string){super(code)}static from(error:unknown):never{if(error instanceof StaffScheduleError)throw error;const code=error instanceof Error?error.message:"";if(code==="INVALID_SHIFT_SCHEDULE_REQUEST"||code==="INVALID_SHIFT_EVALUATION_REQUEST")throw new StaffScheduleError(400,"INVALID_REQUEST");if(code==="SHIFT_SCHEDULE_NOT_FOUND"||code==="SHIFT_EVALUATION_NOT_FOUND")throw new StaffScheduleError(404,"RESOURCE_NOT_FOUND");if(code==="SHIFT_SCHEDULE_CONFLICT"||code==="SHIFT_SCHEDULE_IDEMPOTENCY_CONFLICT")throw new StaffScheduleError(409,"SHIFT_SCHEDULE_CONFLICT");throw error}}

export function registerStaffScheduleRoutes(app:FastifyInstance,pool:TenantTransactionPool){
  const scope={kind:"unit" as const,async resolveUnitId(_client:unknown,request:{params:unknown}){return(request.params as{unitId:string}).unitId}};
  const read={kind:"permission" as const,permission:"shift.read" as const,scope};
  app.get("/v1/units/:unitId/staff-schedules/members",protectedRoute({pool,noStore:true,authorization:read,
    schema:{operationId:"listShiftMembers",params:UnitOperationalTimezoneParamsSchema,response:{200:ListShiftMembersResponseSchema,...problems}},
    async handler(client,request,reply){void reply.header("cache-control","no-store");try{return{items:await listUnitShiftMembers(client,(request.params as{unitId:string}).unitId)}}catch(error){return StaffScheduleError.from(error)}}}));
  app.get("/v1/units/:unitId/staff-schedules/:userId/effective",protectedRoute({pool,noStore:true,authorization:read,
    schema:{operationId:"getEffectiveStaffShift",params:StaffScheduleParamsSchema,querystring:EffectiveStaffShiftQuerySchema,response:{200:EffectiveStaffShiftSchema,...problems}},
    async handler(client,request,reply){void reply.header("cache-control","no-store");try{const{unitId,userId}=request.params as{unitId:string;userId:string},query=request.query as EffectiveStaffShiftQuery;return await evaluateUnitStaffShift(client,{unitId,userId,...(query.at?{at:new Date(query.at)}:{})})}catch(error){return StaffScheduleError.from(error)}}}));
  app.get("/v1/units/:unitId/staff-schedules/:userId",protectedRoute({pool,noStore:true,authorization:read,
    schema:{operationId:"getStaffSchedule",params:StaffScheduleParamsSchema,response:{200:StaffScheduleSchema,...problems}},
    async handler(client,request,reply){void reply.header("cache-control","no-store");try{const{unitId,userId}=request.params as{unitId:string;userId:string};return view(await getUnitShiftSchedule(client,unitId,userId))}catch(error){return StaffScheduleError.from(error)}}}));
  app.post("/v1/units/:unitId/staff-schedules/:userId",protectedRoute({pool,noStore:true,authorization:{kind:"permission",permission:"shift.manage",scope},
    schema:{operationId:"setStaffSchedule",params:StaffScheduleParamsSchema,headers:{type:"object",required:["idempotency-key"],properties:{"idempotency-key":{type:"string",minLength:8,maxLength:200}}},body:SetStaffScheduleRequestSchema,response:{200:SetStaffScheduleResponseSchema,...problems}},
    async handler(client,request,reply){void reply.header("cache-control","no-store");try{const{unitId,userId}=request.params as{unitId:string;userId:string},body=request.body as SetStaffScheduleRequest,row=await setUnitShiftSchedule(client,{unitId,userId,...body,idempotencyKey:key(request.headers)});return{...view(row),replayed:Boolean(row.replayed)}}catch(error){return StaffScheduleError.from(error)}}}));
}
