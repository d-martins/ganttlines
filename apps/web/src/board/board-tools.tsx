import type { ResourceDto, Viewer } from "@ganttlines/protocol";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarRange, GalleryVertical, Layers } from "lucide-react";
import { useStore } from "zustand";
import { baselineList, resourceList } from "../api/queries";
import type { BoardSync } from "../sync/board-sync";
import { Avatar } from "../ui/avatar";
import { Button, IconButton } from "../ui/button";
import { Menu, MenuLabel, MenuRadio, MenuSeparator } from "../ui/menu";
import type { Zoom } from "./chart/timeline";
import { colorFor } from "./format";
import type { CompareMode } from "./model";
import { useBoardView } from "./view-store";

const ZOOMS: { value: Zoom; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];
const MAX_AVATARS = 5;

/** Board controls in the top bar: baseline, zoom, bar style, weekends, today, connection, viewers. */
export function BoardTools({ sync }: { sync: BoardSync }) {
  const { zoom, barStyle, showWeekends, setZoom, setBarStyle, setShowWeekends, goToToday } = useBoardView();
  return (
    <div className="flex min-w-0 items-center gap-1">
      <BaselinePicker projectId={sync.projectId} />
      <div role="group" aria-label="Zoom" className="ml-1 flex rounded-md border border-border bg-bg p-0.5">
        {ZOOMS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={zoom === option.value}
            onClick={() => setZoom(option.value)}
            className={`rounded px-2 py-0.5 text-xs ${zoom === option.value ? "bg-accent-soft font-semibold text-text" : "text-muted hover:text-text"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <IconButton
        label={barStyle === "roomy" ? "Compact bars" : "Roomy bars"}
        aria-pressed={barStyle === "roomy"}
        onClick={() => setBarStyle(barStyle === "roomy" ? "compact" : "roomy")}
        className={barStyle === "roomy" ? "bg-accent-soft text-text" : ""}
      >
        <GalleryVertical size={16} />
      </IconButton>
      <IconButton
        label={showWeekends ? "Hide weekends" : "Show weekends"}
        aria-pressed={!showWeekends}
        onClick={() => setShowWeekends(!showWeekends)}
        className={showWeekends ? "" : "bg-accent-soft text-text"}
      >
        <CalendarRange size={16} />
      </IconButton>
      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={goToToday}>
        Today
      </Button>
      <Connection sync={sync} />
      <Viewers sync={sync} />
    </div>
  );
}

function BaselinePicker({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const search = useSearch({ from: "/app/p/$projectId" });
  const baselines = useQuery(baselineList(projectId));
  const list = baselines.data ?? [];
  const current = list.find((baseline) => baseline.id === search.baseline);
  const compare: CompareMode = search.compare ?? "overlay";
  const choose = (id: string) => void navigate({ to: ".", search: id === "none" ? {} : { baseline: id, ...(compare === "switch" ? { compare } : {}) } });
  const setCompare = (mode: CompareMode) => {
    if (search.baseline) void navigate({ to: ".", search: { baseline: search.baseline, ...(mode === "switch" ? { compare: mode } : {}) } });
  };
  return (
    <Menu
      trigger={
        <Button variant="ghost" className="px-2 py-1 text-xs" aria-label="Baseline">
          <Layers size={14} />
          {current ? `${current.name} · ${compare === "switch" ? "switched" : "overlay"}` : "Baseline"}
        </Button>
      }
    >
      <MenuLabel>Compare with a baseline</MenuLabel>
      {list.length === 0 ? <MenuLabel>No baselines saved yet.</MenuLabel> : null}
      <MenuRadio value={current?.id ?? "none"} options={[{ value: "none", label: "None" }, ...list.map((baseline) => ({ value: baseline.id, label: baseline.name }))]} onChange={choose} />
      {current ? (
        <>
          <MenuSeparator />
          <MenuRadio
            value={compare}
            options={[
              { value: "overlay", label: "Overlay on the live plan" },
              { value: "switch", label: "Switch to the baseline" },
            ]}
            onChange={setCompare}
          />
        </>
      ) : null}
    </Menu>
  );
}

function Connection({ sync }: { sync: BoardSync }) {
  const status = useStore(sync.store, (state) => state.status);
  const [color, text] =
    status === "live" ? ["bg-[#2fa86b]", "Live"] : status === "reconnecting" ? ["bg-[#e5892f]", "Reconnecting…"] : status === "ended" ? ["bg-danger", "Offline"] : ["bg-border-strong", "Connecting…"];
  return (
    <span role="status" aria-label={`Connection: ${text}`} className="ml-1 flex items-center gap-1.5 text-xs text-muted">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {status === "live" ? null : text}
    </span>
  );
}

/** A viewer's color: their team member's avatar color when they have one. */
function viewerColor(viewer: Viewer, resources: readonly ResourceDto[] | undefined): string {
  const userId = viewer.id.startsWith("user:") ? viewer.id.slice(5) : null;
  return resources?.find((resource) => userId && resource.userId === userId)?.avatarColor ?? colorFor(viewer.id);
}

function Viewers({ sync }: { sync: BoardSync }) {
  const viewers = useStore(sync.store, (state) => state.viewers);
  const resources = useQuery(resourceList);
  if (viewers.length === 0) return null;
  const extra = viewers.length - MAX_AVATARS;
  return (
    <div role="list" aria-label="People viewing this board" className="ml-2 flex items-center">
      {viewers.slice(0, MAX_AVATARS).map((viewer) => (
        <Tooltip.Root key={viewer.id}>
          <Tooltip.Trigger asChild>
            <span role="listitem" aria-label={viewer.name} className="-ml-1.5 rounded-full ring-2 ring-surface first:ml-0">
              <Avatar name={viewer.name} color={viewerColor(viewer, resources.data)} size={24} />
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content sideOffset={6} className="z-50 rounded bg-text px-2 py-1 text-xs text-bg shadow">
              {viewer.name}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      ))}
      {extra > 0 ? <span className="ml-1 text-xs text-muted">+{extra}</span> : null}
    </div>
  );
}
