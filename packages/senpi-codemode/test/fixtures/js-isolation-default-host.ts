// A host that starts its JavaScript kernel the way the extension does, with no isolation setting: the mode comes from
// resolveJsIsolation alone. It crashes the kernel with SIGBUS, runs one more cell and prints what it saw as JSON. The
// host reaching that print is the proof: a worker-mode kernel takes the host down with the signal first.
import { resolveJsIsolation } from "../../src/config/feature-settings.ts";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const isolation = resolveJsIsolation(defaultCodemodeSettings);
const kernel = new JavaScriptKernel({
	sessionId: `isolation-default-${process.pid}`,
	cwd: process.cwd(),
	parallelPoolWidth: 1,
	...(isolation === "process" ? { isolation } : {}),
});

const run = (cellId: string, code: string) => kernel.run({ cellId, code, timeoutMs: 20_000 });

await run("mark", "globalThis.beforeCrash = 'marked'");
const modeBefore = kernel.mode;
const pidBefore = kernel.processPid;
const crashed = await run("crash", 'process.kill(process.pid, "SIGBUS")');
const after = await run("after", "return typeof globalThis.beforeCrash");
process.stdout.write(
	`${JSON.stringify({
		resolved: isolation,
		modeBefore,
		pidBefore,
		crashedOk: crashed.ok,
		crashedMessage: crashed.ok ? undefined : crashed.error.message,
		afterOk: after.ok,
		afterValue: after.ok ? after.valueRepr : undefined,
		afterKernelState: after.kernelState,
		afterNotice: after.notice,
		pidAfter: kernel.processPid,
	})}\n`,
);
await kernel.close();
