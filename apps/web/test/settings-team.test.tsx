import type { CalendarDto, ResourceDto } from "@ganttlines/protocol";
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
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

  it("invites new users by email when it's set up, and can send a test email", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/users", () => ({ body: { users: [ADMIN] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    api.on("GET /api/about", () => ({ body: { version: "1.2.0", updates: { enabled: false, latest: null, available: false }, mail: { configured: true } } }));
    api.on("POST /api/users", (body) => ({ status: 201, body: { user: { ...ADMIN, id: "u2", ...(body as object) }, invited: true } }));
    api.on("POST /api/settings/test-email", () => ({ body: { sentTo: ADMIN.email } }));
    const { user } = renderApp("/settings");
    await user.type(await screen.findByLabelText("Name"), "Rudy");
    await user.type(screen.getByLabelText("Email", { selector: "input" }), "rudy@example.com");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(await screen.findByText("Invitation sent to rudy@example.com: they'll choose their own password.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send me a test email" }));
    expect(await screen.findByText(`Sent to ${ADMIN.email} — check your inbox.`)).toBeInTheDocument();
  });

  it("turns two-factor on: scan or type the key, confirm a code, keep the recovery codes", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/users", () => ({ body: { users: [ADMIN] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    api.on("POST /api/auth/2fa/setup", () => ({ body: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x", qrSvg: "<svg></svg>" } }));
    api.on("POST /api/auth/2fa/enable", () => ({ body: { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] } }));
    const { user } = renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "Turn on two-factor" }));
    expect(await screen.findByLabelText("Setup key")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    expect(screen.getByRole("img", { name: "QR code for your authenticator app" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Code from the app"), "123456");
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    expect(within(await screen.findByRole("list", { name: "Recovery codes" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["aaaa-bbbb", "cccc-dddd"]);
    expect(api.calls.find((c) => c.key === "POST /api/auth/2fa/enable")?.body).toEqual({ code: "123456" });
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
    const api = signedIn(VIEWER);
    api.on("GET /api/about", () => ({ body: { version: "1.2.0" } }));
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Users" })).not.toBeInTheDocument();
    expect(await screen.findByText("GanttLines 1.2.0")).toBeInTheDocument(); // the version, without update details
    expect(screen.queryByLabelText("Check for new versions")).not.toBeInTheDocument();
  });

  it("tells admins when a newer version is out, and lets them switch the check off", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/users", () => ({ body: { users: [ADMIN] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    const url = "https://github.com/d-martins/ganttlines/releases/tag/v1.3.0";
    let enabled = true;
    api.on("GET /api/about", () => ({
      body: { version: "1.2.0", updates: enabled ? { enabled, available: true, latest: { version: "1.3.0", url } } : { enabled, available: false, latest: null } },
    }));
    api.on("PUT /api/settings/update-check", (body) => {
      enabled = (body as { enabled: boolean }).enabled;
      return { body: { enabled } };
    });
    const { user } = renderApp("/settings");
    expect(await screen.findByText("GanttLines 1.3.0 is available.", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "What's new and how to update" })).toHaveAttribute("href", url);
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByText("GanttLines 1.3.0 is available")).toBeInTheDocument(); // the sidebar dot
    await user.click(screen.getByLabelText("Check for new versions"));
    expect(api.calls.find((c) => c.key === "PUT /api/settings/update-check")?.body).toEqual({ enabled: false });
    expect(await screen.findByLabelText("Check for new versions")).not.toBeChecked();
    expect(screen.queryByText("GanttLines 1.3.0 is available.", { exact: false })).not.toBeInTheDocument();
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

  it("asks for confirmation before deleting a holiday", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    api.on("GET /api/calendar", () => ({ body: { ...CALENDAR, holidays: [{ id: "h1", name: "Carnival", startDate: "2027-02-09", endDate: "2027-02-09", appliesTo: "all" }] } }));
    api.on("DELETE /api/holidays/h1", () => ({ status: 204 }));
    const { user } = renderApp("/team");
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete “Carnival”?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.calls.some((c) => c.key === "DELETE /api/holidays/h1")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(api.calls.some((c) => c.key === "DELETE /api/holidays/h1")).toBe(true);
  });

  it("hides edit and delete on other entries while one is being edited", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    api.on("GET /api/calendar", () => ({
      body: { ...CALENDAR, timeOff: [{ id: "t1", resourceId: "r-ana", startDate: "2026-10-12", endDate: "2026-10-16", note: "" }] },
    }));
    const { user } = renderApp("/team");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("is read-only for viewers", async () => {
    teamApi(VIEWER);
    renderApp("/team");
    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add holiday" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New team member")).not.toBeInTheDocument();
  });
});
