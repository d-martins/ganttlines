import type { CalendarDto, ResourceDto } from "@ganttlines/protocol";
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { ADMIN, renderApp, screen, signedIn, VIEWER } from "./utils";

const CALENDAR: CalendarDto = { instanceVersion: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [], locations: [] };
const ANA: ResourceDto = { id: "r-ana", name: "Ana", avatarColor: "#4f8cff", inactive: false, userId: null, locationId: null };

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

  it("lets admins require two-factor, once they use it themselves", async () => {
    const api = signedIn({ ...ADMIN, twoFactor: true });
    let require = "off";
    api.on("GET /api/users", () => ({ body: { users: [ADMIN] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    api.on("GET /api/about", () => ({ body: { version: "1.2.0", requireTwoFactor: require } }));
    api.on("PUT /api/settings/require-two-factor", (body) => {
      require = (body as { require: string }).require;
      return { body };
    });
    const { user } = renderApp("/settings");
    expect(await screen.findByRole("button", { name: "Turn off" })).toBeInTheDocument();
    await user.click(await screen.findByLabelText("Required for admins"));
    expect(await screen.findByLabelText("Required for admins")).toBeChecked();
    expect(api.calls.find((c) => c.key === "PUT /api/settings/require-two-factor")?.body).toEqual({ require: "admins" });
    // Now it covers this admin, so it can't be turned off from here.
    expect(await screen.findByText(/It's required, so it can't be turned off/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
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
      locationIds: [],
    });
  });

  it("asks for confirmation before deleting a holiday", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    api.on("GET /api/calendar", () => ({ body: { ...CALENDAR, holidays: [{ id: "h1", name: "Carnival", startDate: "2027-02-09", endDate: "2027-02-09", appliesTo: "all", target: { all: true, resourceIds: [], locationIds: [] } }] } }));
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

  it("keeps locations: people belong to one, and a country's public holidays can be added to it", async () => {
    const LISBON = { id: "l-lisbon", name: "Lisbon office", country: "PT", region: null };
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    api.on("GET /api/calendar", () => ({ body: { ...CALENDAR, locations: [LISBON] } }));
    api.on("GET /api/public-holidays/countries", () => ({ body: { countries: [{ code: "PT", name: "Portugal" }] } }));
    api.on("GET /api/public-holidays/countries/PT/regions", () => ({ body: { regions: [] } }));
    api.on("GET /api/locations/l-lisbon/public-holidays", () => ({
      body: {
        holidays: [
          { name: "New Year's Day", startDate: "2026-01-01", endDate: "2026-01-01", type: "public", added: false },
          { name: "Carnival", startDate: "2026-02-17", endDate: "2026-02-17", type: "observance", added: false },
          { name: "Freedom Day", startDate: "2026-04-25", endDate: "2026-04-25", type: "public", added: true },
        ],
      },
    }));
    api.on("POST /api/locations", (body) => ({ status: 201, body: { location: { id: "l2", ...(body as object) } } }));
    api.on("PATCH /api/resources/r-ana", (body) => ({ body: { resource: { ...ANA, ...(body as object) } } }));
    api.on("POST /api/locations/l-lisbon/holidays", () => ({ status: 201, body: { added: 1 } }));
    const { user } = renderApp("/team");

    await user.selectOptions(await screen.findByLabelText("Location of Ana"), "Lisbon office");
    expect(api.calls.find((c) => c.key === "PATCH /api/resources/r-ana")?.body).toEqual({ locationId: "l-lisbon" });
    await user.type(screen.getByLabelText("New location"), "Munich office");
    await user.click(screen.getByRole("button", { name: "Add location" }));
    expect(api.calls.find((c) => c.key === "POST /api/locations")?.body).toEqual({ name: "Munich office" });

    // Public holidays: days off by law come ticked, others not; ones already added can't be added again.
    await user.click(screen.getByRole("button", { name: "Public holidays…" }));
    const list = await screen.findByRole("list", { name: "Public holidays for Lisbon office" });
    expect(await within(list).findByRole("checkbox", { name: /New Year's Day/ })).toBeChecked();
    expect(within(list).getByRole("checkbox", { name: /Carnival/ })).not.toBeChecked();
    expect(within(list).getByRole("checkbox", { name: /Freedom Day/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add 1 holiday" }));
    expect(api.calls.find((c) => c.key === "POST /api/locations/l-lisbon/holidays")?.body).toEqual({
      holidays: [{ name: "New Year's Day", startDate: "2026-01-01", endDate: "2026-01-01" }],
    });
  });

  it("narrows the holiday list by name or year, and to a location or person", async () => {
    const LISBON = { id: "l-lisbon", name: "Lisbon office", country: "PT", region: null };
    const MUNICH = { id: "l-munich", name: "Munich office", country: "DE", region: null };
    const BEA: ResourceDto = { ...ANA, id: "r-bea", name: "Bea", locationId: "l-munich" };
    const holiday = (id: string, name: string, startDate: string, target: Partial<CalendarDto["holidays"][number]["target"]>) => ({
      id,
      name,
      startDate,
      endDate: startDate,
      appliesTo: "all" as const,
      target: { all: false, resourceIds: [], locationIds: [], ...target },
    });
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [{ ...ANA, locationId: "l-lisbon" }, BEA] } }));
    api.on("GET /api/calendar", () => ({
      body: {
        ...CALENDAR,
        locations: [LISBON, MUNICH],
        holidays: [
          holiday("h1", "Company retreat", "2026-06-01", { all: true }),
          holiday("h2", "Freedom Day", "2026-04-25", { locationIds: ["l-lisbon"] }),
          holiday("h3", "Oktoberfest day", "2026-10-02", { locationIds: ["l-munich"] }),
          holiday("h4", "Bea's birthday", "2027-03-01", { resourceIds: ["r-bea"] }),
        ],
      },
    }));
    const { user } = renderApp("/team");
    const shown = () => within(screen.getByRole("list", { name: "Holidays" })).getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent ?? item.textContent);
    await screen.findByRole("list", { name: "Holidays" });
    expect(shown()).toEqual(["Company retreat", "Freedom Day", "Oktoberfest day", "Bea's birthday"]);

    await user.click(screen.getByRole("button", { name: "Holidays for: Anyone" }));
    await user.type(screen.getByRole("combobox", { name: "Find a location or person" }), "bea{Enter}");
    expect(shown()).toEqual(["Company retreat", "Oktoberfest day", "Bea's birthday"]); // company-wide, her location's, hers

    await user.click(screen.getByRole("button", { name: "Holidays for: Bea" }));
    await user.type(screen.getByRole("combobox", { name: "Find a location or person" }), "lisbon{Enter}");
    expect(shown()).toEqual(["Company retreat", "Freedom Day"]);

    await user.click(screen.getByRole("button", { name: "Holidays for: Lisbon office" }));
    await user.click(screen.getByRole("option", { name: "Anyone" }));
    await user.type(screen.getByLabelText("Find a holiday"), "2027");
    expect(shown()).toEqual(["Bea's birthday"]);
    await user.clear(screen.getByLabelText("Find a holiday"));
    await user.type(screen.getByLabelText("Find a holiday"), "nothing like this");
    expect(shown()).toEqual(["No holidays match."]);
  });

  it("picks a location's country from a searchable list", async () => {
    const LISBON = { id: "l-lisbon", name: "Lisbon office", country: null, region: null };
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    api.on("GET /api/calendar", () => ({ body: { ...CALENDAR, locations: [LISBON] } }));
    api.on("GET /api/public-holidays/countries", () => ({ body: { countries: [{ code: "DE", name: "Germany" }, { code: "PT", name: "Portugal" }] } }));
    api.on("PUT /api/locations/l-lisbon", (body) => ({ body: { location: { ...LISBON, ...(body as object) } } }));
    const { user } = renderApp("/team");
    await user.click(await screen.findByRole("button", { name: "Country of Lisbon office: none" }));
    await user.type(screen.getByRole("combobox", { name: "Find a country" }), "portu{Enter}");
    expect(api.calls.find((c) => c.key === "PUT /api/locations/l-lisbon")?.body).toMatchObject({ country: "PT", region: null });
  });

  it("is read-only for viewers", async () => {
    teamApi(VIEWER);
    renderApp("/team");
    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add holiday" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New team member")).not.toBeInTheDocument();
  });
});
