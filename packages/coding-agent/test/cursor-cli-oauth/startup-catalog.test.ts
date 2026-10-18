import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyCredential } from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	registerCursorCliOauthExtension,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import { STATIC_CURSOR_CLI_MODELS } from "../../src/core/extensions/builtin/cursor-cli-oauth/models.ts";
import type { CursorCliModelProbe } from "../../src/core/extensions/builtin/cursor-cli-oauth/models-probe.ts";
import type { CursorCliOauthProviderSettings } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

type Registration = { name: string; config: ProviderConfigInput };

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "cursor-cli-startup-catalog-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function settings(overrides: Partial<CursorCliOauthProviderSettings> = {}): CursorCliOauthProviderSettings {
	return {
		enabled: true,
		explicitlyDisabled: false,
		executablePath: undefined,
		forceExecution: true,
		noApprovalAcknowledgedAt: undefined,
		executionMode: "agent",
		resumeMode: "auto",
		pinnedAccount: undefined,
		contextRecapOnModelSwitch: true,
		modelCatalogTtlHours: 24,
		sandboxMode: undefined,
		...overrides,
	};
}

async function storeWithAccounts(...names: string[]): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async () => ({
		...emptyCredential(),
		accounts: names.map((name) => ({
			name,
			access: `${name}-access`,
			refresh: `${name}-refresh`,
			expires: Date.now() + 3_600_000,
			source: "login" as const,
		})),
	}));
	return store;
}

/** Resolves with the registration that follows the static one; the extension re-registers only with a probed catalog. */
function captureProbedRegistration(register: (pi: ExtensionAPI) => void): {
	registrations: Registration[];
	probed: Promise<Registration>;
} {
	const registrations: Registration[] = [];
	const probed = new Promise<Registration>((resolve) => {
		const pi = {
			registerProvider: (name: string, config: ProviderConfigInput) => {
				registrations.push({ name, config });
				if (registrations.length === 2) resolve({ name, config });
			},
			registerCommand: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			on: () => {},
		} as unknown as ExtensionAPI;
		register(pi);
	});
	return { registrations, probed };
}

describe("cursor-cli-oauth startup model catalog", () => {
	it("registers the static catalog first, then swaps in the catalog probed inside the pinned account HOME", async () => {
		const store = await storeWithAccounts("default", "second");
		const agentDir = temporaryDirectory();
		const probedHomes: string[] = [];
		const runModelsProbe = vi.fn<CursorCliModelProbe>(async ({ stdoutPath, home }) => {
			probedHomes.push(home);
			await writeFile(stdoutPath, "model-a - Model A\n", "utf8");
		});

		const { registrations, probed } = captureProbedRegistration((pi) =>
			registerCursorCliOauthExtension(pi, {
				cwd: temporaryDirectory(),
				agentDir,
				store,
				loadSettings: () => settings({ pinnedAccount: "second" }),
				resolveExecutable: () => "/qa/cursor-agent",
				runModelsProbe,
			}),
		);
		const swapped = await probed;

		expect(registrations[0]?.config.models?.map((entry) => entry.id)).toEqual(
			STATIC_CURSOR_CLI_MODELS.map((entry) => entry.id),
		);
		expect(swapped.config.models?.map((entry) => entry.id)).toEqual(["model-a"]);
		expect(probedHomes).toEqual([join(agentDir, "cursor-cli-oauth", "accounts", "second", "home")]);
	});
});
