import { ROLES, type Role, type UserDto } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/client";
import {
  about,
  calendar,
  currentUser,
  useCreateUser,
  useDeleteUser,
  useResetPassword,
  userList,
  useSendTestEmail,
  useSetUpdateCheck,
  useSetWorkingWeekdays,
  useUpdateUser,
} from "../api/queries";
import { ChangePasswordForm } from "../auth/auth-pages";
import { useTheme, type ThemePreference } from "../theme";
import { Button } from "../ui/button";
import { ConfirmButton } from "../ui/confirm";
import { ErrorText, Field } from "../ui/field";
import { Section, WEEKDAYS } from "../ui/section";

export function SettingsPage() {
  const me = useQuery(currentUser);
  if (!me.data) return null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <Section title="Your account" description={`${me.data.name} · ${me.data.email}`}>
        <div className="grid gap-6 sm:grid-cols-2">
          <ChangePasswordForm onDone={() => {}} />
          <ThemeChoice />
        </div>
      </Section>
      {me.data.role === "admin" ? (
        <>
          <UsersSection me={me.data} />
          <WorkingWeekdaysSection />
          <EmailSection />
        </>
      ) : null}
      <AboutSection />
    </div>
  );
}

function ThemeChoice() {
  const { preference, setPreference } = useTheme();
  const options: { value: ThemePreference; label: string }[] = [
    { value: "system", label: "Match my system" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-muted">Theme (this browser)</legend>
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <input type="radio" name="theme" checked={preference === option.value} onChange={() => setPreference(option.value)} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

const ROLE_LABELS: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer", guest: "Guest (share links only)" };

function UsersSection({ me }: { me: UserDto }) {
  const users = useQuery(userList);
  const create = useCreateUser();
  const update = useUpdateUser();
  const reset = useResetPassword();
  const remove = useDeleteUser();
  const [form, setForm] = useState({ name: "", email: "", role: "editor" as Role, createResource: true });
  const [notice, setNotice] = useState<string | null>(null);
  const failure = create.error ?? update.error ?? reset.error ?? remove.error;

  return (
    <Section title="Users" description="People who can sign in. New users get an email to choose their password (or, without email set up, a temporary password to pass on).">
      <table className="mb-4 w-full table-fixed text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-medium">Person</th>
            <th className="w-40 py-1 font-medium">Role</th>
            <th className="w-52" />
          </tr>
        </thead>
        <tbody>
          {users.data?.map((user) => (
            <tr key={user.id} className="border-t border-border">
              <td className="py-2 pr-2">
                <div className="truncate">{user.name}</div>
                <div className="truncate text-xs text-muted">{user.email}</div>
              </td>
              <td className="py-2">
                <select
                  aria-label={`Role of ${user.name}`}
                  value={user.role}
                  disabled={user.id === me.id}
                  title={user.id === me.id ? "Another admin has to change your role" : undefined}
                  onChange={(event) => update.mutate({ id: user.id, role: event.target.value as Role })}
                  className="w-full rounded border border-border-strong bg-bg px-1 py-0.5 disabled:opacity-60"
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </td>
              <td className="whitespace-nowrap py-2 text-right">
                {/* Your own password is changed above; resetting it here would sign you out everywhere. */}
                {user.id !== me.id ? (
                  <ConfirmButton
                    label="Reset password"
                    title={`Reset ${user.name}'s password?`}
                    message="They are signed out everywhere and must sign in with a new temporary password, which you'll see here."
                    confirmLabel="Reset"
                    onConfirm={() =>
                      reset.mutate(user.id, { onSuccess: ({ temporaryPassword }) => setNotice(`New temporary password for ${user.name}: ${temporaryPassword}`) })
                    }
                  />
                ) : null}
                {user.id !== me.id ? (
                  <ConfirmButton
                    label="Delete"
                    title={`Delete ${user.name}?`}
                    message="They can no longer sign in. Their team member (and task assignments) stays."
                    onConfirm={() => remove.mutate(user.id)}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="grid items-end gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(form, {
            onSuccess: ({ user, invited, temporaryPassword, inviteFailed }) => {
              setNotice(
                invited
                  ? `Invitation sent to ${user.email}: they'll choose their own password.`
                  : `Created ${user.name}.${inviteFailed ? " The invitation email couldn't be sent." : ""} Temporary password: ${temporaryPassword}`,
              );
              setForm({ name: "", email: "", role: "editor", createResource: true });
            },
          });
        }}
      >
        <Field label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <Field label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text">
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={form.createResource} onChange={(e) => setForm({ ...form, createResource: e.target.checked })} />
          Also add them as a team member (so tasks can be assigned to them)
        </label>
        <Button type="submit" variant="primary" disabled={create.isPending} className="justify-center">
          Add user
        </Button>
      </form>
      {notice ? (
        <p role="status" className="mt-3 rounded-md bg-accent-soft px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      <ErrorText>{failure ? errorMessage(failure) : null}</ErrorText>
    </Section>
  );
}

/** Whether outgoing email is set up (it's configured on the server), and a test to check it works. */
function EmailSection() {
  const info = useQuery(about);
  const test = useSendTestEmail();
  const configured = info.data?.mail?.configured;
  if (configured === undefined) return null;
  return (
    <Section
      title="Email"
      description={
        configured
          ? "Used for invitations and password resets."
          : "Not set up: new users get a temporary password to pass on, and there's no “Forgot your password?”. Add the SMTP_* settings on the server to turn it on."
      }
    >
      {configured ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button disabled={test.isPending} onClick={() => test.mutate()}>
            Send me a test email
          </Button>
          {test.isSuccess ? <span role="status">Sent to {test.data.sentTo} — check your inbox.</span> : null}
          <ErrorText>{test.error ? errorMessage(test.error) : null}</ErrorText>
        </div>
      ) : null}
    </Section>
  );
}

/** The running version; admins also see whether a newer release is out and can switch the check off. */
function AboutSection() {
  const info = useQuery(about);
  const setCheck = useSetUpdateCheck();
  if (!info.data) return null;
  const { version, updates } = info.data;
  return (
    <Section title="About" description={`GanttLines ${version === "dev" ? "(development build)" : version}`}>
      {updates ? (
        <div className="flex flex-col gap-2 text-sm">
          {updates.available && updates.latest ? (
            <p role="status" className="rounded-md bg-accent-soft px-3 py-2">
              GanttLines {updates.latest.version} is available.{" "}
              <a href={updates.latest.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">
                What's new and how to update
              </a>
            </p>
          ) : updates.enabled && updates.latest ? (
            <p className="text-muted">You're on the latest version.</p>
          ) : null}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={updates.enabled} disabled={setCheck.isPending} onChange={(event) => setCheck.mutate(event.target.checked)} />
            Check for new versions
          </label>
          <p className="text-xs text-muted">About once a day the server asks GitHub for the latest release. Nothing about your projects or people is sent.</p>
          <ErrorText>{setCheck.error ? errorMessage(setCheck.error) : null}</ErrorText>
        </div>
      ) : null}
    </Section>
  );
}

function WorkingWeekdaysSection() {
  const current = useQuery(calendar);
  const save = useSetWorkingWeekdays();
  const [draft, setDraft] = useState<number[] | null>(null);
  const days = draft ?? current.data?.workingWeekdays ?? [];
  const toggle = (day: number) => setDraft(days.includes(day) ? days.filter((d) => d !== day) : [...days, day]);
  return (
    <Section title="Working days" description="Tasks are scheduled on these weekdays only (holidays and time off are managed under Team & calendar).">
      <div className="flex flex-wrap items-center gap-3">
        {WEEKDAYS.map((day) => (
          <label key={day.value} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={days.includes(day.value)} onChange={() => toggle(day.value)} />
            {day.label}
          </label>
        ))}
        <Button variant="primary" disabled={draft === null || days.length === 0 || save.isPending} onClick={() => save.mutate(days, { onSuccess: () => setDraft(null) })}>
          Save
        </Button>
      </div>
      <ErrorText>{save.error ? errorMessage(save.error) : null}</ErrorText>
    </Section>
  );
}
