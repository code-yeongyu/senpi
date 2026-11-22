// Shared pieces of the E26-E29 cases (plan §6.4, Z1.b): the shipped example extensions under
// packages/coding-agent/examples/extensions, each loaded unmodified by path, and the fixture that keeps the ones that
// name internet hosts in code offline (fixtures/offline-network.mjs).
import { join } from "node:path";
import { repoRoot } from "../../../../scripts/lib/common.mjs";
import { FIXTURES } from "./case-run.mjs";

export const OFFLINE_NETWORK = join(FIXTURES, "offline-network.mjs");

/** The example extension directory `name` in the checkout under test. */
export const exampleExtension = (name, repo = repoRoot()) =>
	join(repo, "packages", "coding-agent", "examples", "extensions", name);

/**
 * Select an extension-registered provider and model for every child this run starts: the harness's default
 * `--provider mock --model mock-model` pair is replaced in place (the mock provider stays configured, unused).
 */
export function useModel(run, provider, model) {
	const args = [...run.args];
	args[args.indexOf("--provider") + 1] = provider;
	args[args.indexOf("--model") + 1] = model;
	run.args = args;
}
