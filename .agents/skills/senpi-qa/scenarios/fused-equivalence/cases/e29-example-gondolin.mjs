// E29 (plan §6.4, Z1.b): the example extension gondolin, unmodified. O1-O7.
//
// examples/extensions/gondolin routes the built-in tools (read, write, edit, bash, ls, find, grep) into a Gondolin micro-VM
// that it starts on session_start and awaits again in before_agent_start. Starting a VM needs QEMU and a guest image that
// Gondolin downloads on first use; the recording hosts have neither offline, so B0 pins what today's code does there: the
// tool overrides are declared (O3), session_start and before_agent_start report the start failure as extension errors
// (O6), and the routed `read` call fails with that error (O5/O6/O7). fixtures/offline-network.mjs is loaded so a host that
// has QEMU cannot reach the network for the image either. (A working-VM cell needs QEMU and a staged image store on every
// recording host: raised in the P0-05e PR as an M0 readiness item, plan §M0 item 9.)
import { exampleExtension, OFFLINE_NETWORK } from "./support/example-extensions.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E29",
	title: "example extension gondolin, unmodified",
	observables: WITHOUT_O8,
	spec: () => ({
		extensions: [OFFLINE_NETWORK, exampleExtension("gondolin")],
		files: { "a.txt": "alpha\n" },
		turns: [{ toolCalls: [{ id: "call_e29_read", name: "read", args: { path: "a.txt" } }] }, { text: "E29-DONE" }],
	}),
	async drive(run) {
		await run.open();
		await run.prompt("read a.txt");
		await run.close();
	},
};
