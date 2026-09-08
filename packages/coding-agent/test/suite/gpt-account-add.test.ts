import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { subscribeProviderAccountEvents } from "../../src/core/extensions/builtin/claude-sdk-oauth/account-events.ts";
import gptAccountExtension, { type GptAccountExtensionDeps } from "../../src/core/extensions/builtin/gpt-account.ts";
import {
	type Command,
	type ContextOptions,
	createLoginCommandContext,
	type LoginFn,
	registerCommand,
} from "./account-command-harness.ts";

const CODEX_LOGIN_METHOD_PROMPT = {
	type: "select",
	message: "Select OpenAI Codex login method:",
	options: [
		{ id: "browser", label: "Browser login (default)" },
		{ id: "device_code", label: "Device code login (headless)" },
	],
} as const;
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize?state=abc";

let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gpt-account-add-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function registeredGptCommand(deps?: GptAccountExtensionDeps): Command {
	return registerCommand("gpt-account", (pi) => gptAccountExtension(pi, deps));
}

function createLoginContext(login: LoginFn, options: ContextOptions = {}) {
	return createLoginCommandContext(storage, dir, login, options);
}

function collectAccountsChanged(): { changed: string[]; unsubscribe: () => void } {
	const changed: string[] = [];
	const unsubscribe = subscribeProviderAccountEvents((event) => {
		if (event.type === "accounts_changed") changed.push(event.provider);
	});
	return { changed, unsubscribe };
}

describe("/gpt-account add", () => {
	it("shows the login-method choice as a selector and relays the chosen option id", async () => {
		const methods: string[] = [];
		const { ctx, notices, dialogs } = createLoginContext(
			async (_provider, _method, interaction) => {
				const method = await interaction.prompt(CODEX_LOGIN_METHOD_PROMPT);
				if (method !== "browser" && method !== "device_code") {
					throw new Error(`Unknown OpenAI Codex login method: ${method}`);
				}
				methods.push(method);
			},
			{ dialogs: { select: () => "Device code login (headless)" } },
		);

		await registeredGptCommand().handler("add", ctx);

		expect(dialogs).toEqual([
			{
				kind: "select",
				title: "Select OpenAI Codex login method:",
				options: ["Browser login (default)", "Device code login (headless)"],
				signal: undefined,
			},
		]);
		expect(methods).toEqual(["device_code"]);
		expect(notices.at(-1)).toMatchObject({ message: "OpenAI Codex OAuth account added.", type: "info" });
	});

	it("stays silent when the user dismisses the login-method selector", async () => {
		const { changed, unsubscribe } = collectAccountsChanged();
		const { ctx, notices } = createLoginContext(
			async (_provider, _method, interaction) => {
				await interaction.prompt(CODEX_LOGIN_METHOD_PROMPT);
				throw new Error("login must not continue after the selector was dismissed");
			},
			{ dialogs: { select: () => undefined } },
		);

		try {
			await registeredGptCommand().handler("add", ctx);
		} finally {
			unsubscribe();
		}

		expect(notices).toEqual([]);
		expect(changed).toEqual([]);
	});

	it("shows the device code beside its verification URL", async () => {
		const { ctx, notices } = createLoginContext(async (_provider, _method, interaction) => {
			interaction.notify({
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://auth.openai.com/codex/device",
			});
		});

		await registeredGptCommand().handler("add", ctx);

		const deviceNotice = notices.find((notice) => notice.message.includes("https://auth.openai.com/codex/device"));
		expect(deviceNotice?.type).toBe("info");
		expect(deviceNotice?.message).toContain("ABCD-1234");
	});

	it("passes the manual-code placeholder and releases the dialog when the provider aborts the prompt", async () => {
		const outcomes: string[] = [];
		const { ctx, notices, dialogs } = createLoginContext(
			async (_provider, _method, interaction) => {
				const manualAbort = new AbortController();
				const manual = interaction
					.prompt({
						type: "manual_code",
						message: "Paste the authorization code:",
						placeholder: "http://localhost:1455/auth/callback",
						signal: manualAbort.signal,
					})
					.then(
						(value) => `resolved:${value}`,
						(error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
					);
				// The local callback server won the race: the provider retires its manual prompt.
				manualAbort.abort();
				outcomes.push(await manual);
			},
			{
				dialogs: {
					input: (_title, _placeholder, opts) =>
						new Promise((resolve) => {
							if (!opts?.signal) {
								resolve("typed-with-no-way-to-dismiss");
								return;
							}
							if (opts.signal.aborted) {
								resolve(undefined);
								return;
							}
							opts.signal.addEventListener("abort", () => resolve(undefined), { once: true });
						}),
				},
			},
		);

		await registeredGptCommand().handler("add", ctx);

		expect(dialogs).toMatchObject([
			{ kind: "input", title: "Paste the authorization code:", placeholder: "http://localhost:1455/auth/callback" },
		]);
		expect(outcomes).toEqual(["rejected:Login cancelled"]);
		expect(notices.at(-1)).toMatchObject({ message: "OpenAI Codex OAuth account added.", type: "info" });
	});

	it("opens the authorize URL in the browser for the TUI and prints it as a fallback", async () => {
		const opened: string[] = [];
		const { ctx, notices } = createLoginContext(async (_provider, _method, interaction) => {
			interaction.notify({
				type: "auth_url",
				url: AUTHORIZE_URL,
				instructions: "A browser window should open. Complete login to finish.",
			});
		});

		await registeredGptCommand({ openBrowser: (target) => opened.push(target) }).handler("add", ctx);

		expect(opened).toEqual([AUTHORIZE_URL]);
		expect(notices[0]?.message).toContain(AUTHORIZE_URL);
	});

	it("leaves browser opening to the client outside the TUI", async () => {
		const opened: string[] = [];
		const { ctx, notices } = createLoginContext(
			async (_provider, _method, interaction) => {
				interaction.notify({ type: "auth_url", url: AUTHORIZE_URL });
			},
			{ mode: "rpc" },
		);

		await registeredGptCommand({ openBrowser: (target) => opened.push(target) }).handler("add", ctx);

		expect(opened).toEqual([]);
		expect(notices[0]?.message).toContain(AUTHORIZE_URL);
	});

	it("runs an openai-codex oauth login and announces the new account", async () => {
		const { changed, unsubscribe } = collectAccountsChanged();
		const { ctx, notices, logins } = createLoginContext(async () => {});

		try {
			await registeredGptCommand().handler("add", ctx);
		} finally {
			unsubscribe();
		}

		expect(logins).toEqual(["openai-codex:oauth"]);
		expect(notices.at(-1)).toMatchObject({ message: "OpenAI Codex OAuth account added.", type: "info" });
		expect(changed).toEqual(["openai-codex"]);
	});

	it("stays silent when the user cancels the login prompt", async () => {
		const { changed, unsubscribe } = collectAccountsChanged();
		const { ctx, notices } = createLoginContext(async () => {
			throw new Error("Login cancelled");
		});

		try {
			await registeredGptCommand().handler("add", ctx);
		} finally {
			unsubscribe();
		}

		expect(notices).toEqual([]);
		expect(changed).toEqual([]);
	});

	it("surfaces a real login failure as an error notice", async () => {
		const { ctx, notices } = createLoginContext(async () => {
			throw new Error("authorization server rejected the code");
		});

		await registeredGptCommand().handler("add", ctx);

		expect(notices.at(-1)).toMatchObject({ message: "authorization server rejected the code", type: "error" });
	});
});
