import { useMemo } from "react";

import type { PendingKey, RelayPairingRequest } from "../../shared/machines.ts";
import { useOwnJoins } from "../components/OwnJoins.tsx";
import { firstJoinPrompts, pendingKeyPrompts, type PromptPairing } from "../components/RelayPairingPrompt.tsx";

/**
 * What this PC's window asks in one place (RelayPairingPrompt): devices waiting with digits, and, in the PC's own window
 * alone, a first join and a key waiting for its screen, each with Allow beside what to compare. `ownWindow` is a display
 * hint only: the routes enforce the own-window rule themselves.
 */
export function useOwnWindowPrompts(relayPairings: readonly RelayPairingRequest[], pendingKeys: readonly PendingKey[], ownWindow: boolean): readonly PromptPairing[] {
  const ownJoins = useOwnJoins(ownWindow);
  return useMemo(() => [...relayPairings, ...firstJoinPrompts(ownJoins), ...(ownWindow ? pendingKeyPrompts(pendingKeys) : [])], [relayPairings, ownJoins, ownWindow, pendingKeys]);
}
