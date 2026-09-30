import type { ShareInfoDto, UserDto } from "@ganttlines/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Eye, PencilLine } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { ApiError, errorMessage, setShareToken } from "../api/client";
import { currentUser, keys, shareInfo, useVisitorName } from "../api/queries";
import { useActiveBoard } from "../board/active-board";
import { BoardScreen } from "../board/board-page";
import { ThemeToggle } from "../app/theme-toggle";
import { BoardTools } from "../board/board-tools";
import { Button } from "../ui/button";
import { ErrorText, Field } from "../ui/field";
import { Toaster } from "../ui/toast";

/** A person who can see boards without a link: signed in, not a guest, password in order. */
const isMember = (user: UserDto | null | undefined) => Boolean(user && user.role !== "guest" && !user.mustChangePassword);

/**
 * `/s/:token` — a board opened through a share link. Works out what the visitor still needs to do
 * (sign in for sign-in links; pick a display name for anonymous ones), then shows the board in link
 * mode: no sidebar, every request carries the link's token, and a banner says it's a shared view.
 */
export function SharePage() {
  const { token } = useParams({ from: "/s/$token" });
  const client = useQueryClient();
  // Set while rendering, so the board's first requests already carry the token; cleared on leaving.
  setShareToken(token);
  useEffect(() => {
    setShareToken(token);
    return () => {
      setShareToken(null);
      // What was loaded through the link (e.g. the calendar without time-off notes) isn't reused elsewhere.
      client.removeQueries({ queryKey: keys.calendar });
      client.removeQueries({ queryKey: keys.resources });
    };
  }, [token, client]);
  const me = useQuery(currentUser);
  const info = useQuery(shareInfo(token));

  if (info.isPending || me.isPending) return <Centered>Opening the shared board…</Centered>;
  if (info.error) return <LinkProblem error={info.error} onRetry={() => void info.refetch()} />;
  const link = info.data;
  if (link.needsSignIn) return <SignInFirst token={token} link={link} />;
  if (link.access === "anonymous" && !isMember(me.data) && !link.visitor) return <ChooseName token={token} link={link} />;
  return (
    <div className="flex h-full flex-col">
      <LinkHeader link={link} viewer={isMember(me.data) || link.access === "authenticated" ? (me.data?.name ?? null) : link.visitor ? `${link.visitor.name} (anonymous)` : null} />
      <main className="min-h-0 flex-1">
        <BoardScreen projectId={link.project.id} share={{ token, collaboration: link.collaboration }} />
      </main>
      <Toaster />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-muted">{children}</div>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-surface p-6">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-bg p-6 shadow-sm">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function LinkProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 410) {
    return (
      <Card title="This link was turned off">
        <p className="text-sm text-muted">Whoever shared it has stopped sharing through this link. Ask them for a new one.</p>
      </Card>
    );
  }
  if (status === 404) {
    return (
      <Card title="This link doesn't work">
        <p className="text-sm text-muted">It may be mistyped, or the project it opened was deleted.</p>
      </Card>
    );
  }
  return (
    <Card title="Couldn't open the link">
      <p className="text-sm text-muted">{errorMessage(error)}</p>
      <Button className="self-start" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}

function SignInFirst({ token, link }: { token: string; link: ShareInfoDto }) {
  const navigate = useNavigate();
  return (
    <Card title={`Sign in to open “${link.project.name}”`}>
      <p className="text-sm text-muted">This link is for people with an account. Sign in and you'll come straight back to the board.</p>
      <Button variant="primary" className="self-start" onClick={() => void navigate({ to: "/login", search: { redirect: `/s/${token}` } })}>
        Sign in
      </Button>
    </Card>
  );
}

function ChooseName({ token, link }: { token: string; link: ShareInfoDto }) {
  const save = useVisitorName(token);
  const [name, setName] = useState("");
  return (
    <Card title={`Open “${link.project.name}”`}>
      <p className="text-sm text-muted">
        Choose the name others will see {link.collaboration ? "next to your changes and comments" : "while you're looking at the board"}. It's shown as “Name
        (anonymous)”.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) save.mutate(name.trim());
        }}
      >
        <Field label="Your name" value={name} required maxLength={60} autoFocus onChange={(event) => setName(event.target.value)} />
        <ErrorText>{save.error ? errorMessage(save.error) : null}</ErrorText>
        <Button type="submit" variant="primary" className="self-start" disabled={!name.trim() || save.isPending}>
          Open the board
        </Button>
      </form>
    </Card>
  );
}

/** Stand-in store while the board is loading (hooks can't be skipped). */
const EMPTY = createStore<{ project?: { name: string } } | null>(() => null);

function LinkHeader({ link, viewer }: { link: ShareInfoDto; viewer: string | null }) {
  const board = useActiveBoard((state) => state.sync);
  const shown = board && board.projectId === link.project.id ? board : null;
  const name = useStore(shown?.store ?? EMPTY, (state) => state?.project?.name) ?? link.project.name;
  return (
    <header className="flex shrink-0 flex-col border-b border-border bg-surface">
      <div className="flex h-12 items-center gap-3 px-4">
        <h1 className="max-w-64 min-w-12 shrink-0 truncate text-sm font-semibold">{name}</h1>
        {shown ? <BoardTools sync={shown} /> : <span className="flex-1" />}
        {viewer ? <span className="shrink-0 text-xs text-muted">{viewer}</span> : null}
        <ThemeToggle />
      </div>
      <p role="status" className="flex items-center gap-1.5 border-t border-border bg-accent-soft px-4 py-1 text-xs">
        {link.collaboration ? <PencilLine size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
        {link.collaboration ? "Editing via a shared link — changes are saved for everyone." : "Viewing via a shared link."}
      </p>
    </header>
  );
}
