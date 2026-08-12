export class InboxConversationRequestError extends Error{
  constructor(readonly statusCode:number,readonly code:string){super(code);this.name="InboxConversationRequestError"}
  static from(error:unknown):never{if(error instanceof InboxConversationRequestError)throw error;const code=error instanceof Error?error.message:"";
    if(["INVALID_CONVERSATION_ID","INVALID_MESSAGE_ID","INVALID_PAGE_LIMIT","INVALID_PAGE_CURSOR","INVALID_INBOX_CONVERSATION_REQUEST","INVALID_MESSAGE_BODY","INVALID_EXPECTED_VERSION","INVALID_IDEMPOTENCY_KEY"].includes(code))
      throw new InboxConversationRequestError(400,"INVALID_REQUEST");
    if(["INBOX_CONVERSATION_NOT_FOUND","CONVERSATION_NOT_FOUND"].includes(code))throw new InboxConversationRequestError(404,"RESOURCE_NOT_FOUND");
    if(["MESSAGE_SEND_FORBIDDEN","MESSAGE_CANCEL_FORBIDDEN"].includes(code))throw new InboxConversationRequestError(403,"FORBIDDEN");
    if(["MESSAGE_IDEMPOTENCY_CONFLICT","MESSAGE_SEND_STATE_CONFLICT","MESSAGE_SEND_VERSION_CONFLICT","MESSAGE_SEND_TARGET_INACTIVE"].includes(code))
      throw new InboxConversationRequestError(409,"MESSAGE_SEND_CONFLICT");
    if(["MESSAGE_CANCEL_IDEMPOTENCY_CONFLICT","MESSAGE_CANCEL_STATE_CONFLICT","MESSAGE_CANCEL_ALREADY_CLAIMED","MESSAGE_CANCEL_TARGET_INACTIVE"].includes(code))
      throw new InboxConversationRequestError(409,"MESSAGE_CANCEL_CONFLICT");throw error;}
  static notFound(){return new InboxConversationRequestError(404,"RESOURCE_NOT_FOUND")}
}
