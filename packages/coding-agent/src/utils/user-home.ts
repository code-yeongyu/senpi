import { homedir } from "node:os";

export function userHomeDir(): string {
	return homedir();
}
