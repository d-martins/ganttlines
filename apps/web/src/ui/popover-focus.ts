import { useRef } from "react";

/**
 * Radix returns focus to a popover's trigger when it closes. That's right after Escape, but when
 * the popover closed because someone clicked elsewhere (say, into a title to edit it), taking focus
 * back would steal it from what they clicked. Spread the result on `Popover.Content`.
 */
export function useFocusReturnOnKeyboardClose() {
  const clickedOutside = useRef(false);
  return {
    onPointerDownOutside: () => {
      clickedOutside.current = true;
    },
    onCloseAutoFocus: (event: Event) => {
      if (clickedOutside.current) event.preventDefault();
      clickedOutside.current = false;
    },
  };
}
