const fitters = new Map<string, () => void>();

export function registerPaneFitter(paneId: string, fit: () => void): void {
  fitters.set(paneId, fit);
}

export function unregisterPaneFitter(paneId: string): void {
  fitters.delete(paneId);
}

export function fitPanes(paneIds: Iterable<string>): void {
  for (const paneId of paneIds) {
    fitters.get(paneId)?.();
  }
}
