/**
 * senpi#6771 fixture child: an SDK host, not the CLI, so nothing captured the private-descriptor table at startup.
 * It loads one extension through the extension loader and reports what that extension's module saw in the
 * environment, whether senpi adopted the declared name, and the loader's errors. It imports nothing but the loader,
 * so only the loader's own graph can capture the table before the extension evaluates; the adopted state is read
 * through the process-wide key every copy of `private-fds.ts` shares.
 */
import { loadExtensions } from "../../src/core/extensions/loader.ts";

const [extensionPath, cwd] = process.argv.slice(2);
if (!extensionPath || !cwd) throw new Error("usage: sdk-host-private-fds-child <extension> <cwd>");
const result = await loadExtensions([extensionPath], cwd);
const adopted: unknown = Reflect.get(globalThis, Symbol.for("senpi.private-fds.v3"));
const declared: unknown =
	typeof adopted === "object" && adopted !== null ? Reflect.get(adopted, "declared") : undefined;
process.stdout.write(
	`${JSON.stringify({
		seen: Reflect.get(globalThis, Symbol.for("senpi.test.6771.seen-table")),
		declared: declared instanceof Set && declared.has("memory-sync"),
		envAfter: process.env.SENPI_PRIVATE_FDS ?? null,
		errors: result.errors,
	})}\n`,
);
process.exit(0);
