import { describe, expect, it } from "vitest";
import { ADMIN, fakeApi, project, renderApp, screen } from "./utils";

describe("getting in", () => {
  it("sends the first visitor to setup, then into the app", async () => {
    let setUp = false;
    const api = fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: !setUp } }),
      "GET /api/auth/me": () => (setUp ? { body: { user: ADMIN } } : { status: 401, body: { error: "unauthorized", message: "Please sign in" } }),
      "POST /api/setup": () => {
        setUp = true;
        return { status: 201, body: { user: ADMIN } };
      },
      "GET /api/projects": () => ({ body: { projects: [] } }),
    });
    const { user } = renderApp("/");
    expect(await screen.findByRole("heading", { name: "Welcome to GanttLines" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your name"), "Ada Admin");
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password (8+ characters)"), "long enough");
    await user.type(screen.getByLabelText("Setup code (from the server's log)"), "Q82FC-3CKAP");
    await user.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByText("No projects yet.", { selector: "p.text-text" })).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === "POST /api/setup")?.body).toEqual({ name: "Ada Admin", email: "admin@example.com", password: "long enough", setupCode: "Q82FC-3CKAP" });
  });

  it("asks signed-out people to sign in and shows wrong-password errors", async () => {
    let signedIn = false;
    fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: false } }),
      "GET /api/auth/me": () => (signedIn ? { body: { user: ADMIN } } : { status: 401, body: { error: "unauthorized", message: "Please sign in" } }),
      "POST /api/auth/login": (body) => {
        if ((body as { password: string }).password !== "right password") return { status: 401, body: { error: "invalid_credentials", message: "Wrong email or password" } };
        signedIn = true;
        return { body: { user: ADMIN } };
      },
      "GET /api/projects": () => ({ body: { projects: [project("p1", "Launch")] } }),
    });
    const { user, router } = renderApp("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong email or password");
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "right password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("link", { name: "Launch" });
    expect(router.state.location.pathname).toBe("/p/p1");
  });

  it("offers single sign-on when it's set up, keeping where to go back to, and explains failed attempts", async () => {
    fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: false } }),
      "GET /api/auth/me": () => ({ status: 401, body: { error: "unauthorized", message: "Please sign in" } }),
      "GET /api/auth/providers": () => ({ body: { oidc: { name: "Google" } } }),
    });
    renderApp("/login?redirect=%2Fp%2Fp1&error=sso_no_account");
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/api/auth/oidc/start?redirect=%2Fp%2Fp1");
    expect(screen.getByRole("alert")).toHaveTextContent("There's no account for you here yet — ask an admin to add you");
    expect(screen.getByLabelText("Password")).toBeInTheDocument(); // passwords still work
  });

  it("makes people with a temporary password choose a new one first", async () => {
    fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: false } }),
      "GET /api/auth/me": () => ({ body: { user: { ...ADMIN, mustChangePassword: true } } }),
    });
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
  });
});
