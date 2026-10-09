import chalk from "chalk";
import { APP_NAME, getModelsPath } from "../config.ts";
import { ModelConfig } from "../core/model-config.ts";
import {
	discoverProviderModels,
	type ModelsDiscoveryAuth,
	ModelsDiscoveryError,
	type ModelsDiscoveryReport,
} from "../core/model-discovery.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { resolveHeadersOrThrow } from "../core/resolve-config-value.ts";

const USAGE = `${APP_NAME} models discover <provider>`;
const DISCOVERY_TIMEOUT_MS = 30_000;

/** `models discover ...` is the only `models` subcommand; anything else stays a prompt. */
export function isModelsDiscoverCommand(args: readonly string[]): boolean {
	return args[0] === "models" && args[1] === "discover";
}

function printHelp(): void {
	console.log(`Usage:
  ${USAGE}

Fetches <baseUrl>/models once for an OpenAI-compatible provider defined in models.json and adds
every listed model to that provider's "models" array (the original file is kept as a backup).
With "compat": { "supportsReasoningEffort": true } on the provider, the reasoning_efforts each
entry advertises become its thinkingLevelMap and defaultThinkingLevel.`);
}

async function resolveAuth(providerId: string, signal: AbortSignal): Promise<ModelsDiscoveryAuth> {
	// Configured headers (routing, tenant) apply whether or not the provider has a credential.
	const config = await ModelConfig.load(getModelsPath());
	const configured = await resolveHeadersOrThrow(config.getProvider(providerId)?.headers, `provider "${providerId}"`);
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
	// A keyless local server is not a registered provider; it is still discoverable.
	const auth = runtime.getProvider(providerId) ? (await runtime.getAuth(providerId, { signal }))?.auth : undefined;
	return { apiKey: auth?.apiKey, headers: { ...configured, ...auth?.headers } };
}

function describe(report: ModelsDiscoveryReport, id: string): string {
	const efforts = report.efforts[id];
	if (!efforts) return id;
	if (efforts.levels.length === 0) return `${id}  reasoning: off (no usable effort advertised)`;
	const fallback = efforts.defaultThinkingLevel ? ` (default ${efforts.defaultThinkingLevel})` : "";
	return `${id}  reasoning: ${efforts.levels.join(", ")}${fallback}`;
}

export function formatModelsDiscoveryReport(report: ModelsDiscoveryReport): string {
	const listed = report.added.length + report.updated.length + report.unchanged.length;
	const lines = [`Discovered ${listed} models for provider "${report.providerId}" from ${report.url}`];
	for (const [label, ids] of [
		["added", report.added],
		["updated", report.updated],
		["unchanged", report.unchanged],
	] as const) {
		for (const id of ids) lines.push(`  ${label.padEnd(9)} ${describe(report, id)}`);
	}
	if (report.unlisted.length > 0) lines.push(`Kept models the endpoint did not list: ${report.unlisted.join(", ")}`);
	const unmapped = Object.entries(report.efforts).filter(([, efforts]) => efforts.unmapped.length > 0);
	for (const [id, efforts] of unmapped) {
		lines.push(`Unrecognized reasoning efforts for ${id} (not used): ${efforts.unmapped.join(", ")}`);
	}
	if (report.effortsIgnored) {
		lines.push(
			`Advertised reasoning efforts were ignored: set "compat": { "supportsReasoningEffort": true } on provider "${report.providerId}" to use them.`,
		);
	}
	if (!report.written) {
		lines.push(`${report.modelsPath} already matches the endpoint; nothing written.`);
	} else {
		lines.push(`Updated ${report.modelsPath} (backup: ${report.backupPath}).`);
		if (report.commentsDropped) lines.push("Comments in models.json were not preserved; the backup keeps them.");
	}
	return lines.join("\n");
}

/** Run `models discover` with the arguments after `discover`; returns the exit code. */
export async function runModelsDiscoverCommand(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		return 0;
	}
	const [providerId, ...rest] = args;
	if (!providerId || providerId.startsWith("-") || rest.length > 0) {
		console.error(chalk.red(`Usage: ${USAGE}`));
		return 1;
	}
	const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	try {
		const report = await discoverProviderModels({
			providerId,
			modelsPath: getModelsPath(),
			auth: await resolveAuth(providerId, signal),
			signal,
		});
		console.log(formatModelsDiscoveryReport(report));
		return 0;
	} catch (error) {
		const message = error instanceof ModelsDiscoveryError || error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		return 1;
	}
}
