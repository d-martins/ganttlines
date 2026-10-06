/** Leaves the app for another address (a full page load). */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
