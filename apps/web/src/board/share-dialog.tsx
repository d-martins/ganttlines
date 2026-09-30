import type { LinkAccess, ShareLinkDto } from "@ganttlines/protocol";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Link2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../api/client";
import { shareLinkList, useCreateShareLink, useRevokeShareLink, useUpdateShareLink } from "../api/queries";
import { Button, IconButton } from "../ui/button";
import { ConfirmButton } from "../ui/confirm";
import { ErrorText, Field } from "../ui/field";
import { fullTime } from "./format";

const ACCESS_LABEL: Record<LinkAccess, string> = {
  anonymous: "Anyone with the link",
  authenticated: "Signed-in people only",
};

/**
 * Share a board: create links (anyone with the link, who picks a display name, or signed-in people
 * only; view or edit), switch editing on/off and turn links off. A new link's address is shown
 * once — the server keeps only a hash of it.
 */
export function ShareDialog({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="primary" className="px-2.5 py-1 text-xs">
          <Link2 size={14} /> Share
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(94vw,32rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-lg border border-border bg-bg p-5 text-text shadow-xl">
          <div className="flex items-start gap-2">
            <Dialog.Title className="text-base font-semibold">Share “{projectName}”</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close" className="-mt-1 ml-auto">
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-sm text-muted">
            People with a link see this board without an account (or with a guest account, for sign-in links).
          </Dialog.Description>
          {open ? <ShareDialogBody projectId={projectId} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ShareDialogBody({ projectId }: { projectId: string }) {
  const links = useQuery(shareLinkList(projectId));
  return (
    <div className="mt-4 flex flex-col gap-5">
      <CreateLink projectId={projectId} />
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Active links</h3>
        {links.isPending ? <p className="text-sm text-muted">Loading…</p> : null}
        {links.error ? <ErrorText>{errorMessage(links.error)}</ErrorText> : null}
        {links.data?.length === 0 ? <p className="text-sm text-muted">No links yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {links.data?.map((link) => (
            <LinkRow key={link.id} projectId={projectId} link={link} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function CreateLink({ projectId }: { projectId: string }) {
  const create = useCreateShareLink(projectId);
  const [access, setAccess] = useState<LinkAccess>("anonymous");
  const [collaboration, setCollaboration] = useState(false);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">New link</h3>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="sr-only">Who can open it</legend>
        {(["anonymous", "authenticated"] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input type="radio" name="access" checked={access === value} onChange={() => setAccess(value)} />
            {ACCESS_LABEL[value]}
            <span className="text-xs text-muted">{value === "anonymous" ? "(they choose a display name)" : "(needs an account, e.g. a guest)"}</span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={collaboration} onChange={(event) => setCollaboration(event.target.checked)} /> Can edit the board (and comment)
      </label>
      {access === "anonymous" && collaboration ? (
        <p role="note" className="flex items-start gap-1.5 rounded bg-surface-2 px-2 py-1.5 text-xs">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          Anyone who gets this link can change the plan without signing in. Share it only with people you trust.
        </p>
      ) : null}
      <Field label="Label (optional, for you)" value={label} maxLength={100} placeholder="e.g. Client review" onChange={(event) => setLabel(event.target.value)} />
      <ErrorText>{create.error ? errorMessage(create.error) : null}</ErrorText>
      <Button
        variant="primary"
        className="self-start text-xs"
        disabled={create.isPending}
        onClick={() =>
          create.mutate(
            { access, collaboration, label: label.trim() },
            {
              onSuccess: ({ url }) => {
                setCreated(url);
                setCopied(false);
                setLabel("");
              },
            },
          )
        }
      >
        Create link
      </Button>
      {created ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <input readOnly aria-label="New link" value={created} onFocus={(event) => event.target.select()} className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-2 py-1 text-xs" />
            <Button className="text-xs" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted">Copy it now: for safety, the link can't be shown again (you can always make another).</p>
        </div>
      ) : null}
    </section>
  );
}

function LinkRow({ projectId, link }: { projectId: string; link: ShareLinkDto }) {
  const update = useUpdateShareLink(projectId);
  const revoke = useRevokeShareLink(projectId);
  const error = update.error ?? revoke.error;
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{link.label || ACCESS_LABEL[link.access]}</span>
        {link.label ? <span className="text-xs text-muted">{ACCESS_LABEL[link.access]}</span> : null}
        <span className="ml-auto">
          <ConfirmButton
            label="Turn off"
            title="Turn this link off?"
            message="Anyone using it loses access at once. This can't be undone (you can make a new link)."
            confirmLabel="Turn off"
            onConfirm={() => revoke.mutate(link.id)}
            trigger={
              <button type="button" className="text-xs text-muted hover:text-danger hover:underline">
                Turn off
              </button>
            }
          />
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        <label className="flex items-center gap-1.5 text-text">
          <input type="checkbox" checked={link.collaboration} disabled={update.isPending} onChange={(event) => update.mutate({ id: link.id, collaboration: event.target.checked })} />
          Can edit
        </label>
        <span title={fullTime(link.createdAt)}>by {link.createdBy}</span>
        {link.access === "anonymous" && link.collaboration ? <span className="text-danger">anyone can edit</span> : null}
      </div>
      <ErrorText>{error ? errorMessage(error) : null}</ErrorText>
    </li>
  );
}
