import type { ReactNode } from "react";

/** A titled settings/team panel. */
export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-bg p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="mb-3 text-sm text-muted">{description}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

export const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
