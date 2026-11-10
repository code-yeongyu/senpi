// #2861: real source CLI, real MCP builtin, synthetic local OAuth and model endpoints only.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AuthCommandDeps,
	runAuthComplete,
	runAuthStart,
} from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { spawnOAuthIdp } from "../mcp/fixtures/spawn-idp.ts";

interface Sandbox {
	readonly dir: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly cleanup: () => void;
}
interface ModelServer {
	readonly url: string;
	readonly requests: readonly { readonly messages?: unknown }[];
	readonly stop: () => Promise<void>;
}
const root = resolve(import.meta.dirname, "../../../..");
const qa = join(root, ".agents/skills/senpi-qa/scripts/lib");
const require = createRequire(import.meta.url);
// The repository's QA helpers are JavaScript modules; keep this driver's view of their used API explicit.
const common: {
	readonly makeSandbox: (label: string) => Sandbox;
	readonly evidenceDir: (slug: string) => string;
	readonly guardRealAuth: () => { readonly assertUnchanged: () => boolean };
	readonly runCli: (
		args: string[],
		options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
	) => Promise<{
		readonly code: number | null;
		readonly stdout: string;
		readonly stderr: string;
		readonly timedOut: boolean;
	}>;
} = require(join(qa, "common.mjs"));
const model: {
	readonly startFakeModelServer: (options: {
		readonly turns: readonly {
			readonly text?: string;
			readonly toolCalls?: readonly {
				readonly name: string;
				readonly args: Readonly<Record<string, unknown>>;
			}[];
		}[];
	}) => Promise<ModelServer>;
} = require(join(qa, "fake-model-server.mjs"));
const support: {
	readonly hermeticEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
	readonly writeMockModelsJson: (agentDir: string, server: ModelServer, api: string) => void;
} = require(join(qa, "mock-loop-support.mjs"));

