// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPanel, type InboxClient } from "./InboxPanel.js";

const unitId = "40000000-0000-4000-8000-000000000001";
const handoff = { id: "10000000-0000-4000-8000-000000000001", conversationId: "20000000-0000-4000-8000-000000000001", serviceCaseId: "30000000-0000-4000-8000-000000000001", unitId, contactName: "Contato", reason: "HUMAN_REQUESTED", priority: "NORMAL" as const, status: "QUEUED" as const, assignedUserId: null, requestedAt: "2026-08-10T10:00:00.000Z", queuedAt: "2026-08-10T10:00:00.000Z", slaDueAt: null, slaStatus: null, automationStatus: "HUMAN_QUEUED" as const, version: 1 };

function makeClient(subscribeInboxEvents?: InboxClient["subscribeInboxEvents"], listHandoffs = vi.fn().mockResolvedValue({ items: [handoff] })): InboxClient {
  const base = {
    listHandoffs,
    getInboxAvailability: async input => ({ unitId: input, userId: "70000000-0000-4000-8000-000000000001", status: "OFFLINE", maxActive: 5, pauseReason: null, pausedUntil: null, activeCount: 0, version: 1, updatedAt: "2026-08-12T20:00:00.000Z" }),
    setInboxAvailability: async input => ({ unitId: input.unitId, userId: "70000000-0000-4000-8000-000000000001", status: input.status, maxActive: input.maxActive, pauseReason: input.pauseReason ?? null, pausedUntil: null, activeCount: 0, version: input.expectedVersion + 1, updatedAt: "2026-08-12T20:00:00.000Z", replayed: false }),
    listActiveInboxHandoffs: async () => ({ items: [] }), listSupervisedInboxHandoffs: async () => ({ items: [] }), listResolvedInboxHandoffs: async () => ({ items: [] }), listInboxSlaAlerts: async () => ({ items: [] }), acknowledgeInboxSlaAlert: async () => { throw new Error("not called"); },
    claimHandoff: async () => ({}), resolveHandoff: async () => ({}), requeueHandoff: async () => ({}), reopenInboxHandoff: async () => ({}), listInboxHandoffTransferCandidates: async () => ({ items: [] }), transferInboxHandoff: async () => ({}), takeoverInboxHandoff: async () => ({}), sendHumanTextMessage: async () => ({}), cancelHumanTextMessage: async () => ({}),
    getInboxConversation: async () => ({ conversationId: handoff.conversationId, unitId, channelConnectionId: "50000000-0000-4000-8000-000000000001", status: "OPEN", automationStatus: "HUMAN_QUEUED", assignedUserId: null, version: 1, updatedAt: handoff.requestedAt, stateChangedAt: handoff.requestedAt, closedAt: null, displayName: "Contato", allowedActions: [], claimTarget: null, sendTextTarget: null, resolveTarget: null, requeueTarget: null, transferTarget: null, takeoverTarget: null }),
    listInboxConversationMessages: async () => ({ items: [] }), getInboxCapacityAlert: async () => ({ unitId, policyVersion: 1, enabled: false, minimumQueued: 3, sustainedMinutes: 10, queuedCount: 0, sustainedQueuedCount: 0, oldestQueuedAt: null, availableCapacity: 0, state: "CLEAR" as const, evaluatedAt: handoff.requestedAt }),
  } satisfies InboxClient;
  return subscribeInboxEvents ? { ...base, subscribeInboxEvents } : base;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Inbox realtime fallback", () => {
  it("refreshes from an authenticated SSE notification without opening EventSource", async () => {
    let notify!: () => void;
    const subscribe = vi.fn(async (_unit: string, signal: AbortSignal, onChange: () => void) => { notify = onChange; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); });
    const queue = vi.fn().mockResolvedValue({ items: [handoff] });
    render(<InboxPanel client={makeClient(subscribe, queue)} units={[{ id: unitId, name: "Centro" }]} onAuthenticationRequired={() => undefined} onAuthorizationChanged={() => undefined} />);
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    notify();
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("aborts SSE on offline/hidden and reconnects on visible/online", async () => {
    let visibility: "visible" | "hidden" = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const signals: AbortSignal[] = [];
    const subscribe = vi.fn(async (_unit: string, signal: AbortSignal) => { signals.push(signal); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); });
    render(<InboxPanel client={makeClient(subscribe)} units={[{ id: unitId, name: "Centro" }]} onAuthenticationRequired={() => undefined} onAuthorizationChanged={() => undefined} />);
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event("offline")); expect(signals[0]?.aborted).toBe(true);
    visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible"; window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
  });

  it("keeps polling as fallback when the stream fails", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(.5);
    const subscribe = vi.fn().mockRejectedValue(new Error("stream unavailable"));
    const queue = vi.fn().mockResolvedValue({ items: [handoff] });
    render(<InboxPanel client={makeClient(subscribe, queue)} units={[{ id: unitId, name: "Centro" }]} onAuthenticationRequired={() => undefined} onAuthorizationChanged={() => undefined} />);
    await vi.waitFor(() => expect(queue).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
  });
});
