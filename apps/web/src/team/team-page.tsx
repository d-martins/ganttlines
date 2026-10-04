import type { HolidayBody, HolidayDto, LocationDto, ResourceDto, TimeOffBody, TimeOffDto, UserDto } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/client";
import {
  calendar,
  currentUser,
  holidayCountries,
  holidayRegions,
  locationPublicHolidays,
  resourceList,
  useCreateResource,
  useDeleteHoliday,
  useDeleteLocation,
  useImportHolidays,
  useSaveLocation,
  useDeleteTimeOff,
  useSaveHoliday,
  useSaveTimeOff,
  useUpdateResource,
} from "../api/queries";
import { Avatar } from "../ui/avatar";
import { ColorInput } from "../ui/color-input";
import { QueryState } from "../ui/query-state";
import { Button } from "../ui/button";
import { ConfirmButton } from "../ui/confirm";
import { ErrorText, Field } from "../ui/field";
import { Section } from "../ui/section";

const canEdit = (user: UserDto | null | undefined) => user?.role === "editor" || user?.role === "admin";

/** Team members, holidays and time off — the team calendar every project schedules against. */
export function TeamPage() {
  const me = useQuery(currentUser);
  const resources = useQuery(resourceList);
  const cal = useQuery(calendar);
  const editable = canEdit(me.data);
  if (me.data?.role === "guest") {
    return <p className="p-8 text-muted">The team calendar is only available to team members.</p>;
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <QueryState query={resources}>
        {(people) => (
          <QueryState query={cal}>
            {(data) => (
              <>
                <TeamMembers people={people} locations={data.locations} editable={editable} />
                <Locations locations={data.locations} people={people} holidays={data.holidays} editable={editable} />
                <Holidays holidays={data.holidays} people={people} locations={data.locations} editable={editable} />
                <TimeOff entries={data.timeOff} people={people} editable={editable} />
              </>
            )}
          </QueryState>
        )}
      </QueryState>
    </div>
  );
}

function TeamMembers({ people, locations, editable }: { people: ResourceDto[]; locations: LocationDto[]; editable: boolean }) {
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
            {editable && locations.length > 0 ? (
              <select
                aria-label={`Location of ${person.name}`}
                value={person.locationId ?? ""}
                onChange={(event) => update.mutate({ id: person.id, locationId: event.target.value || null })}
                className="max-w-40 rounded border border-border-strong bg-bg px-1 py-0.5 text-sm"
              >
                <option value="">No location</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            ) : person.locationId ? (
              <span className="text-xs text-muted">{locations.find((location) => location.id === person.locationId)?.name}</span>
            ) : null}
            {editable ? (
              <>
                <ColorInput
                  label={`Color of ${person.name}`}
                  value={person.avatarColor}
                  onCommit={(avatarColor) => update.mutate({ id: person.id, avatarColor })}
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

/**
 * Offices or countries team members belong to. Holidays can target a location, and a country's
 * public holidays can be added to one from a suggested list.
 */
function Locations({ locations, people, holidays, editable }: { locations: LocationDto[]; people: ResourceDto[]; holidays: HolidayDto[]; editable: boolean }) {
  const save = useSaveLocation();
  const remove = useDeleteLocation();
  const [name, setName] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  return (
    <Section title="Locations" description="Where people work. Holidays for a location apply to everyone in it — set a country to add its public holidays.">
      <ul className="mb-3 divide-y divide-border">
        {locations.map((location) => {
          const members = people.filter((person) => person.locationId === location.id).length;
          const ownHolidays = holidays.filter((holiday) => holiday.target.locationIds.join() === location.id && holiday.target.resourceIds.length === 0).length;
          return (
            <li key={location.id} className="flex flex-col gap-2 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                {editable ? (
                  <input
                    aria-label={`Name of ${location.name}`}
                    defaultValue={location.name}
                    onBlur={(event) =>
                      event.target.value.trim() && event.target.value !== location.name && save.mutate({ ...location, name: event.target.value.trim() })
                    }
                    className="min-w-32 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-accent"
                  />
                ) : (
                  <span className="flex-1">{location.name}</span>
                )}
                <span className="text-xs text-muted">
                  {members} {members === 1 ? "person" : "people"}
                </span>
                {editable ? <CountryPicker location={location} onChange={(country, region) => save.mutate({ ...location, country, region })} /> : null}
                {editable && location.country ? (
                  <Button variant="ghost" onClick={() => setImporting(importing === location.id ? null : location.id)}>
                    Public holidays…
                  </Button>
                ) : null}
                {editable ? (
                  <ConfirmButton
                    label="Delete"
                    title={`Delete “${location.name}”?`}
                    message={`${members} ${members === 1 ? "person loses" : "people lose"} this location${ownHolidays ? `, and its ${ownHolidays} ${ownHolidays === 1 ? "holiday is" : "holidays are"} deleted` : ""}.`}
                    onConfirm={() => remove.mutate(location.id)}
                  />
                ) : null}
              </div>
              {importing === location.id ? <PublicHolidayPicker location={location} onDone={() => setImporting(null)} /> : null}
            </li>
          );
        })}
        {locations.length === 0 ? <li className="py-2 text-sm text-muted">No locations yet.</li> : null}
      </ul>
      {editable ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ name: name.trim() }, { onSuccess: () => setName("") });
          }}
        >
          <Field label="New location" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lisbon office" required className="flex-1" />
          <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
            Add location
          </Button>
        </form>
      ) : null}
      <ErrorText>{(save.error ?? remove.error) ? errorMessage(save.error ?? remove.error) : null}</ErrorText>
    </Section>
  );
}

