import {
	type GitRunner,
	parseRepositoryIdentity,
	REPOSITORY_IDENTITY_ENTRY_TYPE,
	type RepositoryIdentity,
	readRepositoryIdentity,
	sameRepositoryIdentity,
} from "../../repository-identity.ts";
import type { ReadonlySessionManager } from "../../session-manager.ts";
import type { ExtensionAPI } from "../types.ts";

// Records which git repository a session's cwd belongs to, so a session whose repository was later
// moved can still be recognised as the same project from the new path (senpi#2181).
export function createRepositoryIdentityExtension(run?: GitRunner) {
	return (pi: ExtensionAPI): void => {
		let generation = 0;

		pi.on("session_start", async (_event, ctx) => {
			const current = ++generation;
			if (ctx.sessionManager.getSessionFile() === undefined) return;
			const identity = await readRepositoryIdentity(ctx.cwd, run);
			if (current !== generation || identity === undefined) return;
			if (sameRepositoryIdentity(latestRecordedIdentity(ctx.sessionManager), identity)) return;
			pi.appendEntry(REPOSITORY_IDENTITY_ENTRY_TYPE, identity);
		});

		pi.on("session_shutdown", () => {
			generation++;
		});
	};
}

function latestRecordedIdentity(sessionManager: ReadonlySessionManager): RepositoryIdentity | undefined {
	let recorded: RepositoryIdentity | undefined;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === REPOSITORY_IDENTITY_ENTRY_TYPE) {
			recorded = parseRepositoryIdentity(entry.data) ?? recorded;
		}
	}
	return recorded;
}

export default createRepositoryIdentityExtension();
