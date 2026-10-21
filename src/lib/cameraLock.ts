/**
 * Cross-module "who holds the webcam" flag. The Quick Check (Check.svelte)
 * claims the camera for the whole requestCamera → teardownCamera lifecycle so
 * the background monitor postpones its windows instead of racing
 * getUserMedia. Module-level counter — pair claim/release (use try/finally or
 * release in the shared teardown path).
 */
let count = 0;

export function claimCamera(): void {
  count++;
}

export function releaseCamera(): void {
  count = Math.max(0, count - 1);
}

export function cameraBusy(): boolean {
  return count > 0;
}
