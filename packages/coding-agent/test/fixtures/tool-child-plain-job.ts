// Ordinary job code with a named import and no knowledge of the barrier (senpi#3566 todo 4).
import { spawnSync } from "node:child_process";

export function runPlainSpawn(): number | null {
	return spawnSync("sh", ["-c", "exit 5"]).status;
}
