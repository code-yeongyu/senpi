/** Harness state and observation tools, not general code or filesystem access. */
export const INTERNAL_PERMISSION_TOOLS: ReadonlySet<string> = new Set([
	"todo",
	"tool_search",
	"ask_user",
	"request_user_input",
	"ask_user_question",
	"memory",
	"monitor",
	"create_goal",
	"update_goal",
	"get_goal",
	"bash_output",
	"bash_resize",
	"kill_bash",
]);
