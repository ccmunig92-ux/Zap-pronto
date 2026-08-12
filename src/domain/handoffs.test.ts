import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { listHandoffs, listActiveHandoffs, listSupervisedHandoffs, requestHandoff, resolveHandoff, requeueHandoff,
  listTransferCandidates,transferHandoff,transferFingerprint,getTakeoverTarget,resolveTakeoverUnit,takeoverHandoff,takeoverFingerprint,listResolvedHandoffs,
  resolveHandoffFingerprint,reopenFingerprint,resolveReopenUnit,reopenHandoff } from "./handoffs.js";

const unitId = "10000000-0000-4000-8000-000000000001";
const otherUnitId = "10000000-0000-4000-8000-000000000002";
const firstId = "20000000-0000-4000-8000-000000000001";
const secondId = "20000000-0000-4000-8000-000000000002";

it("normaliza fingerprint de reabertura e envia os mesmos argumentos ao owner e comando",async()=>{const calls:{text:string;values:unknown[]}[]=[];
  const client={async query(text:string,values:unknown[]){calls.push({text,values});return calls.length===1?{rows:[{unitId}]}:{rows:[{sourceHandoffId:firstId,
    handoffId:secondId,conversationId:firstId,serviceCaseId:secondId,handoffVersion:1,conversationVersion:4,serviceCaseVersion:3,replayed:false}]}}};
  const input={handoffId:firstId.toUpperCase(),expectedVersion:2,reason:"PREMATURE_CLOSURE"as const,idempotencyKey:" reopen-command-1 "};
  const expected=createHash("sha256").update(JSON.stringify({expectedVersion:2,handoffId:firstId,reason:"PREMATURE_CLOSURE"})).digest("hex");
  assert.equal(reopenFingerprint(input),expected);assert.equal(await resolveReopenUnit(client as never,input),unitId);
  assert.equal((await reopenHandoff(client as never,input)).handoffId,secondId);
  assert.deepEqual(calls.map(call=>call.values),[[input.handoffId,2,"PREMATURE_CLOSURE","reopen-command-1",expected],
    [input.handoffId,2,"PREMATURE_CLOSURE","reopen-command-1",expected]]);});

it("rejeita reabertura inválida antes do SQL",async()=>{let queried=false;const client={query:async()=>{queried=true;return{rows:[]}}};
  await assert.rejects(reopenHandoff(client as never,{handoffId:"bad",expectedVersion:1,reason:"FOLLOW_UP_REQUIRED",idempotencyKey:"reopen-command-1"}),/INVALID_HANDOFF_REOPEN_REQUEST/);
  await assert.rejects(resolveReopenUnit(client as never,{handoffId:firstId,expectedVersion:0,reason:"NEW_INFORMATION",idempotencyKey:"reopen-command-1"}),/INVALID_HANDOFF_REOPEN_REQUEST/);
  assert.equal(queried,false);});

it("lista histórico resolvido por função estreita e pagina com cursor v2 vinculado aos filtros",async()=>{const resolvedAt=new Date("2026-08-12T10:00:00.123Z");
  const calls:unknown[][]=[];const client={async query(_text:string,values:unknown[]){calls.push(values);return{rows:[
    {id:firstId,conversationId:firstId,unitId,contactName:"Contato",reason:"Finalizado",priority:"NORMAL",resolvedAt,disposition:"RESOLVED",resolvedByUserId:secondId,resolvedByDisplayName:"Agente",version:2},
    {id:secondId,conversationId:secondId,unitId,contactName:null,reason:"Finalizado",priority:"HIGH",resolvedAt,disposition:"LEGACY_UNSPECIFIED",resolvedByUserId:null,resolvedByDisplayName:null,version:1}]}}};
  const filters={priority:"HIGH"as const,disposition:"RESOLVED"as const,resolvedFrom:"2026-08-01T09:00:00-03:00",resolvedBefore:"2026-08-31T12:00:00.000Z"};
  const first=await listResolvedHandoffs(client as never,{unitId,limit:1,...filters});assert.equal(first.items.length,1);assert.ok(first.nextCursor);
  const decoded=JSON.parse(Buffer.from(first.nextCursor,"base64url").toString("utf8"));assert.deepEqual(decoded,{v:2,scope:"UNIT_RESOLVED",unitId,
    priorityFilter:"HIGH",dispositionFilter:"RESOLVED",resolvedFrom:"2026-08-01T12:00:00.000Z",resolvedBefore:"2026-08-31T12:00:00.000Z",resolvedAt:resolvedAt.toISOString(),id:firstId});
  await listResolvedHandoffs(client as never,{unitId,limit:1,cursor:first.nextCursor,...filters});assert.deepEqual(calls[1],[unitId,2,"HIGH","RESOLVED","2026-08-01T12:00:00.000Z","2026-08-31T12:00:00.000Z",resolvedAt.toISOString(),firstId]);});

