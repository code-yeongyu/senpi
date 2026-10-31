import type { ResourceDiagnostic } from "./diagnostics.ts";

export interface SecurityNotice {
	readonly category: "skill-link-blocked" | "mcp-env-withheld";
	readonly message: string;
	readonly path?: string;
}
export interface SecurityNoticeState {
	readonly generation: number;
	readonly notices: readonly SecurityNotice[];
}
export function isSecurityNoticeState(value: unknown): value is SecurityNoticeState {
	if (
		typeof value !== "object" ||
		value === null ||
		!("generation" in value) ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0 ||
		!("notices" in value) ||
		!Array.isArray(value.notices)
	)
		return false;
	return value.notices.every(
		(notice: unknown) =>
			typeof notice === "object" &&
			notice !== null &&
			"category" in notice &&
			(notice.category === "skill-link-blocked" || notice.category === "mcp-env-withheld") &&
			"message" in notice &&
			typeof notice.message === "string" &&
			(!("path" in notice) || notice.path === undefined || typeof notice.path === "string"),
	);
}
/** Session state, with an independent replay cursor owned by each subscription. */
export class SecurityNoticeSnapshot {
	readonly #notices = new Map<string, SecurityNotice>();
	readonly #listeners = new Set<(snapshot: SecurityNoticeState) => void>();
	#generation = 0;
	get snapshot(): SecurityNoticeState {
		return { generation: this.#generation, notices: [...this.#notices.values()] };
	}
	setResources(diagnostics: readonly ResourceDiagnostic[]): void {
		const before = JSON.stringify([...this.#notices]);
		for (const key of this.#notices.keys()) if (key.startsWith("resource:")) this.#notices.delete(key);
		for (const diagnostic of diagnostics) {
			if (diagnostic.category !== "skill-link-blocked") continue;
			this.#notices.set(`resource:${diagnostic.path ?? diagnostic.message}`, {
				category: "skill-link-blocked",
				message: diagnostic.message,
				path: diagnostic.path,
			});
		}
		if (before !== JSON.stringify([...this.#notices])) this.#publish();
	}
	add(notice: SecurityNotice): void {
		const key = `runtime:${notice.category}:${notice.path ?? notice.message}`;
		if (JSON.stringify(this.#notices.get(key)) === JSON.stringify(notice)) return;
		this.#notices.set(key, notice);
		this.#publish();
	}
	accept(value: unknown): void {
		if (
			typeof value !== "object" ||
			value === null ||
			!("message" in value) ||
			typeof value.message !== "string" ||
			!("category" in value) ||
			(value.category !== "skill-link-blocked" && value.category !== "mcp-env-withheld")
		)
			return;
		if ("remove" in value && value.remove === true && "path" in value && typeof value.path === "string") {
			if (this.#notices.delete(`runtime:${value.category}:${value.path}`)) this.#publish();
			return;
		}
		this.add({
			category: value.category,
			message: value.message,
			...("path" in value && typeof value.path === "string" ? { path: value.path } : {}),
		});
	}
	subscribe(listener: (snapshot: SecurityNoticeState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.snapshot);
		return () => this.#listeners.delete(listener);
	}
	dispose(): void {
		this.#listeners.clear();
	}
	#publish(): void {
		this.#generation++;
		const snapshot = this.snapshot;
		for (const listener of this.#listeners) listener(snapshot);
	}
}
