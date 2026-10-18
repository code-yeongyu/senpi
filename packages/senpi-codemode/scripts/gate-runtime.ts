// Must stay first: the kernel graph may load through @code-yeongyu/senpi below.
import "./gate-timers.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readProcessFootprint } from "@code-yeongyu/senpi";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { BridgeServerHandle } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { EvalKernel, EvalLanguage } from "../src/tool/types.ts";
import { censusCell, legacyCells, workpoolCell } from "./gate-cells.ts";
import { helperCandidates } from "./gate-census.ts";
import { canonical, GateInputError, goldenSchema } from "./gate-report.ts";
import { observeResources } from "./gate-resources.ts";
import { cleanupRuntime } from "./gate-runtime-cleanup.ts";

const promptArgsSchema = Type.Object({
	prompt: Type.String(),
	opts: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const agentArgsSchema = Type.Object({
	prompt: Type.String(),
	schema: Type.Optional(Type.Unknown()),
	handle: Type.Optional(Type.Boolean()),
});

/** Runs in a separate host process, so js-bun and js-node really use different engines. */
async function main(): Promise<void> {
	const [target, language, goldenPath] = process.argv.slice(2);
	if (!target || !goldenPath || !["js", "py", "rb", "jl"].includes(language ?? "")) throw new GateInputError("runtime arguments");
	const golden: unknown = JSON.parse(await readFile(goldenPath, "utf8"));
	if (!Check(goldenSchema, golden)) throw new GateInputError(goldenPath);
	const names = golden[language ?? ""];
	if (!names) throw new GateInputError(`helper golden: ${language}`);
	const selected = languageFrom(language);
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-runtime-"));
	const events: KernelToHostMessage[] = [];
	const calls: { name: string; args: unknown }[] = [];
	let gcCollections = 0;
	const thresholds = { gcWatermarkBytes: 256 * 1024 ** 2, noticeBytes: 1024 * 1024 ** 2, ceilingBytes: 2048 * 1024 ** 2 };
	let observation: ReturnType<typeof observeResources> | undefined;
	let server: BridgeServerHandle | undefined;
	let kernel: EvalKernel | undefined;
	try {
		const resources = observeResources();
		observation = resources;
		const { startBridgeServer }: typeof import("../src/bridge/http-server.ts") = await import(
			pathToFileURL(`${target}/src/bridge/http-server.ts`).href
		);
		const { runEvalSchema }: typeof import("../src/bridges/schema-bridge.ts") = await import(
			pathToFileURL(`${target}/src/bridges/schema-bridge.ts`).href
		);
		const reply = async (name: string, args: unknown): Promise<unknown> => {
			calls.push({ name, args });
			if (name === "failure") throw new GateInputError("fixture failure");
			if (name === "__agent__") {
				if (!Check(agentArgsSchema, args)) throw new GateInputError("agent fixture arguments");
				if (args.handle === true && args.prompt !== "fixture-null-handle")
					return { text: "fixture-agent", id: "st_fixture", handle: "agent://st_fixture", run_epoch: 1, agent: "task" };
				return args.schema === undefined ? { text: "fixture-agent" } : { text: '{"answer":42}', data: { answer: 42 } };
			}
			if (name === "completion") {
				if (!Check(promptArgsSchema, args)) throw new GateInputError(`${name} fixture arguments`);
				const opts = args.opts ?? {};
				return "schema" in opts ? { answer: 42 } : "fixture-completion";
			}
			if (name === "__output__") return "fixture-output";
			if (name === "__schema__")
				return runEvalSchema(args, { listTools: () => [{ name: "fixture", parameters: { type: "object" } }] });
			if (name === "workpool") {
				const record = { pool_id: "wp_0123456789abcdef0123456789abcdef", status: "open", mode: "fresh", workers: [], items: [] };
				const value = typeof args === "object" && args !== null && "op" in args && args.op === "push"
					? { pool_id: record.pool_id, item_ids: [{ key: "a", item_id: "wi_fedcba9876543210fedcba9876543210" }] }
					: record;
				return { text: JSON.stringify(value), details: value };
			}
			return { text: "fixture-value", details: { answer: 42 } };
		};
		server = await startBridgeServer({
			onCall: (request) => resources.subscribe(reply(request.toolName, request.args)),
			onEmit: async () => undefined,
			onCompletion: (request) => resources.subscribe(reply("completion", { prompt: request.prompt, opts: request.opts })),
		});
		const common = {
			sessionId: "gate-runtime",
			cwd: root,
			connection: { port: server.port, token: server.token, localRoots: { local: root }, parallelPoolWidth: 2 },
			onMessage: (message: KernelToHostMessage) => {
				events.push(message);
				if (message.type === "status" && message.event.op === "memory-collected") gcCollections += 1;
				if (message.type === "tool-call") {
					void resources.subscribe(reply(message.toolName, message.args)).then(
						(value) => kernel?.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: true, value }),
						(error: unknown) => kernel?.deliverToolReply({
							type: "tool-reply", callId: message.callId, ok: false,
							error: { name: "GateInputError", message: error instanceof Error ? error.message : String(error) },
						}),
					);
				}
			},
		};
		switch (selected) {
			case "js": {
				const { JavaScriptKernel }: typeof import("../src/kernels/js/context-manager.ts") = await import(
					pathToFileURL(`${target}/src/kernels/js/context-manager.ts`).href
				);
				kernel = new JavaScriptKernel({ ...common, parallelPoolWidth: 2, localRoots: { local: root }, memory: thresholds });
				break;
			}
			case "py": {
				const { PythonKernel }: typeof import("../src/kernels/py/kernel.ts") = await import(
					pathToFileURL(`${target}/src/kernels/py/kernel.ts`).href
				);
				kernel = await PythonKernel.start({ ...common, interpreterPath: "python3", memory: thresholds });
				break;
			}
			case "rb": {
				const { RubyKernel }: typeof import("../src/kernels/rb/kernel.ts") = await import(
					pathToFileURL(`${target}/src/kernels/rb/kernel.ts`).href
				);
				kernel = RubyKernel.start({ ...common, command: "ruby", memory: { thresholds, readFootprint: readProcessFootprint } });
				break;
			}
			case "jl": {
				const { JuliaKernel }: typeof import("../src/kernels/jl/kernel.ts") = await import(
					pathToFileURL(`${target}/src/kernels/jl/kernel.ts`).href
				);
				kernel = JuliaKernel.start({ ...common, command: "julia", memory: { thresholds, readFootprint: readProcessFootprint } });
				break;
			}
			default:
				assertNever(selected);
		}
		const candidates = await helperCandidates({ target, language: selected, golden: names });
		const census = await kernel.run({ cellId: "census", code: censusCell(selected, candidates), timeoutMs: 180_000 });
		if (!census.ok) throw new GateInputError(`census ${selected}: ${census.error.message}`);
		const display = events.find((event) => event.type === "display" && event.mimeType === "application/json");
		if (!display || display.type !== "display") throw new GateInputError(`census ${selected}: no JSON display`);
		const helperNames: unknown = JSON.parse(Buffer.from(display.dataBase64, "base64").toString("utf8"));
		if (!Array.isArray(helperNames) || !helperNames.every((item): item is string => typeof item === "string"))
			throw new GateInputError(`census ${selected}: malformed names`);
		const witnesses: Record<string, unknown> = {};
		for (const cell of [...legacyCells(selected), workpoolCell(selected)]) {
			events.length = 0;
			calls.length = 0;
			let executions = 0;
			const result = await kernel.run({
				cellId: cell.name, code: cell.code, timeoutMs: 180_000,
				onStarted: () => { executions += 1; },
			});
			if (result.memory?.gcRan === true) gcCollections += 1;
			const terminalFrames = events.filter((event) => event.type === "result").length;
			if (executions !== 1 || terminalFrames !== 1)
				throw new GateInputError(`${selected}/${cell.name}: executions=${executions}, terminal events=${terminalFrames}`);
			witnesses[cell.name] = {
				ok: result.ok,
				error: result.ok ? undefined : { name: result.error.name, message: result.error.message },
				events: events.flatMap<unknown>((event) => {
					switch (event.type) {
						case "text": return [{ type: "text", stream: event.stream, data: event.data }];
						case "display": return [{ type: "display", mimeType: event.mimeType, dataBase64: event.dataBase64 }];
						case "log": return [{ type: "log", message: event.message }];
						case "phase": return [{ type: "phase", title: event.title }];
						default: return [];
					}
				}),
				hostCalls: calls.map((call) => ({ name: call.name, args: canonical(call.args) })),
				executions,
				terminalFrames,
				queueAfter: kernel.queueSnapshot(),
			};
			const errorExpected = ["traversal", "tool-error", "parallel-error"].includes(cell.name);
			if (result.ok === errorExpected)
				throw new GateInputError(`${selected}/${cell.name}: ${result.ok ? "expected an error" : result.error.message}`);
		}
		const allocation = {
			js: "let gateAllocation = Array.from({ length: 4096 }, (_, i) => i); gateAllocation = undefined;",
			py: "gate_allocation = list(range(4096))\ndel gate_allocation",
			rb: "gate_allocation = Array.new(4096) { |i| i }; gate_allocation = nil",
			jl: "gate_allocation = collect(1:4096); gate_allocation = nothing",
		};
		let memory: unknown;
		for (let index = 0; index < 50; index += 1) {
			const result = await kernel.run({ cellId: `allocation-${index}`, code: allocation[selected], timeoutMs: 180_000 });
			if (!result.ok) throw new GateInputError(`${selected}/allocation: ${result.error.message}`);
			if (result.memory?.gcRan === true) gcCollections += 1;
			memory = result.memory;
		}
		witnesses["legacy-small-cell-gc"] = { collections: gcCollections };
		// Gate-only mutation: leave the real kernel owned until after the measured
		// witness. The finally block still retires it, even in the negative probe.
		if (process.env.SENPI_CODEMODE_GATE_MUTATE !== "leak-kernel") await kernel.close();
		if (process.env.SENPI_CODEMODE_GATE_MUTATE !== "leak-bridge") await server.close();
		const cleanup = await resources.counts();
		const liveTimers = resources.liveTimers().map((site) =>
			site.replaceAll(`${pathToFileURL(target).href}/`, "").replaceAll(`${target}/`, ""));
		console.log(`GATE_RUNTIME:${JSON.stringify({
			helperNames, witnesses, memory,
			hostRuntime: process.versions.bun === undefined ? "node" : "bun",
			cleanup, liveTimers,
		})}`);
	} finally {
		await cleanupRuntime({
			retireKernel: async () => { await kernel?.close(); },
			closeBridge: async () => { await server?.close(); },
			restoreObservers: () => observation?.restore(),
			removeRoot: () => rm(root, { recursive: true, force: true }),
		});
	}
}

function languageFrom(value: string | undefined): EvalLanguage {
	switch (value) {
		case "js": case "py": case "rb": case "jl": return value;
		default: throw new GateInputError(`language ${value}`);
	}
}

function assertNever(value: never): never {
	throw new GateInputError(`language ${value}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