it("rejeita cursor de histórico legado, forjado, de outra unidade ou filtros divergentes antes do SQL",async()=>{let queried=false;const client={query:async()=>{queried=true;return{rows:[]}}};
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url"),base={v:2,scope:"UNIT_RESOLVED",unitId,priorityFilter:null,
    dispositionFilter:null,resolvedFrom:null,resolvedBefore:null,resolvedAt:"2026-08-12T10:00:00.000Z",id:firstId};
  for(const cursor of ["bad+cursor",encode({...base,unitId:otherUnitId}),encode({...base,scope:"UNIT"}),encode({...base,extra:true})])
    await assert.rejects(listResolvedHandoffs(client as never,{unitId,cursor}),/INVALID_PAGE_CURSOR/);
  await assert.rejects(listResolvedHandoffs(client as never,{unitId,cursor:encode({...base,v:1})}),/INVALID_PAGE_CURSOR/);
  await assert.rejects(listResolvedHandoffs(client as never,{unitId,cursor:encode({...base,priorityFilter:"HIGH"})}),/INVALID_PAGE_CURSOR/);
  assert.equal(queried,false);});

it("normaliza instantes e rejeita intervalo histórico invertido ou superior a 366 dias",async()=>{const client={query:async()=>({rows:[]})};
  await listResolvedHandoffs(client as never,{unitId,resolvedFrom:"2026-08-10T09:00:00-03:00",resolvedBefore:"2026-08-11T12:00:00Z"});
  await assert.rejects(listResolvedHandoffs(client as never,{unitId,resolvedFrom:"2026-08-11T12:00:00Z",resolvedBefore:"2026-08-11T12:00:00Z"}),/INVALID_HANDOFF_FILTER/);
  await assert.rejects(listResolvedHandoffs(client as never,{unitId,resolvedFrom:"2025-01-01T00:00:00Z",resolvedBefore:"2026-08-11T12:00:00Z"}),/INVALID_HANDOFF_FILTER/);
  await assert.rejects(listResolvedHandoffs(client as never,{unitId,resolvedFrom:"not-an-instant"}),/INVALID_HANDOFF_FILTER/);});

function row(id: string, priorityRank: number, queuedAt: Date) {
  return { id, conversationId: "30000000-0000-4000-8000-000000000001",
    serviceCaseId: "40000000-0000-4000-8000-000000000001", unitId, contactName: "Contato",
    reason: "Atendimento humano", priority: priorityRank === 1 ? "URGENT" as const : "HIGH" as const,
    status: "QUEUED" as const, assignedUserId: null, requestedAt: queuedAt, queuedAt, slaDueAt: null, slaStatus: null,
    automationStatus: "HUMAN_QUEUED", version: 1, priorityRank, slaMissing: true };
}

