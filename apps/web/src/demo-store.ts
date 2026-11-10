import { useSyncExternalStore } from 'react';
import { changed, demoNow, demoSchema, freshDemo, setDemoTime } from './demo-domain.ts';
import type { Change, DemoState } from './demo-domain.ts';

const storageKey = 'deriro:local-demo:v1';
const listeners = new Set<() => void>();
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(storageKey);

function read(): DemoState | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as DemoState;
    return value.schema === demoSchema && Array.isArray(value.pickups) ? value : undefined;
  } catch {
    return undefined;
  }
}

let snapshot = read() ?? freshDemo();
function update(state: DemoState) {
  if (state === snapshot) return;
  snapshot = state;
  listeners.forEach((listener) => listener());
}

function refresh() {
  const stored = read();
  if (stored) update(stored);
}
window.addEventListener('storage', (event) => { if (event.key === storageKey) refresh(); });
channel?.addEventListener('message', refresh);

// The UI uses the demo data adapter only. Server mutations will need authenticated RPC calls.
export const demoStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  async change(run: (state: DemoState, now: number) => Change): Promise<Change> {
    function transact() {
      const stored = read() ?? snapshot;
      const now = demoNow(stored);
      const current = setDemoTime(stored, now);
      const result = run(current, now);
      if (result.state !== stored) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(result.state));
          channel?.postMessage('changed');
        } catch { /* The current tab can still run the demo without browser storage. */ }
        update(result.state);
      }
      return result;
    }
    return navigator.locks ? navigator.locks.request(storageKey, transact) : transact();
  },
  tick() { return this.change((state) => changed(state)); },
};

export function useDemo() {
  return useSyncExternalStore(demoStore.subscribe, demoStore.getSnapshot);
}
