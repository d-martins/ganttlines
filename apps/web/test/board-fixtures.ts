import { TASK_DEFAULTS, type SectionRow, type TaskRow } from "@ganttlines/engine";
import type { CalendarDto, ProjectStateDto, ResourceDto, ServerMessage } from "@ganttlines/protocol";
import { act } from "@testing-library/react";

/** Row ids are UUIDs on the wire; these readable ones are enough for the client. */
export function task(id: string, fields: Partial<TaskRow> = {}): TaskRow {
  return { ...TASK_DEFAULTS, id, kind: "task", title: id, parentId: null, position: "a0", collapsed: false, ...fields };
}

export function section(id: string, fields: Partial<SectionRow> = {}): SectionRow {
  return { id, kind: "section", title: id, parentId: null, position: "a0", collapsed: false, ...fields };
}

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const BASELINE_ID = "22222222-2222-4222-8222-222222222222";

export function projectState(rows: ProjectStateDto["rows"], version = 5): ProjectStateDto {
  return { project: { id: PROJECT_ID, name: "Launch", version, archived: false }, rows };
}

export const ANA: ResourceDto = { id: "r-ana", name: "Ana Silva", avatarColor: "#e0569b", inactive: false, userId: "u-admin" };

/** Mon–Fri, Monday 2026-10-05 off for everyone, Ana away 2026-10-07. */
export const CALENDAR: CalendarDto = {
  instanceVersion: 1,
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [{ id: "h1", name: "Republic Day", startDate: "2026-10-05", endDate: "2026-10-05", appliesTo: "all" }],
  timeOff: [{ id: "t1", resourceId: ANA.id, startDate: "2026-10-07", endDate: "2026-10-07", note: "" }],
};

/** Stands in for the browser WebSocket: opens on the next tick, records what the app sends. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  static get last(): FakeWebSocket {
    return FakeWebSocket.instances.at(-1)!;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  deliver(message: ServerMessage) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }

  drop(code: number) {
    this.readyState = 3;
    act(() => this.onclose?.({ code }));
  }
}