describe("inbox handoff cursor", () => {
  it("congela o relógio, vincula filtros no cursor v2 e projeta as bordas SLA do servidor",async()=>{
    const asOf=new Date("2026-08-10T12:00:00.000Z"),queuedAt=new Date("2026-08-10T11:00:00.000Z");
    const dueSoon=new Date("2026-08-10T12:15:00.000Z");let values:unknown[]=[];let sql="";
    const client={async query(text:string,input:unknown[]){sql=text;values=input;return{rows:[
      {...row(firstId,1,queuedAt),priority:"URGENT",slaDueAt:dueSoon,slaStatus:"DUE_SOON",slaMissing:false},
      {...row(secondId,1,queuedAt),priority:"URGENT",slaDueAt:new Date("2026-08-10T12:15:00.001Z"),slaStatus:"ON_TRACK",slaMissing:false},
    ]}}};
    const page=await listHandoffs(client as never,{unitId,limit:1,priority:"URGENT",slaStatus:"DUE_SOON",now:asOf});
    assert.equal(page.items[0]?.slaStatus,"DUE_SOON");assert.match(sql,/h\.sla_due_at<=\$4::timestamptz/);
    assert.deepEqual(values.slice(0,4),[unitId,"URGENT","DUE_SOON",asOf.toISOString()]);
    const cursor=JSON.parse(Buffer.from(page.nextCursor!,"base64url").toString("utf8"));
    assert.equal(cursor.asOf,asOf.toISOString());assert.equal(cursor.priorityFilter,"URGENT");assert.equal(cursor.slaStatusFilter,"DUE_SOON");
    await assert.rejects(listHandoffs({query:async()=>({rows:[]})}as never,{unitId,cursor:page.nextCursor!,priority:"HIGH",slaStatus:"DUE_SOON"}),/INVALID_PAGE_CURSOR/);
  });

  it("gera cursor opaco e reaplica exatamente priority, queued_at e id", async () => {
    const queuedAt = new Date("2026-08-10T12:34:56.789Z");
    const calls: unknown[][] = [];
    const client = { query: async (_sql: string, values?: unknown[]) => {
      calls.push(values ?? []);
      return calls.length === 1
        ? { rowCount: 2, rows: [row(firstId, 1, queuedAt), row(secondId, 2, queuedAt)] }
        : calls.length === 2
          ? { rowCount: 1, rows: [{ valid: true }] }
          : { rowCount: 0, rows: [] };
    } };
    const first = await listHandoffs(client, { unitId, limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor && !first.nextCursor.includes("{"));
    await listHandoffs(client, { unitId, limit: 1, cursor: first.nextCursor });
    const decoded=JSON.parse(Buffer.from(first.nextCursor,"base64url").toString("utf8"));
    assert.deepEqual(decoded,{v:2,unitId,priorityFilter:null,slaStatusFilter:null,asOf:decoded.asOf,
      priorityRank:1,slaMissing:true,slaDueAt:null,queuedAt:queuedAt.toISOString(),id:firstId});
    assert.deepEqual(calls[1], [firstId, unitId, null, null, decoded.asOf, queuedAt.toISOString(), 1, true, null]);
    assert.deepEqual(calls[2], [unitId, null, null, decoded.asOf, 1, true, null, queuedAt.toISOString(), firstId, 2]);
  });

  it("rejeita no banco uma âncora inexistente ou que deixou a fila", async () => {
    const queuedAt = new Date("2026-08-10T12:34:56.789Z");
    const firstPageClient = { query: async () => ({ rowCount: 2,
      rows: [row(firstId, 1, queuedAt), row(secondId, 2, queuedAt)] }) };
    const first = await listHandoffs(firstPageClient, { unitId, limit: 1 });
    assert.ok(first.nextCursor);
    let calls = 0;
    const client = { query: async () => { calls += 1; return { rowCount: 1, rows: [{ valid: false }] }; } };
    await assert.rejects(listHandoffs(client, { unitId, limit: 1, cursor: first.nextCursor }), /INVALID_PAGE_CURSOR/);
    assert.equal(calls, 1);
  });

  it("rejeita cursor adulterado, não canônico ou de outra unidade antes do SQL", async () => {
    let queried = false;
    const client = { query: async () => { queried = true; return { rowCount: 0, rows: [] }; } };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const validShape = { v: 1, priority: 1, queuedAt: "2026-08-10T12:34:56.789Z", id: firstId, unitId };
    const invalid = ["not+base64url", encode(validShape) + "=", encode({ ...validShape, priority: 0 }),
      encode({ ...validShape, queuedAt: "2026-08-10" }), encode({ ...validShape, unitId: otherUnitId }),
      encode({ ...validShape, extra: true })];
    for (const cursor of invalid) {
      await assert.rejects(listHandoffs(client, { unitId, cursor }), /INVALID_PAGE_CURSOR/);
    }
    assert.equal(queried, false);
  });
});

it("lista somente atendimentos ativos do ator e valida a âncora no banco",async()=>{const claimedAt=new Date("2026-08-10T12:34:56.789Z");const calls:string[]=[];
  const client={async query(text:string){calls.push(text);return{rows:[{...row(firstId,1,claimedAt),claimedAt},{...row(secondId,2,claimedAt),claimedAt}]}}};
  const first=await listActiveHandoffs(client as never,{unitId,limit:1});assert.equal(first.items.length,1);assert.ok(first.nextCursor);assert.match(calls[0]!,/assigned_user_id=current_app_actor_id/);
  const secondClient={async query(text:string){calls.push(text);return text.includes("SELECT EXISTS")?{rows:[{valid:true}]}:{rows:[]}}};
  await listActiveHandoffs(secondClient as never,{unitId,limit:1,cursor:first.nextCursor});assert.match(calls[1]!,/h.status='ACTIVE'/);});

it("resolve handoff exige disposição, usa o comando estreito e normaliza a chave uma vez",async()=>{let sql="",values:unknown[]=[];const client={async query(text:string,input:unknown[]){sql=text;values=input;return{rows:[{handoffId:firstId,conversationId:"30000000-0000-4000-8000-000000000001",serviceCaseId:"40000000-0000-4000-8000-000000000001",handoffVersion:2,conversationVersion:7,replayed:false}]}}};
  const result=await resolveHandoff(client as never,{handoffId:firstId,expectedVersion:1,disposition:"DUPLICATE",idempotencyKey:"  resolve-key-1  "});assert.equal(result.handoffVersion,2);
  assert.match(sql,/resolve_inbox_handoff\(\$1,\$2,\$3,\$4,\$5\)/);assert.deepEqual(values.slice(0,4),[firstId,1,"DUPLICATE","resolve-key-1"]);assert.match(String(values[4]),/^[a-f0-9]{64}$/);});

it("resolve fingerprint normaliza UUID para lowercase sem alterar os demais campos",()=>{
  const input={handoffId:firstId.toUpperCase(),expectedVersion:7,disposition:"EXTERNAL_REFERRAL" as const};
  const expected=createHash("sha256").update(JSON.stringify({handoffId:firstId,expectedVersion:7,disposition:"EXTERNAL_REFERRAL"})).digest("hex");
  assert.equal(resolveHandoffFingerprint(input),expected);
  assert.equal(resolveHandoffFingerprint(input),resolveHandoffFingerprint({...input,handoffId:firstId}));
});

it("resolve handoff rejeita disposição fora do enum antes do SQL",async()=>{let queried=false;const client={async query(){queried=true;return{rows:[]}}};
  await assert.rejects(resolveHandoff(client as never,{handoffId:firstId,expectedVersion:1,disposition:"FREE_TEXT" as never,idempotencyKey:"resolve-key-1"}),/INVALID_RESOLUTION_DISPOSITION/);
  assert.equal(queried,false);});

it("requeue handoff usa somente o comando estreito e normaliza a chave",async()=>{let sql="",values:unknown[]=[];const client={async query(text:string,input:unknown[]){sql=text;values=input;return{rows:[{handoffId:firstId,conversationId:"30000000-0000-4000-8000-000000000001",serviceCaseId:"40000000-0000-4000-8000-000000000001",handoffVersion:3,conversationVersion:8,serviceCaseVersion:4,replayed:false}]}}};
  const result=await requeueHandoff(client as never,{handoffId:firstId,expectedVersion:2,idempotencyKey:"  requeue-key-1  "});assert.equal(result.handoffVersion,3);
  assert.match(sql,/requeue_inbox_handoff/);assert.deepEqual(values,[firstId,2,"requeue-key-1"]);});

it("request handoff trava tenant e chave antes do caso e rejeita replay divergente", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes("FROM human_handoffs WHERE idempotency_key")) return { rowCount: 1, rows: [{
      id: firstId, conversationId: "30000000-0000-4000-8000-000000000001", serviceCaseId: firstId,
      status: "QUEUED", version: 1, reason: "Outro motivo", priority: "HIGH", slaDueAt: null,
      requestFingerprint: null,
    }] };
    return { rowCount: 1, rows: [] };
  } };
  await assert.rejects(requestHandoff(client as never, { serviceCaseId: firstId, expectedCaseVersion: 1,
    reason: " Motivo ", priority: "HIGH", idempotencyKey: " request-key-1 " }), /IDEMPOTENCY_KEY_REUSED/);
  assert.match(calls[0]!.sql, /handoff-request/);
  assert.deepEqual(calls[0]!.values, ["request-key-1"]);
  assert.match(calls[1]!.sql, /FROM human_handoffs/);
  assert.equal(calls.some(({ sql }) => sql.includes("handoff-case")), false);
});

