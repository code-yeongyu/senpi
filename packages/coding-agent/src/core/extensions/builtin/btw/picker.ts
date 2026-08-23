import type { BtwSessionCatalog } from "./session-catalog.ts";

export type BtwPickerChoice = { type: "session"; sessionPath: string } | { type: "new"; parentSessionPath: string };

export interface BtwPickerOption {
	label: string;
	choice: BtwPickerChoice;
}

export async function validateBtwPickerChoice(
	choice: BtwPickerChoice,
	exists: (sessionPath: string) => Promise<boolean>,
): Promise<boolean> {
	const sessionPath = choice.type === "session" ? choice.sessionPath : choice.parentSessionPath;
	try {
		return await exists(sessionPath);
	} catch {
		return false;
	}
}

export function buildBtwPickerOptions(catalog: BtwSessionCatalog, currentSessionPath: string): BtwPickerOption[] {
	const options: BtwPickerOption[] = [];
	if (catalog.main) {
		options.push({
			label: `Main — ${catalog.main.name?.trim() || "Main session"}`,
			choice: {
				type: "session",
				sessionPath: catalog.main.path,
			},
		});
	}
	for (const side of catalog.sides) {
		const current = side.path === currentSessionPath ? " (current)" : "";
		options.push({
			label: `BTW #${side.metadata.ordinal} — ${side.metadata.summary}${current}`,
			choice: {
				type: "session",
				sessionPath: side.path,
			},
		});
	}
	if (catalog.main) {
		options.push({
			label: "New BTW",
			choice: {
				type: "new",
				parentSessionPath: catalog.parentSessionPath,
			},
		});
	}
	return options;
}
