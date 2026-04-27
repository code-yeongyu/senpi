export const HIGH_CONFIDENCE_PATTERNS: string[] = [];
export const MEDIUM_CONFIDENCE_PATTERNS: string[] = [];
export const LOW_CONFIDENCE_PATTERNS: string[] = [];

export function isContextOverflowError(_error: unknown): { detected: boolean; confidence: "high" | "medium" | "low" } {
	return { detected: false, confidence: "low" };
}

export function isUsageSilentOverflow(): boolean {
	return false;
}
