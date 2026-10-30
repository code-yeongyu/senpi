// O1-O8 collectors (plan §6.2). Each reads only what a provider, an RPC client, the session store or the sandbox
// can observe from outside the CLI; none looks at the pipeline witness (witness.mjs reads that separately).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readJsonl } from "../../../../scripts/lib/common.mjs";

/** Credential-bearing headers: compared as hashes of their values only (O4). */
const CREDENTIAL_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"proxy-authorization",
	"cookie",
	"api-key",
	"x-goog-api-key",
]);
/** Framing headers derived from the O1 body bytes; the body itself is compared in O1. */
const FRAMING_HEADERS = new Set(["content-length", "connection", "keep-alive", "transfer-encoding"]);
const ROUTE_API = [
	["/chat/completions", "openai-completions"],
	["/messages", "anthropic-messages"],
	["/responses", "openai-responses"],
	["/agent.v1.AgentService/Run", "cursor-agent"],
];
/**
 * Paths inside the work dir that are configuration a case wrote before the run (project `.senpi/`: hooks, trust
 * records), not tool effects.
 */
const CONFIG_DIRS = [".senpi"];

const TEXT_LIMIT = 8192;
const fileContent = (bytes) => {
	const text = bytes.toString("utf8");
	return bytes.length <= TEXT_LIMIT && Buffer.from(text, "utf8").equals(bytes) ? { text } : { sha: sha(bytes) };
};
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
/** A credential header's value as its hash, marked redacted so it never reads as a key (O4 still compares it). */
const redactedSha = (value) => `<redacted:${sha(value)}>`;
/**
 * The MCP inventory announcement is emitted on the extension's own schedule: in E11 (darwin-arm64, today's code) it
 * landed before the startup `pi-websearch` status events in one run and after them in another, and with the servers
 * connected one at a time through `/mcp reconnect` it landed before or after that command's own notice and
 * `command_invocation`. No case input orders it, so this one type is compared as its own list.
 */
const isSurfacesEvent = (event) => event.type === "loaded_surfaces_changed";
/**
 * A multi-session host's event-loop watchdog reports a stall when the machine is loaded (`host_stalled` with its drift):
 * whether one fires depends on how loaded the machine is, not on the session, so it is not part of O6.
 */
const isHostHealthEvent = (event) => event.type === "host_stalled";

const transcript = (file) => (file && existsSync(file) ? readJsonl(readFileSync(file, "utf8")) : []);

/** Provider requests: the fake model server's, or those of the provider fixture a case serves itself (E19 Cursor). */
const modelRequests = (run) =>
	(run.providerRequests?.() ?? run.server.requests).filter((request) => request.method === "POST");

export const collectors = {
	O1: (run) =>
		modelRequests(run).map((request) => ({ method: request.method, path: request.url, body: request.body })),
	O2: (run) =>
		modelRequests(run).map((request) => ({
			api: ROUTE_API.find(([suffix]) => request.url.endsWith(suffix))?.[1] ?? "unknown",
			route: request.url,
			model: request.body?.model ?? null,
		})),
	O3: (run) => modelRequests(run).map((request) => request.tools ?? request.body?.tools ?? null),
	O4: (run) =>
		modelRequests(run).map((request) =>
			Object.fromEntries(
				Object.entries(request.headers ?? {})
					.filter(([name]) => !FRAMING_HEADERS.has(name))
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, value]) => [name, CREDENTIAL_HEADERS.has(name) ? redactedSha(String(value)) : value]),
			),
		),
	O5: (run) => ({ calls: effectCalls(run), tree: sandboxTree(run.box.cwd), extra: run.effects }),
	// One interleaved stream per client, as a TUI or desktop client receives it. The one exception is the event type whose
	// position was measured to differ between runs of the same code: `loaded_surfaces_changed` (see isSurfacesEvent). It
	// keeps its own ordered list, compared in full; only its position among the other events is not compared.
	O6: (run) =>
		run.clients.map((client, index) => ({
			events: client.events.filter((event) => !isHostHealthEvent(event) && !isSurfacesEvent(event)),
			surfaces: surfacesChannel(client, run.surfacesSettled?.client === index ? run.surfacesSettled : undefined),
		})),
	O7: (run) => {
		const entries = transcript(run.sessionFile);
		return {
			nonEmpty: entries.length > 0,
			count: entries.length,
			durableIdStable: run.sessionIds.length > 0 && run.sessionIds.every((id) => id === run.sessionIds[0]),
			entries,
			// A case that runs more than one session at once (E30) lists the other sessions' transcripts here.
			...(run.peerSessionFiles ? { peers: run.peerSessionFiles.map((file) => transcript(file)) } : {}),
		};
	},
	O8: (run) => ({ headless: run.states }),
};

/**
 * O6 surfaces list. Without a settle barrier: every `loaded_surfaces_changed` in order. With one (E11, whose two eager
 * MCP servers connect in parallel): how many inventory snapshots the serialized wire-status captures happen to see while
 * the servers connect is a race in today's code (each connect state change, each tool registration and each
 * `get_loaded_surfaces` captures one, and an event fires only when the digest differs), so the events before the barrier
 * are not compared. What is compared exactly: the settled inventory the case read at the barrier, every surfaces event
 * after it, and the inventory read again after the last turn (a change after the barrier shows in `final` even if its
 * event shared a stdout chunk with the barrier's response).
 */
function surfacesChannel(client, settled) {
	const surfaces = client.events.filter(isSurfacesEvent);
	if (!settled) return surfaces;
	return {
		settled: settled.mcpServers,
		after: surfaces.filter((event) => client.events.indexOf(event) >= settled.at),
		final: settled.final,
	};
}

/**
 * O5 calls: every dispatched tool call in dispatch (start) order, with the target it named, the machine it ran on and
 * whether it finished. A case whose tools run concurrently holds their bodies on barriers, so completion order and
 * every event after it stay deterministic and show up in O6.
 */
function effectCalls(run) {
	const calls = [];
	for (const client of run.clients) {
		for (const event of client.events) {
			if (event.type !== "tool_execution_start") continue;
			const end = client.events.find((e) => e.type === "tool_execution_end" && e.toolCallId === event.toolCallId);
			const outcome = end ? (end.isError === true ? "error" : "ok") : "unfinished";
			calls.push({ machine: "local", op: event.toolName, path: targetOf(event.args ?? {}, run.box.cwd), outcome });
		}
	}
	return calls;
}

function targetOf(args, cwd) {
	const raw = args.path ?? args.file_path ?? args.filePath ?? args.cwd ?? null;
	if (typeof raw !== "string") return null;
	return raw.startsWith(cwd) ? relative(cwd, raw).split(sep).join("/") : raw;
}

/**
 * O5 tree: every file under the sandbox work dir, sorted: small UTF-8 text files by content (normalized like everything
 * else, so a file naming the sandbox compares equal across runs), anything else by content hash.
 */
function sandboxTree(root) {
	const out = {};
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const rel = relative(root, full).split(sep).join("/");
			if (CONFIG_DIRS.includes(rel)) continue;
			if (statSync(full).isDirectory()) walk(full);
			else out[rel] = fileContent(readFileSync(full));
		}
	};
	if (existsSync(root)) walk(root);
	return out;
}
