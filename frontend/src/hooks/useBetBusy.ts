import { create } from 'zustand'

/**
 * Whether a bet is in flight, shared between the Composer that is placing it
 * and every place that lets the user change what is picked.
 *
 * The pick itself is not in a store: each page keeps its own `picked` state and
 * hands it to the Composer as a prop. So the Composer cannot stop a page's
 * UP/DOWN buttons from changing it - what it can do is say so, here, and let
 * those buttons read it (`disabled={useBetBusy()}`). The Composer also keeps
 * showing the bet that was started while this is true, whatever the page does
 * with its own state in the meantime, so the two together close the gap the
 * audit called U01: a second pick during an open wallet prompt.
 *
 * A tiny external store rather than context, for the same reason as
 * useWalletPickerStore: the writer (Composer) and the readers (MarketCard, the
 * Market page) share no provider and no common parent worth threading a prop
 * through.
 */
export const useBetBusyStore = create<{ busy: boolean; setBusy: (busy: boolean) => void }>((set) => ({
  busy: false,
  setBusy: (busy) => set({ busy }),
}))

/** True while a bet is being approved, sent or waited on. Disable pick controls with it. */
export function useBetBusy(): boolean {
  return useBetBusyStore((s) => s.busy)
}
