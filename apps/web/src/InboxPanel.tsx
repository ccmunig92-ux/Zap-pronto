import { useEffect, useRef, useState } from "react";
import type { AcknowledgeInboxSlaAlertResponse, InboxAvailability, InboxCapacityAlertSnapshot, InboxConversation, InboxHandoff, InboxMessage, ListHandoffsResponse, ListInboxMessagesResponse, ListInboxSlaAlertsResponse, ListInboxTransferCandidatesResponse, ListResolvedHandoffsResponse, ReopenReason, ResolvedInboxHandoff, SetInboxAvailabilityRequest, SetInboxAvailabilityResponse } from "@zap-pronto/contracts";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";

function DeliveryLabel({ message }: { readonly message: InboxMessage }) {
  if (message.direction !== "OUTBOUND" || message.deliveryStatus === null) return null;
  const status = message.deliveryStatus;
  let label: string;
  switch (status) {
    case "QUEUED": label = "Pendente de envio"; break;
    case "SENT": label = "Enviado"; break;
    case "DELIVERED": label = "Entregue"; break;
    case "READ": label = "Lido"; break;
    case "FAILED": label = "Falha no envio"; break;
    case "CANCELLED": label = "Envio cancelado"; break;
    default: { const exhaustive: never = status; return exhaustive; }
  }
  return <small>{label}</small>;
}

function priorityLabel(priority: InboxHandoff["priority"]): string {
  switch (priority) {
    case "LOW": return "Baixa";
    case "NORMAL": return "Normal";
    case "HIGH": return "Alta";
    case "URGENT": return "Urgente";
  }
}

function dispositionLabel(disposition: ResolvedInboxHandoff["disposition"]): string {
  switch (disposition) {
    case "RESOLVED": return "Resolvido";
    case "DUPLICATE": return "Duplicado";
    case "CUSTOMER_WITHDREW": return "Cliente desistiu";
    case "EXTERNAL_REFERRAL": return "Encaminhamento externo";
    case "LEGACY_UNSPECIFIED": return "Encerramento legado";
  }
}
type SlaAlertSeverity=ListInboxSlaAlertsResponse["items"][number]["severity"];
function alertLabel(severity:SlaAlertSeverity):string{switch(severity){case"MISSING_SLA":return"Sem prazo de SLA";case"DUE_SOON":return"Vence em breve";case"OVERDUE":return"SLA vencido"}}

export interface InboxClient {
  subscribeInboxEvents?(unitId:string,signal:AbortSignal,onChange:(event:{readonly kind?:string;readonly entityId?:string})=>void):Promise<void>;
  getInboxAvailability(unitId:string):Promise<InboxAvailability>;
  setInboxAvailability(input:SetInboxAvailabilityRequest,idempotencyKey:string):Promise<SetInboxAvailabilityResponse>;
  listHandoffs(input:{unitId:string;limit?:number;cursor?:string;priority?:"LOW"|"NORMAL"|"HIGH"|"URGENT";slaStatus?:"ON_TRACK"|"DUE_SOON"|"OVERDUE"}):Promise<ListHandoffsResponse>;
  claimHandoff(handoffId: string, expectedVersion: number, idempotencyKey: string): Promise<unknown>;
  resolveHandoff(handoffId: string, expectedVersion: number, disposition: ResolveDisposition, idempotencyKey: string): Promise<unknown>;
  requeueHandoff(handoffId: string, expectedVersion: number, idempotencyKey: string): Promise<unknown>;
  listInboxHandoffTransferCandidates(handoffId:string):Promise<ListInboxTransferCandidatesResponse>;
  transferInboxHandoff(handoffId:string,expectedVersion:number,targetUserId:string,reason:TransferReason,idempotencyKey:string):Promise<unknown>;
  takeoverInboxHandoff(handoffId:string,expectedVersion:number,idempotencyKey:string):Promise<unknown>;
  listActiveInboxHandoffs(input: { unitId: string; limit?: number; cursor?: string }): Promise<ListHandoffsResponse>;
  listSupervisedInboxHandoffs(input:{unitId:string;limit?:number;cursor?:string}):Promise<ListHandoffsResponse>;
  listResolvedInboxHandoffs(input:{unitId:string;limit?:number;cursor?:string;priority?:InboxHandoff["priority"];
    disposition?:ResolveDisposition;resolvedFrom?:string;resolvedBefore?:string}):Promise<ListResolvedHandoffsResponse>;
  reopenInboxHandoff(sourceHandoffId:string,expectedVersion:number,reason:ReopenReason,idempotencyKey:string):Promise<unknown>;
  listInboxSlaAlerts(input:{unitId:string;limit?:number;cursor?:string;severity?:SlaAlertSeverity;priority?:InboxHandoff["priority"]}):Promise<ListInboxSlaAlertsResponse>;
  acknowledgeInboxSlaAlert(handoffId:string,expectedVersion:number,idempotencyKey:string):Promise<AcknowledgeInboxSlaAlertResponse>;
  getInboxCapacityAlert?(unitId:string):Promise<InboxCapacityAlertSnapshot>;
  getInboxConversation(id: string): Promise<InboxConversation>;
  listInboxConversationMessages(id: string, input?: { limit?: number; cursor?: string; before?:string }): Promise<ListInboxMessagesResponse>;
  sendHumanTextMessage(id: string, input: { body: string; expectedConversationVersion: number }, idempotencyKey: string): Promise<unknown>;
  cancelHumanTextMessage(conversationId: string, messageId: string, expectedConversationVersion: number, idempotencyKey: string): Promise<unknown>;
}

type TransferReason = "SHIFT_CHANGE" | "LOAD_BALANCING" | "SPECIALIZED_SUPPORT" | "OPERATIONAL_CONTINUITY";
type ResolveDisposition = "RESOLVED" | "DUPLICATE" | "CUSTOMER_WITHDREW" | "EXTERNAL_REFERRAL";

type ScopedReadError = { readonly scope: "queue" | "active" | "supervised" | "resolved" | "slaAlerts" | "capacityAlert" | "detail" | "messages" | "availability"; readonly cause: unknown };
type InboxSelection = InboxHandoff | ResolvedInboxHandoff;
type ResolvedFilters={priority:""|InboxHandoff["priority"];disposition:""|ResolveDisposition;resolvedFrom:string;resolvedBefore:string};
const emptyResolvedFilters:ResolvedFilters={priority:"",disposition:"",resolvedFrom:"",resolvedBefore:""};
const maximumHistorySpanMs=366*24*60*60*1000;
const automaticRefreshBaseMs=30_000,automaticRefreshMaximumMs=300_000,automaticRefreshRecoveryMs=1_000;
const refreshWindowMaximumItems=400,refreshWindowMaximumRequests=4;
type RefreshResult="success"|"skipped"|"retryable-failure"|"terminal-auth";
type ConvergenceState={readonly kind:"updated"|"deferred"|"paused"|"unstable";readonly at?:string};
function instantToLocalDateTime(value:string):string{const date=new Date(value),pad=(part:number)=>String(part).padStart(2,"0");return`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`}
function historicalMessages(page:ListInboxMessagesResponse,resolvedAt:string):ListInboxMessagesResponse{
  return {...page,items:page.items.filter(message=>message.createdAt<=resolvedAt).map(message=>({...message,allowedActions:[]}))};
}

