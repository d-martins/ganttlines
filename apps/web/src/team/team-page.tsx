import type { Holiday } from "@ganttlines/engine";
import type { HolidayBody, ResourceDto, TimeOffBody, TimeOffDto, UserDto } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/client";
import {
  calendar,
  currentUser,
  resourceList,
  useCreateResource,
  useDeleteHoliday,
  useDeleteTimeOff,
  useSaveHoliday,
  useSaveTimeOff,
  useUpdateResource,
} from "../api/queries";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ErrorText, Field } from "../ui/field";
import { Section } from "../ui/section";

const canEdit = (user: UserDto | null | undefined) => user?.role === "editor" || user?.role === "admin";

/** Team members, holidays and time off — the team calendar every project schedules against. */
export function TeamPage() {
  const me = useQuery(currentUser);
  const resources = useQuery(resourceList);
  const cal = useQuery(calendar);
  const editable = canEdit(me.data);
  const people = resources.data ?? [];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <TeamMembers people={people} editable={editable} />
      <Holidays holidays={cal.data?.holidays ?? []} people={people} editable={editable} />
      <TimeOff entries={cal.data?.timeOff ?? []} people={people} editable={editable} />
    </div>
  );
}

function TeamMembers({ people, editable }: { people: ResourceDto[]; editable: boolean }) {
  const create = useCreateResource();
  const update = useUpdateResource();
  const [name, setName] = useState("");
  return (
    <Section title="Team members" description="People tasks can be assigned to. They don't need an account. Mark people who left as inactive instead of deleting them.">
      <ul className="mb-3 divide-y divide-border">
        {people.map((person) => (
          <li key={person.id} className="flex items-center gap-3 py-2">
            <Avatar name={person.name} color={person.avatarColor} />
            {editable ? (
              <input
                aria-label={`Name of ${person.name}`}
                defaultValue={person.name}
                onBlur={(event) => event.target.value.trim() && event.target.value !== person.name && update.mutate({ id: person.id, name: event.target.value.trim() })}
                className="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-border focus:border-accent"
              />
            ) : (
              <span className="flex-1 text-sm">{person.name}</span>
            )}
            {person.inactive ? <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">Inactive</span> : null}
            {editable ? (
              <>
                <input
                  type="color"
                  aria-label={`Color of ${person.name}`}
                  value={person.avatarColor}
                  onChange={(event) => update.mutate({ id: person.id, avatarColor: event.target.value })}
                  className="h-7 w-9 cursor-pointer rounded border border-border bg-bg"
                />
                <Button variant="ghost" onClick={() => update.mutate({ id: person.id, inactive: !person.inactive })}>
                  {person.inactive ? "Reactivate" : "Mark inactive"}
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ name: name.trim() }, { onSuccess: () => setName("") });
          }}
        >
          <Field label="New team member" value={name} onChange={(e) => setName(e.target.value)} required className="flex-1" />
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
            Add
          </Button>
        </form>
      ) : null}
      <ErrorText>{(create.error ?? update.error) ? errorMessage(create.error ?? update.error) : null}</ErrorText>
    </Section>
  );
}

const range = (start: string, end: string) => (start === end ? start : `${start} → ${end}`);

