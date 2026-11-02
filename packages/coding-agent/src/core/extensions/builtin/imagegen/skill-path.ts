import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The module-relative payload location shared by skill discovery and read permissions. */
export function imagegenSkillPath(baseDir = dirname(fileURLToPath(import.meta.url))): string {
	return join(baseDir, "skill", "SKILL.md");
}
