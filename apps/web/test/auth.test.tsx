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

  it("emails a reset link when asked, and a link lets you choose a password and go straight in", async () => {
    let signedIn = false;
    const api = fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: false } }),
      "GET /api/auth/me": () => (signedIn ? { body: { user: ADMIN } } : { status: 401, body: { error: "unauthorized", message: "Please sign in" } }),
      "GET /api/auth/providers": () => ({ body: { oidc: null, passwordReset: true } }),
      "POST /api/auth/forgot": () => ({ status: 204 }),
      "POST /api/auth/reset": (body) => {
        if ((body as { token: string }).token === "used-up-token") return { status: 400, body: { error: "invalid_token", message: "This link has expired or was already used — ask for a new one" } };
        signedIn = true;
        return { body: { user: ADMIN } };
      },
      "GET /api/projects": () => ({ body: { projects: [] } }),
    });
    const { user, router } = renderApp("/login");
    await user.click(await screen.findByRole("link", { name: "Forgot your password?" }));
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByRole("status")).toHaveTextContent("If admin@example.com has an account here, a link is on its way");
    expect(api.calls.find((c) => c.key === "POST /api/auth/forgot")?.body).toEqual({ email: "admin@example.com" });

    await router.navigate({ to: "/reset-password", search: { token: "used-up-token" } });
    await user.type(await screen.findByLabelText("New password (8+ characters)"), "a new password");
    await user.click(screen.getByRole("button", { name: "Save and sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This link has expired or was already used");
    expect(screen.getByRole("link", { name: "Get a new link" })).toBeInTheDocument();

    await router.navigate({ to: "/reset-password", search: { token: "fresh-token-123" } });
    await user.type(await screen.findByLabelText("New password (8+ characters)"), "a new password");
    await user.click(screen.getByRole("button", { name: "Save and sign in" }));
    expect(await screen.findByText("No projects yet.", { selector: "p.text-text" })).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === "POST /api/auth/reset" && (c.body as { token: string }).token === "fresh-token-123")?.body).toEqual({
      token: "fresh-token-123",
      password: "a new password",
    });
  });

  it("asks for the authenticator code after the password when two-factor is on", async () => {
    let signedIn = false;
    const api = fakeApi({
      "GET /api/setup": () => ({ body: { needsSetup: false } }),
      "GET /api/auth/me": () => (signedIn ? { body: { user: ADMIN } } : { status: 401, body: { error: "unauthorized", message: "Please sign in" } }),
      "POST /api/auth/login": () => ({ body: { twoFactor: { challenge: "proof-of-password" } } }),
      "POST /api/auth/login/2fa": (body) => {
        if ((body as { code: string }).code !== "123456") return { status: 401, body: { error: "wrong_code", message: "That code isn't right (or was already used)" } };
        signedIn = true;
        return { body: { user: ADMIN } };
      },
      "GET /api/projects": () => ({ body: { projects: [] } }),
    });
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "right password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Two-factor sign-in" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Code"), "000000");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right");
    await user.clear(screen.getByLabelText("Code"));
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("No projects yet.", { selector: "p.text-text" })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.key === "POST /api/auth/login/2fa").map((c) => c.body)).toEqual([
      { challenge: "proof-of-password", code: "000000" },
      { challenge: "proof-of-password", code: "123456" },
    ]);
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
