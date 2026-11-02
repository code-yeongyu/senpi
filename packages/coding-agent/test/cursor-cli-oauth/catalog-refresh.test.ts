import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	type CursorCliModelCatalogRefreshInput,
	refreshCursorCliModelCatalogForLane,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/catalog-refresh.ts";
import { CursorAgentNotInstalledError } from "../../src/core/extensions/builtin/cursor-cli-oauth/executable.ts";
import type { CursorCliModelProbe } from "../../src/core/extensions/builtin/cursor-cli-oauth/models-probe.ts";
import type { CursorCliOauthProviderSettings } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "cursor-cli-catalog-refresh-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
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

function slot(name: string): CursorCliAccountSlot {
	return {
		name,
		access: `${name}-access`,
		refresh: `${name}-refresh`,
		expires: Date.now() + 3_600_000,
		source: "login",
	};
}

function credentialWith(...accounts: CursorCliAccountSlot[]): CursorCliOauthCredential {
	return { ...emptyCredential(), accounts };
}

type Harness = {
	input: CursorCliModelCatalogRefreshInput;
	readCurrent: ReturnType<typeof vi.fn<CursorCliModelCatalogRefreshInput["readCurrent"]>>;
	runProbe: ReturnType<typeof vi.fn<CursorCliModelProbe>>;
};

async function harness(
	overrides: Partial<CursorCliModelCatalogRefreshInput> & { credential?: CursorCliOauthCredential } = {},
): Promise<Harness> {
	const { credential, ...inputOverrides } = overrides;
	const readCurrent = vi.fn<CursorCliModelCatalogRefreshInput["readCurrent"]>(async () => credential);
	const runProbe = vi.fn<CursorCliModelProbe>(async ({ stdoutPath }) => {
		await writeFile(stdoutPath, "model-a - Model A\n", "utf8");
	});
	return {
		input: {
			agentDir: await temporaryDirectory(),
			settings: settings(),
			readCurrent,
			resolveExecutable: () => "/qa/cursor-agent",
			runProbe,
			...inputOverrides,
		},
		readCurrent,
		runProbe,
	};
}

describe("refreshCursorCliModelCatalogForLane", () => {
	it("resolves undefined without reading accounts or probing when the lane is explicitly disabled", async () => {
		const { input, readCurrent, runProbe } = await harness({
			settings: settings({ enabled: false, explicitlyDisabled: true }),
			credential: credentialWith(slot("default")),
		});

		await expect(refreshCursorCliModelCatalogForLane(input)).resolves.toBeUndefined();
		expect(readCurrent).not.toHaveBeenCalled();
		expect(runProbe).not.toHaveBeenCalled();
	});

	it("resolves undefined without reading accounts or probing when cursor-agent is missing", async () => {
		const { input, readCurrent, runProbe } = await harness({
			credential: credentialWith(slot("default")),
			resolveExecutable: () => {
				throw new CursorAgentNotInstalledError();
			},
		});

		await expect(refreshCursorCliModelCatalogForLane(input)).resolves.toBeUndefined();
		expect(readCurrent).not.toHaveBeenCalled();
		expect(runProbe).not.toHaveBeenCalled();
	});

	it("resolves undefined without probing when no usable account is bound", async () => {
		const { input, runProbe } = await harness({ credential: credentialWith() });

		await expect(refreshCursorCliModelCatalogForLane(input)).resolves.toBeUndefined();
		expect(runProbe).not.toHaveBeenCalled();
	});

	it("resolves undefined without probing when the flag is off and no explicit login exists", async () => {
		const { input, runProbe } = await harness({ settings: settings({ enabled: false }), credential: undefined });

		await expect(refreshCursorCliModelCatalogForLane(input)).resolves.toBeUndefined();
		expect(runProbe).not.toHaveBeenCalled();
	});

	it("probes inside the pinned account HOME with its credential in place and returns the probed catalog", async () => {
		const { input, runProbe } = await harness({
			settings: settings({ pinnedAccount: "second" }),
			credential: credentialWith(slot("default"), slot("second")),
		});
		const expectedHome = join(input.agentDir, "cursor-cli-oauth", "accounts", "second", "home");
		let authAtProbeTime: string | undefined;
		runProbe.mockImplementation(async ({ stdoutPath, home }) => {
			authAtProbeTime = await readFile(join(home, ".cursor", "auth.json"), "utf8");
			await writeFile(stdoutPath, "model-a - Model A\n", "utf8");
		});

		const models = await refreshCursorCliModelCatalogForLane(input);

		expect(models?.map((model) => model.id)).toEqual(["model-a"]);
		expect(runProbe).toHaveBeenCalledOnce();
		expect(runProbe.mock.calls[0]?.[0]).toMatchObject({
			executable: "/qa/cursor-agent",
			timeoutMs: 15_000,
			home: expectedHome,
		});
		expect(JSON.parse(authAtProbeTime ?? "{}")).toMatchObject({
			accessToken: "second-access",
			refreshToken: "second-refresh",
		});
		expect(await readFile(join(input.agentDir, "cursor-cli-oauth", "models.json"), "utf8")).toContain('"model-a"');
	});

	it("falls back to the first usable account when the pinned account is unknown", async () => {
		const { input, runProbe } = await harness({
			settings: settings({ pinnedAccount: "missing" }),
			credential: credentialWith(slot("default"), slot("second")),
		});

		await refreshCursorCliModelCatalogForLane(input);

		expect(runProbe.mock.calls[0]?.[0].home).toBe(
			join(input.agentDir, "cursor-cli-oauth", "accounts", "default", "home"),
		);
	});
});
