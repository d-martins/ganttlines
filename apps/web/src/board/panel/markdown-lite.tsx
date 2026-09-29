import type { ReactNode } from "react";

/**
 * **bold**, *italic* / _italic_, http(s) links and @mentions — nothing else. Everything is
 * rendered as React text, never as HTML, so a comment can't inject markup.
 */
const TOKEN = /(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*|_[^_\n]+?_)|(https?:\/\/[^\s<>"]+)|(@[\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu;
/** Punctuation that ends a sentence rather than a link. */
const TRAILING = /[.,;:!?)\]'"]+$/;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index;
    let [token] = match;
    let tail = "";
    if (match[3]) {
      tail = TRAILING.exec(token)?.[0] ?? "";
      token = token.slice(0, token.length - tail.length);
    }
    if (index > last) nodes.push(text.slice(last, index));
    const key = `${keyPrefix}-${index}`;
    if (match[1]) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (match[2]) nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    else if (match[3])
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer" className="break-all text-accent underline">
          {token}
        </a>,
      );
    else nodes.push(
      <span key={key} className="rounded bg-accent-soft px-0.5 font-medium">
        {token}
      </span>,
    );
    if (tail) nodes.push(tail);
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1 break-words whitespace-pre-wrap">
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>{inline(paragraph, String(index))}</p>
      ))}
    </div>
  );
}
