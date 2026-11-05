import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticFacetLoader, defineFacet } from "@earendil-works/chord";
import { AgentHarness, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";
import { runSessionWorkerWithHarness, WorkerLifecycle } from "../../src/experimental/session-worker.ts";
import { KeyedProbe } from "./keyed-service.ts";

/**
 * When set to "1", the worker applies server-disconnect notices to its lifecycle only after SIGUSR2.
 * The coordinator sends that notice while a replacement server registers, so the orphan-demand grace
 * would otherwise start before the replacement has discovered the worker.
 */
export const HOLD_SERVER_DISCONNECT_ENV = "__PI_TEST_HOLD_SERVER_DISCONNECT_UNTIL_SIGUSR2";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Faux Session worker requires a session-worker invocation");
	if (process.env[HOLD_SERVER_DISCONNECT_ENV] === "1") holdServerDisconnectsUntilSignal();
	void runSessionWorkerWithHarness(process.argv.slice(2), async (session, options) => {
		if (options.provider !== "anthropic" || options.model !== "claude-sonnet-4-5") {
			throw new Error(`Unexpected faux worker model: ${options.provider}/${options.model}`);
		}
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("deterministic remote answer", { timestamp: 20 })]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = (
			await AgentHarness.create(
				{
					session,
					models,
					model: faux.getModel(),
					tools: [],
					resources: {},
				},
				BACKGROUND_CONTEXT,
			)
		).harness;
		const keyedProbeFacet = defineFacet({
			id: "@test/keyed-probe",
			setup(env) {
				const probes = env.provideMany(KeyedProbe);
				const spawn = (value: string): void => {
					const state = env.replicatedState({ value });
					let close = (): void => {};
					close = probes.spawn("probe", {
						state,
						async replace(next) {
							close();
							spawn(next);
						},
						async wait(context) {
							const signal = context.abortSignal;
							if (signal === undefined) throw new Error("Probe wait requires cancellation");
							if (signal.aborted) throw abortError(signal);
							await new Promise<void>((_resolve, reject) => {
								signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
							});
						},
					});
				};
				env.onActivate(() => spawn("first"));
			},
		});
		return { harness, facetLoader: createStaticFacetLoader([keyedProbeFacet]) };
	}).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}

function holdServerDisconnectsUntilSignal(): void {
	const serverDisconnected = WorkerLifecycle.prototype.serverDisconnected;
	const held: (() => void)[] = [];
	let released = false;
	process.once("SIGUSR2", () => {
		released = true;
		for (const deliver of held.splice(0)) deliver();
	});
	WorkerLifecycle.prototype.serverDisconnected = function (this: WorkerLifecycle, serverConnectionId: string): void {
		if (released) serverDisconnected.call(this, serverConnectionId);
		else held.push(() => serverDisconnected.call(this, serverConnectionId));
	};
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
