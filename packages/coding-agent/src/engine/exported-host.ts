import { parseHostStopGeneration } from "../modes/rpc/host-stop-generation.ts";
import {
	type HostEnsureInput,
	type HostGcInput,
	type HostHandoffInput,
	type HostShardPathInput,
	type HostStatusInput,
	type HostEndpointOptions,
	type HostStopInput,
	hostEndpointOptions,
	runHostOperation,
} from "./host.ts";
import {
	type InvalidInput,
	invalidInput,
	isInvalid,
	optionalBoolean,
	optionalNumber,
	optionalString,
	requiredNumber,
	requiredObject,
	requiredOneOf,
	requiredString,
} from "./input.ts";

const POLICIES = ["upgrade", "fallback", "never"] as const;

/**
 * The endpoint selector (paths only) and, for ensure and handoff, the presenter channel, checked at run time
 * before the core sees them. Only the inputs named here reach the core.
 */
function endpointOf(input: unknown, takesPresenter: boolean): HostEndpointOptions | InvalidInput {
	const given = typeof input === "object" && input !== null ? input : {};
	let socket: string | undefined;
	let keyRoot: string | undefined;
	if (Reflect.get(given, "endpoint") !== undefined) {
		const endpoint = requiredObject(given, "endpoint");
		if (isInvalid(endpoint)) return endpoint;
		const named = optionalString(endpoint, "socket");
		if (isInvalid(named)) return invalidInput("endpoint.socket", "a string when given");
		const root = optionalString(endpoint, "key_root");
		if (isInvalid(root)) return invalidInput("endpoint.key_root", "a string when given");
		socket = named;
		keyRoot = root;
	}
	const endpoint = {
		...(socket === undefined ? {} : { socket }),
		...(keyRoot === undefined ? {} : { key_root: keyRoot }),
	};
	if (!takesPresenter || Reflect.get(given, "presenter") === undefined) return hostEndpointOptions({ endpoint });
	const presenter = requiredObject(given, "presenter");
	if (isInvalid(presenter)) return presenter;
	if (Reflect.get(presenter, "bootstrap_fd") !== 4) return invalidInput("presenter.bootstrap_fd", "4");
	const enforcement = optionalBoolean(presenter, "enforcement");
	if (isInvalid(enforcement)) return invalidInput("presenter.enforcement", "a boolean when given");
	return hostEndpointOptions({
		endpoint,
		presenter: { bootstrap_fd: 4, ...(enforcement === true ? { enforcement: true } : {}) },
	});
}

async function ensure(input: HostEnsureInput = {}) {
	const at = endpointOf(input, true);
	if (isInvalid(at)) return at;
	const launchSpec = optionalString(input, "launch_spec");
	if (isInvalid(launchSpec)) return launchSpec;
	const policy = input?.policy === undefined ? undefined : requiredOneOf(input, "policy", POLICIES);
	if (isInvalid(policy)) return policy;
	return runHostOperation(
		{
			operation: "ensure",
			...(launchSpec === undefined ? {} : { launch_spec: launchSpec }),
			...(policy === undefined ? {} : { policy }),
		},
		at,
	);
}

async function status(input: HostStatusInput = {}) {
	const at = endpointOf(input, false);
	if (isInvalid(at)) return at;
	const all = optionalBoolean(input, "all");
	if (isInvalid(all)) return all;
	const includeWorkers = optionalBoolean(input, "include_workers");
	if (isInvalid(includeWorkers)) return includeWorkers;
	return runHostOperation({ operation: "status", all: all === true, include_workers: includeWorkers === true }, at);
}

async function stop(input: HostStopInput = {}) {
	const at = endpointOf(input, false);
	if (isInvalid(at)) return at;
	const drain = optionalBoolean(input, "drain");
	if (isInvalid(drain)) return drain;
	const force = optionalBoolean(input, "force");
	if (isInvalid(force)) return force;
	const instance = optionalString(input, "instance");
	if (isInvalid(instance)) return instance;
	const waitMs = optionalNumber(input, "wait_ms");
	if (isInvalid(waitMs)) return waitMs;
	const given = input?.expected_generation;
	const generation = given === undefined ? undefined : parseHostStopGeneration(JSON.stringify(given));
	if (given !== undefined && generation === undefined) {
		return invalidInput("expected_generation", "{ instanceId, generation, pid, processStartTime }");
	}
	return runHostOperation(
		{
			operation: "stop",
			drain: drain === true,
			force: force === true,
			...(instance === undefined ? {} : { instance }),
			...(waitMs === undefined ? {} : { wait_ms: waitMs }),
			...(generation === undefined ? {} : { expected_generation: generation }),
		},
		at,
	);
}

async function handoff(input: HostHandoffInput = {}) {
	const at = endpointOf(input, true);
	if (isInvalid(at)) return at;
	const launchSpec = optionalString(input, "launch_spec");
	if (isInvalid(launchSpec)) return launchSpec;
	const allowDowngrade = optionalBoolean(input, "allow_downgrade");
	if (isInvalid(allowDowngrade)) return allowDowngrade;
	let when: HostHandoffInput["when"];
	if (input?.when !== undefined) {
		const whenInput = requiredObject(input, "when");
		if (isInvalid(whenInput)) return whenInput;
		const idle = requiredObject(whenInput, "idle");
		if (isInvalid(idle)) return invalidInput("when.idle", "an object");
		const operation = requiredString(idle, "operation");
		const ifInstance = requiredString(idle, "if_instance");
		const ifGeneration = requiredNumber(idle, "if_generation");
		const targetBuild = requiredString(idle, "target_build");
		for (const value of [operation, ifInstance, ifGeneration, targetBuild]) if (isInvalid(value)) return value;
		when = {
			idle: {
				operation: String(operation),
				if_instance: String(ifInstance),
				if_generation: Number(ifGeneration),
				target_build: String(targetBuild),
			},
		};
	}
	return runHostOperation(
		{
			operation: "handoff",
			...(launchSpec === undefined ? {} : { launch_spec: launchSpec }),
			...(allowDowngrade === true ? { allow_downgrade: true } : {}),
			...(when === undefined ? {} : { when }),
		},
		at,
	);
}

async function gc(input: HostGcInput = {}) {
	const at = endpointOf(input, false);
	if (isInvalid(at)) return at;
	const agentDir = optionalString(input, "agent_dir");
	if (isInvalid(agentDir)) return agentDir;
	return runHostOperation({ operation: "gc", ...(agentDir === undefined ? {} : { agent_dir: agentDir }) }, at);
}

async function shardPath(input: HostShardPathInput) {
	const at = endpointOf(input, false);
	if (isInvalid(at)) return at;
	const kind = requiredOneOf(input, "kind", ["p", "i"] as const);
	if (isInvalid(kind)) return kind;
	const owner = requiredString(input, "owner");
	if (isInvalid(owner)) return owner;
	const root = optionalString(input, "root");
	if (isInvalid(root)) return root;
	return runHostOperation({ operation: "shard_path", kind, owner, ...(root === undefined ? {} : { root }) }, at);
}

export const host = { ensure, status, stop, handoff, gc, shardPath };
