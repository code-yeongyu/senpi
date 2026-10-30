// E29 (plan §6.4, Z1.b): the example extension gondolin, unmodified. O1-O7.
//
// examples/extensions/gondolin routes the built-in tools (read, write, edit, bash, ls, find, grep) into a Gondolin micro-VM
// that it starts on session_start and awaits again in before_agent_start. B0 is a WORKING VM, recorded offline: the
// recording host has QEMU on PATH and a gondolin image store with `alpine-base:latest` pulled ahead of time, named by
// EQ_GONDOLIN_IMAGE_STORE (the M0 readiness recipe in PR #4751). The case passes it to the child as GONDOLIN_IMAGE_STORE,
// and fixtures/offline-network.mjs keeps the child off the network, so the image can only come from that store.
// Recorded once #4809 gave Bun-loaded extension modules `import.meta.dirname` (gondolin resolves its assets from it,
// https://github.com/code-yeongyu/senpi/issues/4766); before that the VM never started on a Bun child.
import { exampleExtension, OFFLINE_NETWORK } from "./support/example-extensions.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E29",
	title: "example extension gondolin, unmodified",
	observables: WITHOUT_O8,
	spec: () => {
		const store = process.env.EQ_GONDOLIN_IMAGE_STORE;
		if (!store)
			throw new Error(
				"E29 needs EQ_GONDOLIN_IMAGE_STORE: a gondolin image store with alpine-base:latest pulled, and QEMU on PATH",
			);
		return {
			env: { GONDOLIN_IMAGE_STORE: store },
			extensions: [OFFLINE_NETWORK, exampleExtension("gondolin")],
			files: { "a.txt": "alpha\n" },
			turns: [{ toolCalls: [{ id: "call_e29_read", name: "read", args: { path: "a.txt" } }] }, { text: "E29-DONE" }],
		};
	},
	async drive(run) {
		// The store is a host path; anything that names it is normalized like the sandbox root.
		run.extraRoots.push({ prefix: run.env.GONDOLIN_IMAGE_STORE, token: "<gondolin-images>" });
		await run.open();
		await run.prompt("read a.txt");
		await run.close();
		// The status names the VM by the first 8 hex digits of its random id (`Gondolin: <id> (/workspace)`): a run-scoped
		// value, replaced like a root. Nothing else in the observation is masked.
		const vmIds = new Set();
		for (const client of run.clients)
			for (const event of client.events) {
				const match = typeof event.statusText === "string" && /Gondolin: ([0-9a-f]{8}) \(/.exec(event.statusText);
				if (match) vmIds.add(match[1]);
			}
		for (const id of vmIds) run.extraRoots.push({ prefix: id, token: "<gondolin-vm>" });
	},
};