/** A location's country, and region when the country has regional holidays. */
function CountryPicker({ location, onChange }: { location: LocationDto; onChange: (country: string | null, region: string | null) => void }) {
  const countries = useQuery(holidayCountries);
  const regions = useQuery({ ...holidayRegions(location.country ?? ""), enabled: Boolean(location.country) });
  return (
    <>
      <select
        aria-label={`Country of ${location.name}`}
        value={location.country ?? ""}
        onChange={(event) => onChange(event.target.value || null, null)}
        className="max-w-44 rounded border border-border-strong bg-bg px-1 py-0.5"
      >
        <option value="">No country</option>
        {countries.data?.countries.map((country) => (
          <option key={country.code} value={country.code}>
            {country.name}
          </option>
        ))}
      </select>
      {location.country && regions.data && regions.data.regions.length > 0 ? (
        <select
          aria-label={`Region of ${location.name}`}
          value={location.region ?? ""}
          onChange={(event) => onChange(location.country, event.target.value || null)}
          className="max-w-44 rounded border border-border-strong bg-bg px-1 py-0.5"
        >
          <option value="">Whole country</option>
          {regions.data.regions.map((region) => (
            <option key={region.code} value={region.code}>
              {region.name}
            </option>
          ))}
        </select>
      ) : null}
    </>
  );
}

const TYPE_LABELS: Record<string, string> = { public: "", bank: "bank holiday", optional: "optional", school: "school", observance: "observance" };