export function InboxPanel({ client, units, supervisedUnitIds=[], historyUnitIds=[], slaAlertReadUnitIds=[],slaAlertAcknowledgeUnitIds=[],onAuthenticationRequired,
  onAuthorizationChanged, onNavigationStateChange }: {
  readonly client: InboxClient;
  readonly units: readonly { id: string; name: string }[];
  readonly supervisedUnitIds?:readonly string[];
  readonly historyUnitIds?:readonly string[];
  readonly slaAlertReadUnitIds?:readonly string[];readonly slaAlertAcknowledgeUnitIds?:readonly string[];
  readonly onAuthenticationRequired: () => void;
  readonly onAuthorizationChanged: () => void;
  readonly onNavigationStateChange?: (state: { readonly blocked: boolean; readonly dirty: boolean }) => void;
}) {
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [priorityFilter, setPriorityFilter] = useState<"" | InboxHandoff["priority"]>("");
  const [slaFilter, setSlaFilter] = useState<"" | NonNullable<InboxHandoff["slaStatus"]>>("");
  const [queue, setQueue] = useState<ListHandoffsResponse>();
  const [active, setActive] = useState<ListHandoffsResponse>();
  const [supervised,setSupervised]=useState<ListHandoffsResponse>();
  const [resolved,setResolved]=useState<ListResolvedHandoffsResponse>();
  const [slaAlerts,setSlaAlerts]=useState<ListInboxSlaAlertsResponse>();
  const [capacityAlert,setCapacityAlert]=useState<InboxCapacityAlertSnapshot>();
  const [capacityAlertUnavailable,setCapacityAlertUnavailable]=useState(false);
  const [slaAlertSeverity,setSlaAlertSeverity]=useState<""|SlaAlertSeverity>("");
  const [slaAlertPriority,setSlaAlertPriority]=useState<""|InboxHandoff["priority"]>("");
  const [loadingSlaAlertPage,setLoadingSlaAlertPage]=useState(false);
  const [acknowledgingAlertId,setAcknowledgingAlertId]=useState<string>();
  const [resolvedFilters,setResolvedFilters]=useState<ResolvedFilters>(emptyResolvedFilters);
  const [appliedResolvedFilters,setAppliedResolvedFilters]=useState<ResolvedFilters>(emptyResolvedFilters);
  const [selected, setSelected] = useState<InboxSelection>();
  const [detail, setDetail] = useState<InboxConversation>();
  const [messages, setMessages] = useState<ListInboxMessagesResponse>();
  const [error, setError] = useState<string>();
  const [closedNotice, setClosedNotice] = useState<string>();
  const [claiming, setClaiming] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveOpen,setResolveOpen]=useState(false);
  const [resolveDisposition,setResolveDisposition]=useState<""|ResolveDisposition>("");
  const [requeueing, setRequeueing] = useState(false);
  const [reopening,setReopening]=useState(false);
  const [reopenOpen,setReopenOpen]=useState(false);
  const [reopenReason,setReopenReason]=useState<""|ReopenReason>("");
  const [transferCandidates,setTransferCandidates]=useState<ListInboxTransferCandidatesResponse>();
  const [loadingTransferCandidates,setLoadingTransferCandidates]=useState(false);
  const [transferTargetUserId,setTransferTargetUserId]=useState("");
  const [transferReason,setTransferReason]=useState<""|TransferReason>("");
  const [transferring,setTransferring]=useState(false);
  const [takingOver,setTakingOver]=useState(false);
  const [takeoverConfirmOpen,setTakeoverConfirmOpen]=useState(false);
  const [transferOpen,setTransferOpen]=useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [cancellingId, setCancellingId] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [convergence,setConvergence]=useState<ConvergenceState>({kind:"paused"});
  const previousConvergence=useRef<ConvergenceState["kind"]>("paused");
  const [convergenceAnnouncement,setConvergenceAnnouncement]=useState("Atualização automática pausada.");
  const [availability,setAvailability]=useState<InboxAvailability>();
  const [availabilityOpen,setAvailabilityOpen]=useState(false);
  const [availabilityStatus,setAvailabilityStatus]=useState<InboxAvailability["status"]>("OFFLINE");
  const [availabilityMaxActive,setAvailabilityMaxActive]=useState("5");
  const [availabilityPauseReason,setAvailabilityPauseReason]=useState<NonNullable<InboxAvailability["pauseReason"]>>("BREAK");
  const [availabilityPausedUntil,setAvailabilityPausedUntil]=useState("");
  const [savingAvailability,setSavingAvailability]=useState(false);
  const availabilityIntent=useRef<{input:SetInboxAvailabilityRequest;key:string}|undefined>(undefined);
  const generation = useRef(0);
  const claimIntent = useRef<{ id: string; version: number; key: string } | undefined>(undefined);
  const sendIntent = useRef<{ id: string; version: number; body: string; key: string } | undefined>(undefined);
  const resolveIntent = useRef<{ id: string; version: number; disposition:ResolveDisposition; key: string } | undefined>(undefined);
  const requeueIntent = useRef<{ id: string; version: number; key: string } | undefined>(undefined);
  const reopenIntent=useRef<{id:string;version:number;reason:ReopenReason;key:string}|undefined>(undefined);
  const transferIntent=useRef<{id:string;version:number;targetUserId:string;reason:TransferReason;key:string}|undefined>(undefined);
  const takeoverIntent=useRef<{id:string;version:number;key:string}|undefined>(undefined);
  const cancelIntent = useRef<{ conversationId: string; messageId: string; version: number; key: string } | undefined>(undefined);
  const refreshFlight = useRef(false);
  const initialLoadFlight=useRef(false);
  const operationLock = useRef<symbol | undefined>(undefined);
  const mutationLock = useRef<symbol | undefined>(undefined);
  const queuePageFlight = useRef(false);
  const activePageFlight = useRef(false);
  const supervisedPageFlight=useRef(false);
  const resolvedPageFlight=useRef(false);
  const slaAlertPageFlight=useRef(false);
  const slaAlertIntent=useRef<{id:string;version:number;key:string}|undefined>(undefined);
  const automaticRefreshTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const automaticRefreshFailures=useRef(0);
  const automaticRefreshRunner=useRef<()=>Promise<RefreshResult>>(async()=>"skipped");
  const realtimeAbort=useRef<AbortController|undefined>(undefined);
  const realtimeConnected=useRef(false);
  const mounted=useRef(true);
  const authorizationFailed=useRef(false);
  const navigationCallback=useRef(onNavigationStateChange);
  const [loadingQueuePage, setLoadingQueuePage] = useState(false);
  const [loadingActivePage, setLoadingActivePage] = useState(false);
  const [loadingSupervisedPage,setLoadingSupervisedPage]=useState(false);
  const [loadingResolvedPage,setLoadingResolvedPage]=useState(false);
  const mutationBusy = claiming || resolving || requeueing || reopening || transferring || takingOver || sending || savingAvailability || cancellingId !== undefined||acknowledgingAlertId!==undefined;
  const navigationBlocked=mutationBusy||Boolean(operationLock.current)||resolveOpen||reopenOpen||transferOpen||takeoverConfirmOpen||availabilityOpen;
  const navigationDirty=draft!==""||resolveDisposition!==""||reopenReason!==""||transferTargetUserId!==""||transferReason!==""
    ||claimIntent.current!==undefined||sendIntent.current!==undefined||resolveIntent.current!==undefined
    ||requeueIntent.current!==undefined||reopenIntent.current!==undefined||transferIntent.current!==undefined||takeoverIntent.current!==undefined
    ||cancelIntent.current!==undefined||availabilityIntent.current!==undefined||availabilityOpen;
  useEffect(()=>{navigationCallback.current=onNavigationStateChange},[onNavigationStateChange]);
  useEffect(()=>{onNavigationStateChange?.({blocked:navigationBlocked,dirty:navigationDirty})},
    [onNavigationStateChange,navigationBlocked,navigationDirty]);
  useEffect(()=>()=>navigationCallback.current?.({blocked:false,dirty:false}),[]);
  useEffect(()=>{const previous=previousConvergence.current;previousConvergence.current=convergence.kind;
    if(convergence.kind==="unstable")setConvergenceAnnouncement("Conexão instável; nova tentativa automática agendada.");
    else if(convergence.kind==="paused")setConvergenceAnnouncement("Atualização automática pausada.");
    else if(convergence.kind==="updated"&&previous!=="updated")setConvergenceAnnouncement("Sincronização retomada.");
    else if(convergence.kind==="deferred")setConvergenceAnnouncement("");
  },[convergence.kind]);
  const canSupervise=supervisedUnitIds.includes(unitId);
  const canReadHistory=historyUnitIds.includes(unitId);
  const canReadSlaAlerts=slaAlertReadUnitIds.includes(unitId);
  const canAcknowledgeSlaAlerts=slaAlertAcknowledgeUnitIds.includes(unitId);
  const resolvedFiltersDirty=resolvedFilters.priority!==appliedResolvedFilters.priority
    ||resolvedFilters.disposition!==appliedResolvedFilters.disposition
    ||resolvedFilters.resolvedFrom!==appliedResolvedFilters.resolvedFrom
    ||resolvedFilters.resolvedBefore!==appliedResolvedFilters.resolvedBefore;
  const supervisedFirst=(capturedUnit:string)=>supervisedUnitIds.includes(capturedUnit)
    ?client.listSupervisedInboxHandoffs({unitId:capturedUnit,limit:25})
    :Promise.resolve({items:[]} satisfies ListHandoffsResponse);
  function resolvedInput(capturedUnit:string,cursor?:string,filters=appliedResolvedFilters){
    const resolvedFrom=filters.resolvedFrom?new Date(filters.resolvedFrom).toISOString():undefined;
    const resolvedBefore=filters.resolvedBefore?new Date(filters.resolvedBefore).toISOString():undefined;
    return {unitId:capturedUnit,limit:25,...(cursor?{cursor}:{}),...(filters.priority?{priority:filters.priority}:{}),
      ...(filters.disposition?{disposition:filters.disposition}:{}),...(resolvedFrom?{resolvedFrom}:{}),...(resolvedBefore?{resolvedBefore}:{})};
  }
  const resolvedFirst=(capturedUnit:string)=>historyUnitIds.includes(capturedUnit)
    ?client.listResolvedInboxHandoffs(resolvedInput(capturedUnit))
    :Promise.resolve({items:[]} satisfies ListResolvedHandoffsResponse);
  function slaAlertInput(capturedUnit:string,cursor?:string){return{unitId:capturedUnit,limit:25,...(cursor?{cursor}:{}),...(slaAlertSeverity?{severity:slaAlertSeverity}:{}),...(slaAlertPriority?{priority:slaAlertPriority}:{})}}
  const slaAlertsFirst=(capturedUnit:string)=>slaAlertReadUnitIds.includes(capturedUnit)?client.listInboxSlaAlerts(slaAlertInput(capturedUnit)):Promise.resolve({items:[]} satisfies ListInboxSlaAlertsResponse);
  const capacityAlertFirst=async(capturedUnit:string):Promise<{snapshot?:InboxCapacityAlertSnapshot;unavailable:boolean}>=>{
    if(!slaAlertReadUnitIds.includes(capturedUnit)||!client.getInboxCapacityAlert)return{unavailable:false};
    try{return{snapshot:await client.getInboxCapacityAlert(capturedUnit),unavailable:false}}catch(cause){
      if(cause instanceof AuthenticationRequired||cause instanceof ApiProblem&&(cause.problem.status===401||cause.problem.status===403))throw cause;
      return{unavailable:true};
    }
  };

  function queueInput(capturedUnit: string, cursor?: string,
    priority: typeof priorityFilter = priorityFilter, slaStatus: typeof slaFilter = slaFilter) {
    return { unitId: capturedUnit, limit: 25, ...(cursor ? { cursor } : {}),
      ...(priority ? { priority } : {}), ...(slaStatus ? { slaStatus } : {}) };
  }

  function slaLabel(status: InboxHandoff["slaStatus"]): string {
    switch (status) {
      case "OVERDUE": return "SLA: Atrasado";
      case "DUE_SOON": return "SLA: Próximo do prazo";
      case "ON_TRACK": return "SLA: No prazo";
      case null: return "Sem SLA";
    }
  }

  function acquireMutation(): symbol | undefined {
    if (mutationLock.current || operationLock.current) return undefined;
    const token = Symbol("inbox-mutation");
    mutationLock.current = token;
    return token;
  }

  function releaseMutation(token: symbol) {
    if (mutationLock.current === token) mutationLock.current = undefined;
  }

  function acquireOperation(): symbol | undefined {
    if (operationLock.current || mutationLock.current) return undefined;
    const token = Symbol("inbox-operation");
    operationLock.current = token;
    return token;
  }

  function releaseOperation(token: symbol) {
    if (operationLock.current === token) operationLock.current = undefined;
  }

  function clearIntents() {
    claimIntent.current = undefined;
    sendIntent.current = undefined;
    resolveIntent.current = undefined;
    requeueIntent.current = undefined;
    reopenIntent.current=undefined;
    transferIntent.current=undefined;
    takeoverIntent.current=undefined;
    cancelIntent.current = undefined;
    availabilityIntent.current=undefined;
    slaAlertIntent.current=undefined;
  }

  function purgeSensitive() {
    setQueue(undefined); setActive(undefined);setSupervised(undefined);setResolved(undefined);setSlaAlerts(undefined);setCapacityAlert(undefined);setCapacityAlertUnavailable(false);setAvailability(undefined); setSelected(undefined); setDetail(undefined); setMessages(undefined);
    setDraft(""); setClosedNotice(undefined); setError(undefined); clearIntents();
    operationLock.current = undefined;
    refreshFlight.current = false;
    queuePageFlight.current = false; activePageFlight.current = false;supervisedPageFlight.current=false;resolvedPageFlight.current=false;slaAlertPageFlight.current=false;
    setClaiming(false); setResolving(false);setResolveOpen(false);setResolveDisposition(""); setRequeueing(false);setReopening(false);setReopenOpen(false);setReopenReason(""); setTransferring(false);setTakingOver(false);setTakeoverConfirmOpen(false);setLoadingTransferCandidates(false);setTransferCandidates(undefined);setTransferTargetUserId("");setTransferReason("");setTransferOpen(false); setSending(false); setCancellingId(undefined); setRefreshing(false);
    setLoadingQueuePage(false); setLoadingActivePage(false);setLoadingSupervisedPage(false);setLoadingResolvedPage(false);setLoadingSlaAlertPage(false);setAcknowledgingAlertId(undefined);setAvailabilityOpen(false);setSavingAvailability(false);
    setConvergence({kind:"paused"});
  }

  function purgeSelection(notice?: string) {
    setSelected(undefined); setDetail(undefined); setMessages(undefined); setDraft(""); clearIntents();
    setTakeoverConfirmOpen(false);
    setClaiming(false); setResolving(false);setResolveOpen(false);setResolveDisposition(""); setRequeueing(false);setReopening(false);setReopenOpen(false);setReopenReason(""); setTransferring(false);setTakingOver(false);setLoadingTransferCandidates(false);setTransferCandidates(undefined);setTransferTargetUserId("");setTransferReason("");setTransferOpen(false); setSending(false); setCancellingId(undefined);
    if (notice) setClosedNotice(notice);
  }

  function fail(errorValue: unknown, g: number) {
    if (g !== generation.current) return;
    const actual = (errorValue as Partial<ScopedReadError>).cause ?? errorValue;
    if (actual instanceof AuthenticationRequired || actual instanceof ApiProblem && actual.problem.status === 401) {
      generation.current += 1; purgeSensitive(); if(!authorizationFailed.current){authorizationFailed.current=true;onAuthenticationRequired()} return;
    }
    if (actual instanceof ApiProblem && actual.problem.status === 403) {
      generation.current += 1; purgeSensitive(); if(!authorizationFailed.current){authorizationFailed.current=true;onAuthorizationChanged()} return;
    }
    setError(actual instanceof ApiProblem
      ? `Não foi possível carregar a Inbox. Correlação: ${actual.problem.correlationId}`
      : "Não foi possível carregar a Inbox.");
  }

  function failCommittedReconciliation(errorValue: unknown, g: number) {
    if (g !== generation.current) return;
    const actual = (errorValue as Partial<ScopedReadError>).cause ?? errorValue;
    if (actual instanceof AuthenticationRequired || actual instanceof ApiProblem && actual.problem.status === 401) {
      generation.current += 1; purgeSensitive(); if(!authorizationFailed.current){authorizationFailed.current=true;onAuthenticationRequired()} return;
    }
    if (actual instanceof ApiProblem && actual.problem.status === 403) {
      generation.current += 1; purgeSensitive(); if(!authorizationFailed.current){authorizationFailed.current=true;onAuthorizationChanged()} return;
    }
    setError("A ação foi concluída, mas não foi possível atualizar a Inbox. Use Atualizar Inbox.");
  }

  function scoped<T>(scope: ScopedReadError["scope"], promise: Promise<T>): Promise<T> {
    return promise.catch((cause: unknown) => Promise.reject({ scope, cause } satisfies ScopedReadError));
  }

  useEffect(() => {
    const g = ++generation.current;
    purgeSensitive();
    if (!unitId) return () => { generation.current += 1; };
    initialLoadFlight.current=true;
    Promise.all([
      scoped("queue", client.listHandoffs(queueInput(unitId))),
      scoped("active", client.listActiveInboxHandoffs({ unitId, limit: 25 })),
      scoped("supervised",supervisedFirst(unitId)),
      scoped("resolved",resolvedFirst(unitId)),
      scoped("slaAlerts",slaAlertsFirst(unitId)),
      scoped("capacityAlert",capacityAlertFirst(unitId)),
      scoped("availability",client.getInboxAvailability(unitId)),
    ]).then(([queued, mine,others,closed,alerts,nextCapacityAlert,nextAvailability]) => {
      if (g === generation.current) { setQueue(queued); setActive(mine);setSupervised(others);setResolved(closed);setSlaAlerts(alerts);setCapacityAlert(nextCapacityAlert.snapshot);setCapacityAlertUnavailable(nextCapacityAlert.unavailable);setAvailability(nextAvailability);setConvergence({kind:"updated",at:new Date().toISOString()}); }
    }).catch((caught: unknown) => fail(caught, g)).finally(()=>{if(g===generation.current)initialLoadFlight.current=false});
    return () => { generation.current += 1;initialLoadFlight.current=false };
  }, [client, unitId, supervisedUnitIds.join(","),historyUnitIds.join(","),slaAlertReadUnitIds.join(",")]);

  function openAvailability(){
    if(!availability||mutationBusy||refreshing)return;
    setAvailabilityStatus(availability.status);setAvailabilityMaxActive(String(availability.maxActive));
    setAvailabilityPauseReason(availability.pauseReason??"BREAK");
    setAvailabilityPausedUntil(availability.pausedUntil?instantToLocalDateTime(availability.pausedUntil):"");
    availabilityIntent.current=undefined;setAvailabilityOpen(true);
  }
  function invalidateAvailability(){availabilityIntent.current=undefined}
  async function saveAvailability(){
    if(!availability||!unitId)return;const maxActive=Number(availabilityMaxActive);
    if(!Number.isInteger(maxActive)||maxActive<1||maxActive>100){setError("Informe entre 1 e 100 atendimentos ativos.");return}
    const pausedUntil=availabilityStatus==="PAUSED"&&availabilityPausedUntil?new Date(availabilityPausedUntil).toISOString():null;
    const input:SetInboxAvailabilityRequest={unitId,status:availabilityStatus,maxActive,expectedVersion:availability.version,
      pauseReason:availabilityStatus==="PAUSED"?availabilityPauseReason:null,pausedUntil};
    const current=availabilityIntent.current;
    if(current&&JSON.stringify(current.input)!==JSON.stringify(input))availabilityIntent.current=undefined;
    const intent=availabilityIntent.current??{input,key:crypto.randomUUID()};availabilityIntent.current=intent;
    const token=acquireMutation();if(!token)return;const g=generation.current,capturedUnit=unitId;setSavingAvailability(true);setError(undefined);setClosedNotice(undefined);
    try{const result=await client.setInboxAvailability(intent.input,intent.key);if(g!==generation.current||capturedUnit!==unitId)return;
      setAvailability(result);availabilityIntent.current=undefined;setAvailabilityOpen(false);setClosedNotice("Disponibilidade atualizada.");
    }catch(caught){if(g!==generation.current||capturedUnit!==unitId)return;
      if(caught instanceof ApiProblem&&[404,409].includes(caught.problem.status)){
        try{const currentAvailability=await client.getInboxAvailability(capturedUnit);if(g===generation.current&&capturedUnit===unitId){setAvailability(currentAvailability);availabilityIntent.current=undefined;setAvailabilityOpen(false);setClosedNotice("A disponibilidade mudou e foi atualizada.")}}catch(reconcileError){fail(reconcileError,g)}
      }else fail(caught,g);
    }finally{releaseMutation(token);if(g===generation.current)setSavingAvailability(false)}
  }

  async function changeQueueFilters(priority: typeof priorityFilter, slaStatus: typeof slaFilter) {
    if (!unitId || mutationBusy || refreshing) return;
    const operationToken = acquireOperation(); if (!operationToken) return;
    const capturedUnit = unitId; const g = ++generation.current;
    setPriorityFilter(priority); setSlaFilter(slaStatus); setQueue(undefined); setError(undefined);
    try {
      const next = await client.listHandoffs(queueInput(capturedUnit, undefined, priority, slaStatus));
      if (g === generation.current && capturedUnit === unitId) setQueue(next);
    } catch (caught) { if (g === generation.current && capturedUnit === unitId) fail(caught, g); }
    finally { releaseOperation(operationToken); }
  }

  async function applyResolvedFilters(filters:ResolvedFilters=resolvedFilters){
    if(!unitId||!canReadHistory||mutationBusy||refreshing)return;
    const from=filters.resolvedFrom?new Date(filters.resolvedFrom):undefined;
    const before=filters.resolvedBefore?new Date(filters.resolvedBefore):undefined;
    if(from&&!Number.isFinite(from.getTime())||before&&!Number.isFinite(before.getTime())||from&&before&&from>=before){
      setError("Informe um período válido para os atendimentos encerrados.");return;
    }
    if(from&&before&&before.getTime()-from.getTime()>maximumHistorySpanMs){
      setError("O período dos atendimentos encerrados deve ter no máximo 366 dias.");return;
    }
    const operationToken=acquireOperation();if(!operationToken)return;
    filters={...filters};const capturedUnit=unitId,g=++generation.current;
    setError(undefined);resolvedPageFlight.current=false;
    try{const page=await client.listResolvedInboxHandoffs(resolvedInput(capturedUnit,undefined,filters));
      if(g!==generation.current||capturedUnit!==unitId)return;setAppliedResolvedFilters(filters);setResolved(page);
      if(selected&&"resolvedAt" in selected&&!page.items.some(item=>item.id===selected.id))purgeSelection("O atendimento encerrado não corresponde aos filtros aplicados.");
    }catch(caught){if(g===generation.current&&capturedUnit===unitId)fail(caught,g)}finally{releaseOperation(operationToken)}
  }

  function switchUnit(nextUnitId: string) {
    if (nextUnitId === unitId || refreshFlight.current || mutationLock.current) return;
    generation.current += 1;
    purgeSensitive();
    setUnitId(nextUnitId);
  }

  async function open(item: InboxSelection) {
    if (refreshing || mutationBusy) return;
    const operationToken = acquireOperation();
    if (!operationToken) return;
    const capturedUnit = unitId;
    const g = ++generation.current;
    if (selected?.conversationId !== item.conversationId || "resolvedAt" in item) { setDraft(""); clearIntents(); }
    setClosedNotice(undefined); setSelected(item); setDetail(undefined); setMessages(undefined); setError(undefined);
    if (claimIntent.current?.id !== item.id || claimIntent.current.version !== item.version) claimIntent.current = undefined;
    try {
      const [nextDetail, nextMessages] = await Promise.all([
        scoped("detail", client.getInboxConversation(item.conversationId)),
        scoped("messages", client.listInboxConversationMessages(item.conversationId, { limit: 25,...("resolvedAt" in item?{before:item.resolvedAt}:{}) })),
      ]);
      if (g === generation.current && capturedUnit === unitId) {
        if ("resolvedAt" in item) {
          setDetail({...nextDetail,allowedActions:[],claimTarget:null,sendTextTarget:null,resolveTarget:null,requeueTarget:null,transferTarget:null,takeoverTarget:null});
          setDraft("");clearIntents();setMessages(historicalMessages(nextMessages,item.resolvedAt));
        } else { setDetail(nextDetail); setMessages(nextMessages); }
      }
    } catch (caught) {
      if (g !== generation.current || capturedUnit !== unitId) return;
      const scopedError = caught as Partial<ScopedReadError>;
      const actual = scopedError.cause ?? caught;
      if (actual instanceof ApiProblem && actual.problem.status === 404
        && (scopedError.scope === "detail" || scopedError.scope === "messages")) {
        purgeSelection("Atendimento não está mais disponível.");
        try {
          const [queued, mine,others,closed] = await Promise.all([
            scoped("queue", client.listHandoffs(queueInput(capturedUnit))),
            scoped("active", client.listActiveInboxHandoffs({ unitId: capturedUnit, limit: 25 })),
            scoped("supervised",supervisedFirst(capturedUnit)),scoped("resolved",resolvedFirst(capturedUnit)),
          ]);
          if (g === generation.current && capturedUnit === unitId) { setQueue(queued); setActive(mine);setSupervised(others);setResolved(closed); }
        } catch (listFailure) {
          if (g === generation.current && capturedUnit === unitId) fail(listFailure, g);
        }
      } else if (actual instanceof AuthenticationRequired
        || actual instanceof ApiProblem && (actual.problem.status === 401 || actual.problem.status === 403)) {
        fail(caught, g);
      } else {
        purgeSelection();
        fail(caught, g);
      }
    } finally {
      releaseOperation(operationToken);
    }
  }

  function retainCoherentIntents(nextDetail: InboxConversation, nextMessages: ListInboxMessagesResponse, nextSelected: InboxHandoff) {
    const claimTarget = nextDetail.claimTarget;
    if (!claimTarget || claimIntent.current?.id !== claimTarget.handoffId || claimIntent.current.version !== claimTarget.expectedVersion) claimIntent.current = undefined;
    const resolveTarget = nextDetail.resolveTarget;
    if (!resolveTarget || resolveIntent.current?.id !== resolveTarget.handoffId || resolveIntent.current.version !== resolveTarget.expectedVersion) resolveIntent.current = undefined;
    const requeueTarget = nextDetail.requeueTarget;
    if (!requeueTarget || requeueIntent.current?.id !== requeueTarget.handoffId || requeueIntent.current.version !== requeueTarget.expectedVersion) requeueIntent.current = undefined;
    const transferTarget=nextDetail.transferTarget;
    if(!transferTarget||transferIntent.current?.id!==transferTarget.handoffId||transferIntent.current.version!==transferTarget.expectedVersion)transferIntent.current=undefined;
    const takeoverTarget=nextDetail.takeoverTarget;
    if(!takeoverTarget||takeoverIntent.current?.id!==takeoverTarget.handoffId||takeoverIntent.current.version!==takeoverTarget.expectedVersion)takeoverIntent.current=undefined;
    const normalized = draft.replace(/^[ \t\n]+|[ \t\n]+$/gu, "");
    const sendTarget = nextDetail.sendTextTarget;
    if (!sendTarget || sendIntent.current?.id !== nextSelected.conversationId || sendIntent.current.version !== sendTarget.expectedConversationVersion || sendIntent.current.body !== normalized) sendIntent.current = undefined;
    const cancel = cancelIntent.current;
    const cancellable = cancel && cancel.conversationId === nextSelected.conversationId && cancel.version === nextDetail.version
      && nextMessages.items.some(item => item.id === cancel.messageId && item.allowedActions.includes("CANCEL_QUEUED"));
    if (!cancellable) cancelIntent.current = undefined;
  }

  async function collectWindow<T extends object,R extends {readonly items:readonly T[];readonly nextCursor?:string}>(
    target:number,first:(limit:number)=>Promise<R>,next:(cursor:string,limit:number)=>Promise<R>):Promise<R>{
    if(target>refreshWindowMaximumItems)throw new Error("INBOX_REFRESH_WINDOW_BUDGET_EXCEEDED");
    const limit=Math.min(100,Math.max(25,target)),initial=await first(limit);let result=initial;
    const cursors=new Set<string>();let requests=1;
    while(result.items.length<target&&result.nextCursor){
      if(cursors.has(result.nextCursor))throw new Error("INBOX_REFRESH_CURSOR_CYCLE");
      if(requests>=refreshWindowMaximumRequests)throw new Error("INBOX_REFRESH_WINDOW_BUDGET_EXCEEDED");
      cursors.add(result.nextCursor);const previousSize=result.items.length;
      const page=await next(result.nextCursor,Math.min(100,target-result.items.length));
      requests+=1;
      const key=(item:T)=>"id" in item?String(item.id):"handoffId" in item?String(item.handoffId):JSON.stringify(item);
      const ids=new Set(result.items.map(key));
      result={...page,items:[...result.items,...page.items.filter(item=>!ids.has(key(item)))]} as R;
      if(result.items.length===previousSize&&result.nextCursor)throw new Error("INBOX_REFRESH_WINDOW_NO_PROGRESS");
    }
    return result;
  }

  async function refresh(origin:"manual"|"automatic"="manual"):Promise<RefreshResult> {
    const windowBudgetExceeded=[queue,active,supervised,resolved,slaAlerts,messages]
      .some(page=>(page?.items.length??0)>refreshWindowMaximumItems);
    const automaticBlocked=origin==="automatic"&&(initialLoadFlight.current||navigationDirty||navigationBlocked
      ||windowBudgetExceeded||queuePageFlight.current||activePageFlight.current||supervisedPageFlight.current||resolvedPageFlight.current||slaAlertPageFlight.current);
    if (!unitId || authorizationFailed.current){if(origin==="automatic")setConvergence({kind:"paused"});return "skipped"}
    if(refreshing||mutationBusy||automaticBlocked){if(origin==="automatic")setConvergence({kind:"deferred"});return "skipped"}
    const operationToken = acquireOperation();
    if (!operationToken){if(origin==="automatic")setConvergence({kind:"deferred"});return "skipped"}
    refreshFlight.current = true;
    const capturedUnit = unitId;
    const capturedSelected = selected;
    const automatic=origin==="automatic";
    const g = ++generation.current;
    if(!automatic){setRefreshing(true);setError(undefined);setClosedNotice(undefined)}
    const queueTarget=automatic?Math.max(25,queue?.items.length??0):25;
    const activeTarget=automatic?Math.max(25,active?.items.length??0):25;
    const supervisedTarget=automatic?Math.max(25,supervised?.items.length??0):25;
    const resolvedTarget=automatic?Math.max(25,resolved?.items.length??0):25;
    const alertsTarget=automatic?Math.max(25,slaAlerts?.items.length??0):25;
    const messagesTarget=automatic?Math.max(25,messages?.items.length??0):25;
    const listsPromise = Promise.all([
      scoped("queue",collectWindow(queueTarget,limit=>client.listHandoffs({...queueInput(capturedUnit),limit}),(cursor,limit)=>client.listHandoffs({...queueInput(capturedUnit,cursor),limit}))),
      scoped("active",collectWindow(activeTarget,limit=>client.listActiveInboxHandoffs({unitId:capturedUnit,limit}),(cursor,limit)=>client.listActiveInboxHandoffs({unitId:capturedUnit,limit,cursor}))),
      scoped("supervised",supervisedUnitIds.includes(capturedUnit)?collectWindow(supervisedTarget,limit=>client.listSupervisedInboxHandoffs({unitId:capturedUnit,limit}),(cursor,limit)=>client.listSupervisedInboxHandoffs({unitId:capturedUnit,limit,cursor})):Promise.resolve({items:[]} satisfies ListHandoffsResponse)),
      scoped("resolved",historyUnitIds.includes(capturedUnit)?collectWindow(resolvedTarget,limit=>client.listResolvedInboxHandoffs({...resolvedInput(capturedUnit),limit}),(cursor,limit)=>client.listResolvedInboxHandoffs({...resolvedInput(capturedUnit,cursor),limit})):Promise.resolve({items:[]} satisfies ListResolvedHandoffsResponse)),
      scoped("slaAlerts",slaAlertReadUnitIds.includes(capturedUnit)?collectWindow(alertsTarget,limit=>client.listInboxSlaAlerts({...slaAlertInput(capturedUnit),limit}),(cursor,limit)=>client.listInboxSlaAlerts({...slaAlertInput(capturedUnit,cursor),limit})):Promise.resolve({items:[]} satisfies ListInboxSlaAlertsResponse)),
      scoped("capacityAlert",capacityAlertFirst(capturedUnit)),
      scoped("availability",client.getInboxAvailability(capturedUnit)),
    ]);
    const selectionPromise: Promise<readonly [InboxConversation | undefined, ListInboxMessagesResponse | undefined]> = capturedSelected
      ? Promise.all([
        scoped("detail", client.getInboxConversation(capturedSelected.conversationId)),
        scoped("messages",collectWindow(messagesTarget,limit=>client.listInboxConversationMessages(capturedSelected.conversationId,{limit,...("resolvedAt" in capturedSelected?{before:capturedSelected.resolvedAt}:{})}),
          (cursor,limit)=>client.listInboxConversationMessages(capturedSelected.conversationId,{limit,cursor,...("resolvedAt" in capturedSelected?{before:capturedSelected.resolvedAt}:{})}))),
      ])
      : Promise.resolve([undefined, undefined] as const);
    try {
      const [[queued, mine,others,closed,alerts,nextCapacityAlert,nextAvailability], [nextDetail, nextMessages]] = await Promise.all([listsPromise, selectionPromise]);
      if (g !== generation.current || capturedUnit !== unitId) return "skipped";
      let nextSelected: InboxSelection | undefined;
      if (capturedSelected) nextSelected = queued.items.find(item => item.id === capturedSelected.id)
        ?? mine.items.find(item => item.id === capturedSelected.id)
        ?? others.items.find(item=>item.id===capturedSelected.id)
        ?? closed.items.find(item=>item.id===capturedSelected.id)
        ?? (nextDetail?.conversationId === capturedSelected.conversationId && nextDetail.unitId === capturedUnit
          ? capturedSelected : undefined);
      setQueue(queued); setActive(mine);setSupervised(others);setResolved(closed);setSlaAlerts(alerts);setCapacityAlert(nextCapacityAlert.snapshot);setCapacityAlertUnavailable(nextCapacityAlert.unavailable);setAvailability(nextAvailability);
      if (capturedSelected && (!nextSelected || !nextDetail || !nextMessages)) {
        purgeSelection("Atendimento não está mais disponível.");
      } else if (nextSelected && nextDetail && nextMessages) {
        setSelected(nextSelected);
        if("resolvedAt" in nextSelected){setDetail({...nextDetail,allowedActions:[],claimTarget:null,sendTextTarget:null,resolveTarget:null,requeueTarget:null,transferTarget:null,takeoverTarget:null});setMessages(historicalMessages(nextMessages,nextSelected.resolvedAt));setDraft("");clearIntents()}
        else{setDetail(nextDetail);setMessages(nextMessages);retainCoherentIntents(nextDetail,nextMessages,nextSelected)}
      }
      setConvergence({kind:"updated",at:new Date().toISOString()});if(!automatic)setError(undefined);
      return "success";
    } catch (caught) {
      if (g !== generation.current || capturedUnit !== unitId) return "skipped";
      const scopedError = caught as Partial<ScopedReadError>;
      const actual = scopedError.cause ?? caught;
      if (actual instanceof ApiProblem && actual.problem.status === 404) {
        if (scopedError.scope === "detail" || scopedError.scope === "messages") {
          try {
            const [queued, mine,others,closed] = await listsPromise;
            if (g !== generation.current || capturedUnit !== unitId) return "skipped";
            setQueue(queued); setActive(mine);setSupervised(others);setResolved(closed); purgeSelection("Atendimento não está mais disponível.");
            return "success";
          } catch (listFailure) {
            if(g!==generation.current||capturedUnit!==unitId)return"skipped";
            const listActual=(listFailure as Partial<ScopedReadError>).cause??listFailure;
            const terminal=listActual instanceof AuthenticationRequired||listActual instanceof ApiProblem&&[401,403].includes(listActual.problem.status);
            if(terminal||!automatic)fail(listFailure,g);
            if(automatic)setConvergence({kind:terminal?"paused":"unstable"});return terminal?"terminal-auth":"retryable-failure";
          }
        } else {
          purgeSensitive();
          setClosedNotice("Atendimento não está mais disponível.");
          return "success";
        }
      } else {const terminal=actual instanceof AuthenticationRequired||actual instanceof ApiProblem&&[401,403].includes(actual.problem.status);
        if(terminal||!automatic)fail(caught,g);if(automatic)setConvergence({kind:terminal?"paused":"unstable"});return terminal?"terminal-auth":"retryable-failure"}
    } finally {
      releaseOperation(operationToken);
      if (g === generation.current) { refreshFlight.current = false; if(!automatic)setRefreshing(false); }
    }
  }

  automaticRefreshRunner.current=()=>refresh("automatic");
  useEffect(()=>{
    mounted.current=true;
    const cancel=()=>{if(automaticRefreshTimer.current!==undefined){clearTimeout(automaticRefreshTimer.current);automaticRefreshTimer.current=undefined}};
    const eligible=()=>mounted.current&&!authorizationFailed.current&&!realtimeConnected.current&&document.visibilityState==="visible"&&navigator.onLine!==false;
    const jitter=(delay:number)=>Math.max(1,Math.round(delay*(.8+Math.random()*.4)));
    const schedule=(delay:number)=>{cancel();if(eligible())automaticRefreshTimer.current=setTimeout(run,jitter(delay))};
    const run=async()=>{cancel();if(!eligible())return;const result=await automaticRefreshRunner.current();if(!mounted.current||result==="terminal-auth")return;
      if(result==="retryable-failure")automaticRefreshFailures.current+=1;else if(result==="success")automaticRefreshFailures.current=0;
      const delay=result==="retryable-failure"?Math.min(automaticRefreshMaximumMs,automaticRefreshBaseMs*2**Math.max(0,automaticRefreshFailures.current-1)):automaticRefreshBaseMs;schedule(delay)};
    const visibility=()=>{if(document.visibilityState==="visible")schedule(automaticRefreshRecoveryMs);else{cancel();setConvergence({kind:"paused"})}};
    const online=()=>schedule(automaticRefreshRecoveryMs),fallback=()=>schedule(automaticRefreshRecoveryMs),offline=()=>{cancel();setConvergence({kind:"paused"})};
    document.addEventListener("visibilitychange",visibility);window.addEventListener("online",online);window.addEventListener("zap-pronto-realtime-fallback",fallback);window.addEventListener("offline",offline);schedule(automaticRefreshBaseMs);
    return()=>{mounted.current=false;cancel();document.removeEventListener("visibilitychange",visibility);window.removeEventListener("online",online);window.removeEventListener("zap-pronto-realtime-fallback",fallback);window.removeEventListener("offline",offline)};
  },[]);

  useEffect(()=>{
    const subscribe=client.subscribeInboxEvents;
    if(!subscribe||!unitId||authorizationFailed.current)return;
    let disposed=false;
    let reconnectTimer:ReturnType<typeof setTimeout>|undefined;
    let controller:AbortController|undefined;
    const eligible=()=>mounted.current&&!authorizationFailed.current&&document.visibilityState==="visible"&&navigator.onLine!==false;
    const stop=()=>{if(reconnectTimer!==undefined){clearTimeout(reconnectTimer);reconnectTimer=undefined}controller?.abort();controller=undefined;realtimeAbort.current=undefined;realtimeConnected.current=false};
    const restart=()=>{stop();if(eligible())void connect()};
    const visibility=()=>{if(document.visibilityState==="visible")restart();else stop()};
    const online=()=>restart(),offline=()=>stop();
    const connect=async()=>{
      if(disposed||!eligible())return;
      controller=new AbortController();const currentController=controller;realtimeAbort.current=currentController;
      try{
        realtimeConnected.current=true;
        await subscribe(unitId,currentController.signal,()=>{if(eligible())void automaticRefreshRunner.current()});
      }catch(cause){
        realtimeConnected.current=false;
        if(currentController.signal.aborted||!mounted.current)return;
        if(cause instanceof AuthenticationRequired||cause instanceof ApiProblem&&[401,403].includes(cause.problem.status)){
          authorizationFailed.current=true;generation.current+=1;purgeSensitive();
          if(cause instanceof AuthenticationRequired)onAuthenticationRequired();else onAuthorizationChanged();
          return;
        }
        setConvergence({kind:"unstable"});
      }finally{
        realtimeConnected.current=false;
        const intentionallyStopped=currentController.signal.aborted;
        if(controller===currentController)controller=undefined;
        if(realtimeAbort.current===currentController)realtimeAbort.current=undefined;
        if(!intentionallyStopped&&mounted.current&&eligible())window.dispatchEvent(new Event("zap-pronto-realtime-fallback"));
        if(!intentionallyStopped&&!disposed&&mounted.current&&eligible()&&!controller)reconnectTimer=setTimeout(()=>{reconnectTimer=undefined;void connect()},automaticRefreshRecoveryMs);
      }
    };
    document.addEventListener("visibilitychange",visibility);window.addEventListener("online",online);window.addEventListener("offline",offline);
    void connect();
    return()=>{disposed=true;document.removeEventListener("visibilitychange",visibility);window.removeEventListener("online",online);window.removeEventListener("offline",offline);stop()};
  },[client,unitId]);

  async function older() {
    if (!selected || !messages?.nextCursor || refreshing || mutationBusy) return;
    const operationToken = acquireOperation();
    if (!operationToken) return;
    const g = generation.current;
    const capturedUnit = unitId;
    try {
      const page = await client.listInboxConversationMessages(selected.conversationId, { limit: 25, cursor: messages.nextCursor,...("resolvedAt" in selected?{before:selected.resolvedAt}:{}) });
      if (g === generation.current && capturedUnit === unitId) setMessages(old => {const merged=old ? {items:[...new Map([...old.items,...page.items].map(message=>[message.id,message])).values()],...(page.nextCursor?{nextCursor:page.nextCursor}:{})}:page;return "resolvedAt" in selected?historicalMessages(merged,selected.resolvedAt):merged});
    } catch (errorValue) {
      if (g === generation.current && capturedUnit === unitId) fail(errorValue, g);
    } finally {
      releaseOperation(operationToken);
    }
  }

  function appendUnique(current: ListHandoffsResponse | undefined, page: ListHandoffsResponse): ListHandoffsResponse {
    if (!current) return page;
    const ids = new Set(current.items.map(item => item.id));
    const items = [...current.items, ...page.items.filter(item => !ids.has(item.id))];
    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async function loadQueuePage() {
    const cursor = queue?.nextCursor;
    if (!unitId || !cursor || queuePageFlight.current || refreshing) return;
    const operationToken = acquireOperation();
    if (!operationToken) return;
    queuePageFlight.current = true;
    const capturedUnit = unitId;
    const g = generation.current;
    setLoadingQueuePage(true);
    try {
      const page = await client.listHandoffs(queueInput(capturedUnit, cursor));
      if (g === generation.current && capturedUnit === unitId) setQueue(current => appendUnique(current, page));
    } catch (caught) {
      if (g === generation.current && capturedUnit === unitId) fail(caught, g);
    } finally {
      releaseOperation(operationToken);
      queuePageFlight.current = false;
      if (capturedUnit === unitId) setLoadingQueuePage(false);
    }
  }

  async function loadActivePage() {
    const cursor = active?.nextCursor;
    if (!unitId || !cursor || activePageFlight.current || refreshing) return;
    const operationToken = acquireOperation();
    if (!operationToken) return;
    activePageFlight.current = true;
    const capturedUnit = unitId;
    const g = generation.current;
    setLoadingActivePage(true);
    try {
      const page = await client.listActiveInboxHandoffs({ unitId: capturedUnit, limit: 25, cursor });
      if (g === generation.current && capturedUnit === unitId) setActive(current => appendUnique(current, page));
    } catch (caught) {
      if (g === generation.current && capturedUnit === unitId) fail(caught, g);
    } finally {
      releaseOperation(operationToken);
      activePageFlight.current = false;
      if (capturedUnit === unitId) setLoadingActivePage(false);
    }
  }

  async function loadSupervisedPage(){
    const cursor=supervised?.nextCursor;
    if(!canSupervise||!cursor||supervisedPageFlight.current||refreshing)return;
    const operationToken=acquireOperation();if(!operationToken)return;
    supervisedPageFlight.current=true;const capturedUnit=unitId,g=generation.current;setLoadingSupervisedPage(true);
    try{const page=await client.listSupervisedInboxHandoffs({unitId:capturedUnit,limit:25,cursor});
      if(g===generation.current&&capturedUnit===unitId)setSupervised(current=>appendUnique(current,page));
    }catch(caught){if(g===generation.current&&capturedUnit===unitId)fail(caught,g)}finally{
      releaseOperation(operationToken);supervisedPageFlight.current=false;if(capturedUnit===unitId)setLoadingSupervisedPage(false)}
  }

  async function loadResolvedPage(){
    const cursor=resolved?.nextCursor;if(!canReadHistory||!cursor||resolvedPageFlight.current||refreshing)return;
    const operationToken=acquireOperation();if(!operationToken)return;
    resolvedPageFlight.current=true;const capturedUnit=unitId,g=generation.current;setLoadingResolvedPage(true);
    try{const page=await client.listResolvedInboxHandoffs(resolvedInput(capturedUnit,cursor));
      if(g===generation.current&&capturedUnit===unitId)setResolved(current=>current?{items:[...new Map([...current.items,...page.items].map(item=>[item.id,item])).values()],...(page.nextCursor?{nextCursor:page.nextCursor}:{})}:page);
    }catch(caught){if(g===generation.current&&capturedUnit===unitId)fail(caught,g)}finally{
      releaseOperation(operationToken);resolvedPageFlight.current=false;if(capturedUnit===unitId)setLoadingResolvedPage(false)}
  }

  async function reloadSlaAlerts(){
    if(!canReadSlaAlerts||mutationBusy||refreshing)return;const operationToken=acquireOperation();if(!operationToken)return;
    const capturedUnit=unitId,g=++generation.current;setError(undefined);
    try{const page=await client.listInboxSlaAlerts(slaAlertInput(capturedUnit));if(g===generation.current&&capturedUnit===unitId)setSlaAlerts(page)}
    catch(caught){if(g===generation.current&&capturedUnit===unitId)fail(caught,g)}finally{releaseOperation(operationToken)}
  }
  async function loadSlaAlertPage(){
    const cursor=slaAlerts?.nextCursor;if(!canReadSlaAlerts||!cursor||slaAlertPageFlight.current||refreshing)return;
    const operationToken=acquireOperation();if(!operationToken)return;slaAlertPageFlight.current=true;
    const capturedUnit=unitId,g=generation.current;setLoadingSlaAlertPage(true);
    try{const page=await client.listInboxSlaAlerts(slaAlertInput(capturedUnit,cursor));if(g===generation.current&&capturedUnit===unitId)setSlaAlerts(current=>current?{items:[...new Map([...current.items,...page.items].map(item=>[item.handoffId,item])).values()],...(page.nextCursor?{nextCursor:page.nextCursor}:{})}:page)}
    catch(caught){if(g===generation.current&&capturedUnit===unitId)fail(caught,g)}finally{releaseOperation(operationToken);slaAlertPageFlight.current=false;if(capturedUnit===unitId)setLoadingSlaAlertPage(false)}
  }
  async function acknowledgeSlaAlert(alert:ListInboxSlaAlertsResponse["items"][number]){
    if(!canAcknowledgeSlaAlerts||alert.acknowledgedAt||refreshFlight.current||refreshing)return;const token=acquireMutation();if(!token)return;
    const current=slaAlertIntent.current;const intent=current?.id===alert.handoffId&&current.version===alert.version?current:{id:alert.handoffId,version:alert.version,key:crypto.randomUUID()};slaAlertIntent.current=intent;
    const capturedUnit=unitId,g=generation.current;setAcknowledgingAlertId(alert.handoffId);setError(undefined);
    try{const result=await client.acknowledgeInboxSlaAlert(intent.id,intent.version,intent.key);if(g!==generation.current||capturedUnit!==unitId)return;
      setSlaAlerts(page=>page?{...page,items:page.items.map(item=>item.handoffId===result.handoffId?{...item,acknowledgedAt:result.acknowledgedAt,version:result.version}:item)}:page);slaAlertIntent.current=undefined;setClosedNotice("Alerta de SLA reconhecido.")}
    catch(caught){if(g!==generation.current||capturedUnit!==unitId)return;if(caught instanceof ApiProblem&&[404,409].includes(caught.problem.status)){slaAlertIntent.current=undefined;try{const page=await client.listInboxSlaAlerts(slaAlertInput(capturedUnit));if(g===generation.current&&capturedUnit===unitId){setSlaAlerts(page);setClosedNotice("O alerta mudou e a lista foi atualizada.")}}catch(reconcile){fail(reconcile,g)}}else fail(caught,g)}
    finally{releaseMutation(token);if(g===generation.current)setAcknowledgingAlertId(undefined)}
  }

  async function claim() {
    const target = detail?.claimTarget;
    if (!selected || !target || !detail.allowedActions.includes("CLAIM_HANDOFF") || refreshFlight.current || refreshing) return;
    const lockToken = acquireMutation();
    if (!lockToken) return;
    const g = generation.current; setClaiming(true); setError(undefined);
    const intent = claimIntent.current?.id === target.handoffId && claimIntent.current.version === target.expectedVersion
      ? claimIntent.current : { id: target.handoffId, version: target.expectedVersion, key: crypto.randomUUID() };
    claimIntent.current = intent;
    try {
      await client.claimHandoff(intent.id, intent.version, intent.key); if (g !== generation.current) return;
      claimIntent.current = undefined; setDetail(undefined); setMessages(undefined);
      const [queued, mine, alerts, nextDetail, nextMessages] = await Promise.all([client.listHandoffs(queueInput(unitId)), client.listActiveInboxHandoffs({ unitId, limit: 25 }), slaAlertsFirst(unitId), client.getInboxConversation(selected.conversationId), client.listInboxConversationMessages(selected.conversationId, { limit: 25 })]);
      if (g !== generation.current) return; setQueue(queued); setActive(mine); setSlaAlerts(alerts); setSelected(mine.items.find(item => item.id === selected.id)); setDetail(nextDetail); setMessages(nextMessages); claimIntent.current = undefined;
    } catch (caught) {
      if (g !== generation.current) return;
      if (!claimIntent.current) failCommittedReconciliation(caught, g);
      else if (caught instanceof ApiProblem && [404, 409].includes(caught.problem.status)) {
        claimIntent.current = undefined; setError(caught.problem.detail==="ASSIGNMENT_OUTSIDE_SHIFT"?"Você está fora do turno configurado para esta unidade. Procure a supervisão para garantir a continuidade do atendimento.":`Outro atendimento venceu esta disputa. Correlação: ${caught.problem.correlationId}`);
        try {
          const [queued, mine, alerts, nextDetail, nextMessages] = await Promise.all([client.listHandoffs(queueInput(unitId)), client.listActiveInboxHandoffs({ unitId, limit: 25 }), slaAlertsFirst(unitId), client.getInboxConversation(selected.conversationId), client.listInboxConversationMessages(selected.conversationId, { limit: 25 })]);
          if (g === generation.current) { setQueue(queued); setActive(mine); setSlaAlerts(alerts); setSelected(queued.items.find(item => item.id === selected.id) ?? mine.items.find(item => item.id === selected.id)); setDetail(nextDetail); setMessages(nextMessages); }
        } catch (refreshError) { fail(refreshError, g); }
      }
      else fail(caught, g);
    } finally { releaseMutation(lockToken); if (g === generation.current) setClaiming(false); }
  }

  async function resolve() {
    const target = detail?.resolveTarget;
    if (!selected || !target || !resolveDisposition || !detail.allowedActions.includes("RESOLVE_HANDOFF") || refreshFlight.current || refreshing) return;
    const lockToken = acquireMutation();
    if (!lockToken) return;
    const g = generation.current,capturedUnit=unitId; setResolving(true); setError(undefined);
    const intent = resolveIntent.current?.id === target.handoffId && resolveIntent.current.version === target.expectedVersion&&resolveIntent.current.disposition===resolveDisposition
      ? resolveIntent.current : { id: target.handoffId, version: target.expectedVersion,disposition:resolveDisposition, key: crypto.randomUUID() };
    resolveIntent.current = intent;
    try {
      await client.resolveHandoff(intent.id, intent.version,intent.disposition, intent.key); if (g !== generation.current||capturedUnit!==unitId) return;
      resolveIntent.current=undefined;purgeSelection();
      const [queued, mine,others,closed,alerts] = await Promise.all([client.listHandoffs(queueInput(capturedUnit)), client.listActiveInboxHandoffs({ unitId:capturedUnit, limit: 25 }),supervisedFirst(capturedUnit),resolvedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);
      if (g !== generation.current||capturedUnit!==unitId) return; setQueue(queued); setActive(mine);setSupervised(others);setResolved(closed);setSlaAlerts(alerts); purgeSelection(); resolveIntent.current = undefined; setClosedNotice("Atendimento encerrado.");
    } catch (caught) {
      if (g !== generation.current||capturedUnit!==unitId) return;
      if (!resolveIntent.current) failCommittedReconciliation(caught,g);
      else if (caught instanceof ApiProblem && [404, 409].includes(caught.problem.status)) {
        resolveIntent.current = undefined;purgeSelection(); setError(`O atendimento mudou antes do encerramento. Correlação: ${caught.problem.correlationId}`);
        try {
          const [queued, mine,others,closed,alerts] = await Promise.all([client.listHandoffs(queueInput(capturedUnit)), client.listActiveInboxHandoffs({ unitId:capturedUnit, limit: 25 }),supervisedFirst(capturedUnit),resolvedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);
          if (g === generation.current&&capturedUnit===unitId) { setQueue(queued); setActive(mine);setSupervised(others);setResolved(closed);setSlaAlerts(alerts); }
        } catch (refreshError) { fail(refreshError, g); }
      }
      else fail(caught, g);
    } finally { releaseMutation(lockToken); if (g === generation.current) setResolving(false); }
  }

  function cancelResolve(){if(mutationLock.current)return;setResolveOpen(false);setResolveDisposition("");resolveIntent.current=undefined}

  async function requeue() {
    const target=detail?.requeueTarget;
    if(!selected||!target||!detail.allowedActions.includes("REQUEUE_HANDOFF")||refreshFlight.current||refreshing)return;
    const lockToken=acquireMutation();if(!lockToken)return;
    const g=generation.current,capturedUnit=unitId;setRequeueing(true);setError(undefined);
    const intent=requeueIntent.current?.id===target.handoffId&&requeueIntent.current.version===target.expectedVersion
      ?requeueIntent.current:{id:target.handoffId,version:target.expectedVersion,key:crypto.randomUUID()};requeueIntent.current=intent;
    try{
      await client.requeueHandoff(intent.id,intent.version,intent.key);if(g!==generation.current)return;
      requeueIntent.current=undefined;purgeSelection();
      const[queued,mine,others,alerts]=await Promise.all([client.listHandoffs(queueInput(capturedUnit)),client.listActiveInboxHandoffs({unitId:capturedUnit,limit:25}),supervisedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);
      if(g!==generation.current||capturedUnit!==unitId)return;setQueue(queued);setActive(mine);setSupervised(others);setSlaAlerts(alerts);purgeSelection();requeueIntent.current=undefined;setClosedNotice("Atendimento devolvido à fila.");
    }catch(caught){if(g!==generation.current||capturedUnit!==unitId)return;if(!requeueIntent.current)failCommittedReconciliation(caught,g);else if(caught instanceof ApiProblem&&[404,409].includes(caught.problem.status)){
      requeueIntent.current=undefined;purgeSelection();
      try{const[queued,mine,others,alerts]=await Promise.all([client.listHandoffs(queueInput(capturedUnit)),client.listActiveInboxHandoffs({unitId:capturedUnit,limit:25}),supervisedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);
        if(g===generation.current&&capturedUnit===unitId){setQueue(queued);setActive(mine);setSupervised(others);setSlaAlerts(alerts);setError(`O atendimento mudou antes da devolução. Correlação: ${caught.problem.correlationId}`)}}catch(refreshError){fail(refreshError,g)}
    }else fail(caught,g);}finally{releaseMutation(lockToken);if(g===generation.current)setRequeueing(false);}
  }

  function cancelReopen(){if(mutationLock.current)return;setReopenOpen(false);setReopenReason("");reopenIntent.current=undefined}

  async function reopen(){
    const target=selected&&"resolvedAt" in selected?selected.reopenTarget:null;
    if(!selected||!("resolvedAt" in selected)||!target||!reopenReason||refreshFlight.current||refreshing)return;
    const lockToken=acquireMutation();if(!lockToken)return;
    const g=generation.current,capturedUnit=unitId;setReopening(true);setError(undefined);
    const intent=reopenIntent.current?.id===target.handoffId&&reopenIntent.current.version===target.expectedVersion&&reopenIntent.current.reason===reopenReason
      ?reopenIntent.current:{id:target.handoffId,version:target.expectedVersion,reason:reopenReason,key:crypto.randomUUID()};
    reopenIntent.current=intent;
    try{
      await client.reopenInboxHandoff(intent.id,intent.version,intent.reason,intent.key);
      if(g!==generation.current||capturedUnit!==unitId)return;
      reopenIntent.current=undefined;
      const[queued,mine,others,closed,alerts]=await Promise.all([client.listHandoffs(queueInput(capturedUnit)),client.listActiveInboxHandoffs({unitId:capturedUnit,limit:25}),supervisedFirst(capturedUnit),resolvedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);
      if(g!==generation.current||capturedUnit!==unitId)return;
      const historical=closed.items.find(item=>item.id===selected.id);
      setQueue(queued);setActive(mine);setSupervised(others);setResolved(closed);setSlaAlerts(alerts);setReopenOpen(false);setReopenReason("");
      if(historical)setSelected(historical);else purgeSelection();
      setClosedNotice("Atendimento reaberto na fila humana.");
    }catch(caught){
      if(g!==generation.current||capturedUnit!==unitId)return;
      if(!reopenIntent.current){purgeSelection();failCommittedReconciliation(caught,g)}
      else if(caught instanceof ApiProblem&&[404,409].includes(caught.problem.status)){
        reopenIntent.current=undefined;purgeSelection();
        try{const[queued,mine,others,closed,alerts]=await Promise.all([client.listHandoffs(queueInput(capturedUnit)),client.listActiveInboxHandoffs({unitId:capturedUnit,limit:25}),supervisedFirst(capturedUnit),resolvedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);
          if(g===generation.current&&capturedUnit===unitId){setQueue(queued);setActive(mine);setSupervised(others);setResolved(closed);setSlaAlerts(alerts);setError(`O atendimento mudou antes da reabertura. Correlação: ${caught.problem.correlationId}`)}}catch(refreshError){fail(refreshError,g)}
      }else fail(caught,g);
    }finally{releaseMutation(lockToken);if(g===generation.current)setReopening(false)}
  }

  async function openTransfer(){const target=detail?.transferTarget;if(!target||!detail?.allowedActions.includes("TRANSFER_HANDOFF"))return;
    const operationToken=acquireOperation();if(!operationToken)return;const g=generation.current;setLoadingTransferCandidates(true);setError(undefined);
    try{const candidates=await client.listInboxHandoffTransferCandidates(target.handoffId);if(g!==generation.current)return;
      setTransferCandidates(candidates);setTransferTargetUserId(candidates.items[0]?.id??"");setTransferReason("");setTransferOpen(true)}catch(caught){if(g===generation.current){
        if(caught instanceof AuthenticationRequired||caught instanceof ApiProblem&&[401,403].includes(caught.problem.status))fail(caught,g);
        else setError(caught instanceof ApiProblem?`Não foi possível carregar os atendentes elegíveis. Correlação: ${caught.problem.correlationId}`:"Não foi possível carregar os atendentes elegíveis.")
      }}finally{releaseOperation(operationToken);if(g===generation.current)setLoadingTransferCandidates(false)}}
  function closeTransfer(){if(mutationLock.current)return;setTransferOpen(false);setTransferCandidates(undefined);setTransferTargetUserId("");setTransferReason("");transferIntent.current=undefined}
  async function transfer(){const target=detail?.transferTarget;if(!selected||!target||!transferTargetUserId||!transferReason||!detail.allowedActions.includes("TRANSFER_HANDOFF"))return;
    const lockToken=acquireMutation();if(!lockToken)return;const g=generation.current,capturedUnit=unitId;setTransferring(true);setError(undefined);
    const intent=transferIntent.current?.id===target.handoffId&&transferIntent.current.version===target.expectedVersion&&transferIntent.current.targetUserId===transferTargetUserId&&transferIntent.current.reason===transferReason
      ?transferIntent.current:{id:target.handoffId,version:target.expectedVersion,targetUserId:transferTargetUserId,reason:transferReason,key:crypto.randomUUID()};transferIntent.current=intent;
    try{await client.transferInboxHandoff(intent.id,intent.version,intent.targetUserId,intent.reason,intent.key);if(g!==generation.current||capturedUnit!==unitId)return;
      transferIntent.current=undefined;purgeSelection();
      const[queued,mine,others,alerts]=await Promise.all([client.listHandoffs(queueInput(capturedUnit)),client.listActiveInboxHandoffs({unitId:capturedUnit,limit:25}),supervisedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);if(g!==generation.current||capturedUnit!==unitId)return;
      setQueue(queued);setActive(mine);setSupervised(others);setSlaAlerts(alerts);purgeSelection();transferIntent.current=undefined;setClosedNotice("Atendimento transferido.")
    }catch(caught){if(g!==generation.current||capturedUnit!==unitId)return;if(!transferIntent.current)failCommittedReconciliation(caught,g);else if(caught instanceof ApiProblem&&[404,409].includes(caught.problem.status)){
      transferIntent.current=undefined;purgeSelection();
      try{const[queued,mine,others,alerts]=await Promise.all([client.listHandoffs(queueInput(capturedUnit)),client.listActiveInboxHandoffs({unitId:capturedUnit,limit:25}),supervisedFirst(capturedUnit),slaAlertsFirst(capturedUnit)]);
        if(g===generation.current&&capturedUnit===unitId){setQueue(queued);setActive(mine);setSupervised(others);setSlaAlerts(alerts);setError(`O atendimento mudou antes da transferência. Correlação: ${caught.problem.correlationId}`)}}catch(refreshError){fail(refreshError,g)}
    }else fail(caught,g)}finally{releaseMutation(lockToken);if(g===generation.current)setTransferring(false)}}

  async function takeover(){const target=detail?.takeoverTarget;
    if(!selected||!target||!detail.allowedActions.includes("TAKEOVER_HANDOFF")||refreshFlight.current||refreshing)return;
    const lockToken=acquireMutation();if(!lockToken)return;const g=generation.current;setTakingOver(true);setError(undefined);
    const intent=takeoverIntent.current?.id===target.handoffId&&takeoverIntent.current.version===target.expectedVersion
      ?takeoverIntent.current:{id:target.handoffId,version:target.expectedVersion,key:crypto.randomUUID()};takeoverIntent.current=intent;
    try{await client.takeoverInboxHandoff(intent.id,intent.version,intent.key);if(g!==generation.current)return;
      takeoverIntent.current=undefined;setDetail(undefined);setMessages(undefined);setTakeoverConfirmOpen(false);
      const[queued,mine,others,alerts,nextDetail,nextMessages]=await Promise.all([client.listHandoffs(queueInput(unitId)),
        client.listActiveInboxHandoffs({unitId,limit:25}),supervisedFirst(unitId),slaAlertsFirst(unitId),client.getInboxConversation(selected.conversationId),
        client.listInboxConversationMessages(selected.conversationId,{limit:25})]);if(g!==generation.current)return;
      const nextSelected=mine.items.find(item=>item.id===selected.id);setQueue(queued);setActive(mine);setSupervised(others);setSlaAlerts(alerts);
      takeoverIntent.current=undefined;setTakeoverConfirmOpen(false);setClosedNotice("Atendimento assumido pela supervisão.");
      if(nextSelected){setSelected(nextSelected);setDetail(nextDetail);setMessages(nextMessages)}else purgeSelection("Atendimento assumido; atualize a lista para abri-lo.");
    }catch(caught){if(g!==generation.current)return;if(!takeoverIntent.current)failCommittedReconciliation(caught,g);else if(caught instanceof ApiProblem&&[404,409].includes(caught.problem.status)){
      takeoverIntent.current=undefined;setError(`O atendimento mudou antes da assunção. Correlação: ${caught.problem.correlationId}`);
      try{const[queued,mine,others,alerts]=await Promise.all([client.listHandoffs(queueInput(unitId)),client.listActiveInboxHandoffs({unitId,limit:25}),supervisedFirst(unitId),slaAlertsFirst(unitId)]);
        if(g===generation.current){setQueue(queued);setActive(mine);setSupervised(others);setSlaAlerts(alerts);purgeSelection()}}catch(refreshError){fail(refreshError,g)}}else fail(caught,g)
    }finally{releaseMutation(lockToken);if(g===generation.current)setTakingOver(false)}}

  async function sendText() {
    const target = detail?.sendTextTarget;
    const normalized = draft.replace(/^[ \t\n]+|[ \t\n]+$/gu, "");
    if (!selected || !target || !detail.allowedActions.includes("SEND_TEXT") || refreshFlight.current || refreshing || !normalized) return;
    const lockToken = acquireMutation();
    if (!lockToken) return;
    const g = generation.current; setSending(true); setError(undefined);
    const intent = sendIntent.current?.id === selected.conversationId && sendIntent.current.version === target.expectedConversationVersion && sendIntent.current.body === normalized
      ? sendIntent.current : { id: selected.conversationId, version: target.expectedConversationVersion, body: normalized, key: crypto.randomUUID() };
    sendIntent.current = intent;
    try {
      await client.sendHumanTextMessage(intent.id, { body: intent.body, expectedConversationVersion: intent.version }, intent.key); if (g !== generation.current) return;
      sendIntent.current=undefined;setDetail(undefined);setMessages(undefined);setDraft("");
      const [nextDetail, nextMessages, queued, mine] = await Promise.all([client.getInboxConversation(selected.conversationId), client.listInboxConversationMessages(selected.conversationId, { limit: 25 }), client.listHandoffs(queueInput(unitId)), client.listActiveInboxHandoffs({ unitId, limit: 25 })]);
      if (g !== generation.current) return; setDetail(nextDetail); setMessages(nextMessages); setQueue(queued); setActive(mine); setDraft(""); sendIntent.current = undefined;
    } catch (caught) {
      if (g !== generation.current) return;
      if (!sendIntent.current) failCommittedReconciliation(caught,g);
      else if (caught instanceof ApiProblem && [404, 409].includes(caught.problem.status)) {
        sendIntent.current = undefined; setError(`A conversa mudou antes do envio. Correlação: ${caught.problem.correlationId}`);
        try {
          const [nextDetail, nextMessages, queued, mine] = await Promise.all([client.getInboxConversation(selected.conversationId), client.listInboxConversationMessages(selected.conversationId, { limit: 25 }), client.listHandoffs(queueInput(unitId)), client.listActiveInboxHandoffs({ unitId, limit: 25 })]);
          if (g === generation.current) { setDetail(nextDetail); setMessages(nextMessages); setQueue(queued); setActive(mine); }
        } catch (refreshError) { fail(refreshError, g); }
      }
      else fail(caught, g);
    } finally { releaseMutation(lockToken); if (g === generation.current) setSending(false); }
  }

  async function cancelMessage(messageId: string) {
    if (!selected || !detail || refreshFlight.current || refreshing) return;
    const message = messages?.items.find(item => item.id === messageId);
    if (!message?.allowedActions.includes("CANCEL_QUEUED")) return;
    const lockToken = acquireMutation();
    if (!lockToken) return;
    const g = generation.current; setCancellingId(messageId); setError(undefined);
    const intent = cancelIntent.current?.conversationId === selected.conversationId && cancelIntent.current.messageId === messageId && cancelIntent.current.version === detail.version
      ? cancelIntent.current : { conversationId: selected.conversationId, messageId, version: detail.version, key: crypto.randomUUID() };
    cancelIntent.current = intent;
    try {
      await client.cancelHumanTextMessage(intent.conversationId, intent.messageId, intent.version, intent.key); if (g !== generation.current) return;
      cancelIntent.current=undefined;setDetail(undefined);setMessages(undefined);
      const [nextDetail, nextMessages, queued, mine] = await Promise.all([client.getInboxConversation(selected.conversationId), client.listInboxConversationMessages(selected.conversationId, { limit: 25 }), client.listHandoffs(queueInput(unitId)), client.listActiveInboxHandoffs({ unitId, limit: 25 })]);
      if (g !== generation.current) return; setDetail(nextDetail); setMessages(nextMessages); setQueue(queued); setActive(mine); cancelIntent.current = undefined;
    } catch (caught) {
      if (g !== generation.current) return;
      if (!cancelIntent.current) failCommittedReconciliation(caught,g);
      else if (caught instanceof ApiProblem && [404, 409].includes(caught.problem.status)) {
        cancelIntent.current = undefined; setError(`A intenção já não pode ser cancelada. Correlação: ${caught.problem.correlationId}`);
        try {
          const [nextDetail, nextMessages, queued, mine] = await Promise.all([client.getInboxConversation(selected.conversationId), client.listInboxConversationMessages(selected.conversationId, { limit: 25 }), client.listHandoffs(queueInput(unitId)), client.listActiveInboxHandoffs({ unitId, limit: 25 })]);
          if (g === generation.current) { setDetail(nextDetail); setMessages(nextMessages); setQueue(queued); setActive(mine); }
        } catch (refreshError) { fail(refreshError, g); }
      }
      else fail(caught, g);
    } finally { releaseMutation(lockToken); if (g === generation.current) setCancellingId(undefined); }
  }

  const actionsDisabled = refreshing;
  const convergenceLabel=convergence.kind==="updated"?"Atualizado":convergence.kind==="deferred"?"Atualização adiada enquanto há uma operação em andamento.":convergence.kind==="unstable"?"Conexão instável; nova tentativa automática agendada.":"Atualização automática pausada.";
  return <section className="inbox" aria-busy={refreshing}>
    <div className="inbox-title"><div><p className="inbox-eyebrow">Central de atendimento</p><h2>Inbox</h2></div>
      <div><p>{convergenceLabel}</p>{convergence.at&&<p>Última sincronização local: <time dateTime={convergence.at}>{new Date(convergence.at).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</time></p>}<span role="status" aria-live="polite" aria-atomic="true" style={{position:"absolute",width:1,height:1,padding:0,margin:-1,overflow:"hidden",clip:"rect(0, 0, 0, 0)",whiteSpace:"nowrap",border:0}}>{convergenceAnnouncement}</span><button className="inbox-refresh" type="button" onClick={()=>{void refresh()}} disabled={!unitId || refreshing || mutationBusy}>{refreshing ? "Atualizando…" : "Atualizar Inbox"}</button></div></div>
    {canReadSlaAlerts&&capacityAlert?.state==="ACTIVE"&&<aside role="alert" aria-labelledby="capacity-alert-title"><h3 id="capacity-alert-title">Demanda sustentada com capacidade disponível</h3><p>{capacityAlert.sustainedQueuedCount} atendimentos permanecem na fila há pelo menos {capacityAlert.sustainedMinutes} minutos, com capacidade agregada de {capacityAlert.availableCapacity}.</p><p>Distribua a fila conforme prioridade, SLA e regras de atribuição. Este alerta não classifica integrantes.</p></aside>}
    {canReadSlaAlerts&&capacityAlertUnavailable&&<p role="status">Alerta agregado temporariamente indisponível.</p>}
    <section aria-labelledby="availability-title"><h3 id="availability-title">Minha disponibilidade</h3>
      {!availability?<p>Carregando disponibilidade…</p>:<><p>Status: <strong>{availability.status==="AVAILABLE"?"Disponível":availability.status==="PAUSED"?"Pausado":"Offline"}</strong> · {availability.activeCount} de {availability.maxActive} ativos</p>
      {!availabilityOpen&&<button type="button" disabled={mutationBusy||refreshing} onClick={openAvailability}>Alterar disponibilidade</button>}</>}
      {availability&&availabilityOpen&&<fieldset><legend>Confirmar disponibilidade</legend>
        <label>Status <select aria-label="Status da disponibilidade" value={availabilityStatus} disabled={savingAvailability} onChange={event=>{setAvailabilityStatus(event.target.value as InboxAvailability["status"]);invalidateAvailability()}}><option value="AVAILABLE">Disponível</option><option value="PAUSED">Pausado</option><option value="OFFLINE">Offline</option></select></label>
        <label>Máximo de atendimentos ativos <input type="number" min="1" max="100" value={availabilityMaxActive} disabled={savingAvailability} onChange={event=>{setAvailabilityMaxActive(event.target.value);invalidateAvailability()}}/></label>
        {availabilityStatus==="PAUSED"&&<><label>Motivo da pausa <select value={availabilityPauseReason} disabled={savingAvailability} onChange={event=>{setAvailabilityPauseReason(event.target.value as NonNullable<InboxAvailability["pauseReason"]>);invalidateAvailability()}}><option value="BREAK">Intervalo</option><option value="TRAINING">Treinamento</option><option value="MEETING">Reunião</option><option value="OTHER_OPERATIONAL">Outra atividade operacional</option></select></label>
        <label>Pausado até (opcional) <input type="datetime-local" value={availabilityPausedUntil} disabled={savingAvailability} onChange={event=>{setAvailabilityPausedUntil(event.target.value);invalidateAvailability()}}/></label></>}
        <p>A alteração vale apenas para a unidade selecionada e pode afetar a distribuição de novos atendimentos.</p>
        <button type="button" disabled={savingAvailability} onClick={saveAvailability}>{savingAvailability?"Salvando…":"Confirmar alteração"}</button>
        <button type="button" disabled={savingAvailability} onClick={()=>{setAvailabilityOpen(false);availabilityIntent.current=undefined}}>Cancelar alteração</button>
      </fieldset>}
    </section>
    <div className="inbox-toolbar"><label>Unidade <select value={unitId} disabled={mutationBusy || refreshing} onChange={event => switchUnit(event.target.value)}>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
    <label>Prioridade <select value={priorityFilter} disabled={mutationBusy || refreshing} onChange={event => changeQueueFilters(event.target.value as typeof priorityFilter, slaFilter)}>
      <option value="">Todas</option><option value="URGENT">Urgente</option><option value="HIGH">Alta</option><option value="NORMAL">Normal</option><option value="LOW">Baixa</option>
    </select></label>
    <label>SLA <select value={slaFilter} disabled={mutationBusy || refreshing} onChange={event => changeQueueFilters(priorityFilter, event.target.value as typeof slaFilter)}>
      <option value="">Todos</option><option value="OVERDUE">Atrasado</option><option value="DUE_SOON">Próximo do prazo</option><option value="ON_TRACK">No prazo</option>
    </select></label></div>
    {error && <p role="alert">{error}</p>}{closedNotice && <p role="status">{closedNotice}</p>}
    <div className="inbox-workspace"><aside className="inbox-queues" aria-label="Listas de atendimento"><div className="inbox-queue-section">
    <div className="inbox-section-heading"><h3>Fila humana</h3><span>{queue?.items.length ?? 0}</span></div>
    {unitId && !queue && <p>Carregando atendimentos…</p>}{queue?.items.length === 0 && <p>Nenhum atendimento na fila.</p>}
    <ul className="handoff-list">{queue?.items.map(item => <li key={item.id} className={selected?.id === item.id ? "is-selected" : undefined}><button type="button" aria-pressed={selected?.id===item.id} aria-label={`${item.contactName ?? "Contato"} · ${item.priority}`} disabled={actionsDisabled || mutationBusy} onClick={() => open(item)}><strong>{item.contactName ?? "Contato"}</strong><span>{item.reason}</span><span className={`priority priority-${item.priority.toLowerCase()}`}>{priorityLabel(item.priority)}</span><span className={`sla sla-${item.slaStatus?.toLowerCase() ?? "none"}`}>{slaLabel(item.slaStatus)}</span></button></li>)}</ul>
    {queue?.nextCursor && <button type="button" disabled={loadingQueuePage || actionsDisabled || mutationBusy} onClick={loadQueuePage}>{loadingQueuePage ? "Carregando fila…" : "Carregar mais da fila"}</button>}
    </div><div className="inbox-queue-section"><div className="inbox-section-heading"><h3>Meus atendimentos</h3><span>{active?.items.length ?? 0}</span></div>{active?.items.length === 0 && <p>Nenhum atendimento ativo.</p>}
    <ul className="handoff-list">{active?.items.map(item => <li key={item.id} className={selected?.id === item.id ? "is-selected" : undefined}><button type="button" aria-pressed={selected?.id===item.id} aria-label={`${item.contactName ?? "Contato"} · Em atendimento`} disabled={actionsDisabled || mutationBusy} onClick={() => open(item)}><strong>{item.contactName ?? "Contato"}</strong><span>Em atendimento</span><span className={`priority priority-${item.priority.toLowerCase()}`}>{priorityLabel(item.priority)}</span><span className={`sla sla-${item.slaStatus?.toLowerCase() ?? "none"}`}>{slaLabel(item.slaStatus)}</span></button></li>)}</ul>
    {active?.nextCursor && <button type="button" disabled={loadingActivePage || actionsDisabled || mutationBusy} onClick={loadActivePage}>{loadingActivePage ? "Carregando ativos…" : "Carregar mais ativos"}</button>}
    </div>{canSupervise&&<div className="inbox-queue-section"><div className="inbox-section-heading"><h3>Ativos da unidade</h3><span>{supervised?.items.length??0}</span></div>
    {supervised?.items.length===0&&<p>Nenhum atendimento sob supervisão.</p>}
    <ul className="handoff-list">{supervised?.items.map(item=><li key={item.id} className={selected?.id===item.id?"is-selected":undefined}><button type="button" aria-pressed={selected?.id===item.id} aria-label={`${item.contactName??"Contato"} · Sob supervisão`} disabled={actionsDisabled||mutationBusy} onClick={()=>open(item)}><strong>{item.contactName??"Contato"}</strong><span>Sob supervisão</span><span className={`priority priority-${item.priority.toLowerCase()}`}>{priorityLabel(item.priority)}</span><span className={`sla sla-${item.slaStatus?.toLowerCase()??"none"}`}>{slaLabel(item.slaStatus)}</span></button></li>)}</ul>
    {supervised?.nextCursor&&<button type="button" disabled={loadingSupervisedPage||actionsDisabled||mutationBusy} onClick={loadSupervisedPage}>{loadingSupervisedPage?"Carregando supervisionados…":"Carregar mais supervisionados"}</button>}
    </div>}{canReadSlaAlerts&&<div className="inbox-queue-section"><div className="inbox-section-heading"><h3>Alertas de SLA</h3><span aria-label={`${slaAlerts?.items.length??0} alertas de SLA`}>{slaAlerts?.items.length??0}</span></div>
    <fieldset><legend>Filtros dos alertas</legend><label>Estado do alerta <select value={slaAlertSeverity} disabled={mutationBusy||refreshing} onChange={event=>setSlaAlertSeverity(event.target.value as typeof slaAlertSeverity)}><option value="">Todos</option><option value="MISSING_SLA">Sem prazo de SLA</option><option value="DUE_SOON">Vence em breve</option><option value="OVERDUE">SLA vencido</option></select></label>
    <label>Prioridade do alerta <select value={slaAlertPriority} disabled={mutationBusy||refreshing} onChange={event=>setSlaAlertPriority(event.target.value as typeof slaAlertPriority)}><option value="">Todas</option><option value="URGENT">Urgente</option><option value="HIGH">Alta</option><option value="NORMAL">Normal</option><option value="LOW">Baixa</option></select></label>
    <button type="button" disabled={mutationBusy||refreshing||Boolean(operationLock.current)} onClick={reloadSlaAlerts}>Aplicar filtros dos alertas</button></fieldset>
    {slaAlerts?.items.length===0&&<p>Nenhum alerta de SLA.</p>}<ul className="handoff-list">{slaAlerts?.items.map(alert=><li key={alert.handoffId}><strong>{alertLabel(alert.severity)}</strong><span>{priorityLabel(alert.priority)} · {Math.floor(alert.ageSeconds/60)} min na fila</span><span>Capacidade disponível: {alert.availableCapacity}</span>{alert.slaDueAt&&<time dateTime={alert.slaDueAt}>Prazo: {new Date(alert.slaDueAt).toLocaleString("pt-BR")}</time>}{alert.acknowledgedAt?<span>Reconhecido em {new Date(alert.acknowledgedAt).toLocaleString("pt-BR")}</span>:canAcknowledgeSlaAlerts&&<button type="button" disabled={mutationBusy||refreshing} onClick={()=>acknowledgeSlaAlert(alert)}>{acknowledgingAlertId===alert.handoffId?"Reconhecendo…":"Reconhecer alerta"}</button>}</li>)}</ul>
    {slaAlerts?.nextCursor&&<button type="button" disabled={loadingSlaAlertPage||mutationBusy||refreshing} onClick={loadSlaAlertPage}>{loadingSlaAlertPage?"Carregando alertas…":"Carregar mais alertas"}</button>}
    </div>}{canReadHistory&&<div className="inbox-queue-section"><div className="inbox-section-heading"><h3>Encerrados</h3><span aria-label={`${resolved?.items.length??0} atendimentos encerrados`}>{resolved?.items.length??0}</span></div>
    <fieldset><legend>Filtros dos atendimentos encerrados</legend>
      <label>Prioridade dos encerrados <select value={resolvedFilters.priority} disabled={mutationBusy||refreshing}
        onChange={event=>setResolvedFilters(current=>({...current,priority:event.target.value as ResolvedFilters["priority"]}))}>
        <option value="">Todas</option><option value="URGENT">Urgente</option><option value="HIGH">Alta</option><option value="NORMAL">Normal</option><option value="LOW">Baixa</option>
      </select></label>
      <label>Disposição dos encerrados <select value={resolvedFilters.disposition} disabled={mutationBusy||refreshing}
        onChange={event=>setResolvedFilters(current=>({...current,disposition:event.target.value as ResolvedFilters["disposition"]}))}>
        <option value="">Todas</option><option value="RESOLVED">Resolvido</option><option value="DUPLICATE">Duplicado</option>
        <option value="CUSTOMER_WITHDREW">Cliente desistiu</option><option value="EXTERNAL_REFERRAL">Encaminhamento externo</option>
      </select></label>
      <label>Encerrados a partir de <input type="datetime-local" value={resolvedFilters.resolvedFrom} disabled={mutationBusy||refreshing}
        onChange={event=>setResolvedFilters(current=>({...current,resolvedFrom:event.target.value}))}/></label>
      <label>Encerrados antes de <input type="datetime-local" value={resolvedFilters.resolvedBefore} disabled={mutationBusy||refreshing}
        onChange={event=>setResolvedFilters(current=>({...current,resolvedBefore:event.target.value}))}/></label>
      <button type="button" disabled={mutationBusy||refreshing||Boolean(operationLock.current)} onClick={()=>void applyResolvedFilters()}>Aplicar filtros dos encerrados</button>
      <button type="button" disabled={mutationBusy||refreshing||Object.values(resolvedFilters).every(value=>value==="")}
        onClick={()=>{setResolvedFilters(emptyResolvedFilters);void applyResolvedFilters(emptyResolvedFilters)}}>Limpar filtros dos encerrados</button>
      {resolvedFiltersDirty&&<p role="status">Há alterações de filtro ainda não aplicadas.</p>}
    </fieldset>
    {resolved?.items.length===0&&<p>Nenhum atendimento encerrado.</p>}
    <ul className="handoff-list">{resolved?.items.map(item=><li key={item.id} className={selected?.id===item.id?"is-selected":undefined}><button type="button" aria-pressed={selected?.id===item.id} aria-label={`${item.contactName??"Contato"} · Encerrado`} disabled={actionsDisabled||mutationBusy} onClick={()=>open(item)}><strong>{item.contactName??"Contato"}</strong><span>{dispositionLabel(item.disposition)} · {item.reason}</span><span>{item.resolvedByDisplayName?`Encerrado por ${item.resolvedByDisplayName}`:"Encerrado"}</span><time dateTime={item.resolvedAt}>{new Date(item.resolvedAt).toLocaleString("pt-BR")}</time><span className={`priority priority-${item.priority.toLowerCase()}`}>{priorityLabel(item.priority)}</span></button></li>)}</ul>
    {resolved?.nextCursor&&<button type="button" disabled={loadingResolvedPage||actionsDisabled||mutationBusy} onClick={loadResolvedPage}>{loadingResolvedPage?"Carregando encerrados…":"Carregar mais encerrados"}</button>}
    </div>}</aside><div className="conversation-pane" aria-live="polite" aria-busy={Boolean(selected&&!detail)}>
    {!selected && <div className="conversation-empty"><strong>Selecione um atendimento</strong><span>Escolha uma conversa da fila ou dos seus atendimentos ativos.</span></div>}
    {selected && !detail && <p>Carregando conversa…</p>}
    {detail && <article className="conversation"><header className="conversation-header"><div className="contact-avatar" aria-hidden="true">{(detail.displayName ?? "C").slice(0,1).toUpperCase()}</div><div><h3>{detail.displayName ?? "Conversa"}</h3><p>Estado: {detail.automationStatus}</p>{selected&&"resolvedAt" in selected&&<p>{dispositionLabel(selected.disposition)} · {selected.reason}</p>}</div></header><div className="conversation-actions">
      {selected&&"resolvedAt" in selected&&selected.reopenTarget&&!reopenOpen&&<button type="button" disabled={reopening||actionsDisabled||mutationBusy} onClick={()=>setReopenOpen(true)}>Reabrir atendimento</button>}
      {selected&&"resolvedAt" in selected&&selected.reopenTarget&&reopenOpen&&<fieldset><legend>Confirmar reabertura</legend><p>O atendimento voltará à fila humana. A automação não será reativada.</p>
        <label>Motivo <select aria-label="Motivo da reabertura" value={reopenReason} disabled={reopening} onChange={event=>{setReopenReason(event.target.value as ""|ReopenReason);reopenIntent.current=undefined}}>
          <option value="">Selecione um motivo</option><option value="FOLLOW_UP_REQUIRED">Acompanhamento necessário</option><option value="PREMATURE_CLOSURE">Encerramento prematuro</option><option value="NEW_INFORMATION">Nova informação</option><option value="OPERATIONAL_CORRECTION">Correção operacional</option>
        </select></label><button type="button" disabled={reopening||actionsDisabled||!reopenReason} onClick={reopen}>{reopening?"Reabrindo…":"Confirmar reabertura"}</button>
        <button type="button" disabled={reopening} onClick={cancelReopen}>Cancelar reabertura</button></fieldset>}
      {detail.allowedActions.includes("CLAIM_HANDOFF") && detail.claimTarget && <button type="button" disabled={claiming || actionsDisabled} onClick={claim}>{claiming ? "Assumindo…" : "Assumir atendimento"}</button>}
      {detail.allowedActions.includes("RESOLVE_HANDOFF") && detail.resolveTarget&&!resolveOpen && <button type="button" disabled={resolving || actionsDisabled} onClick={()=>setResolveOpen(true)}>Encerrar atendimento</button>}
      {detail.allowedActions.includes("RESOLVE_HANDOFF")&&detail.resolveTarget&&resolveOpen&&<fieldset><legend>Confirmar encerramento</legend>
        <label>Resultado <select aria-label="Disposição do encerramento" value={resolveDisposition} disabled={resolving} onChange={event=>{setResolveDisposition(event.target.value as ""|ResolveDisposition);resolveIntent.current=undefined}}>
          <option value="">Selecione um resultado</option><option value="RESOLVED">Resolvido</option><option value="DUPLICATE">Atendimento duplicado</option><option value="CUSTOMER_WITHDREW">Cliente desistiu</option><option value="EXTERNAL_REFERRAL">Encaminhado externamente</option>
        </select></label><button type="button" disabled={resolving||actionsDisabled||!resolveDisposition} onClick={resolve}>{resolving?"Encerrando…":"Confirmar encerramento"}</button>
        <button type="button" disabled={resolving} onClick={cancelResolve}>Cancelar encerramento</button></fieldset>}
      {detail.allowedActions.includes("REQUEUE_HANDOFF") && detail.requeueTarget && <button type="button" disabled={requeueing || actionsDisabled} onClick={requeue}>{requeueing ? "Devolvendo…" : "Devolver à fila"}</button>}
      {canSupervise&&detail.allowedActions.includes("TAKEOVER_HANDOFF")&&detail.takeoverTarget&&!takeoverConfirmOpen&&<button type="button" disabled={takingOver||actionsDisabled||mutationBusy} onClick={()=>setTakeoverConfirmOpen(true)}>Assumir como supervisor</button>}
      {canSupervise&&detail.allowedActions.includes("TAKEOVER_HANDOFF")&&detail.takeoverTarget&&takeoverConfirmOpen&&<fieldset><legend>Confirmar assunção</legend><p>Este atendimento passará para a sua lista ativa. O takeover de supervisão não é condicionado pela escala neste corte e continua sujeito à disponibilidade, à capacidade e à auditoria normal.</p><button type="button" disabled={takingOver||actionsDisabled||mutationBusy} onClick={takeover}>{takingOver?"Assumindo supervisão…":"Confirmar assunção"}</button><button type="button" disabled={takingOver} onClick={()=>{setTakeoverConfirmOpen(false);takeoverIntent.current=undefined}}>Cancelar assunção</button></fieldset>}
      {detail.allowedActions.includes("TRANSFER_HANDOFF")&&detail.transferTarget&&!transferOpen&&<button type="button" disabled={actionsDisabled||mutationBusy||loadingTransferCandidates} aria-busy={loadingTransferCandidates} onClick={openTransfer}>{loadingTransferCandidates?"Carregando atendentes…":"Transferir atendimento"}</button>}
      {transferOpen&&<fieldset><legend>Confirmar transferência</legend><label>Atendente <select aria-label="Atendente de destino" value={transferTargetUserId} disabled={transferring} onChange={event=>{setTransferTargetUserId(event.target.value);transferIntent.current=undefined}}>
        {transferCandidates?.items.map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}</select></label>
        <label>Motivo <select aria-label="Motivo da transferência" value={transferReason} disabled={transferring} onChange={event=>{setTransferReason(event.target.value as ""|TransferReason);transferIntent.current=undefined}}>
          <option value="">Selecione um motivo</option><option value="SHIFT_CHANGE">Troca de turno</option><option value="LOAD_BALANCING">Balanceamento de carga</option><option value="SPECIALIZED_SUPPORT">Suporte especializado</option><option value="OPERATIONAL_CONTINUITY">Continuidade operacional</option>
        </select></label>
        {transferCandidates?.items.length===0?<p>Nenhum atendente elegível está disponível e em turno nesta unidade.</p>:<button type="button" disabled={transferring||!transferTargetUserId||!transferReason} onClick={transfer}>{transferring?"Transferindo…":"Confirmar transferência"}</button>}
        <button type="button" disabled={transferring} onClick={closeTransfer}>Cancelar transferência</button></fieldset>}</div>
      <ol className="message-timeline">{[...(messages?.items ?? [])].reverse().map(message => <li className={`message message-${message.direction.toLowerCase()}`} key={message.id}><div className="message-bubble"><strong>{message.actor}</strong>{message.kind === "TEXT" ? <><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.body}</p><DeliveryLabel message={message} />
        {message.allowedActions.includes("CANCEL_QUEUED") && <button type="button" disabled={cancellingId !== undefined || actionsDisabled} onClick={() => cancelMessage(message.id)}>{cancellingId === message.id ? "Cancelando…" : "Cancelar envio"}</button>}</> : <p>{message.kind} recebido — visualização indisponível (UNTRUSTED)</p>}</div></li>)}</ol>
      {messages?.nextCursor && <button type="button" disabled={actionsDisabled || mutationBusy} onClick={older}>Carregar anteriores</button>}
      {detail.allowedActions.includes("SEND_TEXT") && detail.sendTextTarget && <div className="reply-composer"><label>Mensagem <textarea value={draft} placeholder="Digite sua mensagem…" maxLength={4096} disabled={sending || actionsDisabled} onChange={event => setDraft(event.target.value)} /></label>
        <button type="button" disabled={sending || actionsDisabled || draft.trim().length === 0} onClick={sendText}>{sending ? "Enviando…" : "Enviar"}</button></div>}
    </article>}
    </div></div>
  </section>;
}
