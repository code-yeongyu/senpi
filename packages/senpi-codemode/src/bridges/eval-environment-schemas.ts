import type { EvalSchemaResult } from "./schema-bridge.ts";

export type NamedEvalSchema = Extract<EvalSchemaResult, { readonly name: string }>;

/**
 * The on-demand documentation for package environments and isolated cells (`tool_schema("eval:environments")` and
 * `tool_schema("eval:isolation")`). Like the other virtual entries they are never listed, never run anything, and add
 * nothing to the eval prompt or input schema. Every magic, code and message named here is the one the source emits.
 */
export const environmentsEntry: NamedEvalSchema = {
	name: "eval:environments",
	description: [
		"Host magic cells: a cell whose first code line (blank and comment lines skipped) is one of these runs on the host, in the language kernel's queue, so it orders with ordinary cells and a queued one is removed by stop like any queued cell. A magic followed by more code is refused: put it on its own cell, then run the code that uses it in the next cell.",
		"py: %pip install <requirements ...> installs into the session's environment (a trailing backslash continues the line). Result: installed <packages> into <mode> (revision <n>); already-imported modules stay cached until reset.",
		"js: %bun add <packages ...> or %npm add <packages ...> (install is accepted as a synonym of add). Result: added <packages> with <installer> into <mode>[ (revision <n>)]; already-imported modules stay cached until reset. A package the project's own node_modules still shadows is named with environment_resolution_conflict in the result.",
		"py and js: %environment managed | project selects where installs go. managed (the default) uses per-session revisions under the session's artifacts directory (or environments.managedRoot) and never touches project files; project installs into the session directory (py: .senpi/python-packages; js: the project root).",
		"py and js: %load <file> runs a local file as a cell, read when its turn comes in the queue, with the file's name in tracebacks; definitions persist like any cell. It accepts a path relative to the session directory, local:// or file://, reads files up to 8 MiB and never fetches remote URLs.",
		"Installs pause the run budget like a bridge call, stream the installer's output into the cell, detach past the foreground window like any cell, and are stopped by stop.",
		'js and py: packages.install(manager, requirements, {timeout?}) runs the same install as a call instead of a magic: manager "pip" in a Python cell, "bun" or "npm" in a JavaScript cell; requirements is a non-empty string or a non-empty list of non-empty strings, and timeout is a positive number of seconds (default 600; py spells it packages.install("pip", [...], timeout=...)). pip receives the requirement list as separate arguments, never re-split; a js package spec cannot contain whitespace. It drives the same session environment the magic uses, returns that install\'s receipt (py: manager, mode, root, revision, requested, resolved, changed; js: installer, mode, revision, added, shadowed) and is cancelled by stop like a magic install. Unlike the magic, the installer\'s output is not streamed into the cell: the receipt is the result, and a failure carries the installer\'s stderr tail.',
		"Install failures are cell errors that start with their code: environment_install_failed (an argument the host rejects: an unknown manager, an empty requirement list, a bun/npm requirement with whitespace or a non-positive timeout; or an installer failure, with the installer's stderr tail. A JS options value that is not an object, or a Python timeout that float() cannot convert, fails earlier in the cell with a plain TypeError or ValueError), environment_install_timeout (a packages.install() still running after its timeout, default 600 s, was stopped), environment_install_cancelled (stopped before or during the install), environment_installer_unavailable (no interpreter or no pip; no JavaScript package environment in this session; neither bun nor npm on PATH, or the chosen one missing; the installer failed to start; installs turned off with environments.autoProvision: false; or pip asked of a session with no Python interpreter, or bun/npm asked of a Python cell), environment_resolution_conflict (py: pip reported a dependency conflict). A %load failure, and a magic refused because more code follows it, are plain cell errors without a code.",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			"%pip": { description: "py: %pip install <requirements ...>" },
			"%bun": { description: "js: %bun add <packages ...>" },
			"%npm": { description: "js: %npm add <packages ...>" },
			"%environment": { enum: ["managed", "project"] },
			"%load": { description: "py and js: %load <path | local://... | file://...>" },
			"packages.install": {
				description: "js and py: packages.install(manager, requirements, {timeout?}) (py: timeout=...)",
			},
		},
	},
};

export const isolationEntry: NamedEvalSchema = {
	name: "eval:isolation",
	description: [
		"isolate: true runs one JavaScript cell in a fresh QuickJS sandbox instead of the persistent kernel. It is available only when sandbox.enabled is on in the codemode settings; only then does the eval input schema carry the isolate field. An older senpi drops the field and would run the code as an ordinary cell, so check this entry before relying on it.",
		'Requests are refused with eval_isolate_invalid when sandbox cells are turned off, when language is not "js", when isolate is not a boolean, with reset: true (a sandbox cell always starts fresh), or when eval runs through a proxy that cannot isolate a cell.',
		"An isolated cell shares nothing with the kernel. Its globals are print, display, text, image, console, exit, tool.<name>(args) (also reachable as tools), ALL_TOOLS (the names and descriptions of the tools it may call), load and store. Its tool calls go through the host, so permission hooks still apply, and tool calls still pending when the script settles are aborted. The store is rejected: load returns nothing and store fails with eval_isolate_no_state.",
		"Limits: sandbox.timeoutSeconds (default 300) and sandbox.memoryMb (default 64; SENPI_CODEMODE_SANDBOX_MEMORY_MB overrides it). The result's runtime names quickjs and its version, with isolation sandbox.",
		"Failures start with their code: eval_isolate_timeout, eval_isolate_aborted, eval_isolate_memory_limit, eval_isolate_unresolved_promise (the script ended with a promise still pending), eval_isolate_no_state, eval_isolate_unavailable (the sandbox itself failed: it could not load, or its worker crashed, exited or lost its output; if that happened after the script started, tool calls the cell made may already have run, so check their effects before retrying).",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			isolate: { type: "boolean", description: 'true with language: "js" runs the cell in a fresh sandbox' },
		},
	},
};
