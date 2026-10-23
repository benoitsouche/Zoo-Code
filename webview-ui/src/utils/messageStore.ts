// messageStore: the webview-side message state for the delta channel
// (issue #1675 Step 2). Holds the conversation once and applies incremental
// updates without cloning the whole array per message.
//
// Public surface:
//   - `size` / `totalCount` — the authoritative count of messages known for
//     the task. Delta continuity checks compare against `totalCount` so a
//     dropped batch is detectable.
//   - `append` for the messagesAppended stream.
//   - `updateLastForTs` for messageUpdated partial updates (no full-array
//     clone; only the snapshot reference is invalidated). Returns the
//     replaced message, or undefined when no retained message has that ts.
//   - `replaceAll` for authoritative full-state snapshots (a resync or a
//     mounted task resets the stream baseline). Stores the array as-is and
//     publishes it as the snapshot without copying.
//   - `getMessages` returns a cached immutable array for React state.

import type { ClineMessage } from "@roo-code/types"

/**
 * The store's single source of truth for the current task's messages.
 * `indicesByTs` maps ts -> array indices where a message with that ts lives,
 * so partial updates resolve without a scan. Duplicate ts values are
 * preserved (replacement targets the last occurrence) — parity with the
 * findLastIndex behavior this store replaced.
 */
export class MessageStore {
	private window: ClineMessage[] = []
	/** ts -> window indices where a full message with that ts lives. */
	private readonly indicesByTs = new Map<number, number[]>()
	/** Cached immutable copy for React; invalidated by any mutation. */
	private snapshot: ClineMessage[] | undefined

	/** Number of messages currently retained. */
	get size(): number {
		return this.window.length
	}

	/**
	 * Total messages known for the task: the continuity ground truth for the
	 * delta watermark.
	 */
	get totalCount(): number {
		return this.window.length
	}

	/**
	 * Replaces the entire contents (full-state snapshot path). The array is
	 * stored as-is and published as the snapshot directly — same reference
	 * until the next mutation (React sees a stable identity).
	 */
	replaceAll(messages: ClineMessage[]): ClineMessage[] {
		this.window = messages
		this.indicesByTs.clear()
		for (let i = 0; i < messages.length; i++) {
			this.indexTs(messages[i].ts, i)
		}
		this.snapshot = messages
		return this.snapshot
	}

	/**
	 * Appends a message from the messagesAppended stream.
	 */
	append(message: ClineMessage): boolean {
		this.indexTs(message.ts, this.window.length)
		this.window.push(message)
		this.snapshot = undefined
		return true
	}

	/**
	 * Partial update (messageUpdated): replaces the LAST retained message
	 * with the given ts. Returns the replaced message, or undefined when no
	 * retained message has that ts (the caller decides whether to warn/drop).
	 * Re-asserting the identical object keeps the snapshot identity (no-op).
	 */
	updateLastForTs(message: ClineMessage): ClineMessage | undefined {
		const indices = this.indicesByTs.get(message.ts)
		if (indices === undefined || indices.length === 0) {
			return undefined
		}
		const idx = indices[indices.length - 1]
		const replaced = this.window[idx]
		if (replaced === message) {
			// Identical reference: nothing changed; keep the snapshot stable.
			return replaced
		}
		this.window[idx] = message
		this.snapshot = undefined
		return replaced
	}

	/**
	 * Immutable array view of the retained messages. The same array instance
	 * is returned until the next mutation, so React's reference-equality
	 * memo comparisons see a stable identity across reads.
	 */
	getMessages(): ClineMessage[] {
		if (this.snapshot === undefined) {
			this.snapshot = [...this.window]
		}
		return this.snapshot
	}

	private indexTs(ts: number, index: number): void {
		const existing = this.indicesByTs.get(ts)
		if (existing === undefined) {
			this.indicesByTs.set(ts, [index])
		} else {
			existing.push(index)
		}
	}
}
