import { Button } from "../ui/button";

/** Shown when a screen fails unexpectedly; reloading usually recovers. */
export function ErrorScreen({ error }: { error: unknown }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-8">
      <h2 className="text-base font-semibold">Something went wrong on this screen.</h2>
      <p className="text-sm text-muted">{error instanceof Error ? error.message : "Unexpected error"}</p>
      <Button variant="primary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
