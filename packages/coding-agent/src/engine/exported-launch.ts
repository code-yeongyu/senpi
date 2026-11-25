import { getAgentDir } from "../config.ts";
import {
	type AuthBearerTokenInput,
	type AuthCheckInput,
	type AuthCredentialsInput,
	type AuthTargetInput,
	apiKey,
	bearerToken,
	checkAuth,
	credentials,
} from "./auth.ts";
import { isInvalid, optionalBoolean, optionalNumber, optionalString } from "./input.ts";
import { launchHand, launchHeadless, launchInteractive, launchPrint, launchRpc } from "./launch.ts";
import type {
	LaunchHandOptions,
	LaunchHeadlessOptions,
	LaunchInteractiveOptions,
	LaunchPrintOptions,
	LaunchRpcOptions,
} from "./launch-options.ts";
import { defaultLaunchPorts } from "./launch-process.ts";

function target(input: AuthTargetInput) {
	const provider = optionalString(input, "provider");
	if (isInvalid(provider)) return provider;
	const model = optionalString(input, "model");
	if (isInvalid(model)) return model;
	return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) };
}

/** `engine.auth`: every input is checked at run time before the command's own parse sees it. */
export const auth = {
	check: async (input: AuthCheckInput) => {
		const named = target(input);
		if (isInvalid(named)) return named;
		const refresh = optionalBoolean(input, "refresh");
		if (isInvalid(refresh)) return refresh;
		return checkAuth({ ...named, ...(refresh === undefined ? {} : { refresh }) });
	},
	credentials: async (input: AuthCredentialsInput) => {
		const named = target(input);
		if (isInvalid(named)) return named;
		const refresh = optionalBoolean(input, "refresh");
		if (isInvalid(refresh)) return refresh;
		return credentials({ ...named, ...(refresh === undefined ? {} : { refresh }) });
	},
	apiKey: async (input: AuthTargetInput) => {
		const named = target(input);
		if (isInvalid(named)) return named;
		return apiKey(named);
	},
	bearerToken: async (input: AuthBearerTokenInput) => {
		const named = target(input);
		if (isInvalid(named)) return named;
		const minExpiry = optionalNumber(input, "min_expiry_ms");
		if (isInvalid(minExpiry)) return minExpiry;
		return bearerToken({ ...named, ...(minExpiry === undefined ? {} : { min_expiry_ms: minExpiry }) });
	},
};

function ports() {
	return defaultLaunchPorts(getAgentDir);
}

/** `engine.launch`: the launch options are checked against `LaunchOptionsSchema` before anything starts. */
export const launch = {
	interactive: (options: LaunchInteractiveOptions = {}) => launchInteractive(ports(), options),
	print: (options: LaunchPrintOptions) => launchPrint(ports(), options),
	rpc: (options: LaunchRpcOptions = {}) => launchRpc(ports(), options),
	hand: (options: LaunchHandOptions = {}) => launchHand(ports(), options),
	headless: (options: LaunchHeadlessOptions = {}) => launchHeadless(ports(), options),
};
