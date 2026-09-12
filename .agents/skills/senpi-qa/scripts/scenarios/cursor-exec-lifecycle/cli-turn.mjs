/**
 * Real-CLI driver: seeds an isolated custom provider whose `api` is
 * `cursor-agent` and whose baseUrl is the local fake Run server, then drives
 * one turn through the REAL source CLI over `--mode rpc` (Channel 1).
 *
 * The provider's apiKey is the ONLY credential in play — a freshly minted
 * fake token written into the sandbox models.json. All ambient provider-key
 * env vars are stripped, so no real credential can reach the fake server.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../../lib/rpc-client.mjs";
import { hermeticEnv } from "../../lib/mock-loop-support.mjs";

export const QA_PROVIDER = "cursor-qa";
export const QA_MODEL = "cursor-run-qa";

export function seedCursorProvider(box, { baseUrl, token }) {
	const config = {
		providers: {
			[QA_PROVIDER]: {
				baseUrl,
				apiKey: token,
				api: "cursor-agent",
				models: [
					{
						id: QA_MODEL,
						baseUrl,
						api: "cursor-agent",
						contextWindow: 200000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
	writeFileSync(join(box.agentDir, "models.json"), JSON.stringify(config, null, 2));
}

/**
 * Drive one full turn. Resolves after `agent_end` with the CLI's final
 * assistant text, its stopReason, and the collected RPC events.
 */
export async function driveRpcTurn(box, prompt, { timeoutMs = 120000 } = {}) {
	const env = hermeticEnv(box.env);
	const client = new RpcClient({
		env,
		cwd: box.cwd,
		extraArgs: ["--provider", QA_PROVIDER, "--model", QA_MODEL, "--approve"],
	});
	const exited = new Promise((resolve) => client.child.once("close", (code) => resolve(code)));
	const state = await client.send({ type: "get_state" });
	const ack = await client.send({ type: "prompt", message: prompt });
	if (!ack?.success) throw new Error(`prompt was not accepted: ${JSON.stringify(ack).slice(0, 300)}`);
	const terminal = await client.waitForEvent(
		(event) => event.type === "agent_end" || event.type === "agent_aborted",
		{ timeoutMs },
	);
	const last = await client.send({ type: "get_last_assistant_text" });
	const messages = await client.send({ type: "get_messages" });
	const assistant = [...(messages?.data?.messages ?? [])].reverse().find((m) => m.role === "assistant");
	client.close();
	const exitCode = await Promise.race([
		exited,
		new Promise((resolve) => setTimeout(() => resolve(`still-running:${client.child.pid}`), 15000)),
	]);
	return {
		bootedModel: state?.data?.model ?? null,
		aborted: terminal.type === "agent_aborted",
		text: last?.data?.text ?? "",
		stopReason: assistant?.stopReason ?? null,
		assistantError: assistant?.errorMessage ?? null,
		events: client.events,
		stderrTail: client.stderr.slice(-2000),
		exitCode,
		env,
	};
}
