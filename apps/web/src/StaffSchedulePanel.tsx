import { useEffect, useRef, useState } from "react";
import { ApiProblem, AuthenticationRequired } from "@zap-pronto/api-client";
export type ShiftSlot = { weekday: number; start: string; end: string };
export type ShiftException = {
  date: string;
  kind: "CLOSED" | "REPLACE";
  slots: { start: string; end: string }[];
};
export type StaffSchedule = {
  unitId: string;
  userId: string;
  timeZone: string;
  effectiveFrom: string;
  weeklySlots: ShiftSlot[];
  exceptions: ShiftException[];
  version: number;
  updatedAt: string;
};
export type ShiftMember = { userId: string; displayName: string; role: string };
export interface StaffScheduleClient {
  listShiftMembers(unitId: string): Promise<{ items: ShiftMember[] }>;
  getStaffSchedule(
    unitId: string,
    userId: string,
  ): Promise<StaffSchedule | null>;
  setStaffSchedule(
    unitId: string,
    userId: string,
    input: {
      expectedVersion: number;
      effectiveFrom: string;
      weeklySlots: ShiftSlot[];
      exceptions: ShiftException[];
    },
    key: string,
  ): Promise<StaffSchedule>;
}
const emptySlot = (): ShiftSlot => ({ weekday: 1, start: "", end: "" }),
  emptyException = (): ShiftException => ({
    date: "",
    kind: "CLOSED",
    slots: [],
  }),
  date = /^\d{4}-\d{2}-\d{2}$/;
const overlaps = (slots: readonly { start: string; end: string }[]) =>
  slots.some((a, i) =>
    slots.some((b, j) => i < j && a.start < b.end && b.start < a.end),
  );
