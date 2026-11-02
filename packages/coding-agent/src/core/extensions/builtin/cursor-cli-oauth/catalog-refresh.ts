import type { Credential } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "../../types.ts";
import { type CursorAccountHomeLogger, runInCursorAccountHome } from "./home-store.ts";
import { resolveCursorCliModelCatalog } from "./models.ts";
import { type CursorCliModelProbe, runModelsProbe } from "./models-probe.ts";
import { assessConfiguration } from "./oauth-login.ts";
import type { CursorCliOauthProviderSettings } from "./settings.ts";

export type CursorCliModelCatalogRefreshInput = {
	readonly agentDir: string;
	readonly settings: CursorCliOauthProviderSettings;
	readonly readCurrent: () => Promise<Credential | undefined>;
	readonly resolveExecutable: (settings: { executablePath?: string }) => string;
	readonly runProbe?: CursorCliModelProbe;
	readonly log?: CursorAccountHomeLogger;
};

/**
 * Startup catalog refresh. Resolves `undefined` - spawning nothing - unless the
 * lane would execute a turn right now, judged by the same assessment `check`
 * and turn-time resolution use; otherwise probes `cursor-agent models` inside
 * the HOME of the account the next turn would use (senpi#1722).
 */
export async function refreshCursorCliModelCatalogForLane(
	input: CursorCliModelCatalogRefreshInput,
): Promise<readonly ProviderModelConfig[] | undefined> {
	const outcome = await assessConfiguration({
		readCurrent: input.readCurrent,
		readSettings: () => input.settings,
		resolveExecutable: input.resolveExecutable,
	});
	switch (outcome.status) {
		case "disabled":
		case "not-installed":
		case "no-accounts":
			return undefined;
		case "configured": {
			const { accounts } = outcome.assessment;
			const account = accounts.find((slot) => slot.name === input.settings.pinnedAccount) ?? accounts[0];
			if (account === undefined) return undefined;
			const probe = input.runProbe ?? runModelsProbe;
			return resolveCursorCliModelCatalog({
				agentDir: input.agentDir,
				settings: {
					modelCatalogTtlHours: input.settings.modelCatalogTtlHours,
					executablePath: input.settings.executablePath,
				},
				deps: {
					resolveExecutable: () => input.resolveExecutable({ executablePath: input.settings.executablePath }),
					runProbe: async (executable, stdoutPath, timeoutMs) => {
						await runInCursorAccountHome(
							input.agentDir,
							account,
							({ home }) => probe({ executable, stdoutPath, timeoutMs, home }),
							input.log,
						);
					},
				},
			});
		}
		default: {
			const exhausted: never = outcome;
			return exhausted;
		}
	}
}
