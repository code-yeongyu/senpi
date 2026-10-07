import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { type CollectedSink, type Harness, makeHarness, makeSink } from "./rpc-connection-harness.ts";

const PROVIDER = "scripted-interactive";

function oauthCredential(access: string): OAuthCredential {
	return { type: "oauth", access, refresh: `${access}-refresh`, expires: 4_102_444_800_000 };
}

/** Register a scripted OAuth provider so the real AuthStorage.login path runs. */
function registerScriptedProvider(
	harness: Harness,
	login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>,
): void {
	harness.authStorage.registerOAuthProvider(PROVIDER, {
		name: "Scripted Interactive",
		login,
		async refresh(credential) {
			return credential;
		},
		async toAuth(credential) {
			return { apiKey: credential.access };
		},
	});
}

type PromptOutcome = { value: string } | { error: unknown };

/**
 * Record a prompt promise the provider does not await, so the test can assert
 * how it settles once the login has ended.
 */
function outcomeRecorder(): {
	record: (prompt: Promise<string>) => void;
	settled: Promise<PromptOutcome>;
} {
	let resolveOutcome: (outcome: PromptOutcome) => void = () => {};
	const settled = new Promise<PromptOutcome>((resolve) => {
		resolveOutcome = resolve;
	});
	return {
		record: (prompt) => {
			void prompt.then(
				(value) => resolveOutcome({ value }),
				(error: unknown) => resolveOutcome({ error }),
			);
		},
		settled,
	};
}

describe("RPC interactive login prompts", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `rpc-login-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const startLogin = async (collected: CollectedSink, harness: Harness) => {
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		await handler.handleInputLine(JSON.stringify({ id: "login", type: "login_start", provider: PROVIDER }));
		return handler;
	};

	it("answers a manual_code prompt through an input dialog", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		let observedCode: string | undefined;
		registerScriptedProvider(harness, async (interaction) => {
			interaction.notify({ type: "auth_url", url: "https://stub.example/oauth" });
			observedCode = await interaction.prompt({
				type: "manual_code",
				message: "Paste the authorization code",
				placeholder: "http://localhost:1455/callback",
			});
			return oauthCredential("token-manual");
		});
		const handler = await startLogin(collected, harness);

		const request = await collected.waitFor(
			(message) => message.type === "extension_ui_request" && message.method === "input",
		);
		expect(request).toMatchObject({
			method: "input",
			title: "Paste the authorization code",
			placeholder: "http://localhost:1455/callback",
		});
		await handler.handleInputLine(
			JSON.stringify({ type: "extension_ui_response", id: request.id, value: "CODE-123" }),
		);

		expect(await collected.waitFor((message) => message.type === "auth_login_end")).toMatchObject({
			provider: PROVIDER,
			success: true,
		});
		expect(observedCode).toBe("CODE-123");
		expect(JSON.stringify(collected.messages())).not.toContain("CODE-123");
		await handler.dispose();
	});

	it("keeps the login alive when the prompt is left unanswered and the callback path completes", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const manual = outcomeRecorder();
		registerScriptedProvider(harness, async (interaction) => {
			// Mirrors loginAnthropic: the manual-code prompt races the local callback
			// server and is aborted once the callback wins.
			const manualAbort = new AbortController();
			try {
				manual.record(interaction.prompt({ type: "manual_code", message: "Paste", signal: manualAbort.signal }));
				return oauthCredential("token-callback");
			} finally {
				manualAbort.abort();
			}
		});
		const handler = await startLogin(collected, harness);

		const request = await collected.waitFor(
			(message) => message.type === "extension_ui_request" && message.method === "input",
		);
		expect(await collected.waitFor((message) => message.type === "auth_login_end")).toMatchObject({
			provider: PROVIDER,
			success: true,
		});

		const outcome = await manual.settled;
		expect(outcome).toEqual({ error: new Error("Login cancelled") });

		const endsBefore = collected.messages().filter((message) => message.type === "auth_login_end").length;
		await handler.handleInputLine(JSON.stringify({ type: "extension_ui_response", id: request.id, value: "LATE" }));
		expect(collected.messages().filter((message) => message.type === "auth_login_end").length).toBe(endsBefore);
		await handler.dispose();
	});

	it("maps a select prompt's labels back to option ids", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		registerScriptedProvider(harness, async (interaction) => {
			const id = await interaction.prompt({
				type: "select",
				message: "Choose an account",
				options: [
					{ id: "a", label: "Account A" },
					{ id: "b", label: "Account B" },
				],
			});
			return oauthCredential(`token-${id}`);
		});
		const handler = await startLogin(collected, harness);

		const request = await collected.waitFor(
			(message) => message.type === "extension_ui_request" && message.method === "select",
		);
		expect(request).toMatchObject({
			method: "select",
			title: "Choose an account",
			options: ["Account A", "Account B"],
		});
		await handler.handleInputLine(
			JSON.stringify({ type: "extension_ui_response", id: request.id, value: "Account B" }),
		);

		expect(await collected.waitFor((message) => message.type === "auth_login_end")).toMatchObject({ success: true });
		const stored = JSON.parse(readFileSync(harness.authPath, "utf-8")) as Record<string, { access: string }>;
		expect(stored[PROVIDER].access).toBe("token-b");
		await handler.dispose();
	});

	it("treats a cancelled input dialog as a cancelled login", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		registerScriptedProvider(harness, async (interaction) => {
			const code = await interaction.prompt({ type: "manual_code", message: "Paste the authorization code" });
			return oauthCredential(`token-${code}`);
		});
		const handler = await startLogin(collected, harness);

		const request = await collected.waitFor(
			(message) => message.type === "extension_ui_request" && message.method === "input",
		);
		await handler.handleInputLine(JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true }));

		expect(await collected.waitFor((message) => message.type === "auth_login_end")).toMatchObject({
			provider: PROVIDER,
			success: false,
			error: expect.stringContaining("Login cancelled"),
		});
		await handler.dispose();
	});

	it("login_cancel releases a pending prompt", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const manual = outcomeRecorder();
		registerScriptedProvider(harness, async (interaction) => {
			const prompt = interaction.prompt({ type: "manual_code", message: "Paste" });
			manual.record(prompt);
			return oauthCredential(`token-${await prompt}`);
		});
		const handler = await startLogin(collected, harness);

		await collected.waitFor((message) => message.type === "extension_ui_request" && message.method === "input");
		await handler.handleInputLine(JSON.stringify({ id: "cancel", type: "login_cancel", provider: PROVIDER }));

		expect(await collected.waitFor((message) => message.id === "cancel")).toMatchObject({ success: true });
		expect(await collected.waitFor((message) => message.type === "auth_login_end")).toMatchObject({ success: false });
		expect(await manual.settled).toEqual({ error: new Error("Login cancelled") });
		await handler.dispose();
	});
});
