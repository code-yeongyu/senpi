#!/usr/bin/env node
/**
 * Real source-CLI proof for #891 generated reasoning capabilities.
 *
 * Uses built-in metadata with sandbox provider baseUrl overrides, so the catalog
 * remains the production generated catalog while every request goes to a local
 * OpenAI-compatible server. The RPC CLI command surface dispatches the same
 * /reasoning and /efforts commands as the interactive TUI.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const XIAOMI_PROVIDER = "xiaomi";
const XIAOMI_MODEL = "mimo-v2.5-pro";
const ALIBABA_PROVIDER = "alibaba-token-plan";
const ALIBABA_MODEL = "qwen3.8-max";
const ON_OFF_ERROR = `Reasoning effort is not configurable for ${XIAOMI_PROVIDER}/${XIAOMI_MODEL}; this model supports on/off only. Use /reasoning on or /reasoning off.`;

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function writeOverrides(agentDir, baseUrl) {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[XIAOMI_PROVIDER]: { baseUrl, apiKey: "xiaomi-local-qa", api: "openai-completions" },
					[ALIBABA_PROVIDER]: { baseUrl, apiKey: "alibaba-local-qa", api: "openai-completions" },
				},
			},
			null,
			2,
		),
	);
}

async function main() {
	installCleanupHooks();
	const evidence = evidenceDir(argument("--evidence", "issue-891"));
	const checks = createChecks("issue-891-qa");
	const guard = guardRealAuth();
	const box = makeSandbox("issue-891-qa");
	const env = hermeticEnv(box.env);
	let server;
	let client;
	let serverStopped = false;
	let sandboxRemoved = false;

	try {
		server = await startFakeModelServer({
			turns: [
				{ text: "OFF-WIRE" },
				{ text: "ON-WIRE" },
				{ text: "GRADED-LOW-WIRE" },
				{ text: "GRADED-MEDIUM-WIRE" },
				{ text: "GRADED-XHIGH-WIRE" },
			],
		});
		writeOverrides(box.agentDir, server.url);
		client = new TargetRpcClient({ env, cwd: box.cwd, targetRoot: repoRoot(), extraArgs: ["--multi-session"] });
		const openXiaomi = await client.send({
			type: "open_session",
			cwd: box.cwd,
			provider: XIAOMI_PROVIDER,
			modelId: XIAOMI_MODEL,
		});
		const xiaomiSession = openXiaomi.data?.sessionId;
		checks.ok("opens the built-in Xiaomi model through the real source CLI", openXiaomi.success === true && !!xiaomiSession);
		const sendXiaomi = (command) => client.send({ ...command, sessionId: xiaomiSession });

		const offNotify = client.waitFor(
			(event) => event.message.type === "extension_ui_request" && event.message.method === "notify" && event.message.sessionId === xiaomiSession,
		);
		await sendXiaomi({ type: "prompt", message: "/reasoning off" });
		const offNotification = await offNotify;
		checks.ok("/reasoning off is accepted", offNotification.message.message === "Reasoning: off.");

		const offEnd = client.waitFor((event) => event.message.type === "agent_end" && event.message.sessionId === xiaomiSession);
		await sendXiaomi({ type: "prompt", message: "Return OFF-WIRE." });
		await offEnd;
		checks.ok("off turn reaches the local fake server", server.requests.length === 1);
		checks.ok(
			"off turn serializes documented disabled thinking",
			server.requests[0]?.body?.thinking?.type === "disabled" && server.requests[0]?.body?.reasoning_effort === undefined,
			JSON.stringify(server.requests[0]?.body),
		);

		const onNotify = client.waitFor(
			(event) => event.message.type === "extension_ui_request" && event.message.method === "notify" && event.message.sessionId === xiaomiSession,
		);
		await sendXiaomi({ type: "prompt", message: "/reasoning on" });
		const onNotification = await onNotify;
		checks.ok("/reasoning on is accepted", onNotification.message.message === "Reasoning: on (high).");

		const onEnd = client.waitFor((event) => event.message.type === "agent_end" && event.message.sessionId === xiaomiSession);
		await sendXiaomi({ type: "prompt", message: "Return ON-WIRE." });
		await onEnd;
		checks.ok(
			"on turn serializes enabled thinking without invented effort",
			server.requests[1]?.body?.thinking?.type === "enabled" && server.requests[1]?.body?.reasoning_effort === undefined,
			JSON.stringify(server.requests[1]?.body),
		);

		const refusedEffort = client.waitFor(
			(event) => event.message.type === "extension_ui_request" && event.message.method === "notify" && event.message.sessionId === xiaomiSession,
		);
		await sendXiaomi({ type: "prompt", message: "/efforts low" });
		const effortNotification = await refusedEffort;
		checks.ok("/efforts is refused for an on/off model", effortNotification.message.message === ON_OFF_ERROR);
		checks.ok("refused Xiaomi effort makes no provider request", server.requests.length === 2);

		const openAlibaba = await client.send({
			type: "open_session",
			cwd: box.cwd,
			provider: ALIBABA_PROVIDER,
			modelId: ALIBABA_MODEL,
		});
		const alibabaSession = openAlibaba.data?.sessionId;
		checks.ok("opens the built-in graded Alibaba model", openAlibaba.success === true && !!alibabaSession);
		const sendAlibaba = (command) => client.send({ ...command, sessionId: alibabaSession });

		for (const [effort, requestIndex] of [
			["low", 2],
			["medium", 3],
			["xhigh", 4],
		]) {
			const gradedNotify = client.waitFor(
				(event) =>
					event.message.type === "extension_ui_request" &&
					event.message.method === "notify" &&
					event.message.sessionId === alibabaSession,
			);
			await sendAlibaba({ type: "prompt", message: `/efforts ${effort}` });
			const gradedNotification = await gradedNotify;
			checks.ok(
				`graded /efforts ${effort} is accepted`,
				gradedNotification.message.message === `Reasoning effort: ${effort}. Available: low, medium, xhigh.`,
			);

			const gradedEnd = client.waitFor(
				(event) => event.message.type === "agent_end" && event.message.sessionId === alibabaSession,
			);
			await sendAlibaba({ type: "prompt", message: `Return GRADED-${effort.toUpperCase()}-WIRE.` });
			await gradedEnd;
			checks.ok(
				`graded Alibaba request preserves its documented ${effort} effort`,
				server.requests[requestIndex]?.body?.enable_thinking === true &&
					server.requests[requestIndex]?.body?.reasoning_effort === effort,
				JSON.stringify(server.requests[requestIndex]?.body),
			);
		}

		const settings = JSON.parse(readFileSync(join(box.agentDir, "settings.json"), "utf8"));
		checks.ok(
			"valid graded Alibaba effort persists in sandbox settings",
			settings.modelThinkingLevels?.[`${ALIBABA_PROVIDER}/${ALIBABA_MODEL}`] === "xhigh",
			JSON.stringify(settings.modelThinkingLevels),
		);
		writeFileSync(
			join(evidence, "issue-891-requests.json"),
			JSON.stringify(server.requests.map(({ authorization: _authorization, apiKeyHeader: _apiKeyHeader, ...request }) => request), null, 2),
		);
		writeFileSync(join(evidence, "issue-891-events.json"), JSON.stringify(client.events, null, 2));
	} finally {
		if (client) await client.close();
		if (server) {
			await server.stop();
			serverStopped = true;
		}
		box.cleanup();
		sandboxRemoved = !existsSync(box.dir);
	}

	checks.ok("local fake server stopped", serverStopped);
	checks.ok("sandbox removed", sandboxRemoved, box.dir);
	checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);
	const passed = checks.finish();
	writeFileSync(join(evidence, "issue-891-summary.json"), JSON.stringify({ passed, serverStopped, sandboxRemoved }, null, 2));
	process.exit(passed ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
