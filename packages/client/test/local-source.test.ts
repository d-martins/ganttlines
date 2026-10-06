import { describe, expect, it } from "vitest";
import { checkFormat, emptyWorkspace, toCalendarDto } from "../src/local/records";
import { MemoryStore } from "../src/local/store";
import { validation } from "../src/local/validation";

describe("local records", () => {
  it("starts empty, with Monday–Friday working days", async () => {
    expect(await new MemoryStore().load()).toEqual({ workspace: null, projects: [] });
    expect(toCalendarDto(emptyWorkspace())).toEqual({ instanceVersion: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [], locations: [] });
  });

  it("keeps copies, so later changes to an object don't leak into the store", async () => {
    const store = new MemoryStore();
    const workspace = emptyWorkspace();
    await store.saveWorkspace(workspace);
    workspace.workingWeekdays.push(6);
    expect((await store.load()).workspace?.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses other formats and newer versions", () => {
    expect(() => checkFormat({ format: "something-else", version: 1 })).toThrow(expect.objectContaining({ status: 400, code: "invalid_file" }));
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 99 })).toThrow(expect.objectContaining({ status: 400, code: "newer_version" }));
    expect(() => checkFormat({ format: "ganttlines-workspace", version: 1 })).not.toThrow();
  });

  it("resolves a location holiday to the people in that location", () => {
    const workspace = emptyWorkspace();
    workspace.locations.push({ id: "l1", name: "Lisbon", country: null, region: null });
    workspace.team.push({ id: "r1", name: "Ana", avatarColor: "#4f8cff", inactive: false, locationId: "l1" });
    workspace.holidays.push({ id: "h1", name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesToAll: false, resourceIds: [], locationIds: ["l1"] });
    expect(toCalendarDto(workspace).holidays).toEqual([
      { id: "h1", name: "Fair", startDate: "2026-10-08", endDate: "2026-10-08", appliesTo: ["r1"], target: { all: false, resourceIds: [], locationIds: ["l1"] } },
    ]);
  });

  it("checks request bodies with the protocol's schemas (loaded on demand)", async () => {
    const { protocol, check } = await validation();
    expect(check(protocol.CreateProjectBody, { name: "  Launch  " })).toEqual({ name: "Launch" });
    expect(() => check(protocol.CreateProjectBody, { name: "" })).toThrow(expect.objectContaining({ status: 400, code: "invalid_request" }));
  });
});
