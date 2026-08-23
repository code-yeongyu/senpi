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
	const sideBaseLabels = catalog.sides.map((side) => `BTW #${side.metadata.ordinal} — ${side.metadata.summary}`);
	const sideLabelCounts = new Map<string, number>();
	for (const label of sideBaseLabels) {
		sideLabelCounts.set(label, (sideLabelCounts.get(label) ?? 0) + 1);
	}
	if (catalog.main) {
		options.push({
			label: `Main — ${catalog.main.name?.trim() || "Main session"}`,
			choice: {
				type: "session",
				sessionPath: catalog.main.path,
			},
		});
	}
	for (const [index, side] of catalog.sides.entries()) {
		const baseLabel = sideBaseLabels[index]!;
		const identity = (sideLabelCounts.get(baseLabel) ?? 0) > 1 ? ` · ${side.id}` : "";
		const current = side.path === currentSessionPath ? " (current)" : "";
		options.push({
			label: `${baseLabel}${identity}${current}`,
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
