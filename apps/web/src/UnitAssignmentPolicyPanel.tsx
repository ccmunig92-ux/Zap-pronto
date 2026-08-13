import {useEffect,useRef,useState} from "react";
import {ApiProblem,AuthenticationRequired} from "@zap-pronto/api-client";
import type {AssignmentPolicyMode,SetUnitAssignmentPolicyResponse,UnitAssignmentPolicy} from "@zap-pronto/contracts";

export interface UnitAssignmentPolicyClient{
  getUnitAssignmentPolicy(unitId:string):Promise<UnitAssignmentPolicy>;
  setUnitAssignmentPolicy(unitId:string,input:{expectedVersion:number;mode:AssignmentPolicyMode},key:string):Promise<SetUnitAssignmentPolicyResponse>;
}
const key=()=>crypto.randomUUID();
export function UnitAssignmentPolicyPanel({client,units,manageableUnitIds,onAuthenticationRequired=()=>undefined,onAuthorizationChanged=()=>undefined,onNavigationStateChange}:{
  client:UnitAssignmentPolicyClient;units:readonly{id:string;name:string}[];manageableUnitIds:readonly string[];
  onAuthenticationRequired?:()=>void;onAuthorizationChanged?:()=>void;onNavigationStateChange?:(state:{blocked:boolean;dirty:boolean})=>void;
}){
  const[unitId,setUnitId]=useState(units[0]?.id??""),[policy,setPolicy]=useState<UnitAssignmentPolicy>(),[mode,setMode]=useState<AssignmentPolicyMode>("OBSERVE");
  const[loading,setLoading]=useState(false),[submitting,setSubmitting]=useState(false),[confirming,setConfirming]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>();
  const intent=useRef<{unitId:string;expectedVersion:number;mode:AssignmentPolicyMode;key:string}|undefined>(undefined),generation=useRef(0),mutationLock=useRef(false);
  const canManage=manageableUnitIds.includes(unitId),dirty=!!policy&&mode!==policy.mode,blocked=loading||submitting;
  useEffect(()=>onNavigationStateChange?.({blocked,dirty}),[blocked,dirty,onNavigationStateChange]);
  useEffect(()=>()=>onNavigationStateChange?.({blocked:false,dirty:false}),[onNavigationStateChange]);
  function message(caught:unknown){
    if(caught instanceof AuthenticationRequired){onAuthenticationRequired();return}
    if(caught instanceof ApiProblem){if(caught.problem.status===403){onAuthorizationChanged();return}if(caught.problem.detail==="SHIFT_ENFORCEMENT_NOT_READY")return"Não é possível ativar a exigência: configure o fuso e uma escala vigente para todos os integrantes operacionais.";
      if(caught.problem.status===409)return"A política mudou em outra sessão. Recarregue e tente novamente."}
    return"Não foi possível atualizar a política de turnos.";
  }
  async function load(id=unitId){if(!id)return;const g=++generation.current;setLoading(true);setError(undefined);setNotice(undefined);setConfirming(false);intent.current=undefined;
    try{const value=await client.getUnitAssignmentPolicy(id);if(g===generation.current){setPolicy(value);setMode(value.mode)}}catch(caught){if(g===generation.current)setError(message(caught))}finally{if(g===generation.current)setLoading(false)}}
  useEffect(()=>{void load(unitId)},[unitId]);
  function changeMode(next:AssignmentPolicyMode){setMode(next);setError(undefined);setNotice(undefined);intent.current=undefined}
  async function save(){if(!policy||!dirty||submitting||mutationLock.current)return;mutationLock.current=true;const current=intent.current?.unitId===unitId&&intent.current.expectedVersion===policy.version&&intent.current.mode===mode?intent.current:{unitId,expectedVersion:policy.version,mode,key:key()};intent.current=current;setSubmitting(true);setError(undefined);
    try{const saved=await client.setUnitAssignmentPolicy(unitId,{expectedVersion:policy.version,mode},current.key),value=await client.getUnitAssignmentPolicy(unitId);setPolicy(value);setMode(value.mode);setConfirming(false);setNotice(saved.mode==="ENFORCE_NEW_ASSIGNMENTS"?"Exigência de turno ativada.":"Política mantida em observação.");intent.current=undefined}catch(caught){setError(message(caught))}finally{mutationLock.current=false;setSubmitting(false)}}
  return <section aria-labelledby="assignment-policy-title"><div inert={confirming?true:undefined} aria-hidden={confirming?true:undefined}><h3 id="assignment-policy-title">Política de novas atribuições</h3>
    <label>Unidade da política<select value={unitId} disabled={blocked} onChange={event=>setUnitId(event.target.value)}>{units.map(unit=><option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
    <button type="button" disabled={blocked} onClick={()=>void load()}>Atualizar política</button>{notice&&<p role="status">{notice}</p>}{loading?<p>Carregando…</p>:error&&!policy?<p role="alert">{error}</p>:policy&&<>
      <p>Modo vigente: {policy.mode==="OBSERVE"?"Somente observar":"Exigir turno em novas atribuições"}. Versão {policy.version}.</p>
      <p>{policy.readiness.effectiveSchedules} de {policy.readiness.operationalMembers} integrantes operacionais possuem escala vigente; {policy.readiness.missingSchedules} pendentes.</p>{!policy.readiness.timezoneConfigured&&<p>Configure primeiro o fuso operacional da unidade.</p>}
      {canManage?<><label>Aplicação<select value={mode} disabled={blocked} onChange={event=>changeMode(event.target.value as AssignmentPolicyMode)}><option value="OBSERVE">Somente observar</option><option value="ENFORCE_NEW_ASSIGNMENTS">Exigir turno em novas atribuições</option></select></label>
        <button type="button" disabled={!dirty||blocked} onClick={()=>setConfirming(true)}>Salvar política de atribuição</button></>:<p>Somente gestores podem alterar esta política.</p>}{error&&<p role="alert">{error}</p>}</>}
    </div>{confirming&&policy&&<div role="dialog" aria-modal="true" aria-labelledby="assignment-policy-confirm-title"><h3 id="assignment-policy-confirm-title">Confirmar política de novas atribuições</h3>
      {mode==="ENFORCE_NEW_ASSIGNMENTS"?<p>Novos claims e destinos de transferência exigirão turno vigente. Atendimentos ativos e disponibilidade não serão alterados. O takeover de supervisão não é condicionado pela escala neste corte e continua sujeito à disponibilidade, à capacidade e à auditoria normal.</p>:<p>Novos claims e transferências deixarão de exigir turno. Atendimentos ativos e disponibilidade não serão alterados.</p>}
      {error&&<p role="alert">{error}</p>}<button type="button" disabled={submitting} onClick={()=>void save()}>{submitting?"Salvando…":"Confirmar alteração"}</button><button type="button" disabled={submitting} onClick={()=>{setConfirming(false);intent.current=undefined;setError(undefined)}}>Cancelar</button></div>}</section>
}
