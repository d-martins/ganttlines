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
});
