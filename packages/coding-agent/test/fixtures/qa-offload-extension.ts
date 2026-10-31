// QA fixture for senpi#3566 todo 8: registers one child module and, at session_start, offloads it and appends the
// result as a custom entry (`qa_offload_result`), which reaches RPC clients as `entry_appended`.
import type { ExtensionAPI } from "../../src/index.ts";

export default function qaOffloadExtension(pi: ExtensionAPI): void {
	pi.registerChildModule({ id: "qa-whoami", module: "./qa-offload/whoami.ts", export: "whoami" });
	pi.on("session_start", (_event, ctx) => {
		if (ctx.offload === undefined) return;
		ctx.offload("qa-whoami", { from: "session_start" }).then(
			(result) => pi.appendEntry("qa_offload_result", { ok: true, result, serverPid: process.pid }),
			(error: unknown) =>
				pi.appendEntry("qa_offload_result", {
					ok: false,
					code: Reflect.get(Object(error), "code") ?? null,
					message: error instanceof Error ? error.message : String(error),
					serverPid: process.pid,
				}),
		);
	});
}
