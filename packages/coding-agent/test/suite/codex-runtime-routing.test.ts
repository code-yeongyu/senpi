import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { subscribeAccountSwitch } from "../../src/core/credential-pool/account-notices.ts";
import { CredentialSlotRepository } from "../../src/core/credential-pool/state-store.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

const token = (name: string) =>
	`test.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: name },
		}),
	).toString("base64url")}.test`;

async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "codex-runtime-"));
	const accounts = ["exhausted", "ready"].map((name) => ({
		name,
		access: token(name),
		refresh: `test-refresh-${name}`,
		expires: 9e12,
	}));
	const credentials = AuthStorage.inMemory({
		"openai-codex": {
			type: "oauth",
			access: token("exhausted"),
			refresh: "test-refresh-exhausted",
			expires: 9e12,
			pinned: "exhausted",
			accounts,
		},
	});
	const runtime = await ModelRuntime.create({
		credentials,
		agentDir: dir,
		modelsPath: null,
		allowModelNetwork: false,
	});
	const provider = runtime.getProvider("openai-codex");
	const model = runtime.getModels().find((candidate) => candidate.provider === "openai-codex");
	if (!provider || !model) throw new Error("Codex builtin is required");
	const fetchUsage = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const exhausted = new Headers(init?.headers).get("authorization") === `Bearer ${token("exhausted")}`;
		return Response.json({
			rate_limit: {
				allowed: !exhausted,
				limit_reached: exhausted,
				primary_window: { used_percent: exhausted ? 100 : 0 },
			},
			credits: { has_credits: false },
		});
	});
	vi.stubGlobal("fetch", fetchUsage);
	return { runtime, provider, model, fetchUsage, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

it.each(["exhausted", "external"])("explicit %s credentials bypass Codex rotation", async (name) => {
	const f = await fixture();
	const faux = fauxProvider({ provider: "openai-codex" });
	try {
		await f.runtime.registerNativeProvider(
			{
				...f.provider,
				stream: faux.provider.stream,
				streamSimple: faux.provider.streamSimple,
			},
			{ refresh: false },
		);
		faux.setResponses([fauxAssistantMessage("pinned")]);
		for await (const event of f.runtime.streamSimple(f.model, { messages: [] }, { apiKey: token(name) })) {
			if (event.type === "error") throw new Error(event.error.errorMessage);
			if (event.type === "done") break;
		}
		expect(faux.getCallLog().map((call) => call.options?.apiKey)).toEqual([token(name)]);
		expect(f.fetchUsage).not.toHaveBeenCalled();
	} finally {
		f.cleanup();
	}
});

it("HTTP requests use the same quota selection and fault-isolated notices", async () => {
	const f = await fixture();
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	const notices: string[] = [];
	const removeBad = subscribeAccountSwitch(() => {
		throw new Error("private observer error");
	});
	const removeGood = subscribeAccountSwitch((event) => {
		notices.push(event.to);
	});
	try {
		const key = await f.runtime.requestWithCredentialRotation(
			f.model,
			{ sessionId: "request-test" },
			async (prepared) => prepared.options.apiKey,
		);
		expect(key).toBe(token("ready"));
		expect(notices).toEqual(["ready"]);
		expect(diagnostics).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private observer error");
	} finally {
		removeBad();
		removeGood();
		f.cleanup();
	}
});

it("an account reserved by another half-open probe cannot authorize paid usage", async () => {
	const f = await fixture();
	try {
		const repository = new CredentialSlotRepository(join(f.dir, "credential-pool-state.json"));
		const credentialRevision = await repository.storedCredentialRevision("openai-codex", "exhausted", {
			access: token("exhausted"),
			refresh: "test-refresh-exhausted",
		});
		await repository.mutateSlotState("openai-codex", "stored", "exhausted", () => ({
			credentialRevision,
			blockedUntil: 1,
			blockReason: "rate_limit",
			lease: { id: "another-request", expiresAt: 9e12 },
		}));
		expect((await repository.listSlots("openai-codex", "stored")).exhausted?.lease?.id).toBe("another-request");
		f.fetchUsage.mockImplementation(async (_url, init) => {
			const included = new Headers(init?.headers).get("authorization") === `Bearer ${token("exhausted")}`;
			return Response.json({
				rate_limit: {
					allowed: included,
					limit_reached: !included,
					primary_window: { used_percent: included ? 20 : 100 },
				},
				credits: { has_credits: !included, balance: "100" },
			});
		});
		const attempt = vi.fn(async () => "must not spend");
		let failure: unknown;
		try {
			await f.runtime.requestWithCredentialRotation(f.model, undefined, attempt);
		} catch (error) {
			failure = error;
		}
		expect(
			f.fetchUsage.mock.calls.map(
				([, init]) => new Headers(init?.headers).get("authorization") === `Bearer ${token("exhausted")}`,
			),
		).toContain(true);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toContain("No credential slots available");
		expect(attempt).not.toHaveBeenCalled();
	} finally {
		f.cleanup();
	}
});
