// EQ determinism contract: the host facts in the CLI child's prompt are pinned (LEAD ruling for #4751, option 2,
// test-only; drift check conf/senpi-4751-E27-pin-drift.md, conditions C1-C3).
//
// The CLI renders its host into the system prompt: coding-agent's `<workstation>` block
// (packages/coding-agent/src/core/dynamic-prompt/workstation.ts: CPU model, core count, kernel) and senpi-codemode's
// eval `Host:` line (packages/senpi-codemode/src/extension/host-facts.ts: CPU model, core count). The text the harness
// compares tokenizes those facts (cases/support/host.mjs), but a value computed INSIDE the child from that text cannot
// be: the OpenAI `prompt_cache_key` (packages/ai/src/api/openai-prompt-cache.ts) hashes the raw system prompt, so
// E27's golden held the recording host's core count, kernel release and CPU model.
//
// Mechanism: the product's own test-only seam (senpi#4660), `SENPI_TEST_WORKSTATION={"cpuModel","cores","kernel"}`.
// Both prompt sites read it (workstation.ts readWorkstationFacts, host-facts.ts hostLine), and nothing else does: no
// `node:os` function is patched, so pool sizes and every other host read in the child stay real.
//
// Pinned values (synthetic, so no real host reports them; a child that ignores the seam differs on every host):
//   fact          pinned value
//   CPU model     darwin-arm64: "Apple EQ-Synthetic CPU", else "EQ-Synthetic CPU". The darwin-arm64 value keeps the
//                 "Apple " prefix because workstation.ts derives the GPU line from it, so which prompt lines exist on a
//                 platform (behavior) does not change.
//   core count    997
//   kernel        "<os.type()> 0.0.0-eq-synthetic" (the real type: goldens are keyed by platform, see host.mjs)
// The triple is recorded as `hostPin` in every golden directory's baseline.json (observe.mjs baselineManifest).
//
// Scope, per process: case-run.mjs puts the variable into the env of every CLI child of an EQ case run (the rpc child,
// the TUI child, the multi-session host). Every process those children start inherits it (tool commands, eval
// kernels, MCP servers, a spawned host), and any senpi process among them renders the pinned facts. Under the fused
// placement this is one process tree on one machine, so both pipelines see the same pinned facts. A process the case
// run did not start (a hand on another machine, a later placement) gets no pin from this contract; whether those
// placements pin it, and whose facts enter the prompt there, is for their own rows (S27a, DM1, V5).
//
// The normalizer tokenizes the pinned values with the same tokens as the real ones (host.mjs), so no other golden
// changes.
import * as os from "node:os";

export const HOST_PIN_ENV = "SENPI_TEST_WORKSTATION";

/** The pinned workstation facts for this host's platform, in the seam's JSON shape. */
export function pinnedWorkstation(platform = process.platform, arch = process.arch, type = os.type()) {
	return {
		cpuModel: platform === "darwin" && arch === "arm64" ? "Apple EQ-Synthetic CPU" : "EQ-Synthetic CPU",
		cores: 997,
		kernel: `${type} 0.0.0-eq-synthetic`,
	};
}

/** The env entry that pins the host facts in a CLI child (every runtime: the seam is read by the product itself). */
export function hostPinEnv() {
	return { [HOST_PIN_ENV]: JSON.stringify(pinnedWorkstation()) };
}

/** The pinned facts as normalizer `hostFacts` entries, with the same tokens as the real ones (host.mjs). */
export function pinnedHostFacts() {
	const { cpuModel, cores, kernel } = pinnedWorkstation();
	return [
		{ value: kernel, token: "<host:kernel>" },
		{ value: kernel.slice(kernel.indexOf(" ") + 1), token: "<host:release>" },
		{ value: `${cpuModel} (${cores} cores)`, token: "<host:cpu>" },
		{ value: cpuModel, token: "<host:cpu-model>" },
		{ value: ` ${cores} cores`, token: " <host:cores> cores" },
	];
}
