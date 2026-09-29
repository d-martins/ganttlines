import { BOARD_LIMITS, type CommentDto } from "@ganttlines/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { errorMessage } from "../../api/client";
import { taskComments, useDeleteComment, useEditComment, usePostComment } from "../../api/queries";
import { Button } from "../../ui/button";
import { ConfirmButton } from "../../ui/confirm";
import { ErrorText } from "../../ui/field";
import { fullTime, timeAgo } from "../format";
import { MarkdownLite } from "./markdown-lite";

const TEXTAREA = "w-full resize-y rounded-md border border-border-strong bg-bg px-2.5 py-1.5 text-sm text-text";

/** Ctrl/Cmd+Enter sends, like most chat boxes; a plain Enter is a new line. */
const isSend = (event: KeyboardEvent) => event.key === "Enter" && (event.metaKey || event.ctrlKey);

/**
 * A task's comments, newest first: a box to write one (Markdown-lite), then the list with
 * edit/delete on your own (admins may delete any). Live: other people's comments arrive over the
 * WebSocket into the same cache.
 */
export function Comments({ projectId, taskId, canComment, isAdmin }: { projectId: string; taskId: string; canComment: boolean; isAdmin: boolean }) {
  const query = useInfiniteQuery(taskComments(projectId, taskId));
  const post = usePostComment(projectId);
  const [draft, setDraft] = useState("");

  const send = () => {
    const body = draft.trim();
    if (!body || post.isPending) return;
    post.mutate({ taskId, body }, { onSuccess: () => setDraft("") });
  };

  return (
    <div className="flex flex-col gap-3">
      {canComment ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            aria-label="Write a comment"
            placeholder="Write a comment… (**bold**, *italic*, links, @names)"
            rows={3}
            maxLength={BOARD_LIMITS.commentMax}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (!isSend(event)) return;
              event.preventDefault();
              send();
            }}
            className={TEXTAREA}
          />
          <ErrorText>{post.error ? errorMessage(post.error) : null}</ErrorText>
          <Button type="submit" variant="primary" className="self-end text-xs" disabled={!draft.trim() || post.isPending}>
            Comment
          </Button>
        </form>
      ) : null}
      {query.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : query.error ? (
        <p className="text-sm text-danger">{errorMessage(query.error)}</p>
      ) : (
        <>
          <ol className="flex flex-col gap-3">
            {query.data.pages
              .flatMap((page) => page.comments)
              .map((comment) => (
                <CommentItem key={comment.id} projectId={projectId} comment={comment} canDelete={comment.mine || isAdmin} />
              ))}
          </ol>
          {query.data.pages[0]?.comments.length === 0 ? <p className="text-sm text-muted">No comments yet.</p> : null}
          {query.hasNextPage ? (
            <Button variant="ghost" className="self-start text-xs" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Show older comments
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function CommentItem({ projectId, comment, canDelete }: { projectId: string; comment: CommentDto; canDelete: boolean }) {
  const edit = useEditComment(projectId);
  const remove = useDeleteComment(projectId);
  const [editing, setEditing] = useState<string | null>(null);

  if (comment.deleted) {
    return <li className="text-sm text-muted italic">Comment deleted.</li>;
  }
  const save = () => {
    const body = editing?.trim();
    if (!body) return;
    if (body === comment.body) return setEditing(null);
    edit.mutate({ id: comment.id, body }, { onSuccess: () => setEditing(null) });
  };
  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex items-baseline gap-2 text-xs text-muted">
        <span className="font-semibold text-text">{comment.author.label}</span>
        <time dateTime={comment.createdAt} title={fullTime(comment.createdAt)}>
          {timeAgo(comment.createdAt)}
        </time>
        {comment.editedAt ? <span title={fullTime(comment.editedAt)}>(edited)</span> : null}
        <span className="ml-auto flex gap-2">
          {comment.mine && editing === null ? (
            <button type="button" className="hover:text-text hover:underline" onClick={() => setEditing(comment.body)}>
              Edit
            </button>
          ) : null}
          {canDelete && editing === null ? (
            <ConfirmButton
              label="Delete"
              title="Delete this comment?"
              message="It will show as “Comment deleted” for everyone."
              onConfirm={() => remove.mutate(comment)}
              trigger={
                <button type="button" className="hover:text-danger hover:underline">
                  Delete
                </button>
              }
            />
          ) : null}
        </span>
      </div>
      {editing !== null ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            aria-label="Edit comment"
            autoFocus
            rows={3}
            maxLength={BOARD_LIMITS.commentMax}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(null);
              else if (isSend(event)) {
                event.preventDefault();
                save();
              }
            }}
            className={TEXTAREA}
          />
          <ErrorText>{edit.error ? errorMessage(edit.error) : null}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button className="text-xs" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" className="text-xs" disabled={!editing.trim() || edit.isPending} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <MarkdownLite text={comment.body} />
      )}
      {remove.error ? <ErrorText>{errorMessage(remove.error)}</ErrorText> : null}
    </li>
  );
}
