/**
 * Hint-aware 429 retry-tier scenarios (real CLI, RPC surface, zero real calls).
 *
 * The tier decision is only observable as SESSION EVENTS (`auto_retry_start`
 * delayMs sequencing, `retry_fallback_applied`, `retry_probe_scheduled` /
 * `retry_probe_result`), and `--print` does not emit them. These scenarios
 * therefore drive the same real CLI from source over `--mode rpc`, which
 * forwards every `AgentSessionEvent` verbatim as a JSON line.
 *
 *   hinted-429-in-turn      Tier 1: hinted 429 stays on the SAME model, waiting
 *                           half the hint then to the (refreshed) deadline.
 *   no-hint-429-fast-fallback  No hint: exactly ONE primary call, immediate
 *                           fallback, next chain model serves the turn.
 *   hinted-429-probe-back   Tier 2 (hint above a test-shrunk hintedWaitCapMs):
 *                           immediate fallback, bounded probe-back, probe ok
 *                           clears the cooldown and the next turn restores the
 *                           primary.
 *
 * Every wait is bounded by a scripted hint measured in seconds, and every
 * assertion waits on an EVENT (never a fixed sleep), so runs are deterministic.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, spawnCli } from "./common.mjs";
import { API_PRESETS, checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "./mock-loop-support.mjs";
import {
	HINT_429_FALLBACK_MODEL_ID,
	HINT_429_PRIMARY_MODEL_ID,
	startHint429Server,
} from "./hint-429-server.mjs";

const API_NAME = "anthropic-messages";
const PRIMARY_MARKER = "SENPI-QA-HINT429-PRIMARY-6c1b";
const FALLBACK_MARKER = "SENPI-QA-HINT429-FALLBACK-6c1b";
const IN_TURN_HINT_SECONDS = 8;
const PROBE_BACK_HINT_MS = 4000;
const PROBE_BACK_CAP_MS = 1000;

export const HINT_429_SCENARIOS = ["hinted-429-in-turn", "no-hint-429-fast-fallback", "hinted-429-probe-back"];

export function isHint429Scenario(name) {
	return HINT_429_SCENARIOS.includes(name);
}

/**
 * Minimal JSON-lines RPC client over a spawned `--mode rpc` child. Mirrors the
 * Channel 1 client but stays local so scenario receipts carry no other channel's
 * stdout, and so every observed event is timestamped for delay assertions.
 */
