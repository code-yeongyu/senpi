// Drives one SC-LIVE session through the real CLI (`--mode rpc`, persisted session, the driver's child runtime):
// sends the prompts one turn at a time, answers every `ask_user` question over RPC, meters tokens with a hard stop at
// the budget, then closes the child and reopens the persisted session in a fresh one (O7).
import { existsSync, readFileSync } from "node:fs";
import { readJsonl } from "../../../../scripts/lib/common.mjs";
import { RpcClient } from "../../../../scripts/lib/rpc-client.mjs";
import { MCP_SERVER } from "./sandbox-setup.mjs";

const OPEN_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * Billable-weighted tokens one assistant message used, in input-token equivalents at the provider's relative prices:
 * output x5, cache read x0.05, cache write x1.25 (anthropic/claude-opus-5-5: $4 in / $20 out / $0.20 cache read /
 * $5 cache write per M). The --budget caps SPEND: raw counts let re-read system prompts (cache reads, 1/20 the price)
 * exhaust it in a few turns (LIVE-P0 run 1: 915k of 1.0M raw tokens were cache reads, ~$0.80 spent).
 */
const TOKEN_WEIGHT = { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 };
export function messageTokens(usage) {
	if (!usage || typeof usage !== "object") return 0;
	return Math.round(
		Object.entries(TOKEN_WEIGHT).reduce(
			(total, [key, weight]) => total + (Number.isFinite(usage[key]) ? usage[key] * weight : 0),
			0,
		),
	);
}

/** Pick the option labelled `answer` in every question (else its first option): the harness's answer over RPC. */
export function answersFor(frame, answer) {
	return Object.fromEntries(
		(frame.questions ?? []).map((question) => {
			const labels = (question.options ?? []).map((option) => option.label);
			return [question.id, { selected: [labels.includes(answer) ? answer : (labels[0] ?? answer)] }];
		}),
	);
}

const transcript = (path) => (path && existsSync(path) ? readJsonl(readFileSync(path, "utf8")) : []);

function exited(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("close", () => resolve()));
}

async function open(setup, args) {
	const client = new RpcClient({ env: setup.env, cwd: setup.box.cwd, extraArgs: args });
	const state = await client.send({ type: "get_state" }, { timeoutMs: OPEN_TIMEOUT_MS });
	if (!state.success) throw new Error(`get_state failed: ${JSON.stringify(state).slice(0, 400)}`);
	const info = await client.send({ type: "set_client_info", width: 100, capabilities: ["question"] });
	if (!info.success) throw new Error(`set_client_info failed: ${JSON.stringify(info).slice(0, 400)}`);
	return { client, state: state.data };
}

/**
 * Resolve once the MCP fixture server reports connected. A change event is awaited only after a read showed it not yet
 * connected (waitForEvent also matches events that arrived since `seen`), so no waiter outlives the connect.
 */
async function mcpConnected(client) {
	for (;;) {
		const seen = client.events.length;
		const surfaces = await client.send({ type: "get_loaded_surfaces" }, { timeoutMs: COMMAND_TIMEOUT_MS });
		const server = (surfaces.data?.mcpServers ?? []).find((entry) => entry.name === MCP_SERVER);
		if (server?.status === "connected") return;
		await client.waitForEvent(
			(event) => client.events.indexOf(event) >= seen && event.type === "loaded_surfaces_changed",
			{ timeoutMs: OPEN_TIMEOUT_MS },
		);
	}
}

/**
 * @param {{ setup: object, args: string[], prompts: string[], budget: number, answer: string, promptTimeoutMs: number }} options
 */
export async function driveSession({ setup, args, prompts, budget, answer, promptTimeoutMs }) {
	const meter = { limit: budget, used: 0, stopped: false, messages: 0 };
	const questions = { asked: 0, answered: 0, refused: [] };
	const { client, state: opened } = await open(setup, args);
	const answerQuestion = async (frame) => {
		questions.asked += 1;
		const reply = await client.send(
			{ type: "extension_ui_response", id: frame.id, answers: answersFor(frame, answer) },
			{ timeoutMs: COMMAND_TIMEOUT_MS },
		);
		if (reply.success) questions.answered += 1;
		else questions.refused.push(reply.error ?? "refused");
	};
	const pending = [];
	// RpcClient buffers events; this tap sees each new one once, in arrival order, right after the client recorded it.
	const recordData = client._onData.bind(client);
	client._onData = (chunk) => {
		const before = client.events.length;
		recordData(chunk);
		for (const event of client.events.slice(before)) {
			if (event.type === "extension_ui_request" && event.method === "question") pending.push(answerQuestion(event));
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			meter.messages += 1;
			meter.used += messageTokens(event.message.usage);
			if (meter.used >= meter.limit && !meter.stopped) {
				meter.stopped = true;
				client.send({ type: "abort" }, { timeoutMs: COMMAND_TIMEOUT_MS }).catch(() => {});
			}
		}
	};
	await mcpConnected(client);
	let turns = 0;
	for (const message of prompts) {
		if (meter.stopped) break;
		const seen = client.events.length;
		const idle = client.waitForEvent((e) => client.events.indexOf(e) >= seen && e.type === "agent_idle", {
			timeoutMs: promptTimeoutMs,
		});
		idle.catch(() => {});
		const sent = await client.send({ type: "prompt", message }, { timeoutMs: COMMAND_TIMEOUT_MS });
		if (!sent.success) throw new Error(`prompt failed: ${JSON.stringify(sent).slice(0, 400)}`);
		await idle;
		turns += 1;
	}
	await Promise.all(pending);
	const before = await client.send({ type: "get_state" }, { timeoutMs: COMMAND_TIMEOUT_MS });
	client.close();
	await exited(client.child);
	const entries = transcript(opened.sessionFile);
	const reopened = await open(setup, [...args, "--session", opened.sessionFile]);
	reopened.client.close();
	await exited(reopened.client.child);
	return {
		events: client.events,
		sessionFile: opened.sessionFile,
		entries,
		entriesAfterReopen: transcript(opened.sessionFile),
		turns,
		meter,
		questions,
		reopen: {
			before: { sessionId: before.data?.sessionId, messageCount: before.data?.messageCount },
			after: { sessionId: reopened.state.sessionId, messageCount: reopened.state.messageCount },
		},
		stderr: client.stderr,
	};
}