it("request handoff aceita replay pelo SHA-256 dos quatro campos normalizados", async () => {
  const fingerprint = createHash("sha256").update(JSON.stringify({ serviceCaseId: firstId,
    reason: "Motivo", priority: "NORMAL", slaDueAt: "2026-08-10T12:34:56.789Z" })).digest("hex");
  let calls = 0;
  const client = { async query(sql: string) {
    calls += 1;
    if (sql.includes("FROM human_handoffs WHERE idempotency_key")) return { rowCount: 1, rows: [{
      id: secondId, conversationId: "30000000-0000-4000-8000-000000000001", serviceCaseId: firstId,
      status: "QUEUED", version: 1, reason: "valor legado ignorado", priority: "LOW", slaDueAt: null,
      requestFingerprint: fingerprint,
    }] };
    return { rowCount: 1, rows: [] };
  } };
  const replay = await requestHandoff(client as never, { serviceCaseId: firstId.toUpperCase(), expectedCaseVersion: 1,
    reason: " Motivo ", priority: "NORMAL", idempotencyKey: " request-key-2 ",
    slaDueAt: new Date("2026-08-10T12:34:56.789Z") });
  assert.equal(replay.id, secondId);
  assert.equal(calls, 2);
});

it("lista somente o catálogo operacional estreito de transferência",async()=>{const calls:{sql:string;values:unknown[]}[]=[];const client={async query(sql:string,values:unknown[]){calls.push({sql,values});return{rows:[{id:secondId,displayName:"Atendente B"}]}}};
  assert.deepEqual(await listTransferCandidates(client as never,firstId),{items:[{id:secondId,displayName:"Atendente B"}]});assert.match(calls[0]!.sql,/list_inbox_handoff_transfer_candidates/);assert.deepEqual(calls[0]!.values,[firstId]);});

