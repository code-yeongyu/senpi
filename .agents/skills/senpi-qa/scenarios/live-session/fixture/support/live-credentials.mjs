// Live-run credentials (plan §3.4 SC-LIVE): the pinned provider's entry from the operator's own agent store, copied
// into the run's sandbox agent dir (mode 0600) for the length of the run. Nothing else is copied, the sandbox is removed
// on exit, the real store is read-only (guardRealAuth asserts it unchanged), and no credential value is ever returned
// to the caller: receipts only see the provider name and the entry type.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realAuthPath } from "../../../../scripts/lib/common.mjs";

/**
 * OAuth entries are refused: a refresh inside the run would rotate the token in the copy while the operator's store
 * keeps the old one (see "Decisions for the lead" on the PR).
 * @returns {{ provider: string, type: string }}
 */
export function installProviderCredential(agentDir, provider) {
	let store;
	try {
		store = JSON.parse(readFileSync(realAuthPath(), "utf8"));
	} catch (error) {
		throw new Error(
			`live run: cannot read the operator's agent store (${error instanceof Error ? error.message : error})`,
		);
	}
	const entry = store?.[provider];
	if (!entry || typeof entry !== "object")
		throw new Error(`live run: the agent store has no entry for provider "${provider}"`);
	if (entry.type !== "api_key")
		throw new Error(
			`live run: provider "${provider}" is a "${entry.type}" entry; only api_key entries are copied into a run`,
		);
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({ [provider]: entry }, null, 2)}\n`, { mode: 0o600 });
	return { provider, type: entry.type };
}
