// E28 (plan §6.4, Z1.b): the example extension sandbox, unmodified. O1-O7.
//
// examples/extensions/sandbox replaces the built-in `bash` tool with one that wraps every command in
// @anthropic-ai/sandbox-runtime (sandbox-exec on macOS, bubblewrap on Linux) under its default policy: writes allowed in
// the work dir, denied for `.env`. One bash call writes inside the work dir (allowed, O5 tree) and then tries `.env`
// (denied: the exit code is printed, the file is absent from O5's tree), all reported by one final printf. The shell's own error line for the denied write
// names the shell's install path, a host fact, so the command sends it to /dev/null and prints only the exit code. Then
// the extension's `/sandbox` command reports the active policy (O6).
import { exampleExtension } from "./support/example-extensions.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

// One printf at the end: the tool streams stdout as it arrives, so output written in pieces could reach it in one chunk
// or several.
const COMMAND =
	"printf 'inside\\n' > out/inside.txt; { printf 'x' > .env; } 2>/dev/null; rc=$?; printf 'inside=%s denied-rc=%s\\n' \"$(cat out/inside.txt)\" \"$rc\"";

export default {
	id: "E28",
	title: "example extension sandbox, unmodified",
	observables: WITHOUT_O8,
	spec: () => ({
		extensions: [exampleExtension("sandbox")],
		files: { "out/.keep": "" },
		turns: [{ toolCalls: [{ id: "call_e28_bash", name: "bash", args: { command: COMMAND } }] }, { text: "E28-DONE" }],
	}),
	async drive(run) {
		await run.open();
		await run.prompt("write inside, then try .env");
		const shown = run.nextEvent(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				e.message?.startsWith("Sandbox Configuration"),
		);
		await run.send({ type: "prompt", message: "/sandbox" });
		await shown;
		await run.close();
	},
};