it("transfere com fingerprint completo e parâmetros canônicos",async()=>{let captured:unknown[]=[];const client={async query(_sql:string,values:unknown[]){captured=values;return{rows:[{handoffId:firstId,conversationId:unitId,serviceCaseId:otherUnitId,targetUserId:secondId,handoffVersion:3,conversationVersion:9,replayed:false}]}}};
  const input={handoffId:firstId,expectedVersion:2,targetUserId:secondId,reason:"LOAD_BALANCING" as const,idempotencyKey:" transfer-key-1 "};
  const result=await transferHandoff(client as never,input);assert.equal(result.targetUserId,secondId);
  assert.deepEqual(captured,[firstId,2,secondId,"LOAD_BALANCING","transfer-key-1",transferFingerprint(input)]);
  assert.equal(transferFingerprint(input),createHash("sha256").update(JSON.stringify({expectedVersion:2,handoffId:firstId,reason:"LOAD_BALANCING",targetUserId:secondId})).digest("hex"));});

it("rejeita motivo de transferência fora do enum antes de consultar SQL",async()=>{let queried=false;const client={async query(){queried=true;return{rows:[]}}};
  await assert.rejects(transferHandoff(client as never,{handoffId:firstId,expectedVersion:2,targetUserId:secondId,reason:"FREE_TEXT" as never,idempotencyKey:"transfer-key-1"}),/INVALID_HANDOFF_TRANSFER_REQUEST/);
  assert.equal(queried,false);});

it("lista ativos supervisionados com cursor estrito vinculado a unit e scope",async()=>{const claimedAt=new Date("2026-08-10T12:34:56.789Z"),now=new Date("2026-08-10T13:00:00.000Z");
  const calls:{sql:string;values:unknown[]}[]=[];const active={...row(firstId,1,claimedAt),status:"ACTIVE" as const,assignedUserId:secondId,
    automationStatus:"HUMAN_ACTIVE",claimedAt};const client={async query(sql:string,values:unknown[]){calls.push({sql,values});return{rows:[active,{...active,id:secondId}]}}};
  const page=await listSupervisedHandoffs(client as never,{unitId,limit:1,now});assert.equal(page.items[0]?.assignedUserId,secondId);assert.ok(page.nextCursor);
  assert.match(calls[0]!.sql,/list_inbox_supervised_handoffs/);assert.deepEqual(calls[0]!.values,[unitId,2,null,null,now.toISOString()]);
  const decoded=JSON.parse(Buffer.from(page.nextCursor!,"base64url").toString("utf8"));assert.deepEqual(decoded,{v:1,scope:"UNIT",unitId,claimedAt:claimedAt.toISOString(),id:firstId});
  let queried=false;const rejectClient={async query(){queried=true;return{rows:[]}}};
  const wrongScope=Buffer.from(JSON.stringify({...decoded,scope:"OWN"})).toString("base64url");
  await assert.rejects(listSupervisedHandoffs(rejectClient as never,{unitId,cursor:wrongScope}),/INVALID_PAGE_CURSOR/);
  await assert.rejects(listSupervisedHandoffs(rejectClient as never,{unitId:otherUnitId,cursor:page.nextCursor}),/INVALID_PAGE_CURSOR/);assert.equal(queried,false);
});

