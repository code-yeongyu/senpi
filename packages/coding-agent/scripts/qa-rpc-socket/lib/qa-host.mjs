/**
 * Starts one sandboxed RPC host for the QA driver and the offload profiler through `ensureHost`
 * (bounded liveness inside the ensure, no client-side connect retry loop), connects ONE client,
 * reads `get_protocol_info`, then releases the ensure's attach hold.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHostLaunch, ensureHost as realEnsureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { stopHost as realStopHost } from "../../../src/modes/rpc/host-stop.ts";
import { connectRpc } from "./rpc-client.mjs";

export const MOCK_PROVIDER = "qa";
export const MOCK_MODEL = "qa-mock-1";

/** Sandbox agent dir whose only model is a local OpenAI-compatible mock at `baseUrl`. */
export function writeSandboxAgentDir(agentDir, { baseUrl, workdir }) {
	mkdirSync(agentDir, { recursive: true });
	const json = (name, value) => writeFileSync(join(agentDir, name), `${JSON.stringify(value, null, 2)}\n`);
	json("models.json", {
		providers: {
			[MOCK_PROVIDER]: {
				baseUrl,
				api: "openai-completions",
				apiKey: "qa-not-a-secret",
				models: [
					{
						id: MOCK_MODEL,
						name: MOCK_MODEL,
						contextWindow: 200000,
						maxTokens: 8000,
						input: ["text"],
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	});
	json("settings.json", { defaultProvider: MOCK_PROVIDER, defaultModel: MOCK_MODEL, defaultProjectTrust: "ask" });
	if (workdir) json("trust.json", { [workdir]: true });
}

/** Environment for the host: the sandbox agent dir on every brand lane, offline, no inherited lifecycle. */
export function sandboxHostEnv(agentDir, extra = {}) {
	const env = {};
	for (const key of Object.keys(process.env)) {
		if (/^(OMO_|SENPI_|PI_|T3CODE_|HERDR_)/.test(key)) env[key] = null;
	}
	return {
		...env,
		SENPI_CODING_AGENT_DIR: agentDir,
		OMO_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		SENPI_OFFLINE: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		...extra,
	};
}

const BUILT_SUPERVISOR = fileURLToPath(new URL("../../../dist/modes/rpc/host-lifecycle.js", import.meta.url));
/** Readiness bound for a host start on a loaded machine; still bounded inside `ensureHost`. */
export const QA_READINESS_TIMEOUT_MS = 90_000;

/**
 * Supervisor launch for the QA host. `built` runs the package's `dist` supervisor (whose host child is
 * `dist/cli.js`), the product a user runs; `cpuDir` runs it under `bun --cpu-prof`, and the host child
 * inherits the flags through the supervisor's exec argv.
 */
export function qaHostLaunch({ built, cpuDir }) {
	const profile = cpuDir ? ["--cpu-prof", `--cpu-prof-dir=${cpuDir}`] : [];
	return (supervisorArgs) => {
		if (built && !existsSync(BUILT_SUPERVISOR)) throw new Error(`${BUILT_SUPERVISOR} not found; run npm run build first`);
		if (built) return { command: process.execPath, args: [...profile, BUILT_SUPERVISOR, ...supervisorArgs] };
		const base = defaultHostLaunch(supervisorArgs);
		return { command: base.command, args: [...profile, ...base.args] };
	};
}

export async function startQaHost(options, deps = {}) {
	const ensureHost = deps.ensureHost ?? realEnsureHost;
	const connect = deps.connect ?? ((socket) => connectRpc(socket, { label: "qa" }));
	const stopHost = deps.stopHost ?? realStopHost;
	const agentDir = options.agentDir ?? join(options.scratch, "agent");
	const socket = options.socket ?? join(options.scratch, "h.sock");
	const hostArgs = [
		...(options.runtime ? ["--tool-runtime", options.runtime] : []),
		...(options.extension ? ["--extension", options.extension] : []),
		...(options.hostArgs ?? []),
	];
	const ensured = await ensureHost({
		socket,
		agentDir,
		hostArgs,
		env: sandboxHostEnv(agentDir, options.env),
		_test: {
			readinessTimeoutMs: options.readinessTimeoutMs ?? QA_READINESS_TIMEOUT_MS,
			launch: qaHostLaunch({ built: options.built !== false, cpuDir: options.cpuDir }),
		},
	});
	let rpc;
	try {
		rpc = await connect(socket);
	} finally {
		ensured.release();
	}
	const info = await rpc.request({ type: "get_protocol_info" });
	return {
		pid: ensured.pid,
		socket,
		agentDir,
		protocolInfo: info.data ?? {},
		rpc,
		async stop() {
			rpc.close();
			return stopHost({ socket, agentDir, force: true });
		},
	};
}
