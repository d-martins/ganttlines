import { BOARD_LIMITS, type CommentDto } from "@ganttlines/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../../api/client";
import { taskComments, useDeleteComment, useEditComment, usePostComment } from "../../api/queries";
import { Button } from "../../ui/button";
import { ConfirmButton } from "../../ui/confirm";
import { ErrorText } from "../../ui/field";
import { toast } from "../../ui/toast";
import { Avatar } from "../../ui/avatar";
import { useBoard } from "../board-context";
import { colorFor, fullTime, timeAgo } from "../format";
import { RichTextEditor, RichTextView } from "../../ui/rich-text";


/**
 * A task's comments, newest first: a box to write one (Markdown-lite), then the list with
 * edit/delete on your own (admins may delete any). Live: other people's comments arrive over the
 * WebSocket into the same cache.
 */
export function Comments({
  projectId,
  taskId,
  canComment,
  isAdmin,
  maxHeight,
}: {
  projectId: string;
  taskId: string;
  canComment: boolean;
  isAdmin: boolean;
  /** the write/edit boxes grow up to this height */
  maxHeight: number;
}) {
  const query = useInfiniteQuery(taskComments(projectId, taskId));
  const post = usePostComment(projectId);
  const [draft, setDraft] = useState("");
  // Bumped after sending, to start a fresh (empty) editor.
  const [round, setRound] = useState(0);

  const send = () => {
    const body = draft.trim();
    if (!body || post.isPending) return;
    if (body.length > BOARD_LIMITS.commentMax) return toast(`Comments are limited to ${BOARD_LIMITS.commentMax} characters`, { tone: "error" });
    post.mutate(
      { taskId, body },
      {
        onSuccess: () => {
          setDraft("");
          setRound((value) => value + 1);
        },
      },
    );
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
          <RichTextEditor
            key={round}
            value=""
            label="Write a comment"
            placeholder="Write a comment… (⌘/Ctrl+Enter to send)"
            autoSize={{ min: 56, max: maxHeight }}
            onChange={setDraft}
            onSubmit={send}
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
          <ol className="flex flex-col gap-2">
            {query.data.pages
              .flatMap((page) => page.comments)
              .map((comment) => (
                <CommentItem key={comment.id} projectId={projectId} comment={comment} canDelete={comment.mine || isAdmin} maxHeight={maxHeight} />
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

function CommentItem({ projectId, comment, canDelete, maxHeight }: { projectId: string; comment: CommentDto; canDelete: boolean; maxHeight: number }) {
  const edit = useEditComment(projectId);
  const remove = useDeleteComment(projectId);
  const [editing, setEditing] = useState<string | null>(null);
  const { resources } = useBoard();
  // The author's team-member color when they have one (as in the viewers list); otherwise one from their id or name.
  const { userId, label } = comment.author;
  const avatarColor = resources.find((resource) => userId && resource.userId === userId)?.avatarColor ?? colorFor(userId ?? label);

  if (comment.deleted) {
    return <li className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted italic">Comment deleted.</li>;
  }
  const save = () => {
    const body = editing?.trim();
    if (!body) return;
    if (body === comment.body) return setEditing(null);
    edit.mutate({ id: comment.id, body }, { onSuccess: () => setEditing(null) });
  };
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Avatar name={comment.author.label} color={avatarColor} size={20} />
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
          <RichTextEditor
            value={comment.body}
            label="Edit comment"
            autoSize={{ min: 56, max: maxHeight }}
            onChange={setEditing}
            onSubmit={save}
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
        <RichTextView markdown={comment.body} />
      )}
      {remove.error ? <ErrorText>{errorMessage(remove.error)}</ErrorText> : null}
    </li>
  );
}
