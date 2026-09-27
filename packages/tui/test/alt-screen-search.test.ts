import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AltScreenSearchComponent,
	findAltScreenSearchMatches,
	getIndexedAltScreenSearchMatchKey,
	IndexedAltScreenSearchIndex,
} from "../src/alt-screen-search.ts";
import type { ScrollEntry, ScrollEntryFrame, ScrollEntrySource } from "../src/layout-node.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function fixture(content: string[][]) {
	let reads = 0;
	const entries: ScrollEntry[] = content.map((lines, sourceIndex) => ({
		key: {},
		sourceIndex,
		revision: 0,
		component: { render: () => lines, invalidate() {} },
	}));
	const source: ScrollEntrySource & { version: number; displayRevision: number } = {
		version: 0,
		displayRevision: 0,
		get length() {
			return entries.length;
		},
		get(index) {
			reads++;
			return entries[index]!;
		},
		indexOf(key) {
			const index = entries.findIndex((entry) => entry.key === key);
			return index < 0 ? undefined : index;
		},
		resolve(key) {
			return this.indexOf(key);
		},
	};
	const view = {
		entrySource: source,
		renderEntry(index: number, _width: number) {
			const entry = source.get(index);
			return { entry, index, lines: content[index]! };
		},
	};
	return {
		entries,
		source,
		view,
		get reads() {
			return reads;
		},
	};
}

