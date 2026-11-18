import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShow } from "../src/ui/use-show";

function Drawer({ show }: { show: boolean }) {
  const { shouldRender, onAnimationEnd } = useShow(show);
  return shouldRender ? (
    <div data-testid="drawer" onAnimationEnd={onAnimationEnd}>
      <span data-testid="inner" />
    </div>
  ) : null;
}

describe("useShow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("isn't rendered until shown", () => {
    render(<Drawer show={false} />);
    expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
  });

  it("stays rendered after it's hidden, until its exit animation ends", () => {
    const { rerender } = render(<Drawer show />);
    rerender(<Drawer show={false} />);
    expect(screen.getByTestId("drawer")).toBeInTheDocument();
    // An animation inside it ending doesn't count.
    fireEvent.animationEnd(screen.getByTestId("inner"));
    expect(screen.getByTestId("drawer")).toBeInTheDocument();
    fireEvent.animationEnd(screen.getByTestId("drawer"));
    expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
  });

  it("the entry animation ending doesn't hide it", () => {
    render(<Drawer show />);
    fireEvent.animationEnd(screen.getByTestId("drawer"));
    expect(screen.getByTestId("drawer")).toBeInTheDocument();
  });

  it("shown again while leaving, it stays", () => {
    const { rerender } = render(<Drawer show />);
    rerender(<Drawer show={false} />);
    rerender(<Drawer show />);
    fireEvent.animationEnd(screen.getByTestId("drawer"));
    expect(screen.getByTestId("drawer")).toBeInTheDocument();
  });

  it("with reduced motion (no animation, so no end to wait for), it goes at once", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }) as MediaQueryList);
    const { rerender } = render(<Drawer show />);
    act(() => rerender(<Drawer show={false} />));
    expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
  });
});
