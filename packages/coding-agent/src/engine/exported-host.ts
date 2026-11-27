import { parseHostStopGeneration } from "../modes/rpc/host-stop-generation.ts";
import {
	type HostEnsureInput,
	type HostGcInput,
	type HostHandoffInput,
	type HostShardPathInput,
	type HostStatusInput,
	type HostStopInput,
	runHostOperation,
} from "./host.ts";
import {
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

/** Only the inputs named here reach the core: an endpoint, key root or presenter channel in the input is ignored. */
async function ensure(input: HostEnsureInput = {}) {
	const launchSpec = optionalString(input, "launch_spec");
	if (isInvalid(launchSpec)) return launchSpec;
	const policy = input?.policy === undefined ? undefined : requiredOneOf(input, "policy", POLICIES);
	if (isInvalid(policy)) return policy;
	return runHostOperation({
		operation: "ensure",
		...(launchSpec === undefined ? {} : { launch_spec: launchSpec }),
		...(policy === undefined ? {} : { policy }),
	});
}

async function status(input: HostStatusInput = {}) {
	const all = optionalBoolean(input, "all");
	if (isInvalid(all)) return all;
	const includeWorkers = optionalBoolean(input, "include_workers");
	if (isInvalid(includeWorkers)) return includeWorkers;
	return runHostOperation({ operation: "status", all: all === true, include_workers: includeWorkers === true });
}

async function stop(input: HostStopInput = {}) {
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
	return runHostOperation({
		operation: "stop",
		drain: drain === true,
		force: force === true,
		...(instance === undefined ? {} : { instance }),
		...(waitMs === undefined ? {} : { wait_ms: waitMs }),
		...(generation === undefined ? {} : { expected_generation: generation }),
	});
}

async function handoff(input: HostHandoffInput = {}) {
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
	return runHostOperation({
		operation: "handoff",
		...(launchSpec === undefined ? {} : { launch_spec: launchSpec }),
		...(allowDowngrade === true ? { allow_downgrade: true } : {}),
		...(when === undefined ? {} : { when }),
	});
}

async function gc(input: HostGcInput = {}) {
	const agentDir = optionalString(input, "agent_dir");
	if (isInvalid(agentDir)) return agentDir;
	return runHostOperation({ operation: "gc", ...(agentDir === undefined ? {} : { agent_dir: agentDir }) });
}

async function shardPath(input: HostShardPathInput) {
	const kind = requiredOneOf(input, "kind", ["p", "i"] as const);
	if (isInvalid(kind)) return kind;
	const owner = requiredString(input, "owner");
	if (isInvalid(owner)) return owner;
	const root = optionalString(input, "root");
	if (isInvalid(root)) return root;
	return runHostOperation({ operation: "shard_path", kind, owner, ...(root === undefined ? {} : { root }) });
}

export const host = { ensure, status, stop, handoff, gc, shardPath };
