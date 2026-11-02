import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Api, Credential, Model, Provider } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../../../../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../../../../../packages/coding-agent/src/core/model-runtime.ts";
import {
	registerCursorCliAccountCommand,
} from "../../../../../../packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/account-command.ts";
import {
	persistCursorCliNoApprovalAcknowledgement,
} from "../../../../../../packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "../../../../../../packages/coding-agent/src/core/extensions/types.ts";
import { InteractiveMode } from "../../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";

type Command = Pick<RegisteredCommand, "handler">;

const [agentDir, cwd] = process.argv.slice(2);
if (!agentDir || !cwd) throw new Error("usage: setup.ts <agent-dir> <cwd>");
process.env.SENPI_CODING_AGENT_DIR = agentDir;

async function provePostLoginCatalog(): Promise<{
	allowNetworkObserved: boolean;
	catalogRequests: number;
	modelVisibleBefore: boolean;
	modelVisibleAfter: boolean;
}> {
	let catalogRequests = 0;
	const server = createServer((request, response) => {
		if (request.method !== "GET" || request.url !== "/models") {
			response.writeHead(404).end();
			return;
		}
		catalogRequests++;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ models: [{ id: "cursor-http-dynamic" }] }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("catalog server has no TCP address");
		const catalogUrl = `http://127.0.0.1:${address.port}/models`;
		let allowNetworkObserved = false;
		let catalogReady = false;
		const model: Model<"openai-completions"> = {
			id: "cursor-http-dynamic",
			name: "Cursor HTTP Dynamic",
			api: "openai-completions",
			provider: "cursor-http-catalog-qa",
			baseUrl: catalogUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		};
		const provider: Provider<"openai-completions"> = {
			id: model.provider,
			name: "Cursor HTTP Catalog QA",
			auth: {
				apiKey: {
					name: "Cursor QA token",
					login: async () => ({ type: "api_key", key: "qa-cursor-token" }),
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored QA token" } : undefined,
					resolve: async ({ credential }) => ({
						auth: { apiKey: credential?.key ?? "" },
						source: "stored QA token",
					}),
				},
			},
			getModels: () => (catalogReady ? [model] : []),
			refreshModels: async ({ allowNetwork }) => {
				if (!allowNetwork) return;
				allowNetworkObserved = true;
				const response = await fetch(catalogUrl);
				if (!response.ok) throw new Error(`catalog server returned ${response.status}`);
				const payload = (await response.json()) as { models?: Array<{ id?: unknown }> };
				catalogReady = payload.models?.some((entry) => entry.id === model.id) === true;
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
		});
		await runtime.registerNativeProvider(provider, { refresh: false });
		await runtime.login(provider.id, "api_key", {
			prompt: async () => "unused",
			notify: () => {},
		});
		const modelVisibleBefore = runtime.getAvailableSnapshot().some((entry) => entry.id === model.id);
		let markRendered: (() => void) | undefined;
		const rendered = new Promise<void>((resolve) => {
			markRendered = resolve;
		});
		const context = {
			session: { modelRuntime: runtime },
			updateAvailableProviderCount: () => {},
			footer: { invalidate: () => {} },
			updateEditorBorderColor: () => {},
			showStatus: () => {},
			showError: () => {},
			showWarning: () => {},
			maybeWarnAboutAnthropicSubscriptionAuth: () => {},
			checkDaxnutsEasterEgg: () => {},
			ui: { requestRender: () => markRendered?.() },
		};
		const complete = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication") as (
			this: object,
			providerId: string,
			providerName: string,
			authType: "oauth" | "api_key",
			previousModel: Model<Api>,
		) => Promise<void>;
		await complete.call(context, provider.id, provider.name, "api_key", {
			...model,
			id: "previous-model",
			provider: "previous-provider",
		});
		await Promise.race([
			rendered,
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("post-login catalog refresh did not render within 5s")), 5_000);
			}),
		]);
		return {
			allowNetworkObserved,
			catalogRequests,
			modelVisibleBefore,
			modelVisibleAfter: runtime.getAvailableSnapshot().some((entry) => entry.id === model.id),
		};
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

