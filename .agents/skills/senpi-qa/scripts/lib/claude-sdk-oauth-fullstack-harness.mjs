/**
 * Shared hermetic stack harness for the claude-sdk-oauth fullstack probe.
 *
 * Owns the pieces --baseline and --matrix both need: the loopback-only SSE
 * server, the isolated sandbox HOME, the SDK-boundary interception that
 * measures every query creation and every submitted user payload, and the real
 * createAgentSession() wiring. No credentials and no network egress: the Claude
 * Code subprocess is pinned to 127.0.0.1 via ANTHROPIC_BASE_URL.
 */

import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardRealAuth, makeSandbox, repoRoot, track } from "./common.mjs";
import { loopbackSseBody, seedProbeAgentDir } from "./claude-sdk-oauth-fullstack-support.mjs";
import { applyHermeticEnvironment, assertHermeticEnvironment } from "./claude-sdk-oauth-hermetic-env.mjs";

const ROOT = repoRoot();
export const SOURCE_ROOT = join(ROOT, "packages", "coding-agent", "src");

function extensionModule(name) {
	return pathToFileURL(join(SOURCE_ROOT, "core", "extensions", "builtin", "claude-sdk-oauth", `${name}.ts`)).href;
}

/**
 * Splits the canned SSE body just after the first text delta. The prefix is
 * enough for the SDK to claim the turn and start streaming; the suffix ends it.
 * A phase that needs a genuine in-flight window holds the suffix until it
 * releases the turn — a completion handshake, never a timed wait.
 */
function splitSseBody(body) {
	const marker = "event: content_block_stop";
	const cut = body.indexOf(marker);
	return cut === -1 ? { head: body, tail: "" } : { head: body.slice(0, cut), tail: body.slice(cut) };
}

async function startLoopbackServer(onRequest, holdRelease) {
	const server = track(
		createServer((request, response) => {
			if (request.method !== "POST") {
				response.writeHead(200);
				response.end();
				return;
			}
			let raw = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				raw += chunk;
			});
			request.on("end", () => {
				let body;
				try {
					body = JSON.parse(raw);
				} catch {
					body = { messages: [] };
				}
				const sequence = onRequest({
					bytes: raw.length,
					messages: Array.isArray(body.messages) ? body.messages.length : 0,
				});
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				const sse = loopbackSseBody(`probe-reply-${sequence}`, sequence);
				const hold = holdRelease?.();
				if (!hold) {
					response.end(sse);
					return;
				}
				// Stream the opening events so the turn is genuinely in flight, tell the
				// phase it may act now, and finish only when it releases the hold.
				const { head, tail } = splitSseBody(sse);
				response.write(head, () => hold.inFlight?.());
				void hold.release.then(() => response.end(tail));
			});
		}),
	);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
		throw new Error("probe server did not bind exclusively to 127.0.0.1");
	}
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

/**
 * Boot the hermetic stack. Returns the sandbox, the loopback request log, the
 * query-creation log measured at overrideSdkBoundary, and the live modules the
 * scenario driver needs (registry boundary for the injected clock, reattach
 * store, and a session factory).
 */
