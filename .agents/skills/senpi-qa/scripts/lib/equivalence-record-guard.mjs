// A fused-equivalence golden is committed to a public repository, so a record run must never capture anything private
// to the recording host. The CLI under test loads project rules by walking up from its cwd (AGENTS.md, CLAUDE.md, ...),
// and the case cwd lives under the sandbox temp dir: a temp dir below a home directory with its own AGENTS.md put that
// file into a recorded system prompt (senpi#7536 review). The recorder refuses such a host before any case runs, and
// refuses to write a golden that carries a project-rules block or a real home path.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";

/** Files the CLI's context and rules discovery reads from a directory above the cwd. */
const RULE_FILES = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CONTEXT.md", ".github/copilot-instructions.md"];
const RULE_DIRS = [".pi/rules", ".omo/rules", ".claude/rules", ".cursor/rules", ".github/instructions"];

/** Text that never belongs in a golden: the rules block marker, a rules file name, a real home path. */
const LEAK_MARKERS = ["<project_rules>", "AGENTS.md", "CLAUDE.md", "/Users/", "/home/", "C:\\Users\\"];

/** Every leak marker the serialized golden contains, with its count; empty means the golden may be written. */
export function goldenLeaks(serialized) {
	const text = serialized.replaceAll("\\\\", "\\");
	return LEAK_MARKERS.map((marker) => ({ marker, count: text.split(marker).length - 1 })).filter(
		(leak) => leak.count > 0,
	);
}

function inside(child, parent) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Why this host cannot record: the sandbox temp dir is inside the home dir or below a project-rules file. */
export function recordHostProblems({ temp, home }) {
	const real = realpathSync(temp);
	const problems = [];
	if (existsSync(home) && inside(real, realpathSync(home)))
		problems.push(`the sandbox temp dir ${temp} is inside the home dir ${home}; set TMPDIR outside it`);
	for (let dir = dirname(real); ; dir = dirname(dir)) {
		for (const name of [...RULE_FILES, ...RULE_DIRS]) {
			const path = join(dir, name);
			if (existsSync(path))
				problems.push(`${path} is above the sandbox temp dir ${temp}; a recorded prompt would carry it`);
		}
		if (dirname(dir) === dir) break;
	}
	return problems;
}
