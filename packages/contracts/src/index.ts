import { Type, type Static } from "@sinclair/typebox";

export const ProblemDetailsSchema = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  detail: Type.Optional(Type.String()),
  correlationId: Type.String(),
}, { $id: "ProblemDetails" });
export type ProblemDetails = Static<typeof ProblemDetailsSchema>;

export const HealthSchema = Type.Object({ status: Type.Literal("ok") }, { $id: "Health" });
export type Health = Static<typeof HealthSchema>;

export const PrincipalSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  tenantId: Type.String({ format: "uuid" }),
  unitIds: Type.Array(Type.String({ format: "uuid" })),
});
export type Principal = Static<typeof PrincipalSchema>;