export function StaffSchedulePanel({
  client,
  units,
  manageableUnitIds,
  onAuthenticationRequired = () => undefined,
  onAuthorizationChanged = () => undefined,
  onNavigationStateChange,
}: {
  client: StaffScheduleClient;
  units: readonly { id: string; name: string }[];
  manageableUnitIds: readonly string[];
  onAuthenticationRequired?: () => void;
  onAuthorizationChanged?: () => void;
  onNavigationStateChange?: (state: {
    blocked: boolean;
    dirty: boolean;
  }) => void;
}) {
  const [unitId, setUnitId] = useState(units[0]?.id ?? ""),
    [members, setMembers] = useState<ShiftMember[]>(),
    [userId, setUserId] = useState(""),
    [schedule, setSchedule] = useState<StaffSchedule | null>(),
    [effectiveFrom, setEffectiveFrom] = useState(""),
    [weeklySlots, setWeeklySlots] = useState<ShiftSlot[]>([]),
    [exceptions, setExceptions] = useState<ShiftException[]>([]),
    [loading, setLoading] = useState(Boolean(unitId)),
    [error, setError] = useState<string>(),
    [notice, setNotice] = useState<string>(),
    [mutationError, setMutationError] = useState<string>(),
    [confirming, setConfirming] = useState(false),
    [saving, setSaving] = useState(false),
    [key, setKey] = useState<string>();
  const generation = useRef(0),
    lock = useRef<symbol | undefined>(undefined),
    dialog = useRef<HTMLDivElement>(null),
    opener = useRef<HTMLElement | null>(null);
  function purge() {
    generation.current++;
    setMembers(undefined);
    setUserId("");
    setSchedule(undefined);
    setEffectiveFrom("");
    setWeeklySlots([]);
    setExceptions([]);
    setError(undefined);
    setNotice(undefined);
    setMutationError(undefined);
    setConfirming(false);
    setSaving(false);
    setKey(undefined);
    lock.current = undefined;
  }
  function invalidate() {
    setKey(undefined);
    setError(undefined);
    setNotice(undefined);
    setMutationError(undefined);
  }
  function access(c: unknown) {
    if (
      c instanceof AuthenticationRequired ||
      (c instanceof ApiProblem && c.problem.status === 401)
    ) {
      purge();
      onAuthenticationRequired();
      return true;
    }
    if (c instanceof ApiProblem && c.problem.status === 403) {
      purge();
      onAuthorizationChanged();
      return true;
    }
    return false;
  }
  function apply(v: StaffSchedule | null) {
    setSchedule(v);
    setEffectiveFrom(v?.effectiveFrom ?? "");
    setWeeklySlots(v?.weeklySlots.map((x) => ({ ...x })) ?? []);
    setExceptions(
      v?.exceptions.map((x) => ({
        ...x,
        slots: x.slots.map((s) => ({ ...s })),
      })) ?? [],
    );
  }
  async function loadMembers(selected = unitId) {
    const g = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await client.listShiftMembers(selected);
      if (g !== generation.current || selected !== unitId) return;
      setMembers(result.items);
      const next = result.items[0]?.userId ?? "";
      setUserId(next);
      if (next) await loadSchedule(selected, next, g);
      else {
        apply(null);
        setLoading(false);
      }
    } catch (c) {
      if (g === generation.current && !access(c)) {
        setError("Não foi possível carregar os integrantes elegíveis.");
        setLoading(false);
      }
    }
  }
  async function loadSchedule(
    unit = unitId,
    user = userId,
    g = ++generation.current,
  ) {
    setLoading(true);
    setError(undefined);
    try {
      const value = await client.getStaffSchedule(unit, user);
      if (g !== generation.current || unit !== unitId) return;
      apply(value);
    } catch (c) {
      if (g !== generation.current) return;
      if (c instanceof ApiProblem && c.problem.status === 404) apply(null);
      else if (!access(c)) setError("Não foi possível carregar a escala.");
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (unitId) void loadMembers(unitId);
    return () => {
      generation.current++;
    };
  }, [client, unitId]);
  const canManage = manageableUnitIds.includes(unitId),
    snapshot = JSON.stringify(
      schedule
        ? {
            effectiveFrom: schedule.effectiveFrom,
            weeklySlots: schedule.weeklySlots,
            exceptions: schedule.exceptions,
          }
        : { effectiveFrom: "", weeklySlots: [], exceptions: [] },
    ),
    draft = JSON.stringify({ effectiveFrom, weeklySlots, exceptions }),
    dirty = canManage && snapshot !== draft,
    blocked = confirming || saving;
  const weeklyValid =
      weeklySlots.length <= 28 &&
      weeklySlots.every(
        (x) => x.weekday >= 1 && x.weekday <= 7 && x.start < x.end,
      ) &&
      ![1, 2, 3, 4, 5, 6, 7].some((day) => {
        const slots = weeklySlots.filter((x) => x.weekday === day);
        return slots.length > 4 || overlaps(slots);
      }),
    exceptionDates = new Set(exceptions.map((x) => x.date)),
    exceptionValid =
      exceptions.length <= 90 &&
      exceptionDates.size === exceptions.length &&
      exceptions.every(
        (x) =>
          date.test(x.date) &&
          x.date >= effectiveFrom &&
          (x.kind === "CLOSED" ||
            (x.slots.length >= 1 &&
              x.slots.length <= 4 &&
              x.slots.every((s) => s.start < s.end) &&
              !overlaps(x.slots))),
      ),
    valid = date.test(effectiveFrom) && weeklyValid && exceptionValid;
  useEffect(
    () =>
      onNavigationStateChange?.({
        blocked,
        dirty: dirty || blocked || Boolean(key),
      }),
    [blocked, dirty, key, onNavigationStateChange],
  );
  useEffect(
    () => () => onNavigationStateChange?.({ blocked: false, dirty: false }),
    [onNavigationStateChange],
  );
  function chooseUnit(v: string) {
    if (blocked) return;
    if (dirty && !window.confirm("Descartar alterações não salvas da escala?"))
      return;
    purge();
    setLoading(true);
    setUnitId(v);
  }
  function chooseMember(v: string) {
    if (blocked) return;
    if (dirty && !window.confirm("Descartar alterações não salvas da escala?"))
      return;
    apply(null);
    setUserId(v);
    void loadSchedule(unitId, v);
  }
  function open() {
    if (!valid || !dirty) return;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMutationError(undefined);
    setConfirming(true);
  }
  function close() {
    if (saving) return;
    setConfirming(false);
    setMutationError(undefined);
    setKey(undefined);
  }
  useEffect(() => {
    if (!confirming) return;
    dialog.current
      ?.querySelector<HTMLElement>("button:not([disabled])")
      ?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled])",
          ) ?? []),
        ];
        if (!controls.length) return;
        const first = controls[0]!,
          last = controls.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [confirming, saving]);
  useEffect(() => {
    if (!confirming && opener.current) {
      opener.current.focus();
      opener.current = null;
    }
  }, [confirming]);
  async function save() {
    if (lock.current || !valid || !userId) return;
    const token = Symbol(),
      g = generation.current,
      capturedUnit = unitId,
      capturedUser = userId,
      retry = key ?? crypto.randomUUID();
    lock.current = token;
    setKey(retry);
    setSaving(true);
    setMutationError(undefined);
    try {
      const value = await client.setStaffSchedule(
        capturedUnit,
        capturedUser,
        {
          expectedVersion: schedule?.version ?? 0,
          effectiveFrom,
          weeklySlots,
          exceptions,
        },
        retry,
      );
      if (
        g !== generation.current ||
        capturedUnit !== unitId ||
        capturedUser !== userId
      )
        return;
      apply(value);
      setKey(undefined);
      setConfirming(false);
      setNotice("Escala semanal atualizada.");
    } catch (c) {
      if (g !== generation.current) return;
      if (access(c)) return;
      if (
        c instanceof ApiProblem &&
        (c.problem.status === 404 || c.problem.status === 409)
      ) {
        setConfirming(false);
        setKey(undefined);
        await loadSchedule(capturedUnit, capturedUser);
        if (
          g === generation.current &&
          capturedUnit === unitId &&
          capturedUser === userId
        )
          setNotice("A escala mudou e os dados foram atualizados.");
      } else setMutationError("Não foi possível salvar a escala.");
    } finally {
      if (lock.current === token) lock.current = undefined;
      if (g === generation.current) setSaving(false);
    }
  }
  const mutateSlots = (fn: (value: ShiftSlot[]) => ShiftSlot[]) => {
      invalidate();
      setWeeklySlots(fn);
    },
    mutateExceptions = (fn: (value: ShiftException[]) => ShiftException[]) => {
      invalidate();
      setExceptions(fn);
    };
  return (
    <section aria-labelledby="staff-schedule-title">
      <div
        inert={confirming ? true : undefined}
        aria-hidden={confirming ? true : undefined}
      >
        <h3 id="staff-schedule-title">Grade semanal e exceções</h3>
        <label>
          Unidade da escala
          <select
            value={unitId}
            disabled={blocked}
            onChange={(e) => chooseUnit(e.target.value)}
          >
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        {members && (
          <label>
            Integrante
            <select
              value={userId}
              disabled={blocked}
              onChange={(e) => chooseMember(e.target.value)}
            >
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName} · {m.role}
                </option>
              ))}
            </select>
          </label>
        )}
        {loading ? (
          <p>Carregando escala…</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : !userId ? (
          <p>Nenhum integrante elegível.</p>
        ) : (
          <>
            {schedule ? (
              <p>
                Fuso da versão: <strong>{schedule.timeZone}</strong> · Versão{" "}
                {schedule.version}.
              </p>
            ) : (
              <p>
                Nenhuma escala configurada. O fuso será definido pelo servidor a
                partir da unidade.
              </p>
            )}
            <p>
              Esta configuração é observacional: não altera disponibilidade,
              atendimentos, responsáveis ou claims e não executa scheduler.
            </p>
            {canManage ? (
              <>
                <label>
                  Vigência a partir de
                  <input
                    type="date"
                    value={effectiveFrom}
                    onChange={(e) => {
                      invalidate();
                      setEffectiveFrom(e.target.value);
                    }}
                  />
                </label>
                <h4>Grade semanal</h4>
                {weeklySlots.map((slot, i) => (
                  <fieldset key={i}>
                    <legend>Período {i + 1}</legend>
                    <label>
                      Dia
                      <select
                        value={slot.weekday}
                        onChange={(e) =>
                          mutateSlots((a) =>
                            a.map((x, j) =>
                              j === i
                                ? { ...x, weekday: Number(e.target.value) }
                                : x,
                            ),
                          )
                        }
                      >
                        {[
                          "Segunda",
                          "Terça",
                          "Quarta",
                          "Quinta",
                          "Sexta",
                          "Sábado",
                          "Domingo",
                        ].map((x, j) => (
                          <option value={j + 1} key={x}>
                            {x}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Início
                      <input
                        type="time"
                        value={slot.start}
                        onChange={(e) =>
                          mutateSlots((a) =>
                            a.map((x, j) =>
                              j === i ? { ...x, start: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      Fim
                      <input
                        type="time"
                        value={slot.end}
                        onChange={(e) =>
                          mutateSlots((a) =>
                            a.map((x, j) =>
                              j === i ? { ...x, end: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        mutateSlots((a) => a.filter((_, j) => j !== i))
                      }
                    >
                      Remover período
                    </button>
                  </fieldset>
                ))}
                <button
                  type="button"
                  disabled={weeklySlots.length >= 28}
                  onClick={() => mutateSlots((a) => [...a, emptySlot()])}
                >
                  Adicionar período
                </button>
                <h4>Exceções</h4>
                {exceptions.map((exception, i) => (
                  <fieldset key={i}>
                    <legend>Exceção {i + 1}</legend>
                    <label>
                      Data
                      <input
                        type="date"
                        min={effectiveFrom || undefined}
                        value={exception.date}
                        onChange={(e) =>
                          mutateExceptions((a) =>
                            a.map((x, j) =>
                              j === i ? { ...x, date: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      Tipo
                      <select
                        value={exception.kind}
                        onChange={(e) =>
                          mutateExceptions((a) =>
                            a.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    kind: e.target
                                      .value as ShiftException["kind"],
                                    slots:
                                      e.target.value === "CLOSED"
                                        ? []
                                        : [{ start: "", end: "" }],
                                  }
                                : x,
                            ),
                          )
                        }
                      >
                        <option value="CLOSED">Fechado</option>
                        <option value="REPLACE">Substituir horários</option>
                      </select>
                    </label>
                    {exception.kind === "REPLACE" && (
                      <>
                        {exception.slots.map((s, k) => (
                          <span key={k}>
                            <label>
                              Início da exceção
                              <input
                                type="time"
                                value={s.start}
                                onChange={(e) =>
                                  mutateExceptions((a) =>
                                    a.map((x, j) =>
                                      j === i
                                        ? {
                                            ...x,
                                            slots: x.slots.map((y, l) =>
                                              l === k
                                                ? {
                                                    ...y,
                                                    start: e.target.value,
                                                  }
                                                : y,
                                            ),
                                          }
                                        : x,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <label>
                              Fim da exceção
                              <input
                                type="time"
                                value={s.end}
                                onChange={(e) =>
                                  mutateExceptions((a) =>
                                    a.map((x, j) =>
                                      j === i
                                        ? {
                                            ...x,
                                            slots: x.slots.map((y, l) =>
                                              l === k
                                                ? { ...y, end: e.target.value }
                                                : y,
                                            ),
                                          }
                                        : x,
                                    ),
                                  )
                                }
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                mutateExceptions((a) =>
                                  a.map((x, j) =>
                                    j === i
                                      ? {
                                          ...x,
                                          slots: x.slots.filter(
                                            (_, l) => l !== k,
                                          ),
                                        }
                                      : x,
                                  ),
                                )
                              }
                            >
                              Remover horário da exceção
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          disabled={exception.slots.length >= 4}
                          onClick={() =>
                            mutateExceptions((a) =>
                              a.map((x, j) =>
                                j === i
                                  ? {
                                      ...x,
                                      slots: [
                                        ...x.slots,
                                        { start: "", end: "" },
                                      ],
                                    }
                                  : x,
                              ),
                            )
                          }
                        >
                          Adicionar horário da exceção
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        mutateExceptions((a) => a.filter((_, j) => j !== i))
                      }
                    >
                      Remover exceção
                    </button>
                  </fieldset>
                ))}
                <button
                  type="button"
                  disabled={exceptions.length >= 90}
                  onClick={() =>
                    mutateExceptions((a) => [...a, emptyException()])
                  }
                >
                  Adicionar exceção
                </button>
                <button
                  type="button"
                  disabled={!valid || !dirty || blocked}
                  onClick={open}
                >
                  Salvar escala
                </button>
              </>
            ) : (
              <p>
                {schedule
                  ? `${schedule.weeklySlots.length} período(s) semanal(is) e ${schedule.exceptions.length} exceção(ões).`
                  : "Sem escala publicada."}
              </p>
            )}
          </>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {confirming && (
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar escala"
        >
          <p>
            Publicar esta grade observacional? Ela não altera disponibilidade
            nem claims.
          </p>
          {mutationError && <p role="alert">{mutationError}</p>}
          <button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "Salvando…" : "Confirmar alteração"}
          </button>
          <button type="button" disabled={saving} onClick={close}>
            Cancelar
          </button>
        </div>
      )}
    </section>
  );
}
