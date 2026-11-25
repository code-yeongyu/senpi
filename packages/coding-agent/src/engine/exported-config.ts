import { getAgentDir } from "../config.ts";
import { RESOURCE_TYPES } from "../core/resource-overrides/patterns.ts";
import { agentDirectory } from "./agent-directory.ts";
import { openResourceConfig, type ResourceSetting, type ResourcesInput, setResource } from "./config.ts";
import { promptSizesWithDefaultRuntime } from "./default-runtime.ts";
import { processScope } from "./exported-packages.ts";
import {
	invalidInput,
	isInvalid,
	optionalBoolean,
	optionalNumber,
	optionalString,
	requiredBoolean,
	requiredNumber,
	requiredObject,
	requiredOneOf,
	requiredString,
} from "./input.ts";
import { type ExportHtmlInput, exportSessionHtml } from "./queries.ts";
import {
	cancelSchedule,
	listSchedules,
	runSchedule,
	type ScheduleCancelInput,
	type ScheduleRunInput,
	type ScheduleRunOptions,
} from "./schedule.ts";
import { type SessionOfPidInput, sessionOfPid } from "./session-of-pid.ts";
import { tips } from "./tips.ts";

async function resources(input: ResourcesInput = {}) {
	const local = optionalBoolean(input, "local");
	if (isInvalid(local)) return local;
	const trust = optionalBoolean(input, "trust");
	if (isInvalid(trust)) return trust;
	const opened = await openResourceConfig(processScope(), {
		local: local === true,
		...(trust === undefined ? {} : { trust }),
	});
	if (opened.kind === "error") return opened;
	const { settingsManager: _settings, ...resolved } = opened.value;
	return { ...opened, value: resolved };
}

async function setResourceSafely(setting: ResourceSetting) {
	const source = requiredString(setting, "source");
	if (isInvalid(source)) return source;
	const resourceInput = requiredObject(setting, "resource");
	if (isInvalid(resourceInput)) return resourceInput;
	const type = requiredOneOf(resourceInput, "type", RESOURCE_TYPES);
	if (isInvalid(type)) return type;
	const path = requiredString(resourceInput, "path");
	if (isInvalid(path)) return path;
	const local = optionalBoolean(setting, "local");
	if (isInvalid(local)) return local;
	const resource = { type, path };
	if (local === true) {
		const state = requiredOneOf(setting, "state", ["inherit", "load", "unload"] as const);
		if (isInvalid(state)) return state;
		const trust = optionalBoolean(setting, "trust");
		if (isInvalid(trust)) return trust;
		return setResource(processScope(), {
			local: true,
			source,
			resource,
			state,
			...(trust === undefined ? {} : { trust }),
		});
	}
	const enabled = requiredBoolean(setting, "enabled");
	if (isInvalid(enabled)) return enabled;
	return setResource(processScope(), { source, resource, enabled });
}

export const config = {
	agentDir: () => agentDirectory(),
	resources,
	setResource: setResourceSafely,
};

async function runScheduleSafely(input: ScheduleRunInput, options: ScheduleRunOptions) {
	if (typeof options?.onEvent !== "function") return invalidInput("onEvent", "a function");
	const watch = optionalBoolean(input, "watch");
	if (isInvalid(watch)) return watch;
	const exec = optionalString(input, "exec");
	if (isInvalid(exec)) return exec;
	const numbers: Partial<Record<"poll_seconds" | "timeout_seconds" | "concurrency", number>> = {};
	for (const key of ["poll_seconds", "timeout_seconds", "concurrency"] as const) {
		const value = optionalNumber(input, key);
		if (isInvalid(value)) return value;
		if (value !== undefined) numbers[key] = value;
	}
	const signal = input?.signal;
	if (signal !== undefined && !(signal instanceof AbortSignal))
		return invalidInput("signal", "an AbortSignal when given");
	return runSchedule(
		{ agentDir: getAgentDir() },
		{
			...(watch === undefined ? {} : { watch }),
			...(exec === undefined ? {} : { exec }),
			...numbers,
			...(signal === undefined ? {} : { signal }),
		},
		{ onEvent: options.onEvent },
	);
}

export const schedule = {
	list: () => listSchedules({ agentDir: getAgentDir() }),
	cancel: async (input: ScheduleCancelInput) => {
		const id = requiredString(input, "id");
		if (isInvalid(id)) return id;
		return cancelSchedule({ agentDir: getAgentDir() }, { id });
	},
	run: runScheduleSafely,
};

export const queries = {
	sessionOfPid: async (input: SessionOfPidInput) => {
		const pid = requiredNumber(input, "pid");
		if (isInvalid(pid)) return pid;
		return sessionOfPid({ pid });
	},
	sessions: {
		exportHtml: async (input: ExportHtmlInput) => {
			const session = requiredString(input, "session");
			if (isInvalid(session)) return session;
			const out = optionalString(input, "out");
			if (isInvalid(out)) return out;
			return exportSessionHtml({ session, ...(out === undefined ? {} : { out }) });
		},
	},
	promptSizes: (_input: Record<string, never> = {}) => promptSizesWithDefaultRuntime(),
	tips: () => tips(),
};
