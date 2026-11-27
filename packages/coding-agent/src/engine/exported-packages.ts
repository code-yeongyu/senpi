import { getAgentDir } from "../config.ts";
import { builtInExtensions } from "../extensions/index.ts";
import type { EngineCommandScope } from "./command-settings.ts";
import { listModelsWithDefaultRuntime } from "./default-runtime.ts";
import { isInvalid, optionalBoolean, optionalString, requiredString } from "./input.ts";
import { discoverModels, type ModelsDiscoverInput, type ModelsListInput, updateModelCatalogs } from "./models.ts";
import {
	installPackage,
	listPackages,
	type PackageCommandOptions,
	type PackageListInput,
	type PackageSourceInput,
	type PackageUpdateInput,
	removePackage,
	updatePackages,
} from "./packages.ts";

/** The process's directories and the built-in extensions; no trust decider, so no terminal is ever read. */
export function processScope(): EngineCommandScope {
	return { cwd: process.cwd(), agentDir: getAgentDir(), extensionFactories: builtInExtensions };
}

function progressOnly(options: PackageCommandOptions | undefined): PackageCommandOptions {
	return typeof options?.onProgress === "function" ? { onProgress: options.onProgress } : {};
}

async function sourceCommand(
	input: PackageSourceInput,
	run: typeof installPackage,
	options: PackageCommandOptions | undefined,
) {
	const source = requiredString(input, "source");
	if (isInvalid(source)) return source;
	const local = optionalBoolean(input, "local");
	if (isInvalid(local)) return local;
	const trust = optionalBoolean(input, "trust");
	if (isInvalid(trust)) return trust;
	return run(
		processScope(),
		{ source, local: local === true, ...(trust === undefined ? {} : { trust }) },
		progressOnly(options),
	);
}

export const packages = {
	install: (input: PackageSourceInput, options?: PackageCommandOptions) =>
		sourceCommand(input, installPackage, options),
	remove: (input: PackageSourceInput, options?: PackageCommandOptions) => sourceCommand(input, removePackage, options),
	list: async (input: PackageListInput = {}) => {
		const trust = optionalBoolean(input, "trust");
		if (isInvalid(trust)) return trust;
		return listPackages(processScope(), trust === undefined ? {} : { trust });
	},
	update: async (input: PackageUpdateInput = {}, options?: PackageCommandOptions) => {
		const source = optionalString(input, "source");
		if (isInvalid(source)) return source;
		const trust = optionalBoolean(input, "trust");
		if (isInvalid(trust)) return trust;
		return updatePackages(
			processScope(),
			{ ...(source === undefined ? {} : { source }), ...(trust === undefined ? {} : { trust }) },
			progressOnly(options),
		);
	},
};

export const models = {
	update: () => updateModelCatalogs({ agentDir: getAgentDir() }),
	discover: async (input: ModelsDiscoverInput) => {
		const provider = requiredString(input, "provider");
		if (isInvalid(provider)) return provider;
		return discoverModels({ agentDir: getAgentDir() }, { provider });
	},
	list: async (input: ModelsListInput = {}) => {
		const pattern = optionalString(input, "pattern");
		if (isInvalid(pattern)) return pattern;
		return listModelsWithDefaultRuntime(pattern === undefined ? {} : { pattern });
	},
};
