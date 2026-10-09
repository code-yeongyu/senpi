/**
 * How the moved-path guard sees each tool's targets (senpi#2898). A test enumerates every tool of a full load
 * against this table, so a new builtin must be classified before it can ship. A tool missing from it (a third-party
 * extension or MCP tool) is not allowed silently: every string in its arguments is scanned as command text.
 */
export type MovedPathToolClass =
	/** The tool checks the registered filesystem policy before its own I/O. */
	| { readonly kind: "filesystem-policy" }
	/** `apply_patch`: every target named in the patch. */
	| { readonly kind: "patch" }
	/** Shell text: path tokens in the command plus the call's working directory. */
	| { readonly kind: "command"; readonly field: string }
	/** Named input fields holding paths the tool writes or reads. */
	| { readonly kind: "paths"; readonly write: readonly string[]; readonly read: readonly string[] }
	/** Touches no path a model names. */
	| { readonly kind: "none" };

export const MOVED_PATH_TOOL_CLASSES: Readonly<Record<string, MovedPathToolClass>> = {
	read: { kind: "filesystem-policy" },
	write: { kind: "filesystem-policy" },
	edit: { kind: "filesystem-policy" },
	find: { kind: "filesystem-policy" },
	ls: { kind: "filesystem-policy" },
	grep: { kind: "filesystem-policy" },
	apply_patch: { kind: "patch" },
	bash: { kind: "command", field: "command" },
	eval: { kind: "command", field: "code" },
	bash_input: { kind: "command", field: "input" },
	monitor: { kind: "command", field: "command" },
	powershell: { kind: "command", field: "command" },
	generate_image: { kind: "paths", write: ["output_path"], read: ["reference_image_paths", "mask_image_path"] },
	read_video: { kind: "paths", write: [], read: ["path"] },
	look_at: { kind: "paths", write: [], read: ["file_path", "file_paths"] },
	bash_output: { kind: "none" },
	bash_resize: { kind: "none" },
	kill_bash: { kind: "none" },
	request_user_input: { kind: "none" },
	ask_user_question: { kind: "none" },
	todo: { kind: "none" },
	web_search: { kind: "none" },
	tool_search: { kind: "none" },
	webfetch: { kind: "none" },
	create_goal: { kind: "none" },
	update_goal: { kind: "none" },
	get_goal: { kind: "none" },
	schedule_wakeup: { kind: "none" },
	schedule_prompt: { kind: "none" },
	show_html_page: { kind: "none" },
};
