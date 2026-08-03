import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container, ScrollView, Text } from "../src/index.ts";

class StableInvalidatingComponent implements Component {
	private readonly lines = ["stable"];
	private revision = 0;
	private onInvalidated: (() => void) | undefined;

	render(): string[] {
		return this.lines;
	}

	getRenderRevision(): number {
		return this.revision;
	}

	getRenderChangeStart(): number {
		return 0;
	}

	setRenderInvalidationCallback(callback: (() => void) | undefined): void {
		this.onInvalidated = callback;
	}

	isRenderCacheTrackable(): boolean {
		return true;
	}

	invalidate(): void {
		this.revision++;
		this.onInvalidated?.();
	}

	notifyUnchanged(): void {
		this.onInvalidated?.();
	}
}

describe("Container render cache", () => {
	it("reuses the flattened transcript while its children are unchanged", () => {
		const container = new Container();
		container.addChild(new Text("first", 0, 0));
		container.addChild(new Text("second", 0, 0));

		const firstRender = container.render(20);
		const secondRender = container.render(20);

		assert.strictEqual(secondRender, firstRender);
		assert.deepEqual(secondRender, ["first               ", "second              "]);
	});

	it("updates only the changed tail and propagates that change through nested containers", () => {
		const transcript = new Container();
		const historical = new Text("history", 0, 0);
		const streamingTail = new Text("tail-1", 0, 0);
		transcript.addChild(historical);
		transcript.addChild(streamingTail);

		const document = new Container();
		document.addChild(new Text("header", 0, 0));
		document.addChild(transcript);

		const firstRender = document.render(20);
		const firstRevision = document.getRenderRevision();
		streamingTail.setText("tail-2");
		const secondRender = document.render(20);

		assert.notStrictEqual(secondRender, firstRender);
		assert.strictEqual(document.render(20), secondRender);
		assert.equal(document.getRenderRevision(), firstRevision + 1);
		assert.equal(document.getRenderChangeStart(), 2);
		assert.deepEqual(secondRender, ["header              ", "history             ", "tail-2              "]);
	});

	it("handles appended and removed children without rebuilding the stable prefix", () => {
		const container = new Container();
		container.addChild(new Text("one", 0, 0));
		const firstRender = container.render(10);

		const appended = new Text("two", 0, 0);
		container.addChild(appended);
		const appendedRender = container.render(10);
		assert.notStrictEqual(appendedRender, firstRender);
		assert.strictEqual(container.render(10), appendedRender);
		assert.equal(container.getRenderChangeStart(), 1);
		assert.deepEqual(appendedRender, ["one       ", "two       "]);

		container.detachChild(appended);
		const removedRender = container.render(10);
		assert.notStrictEqual(removedRender, firstRender);
		assert.strictEqual(container.render(10), removedRender);
		assert.equal(container.getRenderChangeStart(), 1);
		assert.deepEqual(removedRender, ["one       "]);
	});

	it("keeps repeated child references subscribed until their last occurrence is removed", () => {
		const container = new Container();
		const repeated = new Text("one", 0, 0);
		container.addChild(repeated);
		container.addChild(repeated);
		container.render(10);

		container.detachChild(repeated);
		const once = container.render(10);
		repeated.setText("two");
		const updated = container.render(10);

		assert.notStrictEqual(updated, once);
		assert.deepEqual(updated, ["two       "]);
	});

	it("fans shared-child invalidation out to every containing parent", () => {
		const firstParent = new Container();
		const secondParent = new Container();
		const child = new Text("one", 0, 0);
		firstParent.addChild(child);
		firstParent.render(10);
		secondParent.addChild(child);
		secondParent.render(10);

		child.setText("two");
		assert.deepEqual(firstParent.render(10), ["two       "]);
		assert.deepEqual(secondParent.render(10), ["two       "]);

		firstParent.detachChild(child);
		const detachedRender = firstParent.render(10);
		const detachedRevision = firstParent.getRenderRevision();
		child.setText("three");
		assert.equal(firstParent.getRenderRevision(), detachedRevision);
		assert.strictEqual(firstParent.render(10), detachedRender);
		assert.deepEqual(secondParent.render(10), ["three     "]);
	});

	it("closes a clean invalidation window at the end of the cached output", () => {
		const container = new Container();
		const child = new StableInvalidatingComponent();
		container.addChild(child);
		const firstRender = container.render(10);

		child.notifyUnchanged();
		const cleanRender = container.render(10);

		assert.strictEqual(cleanRender, firstRender);
		assert.equal(container.getRenderChangeStart(), cleanRender.length);
	});

	it("starts a new cache when the render width changes", () => {
		const container = new Container();
		container.addChild(new Text("content", 0, 0));
		const narrow = container.render(10);
		const wide = container.render(20);

		assert.notStrictEqual(wide, narrow);
		assert.equal(container.getRenderChangeStart(), 0);
		assert.deepEqual(wide, ["content             "]);
	});

	it("reuses the fullscreen scrollbar projection and updates only its changed tail", () => {
		const transcript = new Container();
		transcript.addChild(new Text("history", 0, 0));
		const streamingTail = new Text("tail-1", 0, 0);
		transcript.addChild(streamingTail);
		const scrollView = new ScrollView(transcript, { scrollbar: "always" });

		const firstRender = scrollView.render(20);
		assert.strictEqual(scrollView.render(20), firstRender);
		streamingTail.setText("tail-2");
		const secondRender = scrollView.render(20);

		assert.notStrictEqual(secondRender, firstRender);
		assert.strictEqual(scrollView.render(20), secondRender);
		assert.equal(scrollView.getRenderChangeStart(), 1);
		assert.deepEqual(secondRender, ["history             ", "tail-2              "]);
	});
});
