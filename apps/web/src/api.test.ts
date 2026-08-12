// @vitest-environment jsdom
import{afterEach,describe,expect,it,vi}from"vitest";
import{getAccessTokenSingleFlight}from"./api.js";

afterEach(()=>{delete window.__ZAP_PRONTO_AUTH__});

describe("API authentication transport",()=>{
  it("compartilha uma única leitura do token entre requisições concorrentes e libera o próximo ciclo",async()=>{
    let resolve!:(token:string|undefined)=>void;
    const first=new Promise<string|undefined>(done=>{resolve=done});
    const getAccessToken=vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce("token-2");
    window.__ZAP_PRONTO_AUTH__={getAccessToken};
    const left=getAccessTokenSingleFlight();const right=getAccessTokenSingleFlight();
    expect(left).toBe(right);expect(getAccessToken).toHaveBeenCalledTimes(1);
    resolve("token-1");expect(await left).toBe("token-1");await Promise.resolve();
    expect(await getAccessTokenSingleFlight()).toBe("token-2");expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
});
