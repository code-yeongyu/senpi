import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Check } from "typebox/value";
import { buildFingerprint, builtWorkspaces, fingerprintSchema } from "./gate-build-inputs.ts";
import { GateInputError } from "./gate-input-error.ts";

/** Workspace imports resolve through dist, not the source tree being compared. */
export async function assertFreshTarget(target: string): Promise<void> {
	for (const workspace of await builtWorkspaces(target)) {
		await stat(workspace.entry).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				throw new GateInputError(`stale workspace dist: ${workspace.label} (missing build entry; run the gate build)`);
			throw error;
		});
		const inputs = await buildFingerprint(workspace.directory);
		let recorded: unknown;
		try {
			recorded = JSON.parse(await readFile(resolve(workspace.directory, ".senpi-gate-inputs.json"), "utf8"));
		} catch (error: unknown) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				throw new GateInputError(`stale workspace dist: ${workspace.label} (missing input fingerprint; run the gate build)`);
			throw error;
		}
		if (!Check(fingerprintSchema, recorded)) throw new GateInputError(`build fingerprint: ${workspace.label}`);
		const changed = [...new Set([...Object.keys(recorded), ...Object.keys(inputs)])]
			.filter((path) => recorded[path] !== inputs[path]);
		if (changed.length > 0)
			throw new GateInputError(`stale workspace dist: ${workspace.label} (changed or deleted inputs: ${changed.join(", ")}; run the gate build)`);
	}
}
