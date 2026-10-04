import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../api/client";
import {
  currentUser,
  setupStatus,
  signInProviders,
  useChangePassword,
  useChoosePassword,
  useLogin,
  useLoginCode,
  useLogout,
  useRequestPasswordReset,
  useSetup,
} from "../api/queries";
import { Button } from "../ui/button";
import { ErrorText, Field } from "../ui/field";
import { TwoFactorSetup } from "./two-factor-setup";

function Card({ title, subtitle, children }: { title: string; subtitle?: string | undefined; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-surface p-6">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-bg p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
        </div>
        {children}
      </div>
    </main>
  );
}

function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

export function SetupPage() {
  const navigate = useNavigate();
  const status = useQuery(setupStatus);
  const setup = useSetup();
  const providers = useQuery(signInProviders);
  const [values, setValues] = useState({ name: "", email: "", password: "", setupCode: "" });
  if (status.data && !status.data.needsSetup && !setup.isSuccess) return <Navigate to="/" />;
  const sso = providers.data?.oidc?.firstAdmin ? providers.data.oidc : null;
  return (
    <Card title="Welcome to GanttLines" subtitle="Create the admin account to get started.">
      {sso ? (
        <>
          <a href="/api/auth/oidc/start" className="flex justify-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-text hover:opacity-90">
            Sign in with {sso.name} to become the admin
          </a>
          <p className="text-xs text-muted">Only the account this server was set up for (ADMIN_EMAIL, or the allowed email domains) can.</p>
          <p className="flex items-center gap-2 text-xs text-muted before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">or with a password</p>
        </>
      ) : null}
      <p className="text-sm text-muted">
        To prove you run this server, enter the setup code it printed in its log (e.g. <code className="text-text">docker compose logs app</code>).
      </p>
      <Form onSubmit={() => setup.mutate(values, { onSuccess: () => navigate({ to: "/" }) })}>
        <Field label="Your name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} required autoFocus />
        <Field label="Email" type="email" value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} required />
        <Field label="Password (8+ characters)" type="password" value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} minLength={8} required />
        <Field label="Setup code (from the server's log)" value={values.setupCode} onChange={(e) => setValues({ ...values, setupCode: e.target.value })} autoComplete="off" spellCheck={false} required />
        <ErrorText>{setup.error ? errorMessage(setup.error) : null}</ErrorText>
        <Button type="submit" variant="primary" disabled={setup.isPending}>
          Create admin account
        </Button>
      </Form>
    </Card>
  );
}

/** Why a single sign-on attempt failed (the server sends people back with ?error=…). */
const SSO_ERRORS: Record<string, string> = {
  sso_no_account: "There's no account for you here yet — ask an admin to add you, then try again.",
  sso_setup_pending: "This server has no admin yet. Its admin signs in first (or creates the account with the setup code from the server's log).",
  sso_domain: "Accounts from that email domain can't sign in here.",
  sso_unverified: "Your sign-in provider didn't confirm your email address.",
  sso_failed: "Signing in didn't work. Please try again.",
};

export function LoginPage() {
  const navigate = useNavigate();
  const { redirect, error } = useSearch({ from: "/login" });
  const me = useQuery(currentUser);
  const providers = useQuery(signInProviders);
  const login = useLogin();
  const [values, setValues] = useState({ email: "", password: "" });
  const [challenge, setChallenge] = useState<string | null>(null);
  // Already signed in (e.g. a second tab): go straight back.
  if (me.data && !login.isPending) return <Navigate to={redirect ?? "/"} />;
  if (challenge) return <TwoFactorStep challenge={challenge} onDone={() => navigate({ to: redirect ?? "/" })} />;
  const sso = providers.data?.oidc;
  return (
    <Card title="Sign in" subtitle={sso ? undefined : "Use the email and password your admin gave you."}>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {SSO_ERRORS[error] ?? SSO_ERRORS["sso_failed"]}
        </p>
      ) : null}
      {sso ? (
        <>
          <a
            href={`/api/auth/oidc/start${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""}`}
            className="flex justify-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-text hover:opacity-90"
          >
            Sign in with {sso.name}
          </a>
          <p className="flex items-center gap-2 text-xs text-muted before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">or with a password</p>
        </>
      ) : null}
      <Form onSubmit={() => login.mutate(values, { onSuccess: (result) => (result.twoFactor ? setChallenge(result.twoFactor.challenge) : navigate({ to: redirect ?? "/" })) })}>
        <Field label="Email" type="email" value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} required autoFocus />
        <Field label="Password" type="password" value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} required />
        <ErrorText>{login.error ? errorMessage(login.error) : null}</ErrorText>
        <Button type="submit" variant="primary" disabled={login.isPending}>
          Sign in
        </Button>
      </Form>
      {providers.data?.passwordReset ? (
        <Link to="/forgot-password" className="text-sm text-accent hover:underline">
          Forgot your password?
        </Link>
      ) : null}
    </Card>
  );
}