const nativeCredential: Credential = {
	type: "oauth",
	access: "qa-native-access",
	refresh: "qa-native-refresh",
	expires: Date.now() + 3_600_000,
};
const authPath = join(agentDir, "auth.json");
const storage = AuthStorage.create(authPath);
storage.set("cursor", nativeCredential);
const nativeBefore = JSON.stringify(storage.get("cursor"));
let importRefreshObserved = false;
const fallbackModel: Model<"openai-completions"> = {
	id: "cursor-cli-import-visible",
	name: "Cursor CLI Import Visible",
	api: "openai-completions",
	provider: "cursor-cli-oauth",
	baseUrl: "cursor-cli-oauth",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};
const fallbackProvider: Provider<"openai-completions"> = {
	id: fallbackModel.provider,
	name: "Cursor CLI Import QA",
	auth: {
		oauth: {
			name: "Cursor CLI Import QA",
			isSubscription: true,
			login: async () => {
				throw new Error("unused");
			},
			refresh: async (credential) => credential,
			toAuth: async () => ({ apiKey: "cursor-cli-oauth-managed" }),
			check: async ({ credential }) => {
				if (credential?.type !== "oauth") return undefined;
				const accounts = (credential as { accounts?: unknown }).accounts;
				return Array.isArray(accounts) && accounts.length > 0
					? { type: "oauth", source: "managed QA account" }
					: undefined;
			},
		},
	},
	getModels: () => [fallbackModel],
	refreshModels: async ({ allowNetwork }) => {
		if (!allowNetwork) importRefreshObserved = true;
	},
	stream: () => {
		throw new Error("unused");
	},
	streamSimple: () => {
		throw new Error("unused");
	},
};
const importRuntime = await ModelRuntime.create({
	credentials: storage,
	modelsPath: null,
	allowModelNetwork: false,
});
await importRuntime.registerNativeProvider(fallbackProvider, { refresh: false });
await importRuntime.refresh({ allowNetwork: false, providers: [fallbackProvider.id] });
const modelVisibleBeforeImport = importRuntime
	.getAvailableSnapshot()
	.some((entry) => entry.id === fallbackModel.id);

let command: Command | undefined;
const pi = {
	registerCommand: (name: string, registered: Command) => {
		if (name === "cursor-account") command = registered;
	},
	on: () => {},
} as unknown as ExtensionAPI;
registerCursorCliAccountCommand(pi);
if (!command) throw new Error("/cursor-account was not registered");

const notices: Array<{ message: string; type?: string }> = [];
const ctx = {
	hasUI: false,
	cwd,
	signal: undefined,
	isIdle: () => true,
	sessionManager: { getSessionId: () => "cursor-oauth-catalog-refresh-qa" },
	modelRegistry: {
		authStorage: storage,
		modelRuntime: importRuntime,
	},
	ui: {
		notify: (message: string, type?: string) => notices.push({ message, type }),
		input: async () => undefined,
	},
} as unknown as ExtensionCommandContext;

await command.handler("import native", ctx);
const modelVisibleAfterImport = importRuntime
	.getAvailableSnapshot()
	.some((entry) => entry.id === fallbackModel.id);
persistCursorCliNoApprovalAcknowledgement(cwd, "2026-08-18T02:45:00.000Z");
const postLoginCatalog = await provePostLoginCatalog();

const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
const target = stored["cursor-cli-oauth"] as
	| {
			accounts?: Array<{ name?: unknown; source?: unknown; access?: unknown; refresh?: unknown }>;
		}
	| undefined;
const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
	cursorCliOauthProvider?: { enabled?: unknown; noApprovalAcknowledgedAt?: unknown };
};
const account = target?.accounts?.[0];

process.stdout.write(
	`${JSON.stringify({
		nativePreserved: JSON.stringify(storage.get("cursor")) === nativeBefore,
		targetCreated: target !== undefined,
		accountName: account?.name,
		accountSource: account?.source,
		accountMatchesNative:
			account?.access === nativeCredential.access && account?.refresh === nativeCredential.refresh,
		enabled: settings.cursorCliOauthProvider?.enabled === true,
		acknowledged:
			settings.cursorCliOauthProvider?.noApprovalAcknowledgedAt === "2026-08-18T02:45:00.000Z",
		refreshRequested: importRefreshObserved,
		modelVisibleBeforeImport,
		modelVisibleAfterImport,
		successNotice: notices.some(
			(notice) => notice.type === "info" && notice.message.includes("Imported native Cursor credential"),
		),
		postLoginCatalog,
	})}\n`,
);
