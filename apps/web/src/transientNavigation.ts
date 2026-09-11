export function isTransientNavigationFailure(caught:unknown):boolean{
  return caught instanceof Error&&(caught.name==="TimeoutError"
    ||/(?:ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|Timeout .* exceeded)/u.test(caught.message));
}

export async function retryTransientNavigation<T>(
  operation:()=>Promise<T>,
  wait:(delayMs:number)=>Promise<void>,
  external:boolean,
):Promise<T>{
  const attempts=external?3:1;
  for(let attempt=1;attempt<=attempts;attempt+=1){
    try{return await operation()}catch(caught){
      if(!isTransientNavigationFailure(caught)||attempt===attempts)throw caught;
      await wait(attempt*2_000);
    }
  }
  throw new Error("NAVIGATION_RETRY_EXHAUSTED");
}