/** Suggested public holidays for a year: days off by law are ticked; tick or untick, then add. */
function PublicHolidayPicker({ location, onDone }: { location: LocationDto; onDone: () => void }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const suggestions = useQuery(locationPublicHolidays(location.id, year));
  const add = useImportHolidays();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const key = (holiday: { name: string; startDate: string }) => `${holiday.name}|${holiday.startDate}`;
  const available = suggestions.data?.holidays.filter((holiday) => !holiday.added) ?? [];
  const chosen = available.filter((holiday) => picked[key(holiday)] ?? holiday.type === "public");
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          Year
          <select aria-label="Year" value={year} onChange={(event) => (setYear(Number(event.target.value)), setPicked({}))} className="rounded border border-border-strong bg-bg px-1 py-0.5">
            {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-xs text-muted">
          Holiday data:{" "}
          <a href="https://github.com/commenthol/date-holidays" target="_blank" rel="noopener noreferrer" className="underline">
            date-holidays
          </a>{" "}
          (CC BY-SA 3.0) — check it against official sources.
        </span>
      </div>
      {suggestions.isPending ? <p className="text-muted">Loading…</p> : null}
      <ul aria-label={`Public holidays for ${location.name}`} className="grid gap-1 sm:grid-cols-2">
        {suggestions.data?.holidays.map((holiday) => (
          <li key={key(holiday)}>
            <label className={`flex items-center gap-1.5 ${holiday.added ? "text-muted" : ""}`}>
              <input
                type="checkbox"
                disabled={holiday.added}
                checked={holiday.added || (picked[key(holiday)] ?? holiday.type === "public")}
                onChange={(event) => setPicked({ ...picked, [key(holiday)]: event.target.checked })}
              />
              <span>
                {holiday.name} <span className="text-xs text-muted">· {range(holiday.startDate, holiday.endDate)}</span>
                {TYPE_LABELS[holiday.type] ? <span className="text-xs text-muted"> · {TYPE_LABELS[holiday.type]}</span> : null}
                {holiday.added ? <span className="text-xs text-muted"> · added</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={chosen.length === 0 || add.isPending}
          onClick={() => add.mutate({ id: location.id, holidays: chosen.map(({ name, startDate, endDate }) => ({ name, startDate, endDate })) }, { onSuccess: onDone })}
        >
          Add {chosen.length} {chosen.length === 1 ? "holiday" : "holidays"}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
      <ErrorText>{(suggestions.error ?? add.error) ? errorMessage(suggestions.error ?? add.error) : null}</ErrorText>
    </div>
  );
}

const range = (start: string, end: string) => (start === end ? start : `${start} → ${end}`);

/** Who a holiday is for, as set up: "Everyone", or locations and people. */
function audience(holiday: HolidayDto, people: ResourceDto[], locations: LocationDto[]): string {
  if (holiday.target.all) return "Everyone";
  const names = [
    ...holiday.target.locationIds.map((id) => locations.find((location) => location.id === id)?.name ?? "Unknown location"),
    ...holiday.target.resourceIds.map((id) => people.find((person) => person.id === id)?.name ?? "Unknown"),
  ];
  return names.join(", ");
}

function Holidays({ holidays, people, locations, editable }: { holidays: HolidayDto[]; people: ResourceDto[]; locations: LocationDto[]; editable: boolean }) {
  const save = useSaveHoliday();
  const remove = useDeleteHoliday();
  const [editing, setEditing] = useState<(HolidayBody & { id?: string; locationIds: string[] }) | null>(null);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((other) => other !== id) : [...list, id]);
  return (
    <Section title="Holidays" description="Days off for everyone, or only for some locations or people (for example a local holiday).">
      <ul className="mb-3 divide-y divide-border">
        {holidays.map((holiday) => (
          <li key={holiday.id} className="flex items-center gap-3 py-2 text-sm">
            <span className="flex-1">
              <strong>{holiday.name}</strong> <span className="text-muted">· {range(holiday.startDate, holiday.endDate)}</span>
            </span>
            <span className="text-muted">{audience(holiday, people, locations)}</span>
            {/* Row actions are hidden while a holiday is being edited, so nothing is deleted mid-edit. */}
            {editable && !editing ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setEditing({
                      id: holiday.id,
                      name: holiday.name,
                      startDate: holiday.startDate,
                      endDate: holiday.endDate,
                      appliesTo: holiday.target.all ? "all" : holiday.target.resourceIds,
                      locationIds: holiday.target.locationIds,
                    })
                  }
                >
                  Edit
                </Button>
                <ConfirmButton
                  label="Delete"
                  title={`Delete “${holiday.name}”?`}
                  message="Tasks that were stretched around this holiday will be rescheduled."
                  onConfirm={() => remove.mutate(holiday.id)}
                />
              </>
            ) : null}
          </li>
        ))}
        {holidays.length === 0 ? <li className="py-2 text-sm text-muted">No holidays yet.</li> : null}
      </ul>
      {editable && !editing ? (
        <Button onClick={() => setEditing({ name: "", startDate: "", endDate: "", appliesTo: "all", locationIds: [] })}>Add holiday</Button>
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
              ? locations.map((location) => (
                  <label key={location.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={editing.locationIds.includes(location.id)}
                      onChange={() => setEditing({ ...editing, locationIds: toggle(editing.locationIds, location.id) })}
                    />
                    {location.name} <span className="text-xs text-muted">(location)</span>
                  </label>
                ))
              : null}
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
            <Button type="submit" variant="primary" disabled={save.isPending || (editing.appliesTo !== "all" && editing.appliesTo.length === 0 && editing.locationIds.length === 0)}>
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
            {/* Row actions are hidden while an entry is being edited, so nothing is deleted mid-edit. */}
            {editable && !editing ? (
              <>
                <Button variant="ghost" onClick={() => setEditing({ ...entry })}>
                  Edit
                </Button>
                <ConfirmButton
                  label="Delete"
                  title={`Delete ${nameOf(entry.resourceId)}’s time off?`}
                  message={`${range(entry.startDate, entry.endDate)}. Their tasks will be rescheduled.`}
                  onConfirm={() => remove.mutate(entry.id)}
                />
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
