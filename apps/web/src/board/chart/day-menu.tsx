import { fromDay, type DayNum } from "@ganttlines/engine";
import type { HighlightDto, ResourceDto } from "@ganttlines/protocol";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useState, type ReactNode } from "react";
import { errorMessage } from "../../api/client";
import { useDeleteHighlight, useSaveHighlight, useSaveHoliday, useSaveTimeOff } from "../../api/queries";
import { ColorInput } from "../../ui/color-input";
import { Field } from "../../ui/field";
import { FormDialog } from "../../ui/form-dialog";
import { toast } from "../../ui/toast";
import { formatDay } from "../format";

type DialogKind = "highlight" | "holiday" | "timeOff";

const ITEM = "cursor-pointer rounded px-2 py-1.5 outline-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2";
const DEFAULT_HIGHLIGHT = "#e5892f";

/**
 * Right-click on a day of the chart: highlight it (or edit / remove its highlight), add a holiday
 * (everyone or selected people) or someone's time off starting that day.
 */
export function DayMenu({
  projectId,
  enabled,
  canEditCalendar,
  dayAt,
  highlights,
  resources,
  children,
}: {
  projectId: string;
  enabled: boolean;
  /** holidays and time off are team-wide: signed-in editors only (not share-link visitors) */
  canEditCalendar: boolean;
  /** the day under a viewport x coordinate */
  dayAt: (clientX: number) => DayNum;
  highlights: readonly { day: DayNum; highlight: HighlightDto }[];
  resources: readonly ResourceDto[];
  children: ReactNode;
}) {
  const [day, setDay] = useState<DayNum | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const deleteHighlight = useDeleteHighlight(projectId);
  const existing = day === null ? undefined : highlights.find((entry) => entry.day === day)?.highlight;
  const date = day === null ? "" : formatDay(day);

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild disabled={!enabled} onContextMenu={(event) => setDay(dayAt(event.clientX))}>
          {children}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-52 rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg">
            <ContextMenu.Label className="px-2 py-1 text-xs text-muted">{date}</ContextMenu.Label>
            <ContextMenu.Item className={ITEM} onSelect={() => setDialog("highlight")}>
              {existing ? "Edit highlight…" : "Highlight this day…"}
            </ContextMenu.Item>
            {existing ? (
              <ContextMenu.Item
                className={ITEM}
                onSelect={() => deleteHighlight.mutate(existing.id, { onError: (error) => toast(`Couldn't remove the highlight: ${errorMessage(error)}`, { tone: "error" }) })}
              >
                Remove highlight
              </ContextMenu.Item>
            ) : null}
            {canEditCalendar ? (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <ContextMenu.Item className={ITEM} onSelect={() => setDialog("holiday")}>
                  Add a holiday…
                </ContextMenu.Item>
                <ContextMenu.Item className={ITEM} onSelect={() => setDialog("timeOff")}>
                  Add time off…
                </ContextMenu.Item>
              </>
            ) : null}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {day !== null && dialog === "highlight" ? <HighlightDialog projectId={projectId} day={day} existing={existing} onClose={() => setDialog(null)} /> : null}
      {day !== null && dialog === "holiday" ? <HolidayDialog day={day} resources={resources} onClose={() => setDialog(null)} /> : null}
      {day !== null && dialog === "timeOff" ? <TimeOffDialog day={day} resources={resources} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

function HighlightDialog({ projectId, day, existing, onClose }: { projectId: string; day: DayNum; existing: HighlightDto | undefined; onClose: () => void }) {
  const save = useSaveHighlight(projectId);
  const [label, setLabel] = useState(existing?.label ?? "");
  const [color, setColor] = useState(existing?.color ?? DEFAULT_HIGHLIGHT);
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Highlight ${formatDay(day)}`}
      submitLabel={existing ? "Save" : "Highlight"}
      pending={save.isPending}
      error={save.error ? errorMessage(save.error) : null}
      onSubmit={() => save.mutate({ ...(existing ? { id: existing.id } : {}), date: fromDay(day), label, color }, { onSuccess: onClose })}
    >
      <Field label="Label (optional)" value={label} maxLength={100} autoFocus onChange={(event) => setLabel(event.target.value)} />
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        <ColorInput label="Highlight color" value={color} onCommit={setColor} /> Color
      </div>
    </FormDialog>
  );
}

function HolidayDialog({ day, resources, onClose }: { day: DayNum; resources: readonly ResourceDto[]; onClose: () => void }) {
  const save = useSaveHoliday();
  const [name, setName] = useState("");
  const [endDate, setEndDate] = useState(fromDay(day));
  const [everyone, setEveryone] = useState(true);
  const [people, setPeople] = useState<string[]>([]);
  const active = resources.filter((resource) => !resource.inactive);
  const submit = () => {
    if (!everyone && people.length === 0) return;
    save.mutate({ name: name.trim(), startDate: fromDay(day), endDate, appliesTo: everyone ? "all" : people }, { onSuccess: onClose });
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Holiday from ${formatDay(day)}`}
      description="Nobody it applies to is scheduled to work on these days."
      submitLabel="Add holiday"
      pending={save.isPending}
      error={!everyone && people.length === 0 ? "Choose at least one person." : save.error ? errorMessage(save.error) : null}
      onSubmit={submit}
    >
      <Field label="Name" value={name} required maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} />
      <Field label="Last day" type="date" value={endDate} min={fromDay(day)} required onChange={(event) => setEndDate(event.target.value)} />
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-xs font-medium text-muted">Applies to</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="applies" checked={everyone} onChange={() => setEveryone(true)} /> Everyone
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="applies" checked={!everyone} onChange={() => setEveryone(false)} /> Selected people
        </label>
        {!everyone ? (
          <div className="ml-6 flex max-h-40 flex-col gap-1 overflow-auto">
            {active.map((resource) => (
              <label key={resource.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={people.includes(resource.id)}
                  onChange={(event) => setPeople((current) => (event.target.checked ? [...current, resource.id] : current.filter((id) => id !== resource.id)))}
                />
                {resource.name}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
    </FormDialog>
  );
}

function TimeOffDialog({ day, resources, onClose }: { day: DayNum; resources: readonly ResourceDto[]; onClose: () => void }) {
  const save = useSaveTimeOff();
  const active = resources.filter((resource) => !resource.inactive);
  const [resourceId, setResourceId] = useState(active[0]?.id ?? "");
  const [endDate, setEndDate] = useState(fromDay(day));
  const [note, setNote] = useState("");
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Time off from ${formatDay(day)}`}
      description="Their tasks skip these days, like a weekend."
      submitLabel="Add time off"
      pending={save.isPending}
      error={active.length === 0 ? "Add team members first (Team & calendar)." : save.error ? errorMessage(save.error) : null}
      onSubmit={() => resourceId && save.mutate({ resourceId, startDate: fromDay(day), endDate, note }, { onSuccess: onClose })}
    >
      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
        Who
        <select value={resourceId} onChange={(event) => setResourceId(event.target.value)} className="rounded-md border border-border-strong bg-bg px-2.5 py-1.5 text-sm text-text">
          {active.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.name}
            </option>
          ))}
        </select>
      </label>
      <Field label="Last day" type="date" value={endDate} min={fromDay(day)} required onChange={(event) => setEndDate(event.target.value)} />
      <Field label="Note (optional)" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
    </FormDialog>
  );
}
