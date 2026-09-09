import type { Component, TUI } from "@earendil-works/pi-tui";
import { initTheme, type Theme, theme } from "../interactive/theme/theme.ts";

export interface LiveComponentRenderer {
	rerender(): void;
	dispose(): void;
}

export function createLiveComponentRenderer(options: {
	factory: (...args: [TUI, Theme, ...unknown[]]) => Component & { dispose?(): void };
	/** Additional arguments are used by footer factories; widgets retain the 2-arg path. */
	factoryArgs?: readonly unknown[];
	getWidth: () => number;
	emit: (lines: string[]) => void;
	onRenderFault?: (error: unknown) => void;
}): LiveComponentRenderer | undefined {
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// RPC hosts do not necessarily pass through the interactive theme setup.
		try {
			void theme.name;
		} catch {
			initTheme("dark");
		}
		let component: Component & { dispose?(): void };
		let lastLines: string[] | undefined;
		const render = () => {
			if (disposed) return;
			try {
				const lines = component.render(options.getWidth());
				if (
					lastLines &&
					lines.length === lastLines.length &&
					lines.every((line: string, i: number) => line === lastLines![i])
				)
					return;
				lastLines = [...lines];
				options.emit(lines);
			} catch (error) {
				// Allow a recovered render to be emitted even when it matches the last
				// successful frame; the fault means the client may have lost that frame.
				lastLines = undefined;
				options.onRenderFault?.(error);
			}
		};
		const requestRender = () => {
			if (disposed || timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				render();
			}, 0);
		};
		const tui = new Proxy({ requestRender } as Record<string, unknown>, {
			get(target, property: string | symbol) {
				if (property in target) return target[property as string];
				throw new Error(`RPC live component TUI member is unsupported: ${String(property)}`);
			},
		}) as unknown as TUI;
		component = options.factory(tui, theme, ...(options.factoryArgs ?? []));
		render();
		return {
			rerender: render,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				if (timer !== undefined) clearTimeout(timer);
				timer = undefined;
				component.dispose?.();
			},
		};
	} catch (error) {
		disposed = true;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		options.onRenderFault?.(error);
		return undefined;
	}
}