export async function bootHermeticStack({ sandboxLabel = "claude-sdk-fullstack-probe", onPayload, onRequest } = {}) {
	const authGuard = guardRealAuth();
	const box = makeSandbox(sandboxLabel);
	const providerRequests = [];
	let pendingHold;
	const { server, baseUrl } = await startLoopbackServer(
		(entry) => {
			providerRequests.push(entry);
			onRequest?.();
			return providerRequests.length;
		},
		() => {
			const hold = pendingHold;
			pendingHold = undefined;
			return hold;
		},
	);

	seedProbeAgentDir(box.agentDir);
	// The ambient auth lane hands the probe's own environment to the Claude Code
	// subprocess, so inherited credentials and proxies are scrubbed BEFORE the
	// hermetic pins are applied, and the result is asserted below.
	const scrubbed = applyHermeticEnvironment(process.env, {
		HOME: box.dir,
		USERPROFILE: box.dir,
		TMPDIR: box.dir,
		SENPI_CODING_AGENT_DIR: box.agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: box.sessionDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: "fullstack-probe-dummy-key",
		CLAUDE_CONFIG_DIR: join(box.dir, "claude-config"),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_DISABLE_TELEMETRY: "1",
		SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION: "ambient",
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	});
	assertHermeticEnvironment(process.env, baseUrl);

	const creations = [];
	let forkCount = 0;
	// After a fork, the entry adopts the fork's newly-minted id (the fork-id
	// persistence fix), so the NEXT query resumes that id instead of the fork's
	// parent. The alias map ties the adopted id back to the fork's lineage so a
	// reattach resuming it reads as the SAME lineage, not a new one.
	const forkAliases = new Map();
	let lastFork = null;
	const boundaryModule = await import(extensionModule("sdk-boundary"));
	const baseQuery = boundaryModule.getSdkBoundary().query;
	boundaryModule.overrideSdkBoundary({
		query: (input) => {
			const options = input.options ?? {};
			// The resident registry always creates its query with the replay-user-messages
			// extraArg (session-registry.ts); the flatten branch in stream.ts never does.
			const resident = options.extraArgs !== undefined && "replay-user-messages" in options.extraArgs;
			// A fork resumes the SAME transcript id with forkSession+resumeSessionAt and
			// lets the CLI mint the branch, so the fork flag — not the id — is what marks
			// a new lineage. `lineage` is the probe's own branch label built from that.
			const forked = options.forkSession === true;
			const transcriptId = options.sessionId ?? options.resume ?? null;
			let lineage;
			if (forked) {
				forkCount += 1;
				lineage = `${transcriptId}#fork${forkCount}`;
				lastFork = { parent: transcriptId, lineage };
			} else if (transcriptId && forkAliases.has(transcriptId)) {
				lineage = forkAliases.get(transcriptId);
			} else if (transcriptId && lastFork && transcriptId !== lastFork.parent) {
				// A new resume target right after a fork is that fork's minted
				// branch: alias it to the fork's lineage.
				forkAliases.set(transcriptId, lastFork.lineage);
				lineage = lastFork.lineage;
			} else {
				lineage = forkCount === 0 ? transcriptId : `${transcriptId}#fork${forkCount}`;
			}
			const record = {
				index: creations.length + 1,
				path: resident ? "resident-registry" : "flatten-stream",
				sessionId: transcriptId,
				lineage,
				resume: options.resume ?? null,
				resumeAt: options.resumeSessionAt ?? null,
				forked,
				payloads: [],
			};
			creations.push(record);
			const prompt = input.prompt;
			if (typeof prompt === "string") return baseQuery(input);
			const observed = (async function* () {
				for await (const message of prompt) {
					record.payloads.push(message);
					onPayload?.({ creation: record.index, path: record.path, lineage: record.lineage, message });
					yield message;
				}
			})();
			return baseQuery({ ...input, prompt: observed });
		},
	});

	const registryModule = await import(extensionModule("session-registry"));
	const reattachModule = await import(extensionModule("session-reattach"));
	const { createAgentSession } = await import(pathToFileURL(join(SOURCE_ROOT, "index.ts")).href);

	return {
		box,
		authGuard,
		baseUrl,
		scrubbed,
		providerRequests,
		creations,
		registryModule,
		reattachModule,
		/**
		 * Holds the NEXT loopback response open until the returned release() is
		 * called, giving a phase a real in-flight window to abort into.
		 */
		holdNextResponse(onInFlight) {
			let releaseHold;
			pendingHold = {
				inFlight: onInFlight,
				release: new Promise((resolve) => {
					releaseHold = resolve;
				}),
			};
			return () => releaseHold?.();
		},
		createAgentSession: () =>
			createAgentSession({ cwd: box.cwd, agentDir: box.agentDir, noTools: "all", autoTitleSessions: false }),
		/**
		 * Close every resident SDK session so the Claude Code subprocess exits and
		 * stops writing into CLAUDE_CONFIG_DIR. Without this the child recreates the
		 * sandbox directory right after cleanup and leaks a temp dir per run.
		 */
		async closeResidentSessions(senpiSessionId) {
			try {
				if (senpiSessionId) registryModule.closeSession(senpiSessionId, "session_shutdown");
			} catch {
				// best-effort teardown
			}
			// Let the subprocess observe the closed stdin and exit before the sandbox
			// is removed — drained on the macrotask queue, never a fixed sleep.
			for (let round = 0; round < 5; round += 1) {
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		async shutdown() {
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/** Resolve two distinct claude-sdk-oauth models: the primary and a switch target. */
export function resolveMatrixModels(session, primaryId) {
	const primary = session.modelRuntime.getModel("claude-sdk-oauth", primaryId);
	if (!primary) throw new Error("claude-sdk-oauth provider did not register its models");
	const candidates = session.modelRuntime.getModels?.("claude-sdk-oauth") ?? [];
	const alternateId = candidates.map((model) => model.id).find((id) => id !== primaryId);
	const alternate = alternateId ? session.modelRuntime.getModel("claude-sdk-oauth", alternateId) : undefined;
	if (!alternate) throw new Error("claude-sdk-oauth provider registered only one model; phase (c) needs two");
	return { primary, alternate };
}
