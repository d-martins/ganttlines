import { MCP_SCOPE_LABELS, MCP_SCOPES, ROLES, TWO_FACTOR_REQUIREMENTS } from "@ganttlines/protocol/constants";
import type { McpConnectionDto, McpScope, Role, TwoFactorRequirement, UserDto } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, latestError } from "../api/client";
import {
  about,
  calendar,
  currentUser,
  mcpAvailable,
  mcpConnections,
  mcpSettings,
  useCreateMcpToken,
  useDisconnectApp,
  useSaveMcpSettings,
  useCreateUser,
  useDeleteUser,
  useResetPassword,
  userList,
  useAdminDisableTwoFactor,
  useDisableTwoFactor,
  useSendTestEmail,
  useSetRequireTwoFactor,
  useSetUpdateCheck,
  useSetWorkingWeekdays,
  useUpdateUser,
} from "../api/queries";
import { ChangePasswordForm } from "../auth/auth-pages";
import { TwoFactorSetup } from "../auth/two-factor-setup";
import { useTheme, type ThemePreference } from "../theme";
import { Button } from "../ui/button";
import { ConfirmButton } from "../ui/confirm";
import { ErrorText, Field } from "../ui/field";
import { CopyText } from "../ui/copy-text";
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
        <TwoFactorSettings me={me.data} />
      </Section>
      {me.data.role === "admin" ? (
        <>
          <UsersSection me={me.data} />
          <SignInSecuritySection me={me.data} />
          <AiAccessSection />
        </>
      ) : null}
      {me.data.role !== "guest" ? <ConnectedApps /> : null}
      {me.data.role === "admin" ? (
        <>
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
  const disableTwoFactor = useAdminDisableTwoFactor();
  const [form, setForm] = useState({ name: "", email: "", role: "editor" as Role, createResource: true });
  const [notice, setNotice] = useState<string | null>(null);
  const failure = latestError(create, update, reset, remove, disableTwoFactor);

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
                {user.id !== me.id && user.twoFactor ? (
                  <ConfirmButton
                    label="Turn off two-factor"
                    title={`Turn off two-factor sign-in for ${user.name}?`}
                    message="For someone who lost their authenticator app and recovery codes: they'll sign in with just their password, and can turn it on again."
                    confirmLabel="Turn off"
                    onConfirm={() => disableTwoFactor.mutate(user.id, { onSuccess: () => setNotice(`Two-factor sign-in is off for ${user.name}.`) })}
                  />
                ) : null}
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

/**
 * Two-factor sign-in for your own account: turn it on (scan the QR code, confirm a code, save the
 * recovery codes) or off (with your password) — unless an admin requires it.
 */
function TwoFactorSettings({ me }: { me: UserDto }) {
  const disable = useDisableTwoFactor();
  const info = useQuery(about);
  const [password, setPassword] = useState("");
  const required = info.data?.requireTwoFactor === "everyone" || (info.data?.requireTwoFactor === "admins" && me.role === "admin");
  return (
    <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4 text-sm">
      <h3 className="font-medium">Two-factor sign-in</h3>
      {!me.twoFactor ? (
        <TwoFactorSetup intro="Off. Add a code from an authenticator app to your password, so a stolen password isn't enough." />
      ) : required ? (
        <p>On: signing in with your password also asks for a code from your authenticator app. It's required, so it can't be turned off.</p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            disable.mutate(password, { onSuccess: () => setPassword("") });
          }}
        >
          <p className="w-full">On: signing in with your password also asks for a code from your authenticator app.</p>
          <Field label="Your password (to turn it off)" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <Button type="submit" disabled={disable.isPending}>
            Turn off
          </Button>
          <ErrorText>{disable.error ? errorMessage(disable.error) : null}</ErrorText>
        </form>
      )}
    </div>
  );
}

const REQUIREMENT_LABELS: Record<TwoFactorRequirement, string> = { off: "Not required", admins: "Required for admins", everyone: "Required for everyone" };

