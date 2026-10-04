import { MCP_SCOPE_LABELS, type McpScope } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage } from "../api/client";
import { currentUser, oauthRequest, useOAuthConsent } from "../api/queries";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/field";

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-surface p-6">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-bg p-6 text-sm shadow-sm">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Sends the browser back to the app (its address can be another site, or an app's own scheme). */
const leaveFor = (url: string) => window.location.assign(url);

/**
 * "Allow access?": an AI app asks to use GanttLines as the signed-in person. They pick which tool
 * groups it gets (only those the admin allows and their role permits), then go back to the app.
 */
export function ConnectPage() {
  const { request, error } = useSearch({ from: "/connect" });
  const me = useQuery(currentUser);
  const pending = useQuery({ ...oauthRequest(request ?? ""), enabled: Boolean(request && me.data && !me.data.mustChangePassword && !me.data.mustSetUpTwoFactor) });
  const consent = useOAuthConsent();
  const [chosen, setChosen] = useState<McpScope[] | null>(null);

  if (error || !request) {
    return (
      <Frame title="Couldn't connect the app">
        <p role="alert">{error ?? "This link is missing the app's request."}</p>
        <p className="text-muted">Start connecting again from the AI app.</p>
      </Frame>
    );
  }
  if (me.isPending) return <p className="p-6 text-muted">Loading…</p>;
  if (!me.data) return <Navigate to="/login" search={{ redirect: `/connect?request=${encodeURIComponent(request)}` }} />;
  if (me.data.mustChangePassword) return <Navigate to="/change-password" />;
  if (me.data.mustSetUpTwoFactor) return <Navigate to="/set-up-two-factor" />;
  if (pending.isPending) return <p className="p-6 text-muted">Loading…</p>;
  if (pending.error || !pending.data) {
    return (
      <Frame title="Couldn't connect the app">
        <p role="alert">{errorMessage(pending.error)}</p>
      </Frame>
    );
  }

  const { app, scopes } = pending.data;
  const grantable = scopes.filter((entry) => entry.grantable);
  const selected = chosen ?? grantable.filter((entry) => entry.requested).map((entry) => entry.scope);
  const toggle = (scope: McpScope) => setChosen(selected.includes(scope) ? selected.filter((other) => other !== scope) : [...selected, scope]);
  const answer = (approve: boolean) => consent.mutate({ request, approve, scopes: approve ? selected : [] }, { onSuccess: ({ redirect }) => leaveFor(redirect) });

  return (
    <Frame title={`Allow ${app.name} to use GanttLines?`}>
      <p>
        <strong>{app.name}</strong> will act as you ({me.data.name}): what it does shows up as yours, “via {app.name}”. You'll go back to{" "}
        <strong>{app.redirectHost}</strong> afterwards.
      </p>
      {grantable.length === 0 ? (
        <p role="alert">There's nothing you can let an AI app do on this server — ask an admin.</p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-muted">It may</legend>
          {grantable.map(({ scope }) => (
            <label key={scope} className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={selected.includes(scope)} onChange={() => toggle(scope)} />
              <span>
                {MCP_SCOPE_LABELS[scope].label}
                <span className="block text-xs text-muted">{MCP_SCOPE_LABELS[scope].detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-xs text-muted">You can disconnect it any time under Settings → Connected AI apps.</p>
      <ErrorText>{consent.error ? errorMessage(consent.error) : null}</ErrorText>
      <div className="flex gap-2">
        <Button variant="primary" disabled={selected.length === 0 || consent.isPending} onClick={() => answer(true)}>
          Allow
        </Button>
        <Button disabled={consent.isPending} onClick={() => answer(false)}>
          Deny
        </Button>
      </div>
    </Frame>
  );
}