async function main(): Promise<void> {
	const guard = common.guardRealAuth();
	const box = common.makeSandbox("mcp-oauth-continuity");
	const idp = await spawnOAuthIdp(["--rotate-refresh"]);
	const server = await model.startFakeModelServer({
		turns: [
			{ toolCalls: [{ name: "mcp_race_tool_1", args: { value: "first" } }] },
			{ toolCalls: [{ name: "mcp_race_tool_1", args: { value: "second" } }] },
			{ text: "MCP-OAUTH-CONTINUITY-COMPLETE" },
		],
	});
	try {
		const deps: AuthCommandDeps = {
			serverName: "race",
			agentDir: box.agentDir,
			hasUI: false,
			pending: new Map(),
			notify: () => {},
			onReconnect: async () => {},
			config: {
				type: "http",
				url: idp.mcpUrl,
				auth: "oauth",
				args: [],
				enabled: true,
				lifecycle: "lazy",
				exposure: "direct",
				connectTimeoutMs: 4000,
				requestTimeoutMs: 4000,
				startupTimeoutMs: 250,
				idleTimeoutMin: 10,
				logLevel: "info",
				oauth: { scopes: ["mcp", "offline_access"] },
			},
		};
		const authorization = await runAuthStart(deps);
		const location = (await fetch(authorization, { redirect: "manual" })).headers.get("location");
		assert.ok(location, "synthetic sign-in must return a code");
		await runAuthComplete(deps, location);
		await writeFile(join(box.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { race: deps.config } }));
		await writeFile(
			join(box.agentDir, "settings.json"),
			JSON.stringify({
				enabledBuiltinExtensions: ["tool-search"],
			}),
		);
		support.writeMockModelsJson(box.agentDir, server, "openai-completions");
		const observer = join(box.dir, "observer.mjs");
		const observed = join(box.dir, "observed.json");
		const source = join(root, "packages/coding-agent/src/core/extensions/builtin/mcp");
		await writeFile(
			observer,
			`
import { writeFile } from "node:fs/promises";
import { createMcpExtension } from ${JSON.stringify(pathToFileURL(join(source, "index.ts")).href)};
import { McpService } from ${JSON.stringify(pathToFileURL(join(source, "service.ts")).href)};
import { McpTokenStore } from ${JSON.stringify(pathToFileURL(join(source, "auth/token-store.ts")).href)};
import permissionSystemExtension from ${JSON.stringify(pathToFileURL(join(source, "../permission-system/index.ts")).href)};
export default function observer(pi) {
	// Invoke the production builtin factory itself. The observer registers no tool and owns no transport.
	// Load its production permission peer in the same extension module graph, preserving real dispatch authority.
	permissionSystemExtension(pi);
	const service = new McpService();
	createMcpExtension(service)(pi);
	const store = new McpTokenStore(${JSON.stringify({ agentDir: box.agentDir, serverName: "race", serverUrl: idp.mcpUrl })});
	let owner;
	let results = 0;
	pi.on("before_agent_start", async () => {
		if (await service.whenAttachSettled(5000) !== "settled") throw new Error("synthetic MCP attach timed out");
		owner = service.getConnection("race");
	});
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "mcp_race_tool_1") return;
		results++;
		if (results === 1) await store.update(record => ({ ...record, expiresAt: Date.now() + 60000 }));
	});
	pi.on("agent_end", async () => {
		await writeFile(${JSON.stringify(observed)}, JSON.stringify({
			results, sameOwner: owner !== undefined && service.getConnection("race") === owner
		}));
	});
}
`,
		);
		const result = await common.runCli(
			[
				"--provider",
				"mock",
				"--model",
				"mock-model",
				"--no-context-files",
				"-e",
				observer,
				"--permission-preset",
				"full-access",
				"--approve",
				"--print",
				"Call the synthetic MCP tool twice.",
			],
			{ cwd: box.cwd, env: support.hermeticEnv(box.env), timeoutMs: 60_000 },
		);
		const log = await idp.getLog();
		const observation: unknown = JSON.parse(await readFile(observed, "utf8"));
		const messages = server.requests.map((request) => JSON.stringify(request.messages));
		const toolResults = server.requests.flatMap((request) =>
			Array.isArray(request.messages)
				? request.messages.filter(
						(message: unknown) =>
							typeof message === "object" && message !== null && "role" in message && message.role === "tool",
					)
				: [],
		);
		const receipt = {
			cliExit: result.code,
			completed: result.stdout.includes("MCP-OAUTH-CONTINUITY-COMPLETE"),
			modelRequests: server.requests.length,
			firstResultObserved: messages.some((text) => text.includes("fixture tool_1 value=first mode=alpha")),
			secondResultObserved: messages.some((text) => text.includes("fixture tool_1 value=second mode=alpha")),
			refreshes: log.requests.filter((request) => request.grantType === "refresh_token").length,
			calls: log.requests.filter((request) => request.rpcMethod === "tools/call").length,
			familyIntact: !log.familyInvalidated,
			observation,
			toolResults,
			realAuthUnchanged: guard.assertUnchanged(),
		};
		const evidence = common.evidenceDir("mcp-oauth-2861");
		await writeFile(join(evidence, "cli-oauth.json"), `${JSON.stringify(receipt, null, 2)}\n`);
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
		assert.equal(result.code, 0, "source CLI must exit successfully");
		assert.equal(receipt.completed, true);
		assert.equal(receipt.modelRequests, 3);
		assert.equal(receipt.firstResultObserved, true);
		assert.equal(receipt.secondResultObserved, true);
		assert.equal(receipt.refreshes, 1);
		assert.equal(receipt.calls, 2);
		assert.equal(receipt.familyIntact, true);
		assert.deepEqual(observation, { results: 2, sameOwner: true });
	} finally {
		await server.stop();
		await idp.cleanup();
		box.cleanup();
	}
}

await main();
