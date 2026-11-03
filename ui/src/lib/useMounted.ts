import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * `false` on the server and during the hydration pass, `true` afterwards.
 *
 * Used to defer localStorage-backed presentation (dock height, hidden and
 * maximized state) until the prerendered HTML and the first client render
 * agree. Implemented with `useSyncExternalStore` rather than
 * `useState` + `useEffect` so React can swap the snapshot without a
 * set-state-in-effect render cascade.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
