import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";

/** A value to copy (a token, an address): shown as code, with a Copy button on its right. */
export function CopyText({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code aria-label={label} className="min-w-0 flex-1 break-all rounded bg-surface-2 px-2 py-1 font-mono">
        {value}
      </code>
      <Button
        className="shrink-0 text-xs"
        aria-label={copied ? `Copied: ${label}` : `Copy: ${label}`}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined)}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
