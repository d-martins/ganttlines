import type { CalendarDto, ResourceDto, UserDto } from "@ganttlines/protocol";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ADMIN, fakeApi, GUEST, project, renderApp, screen, signedIn } from "./utils";

const CALENDAR: CalendarDto = { instanceVersion: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [], timeOff: [], locations: [] };
const ANA: ResourceDto = { id: "r-ana", name: "Ana", avatarColor: "#4f8cff", inactive: false, userId: null, locationId: null };
const RUDY: UserDto = { id: "u-rudy", email: "rudy@example.com", name: "Rudy", role: "editor", mustChangePassword: false, twoFactor: false };
const unauthorized = { status: 401, body: { error: "unauthorized", message: "Please sign in" } };

/** A server whose session can expire and where different people can sign in. */
function expiringServer() {
  let user: UserDto | null = ADMIN;
  const api = fakeApi({
    "GET /api/setup": () => ({ body: { needsSetup: false } }),
    "GET /api/auth/me": () => (user ? { body: { user } } : unauthorized),
    "GET /api/projects": () => ({ body: { projects: user?.role === "guest" ? [] : [project("p1", "Secret plan")] } }),
    "GET /api/resources": () => ({ body: { resources: [ANA] } }),
    "GET /api/calendar": () => ({ body: CALENDAR }),
    "POST /api/resources": () => unauthorized,
  });
  return {
    api,
    expire: () => (user = null),
    signInAs: (next: UserDto) => api.on("POST /api/auth/login", () => ((user = next), { body: { user: next } })),
  };
}

describe("losing the session", () => {
  it("returns to sign-in when a request finds the session gone, then back to the same page", async () => {
    const server = expiringServer();
    server.signInAs(ADMIN);
    const { user, router } = renderApp("/team");
    await user.type(await screen.findByLabelText("New team member"), "Rudy");
    server.expire();
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ redirect: "/team" });
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("New team member");
    expect(router.state.location.pathname).toBe("/team");
  });

  it("never shows the previous person's data to the next one", async () => {
    const server = expiringServer();
    server.signInAs(GUEST);
    const { user, router } = renderApp("/team"); // the admin is signed in first
    expect(await screen.findByText("Secret plan")).toBeInTheDocument();
    await user.type(await screen.findByLabelText("New team member"), "x");
    server.expire();
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByRole("heading", { name: "Sign in" });
    await router.navigate({ to: "/login" }); // the guest signs in fresh, landing on the home page
    await user.type(await screen.findByLabelText("Email"), "client@example.com");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    // With the admin's cached project list, the guest would be sent to "Secret plan" (/p/p1).
    expect(await screen.findByText(/When someone shares a project with you/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByText("Secret plan")).not.toBeInTheDocument();
  });
});

describe("guests", () => {
  it("don't see the team calendar", async () => {
    signedIn(GUEST);
    renderApp("/");
    await screen.findByText(/When someone shares a project with you/);
    expect(screen.queryByRole("link", { name: /Team/ })).not.toBeInTheDocument();
  });
});

describe("loading and errors", () => {
  it("shows an error with a retry instead of empty lists", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    let fail = true;
    api.on("GET /api/calendar", () => (fail ? { status: 500, body: { error: "internal", message: "Something went wrong" } } : { body: CALENDAR }));
    const { user } = renderApp("/team");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(screen.queryByText("No holidays yet.")).not.toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No holidays yet.")).toBeInTheDocument();
  });
});

describe("admin safeguards", () => {
  it("doesn't offer resetting your own password or changing your own role; asks before resetting others", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/users", () => ({ body: { users: [ADMIN, RUDY] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    api.on("POST /api/users/u-rudy/reset-password", () => ({ body: { temporaryPassword: "New-Temp-Pass-99" } }));
    const { user } = renderApp("/settings");
    expect(await screen.findByLabelText("Role of Ada Admin")).toBeDisabled();
    const resetButtons = screen.getAllByRole("button", { name: "Reset password" });
    expect(resetButtons).toHaveLength(1);
    await user.click(resetButtons[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Reset Rudy's password?" });
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(await screen.findByRole("status")).toHaveTextContent("New-Temp-Pass-99");
  });
});

describe("color picker", () => {
  it("saves only the final color, not every step while dragging", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [ANA] } }));
    api.on("GET /api/calendar", () => ({ body: CALENDAR }));
    api.on("PATCH /api/resources/r-ana", () => ({ body: { resource: ANA } }));
    renderApp("/team");
    const picker = await screen.findByLabelText("Color of Ana");
    for (const color of ["#111111", "#222222", "#333333"]) fireEvent.input(picker, { target: { value: color } });
    expect(api.calls.filter((c) => c.key === "PATCH /api/resources/r-ana")).toHaveLength(0);
    fireEvent.change(picker, { target: { value: "#333333" } });
    await waitFor(() => expect(api.calls.filter((c) => c.key === "PATCH /api/resources/r-ana").map((c) => c.body)).toEqual([{ avatarColor: "#333333" }]));
  });
});
