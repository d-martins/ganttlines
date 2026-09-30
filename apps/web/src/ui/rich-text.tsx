import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as Popover from "@radix-ui/react-popover";
import { Bold, Code, Italic, Link2, List, ListOrdered, Strikethrough } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Rich text for descriptions and comments. What people see is formatted (WYSIWYG); what is stored
 * is Markdown, so existing plain text and Markdown keep working and the server stores a string.
 * Only the editor's schema is ever rendered — never user-supplied HTML — and links are limited to
 * http(s)/mailto and open in a new tab without a referrer.
 */
function extensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      underline: false, // not Markdown
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        isAllowedUri: (url, context) => /^(https?:|mailto:)/i.test(url) && context.defaultValidate(url),
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      },
    }),
    Placeholder.configure({ placeholder }),
    Markdown,
  ];
}

const markdownOf = (editor: Editor) => editor.getMarkdown().replace(/\n+$/, "");

/** How the box sizes itself: grow with the content between `min` and `max` px (to `max` when focused, if asked). */
export interface AutoSize {
  min: number;
  max: number;
  expandOnFocus?: boolean;
}

/**
 * The editor. `value` is Markdown; edits are reported by `onChange` (every change) and `onCommit`
 * (when it loses focus, if changed). Cmd/Ctrl+Enter calls `onSubmit`; Escape puts `value` back.
 * Shows other people's changes to `value` until you start typing.
 */
export function RichTextEditor({
  value,
  label,
  placeholder = "",
  editable = true,
  onChange,
  onCommit,
  onSubmit,
  autoSize,
  footer,
}: {
  value: string;
  label: string;
  placeholder?: string;
  editable?: boolean;
  onChange?: (markdown: string) => void;
  onCommit?: (markdown: string) => void;
  onSubmit?: () => void;
  autoSize: AutoSize;
  /** extra controls under the text (e.g. a Send button) */
  footer?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const latest = useRef({ value, onChange, onCommit, onSubmit });
  latest.current = { value, onChange, onCommit, onSubmit };
  const editor = useEditor({
    extensions: extensions(placeholder),
    content: value,
    contentType: "markdown",
    editable,
    immediatelyRender: true,
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": label, class: "rich-text outline-none" },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && latest.current.onSubmit) {
          latest.current.onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => latest.current.onChange?.(markdownOf(current)),
    onFocus: () => setFocused(true),
    onBlur: ({ editor: current }) => {
      setFocused(false);
      const markdown = markdownOf(current);
      if (markdown !== latest.current.value.replace(/\n+$/, "")) latest.current.onCommit?.(markdown);
    },
  });

  // Someone else changed it (or another task was selected): show the new value unless typing here.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (markdownOf(editor) !== value.replace(/\n+$/, "")) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const height = useAutoHeight(editor, autoSize, focused);
  return (
    <div
      className={`flex flex-col rounded-md border bg-bg text-sm text-text transition-colors ${focused ? "border-accent" : "border-border-strong"} ${editable ? "" : "border-border"}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !editor) return;
        // Escape: put the stored text back and leave the editor.
        event.stopPropagation();
        editor.commands.setContent(latest.current.value, { contentType: "markdown", emitUpdate: false });
        latest.current.onChange?.(latest.current.value);
        editor.commands.blur();
      }}
    >
      {editable && editor ? <Toolbar editor={editor} visible={focused} label={`${label} formatting`} /> : null}
      <div
        className="overflow-y-auto px-2.5 py-1.5 transition-[height] duration-200 ease-out motion-reduce:transition-none"
        style={{ height }}
        onMouseDown={(event) => {
          // A click on the empty part of the box puts the cursor at the end of the text.
          if (event.target === event.currentTarget && editor) {
            event.preventDefault();
            editor.commands.focus("end");
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {footer}
    </div>
  );
}

/**
 * The box's height: the content's height between `min` and `max`, or `max` while focused when
 * `expandOnFocus` — in px, so CSS can animate it.
 */
function useAutoHeight(editor: Editor | null, { min, max, expandOnFocus = false }: AutoSize, focused: boolean): number {
  const [content, setContent] = useState(min);
  useLayoutEffect(() => {
    const dom = editor?.view.dom as HTMLElement | undefined;
    if (!dom) return;
    const measure = () => setContent(dom.scrollHeight + 12); // + the box's vertical padding
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dom);
    return () => observer.disconnect();
  }, [editor]);
  const ceiling = Math.max(max, min);
  return focused && expandOnFocus ? ceiling : Math.min(Math.max(content, min), ceiling);
}

function Toolbar({ editor, visible, label }: { editor: Editor; visible: boolean; label: string }) {
  const button = (label: string, icon: ReactNode, active: boolean, run: () => void) => (
    <button
      key={label}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      // Keep the cursor in the text while clicking the toolbar.
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
      className={`rounded p-1 ${active ? "bg-accent-soft text-text" : "text-muted hover:bg-surface-2 hover:text-text"}`}
    >
      {icon}
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={`flex gap-0.5 overflow-hidden border-b border-border px-1 transition-[max-height,padding,opacity] duration-200 ease-out motion-reduce:transition-none ${
        visible ? "max-h-10 py-1 opacity-100" : "max-h-0 border-transparent py-0 opacity-0"
      }`}
    >
      {button("Bold (⌘B)", <Bold size={14} />, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
      {button("Italic (⌘I)", <Italic size={14} />, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
      {button("Strikethrough", <Strikethrough size={14} />, editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run())}
      {button("Code", <Code size={14} />, editor.isActive("code"), () => editor.chain().focus().toggleCode().run())}
      {button("Bulleted list", <List size={14} />, editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
      {button("Numbered list", <ListOrdered size={14} />, editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
      <LinkButton editor={editor} />
    </div>
  );
}

/** Add, change or remove the link on the selected text. */
function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const apply = () => {
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url.trim()) chain.setLink({ href: /^[a-z]+:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}` }).run();
    else chain.unsetLink().run();
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setUrl((editor.getAttributes("link")["href"] as string | undefined) ?? "");
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Link"
          title="Link"
          aria-pressed={editor.isActive("link")}
          onMouseDown={(event) => event.preventDefault()}
          className={`rounded p-1 ${editor.isActive("link") ? "bg-accent-soft text-text" : "text-muted hover:bg-surface-2 hover:text-text"}`}
        >
          <Link2 size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} className="z-50 flex gap-1 rounded-md border border-border bg-bg p-1.5 shadow-lg" onEscapeKeyDown={() => editor.commands.focus()}>
          <input
            autoFocus
            aria-label="Link address"
            placeholder="https://…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              apply();
            }}
            className="w-56 rounded border border-border-strong bg-bg px-2 py-1 text-sm text-text"
          />
          <button type="button" onClick={apply} className="rounded bg-accent px-2 text-xs font-medium text-accent-text">
            {url.trim() ? "Apply" : "Remove"}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Formatted, read-only text (a comment). */
export function RichTextView({ markdown }: { markdown: string }) {
  const editor = useEditor({ extensions: extensions(""), content: markdown, contentType: "markdown", editable: false, immediatelyRender: true, editorProps: { attributes: { class: "rich-text" } } });
  useEffect(() => {
    if (editor && markdownOf(editor) !== markdown.replace(/\n+$/, "")) editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  }, [editor, markdown]);
  return <EditorContent editor={editor} className="break-words" />;
}
