export class InboxRoutingRequiredError extends Error{
  private constructor(readonly statusCode:400|404|409|422,readonly code:string){super(code)}
  static from(error:unknown):never{if(error instanceof InboxRoutingRequiredError)throw error;
    const code=error instanceof Error?error.message:"";
    if(["INVALID_PAGE_CURSOR","INVALID_PAGE_LIMIT","INVALID_INBOUND_ROUTING_PAGE","INVALID_INBOUND_ROUTING_CURSOR",
      "INVALID_INBOUND_ROUTING_REQUEST","INVALID_IDEMPOTENCY_KEY"].includes(code))throw new InboxRoutingRequiredError(400,"INVALID_REQUEST");
    if(code==="INBOUND_ROUTING_NOT_FOUND")throw new InboxRoutingRequiredError(404,"RESOURCE_NOT_FOUND");
    if(["INBOUND_ROUTING_CONFLICT","INBOUND_ROUTING_IDEMPOTENCY_CONFLICT"].includes(code))
      throw new InboxRoutingRequiredError(409,"ROUTING_CONFLICT");
    if(code==="INBOUND_ROUTING_TARGET_INVALID")throw new InboxRoutingRequiredError(422,"ROUTING_TARGET_INVALID");throw error;}
}
