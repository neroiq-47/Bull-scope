// Reconciliation: compare the executor's own intent log with the exchange's open orders.
// Any mismatch means trading must halt until a human has looked at it.

/**
 * @param {Array<{ intentId: string, userref: number, status: string }>} localIntents  submitted-but-unresolved intents
 * @param {Array<{ txid: string, userref: number }>} remoteOpenOrders  open orders reported by Kraken
 */
export function reconcile({ localIntents, remoteOpenOrders }) {
  const remoteRefs = new Set(remoteOpenOrders.map((o) => o.userref));
  const localRefs = new Set(localIntents.map((i) => i.userref));

  // Orders we believe are live but the exchange does not show
  const missingRemote = localIntents.filter((i) => i.status === "submitted" && !remoteRefs.has(i.userref));
  // Orders the exchange shows that we have no record of
  const unknownRemote = remoteOpenOrders.filter((o) => !localRefs.has(o.userref));

  const ok = missingRemote.length === 0 && unknownRemote.length === 0;
  return {
    ok,
    action: ok ? "none" : "halt and review",
    missingRemote,
    unknownRemote,
  };
}
