export type DrainPart = { readonly text: string } | { readonly key: string };

export interface DrainScan {
	readonly parts: DrainPart[];
	readonly carry: string;
}

export function scanDrainText(carry: string, chunk: string, marker: string): DrainScan;