/** Admins: who must use two-factor when signing in with a password. */
function SignInSecuritySection({ me }: { me: UserDto }) {
  const info = useQuery(about);
  const save = useSetRequireTwoFactor();
  // The choice shows at once; it reverts if the server refuses it.
  const current = save.isPending ? save.variables : info.data?.requireTwoFactor;
  if (current === undefined) return null;
  return (
    <Section
      title="Two-factor sign-in"
      description="People it covers set it up the next time they open GanttLines. Signing in with single sign-on is exempt: your provider's own two-factor applies."
    >
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="sr-only">Who must use two-factor</legend>
        {TWO_FACTOR_REQUIREMENTS.map((requirement) => (
          <label key={requirement} className="flex items-center gap-2">
            <input type="radio" name="require-two-factor" checked={current === requirement} onChange={() => save.mutate(requirement)} />
            {REQUIREMENT_LABELS[requirement]}
          </label>
        ))}
        {!me.twoFactor && current === "off" ? <p className="text-xs text-muted">Turn it on for your own account (above) before requiring it.</p> : null}
      </fieldset>
      <ErrorText>{save.error ? errorMessage(save.error) : null}</ErrorText>
    </Section>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never");
const scopeNames = (scopes: McpScope[]) => scopes.map((scope) => MCP_SCOPE_LABELS[scope].label).join(", ");

const expiry = (connection: McpConnectionDto) =>
  connection.kind === "token" ? (connection.expiresAt ? ` · expires ${when(connection.expiresAt)}` : " · never expires") : "";

/**
 * The AI apps you've let use GanttLines as you (and your personal access tokens), with a way to
 * disconnect each — and to make a token for apps that take one instead of signing in.
 */
function ConnectedApps() {
  const connections = useQuery(mcpConnections(false));
  const available = useQuery(mcpAvailable);
  const disconnect = useDisconnectApp();
  const [creating, setCreating] = useState(false);
  // Shown even while AI access is off, so people can still disconnect apps; new ones need it on.
  const enabled = available.data?.enabled ?? false;
  return (
    <Section title="Connected AI apps" description="AI apps you've let use GanttLines as you, and your access tokens.">
      <div className="flex flex-col gap-2 text-sm">
        {connections.data?.length ? (
          <ul aria-label="Connected AI apps" className="divide-y divide-border">
            {connections.data.map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-medium">{connection.app}</span>
                {connection.kind === "token" ? <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">Access token</span> : null}
                <span className="text-muted">{scopeNames(connection.scopes)}</span>
                <span className="ml-auto text-xs text-muted">
                  last used {when(connection.lastUsedAt)}
                  {expiry(connection)}
                </span>
                <ConfirmButton
                  label="Disconnect"
                  confirmLabel="Disconnect"
                  title={`Disconnect ${connection.app}?`}
                  message={connection.kind === "token" ? "The token stops working at once." : "It can't use GanttLines as you any more, until you connect it again."}
                  onConfirm={() => disconnect.mutate(connection.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">
            {enabled
              ? `None yet. Add ${available.data?.url} to an AI app (for example Claude or ChatGPT) and approve it, or create an access token.`
              : "None. AI apps can connect once an admin turns AI access on."}
          </p>
        )}
        <ErrorText>{disconnect.error ? errorMessage(disconnect.error) : null}</ErrorText>
        {enabled && available.data && available.data.scopes.length > 0 ? (
          creating ? (
            <NewAccessToken scopes={available.data.scopes} url={available.data.url} onDone={() => setCreating(false)} />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setCreating(true)}>Create an access token</Button>
              <span className="text-xs text-muted">For AI apps that take a token instead of signing in (address: {available.data.url}).</span>
            </div>
          )
        ) : null}
      </div>
    </Section>
  );
}

/** Making a personal access token: what it's for, what it may do, how long it lasts; then the token, once. */
function NewAccessToken({ scopes, url, onDone }: { scopes: McpScope[]; url: string; onDone: () => void }) {
  const create = useCreateMcpToken();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<McpScope[]>(scopes.filter((scope) => scope !== "team:write"));
  const [days, setDays] = useState<"30" | "90" | "365" | "never">("90");
  if (create.data) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p role="status">Copy the token now — it won't be shown again. Anyone with it can act as you within what it may do.</p>
        <CopyText label="New access token" value={create.data.token} />
        <p className="text-xs text-muted">
          Give the app the address {url} and the header <code>Authorization: Bearer …</code> with this token.
        </p>
        <Button className="self-start" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ name: name.trim(), scopes: chosen, expiresInDays: days === "never" ? null : (Number(days) as 30 | 90 | 365) });
      }}
    >
      <Field label="What it's for" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Cursor on my laptop" required />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted">It may</legend>
        {scopes.map((scope) => (
          <label key={scope} className="flex items-center gap-2">
            <input type="checkbox" checked={chosen.includes(scope)} onChange={() => setChosen(chosen.includes(scope) ? chosen.filter((other) => other !== scope) : [...chosen, scope])} />
            {MCP_SCOPE_LABELS[scope].label}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2">
        Expires
        <select aria-label="Expires" value={days} onChange={(event) => setDays(event.target.value as typeof days)} className="rounded border border-border-strong bg-bg px-1 py-0.5">
          <option value="30">in 30 days</option>
          <option value="90">in 90 days</option>
          <option value="365">in a year</option>
          <option value="never">never</option>
        </select>
      </label>
      <ErrorText>{create.error ? errorMessage(create.error) : null}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!name.trim() || chosen.length === 0 || create.isPending}>
          Create token
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

/** Admins: whether AI apps may connect over MCP, which tool groups they may get, and everyone's connections. */
function AiAccessSection() {
  const settings = useQuery(mcpSettings);
  const save = useSaveMcpSettings();
  const everyone = useQuery(mcpConnections(true));
  const disconnect = useDisconnectApp();
  if (!settings.data) return null;
  // Changes show at once; they revert if the server refuses them.
  const { enabled, scopes, url } = save.isPending && save.variables ? { ...settings.data, ...save.variables } : settings.data;
  const change = (next: Partial<{ enabled: boolean; scopes: McpScope[] }>) => save.mutate({ enabled, scopes, ...next });
  return (
    <Section
      title="AI access (MCP)"
      description="Lets AI apps such as Claude, ChatGPT or Cursor read and edit plans as the person who connects them. Each person approves each app, and can give it less than allowed here; roles still apply (viewers' apps only read)."
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(event) => change({ enabled: event.target.checked })} />
          Allow AI apps to connect
        </label>
        {enabled ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-muted">Address to give AI apps:</span>
              <CopyText label="MCP server address" value={url} />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium text-muted">What AI apps may be allowed to do</legend>
              {MCP_SCOPES.map((scope) => (
                <label key={scope} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopes.includes(scope)}
                    onChange={() => change({ scopes: scopes.includes(scope) ? scopes.filter((other) => other !== scope) : [...scopes, scope] })}
                  />
                  <span>
                    {MCP_SCOPE_LABELS[scope].label}
                    <span className="block text-xs text-muted">{MCP_SCOPE_LABELS[scope].detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </>
        ) : (
          <p className="text-muted">Off: AI apps can't connect, and apps connected earlier are refused until it's back on.</p>
        )}
        <ErrorText>{save.error ? errorMessage(save.error) : null}</ErrorText>
        {everyone.data?.length ? (
          <div className="flex flex-col gap-1">
            <h3 className="font-medium">Connected apps</h3>
            <ul aria-label="Everyone's connected AI apps" className="divide-y divide-border">
              {everyone.data.map((connection) => (
                <li key={connection.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="font-medium">{connection.user?.name}</span>
                  <span>
                    {connection.app}
                    {connection.kind === "token" ? " (access token)" : ""}
                  </span>
                  <span className="text-muted">{scopeNames(connection.scopes)}</span>
                  <span className="ml-auto text-xs text-muted">last used {when(connection.lastUsedAt)}</span>
                  <ConfirmButton
                    label="Disconnect"
                confirmLabel="Disconnect"
                    title={`Disconnect ${connection.user?.name}'s ${connection.app}?`}
                    message="It stops working at once; they can connect it again."
                    onConfirm={() => disconnect.mutate(connection.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
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
