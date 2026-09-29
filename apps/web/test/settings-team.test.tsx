import type { CalendarDto, ResourceDto } from "@ganttlines/protocol";
import { describe, expect, it } from "vitest";
import { ADMIN, renderApp, screen, signedIn, VIEWER } from "./utils";

const CALENDAR: CalendarDto = { instanceVersion: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [] };
const ANA: ResourceDto = { id: "r-ana", name: "Ana", avatarColor: "#4f8cff", inactive: false, userId: null };

describe("settings", () => {
  it("lets admins add users and shows the temporary password", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/users", () => ({ body: { users: [ADMIN] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    api.on("POST /api/users", (body) => ({ status: 201, body: { user: { ...ADMIN, id: "u2", ...(body as object) }, temporaryPassword: "Tmp-Pass-1234567" } }));
    const { user } = renderApp("/settings");
    await user.type(await screen.findByLabelText("Name"), "Rudy");
    await user.type(screen.getByLabelText("Email", { selector: "input" }), "rudy@example.com");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Temporary password: Tmp-Pass-1234567");
    expect(api.calls.find((c) => c.key === "POST /api/users")?.body).toEqual({ name: "Rudy", email: "rudy@example.com", role: "editor", createResource: true });
  });

  it("saves working weekdays", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/users", () => ({ body: { users: [ADMIN] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    api.on("PUT /api/calendar/working-weekdays", (body) => ({ body: { ...CALENDAR, ...(body as object) } }));
    const { user } = renderApp("/settings");
    await user.click(await screen.findByLabelText("Sat"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByLabelText("Sat");
    expect(api.calls.find((c) => c.key === "PUT /api/calendar/working-weekdays")?.body).toEqual({ workingWeekdays: [1, 2, 3, 4, 5, 6] });
  });

  it("only shows account settings to non-admins", async () => {
    signedIn(VIEWER);
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Users" })).not.toBeInTheDocument();
  });
});

describe("team & calendar", () => {
  function teamApi(user = ADMIN) {
    const api = signedIn(user);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    return api;
  }

  it("adds team members", async () => {
    const api = teamApi();
    api.on("POST /api/resources", () => ({ status: 201, body: { resource: { ...ANA, id: "r2", name: "Rudy" } } }));
    const { user } = renderApp("/team");
    await user.type(await screen.findByLabelText("New team member"), "Rudy");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(api.calls.find((c) => c.key === "POST /api/resources")?.body).toEqual({ name: "Rudy" });
  });

  it("adds a holiday for selected people only", async () => {
    const api = teamApi();
    api.on("POST /api/holidays", (body) => ({ status: 201, body: { holiday: { id: "h1", ...(body as object) } } }));
    const { user } = renderApp("/team");
    await user.click(await screen.findByRole("button", { name: "Add holiday" }));
    await user.type(screen.getByLabelText("Name"), "Local fair");
    await user.type(screen.getByLabelText("From"), "2026-10-08");
    await user.click(screen.getByLabelText("Only:"));
    await user.click(screen.getByRole("checkbox", { name: "Ana" }));
    await user.click(screen.getByRole("button", { name: "Save holiday" }));
    expect(api.calls.find((c) => c.key === "POST /api/holidays")?.body).toEqual({
      name: "Local fair",
      startDate: "2026-10-08",
      endDate: "2026-10-08",
      appliesTo: ["r-ana"],
    });
  });

  it("is read-only for viewers", async () => {
    teamApi(VIEWER);
    renderApp("/team");
    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add holiday" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New team member")).not.toBeInTheDocument();
  });
});
