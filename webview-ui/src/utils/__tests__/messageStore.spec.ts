// Unit tests for MessageStore (issue #1675, Steps 1+3) — pure logic, no React.

import { describe, expect, test } from "vitest"

import type { ClineMessage } from "@roo-code/types"

import { MessageStore } from "../messageStore"

function makeMessage(ts: number, text: string, partial = false): ClineMessage {
	return { ts, type: "say", say: "text", text, partial } as ClineMessage
}

/** A message with a given body size in KB. */
function fat(ts: number, kb: number): ClineMessage {
	return makeMessage(ts, "m".repeat(kb * 1024))
}

describe("MessageStore", () => {
	test("replaceAll stores the incoming array as the snapshot without copying", () => {
		const store = new MessageStore()
		const messages = [makeMessage(1, "a"), makeMessage(2, "b")]

		store.replaceAll(messages)

		expect(store.size).toBe(2)
		// Snapshot identity: same array reference until a mutation occurs.
		expect(store.getMessages()).toBe(messages)
	})

	test("append preserves insertion order and reports size", () => {
		const store = new MessageStore()

		store.append(makeMessage(10, "first"))
		store.append(makeMessage(11, "second"))
		store.append(makeMessage(12, "third"))

		const view = store.getMessages()
		expect(view.map((m) => m.text)).toEqual(["first", "second", "third"])
		expect(store.size).toBe(3)
	})

	test("updateLastForTs replaces the last occurrence when duplicate ts values exist", () => {
		const store = new MessageStore()
		const original = makeMessage(5, "original")
		const duplicate = makeMessage(5, "duplicate")

		store.append(original)
		store.append(makeMessage(6, "other"))
		store.append(duplicate)

		const replacement = makeMessage(5, "updated")
		const replaced = store.updateLastForTs(replacement)

		// Only the LAST occurrence is updated — findLastIndex parity with the
		// previous ExtensionStateContext implementation.
		expect(replaced).toBe(duplicate)
		const view = store.getMessages()
		expect(view.map((m) => m.text)).toEqual(["original", "other", "updated"])
	})

	test("updateLastForTs returns undefined and mutates nothing for an unknown ts", () => {
		const store = new MessageStore()
		store.append(makeMessage(1, "a"))

		expect(store.updateLastForTs(makeMessage(999, "unknown"))).toBeUndefined()
		expect(store.getMessages().map((m) => m.text)).toEqual(["a"])
	})

	test("snapshot identity is stable across reads until a mutation", () => {
		const store = new MessageStore()
		store.append(makeMessage(1, "a"))

		const first = store.getMessages()
		const second = store.getMessages()
		expect(first).toBe(second)

		store.append(makeMessage(2, "b"))
		const third = store.getMessages()
		expect(third).not.toBe(first)
		expect(third.map((m) => m.text)).toEqual(["a", "b"])
	})

	test("updateLastForTs with the identical message object keeps the snapshot identity", () => {
		const store = new MessageStore()
		const message = makeMessage(1, "a")
		store.append(message)
		const first = store.getMessages()

		// Re-asserting the same object is a no-op: no new snapshot.
		store.updateLastForTs(message)
		expect(store.getMessages()).toBe(first)
	})

	test("replaceAll resets ts indices from any earlier contents", () => {
		const store = new MessageStore()
		store.append(makeMessage(1, "stale"))
		store.updateLastForTs(makeMessage(1, "stale-updated"))

		const fresh = [makeMessage(2, "x"), makeMessage(1, "y")]
		store.replaceAll(fresh)

		// The ts=1 update must hit the NEW message, not the stale one.
		store.updateLastForTs(makeMessage(1, "y-updated"))
		expect(store.getMessages().map((m) => m.text)).toEqual(["x", "y-updated"])
	})

	test("append after replaceAll indexes into the new window", () => {
		const store = new MessageStore()
		store.replaceAll([makeMessage(7, "base")])
		store.append(makeMessage(8, "tail"))

		store.updateLastForTs(makeMessage(8, "tail-updated"))
		expect(store.getMessages().map((m) => m.text)).toEqual(["base", "tail-updated"])
	})

	test("large-workload sanity: appending and partial-updating N messages stays consistent", () => {
		const store = new MessageStore()
		const n = 10_000
		for (let i = 0; i < n; i++) {
			store.append(makeMessage(i, `m${i}`))
		}
		// Update the last message repeatedly, streaming-style.
		for (let round = 0; round < 50; round++) {
			store.updateLastForTs(makeMessage(n - 1, `m${n - 1}-${round}`))
		}

		const view = store.getMessages()
		expect(view.length).toBe(n)
		expect(view[n - 1].text).toBe(`m${n - 1}-49`)
		expect(view[0].text).toBe("m0")
	})
})