function Holidays({ holidays, people, editable }: { holidays: Holiday[]; people: ResourceDto[]; editable: boolean }) {
  const save = useSaveHoliday();
  const remove = useDeleteHoliday();
  const [editing, setEditing] = useState<(HolidayBody & { id?: string }) | null>(null);
  const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? "Unknown";
  return (
    <Section title="Holidays" description="Days off for everyone, or only for some people (for example a local holiday).">
      <ul className="mb-3 divide-y divide-border">
        {holidays.map((holiday) => (
          <li key={holiday.id} className="flex items-center gap-3 py-2 text-sm">
            <span className="flex-1">
              <strong>{holiday.name}</strong> <span className="text-muted">· {range(holiday.startDate, holiday.endDate)}</span>
            </span>
            <span className="text-muted">{holiday.appliesTo === "all" ? "Everyone" : holiday.appliesTo.map(nameOf).join(", ")}</span>
            {editable ? (
              <>
                <Button variant="ghost" onClick={() => setEditing({ ...holiday })}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => remove.mutate(holiday.id)}>
                  Delete
                </Button>
              </>
            ) : null}
          </li>
        ))}
        {holidays.length === 0 ? <li className="py-2 text-sm text-muted">No holidays yet.</li> : null}
      </ul>
      {editable && !editing ? (
        <Button onClick={() => setEditing({ name: "", startDate: "", endDate: "", appliesTo: "all" })}>Add holiday</Button>
      ) : null}
      {editing ? (
        <form
          className="flex flex-col gap-3 rounded-md border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ ...editing, endDate: editing.endDate || editing.startDate }, { onSuccess: () => setEditing(null) });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            <Field label="From" type="date" value={editing.startDate} onChange={(e) => setEditing({ ...editing, startDate: e.target.value })} required />
            <Field label="To (optional)" type="date" value={editing.endDate} onChange={(e) => setEditing({ ...editing, endDate: e.target.value })} />
          </div>
          <fieldset className="flex flex-wrap items-center gap-3 text-sm">
            <legend className="mb-1 text-xs font-medium text-muted">Applies to</legend>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={editing.appliesTo === "all"} onChange={() => setEditing({ ...editing, appliesTo: "all" })} /> Everyone
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={editing.appliesTo !== "all"} onChange={() => setEditing({ ...editing, appliesTo: [] })} /> Only:
            </label>
            {editing.appliesTo !== "all"
              ? people.map((person) => {
                  const selected = editing.appliesTo as string[];
                  return (
                    <label key={person.id} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={selected.includes(person.id)}
                        onChange={() =>
                          setEditing({ ...editing, appliesTo: selected.includes(person.id) ? selected.filter((id) => id !== person.id) : [...selected, person.id] })
                        }
                      />
                      {person.name}
                    </label>
                  );
                })
              : null}
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={save.isPending || (editing.appliesTo !== "all" && editing.appliesTo.length === 0)}>
              Save holiday
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}
      <ErrorText>{(save.error ?? remove.error) ? errorMessage(save.error ?? remove.error) : null}</ErrorText>
    </Section>
  );
}

function TimeOff({ entries, people, editable }: { entries: TimeOffDto[]; people: ResourceDto[]; editable: boolean }) {
  const save = useSaveTimeOff();
  const remove = useDeleteTimeOff();
  const [editing, setEditing] = useState<(TimeOffBody & { id?: string }) | null>(null);
  const active = people.filter((person) => !person.inactive);
  const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? "Unknown";
  return (
    <Section title="Time off" description="Vacations and other absences. Tasks assigned to someone stretch around their time off.">
      <ul className="mb-3 divide-y divide-border">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-3 py-2 text-sm">
            <span className="flex-1">
              <strong>{nameOf(entry.resourceId)}</strong> <span className="text-muted">· {range(entry.startDate, entry.endDate)}</span>
              {entry.note ? <span className="text-muted"> · {entry.note}</span> : null}
            </span>
            {editable ? (
              <>
                <Button variant="ghost" onClick={() => setEditing({ ...entry })}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => remove.mutate(entry.id)}>
                  Delete
                </Button>
              </>
            ) : null}
          </li>
        ))}
        {entries.length === 0 ? <li className="py-2 text-sm text-muted">No time off yet.</li> : null}
      </ul>
      {editable && !editing ? (
        <Button disabled={active.length === 0} onClick={() => setEditing({ resourceId: active[0]!.id, startDate: "", endDate: "", note: "" })}>
          Add time off
        </Button>
      ) : null}
      {editing ? (
        <form
          className="flex flex-col gap-3 rounded-md border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ ...editing, endDate: editing.endDate || editing.startDate }, { onSuccess: () => setEditing(null) });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Who
              <select
                value={editing.resourceId}
                onChange={(e) => setEditing({ ...editing, resourceId: e.target.value })}
                className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text"
              >
                {active.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <Field label="From" type="date" value={editing.startDate} onChange={(e) => setEditing({ ...editing, startDate: e.target.value })} required />
            <Field label="To (optional)" type="date" value={editing.endDate} onChange={(e) => setEditing({ ...editing, endDate: e.target.value })} />
            <Field label="Note (only visible to the team)" value={editing.note ?? ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Save time off
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}
      <ErrorText>{(save.error ?? remove.error) ? errorMessage(save.error ?? remove.error) : null}</ErrorText>
    </Section>
  );
}
