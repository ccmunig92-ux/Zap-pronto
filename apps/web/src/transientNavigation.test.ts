import {describe,expect,it,vi} from "vitest";
import {retryTransientNavigation} from "./transientNavigation.js";

describe("retryTransientNavigation",()=>{
  it("retries an external Playwright timeout up to the third attempt",async()=>{
    const timeout=Object.assign(new Error("page.goto: Timeout 30000ms exceeded"),{name:"TimeoutError"});
    const operation=vi.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED")).mockResolvedValue("ok");
    const wait=vi.fn().mockResolvedValue(undefined);
    await expect(retryTransientNavigation(operation,wait,true)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);expect(wait.mock.calls).toEqual([[2_000],[4_000]]);
  });

  it("does not retry local or non-transient failures",async()=>{
    const transient=Object.assign(new Error("page.goto: Timeout 30000ms exceeded"),{name:"TimeoutError"});
    const local=vi.fn().mockRejectedValue(transient),nonTransient=vi.fn().mockRejectedValue(new Error("certificate rejected"));
    const wait=vi.fn().mockResolvedValue(undefined);
    await expect(retryTransientNavigation(local,wait,false)).rejects.toBe(transient);
    await expect(retryTransientNavigation(nonTransient,wait,true)).rejects.toThrow("certificate rejected");
    expect(local).toHaveBeenCalledTimes(1);expect(nonTransient).toHaveBeenCalledTimes(1);expect(wait).not.toHaveBeenCalled();
  });
});
