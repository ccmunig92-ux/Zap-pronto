// Generated from the canonical OpenAPI document. Do not edit manually.
export interface paths {
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getHealthLive"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getHealthReady"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCurrentUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/invitations/options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getUserInvitationOptions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAdministrativeInvitations"];
        put?: never;
        post: operations["createUserInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAdministrativeUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/memberships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listUnitMemberships"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/{userId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["changeAdministrativeUserStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/{userId}/memberships/{unitId}/lifecycle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["changeUnitMembership"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/invitations/{invitationId}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeUserInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/invitations/{invitationId}/reissue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reissueUserInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/invitations/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["acceptUserInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/resolved": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listResolvedInboxHandoffs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listActiveInboxHandoffs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/supervised": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listSupervisedInboxHandoffs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listHandoffs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs/{handoffId}/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["claimHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs/{handoffId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["resolveInboxHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs/{handoffId}/requeue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["requeueInboxHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs/{handoffId}/reopen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reopenInboxHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs/{handoffId}/transfer-candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listInboxHandoffTransferCandidates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs/{handoffId}/transfer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["transferInboxHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/handoffs/{handoffId}/takeover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["takeoverInboxHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/routing-required": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listRoutingRequired"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/routing-required/{receiptId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["resolveRoutingRequired"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/conversations/{conversationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getInboxConversation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/conversations/{conversationId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listInboxConversationMessages"];
        put?: never;
        post: operations["sendHumanTextMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/conversations/{conversationId}/messages/{messageId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelHumanTextMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getInboxAvailability"];
        put?: never;
        post: operations["setInboxAvailability"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/team-availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listInboxTeamAvailability"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/sla-alerts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listInboxSlaAlerts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/sla-alerts/{handoffId}/acknowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["acknowledgeInboxSlaAlert"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/sla-policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getUnitSlaPolicy"];
        put?: never;
        post: operations["setUnitSlaPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/capacity-alert-policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getUnitCapacityAlertPolicy"];
        put?: never;
        post: operations["setUnitCapacityAlertPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/capacity-alert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getInboxCapacityAlert"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/capacity-alert-episodes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listCapacityAlertEpisodes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/capacity-alert-episodes/{episodeId}/acknowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["acknowledgeCapacityAlertEpisode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/operational-timezone": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getUnitOperationalTimezone"];
        put?: never;
        post: operations["setUnitOperationalTimezone"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/staff-schedules/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listShiftMembers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/staff-schedules/{userId}/effective": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getEffectiveStaffShift"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/staff-schedules/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getStaffSchedule"];
        put?: never;
        post: operations["setStaffSchedule"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/units/{unitId}/assignment-policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getUnitAssignmentPolicy"];
        put?: never;
        post: operations["setUnitAssignmentPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/channel-connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listChannelConnections"];
        put?: never;
        post: operations["setChannelConnectionMetadata"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/inbox/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["streamInboxEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** Health */
        "def-0": {
            /** @enum {string} */
            status: "ok";
        };
        /** ProblemDetails */
        "def-1": {
            type: string;
            title: string;
            status: number;
            detail?: string;
            correlationId: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealthLive: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "ok";
                    };
                };
            };
        };
    };
    getHealthReady: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "ok";
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getCurrentUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        user: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                        };
                        tenant: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                        };
                        memberships: {
                            /** Format: uuid */
                            unitId: string;
                            unitCode: string;
                            unitName: string;
                            /** AppRole */
                            role: "TENANT_ADMIN" | "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                        }[];
                        grants: ({
                            permission: "tenant.users.manage" | "unit.members.manage" | "handoff.read" | "handoff.history.read" | "handoff.claim" | "handoff.resolve" | "handoff.reopen" | "handoff.requeue" | "handoff.transfer" | "handoff.takeover" | "conversation.read" | "conversation.supervise" | "quote.read" | "quote.review" | "quote.publish" | "medical_order.read" | "medical_order.review" | "inbound.routing.read" | "inbound.routing.resolve" | "message.send" | "message.cancel" | "sla_alert.read" | "sla_alert.manage" | "sla_alert.acknowledge" | "sla_policy.read" | "sla_policy.manage" | "availability.supervise" | "unit_timezone.read" | "unit_timezone.manage" | "shift.read" | "shift.manage" | "channel_connections.read" | "channel_connections.manage";
                            /** @enum {string} */
                            scope: "TENANT";
                        } | {
                            permission: "tenant.users.manage" | "unit.members.manage" | "handoff.read" | "handoff.history.read" | "handoff.claim" | "handoff.resolve" | "handoff.reopen" | "handoff.requeue" | "handoff.transfer" | "handoff.takeover" | "conversation.read" | "conversation.supervise" | "quote.read" | "quote.review" | "quote.publish" | "medical_order.read" | "medical_order.review" | "inbound.routing.read" | "inbound.routing.resolve" | "message.send" | "message.cancel" | "sla_alert.read" | "sla_alert.manage" | "sla_alert.acknowledge" | "sla_policy.read" | "sla_policy.manage" | "availability.supervise" | "unit_timezone.read" | "unit_timezone.manage" | "shift.read" | "shift.manage" | "channel_connections.read" | "channel_connections.manage";
                            /** @enum {string} */
                            scope: "UNIT";
                            /** Format: uuid */
                            unitId: string;
                        })[];
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getUserInvitationOptions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        providers: {
                            code: string;
                        }[];
                        units: {
                            /** Format: uuid */
                            id: string;
                            code: string;
                            name: string;
                        }[];
                        roles: ("UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR")[];
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listAdministrativeInvitations: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                            assignments: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                            }[];
                            allowedActions: ("REVOKE" | "REISSUE")[];
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    createUserInvitation: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    email: string;
                    displayName: string;
                    providerCode: string;
                    /** Format: date-time */
                    expiresAt: string;
                    assignments: {
                        /** Format: uuid */
                        unitId: string;
                        role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                    }[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                        };
                        assignments: {
                            /** Format: uuid */
                            unitId: string;
                            unitCode: string;
                            unitName: string;
                            role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                        }[];
                        /** @enum {boolean} */
                        replayed: false;
                        invitationToken: string;
                    } | {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                        };
                        assignments: {
                            /** Format: uuid */
                            unitId: string;
                            unitCode: string;
                            unitName: string;
                            role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                        }[];
                        /** @enum {boolean} */
                        replayed: true;
                    };
                };
            };
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                        };
                        assignments: {
                            /** Format: uuid */
                            unitId: string;
                            unitCode: string;
                            unitName: string;
                            role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                        }[];
                        /** @enum {boolean} */
                        replayed: false;
                        invitationToken: string;
                    } | {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                        };
                        assignments: {
                            /** Format: uuid */
                            unitId: string;
                            unitCode: string;
                            unitName: string;
                            role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                        }[];
                        /** @enum {boolean} */
                        replayed: true;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listAdministrativeUsers: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "ACTIVE" | "BLOCKED" | "REVOKED";
                            version: number;
                            memberships: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "TENANT_ADMIN" | ("UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR");
                                status: "ACTIVE" | "REVOKED";
                                version: number;
                                allowedActions: ("REVOKE" | "REACTIVATE")[];
                            }[];
                            allowedActions: ("BLOCK" | "ACTIVATE" | "REVOKE")[];
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listUnitMemberships: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            userId: string;
                            displayName: string;
                            role: "TENANT_ADMIN" | ("UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR");
                            status: "ACTIVE" | "REVOKED";
                            version: number;
                            allowedActions: ("REVOKE" | "REACTIVATE")[];
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    changeAdministrativeUserStatus: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                userId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    action: "BLOCK" | "ACTIVATE" | "REVOKE";
                    expectedVersion: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        user: {
                            /** Format: uuid */
                            id: string;
                            status: "ACTIVE" | "BLOCKED" | "REVOKED";
                            version: number;
                        };
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    changeUnitMembership: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                userId: string;
                unitId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    operation: "REVOKE" | "REACTIVATE";
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        membership: {
                            /** Format: uuid */
                            userId: string;
                            /** Format: uuid */
                            unitId: string;
                            status: "ACTIVE" | "REVOKED";
                            version: number;
                        };
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    revokeUserInvitation: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                invitationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                            assignments: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                            }[];
                            allowedActions: ("REVOKE" | "REISSUE")[];
                        };
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    reissueUserInvitation: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                invitationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: date-time */
                    expiresAt: string;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                            assignments: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                            }[];
                            allowedActions: ("REVOKE" | "REISSUE")[];
                        };
                        /** @enum {boolean} */
                        replayed: false;
                        invitationToken: string;
                    } | {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                            assignments: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                            }[];
                            allowedActions: ("REVOKE" | "REISSUE")[];
                        };
                        /** @enum {boolean} */
                        replayed: true;
                    };
                };
            };
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                            assignments: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                            }[];
                            allowedActions: ("REVOKE" | "REISSUE")[];
                        };
                        /** @enum {boolean} */
                        replayed: false;
                        invitationToken: string;
                    } | {
                        invitation: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            displayName: string;
                            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
                            /** Format: date-time */
                            expiresAt: string;
                            providerCode: string;
                            assignments: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                            }[];
                            allowedActions: ("REVOKE" | "REISSUE")[];
                        };
                        /** @enum {boolean} */
                        replayed: true;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    acceptUserInvitation: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    invitationToken: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** CurrentUser */
                        currentUser: {
                            user: {
                                /** Format: uuid */
                                id: string;
                                email: string;
                                displayName: string;
                            };
                            tenant: {
                                /** Format: uuid */
                                id: string;
                                name: string;
                            };
                            memberships: {
                                /** Format: uuid */
                                unitId: string;
                                unitCode: string;
                                unitName: string;
                                role: "TENANT_ADMIN" | "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                            }[];
                            grants: ({
                                permission: "tenant.users.manage" | "unit.members.manage" | "handoff.read" | "handoff.history.read" | "handoff.claim" | "handoff.resolve" | "handoff.reopen" | "handoff.requeue" | "handoff.transfer" | "handoff.takeover" | "conversation.read" | "conversation.supervise" | "quote.read" | "quote.review" | "quote.publish" | "medical_order.read" | "medical_order.review" | "inbound.routing.read" | "inbound.routing.resolve" | "message.send" | "message.cancel" | "sla_alert.read" | "sla_alert.manage" | "sla_alert.acknowledge" | "sla_policy.read" | "sla_policy.manage" | "availability.supervise" | "unit_timezone.read" | "unit_timezone.manage" | "shift.read" | "shift.manage" | "channel_connections.read" | "channel_connections.manage";
                                /** @enum {string} */
                                scope: "TENANT";
                            } | {
                                permission: "tenant.users.manage" | "unit.members.manage" | "handoff.read" | "handoff.history.read" | "handoff.claim" | "handoff.resolve" | "handoff.reopen" | "handoff.requeue" | "handoff.transfer" | "handoff.takeover" | "conversation.read" | "conversation.supervise" | "quote.read" | "quote.review" | "quote.publish" | "medical_order.read" | "medical_order.review" | "inbound.routing.read" | "inbound.routing.resolve" | "message.send" | "message.cancel" | "sla_alert.read" | "sla_alert.manage" | "sla_alert.acknowledge" | "sla_policy.read" | "sla_policy.manage" | "availability.supervise" | "unit_timezone.read" | "unit_timezone.manage" | "shift.read" | "shift.manage" | "channel_connections.read" | "channel_connections.manage";
                                /** @enum {string} */
                                scope: "UNIT";
                                /** Format: uuid */
                                unitId: string;
                            })[];
                        };
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listResolvedInboxHandoffs: {
        parameters: {
            query: {
                unitId: string;
                limit?: number;
                cursor?: string;
                priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                disposition?: "LEGACY_UNSPECIFIED" | "RESOLVED" | "DUPLICATE" | "CUSTOMER_WITHDREW" | "EXTERNAL_REFERRAL";
                resolvedFrom?: string;
                resolvedBefore?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            conversationId: string;
                            /** Format: uuid */
                            unitId: string;
                            contactName: string | null;
                            reason: string;
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            /** Format: date-time */
                            resolvedAt: string;
                            disposition: "LEGACY_UNSPECIFIED" | "RESOLVED" | "DUPLICATE" | "CUSTOMER_WITHDREW" | "EXTERNAL_REFERRAL";
                            resolvedByUserId: string | null;
                            resolvedByDisplayName: string | null;
                            version: number;
                            reopenTarget: {
                                /** Format: uuid */
                                handoffId: string;
                                expectedVersion: number;
                            } | null;
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listActiveInboxHandoffs: {
        parameters: {
            query: {
                unitId: string;
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            conversationId: string;
                            /** Format: uuid */
                            serviceCaseId: string;
                            /** Format: uuid */
                            unitId: string;
                            contactName: string | null;
                            reason: string;
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            /** HandoffStatus */
                            status: "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";
                            assignedUserId: string | null;
                            /** Format: date-time */
                            requestedAt: string;
                            queuedAt: string | null;
                            slaDueAt: string | null;
                            slaStatus: ("ON_TRACK" | "DUE_SOON" | "OVERDUE") | null;
                            /** HandoffAutomationStatus */
                            automationStatus: "ACTIVE" | "HUMAN_REQUESTED" | "HUMAN_QUEUED" | "HUMAN_ACTIVE" | "CLOSED";
                            version: number;
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listSupervisedInboxHandoffs: {
        parameters: {
            query: {
                unitId: string;
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            conversationId: string;
                            /** Format: uuid */
                            serviceCaseId: string;
                            /** Format: uuid */
                            unitId: string;
                            contactName: string | null;
                            reason: string;
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            status: "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";
                            assignedUserId: string | null;
                            /** Format: date-time */
                            requestedAt: string;
                            queuedAt: string | null;
                            slaDueAt: string | null;
                            slaStatus: ("ON_TRACK" | "DUE_SOON" | "OVERDUE") | null;
                            automationStatus: "ACTIVE" | "HUMAN_REQUESTED" | "HUMAN_QUEUED" | "HUMAN_ACTIVE" | "CLOSED";
                            version: number;
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listHandoffs: {
        parameters: {
            query: {
                unitId: string;
                limit?: number;
                cursor?: string;
                priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                slaStatus?: "ON_TRACK" | "DUE_SOON" | "OVERDUE";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            conversationId: string;
                            /** Format: uuid */
                            serviceCaseId: string;
                            /** Format: uuid */
                            unitId: string;
                            contactName: string | null;
                            reason: string;
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            status: "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";
                            assignedUserId: string | null;
                            /** Format: date-time */
                            requestedAt: string;
                            queuedAt: string | null;
                            slaDueAt: string | null;
                            slaStatus: ("ON_TRACK" | "DUE_SOON" | "OVERDUE") | null;
                            automationStatus: "ACTIVE" | "HUMAN_REQUESTED" | "HUMAN_QUEUED" | "HUMAN_ACTIVE" | "CLOSED";
                            version: number;
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    claimHandoff: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        handoff: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            conversationId: string;
                            /** Format: uuid */
                            serviceCaseId: string;
                            /** Format: uuid */
                            unitId: string;
                            contactName: string | null;
                            reason: string;
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            status: "REQUESTED" | "QUEUED" | "ACTIVE" | "RESOLVED" | "FAILED" | "CANCELLED";
                            assignedUserId: string | null;
                            /** Format: date-time */
                            requestedAt: string;
                            queuedAt: string | null;
                            slaDueAt: string | null;
                            slaStatus: ("ON_TRACK" | "DUE_SOON" | "OVERDUE") | null;
                            automationStatus: "ACTIVE" | "HUMAN_REQUESTED" | "HUMAN_QUEUED" | "HUMAN_ACTIVE" | "CLOSED";
                            version: number;
                        };
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    resolveInboxHandoff: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    /** HandoffResolutionDisposition */
                    disposition: "RESOLVED" | "DUPLICATE" | "CUSTOMER_WITHDREW" | "EXTERNAL_REFERRAL";
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        handoffId: string;
                        /** Format: uuid */
                        conversationId: string;
                        /** Format: uuid */
                        serviceCaseId: string;
                        handoffVersion: number;
                        conversationVersion: number;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    requeueInboxHandoff: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        handoffId: string;
                        /** Format: uuid */
                        conversationId: string;
                        /** Format: uuid */
                        serviceCaseId: string;
                        handoffVersion: number;
                        conversationVersion: number;
                        serviceCaseVersion: number;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    reopenInboxHandoff: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    /** ReopenReason */
                    reason: "FOLLOW_UP_REQUIRED" | "PREMATURE_CLOSURE" | "NEW_INFORMATION" | "OPERATIONAL_CORRECTION";
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        sourceHandoffId: string;
                        /** Format: uuid */
                        handoffId: string;
                        /** Format: uuid */
                        conversationId: string;
                        /** Format: uuid */
                        serviceCaseId: string;
                        handoffVersion: number;
                        conversationVersion: number;
                        serviceCaseVersion: number;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listInboxHandoffTransferCandidates: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            displayName: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    transferInboxHandoff: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    /** Format: uuid */
                    targetUserId: string;
                    /** TransferReason */
                    reason: "SHIFT_CHANGE" | "LOAD_BALANCING" | "SPECIALIZED_SUPPORT" | "OPERATIONAL_CONTINUITY";
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        handoffId: string;
                        /** Format: uuid */
                        conversationId: string;
                        /** Format: uuid */
                        serviceCaseId: string;
                        /** Format: uuid */
                        targetUserId: string;
                        handoffVersion: number;
                        conversationVersion: number;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    takeoverInboxHandoff: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        handoffId: string;
                        /** Format: uuid */
                        conversationId: string;
                        /** Format: uuid */
                        serviceCaseId: string;
                        /** Format: uuid */
                        previousAssignedUserId: string;
                        handoffVersion: number;
                        conversationVersion: number;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listRoutingRequired: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            receiptId: string;
                            /** Format: uuid */
                            channelConnectionId: string;
                            provider: string;
                            kind: string;
                            /** Format: date-time */
                            occurredAt: string;
                            /** Format: date-time */
                            receivedAt: string;
                            eligibleUnits: {
                                /** Format: uuid */
                                id: string;
                                code: string;
                                name: string;
                            }[];
                            allowedActions: "RESOLVE"[];
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    resolveRoutingRequired: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                receiptId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    unitId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        receiptId: string;
                        /** Format: uuid */
                        unitId: string;
                        /** @enum {string} */
                        routingStatus: "ROUTED";
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getInboxConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        conversationId: string;
                        /** Format: uuid */
                        unitId: string;
                        /** Format: uuid */
                        channelConnectionId: string;
                        status: "OPEN" | "CLOSED" | "ARCHIVED";
                        automationStatus: "ACTIVE" | "HUMAN_REQUESTED" | "HUMAN_QUEUED" | "HUMAN_ACTIVE" | "SUSPENDED";
                        assignedUserId: string | null;
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                        /** Format: date-time */
                        stateChangedAt: string;
                        closedAt: string | null;
                        displayName: string | null;
                        allowedActions: ("CLAIM_HANDOFF" | "SEND_TEXT" | "RESOLVE_HANDOFF" | "REQUEUE_HANDOFF" | "TRANSFER_HANDOFF" | "TAKEOVER_HANDOFF")[];
                        claimTarget: {
                            /** Format: uuid */
                            handoffId: string;
                            expectedVersion: number;
                        } | null;
                        sendTextTarget: {
                            expectedConversationVersion: number;
                        } | null;
                        resolveTarget: {
                            /** Format: uuid */
                            handoffId: string;
                            expectedVersion: number;
                        } | null;
                        requeueTarget: {
                            /** Format: uuid */
                            handoffId: string;
                            expectedVersion: number;
                        } | null;
                        transferTarget: {
                            /** Format: uuid */
                            handoffId: string;
                            expectedVersion: number;
                        } | null;
                        takeoverTarget: {
                            /** Format: uuid */
                            handoffId: string;
                            expectedVersion: number;
                        } | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listInboxConversationMessages: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                before?: string;
            };
            header?: never;
            path: {
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            direction: "INBOUND" | "OUTBOUND";
                            actor: "CUSTOMER" | "HERMES" | "HUMAN" | "SYSTEM";
                            body: string | null;
                            kind: "TEXT" | "AUDIO" | "IMAGE" | "DOCUMENT" | "INTERACTIVE" | "UNKNOWN";
                            trust: "UNTRUSTED" | null;
                            deliveryStatus: "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "CANCELLED" | null;
                            allowedActions: "CANCEL_QUEUED"[];
                            /** Format: date-time */
                            createdAt: string;
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    sendHumanTextMessage: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                conversationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    kind: "TEXT";
                    body: string;
                    expectedConversationVersion: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        messageId: string;
                        /** Format: uuid */
                        conversationId: string;
                        conversationVersion: number;
                        /** @enum {string} */
                        deliveryStatus: "QUEUED";
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    cancelHumanTextMessage: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                conversationId: string;
                messageId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedConversationVersion: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        messageId: string;
                        /** Format: uuid */
                        conversationId: string;
                        conversationVersion: number;
                        /** @enum {string} */
                        deliveryStatus: "CANCELLED";
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getInboxAvailability: {
        parameters: {
            query: {
                unitId: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        /** Format: uuid */
                        userId: string;
                        /** InboxAvailabilityStatus */
                        status: "AVAILABLE" | "PAUSED" | "OFFLINE";
                        maxActive: number;
                        pauseReason: ("BREAK" | "TRAINING" | "MEETING" | "OTHER_OPERATIONAL") | null;
                        pausedUntil: string | null;
                        activeCount: number;
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    setInboxAvailability: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    unitId: string;
                    status: "AVAILABLE" | "PAUSED" | "OFFLINE";
                    maxActive: number;
                    pauseReason?: ("BREAK" | "TRAINING" | "MEETING" | "OTHER_OPERATIONAL") | null;
                    pausedUntil?: string | null;
                    expectedVersion: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        /** Format: uuid */
                        userId: string;
                        status: "AVAILABLE" | "PAUSED" | "OFFLINE";
                        maxActive: number;
                        pauseReason: ("BREAK" | "TRAINING" | "MEETING" | "OTHER_OPERATIONAL") | null;
                        pausedUntil: string | null;
                        activeCount: number;
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listInboxTeamAvailability: {
        parameters: {
            query: {
                unitId: string;
                limit?: number;
                status?: "AVAILABLE" | "PAUSED" | "OFFLINE";
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            userId: string;
                            displayName: string;
                            role: "TENANT_ADMIN" | "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT";
                            status: "AVAILABLE" | "PAUSED" | "OFFLINE";
                            maxActive: number;
                            activeCount: number;
                            remainingCapacity: number;
                            pauseReason: ("BREAK" | "TRAINING" | "MEETING" | "OTHER_OPERATIONAL") | null;
                            pausedUntil: string | null;
                            /** Format: date-time */
                            updatedAt: string;
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listInboxSlaAlerts: {
        parameters: {
            query: {
                unitId: string;
                limit?: number;
                severity?: "MISSING_SLA" | "DUE_SOON" | "OVERDUE";
                priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            handoffId: string;
                            /** Format: uuid */
                            unitId: string;
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            severity: "MISSING_SLA" | "DUE_SOON" | "OVERDUE";
                            slaDueAt: string | null;
                            /** Format: date-time */
                            queuedAt: string;
                            ageSeconds: number;
                            availableCapacity: number;
                            acknowledgedAt: string | null;
                            version: number;
                        }[];
                        nextCursor?: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    acknowledgeInboxSlaAlert: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                handoffId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        handoffId: string;
                        /** Format: date-time */
                        acknowledgedAt: string;
                        /** Format: uuid */
                        acknowledgedByUserId: string;
                        version: number;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getUnitSlaPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        version: number;
                        /** Format: date-time */
                        effectiveAt: string;
                        targets: {
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            targetMinutes: number;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    setUnitSlaPolicy: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    targets: {
                        priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                        targetMinutes: number;
                    }[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        version: number;
                        /** Format: date-time */
                        effectiveAt: string;
                        targets: {
                            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
                            targetMinutes: number;
                        }[];
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getUnitCapacityAlertPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        /** CapacityAlertPolicyMode */
                        mode: "DISABLED" | "ENABLED";
                        minimumQueued: number | null;
                        sustainedMinutes: number | null;
                        version: number;
                        updatedAt: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    setUnitCapacityAlertPolicy: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    mode: "DISABLED" | "ENABLED";
                    minimumQueued: number;
                    sustainedMinutes: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        mode: "DISABLED" | "ENABLED";
                        minimumQueued: number | null;
                        sustainedMinutes: number | null;
                        version: number;
                        updatedAt: string | null;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getInboxCapacityAlert: {
        parameters: {
            query: {
                unitId: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        policyVersion: number;
                        enabled: boolean;
                        minimumQueued: number | null;
                        sustainedMinutes: number | null;
                        queuedCount: number;
                        sustainedQueuedCount: number;
                        oldestQueuedAt: string | null;
                        availableCapacity: number;
                        state: "ACTIVE" | "CLEAR";
                        /** Format: date-time */
                        evaluatedAt: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listCapacityAlertEpisodes: {
        parameters: {
            query: {
                unitId: string;
                status?: "OPEN" | "ACKNOWLEDGED" | "ESCALATED" | "RESOLVED";
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            episodeId: string;
                            /** Format: uuid */
                            unitId: string;
                            policyVersion: number;
                            status: "OPEN" | "ACKNOWLEDGED" | "ESCALATED" | "RESOLVED";
                            /** Format: date-time */
                            openedAt: string;
                            /** Format: date-time */
                            lastEvaluatedAt: string;
                            /** Format: date-time */
                            cooldownUntil: string;
                            escalationLevel: number;
                            acknowledgedAt: string | null;
                            acknowledgedByUserId: string | null;
                            acknowledgementReason: string | null;
                            escalatedAt: string | null;
                            closedAt: string | null;
                            version: number;
                            recipientCount: number;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    acknowledgeCapacityAlertEpisode: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                episodeId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        episodeId: string;
                        status: "OPEN" | "ACKNOWLEDGED" | "ESCALATED" | "RESOLVED";
                        /** Format: date-time */
                        acknowledgedAt: string;
                        /** Format: uuid */
                        acknowledgedByUserId: string;
                        version: number;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getUnitOperationalTimezone: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        timeZone: string;
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    setUnitOperationalTimezone: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    timeZone: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        timeZone: string;
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listShiftMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            userId: string;
                            displayName: string;
                            role: "TENANT_ADMIN" | "UNIT_MANAGER" | "SUPERVISOR" | "ATTENDANT" | "AUDITOR";
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getEffectiveStaffShift: {
        parameters: {
            query?: {
                at?: string;
            };
            header?: never;
            path: {
                unitId: string;
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        /** Format: uuid */
                        userId: string;
                        state: "IN_SHIFT" | "OUTSIDE_SHIFT" | "CLOSED" | "NOT_EFFECTIVE" | "UNCONFIGURED";
                        scheduleVersion: number | null;
                        effectiveFrom: string | null;
                        timeZone: string | null;
                        localDate: string | null;
                        localTime: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getStaffSchedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                unitId: string;
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        /** Format: uuid */
                        userId: string;
                        timeZone: string;
                        /** Format: date */
                        effectiveFrom: string;
                        weeklySlots: {
                            weekday: number;
                            start: string;
                            end: string;
                        }[];
                        exceptions: ({
                            /** Format: date */
                            date: string;
                            /** @enum {string} */
                            type: "CLOSED";
                        } | {
                            /** Format: date */
                            date: string;
                            /** @enum {string} */
                            type: "REPLACE";
                            slots: {
                                start: string;
                                end: string;
                            }[];
                        })[];
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    setStaffSchedule: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                unitId: string;
                userId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    /** Format: date */
                    effectiveFrom: string;
                    weeklySlots: {
                        weekday: number;
                        start: string;
                        end: string;
                    }[];
                    exceptions: ({
                        /** Format: date */
                        date: string;
                        /** @enum {string} */
                        type: "CLOSED";
                    } | {
                        /** Format: date */
                        date: string;
                        /** @enum {string} */
                        type: "REPLACE";
                        slots: {
                            start: string;
                            end: string;
                        }[];
                    })[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        /** Format: uuid */
                        userId: string;
                        timeZone: string;
                        /** Format: date */
                        effectiveFrom: string;
                        weeklySlots: {
                            weekday: number;
                            start: string;
                            end: string;
                        }[];
                        exceptions: ({
                            /** Format: date */
                            date: string;
                            /** @enum {string} */
                            type: "CLOSED";
                        } | {
                            /** Format: date */
                            date: string;
                            /** @enum {string} */
                            type: "REPLACE";
                            slots: {
                                start: string;
                                end: string;
                            }[];
                        })[];
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    getUnitAssignmentPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        mode: "OBSERVE" | "ENFORCE_NEW_ASSIGNMENTS";
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                        readiness: {
                            operationalMembers: number;
                            effectiveSchedules: number;
                            missingSchedules: number;
                            timezoneConfigured: boolean;
                            ready: boolean;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    setUnitAssignmentPolicy: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                unitId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedVersion: number;
                    mode: "OBSERVE" | "ENFORCE_NEW_ASSIGNMENTS";
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        unitId: string;
                        mode: "OBSERVE" | "ENFORCE_NEW_ASSIGNMENTS";
                        version: number;
                        /** Format: date-time */
                        updatedAt: string;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    listChannelConnections: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            type: "WHATSAPP";
                            scope: "CORPORATE" | "SINGLE_UNIT" | "SELECTED_UNITS";
                            displayName?: string;
                            wabaId: string;
                            phoneNumberId: string;
                            status: string;
                            secretConfigured: boolean;
                            unitIds: string[];
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    setChannelConnectionMetadata: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    id?: string;
                    scope: "CORPORATE" | "SINGLE_UNIT" | "SELECTED_UNITS";
                    displayName?: string;
                    wabaId: string;
                    phoneNumberId: string;
                    status: "ACTIVE" | "DEGRADED" | "DISCONNECTED";
                    secretReference: string;
                    unitIds: string[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        connection: {
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            type: "WHATSAPP";
                            scope: "CORPORATE" | "SINGLE_UNIT" | "SELECTED_UNITS";
                            displayName?: string;
                            wabaId: string;
                            phoneNumberId: string;
                            status: string;
                            secretConfigured: boolean;
                            unitIds: string[];
                        };
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        type: string;
                        title: string;
                        status: number;
                        detail?: string;
                        correlationId: string;
                    };
                };
            };
        };
    };
    streamInboxEvents: {
        parameters: {
            query: {
                unitId: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
