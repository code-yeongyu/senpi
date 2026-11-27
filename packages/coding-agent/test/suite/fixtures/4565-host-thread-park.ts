/**
 * senpi#4565 child: the host-thread pieces a wedged macOS host stopped running (an accept loop and the loop-lag
 * heartbeat on a virtual clock) beside the real permission decision for a `monitor` whose command names a path under
 * an automount trigger. The injected filesystem parks this thread for good in any synchronous call that touches such a
 * path, as the kernel does when the automounter never answers: `Atomics.wait` on a word nothing ever notifies.
 *
 * Protocol (one line each way): stdin `decide` | `tick`; stdout `ready <socket>`, `decided <action>`, `accepted`, `beat <virtual ms>`.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createDispatchAuthorizer } from "../../../src/core/extensions/builtin/permission-system/dispatch-policy.ts";
import { createLocalEventEmitter } from "../../../src/core/extensions/builtin/permission-system/events.ts";
import { createBuiltinParserRegistry } from "../../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../../src/core/extensions/builtin/permission-system/service.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { HOST_DAEMON_DIR_ENV } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "../../../src/modes/rpc/host-identity-env.ts";
import { LOOP_LAG_TICK_MS, LoopLagWatchdog } from "../../../src/modes/rpc/loop-lag-watchdog.ts";
import {
	answerAutomountTriggersFrom,
	automountTriggerPath,
} from "../../../../machine-ops/src/files/automount-trigger.ts";

const [root, trigger, target] = process.argv.slice(2);
if (!root || !trigger || !target) throw new Error("usage: 4565-host-thread-park.ts <root> <trigger> <target>");

const parked = new Int32Array(new SharedArrayBuffer(4));
const underTrigger = (value: unknown): boolean =>
	(typeof value === "string" || value instanceof URL) && `${value}`.replace(/^file:\/\//, "").startsWith(`${trigger}/`);
const fs = createRequire(import.meta.url)("node:fs") as Record<string, unknown> & {
	realpathSync: ((...args: unknown[]) => unknown) & { native: (...args: unknown[]) => unknown };
};
const park =
	<F extends (...args: never[]) => unknown>(name: string, original: F) =>
	(...args: Parameters<F>): ReturnType<F> => {
		if (underTrigger(args[0])) {
			process.stderr.write(`parked in ${name}(${String(args[0])})\n`);
			for (;;) Atomics.wait(parked, 0, 0);
		}
		return original(...args) as ReturnType<F>;
	};
for (const name of ["lstatSync", "statSync", "readdirSync", "readlinkSync", "existsSync", "accessSync", "openSync", "opendirSync"]) {
	const original = fs[name];
	if (typeof original === "function") fs[name] = park(name, original as (...args: never[]) => unknown);
}
fs.realpathSync.native = park("realpathSync.native", fs.realpathSync.native);

// The trigger is the only automount this host knows of; the view is read once before anything is decided.
answerAutomountTriggersFrom(async () => ({
	mounts: [
		{ mountPoint: "/", type: "ext4" },
		{ mountPoint: trigger, type: "autofs" },
	],
	aliases: new Map(),
	caseInsensitive: false,
}));
await automountTriggerPath("/");

const agentDir = join(root, "agent");
const projectDir = join(root, "project");
const instanceId = "generation-4565";
mkdirSync(join(root, "daemon", "generations", instanceId), { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

let clock = 0;
const watchdog = new LoopLagWatchdog({
	emit: () => {},
	log: () => {},
	now: () => clock,
	env: { [HOST_DAEMON_DIR_ENV]: join(root, "daemon"), [HOST_INSTANCE_ID_ENV]: instanceId },
	writeHeartbeat: async () => {
		process.stdout.write(`beat ${clock}\n`);
	},
});
watchdog.tick();

const service = new PermissionService(
	[{ permission: "*", pattern: "*", action: "ask" }],
	[],
	createLocalEventEmitter(),
	"full-access",
	projectDir,
	agentDir,
);
const authorizer = createDispatchAuthorizer(
	{ getAllTools: () => [] },
	() => ({ service, parsers: createBuiltinParserRegistry(), preset: "full-access", setupError: null }),
	async () => undefined,
);
const ctx = { cwd: projectDir, sessionManager: undefined } as unknown as ExtensionContext;

const socket = join(root, "host.sock");
const server = createServer((connection) => {
	process.stdout.write("accepted\n");
	connection.end();
});
server.listen(socket, () => process.stdout.write(`ready ${socket}\n`));

createInterface({ input: process.stdin }).on("line", (line) => {
	if (line === "decide") {
		// The re-armed watch of the field case: a command that only names two paths on another machine.
		const command = `bun waitSentinel.ts ${target}/t4.done ${target}/t4.status`;
		const policy = authorizer.policy({ toolCallId: "call-4565", toolName: "monitor", input: { command }, identity: { owner: {}, metadata: "4565" } }, ctx);
		process.stdout.write(`decided ${policy.action}\n`);
	} else if (line === "tick") {
		for (let step = 0; step < 10; step += 1) {
			clock += LOOP_LAG_TICK_MS;
			watchdog.tick();
		}
	}
});
