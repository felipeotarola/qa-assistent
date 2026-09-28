import type { ExternalIssue } from "../../shared/external";

interface Receipt { fingerprint: string; state: string; result: ExternalIssue | null }
export class ReceiptConflict extends Error {}

/** Only a confirmed matching receipt may be replayed as success. */
export function replayExternalReceipt(receipt: Receipt, fingerprint: string): ExternalIssue {
  if (receipt.fingerprint !== fingerprint) throw new ReceiptConflict("Operation key already used for different content or destination");
  if (receipt.state !== "complete" || !receipt.result) throw new ReceiptConflict("This write is pending or its outcome is unknown. Check the external system; do not repeat it.");
  return receipt.result;
}

/** Reservation must commit before this function is called. Never retry write. */
export async function finishExternalWrite(
  write: () => Promise<ExternalIssue>,
  record: (state: "complete" | "unknown", result?: ExternalIssue) => Promise<void>,
) {
  try {
    const result = await write();
    await record("complete", result);
    return result;
  }
  catch {
    await record("unknown");
    throw new ReceiptConflict("Could not confirm the external write. Check the destination before retrying. Do not claim it was saved.");
  }
}
