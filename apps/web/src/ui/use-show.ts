import { useState, type AnimationEvent } from "react";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Keeps something rendered while it animates out. `shouldRender` follows `show`, except that after `show` turns false
 * it stays true until the element's own exit animation ends (pass `onAnimationEnd` to that element). With reduced
 * motion there is no animation, so no end to wait for: it goes at once.
 */
export function useShow(show: boolean): { shouldRender: boolean; onAnimationEnd: (event: AnimationEvent) => void } {
  const [leaving, setLeaving] = useState(false);
  const [previous, setPrevious] = useState(show);
  if (show !== previous) {
    setPrevious(show);
    setLeaving(!show && !reducedMotion());
  }
  return {
    shouldRender: show || leaving,
    onAnimationEnd: (event) => {
      // Only its own animation, not one inside it; and the entry animation ending changes nothing.
      if (event.target === event.currentTarget && !show) setLeaving(false);
    },
  };
}
