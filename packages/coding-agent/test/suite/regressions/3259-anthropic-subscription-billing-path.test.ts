import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { findInitialModel, restoreModelFromSession } from "../../../src/core/model-resolver.ts";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/3259: a Claude subscription logged in
// through the direct `anthropic` provider is billed by Anthropic as a third-party app (extra usage),
// and the fallback chain replayed the same rejection on every Anthropic model. The subscription must
// run through the Agent SDK lane (`anthropic-subscription`) and the rejection must end the turn once.

const THIRD_PARTY_400 =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}';

function subscriptionModel(id: string): Model<Api> {
	const base = getModels("anthropic").find((model) => model.id === id);
	if (!base) throw new Error(`missing anthropic model ${id}`);
	return { ...base, provider: "anthropic-subscription" } as Model<Api>;
}

function runtimeWithAuthOn(provider: string): Parameters<typeof findInitialModel>[0]["modelRuntime"] {
	const models: Model<Api>[] = [...(getModels("anthropic") as Model<Api>[]), subscriptionModel("claude-opus-5-5")];
	return {
		getAvailableSnapshot: () => models.filter((model) => model.provider === provider),
		getModel: (p: string, id: string) => models.find((model) => model.provider === p && model.id === id),
		hasConfiguredAuth: (p: string) => p === provider,
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
}

describe("saved anthropic selections follow the moved subscription (#3259)", () => {
	it("starts a saved anthropic default on the same model in the subscription lane", async () => {
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: "claude-opus-5-5",
			modelRuntime: runtimeWithAuthOn("anthropic-subscription"),
		});
		expect(initial.model).toMatchObject({ provider: "anthropic-subscription", id: "claude-opus-5-5" });
		expect(initial.provenance).toBe("settings");
	});

	it("restores an anthropic session onto the subscription lane without a fallback warning", async () => {
		const restored = await restoreModelFromSession(
			"anthropic",
			"claude-opus-5-5",
			undefined,
			false,
			runtimeWithAuthOn("anthropic-subscription"),
		);
		expect(restored.model).toMatchObject({ provider: "anthropic-subscription", id: "claude-opus-5-5" });
		expect(restored.fallbackMessage).toBeUndefined();
	});

	it("names the lane it actually restored in the restore notice", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await restoreModelFromSession(
				"anthropic",
				"claude-opus-5-5",
				undefined,
				true,
				runtimeWithAuthOn("anthropic-subscription"),
			);
			expect(log.mock.calls.flat().join(" ")).toContain("anthropic-subscription/claude-opus-5-5");
		} finally {
			log.mockRestore();
		}
	});

	it("keeps the direct anthropic provider when it still holds its own auth", async () => {
		const restored = await restoreModelFromSession(
			"anthropic",
			"claude-opus-5-5",
			undefined,
			false,
			runtimeWithAuthOn("anthropic"),
		);
		expect(restored.model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
	});
});

describe("the sign-out runs once at the auth.json load seam behind a private backup (senpi#4436)", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("drops the anthropic OAuth login behind a 0600 backup, copies nothing, and settles with no further writes", async () => {
		dir = mkdtempSync(join(tmpdir(), "auth-3259-"));
		const authPath = join(dir, "auth.json");
		const original = JSON.stringify({
			openai: { type: "api_key", key: "sk-openai" },
			anthropic: { type: "oauth", access: "acc-1", refresh: "ref-1", expires: 42 },
		});
		writeFileSync(authPath, original, { mode: 0o600 });
		const backups = () =>
			readdirSync(dir ?? "")
				.filter((name) => name.startsWith("auth.json.backup-"))
				.sort();

		const first = AuthStorage.create(authPath);
		expect(await first.read("anthropic")).toBeUndefined();
		expect(await first.read("anthropic-subscription")).toBeUndefined();
		expect(await first.read("openai")).toEqual({ type: "api_key", key: "sk-openai" });

		const written = backups();
		expect(written).toHaveLength(1);
		expect(readFileSync(join(dir, written[0] ?? ""), "utf-8")).toBe(original);
		expect(statSync(join(dir, written[0] ?? "")).mode & 0o777).toBe(0o600);

		const settled = readFileSync(authPath, "utf-8");
		expect(settled).not.toContain("ref-1");
		AuthStorage.create(authPath);
		expect(readFileSync(authPath, "utf-8")).toBe(settled);
		expect(backups()).toEqual(written);
	});
});

describe("third-party billing rejection ends the Anthropic account, not one model (#3259)", () => {
	it("scopes the rejection to the whole account so the chain skips sibling Anthropic models", () => {
		expect(usageLimitScope(THIRD_PARTY_400)).toBe("account");
	});
});
