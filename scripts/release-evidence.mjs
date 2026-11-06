#!/usr/bin/env node
/**
 * Which test evidence a release uses (senpi#2943, senpi#4981):
 * - "ci": wait for the release commit's green hosted "Check and test" run (the default);
 * - "force-tests": run the CI=1 npm test suite in the release job;
 * - "local-receipt": a green local whole-suite receipt at the exact pinned release sha. The job runs clean, build and
 *   check only (no npm test, no CI wait) and records the receipt it relied on.
 * The receipt mode accepts only an exact, pinned sha: a receipt covers one commit, never main's moving tip.
 */

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * @param {{forceTests: boolean, pinnedSha: string | null, localReceiptSha: string | null, localReceipt: string | null}} input
 * @returns {{mode: "ci"} | {mode: "force-tests"} | {mode: "local-receipt", sha: string, receipt: string}}
 */
export function planTestEvidence({ forceTests, pinnedSha, localReceiptSha, localReceipt }) {
	if (localReceiptSha === null && localReceipt === null) return { mode: forceTests ? "force-tests" : "ci" };
	const receipt = localReceipt?.trim() ?? "";
	if (!localReceiptSha || !receipt) {
		throw new Error("--local-receipt-sha and --local-receipt go together: name the green receipt and the exact sha it covers");
	}
	if (!SHA40.test(localReceiptSha)) throw new Error(`--local-receipt-sha must be a full 40-hex sha, got ${localReceiptSha}`);
	if (forceTests) throw new Error("--local-receipt-sha and --force-tests are two different test evidences; pass one of them");
	if (pinnedSha === null) {
		throw new Error("--local-receipt-sha needs a pinned release (--sha): a receipt covers one exact commit, never main's tip");
	}
	if (pinnedSha.toLowerCase() !== localReceiptSha) {
		throw new Error(`the local receipt covers ${localReceiptSha.slice(0, 12)}, but the release pins ${pinnedSha.slice(0, 12)}`);
	}
	return { mode: "local-receipt", sha: localReceiptSha, receipt };
}
