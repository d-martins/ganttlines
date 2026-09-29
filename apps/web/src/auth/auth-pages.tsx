import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../api/client";
import { useChangePassword, useLogin, useSetup } from "../api/queries";
import { Button } from "../ui/button";
import { ErrorText, Field } from "../ui/field";

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-surface p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg p-6 shadow-sm">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mb-4 text-sm text-muted">{subtitle}</p>
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
  const setup = useSetup();
  const [values, setValues] = useState({ name: "", email: "", password: "" });
  return (
    <Card title="Welcome to GanttLines" subtitle="Create the admin account to get started.">
      <Form onSubmit={() => setup.mutate(values, { onSuccess: () => navigate({ to: "/" }) })}>
        <Field label="Your name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} required autoFocus />
        <Field label="Email" type="email" value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} required />
        <Field label="Password (8+ characters)" type="password" value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} minLength={8} required />
        <ErrorText>{setup.error ? errorMessage(setup.error) : null}</ErrorText>
        <Button type="submit" variant="primary" disabled={setup.isPending}>
          Create admin account
        </Button>
      </Form>
    </Card>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const [values, setValues] = useState({ email: "", password: "" });
  return (
    <Card title="Sign in" subtitle="Use the email and password your admin gave you.">
      <Form onSubmit={() => login.mutate(values, { onSuccess: () => navigate({ to: "/" }) })}>
        <Field label="Email" type="email" value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} required autoFocus />
        <Field label="Password" type="password" value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} required />
        <ErrorText>{login.error ? errorMessage(login.error) : null}</ErrorText>
        <Button type="submit" variant="primary" disabled={login.isPending}>
          Sign in
        </Button>
      </Form>
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

export function ChangePasswordPage() {
  return (
    <Card title="Choose a new password" subtitle="You signed in with a temporary password. Pick your own to continue.">
      <ChangePasswordForm />
    </Card>
  );
}