/** Also used inside Settings; `onDone` defaults to going home. */
export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const navigate = useNavigate();
  const change = useChangePassword();
  const [values, setValues] = useState({ currentPassword: "", newPassword: "" });
  const [saved, setSaved] = useState(false);
  return (
    <Form
      onSubmit={() =>
        change.mutate(values, {
          onSuccess: () => {
            setValues({ currentPassword: "", newPassword: "" });
            setSaved(true);
            if (onDone) onDone();
            else void navigate({ to: "/" });
          },
        })
      }
    >
      <Field label="Current password" type="password" value={values.currentPassword} onChange={(e) => setValues({ ...values, currentPassword: e.target.value })} required />
      <Field label="New password (8+ characters)" type="password" value={values.newPassword} onChange={(e) => setValues({ ...values, newPassword: e.target.value })} minLength={8} required />
      <ErrorText>{change.error ? errorMessage(change.error) : null}</ErrorText>
      {saved && !change.error ? <p className="text-sm text-muted">Password changed.</p> : null}
      <Button type="submit" variant="primary" disabled={change.isPending}>
        Change password
      </Button>
    </Form>
  );
}

/** "Forgot your password?": asks for the email and says what happens next (the same whether or not it has an account). */
export function ForgotPasswordPage() {
  const request = useRequestPasswordReset();
  const [email, setEmail] = useState("");
  return (
    <Card title="Forgot your password?" subtitle="We'll email you a link to choose a new one.">
      {request.isSuccess ? (
        <p role="status" className="text-sm">
          If <strong>{email}</strong> has an account here, a link is on its way. It works once, for an hour.
        </p>
      ) : (
        <Form onSubmit={() => request.mutate(email)}>
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <ErrorText>{request.error ? errorMessage(request.error) : null}</ErrorText>
          <Button type="submit" variant="primary" disabled={request.isPending}>
            Email me a link
          </Button>
        </Form>
      )}
      <Link to="/login" className="text-sm text-accent hover:underline">
        Back to sign in
      </Link>
    </Card>
  );
}

/** From an emailed invitation or reset link: choose a password, then go straight in. */
export function ChoosePasswordPage() {
  const { token } = useSearch({ from: "/reset-password" });
  if (!token) return <Navigate to="/forgot-password" />;
  // A fresh form for each link.
  return <ChoosePasswordForm key={token} token={token} />;
}

function ChoosePasswordForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const choose = useChoosePassword();
  const [password, setPassword] = useState("");
  // With two-factor on, an emailed link still needs the code.
  if (choose.data?.twoFactor) return <TwoFactorStep challenge={choose.data.twoFactor.challenge} onDone={() => navigate({ to: "/" })} />;
  return (
    <Card title="Choose your password" subtitle="You'll use it with your email to sign in.">
      <Form onSubmit={() => choose.mutate({ token, password }, { onSuccess: (result) => void (result.user && navigate({ to: "/" })) })}>
        <Field label="New password (8+ characters)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
        <ErrorText>{choose.error ? errorMessage(choose.error) : null}</ErrorText>
        <Button type="submit" variant="primary" disabled={choose.isPending}>
          Save and sign in
        </Button>
      </Form>
      {choose.error ? (
        <Link to="/forgot-password" className="text-sm text-accent hover:underline">
          Get a new link
        </Link>
      ) : null}
    </Card>
  );
}

/** The second sign-in step: a code from the authenticator app, or a recovery code. */
function TwoFactorStep({ challenge, onDone }: { challenge: string; onDone: () => void }) {
  const send = useLoginCode();
  const [code, setCode] = useState("");
  return (
    <Card title="Two-factor sign-in" subtitle="Enter the 6-digit code from your authenticator app.">
      <Form onSubmit={() => send.mutate({ challenge, code }, { onSuccess: onDone })}>
        <Field label="Code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required autoFocus />
        <ErrorText>{send.error ? errorMessage(send.error) : null}</ErrorText>
        <Button type="submit" variant="primary" disabled={send.isPending}>
          Sign in
        </Button>
      </Form>
      <p className="text-xs text-muted">Lost your phone? Use one of your recovery codes instead, or ask an admin to turn two-factor off for you.</p>
    </Card>
  );
}

export function ChangePasswordPage() {
  const me = useQuery(currentUser);
  if (me.data === null) return <Navigate to="/login" />;
  return (
    <Card title="Choose a new password" subtitle="You signed in with a temporary password. Pick your own to continue.">
      <ChangePasswordForm />
    </Card>
  );
}

/** Required by an admin: setting up two-factor comes before anything else. */
export function SetUpTwoFactorPage() {
  const me = useQuery(currentUser);
  const navigate = useNavigate();
  const logout = useLogout();
  if (me.data === null) return <Navigate to="/login" />;
  return (
    <Card title="Set up two-factor sign-in" subtitle="Your admin requires a code from an authenticator app when you sign in with a password.">
      <div className="text-sm">
        <TwoFactorSetup intro="It takes a minute: you'll scan a QR code with an app on your phone." onDone={() => void navigate({ to: "/" })} />
      </div>
      <Button variant="ghost" className="self-start" onClick={() => logout.mutate(undefined, { onSuccess: () => void navigate({ to: "/login" }) })}>
        Sign out
      </Button>
    </Card>
  );
}