class HintRpcClient {
	constructor({ env, cwd, extraArgs = [] }) {
		this.child = spawnCli(["--mode", "rpc", "--no-session", "--no-context-files", "--no-extensions", ...extraArgs], {
			env,
			cwd,
		});
		this.pending = new Map();
		this.events = [];
		this.eventWaiters = [];
		this.seq = 0;
		this._buf = "";
		this.stderr = "";
		this.child.stdout.on("data", (chunk) => this._onData(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
	}

	_onData(chunk) {
		this._buf += chunk.toString();
		let newline;
		while ((newline = this._buf.indexOf("\n")) >= 0) {
			const line = this._buf.slice(0, newline).trim();
			this._buf = this._buf.slice(newline + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue; // non-protocol noise (tsx/startup) — ignore
			}
			if (message?.type === "response") {
				const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
				if (waiter) {
					this.pending.delete(message.id);
					waiter.resolve(message);
				}
				continue;
			}
			if (!message?.type) continue;
			message.observedAtMs = Date.now();
			this.events.push(message);
			for (const waiter of [...this.eventWaiters]) {
				if (!waiter.pred(message)) continue;
				clearTimeout(waiter.timer);
				this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		}
	}

	send(command, { timeoutMs = 45000 } = {}) {
		const id = command.id ?? `req-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout after ${timeoutMs}ms for ${command.type} (stderr: ${this.stderr.slice(-400)})`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	waitForEvent(pred, { timeoutMs = 60000 } = {}) {
		const found = this.events.find(pred);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const waiter = {
				pred,
				resolve,
				timer: setTimeout(() => {
					this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
					reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching session event`));
				}, timeoutMs),
			};
			this.eventWaiters.push(waiter);
		});
	}

	close() {
		try {
			this.child.stdin.end();
		} catch {}
	}

	/**
	 * Deterministic teardown: closing stdin ends `--mode rpc`. Await the real exit
	 * event (never a fixed sleep) and SIGKILL only if the child outlives the bound,
	 * so the cleanup receipt can assert the pid is gone rather than assume it.
	 */
	closeAndWait({ timeoutMs = 15000 } = {}) {
		this.close();
		if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				try {
					this.child.kill("SIGKILL");
				} catch {}
			}, timeoutMs);
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

function selector(modelId) {
	return `${API_PRESETS[API_NAME].provider}/${modelId}`;
}

function retrySettings(extra = {}) {
	return {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 0,
		provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
		fallbackChains: {
			[selector(HINT_429_PRIMARY_MODEL_ID)]: [selector(HINT_429_FALLBACK_MODEL_ID)],
		},
		...extra,
	};
}

/** Terminal boundary of one prompt: agent_end that is NOT followed by a retry. */
function turnComplete(afterMs = 0) {
	return (event) =>
		(event.type === "agent_end" && event.willRetry === false && event.observedAtMs >= afterMs) ||
		(event.type === "agent_aborted" && event.observedAtMs >= afterMs);
}

async function runOneTurn(client, message, { timeoutMs = 120000, afterMs = 0 } = {}) {
	const ack = await client.send({ type: "prompt", message });
	if (ack.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(ack)}`);
	await client.waitForEvent(turnComplete(afterMs), { timeoutMs });
	const last = await client.send({ type: "get_last_assistant_text" });
	return last.data?.text ?? "";
}

function retryEvents(client) {
	return client.events.filter((event) => event.type === "auto_retry_start" || event.type === "auto_retry_end" || event.type.startsWith("retry_"));
}

function transcript(scenarioName, server, client) {
	const sequence = server.requests.map(
		(request, index) => `${index + 1}:${selector(request.model)}${request.rateLimited ? "(429)" : ""}${request.maxTokens === 1 ? "(probe)" : ""}`,
	);
	const delays = client.events.filter((event) => event.type === "auto_retry_start").map((event) => event.delayMs);
	const fallbacks = client.events.filter((event) => event.type === "retry_fallback_applied").length;
	return [
		`scenario=${scenarioName}`,
		`attempts=${server.requests.length}`,
		`sequence=${sequence.join(",") || "none"}`,
		`retryDelays=${delays.join(",") || "none"}`,
		`fallbackApplied=${fallbacks}`,
		`probeScheduled=${client.events.filter((event) => event.type === "retry_probe_scheduled").length}`,
		`probeOk=${client.events.filter((event) => event.type === "retry_probe_result" && event.ok === true).length}`,
	].join(" ");
}

function writeHint429Evidence(slug, scenarioName, { server, client, texts, box, cliPid }) {
	const dir = evidenceDir(slug);
	writeFileSync(join(dir, `${scenarioName}-events.jsonl`), `${client.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	writeFileSync(join(dir, `${scenarioName}-requests.json`), `${JSON.stringify(server.requests, null, 2)}\n`);
	writeFileSync(
		join(dir, `${scenarioName}-summary.json`),
		`${JSON.stringify(
			{
				command: `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --scenario ${scenarioName}`,
				api: API_NAME,
				sandbox: box.dir,
				// Cleanup receipt inputs: the exact localhost port and CLI pid this run held.
				mockServerOrigin: server.origin,
				mockServerPort: server.port,
				rpcCliPid: cliPid,
				assistantTexts: texts,
				retryEvents: retryEvents(client),
			},
			null,
			2,
		)}\n`,
	);
	process.stderr.write(`evidence: ${dir}\n`);
}

export async function runHint429Scenario({ scenarioName, apiName, evidenceSlug }) {
	if (apiName !== API_NAME) {
		throw new Error(`${scenarioName} requires --api ${API_NAME}`);
	}
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --scenario ${scenarioName}`);
	const guard = guardRealAuth();
	const box = makeSandbox(`senpi-qa-${scenarioName}`);
	const script =
		scenarioName === "hinted-429-in-turn"
			? { primaryLimitedRequests: 2, rateLimitHeaders: { "retry-after": String(IN_TURN_HINT_SECONDS) }, rateLimitMessage: "primary rate limited" }
			: scenarioName === "no-hint-429-fast-fallback"
				? { primaryLimitedRequests: 4, rateLimitMessage: "All tokens rate limited" }
				: { primaryLimitedRequests: 1, rateLimitHeaders: { "retry-after-ms": String(PROBE_BACK_HINT_MS) }, rateLimitMessage: "primary rate limited" };
	const server = await startHint429Server({ ...script, primaryMarker: PRIMARY_MARKER, fallbackMarker: FALLBACK_MARKER });
	writeMockModelsJson(box.agentDir, server, API_NAME, {}, {
		models: [{ id: HINT_429_FALLBACK_MODEL_ID }],
		retry:
			scenarioName === "hinted-429-probe-back"
				? retrySettings({ hintedWaitCapMs: PROBE_BACK_CAP_MS, probeBackMaxMs: 3_600_000 })
				: retrySettings(),
	});
	const client = new HintRpcClient({
		env: hermeticEnv(box.env),
		cwd: box.cwd,
		extraArgs: ["--provider", API_PRESETS[API_NAME].provider, "--model", HINT_429_PRIMARY_MODEL_ID],
	});
	const texts = [];
	try {
		await client.send({ type: "get_state" }); // ensure the session booted
		if (scenarioName === "hinted-429-in-turn") await assertInTurn(checks, client, server, texts);
		else if (scenarioName === "no-hint-429-fast-fallback") await assertFastFallback(checks, client, server, texts);
		else await assertProbeBack(checks, client, server, texts);
		process.stdout.write(`SENPI_QA_HINT429_TRANSCRIPT ${transcript(scenarioName, server, client)}\n`);
		checkRealAuthUnchanged(checks, guard);
		if (evidenceSlug) {
			writeHint429Evidence(evidenceSlug, scenarioName, { server, client, texts, box, cliPid: client.child.pid });
		}
	} catch (error) {
		checks.ok(`${scenarioName}: scenario ran to completion`, false, error instanceof Error ? error.message : String(error));
		process.stderr.write(`\n--- ${scenarioName} rpc stderr tail ---\n${client.stderr.slice(-1500)}\n`);
	} finally {
		// Paired teardown: RPC child stdin closed, localhost server stopped, sandbox removed.
		const cliPid = client.child.pid;
		const port = server.port;
		await client.closeAndWait();
		await server.stop();
		box.cleanup();
		process.stdout.write(
			`SENPI_QA_HINT429_CLEANUP scenario=${scenarioName} rpcCliPid=${cliPid} rpcCliExited=${client.child.exitCode !== null || client.child.signalCode !== null} mockServerPort=${port} serverListening=${server.listening} sandbox=${box.dir} sandboxRemoved=${!existsSync(box.dir)}\n`,
		);
	}
	process.exit(checks.finish() ? 0 : 1);
}

/** Tier 1: hinted 429 waits half the hint, then to the refreshed deadline, on the SAME model. */
async function assertInTurn(checks, client, server, texts) {
	texts.push(await runOneTurn(client, `Return ${PRIMARY_MARKER} once the scripted rate limit clears.`, { timeoutMs: 180000 }));
	const delays = client.events.filter((event) => event.type === "auto_retry_start").map((event) => event.delayMs);
	const halfHintMs = (IN_TURN_HINT_SECONDS * 1000) / 2;
	const fullHintMs = IN_TURN_HINT_SECONDS * 1000;
	checks.ok(
		"hinted-429-in-turn: two same-model waits scheduled at half-hint then hint deadline",
		delays.length === 2 && delays[0] === halfHintMs && delays[1] === fullHintMs,
		`delayMs=${delays.join(",") || "none"} expected=${halfHintMs},${fullHintMs}`,
	);
	const models = server.requests.map((request) => request.model);
	checks.ok(
		"hinted-429-in-turn: every attempt stays on the primary model",
		models.length === 3 && models.every((model) => model === HINT_429_PRIMARY_MODEL_ID),
		`sequence=${models.join(" -> ") || "none"}`,
	);
	checks.ok(
		"hinted-429-in-turn: zero fallback switches",
		client.events.filter((event) => event.type === "retry_fallback_applied").length === 0,
		`retry_fallback_applied=${client.events.filter((event) => event.type === "retry_fallback_applied").length}`,
	);
	checks.ok(
		"hinted-429-in-turn: the hinted retry recovers on the primary model",
		texts[0].includes(PRIMARY_MARKER),
		`text=${texts[0].slice(0, 80)}`,
	);
	const observedWaits = server.requests.slice(1).map((request, index) => request.atMs - server.requests[index].atMs);
	checks.ok(
		"hinted-429-in-turn: the real waits match the scheduled half-then-deadline hints",
		observedWaits.length === 2 && observedWaits[0] >= halfHintMs && observedWaits[1] >= fullHintMs,
		`observedWaitsMs=${observedWaits.join(",")} floor=${halfHintMs},${fullHintMs}`,
	);
}

/** No hint: zero same-model retries, immediate fallback, next chain model answers. */
async function assertFastFallback(checks, client, server, texts) {
	texts.push(await runOneTurn(client, `Return ${FALLBACK_MARKER} from whichever model can serve this turn.`));
	const primaryCalls = server.requests.filter((request) => request.model === HINT_429_PRIMARY_MODEL_ID).length;
	checks.ok(
		"no-hint-429-fast-fallback: exactly one call reaches the primary (zero same-model retries)",
		primaryCalls === 1,
		`primaryCalls=${primaryCalls}`,
	);
	const applied = client.events.filter((event) => event.type === "retry_fallback_applied");
	checks.ok(
		"no-hint-429-fast-fallback: retry_fallback_applied fires on the first failure",
		applied.length === 1 && applied[0].from === selector(HINT_429_PRIMARY_MODEL_ID) && applied[0].to === selector(HINT_429_FALLBACK_MODEL_ID),
		`applied=${JSON.stringify(applied.map((event) => `${event.from}->${event.to}(${event.reason})`))}`,
	);
	const delays = client.events.filter((event) => event.type === "auto_retry_start").map((event) => event.delayMs);
	checks.ok(
		"no-hint-429-fast-fallback: the fallback attempt waits zero milliseconds",
		delays.length === 1 && delays[0] === 0,
		`delayMs=${delays.join(",") || "none"}`,
	);
	const models = server.requests.map((request) => request.model);
	checks.ok(
		"no-hint-429-fast-fallback: the chain's next model serves the turn",
		JSON.stringify(models) === JSON.stringify([HINT_429_PRIMARY_MODEL_ID, HINT_429_FALLBACK_MODEL_ID]) && texts[0].includes(FALLBACK_MARKER),
		`sequence=${models.join(" -> ") || "none"} text=${texts[0].slice(0, 80)}`,
	);
}

/** Tier 2: hint above the shrunk cap -> immediate fallback + bounded probe-back that restores the primary. */
async function assertProbeBack(checks, client, server, texts) {
	texts.push(await runOneTurn(client, `Return ${FALLBACK_MARKER} from whichever model can serve this turn.`));
	const applied = client.events.filter((event) => event.type === "retry_fallback_applied");
	checks.ok(
		"hinted-429-probe-back: a hint above hintedWaitCapMs falls back immediately",
		applied.length === 1 && applied[0].to === selector(HINT_429_FALLBACK_MODEL_ID) && texts[0].includes(FALLBACK_MARKER),
		`applied=${applied.length} capMs=${PROBE_BACK_CAP_MS} hintMs=${PROBE_BACK_HINT_MS} text=${texts[0].slice(0, 60)}`,
	);
	const scheduled = client.events.filter((event) => event.type === "retry_probe_scheduled");
	checks.ok(
		"hinted-429-probe-back: probe 1 is scheduled for the demoted selector at half the hint",
		scheduled.length >= 1 &&
			scheduled[0].probeIndex === 1 &&
			scheduled[0].selector === selector(HINT_429_PRIMARY_MODEL_ID) &&
			scheduled[0].atMs - scheduled[0].observedAtMs <= PROBE_BACK_HINT_MS,
		`scheduled=${JSON.stringify(scheduled.map((event) => ({ probeIndex: event.probeIndex, inMs: event.atMs - event.observedAtMs })))}`,
	);
	const probeResult = await client.waitForEvent((event) => event.type === "retry_probe_result", { timeoutMs: 60000 });
	checks.ok(
		"hinted-429-probe-back: the probe reaches the recovered primary and reports ok",
		probeResult.ok === true && probeResult.selector === selector(HINT_429_PRIMARY_MODEL_ID),
		`ok=${probeResult.ok} selector=${probeResult.selector} error=${probeResult.errorMessage ?? "none"}`,
	);
	const probeRequests = server.requests.filter((request) => request.maxTokens === 1);
	checks.ok(
		"hinted-429-probe-back: the probe costs exactly one bounded 1-token request on the primary",
		probeRequests.length === 1 && probeRequests[0].model === HINT_429_PRIMARY_MODEL_ID,
		`probeRequests=${JSON.stringify(probeRequests.map((request) => ({ model: request.model, maxTokens: request.maxTokens })))}`,
	);
	const afterProbeMs = probeResult.observedAtMs;
	texts.push(await runOneTurn(client, `Return ${PRIMARY_MARKER} from the restored model.`, { afterMs: afterProbeMs }));
	const reverted = client.events.filter((event) => event.type === "retry_fallback_reverted");
	const secondTurnModels = server.requests.filter((request) => request.atMs >= afterProbeMs).map((request) => request.model);
	checks.ok(
		"hinted-429-probe-back: the cleared cooldown restores the primary on the next turn",
		reverted.length === 1 &&
			reverted[0].to === selector(HINT_429_PRIMARY_MODEL_ID) &&
			secondTurnModels.every((model) => model === HINT_429_PRIMARY_MODEL_ID) &&
			texts[1].includes(PRIMARY_MARKER),
		`reverted=${reverted.length} secondTurn=${secondTurnModels.join(" -> ") || "none"} text=${texts[1].slice(0, 60)}`,
	);
}
