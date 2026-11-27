import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onCellRelease, runOutsideCell } from "./cell-run-context.js";
import { terminateProcessTrees } from "./process-tree.js";

// Mirrors SCOPE_MONITOR_OP in src/bridge/reserved.ts (this worker file cannot import TypeScript).
const SCOPE_MONITOR_OP = "scope-monitor";
const CHILD_STOP_GRACE_MS = 2_000;
const ENDED_WATCH_RE = /^No terminal session found with id/u;

/**
 * Installs `scope()`: an AsyncDisposableStack whose helpers start a resource and register its teardown, so
 * `await using s = scope()` closes everything the block opened when it exits, on success or throw. Disposal is the
 * native stack's: once only, in reverse order, every teardown attempted. `move()` hands the open resources on.
 * Teardown runs outside the cell context, so it still works after the cell was stopped; a stopped cell's servers and
 * children are also ended by cell ownership, its temp dirs by the release hook below, its watches by the host.
 */
export function installScopeHelper({ callTool, emitStatus }) {
	class CellScope extends AsyncDisposableStack {
		serve(options) {
			const server = Bun.serve(options);
			this.defer(() => runOutsideCell(() => server.stop(true)));
			return server;
		}

		spawn(command, options) {
			const child = Bun.spawn(command, options);
			this.defer(() => runOutsideCell(() => stopChild(child)));
			return child;
		}

		async tempDir(prefix = "eval-scope-") {
			const path = await mkdtemp(join(tmpdir(), prefix));
			const forget = onCellRelease(() => runOutsideCell(() => rmSync(path, { recursive: true, force: true })));
			this.defer(async () => {
				forget();
				await runOutsideCell(() => rm(path, { recursive: true, force: true }));
			});
			return path;
		}

		async monitor(args) {
			if (args?.persistent === true) {
				throw new TypeError("scope().monitor() ends its watch with the scope; start a standing watch with tool.monitor({ persistent: true })");
			}
			const result = await callTool("monitor", args ?? {});
			const bashId = result?.details?.bash_id;
			if (typeof bashId !== "string") throw new Error(`monitor did not start a watch: ${result?.text ?? String(result)}`);
			emitStatus({ op: SCOPE_MONITOR_OP, bashId, held: true });
			this.defer(async () => {
				const stopped = await callTool("kill_bash", { bash_id: bashId });
				if (isToolError(stopped) && !ENDED_WATCH_RE.test(stopped.text ?? "")) throw new Error(`kill_bash ${bashId}: ${stopped.text}`);
				emitStatus({ op: SCOPE_MONITOR_OP, bashId, held: false });
			});
			return result;
		}
	}
	globalThis.scope = () => new CellScope();
}

async function stopChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await terminateProcessTrees([child.pid], { graceMs: CHILD_STOP_GRACE_MS, settled: child.exited });
	await child.exited;
}

function isToolError(result) {
	return result !== null && typeof result === "object" && (result.hasError === true || result.isError === true);
}
