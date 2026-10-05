import { useTheme } from "../src/theme";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ADMIN, project, renderApp, screen, signedIn, VIEWER } from "./utils";

describe("sidebar and top bar", () => {
  it("lists projects, opens the last one used, and shows its name in the top bar", async () => {
    signedIn(ADMIN, [project("p1", "Launch"), project("p2", "Website")]);
    localStorage.setItem("gp.lastProject:u-admin", '"p2"');
    const { router } = renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Website" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/p2");
    expect(screen.getByRole("link", { name: "Launch" })).toBeInTheDocument();
  });

  it("loads the project list once for the sidebar, top bar and home page", async () => {
    const api = signedIn(ADMIN, [project("p1", "Launch"), { ...project("p2", "Old"), archived: true }]);
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Launch" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Old" })).not.toBeInTheDocument(); // archived ones stay folded away
    expect(api.calls.filter((call) => call.key === "GET /api/projects")).toHaveLength(1);
  });

  it("shows the account avatar in the person's own team color", async () => {
    const api = signedIn(ADMIN);
    api.on("GET /api/resources", () => ({ body: { resources: [{ id: "r1", name: ADMIN.name, avatarColor: "#e0569b", inactive: false, userId: ADMIN.id, locationId: null }] } }));
    renderApp("/");
    const avatar = (await screen.findByRole("button", { name: "Account menu" })).querySelector("span")!;
    await waitFor(() => expect(avatar.style.background).toBe("rgb(224, 86, 155)"));
  });

  it("signs out from the account menu", async () => {
    const api = signedIn(ADMIN);
    let out = false;
    api.on("POST /api/auth/logout", () => ((out = true), { status: 204 }));
    api.on("GET /api/auth/me", () => (out ? { status: 401, body: { error: "unauthorized", message: "Please sign in" } } : { body: { user: ADMIN } }));
    const { router, user } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(api.calls.some((call) => call.key === "POST /api/auth/logout")).toBe(true);
  });

  it("renames and archives a project from its actions menu", async () => {
    const projects = [project("p1", "Launch")];
    const api = signedIn(ADMIN, projects);
    api.on("PATCH /api/projects/p1", (body) => {
      Object.assign(projects[0]!, body);
      return { body: { project: projects[0] } };
    });
    const { user } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Actions for Launch" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const name = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(name);
    await user.type(name, "Liftoff{Enter}");
    expect(await screen.findByRole("link", { name: "Liftoff" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions for Liftoff" }));
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(api.calls.filter((call) => call.key === "PATCH /api/projects/p1").map((call) => call.body)).toEqual([{ name: "Liftoff" }, { archived: true }]);
  });

  it("tells a viewer without projects how to get one", async () => {
    signedIn(VIEWER, []);
    renderApp("/");
    expect(await screen.findByText(/When someone shares a project with you/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
  });

  it("creates projects inline (editors and admins only)", async () => {
    const projects = [project("p1", "Launch")];
    const api = signedIn(ADMIN, projects);
    api.on("POST /api/projects", (body) => {
      projects.push(project("p2", (body as { name: string }).name));
      return { status: 201, body: { project: projects[1] } };
    });
    const { user } = renderApp("/p/p1");
    await user.click(await screen.findByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("New project name"), "Roadmap{Enter}");
    expect(await screen.findByRole("link", { name: "Roadmap" })).toBeInTheDocument();
  });

  it("hides project management from viewers", async () => {
    signedIn(VIEWER, [project("p1", "Launch")]);
    renderApp("/p/p1");
    await screen.findByRole("link", { name: "Launch" });
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for Launch" })).not.toBeInTheDocument();
  });

  it("shows archived projects in their own collapsed group", async () => {
    signedIn(ADMIN, [project("p1", "Launch"), project("p9", "Old plan", true)]);
    const { user } = renderApp("/p/p1");
    const toggle = await screen.findByRole("button", { name: "Archived (1)" });
    expect(screen.queryByRole("link", { name: "Old plan" })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByRole("link", { name: "Old plan" })).toBeInTheDocument();
  });

  it("collapses to an icon rail with the bottom-right button, and remembers it", async () => {
    signedIn(ADMIN, [project("p1", "Launch")]);
    const { user } = renderApp("/p/p1");
    await user.click(await screen.findByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("link", { name: "Launch" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(localStorage.getItem("gp.sidebarCollapsed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("link", { name: "Launch" })).toBeInTheDocument();
  });

  it("switches theme from the account menu", async () => {
    signedIn(ADMIN, [project("p1", "Launch")]);
    const { user } = renderApp("/p/p1");
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });

  it("toggles light and dark with one click from the top bar", async () => {
    signedIn(ADMIN, [project("p1", "Launch")]);
    useTheme.getState().setPreference("system"); // the system is light here
    const { user } = renderApp("/p/p1");
    await user.click(await screen.findByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });
});