describe("cooperative entry transcript search", () => {
	it("preserves legacy Unicode, ANSI, whitespace, grapheme and cross-entry matching", async () => {
		const content = [
			["\x1b[31mfoo  bar\x1b[0m"],
			[],
			["A界🙂éZ", "QUICK"],
			["brown\tfox", "K ſ aaa aaa"],
			["a"],
			["a"],
			["a"],
			["a"],
		];
		const data = fixture(content);
		const offsets = content.map((_lines, index) => content.slice(0, index).flat().length);
		const index = new IndexedAltScreenSearchIndex();
		for (const query of ["oo   bar\nA界🙂é", "quick brown", "K S", "🙂", "e", "aaa", "a a", "", "missing"]) {
			index.search(data.view, 80, query, () => {});
			await index.whenIdle();
			const result = index.search(data.view, 80, query, () => {});
			assert.equal(result.pending, false);
			assert.deepEqual(
				result.matches.map((match) => ({
					segments: match.segments.map(({ anchor, startCol, endCol }) => ({
						row: offsets[anchor.sourceIndex]! + anchor.row,
						startCol,
						endCol,
					})),
				})),
				findAltScreenSearchMatches(content.flat(), query),
				query,
			);
		}
	});

	it("does no entry work synchronously or on unchanged frames and indexes only visible highlights", async () => {
		const data = fixture(Array.from({ length: 160 }, (_, index) => [`needle ${index}`]));
		const index = new IndexedAltScreenSearchIndex();
		const initial = index.search(data.view, 80, "needle", () => {});
		assert.equal(initial.pending, true);
		assert.equal(data.reads, 0);
		assert.equal(index.search(data.view, 80, "needle", () => {}).changed, false);
		await index.whenIdle();
		const complete = index.search(data.view, 80, "needle", () => {});
		assert.equal(complete.changed, true);
		assert.equal(complete.matches.length, 160);
		const reads = data.reads;
		for (let frame = 0; frame < 100; frame++) {
			assert.equal(index.search(data.view, 80, "needle", () => {}).changed, false);
		}
		const entry = data.entries[123]!;
		const frame: ScrollEntryFrame = {
			source: data.source,
			width: 80,
			height: 2,
			version: 0,
			displayRevision: 0,
			pending: false,
			entries: [{ entry, index: 123, lines: ["needle 123"], top: 0 }],
			rows: [{ anchor: { key: entry.key, sourceIndex: 123, row: 0 }, line: "needle 123", revision: 0 }, undefined],
		};
		const visible = index.getVisibleMatches(frame);
		assert.equal(visible.length, 1);
		assert.equal(visible[0]?.matchIndex, 123);
		assert.equal(visible[0]?.row, 0);
		assert.equal(data.reads, reads);
		assert.deepEqual(index.getVisibleMatches({ ...frame, width: 40 }), []);
		assert.deepEqual(index.getVisibleMatches({ ...frame, displayRevision: 1 }), []);
		assert.deepEqual(index.getVisibleMatches({ ...frame, rows: [{ ...frame.rows[0]!, line: "xxxxxx 123" }] }), []);
	});

	it("finishes through repeated tail changes and reuses the completed prefix with cross-entry rollback", async () => {
		const content = Array.from({ length: 160 }, () => ["prefix needle"]);
		content.push(["a"], ["b"]);
		const data = fixture(content);
		let changedAt = content.length - 1;
		data.source.changedSince = () => changedAt;
		const index = new IndexedAltScreenSearchIndex();
		let updates = 0;
		const onUpdate = () => {
			if (updates++ < 6) {
				data.source.version++;
				index.search(data.view, 80, "needle", onUpdate);
			}
		};
		index.search(data.view, 80, "needle", onUpdate);
		await index.whenIdle();
		assert.equal(index.search(data.view, 80, "needle", onUpdate).pending, false);
		assert.equal(data.reads, content.length);
		assert.equal(updates > 6, true);
		index.search(data.view, 80, "a b", () => {});
		await index.whenIdle();
		assert.equal(index.search(data.view, 80, "a b", () => {}).matches.length, 1);
		const reads = data.reads;
		content[changedAt] = ["changed"];
		data.source.version++;
		const restarting = index.search(data.view, 80, "a b", () => {});
		assert.equal(restarting.pending, true);
		assert.equal(data.reads, reads);
		await index.whenIdle();
		assert.equal(index.search(data.view, 80, "a b", () => {}).matches.length, 0);
		assert.equal(data.reads, reads + 1);
		content[changedAt] = ["b"];
		data.source.version++;
		index.search(data.view, 80, "a b", () => {});
		await index.whenIdle();
		assert.equal(index.search(data.view, 80, "a b", () => {}).matches.length, 1);
		assert.equal(data.reads, reads + 2);
		changedAt = 0;
		content[0] = ["a b"];
		data.source.version++;
		index.search(data.view, 80, "a b", () => {});
		await index.whenIdle();
		assert.equal(index.search(data.view, 80, "a b", () => {}).matches.length, 2);
		assert.equal(data.reads, reads + 2 + content.length);
	});

	it("resumes a paused scan after a tail change before the next frame", async () => {
		const data = fixture(Array.from({ length: 100 }, () => ["needle"]));
		data.source.changedSince = () => 99;
		const index = new IndexedAltScreenSearchIndex();
		index.search(data.view, 80, "needle", () => {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const reads = data.reads;
		data.source.version++;
		await index.whenIdle();
		assert.equal(data.reads, reads);
		index.search(data.view, 80, "needle", () => {});
		await index.whenIdle();
		assert.equal(index.search(data.view, 80, "needle", () => {}).matches.length, 100);
		assert.equal(data.reads, 101);
	});

	it("keeps only query overlap across row batches without introducing overlapping matches", async () => {
		const content = Array.from({ length: 100 }, (_, row) => [row % 3 === 0 ? "🙂 a" : "a"]);
		const data = fixture(content);
		const index = new IndexedAltScreenSearchIndex();
		for (const query of ["a a", "a a a", "a 🙂 a a a 🙂", content.slice(0, 40).flat().join(" ")]) {
			index.search(data.view, 80, query, () => {});
			await index.whenIdle();
			const matches = index.search(data.view, 80, query, () => {}).matches;
			assert.deepEqual(
				matches.map((match) => ({
					segments: match.segments.map(({ anchor, startCol, endCol }) => ({
						row: anchor.sourceIndex,
						startCol,
						endCol,
					})),
				})),
				findAltScreenSearchMatches(content.flat(), query),
			);
		}
	});

	it("yields within multirow entries and while traversing empty entries", async () => {
		const index = new IndexedAltScreenSearchIndex();
		const large = fixture([Array.from({ length: 300 }, () => "needle")]);
		let count = 0;
		index.search(large.view, 80, "needle", () => {
			count = index.search(large.view, 80, "needle", () => {}).matches.length;
			index.cancel();
		});
		await index.whenIdle();
		assert.ok(count > 0 && count < 300);
		assert.equal(large.reads, 1);
		const empty = fixture(Array.from({ length: 300 }, () => []));
		index.search(empty.view, 80, "needle", () => {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(empty.reads > 0 && empty.reads < 300);
		index.cancel();
		await index.whenIdle();
	});

	it("settles renderer errors safely and discards a render that invalidates its source", async () => {
		const data = fixture([["needle"]]);
		const index = new IndexedAltScreenSearchIndex();
		let updates = 0;
		const throwing = {
			...data.view,
			renderEntry() {
				throw new Error("private renderer details");
			},
		};
		index.search(throwing, 80, "needle", () => {
			updates++;
		});
		await index.whenIdle();
		const failed = index.search(throwing, 80, "needle", () => {});
		assert.equal(failed.pending, false);
		assert.equal(failed.changed, true);
		assert.equal(failed.error, "Search unavailable");
		assert.deepEqual(failed.matches, []);
		assert.equal(updates, 1);
		const invalidating = {
			...data.view,
			renderEntry() {
				data.source.version++;
				throw new Error("obsolete");
			},
		};
		index.search(invalidating, 80, "needle", () => {
			updates++;
		});
		await index.whenIdle();
		assert.equal(updates, 1);
		const absent = { ...data.view, entrySource: undefined };
		assert.equal(index.search(absent, 80, "needle", () => {}).pending, false);
		assert.equal(index.search(absent, 80, "needle", () => {}).changed, false);
	});

	it("shows pending search without changing the legacy settled count", () => {
		const component = new AltScreenSearchComponent(() => {});
		component.handleInput("needle");
		component.setResult(-1, 0, true);
		assert.match(stripTerminalSequences(component.render(60).join("\n")), /Searching…/u);
		component.setResult(0, 2);
		assert.match(stripTerminalSequences(component.render(60).join("\n")), /1\/2/u);
	});

	it("restarts the whole search after recovering a failed last entry", async () => {
		const data = fixture([["needle first"], ["needle second"], ["needle last"]]);
		data.source.changedSince = () => 2;
		let fail = true;
		const view = {
			...data.view,
			renderEntry(index: number, width: number) {
				if (fail && index === 2) throw new Error("last entry failed");
				return data.view.renderEntry(index, width);
			},
		};
		const index = new IndexedAltScreenSearchIndex();
		index.search(view, 80, "needle", () => {});
		await index.whenIdle();
		assert.equal(index.search(view, 80, "needle", () => {}).error, "Search unavailable");
		fail = false;
		data.source.version++;
		index.search(view, 80, "needle", () => {});
		await index.whenIdle();
		const recovered = index.search(view, 80, "needle", () => {});
		assert.equal(recovered.error, undefined);
		assert.equal(recovered.matches.length, 3);
		assert.equal(data.reads, 5);
	});

	it("yields between batches and cancels without stale callbacks or further entry reads", async () => {
		const data = fixture(Array.from({ length: 300 }, () => ["needle"]));
		const index = new IndexedAltScreenSearchIndex();
		let callbacks = 0;
		index.search(data.view, 80, "needle", () => {
			callbacks++;
			index.cancel();
		});
		await index.whenIdle();
		assert.equal(callbacks, 1);
		assert.ok(data.reads > 0 && data.reads < 300);
		const reads = data.reads;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(data.reads, reads);
		assert.equal(callbacks, 1);
	});

	it("restarts for query, source, width, version and display revisions and rejects obsolete work", async () => {
		const data = fixture([["old"], ["new"]]);
		const replacement = fixture([["replacement"]]);
		const index = new IndexedAltScreenSearchIndex();
		let obsoleteUpdates = 0;
		index.search(data.view, 80, "old", () => {
			obsoleteUpdates++;
		});
		const oldIdle = index.whenIdle();
		index.search(data.view, 80, "new", () => {});
		await oldIdle;
		await index.whenIdle();
		assert.equal(obsoleteUpdates, 0);
		assert.equal(
			index.search(data.view, 80, "new", () => {}).matches[0]?.segments[0]?.anchor.key,
			data.entries[1]?.key,
		);
		for (const change of [
			() => {
				data.source.version++;
			},
			() => {
				data.source.displayRevision++;
			},
		]) {
			change();
			assert.equal(index.search(data.view, 80, "new", () => {}).pending, true);
			await index.whenIdle();
		}
		assert.equal(index.search(data.view, 40, "new", () => {}).pending, true);
		await index.whenIdle();
		index.search(replacement.view, 40, "replacement", () => {});
		await index.whenIdle();
		const match = index.search(replacement.view, 40, "replacement", () => {}).matches[0]!;
		assert.equal(match.segments[0]?.anchor.key, replacement.entries[0]?.key);
		assert.notEqual(
			getIndexedAltScreenSearchMatchKey(match),
			getIndexedAltScreenSearchMatchKey({
				segments: match.segments.map((segment) => ({ ...segment, anchor: { ...segment.anchor, key: {} } })),
			}),
		);
		index.search(data.view, 80, "old", () => {
			obsoleteUpdates++;
		});
		data.source.version++;
		await index.whenIdle();
		assert.equal(obsoleteUpdates, 0);
	});
});
