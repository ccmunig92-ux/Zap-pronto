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
        get?: never;
        put?: never;
        post: operations["createUserInvitation"];
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
                            permission: "tenant.users.manage" | "unit.members.manage" | "handoff.read" | "handoff.claim" | "quote.read" | "quote.review" | "quote.publish" | "medical_order.read" | "medical_order.review";
                            /** @enum {string} */
                            scope: "TENANT";
                        } | {
                            permission: "tenant.users.manage" | "unit.members.manage" | "handoff.read" | "handoff.claim" | "quote.read" | "quote.review" | "quote.publish" | "medical_order.read" | "medical_order.review";
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
}
