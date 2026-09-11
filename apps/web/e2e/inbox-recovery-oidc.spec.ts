import { expect, test, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import {retryTransientNavigation} from "../src/transientNavigation.js";

const optional = (name:string):string|undefined => process.env[name]?.trim() || undefined;
const enabled = process.env.E2E_OIDC_ENABLED === "true";
const externalMode = optional("E2E_OIDC_TARGET") === "external";
const usernameSelector = optional("E2E_OIDC_USERNAME_SELECTOR") ?? 'input[name="username"]';
const passwordSelector = optional("E2E_OIDC_PASSWORD_SELECTOR") ?? 'input[name="password"]';
const submitSelector = optional("E2E_OIDC_SUBMIT_SELECTOR") ?? 'button[type="submit"]';
type SafeActiveListDiagnostic=Readonly<{status:number;validBody:boolean;fixtureMatchCount:number}>;

function attendantAccount():Readonly<{username:string;password:string;tenant:string}>{
  const username=optional("E2E_ATTENDANT_USERNAME"),password=optional("E2E_ATTENDANT_PASSWORD"),
    tenant=optional("E2E_ATTENDANT_EXPECTED_TENANT");
  if(!username||!password||!tenant)throw new Error("E2E_ATTENDANT_CONFIGURATION_REQUIRED");
  return{username,password,tenant};
}

async function login(page:Page):Promise<void>{
  const account=attendantAccount();await retryTransientNavigation(()=>page.goto("/"),delay=>page.waitForTimeout(delay),externalMode);const enter=page.getByRole("button",{name:"Entrar"});
  await expect(enter).toBeEnabled();const me=page.waitForResponse(response=>new URL(response.url()).pathname==="/v1/me"
    &&response.request().method()==="GET"&&response.status()===200);
  await enter.click();await page.locator(usernameSelector).fill(account.username);
  await page.locator(passwordSelector).fill(account.password);await page.locator(submitSelector).click();
  const response=await me;expect(response.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("banner").getByText(account.tenant,{exact:true})).toBeVisible();
}

async function openInbox(page:Page):Promise<void>{
  const button=page.getByRole("navigation",{name:"Módulos"}).getByRole("button",{name:"Inbox"});
  await expect(button).toBeVisible();await button.click();await expect(button).toHaveAttribute("aria-current","page");
  await expect(page.getByRole("heading",{name:"Inbox"})).toBeVisible();
}

async function responseStatus(response:Promise<PlaywrightResponse>):Promise<number>{return(await response).status()}

async function safeActiveListDiagnostic(response:PlaywrightResponse,contactName:string):Promise<SafeActiveListDiagnostic>{
  const status=response.status();if(status!==200)return{status,validBody:false,fixtureMatchCount:0};
  try{const body:unknown=await response.json();if(!body||typeof body!=="object"||!("items" in body)||!Array.isArray((body as{items?:unknown}).items))return{status,validBody:false,fixtureMatchCount:0};
    return{status,validBody:true,fixtureMatchCount:(body as{items:unknown[]}).items.filter(item=>Boolean(item)&&typeof item==="object"&&(item as{contactName?:unknown}).contactName===contactName).length};
  }catch{return{status,validBody:false,fixtureMatchCount:0}}
}

test.describe("recovery OIDC externo da fixture Inbox",()=>{
  test("requeue próprio precede OFFLINE sem takeover ou transferência",async({page})=>{
    test.skip(!enabled||!externalMode,"Executa somente na recuperação OIDC externa.");
    const runKey=optional("E2E_INBOX_FIXTURE_KEY");
    if(!runKey?.match(/^[0-9]{1,20}-[1-9][0-9]{0,5}$/u))throw new Error("E2E_INBOX_FIXTURE_KEY_REQUIRED");
    const baseUrl=optional("E2E_BASE_URL");let target:URL;try{target=new URL(baseUrl??"")}catch{throw new Error("E2E_BASE_URL_VALID_HTTPS_REQUIRED")}
    if(target.protocol!=="https:"||target.username||target.password||["localhost","127.0.0.1","::1"].includes(target.hostname)){
      throw new Error("E2E_EXTERNAL_HARNESS_PUBLIC_ORIGIN_REQUIRED");
    }

    const contactName=`E2E Inbox ${runKey}`;
    await login(page);await openInbox(page);
    const activeSnapshot=page.waitForResponse(response=>response.request().method()==="GET"&&new URL(response.url()).pathname==="/v1/inbox/active");
    const queueSnapshot=page.waitForResponse(response=>response.request().method()==="GET"&&new URL(response.url()).pathname==="/v1/inbox/handoffs");
    await page.getByRole("button",{name:"Atualizar Inbox"}).click();
    const activeDiagnostic=await safeActiveListDiagnostic(await activeSnapshot,contactName);
    expect(await responseStatus(queueSnapshot)).toBe(200);
    if(activeDiagnostic.status!==200||!activeDiagnostic.validBody||activeDiagnostic.fixtureMatchCount>1)throw new Error("E2E_INBOX_ACTIVE_SNAPSHOT_INVALID");
    const active=page.getByRole("button",{name:`${contactName} · Em atendimento`});
    const queued=page.getByRole("button",{name:`${contactName} · NORMAL`});
    const mutations:string[]=[];
    let didRequeue=false;
    page.on("request",request=>{const path=new URL(request.url()).pathname;
      if(path.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${path}`)});

    if(activeDiagnostic.fixtureMatchCount===1){
      await expect(active).toBeVisible();await active.click();await expect(page.getByText("Estado: HUMAN_ACTIVE")).toBeVisible();
      const requeueButton=page.getByRole("button",{name:"Devolver à fila"});
      if(!await requeueButton.isVisible())throw new Error("E2E_INBOX_RECOVERY_NOT_OWNED");
      const requeue=page.waitForResponse(response=>response.request().method()==="POST"
        &&new URL(response.url()).pathname.endsWith("/requeue"));
      await requeueButton.click();expect(await responseStatus(requeue)).toBe(200);didRequeue=true;await expect(queued).toBeVisible();
    }else await expect(active).toHaveCount(0);

    const offline=page.getByText(/Status:\s*Offline/u);
    await expect(page.getByText(/Status:\s*(?:Disponível|Pausado|Offline)/u)).toBeVisible();
    if(!await offline.isVisible()){
      await page.getByRole("button",{name:"Alterar disponibilidade"}).click();
      await page.getByLabel("Status da disponibilidade").selectOption("OFFLINE");
      const availability=page.waitForResponse(response=>response.request().method()==="POST"
        &&new URL(response.url()).pathname==="/v1/inbox/availability");
      await page.getByRole("button",{name:"Confirmar alteração"}).click();expect(await responseStatus(availability)).toBe(200);
    }
    await retryTransientNavigation(()=>page.reload(),delay=>page.waitForTimeout(delay),externalMode);await openInbox(page);await expect(offline).toBeVisible();
    expect(mutations.filter(value=>value.endsWith("/requeue"))).toHaveLength(didRequeue?1:0);
    expect(mutations.filter(value=>value==="POST /v1/inbox/availability").length).toBeLessThanOrEqual(1);
    expect(mutations.some(value=>value.endsWith("/takeover")||value.endsWith("/transfer"))).toBe(false);
  });
});