describe("MessageStore windowing (issue #1675 Step 3)", () => {
	test("retained bytes stay under the budget by evicting oldest messages", () => {
		const store = new MessageStore({ byteBudget: 6 * 1024 })
		for (let i = 1; i <= 4; i++) {
			store.append(fat(i, 8))
		}

		// The budget fits ~6KB; each message is ~8KB, so only the newest can
		// remain. Older messages become shells.
		expect(store.evictedCount).toBe(3)
		expect(store.size).toBe(1)
		const view = store.getMessages()
		expect(view.length).toBe(1)
		expect(view[0].ts).toBe(4)
	})

	test("totalCount stays authoritative across evictions", () => {
		const store = new MessageStore({ byteBudget: 6 * 1024 })
		for (let i = 1; i <= 4; i++) {
			store.append(fat(i, 8))
		}

		// Ground truth for delta continuity: retained + shells.
		expect(store.totalCount).toBe(4)
		expect(store.evictedCount).toBe(3)
		expect(store.size).toBe(1)
	})

	test("never evicts below one message", () => {
		const store = new MessageStore({ byteBudget: 1 })
		store.append(fat(1, 8))
		store.append(fat(2, 8))

		// Clamped: the newest message always stays retained.
		expect(store.size).toBe(1)
		expect(store.evictedCount).toBe(1)
		expect(store.getMessages()[0].ts).toBe(2)
	})

	test("evicted messages keep a shell with ts for UI scans", () => {
		const store = new MessageStore({ byteBudget: 6 * 1024 })
		for (let i = 1; i <= 3; i++) {
			store.append(fat(i, 8))
		}

		// A shell only exists for evicted messages; partial updates to a
		// shell-only ts are treated as unknown (not silently applied).
		expect(store.updateLastForTs(makeMessage(1, "updated"))).toBeUndefined()
	})

	test("prependMessages restores the newest evicted messages", () => {
		const store = new MessageStore({ byteBudget: 10 * 1024 })
		for (let i = 1; i <= 10; i++) {
			store.append(fat(i, 8))
		}
		// Previous eviction state: some messages evicted.
		const evictedBefore = store.evictedCount
		expect(evictedBefore).toBeGreaterThan(0)

		// Load the newest 2 evicted messages back (page from disk).
		const loaded = (store as unknown as { shells: Array<{ ts: number }> }).shells
			.slice(-2)
			.map((s) => makeMessage(s.ts, "restored"))
		const ok = store.prependMessages(loaded, 2)

		expect(ok).toBe(true)
		expect(store.evictedCount).toBe(evictedBefore - 2)

		const view = store.getMessages()
		// No duplicated ts anywhere in the merged window.
		const tsList = view.map((m) => m.ts)
		expect(new Set(tsList).size).toBe(tsList.length)
	})

	test("prependMessages rejects a page whose length mismatches the count", () => {
		const store = new MessageStore({ byteBudget: 6 * 1024 })
		store.append(fat(1, 8))
		store.append(fat(2, 8))
		store.append(fat(3, 8))

		const page = [makeMessage(2, "restored")]
		// Page says 2 but carries 1: must be rejected wholesale.
		expect(store.prependMessages(page, 2)).toBe(false)
		expect(store.prependMessages(page, -1)).toBe(false)
	})

	test("replaceAll clears shells and enforces the budget from scratch", () => {
		const store = new MessageStore({ byteBudget: 6 * 1024 })
		store.append(fat(1, 8))
		store.append(fat(2, 8))

		// A full-state snapshot is authoritative: shells reset.
		store.replaceAll([makeMessage(10, "a"), makeMessage(11, "b")])
		expect(store.evictedCount).toBe(0)
		expect(store.totalCount).toBe(2)
		expect(store.size).toBe(2)
	})
})
