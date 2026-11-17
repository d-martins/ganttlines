import { waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { screen } from "./utils";

/** Opens a row's details: selects it in the list, then opens the drawer from its strip (unless it's open already). */
export async function openDetails(user: UserEvent, row: HTMLElement): Promise<void> {
  await user.click(within(row).getByRole("gridcell", { name: /^Row / }));
  // The drawer is a separate download: wait for it, or its strip, to show.
  const strip = await waitFor(() => {
    const found = screen.queryByRole("button", { name: /^Show details/ });
    if (!found && !screen.queryByRole("complementary", { name: /^Details of/ })) throw new Error("no drawer yet");
    return found;
  });
  if (strip) await user.click(strip);
}
