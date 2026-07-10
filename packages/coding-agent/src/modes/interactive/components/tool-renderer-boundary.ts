import type { Component } from "@earendil-works/pi-tui";

export function isComponent(value: unknown): value is Component {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof Reflect.get(value, "render") === "function" &&
		typeof Reflect.get(value, "invalidate") === "function"
	);
}

export class ToolRendererBoundary implements Component {
	private component: Component;
	private componentDisposed = false;
	private fallback?: Component;
	private failed = false;
	private onFailure: () => void;

	constructor(component: Component, fallback: Component | undefined, onFailure: () => void) {
		this.component = component;
		this.fallback = fallback;
		this.onFailure = onFailure;
	}

	render(width: number): string[] {
		if (!this.failed) {
			try {
				const lines = this.component.render(width);
				if (Array.isArray(lines)) {
					const safeLines: string[] = [];
					for (const line of lines) {
						if (typeof line !== "string") {
							throw new TypeError("Tool renderer returned a non-string line");
						}
						safeLines.push(line);
					}
					return safeLines;
				}
			} catch {
				this.fail();
				return this.renderFallback(width);
			}
			this.fail();
		}
		return this.renderFallback(width);
	}

	invalidate(): void {
		if (!this.failed) {
			try {
				this.component.invalidate();
			} catch {
				this.fail();
			}
		}
		this.fallback?.invalidate();
	}

	dispose(): void {
		this.disposeComponent();
		this.fallback?.dispose?.();
	}

	private fail(): void {
		if (this.failed) return;
		this.failed = true;
		this.onFailure();
		this.disposeComponent();
	}

	private disposeComponent(): void {
		if (this.componentDisposed) return;
		this.componentDisposed = true;
		try {
			this.component.dispose?.();
		} catch {
			return;
		}
	}

	private renderFallback(width: number): string[] {
		return this.fallback?.render(width) ?? [];
	}
}
