import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/client";
import { keys, useEnableTwoFactor, useTwoFactorSetup } from "../api/queries";
import { Button } from "../ui/button";
import { ErrorText, Field } from "../ui/field";

/**
 * Turning two-factor on: scan the QR code (or type the key), confirm a code from the app, then
 * keep the recovery codes. Who's signed in is only refreshed once the codes are put away, so they
 * stay on screen even where being "on" changes what's shown.
 */
export function TwoFactorSetup({ intro, onDone }: { intro: string; onDone?: () => void }) {
  const client = useQueryClient();
  const setup = useTwoFactorSetup();
  const enable = useEnableTwoFactor();
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  if (recoveryCodes) {
    return (
      <div className="flex flex-col gap-2">
        <p role="status">
          Two-factor sign-in is on. Keep these recovery codes somewhere safe — each one signs you in once if you lose your phone. They won't be shown again.
        </p>
        <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-3 font-mono text-sm sm:grid-cols-5">
          {recoveryCodes.map((recovery) => (
            <li key={recovery}>{recovery}</li>
          ))}
        </ul>
        <Button
          className="self-start"
          onClick={() => {
            setRecoveryCodes(null);
            void client.invalidateQueries({ queryKey: keys.me }).then(() => onDone?.());
          }}
        >
          I've saved them
        </Button>
      </div>
    );
  }
  if (setup.data) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          enable.mutate(code, { onSuccess: ({ recoveryCodes: codes }) => (setRecoveryCodes(codes), setCode(""), setup.reset()) });
        }}
      >
        <p>Scan this with an authenticator app (Google Authenticator, 1Password, Authy …), then enter the code it shows.</p>
        <div className="flex flex-wrap items-center gap-4">
          {/* The QR code is drawn by our own server from the otpauth link. */}
          <div aria-label="QR code for your authenticator app" role="img" className="h-40 w-40 rounded bg-white p-1 [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: setup.data.qrSvg }} />
          <div className="flex flex-col gap-1 text-xs text-muted">
            Can't scan it? Enter this key:
            <code aria-label="Setup key" className="break-all rounded bg-surface-2 px-2 py-1 font-mono text-sm text-text">
              {setup.data.secret}
            </code>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Code from the app" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
          <Button type="submit" variant="primary" disabled={enable.isPending}>
            Turn on
          </Button>
        </div>
        <ErrorText>{enable.error ? errorMessage(enable.error) : null}</ErrorText>
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p>{intro}</p>
      <Button disabled={setup.isPending} onClick={() => setup.mutate()}>
        Turn on two-factor
      </Button>
      <ErrorText>{setup.error ? errorMessage(setup.error) : null}</ErrorText>
    </div>
  );
}