it("reaplica a âncora supervisionada canônica na função SQL",async()=>{const claimedAt=new Date("2026-08-10T12:34:56.789Z"),now=new Date("2026-08-10T13:00:00.000Z");
  const first=await listSupervisedHandoffs({query:async()=>({rows:[{...row(firstId,1,claimedAt),status:"ACTIVE",assignedUserId:secondId,automationStatus:"HUMAN_ACTIVE",claimedAt},
    {...row(secondId,1,claimedAt),status:"ACTIVE",assignedUserId:firstId,automationStatus:"HUMAN_ACTIVE",claimedAt}]})}as never,{unitId,limit:1,now});let values:unknown[]=[];
  await listSupervisedHandoffs({query:async(_sql:string,input:unknown[])=>{values=input;return{rows:[]}}}as never,{unitId,limit:1,cursor:first.nextCursor!,now});
  assert.deepEqual(values,[unitId,2,claimedAt.toISOString(),firstId,now.toISOString()]);
});

it("consulta target e resolver estreitos do takeover",async()=>{const conversationId="30000000-0000-4000-8000-000000000001";const calls:{sql:string;values:unknown[]}[]=[];
  const client={async query(sql:string,values:unknown[]){calls.push({sql,values});return sql.includes("get_inbox")?{rows:[{handoffId:firstId,expectedVersion:4}]}:{rows:[{unitId}]}}};
  assert.deepEqual(await getTakeoverTarget(client as never,conversationId),{handoffId:firstId,expectedVersion:4});
  const input={handoffId:firstId,expectedVersion:4,idempotencyKey:" takeover-key-1 "};assert.equal(await resolveTakeoverUnit(client as never,input),unitId);
  assert.match(calls[0]!.sql,/get_inbox_conversation_takeover_target/);assert.deepEqual(calls[0]!.values,[conversationId]);
  assert.match(calls[1]!.sql,/resolve_inbox_handoff_takeover_unit/);assert.deepEqual(calls[1]!.values,[firstId,4,"takeover-key-1",takeoverFingerprint(input)]);
});

it("takeover usa fingerprint canônico e somente o comando SQL 0033",async()=>{let sql="",values:unknown[]=[];const input={handoffId:firstId,expectedVersion:4,idempotencyKey:" takeover-key-1 "};
  const client={async query(text:string,inputValues:unknown[]){sql=text;values=inputValues;return{rows:[{handoffId:firstId,conversationId:unitId,serviceCaseId:otherUnitId,
    previousAssignedUserId:secondId,handoffVersion:5,conversationVersion:10,replayed:false}]}}};
  const result=await takeoverHandoff(client as never,input);assert.equal(result.previousAssignedUserId,secondId);assert.match(sql,/FROM takeover_inbox_handoff/);
  assert.deepEqual(values,[firstId,4,"takeover-key-1",takeoverFingerprint(input)]);
  assert.equal(takeoverFingerprint(input),createHash("sha256").update(JSON.stringify({expectedVersion:4,handoffId:firstId})).digest("hex"));
});

it("takeover rejeita entrada inválida antes do SQL",async()=>{let queried=false;const client={query:async()=>{queried=true;return{rows:[]}}};
  await assert.rejects(takeoverHandoff(client as never,{handoffId:"invalid",expectedVersion:1,idempotencyKey:"takeover-key-1"}),/INVALID_HANDOFF_TAKEOVER_REQUEST/);
  await assert.rejects(resolveTakeoverUnit(client as never,{handoffId:firstId,expectedVersion:0,idempotencyKey:"takeover-key-1"}),/INVALID_HANDOFF_TAKEOVER_REQUEST/);
  await assert.rejects(getTakeoverTarget(client as never,"invalid"),/INVALID_HANDOFF_TAKEOVER_REQUEST/);assert.equal(queried,false);
});
