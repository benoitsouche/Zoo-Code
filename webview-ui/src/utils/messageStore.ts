// Message store backing the webview's clineMessages state (issue #1675, Steps 1+3).
//
// Problem being fixed: every `messageUpdated` partial previously cloned the
// entire conversation array, every state push replaced it wholesale, and the
// webview retained the full multi-day conversation forever — the retained-RAM
// half of the #1675 gray screen (the churn half is fixed by the
// messagesAppended delta channel, Step 2).
//
// This store provides:
//   - O(1) append / last-match upsert (exact findLastIndex parity) with a
//     cached immutable snapshot for React state (Step 1).
//   - A bounded retention window: when the retained byte size exceeds the
//     budget, the OLDEST messages are evicted and only a lightweight shell
//     (ts + partial type info, no text/images) stays for them, so UI state
//     like FileChangesPanel/subtask-link scans can still see every ts that
//     ever existed without retaining message bodies (Step 3).
//   - `totalCount` — the authoritative count of messages known for the task
//     (retained + shells). Delta continuity checks compare against this, not
//     the window size, so eviction never masquerades as a gap.
//   - `prependMessages` for loading earlier pages from disk on demand; it
//     replaces the matching shells (or dedup-appends if the page overlaps
//     content already retained).
//
// The store is pure TypeScript (no React/vscode) so it is unit-testable.

import type { ClineMessage } from "@roo-code/types"

/** Estimated per-message JSON size used for the retention budget. */
function estimateMessageBytes(message: ClineMessage): number {
	// Text dominates; images (base64) dominate harder when present. This is an
	// estimate for budgeting, not an exact wire size.
	const textBytes = (message.text?.length ?? 0) + (message.images?.join("").length ?? 0)
	return 256 + textBytes
}

/** Minimal retained record for an evicted message. */
export interface EvictedMessageShell {
	evicted: true
	ts: number
	type?: ClineMessage["type"]
}

export interface MessageStoreOptions {
	/**
	 * Soft upper bound on estimated retained message bytes. When exceeded,
	 * oldest messages are evicted to shells. Default 64 MiB — generous enough
	 * that eviction only engages on genuinely long sessions, small enough to
	 * keep the renderer far below collapse even with several large sessions'
	 * worth of pressure.
	 */
	byteBudget?: number
}

export class MessageStore {
	/** Full retained messages, in task order. */
	private readonly window: ClineMessage[] = []
	/** Shells for evicted messages, in task order, oldest first. */
	private readonly shells: EvictedMessageShell[] = []
	/** ts -> window indices where a full message with that ts lives. */
	private readonly indicesByTs = new Map<number, number[]>()
	private snapshot: ClineMessage[] | undefined
	private retainedBytes = 0
	private readonly byteBudget: number

	constructor(options: MessageStoreOptions = {}) {
		this.byteBudget = options.byteBudget ?? 64 * 1024 * 1024
	}

	/** Number of full messages currently retained. */
	get size(): number {
		return this.window.length
	}

	/**
	 * Total messages known for the task: retained + evicted shells. This is
	 * the continuity ground truth for the delta watermark — evictions never
	 * make a continuous batch look discontinuous.
	 */
	get totalCount(): number {
		return this.shells.length + this.window.length
	}

	/** Number of evicted (shelled) messages not currently in memory. */
	get evictedCount(): number {
		return this.shells.length
	}

	/** Estimated retained bytes (for diagnostics / telemetry). */
	get retainedByteEstimate(): number {
		return this.retainedBytes
	}

	/**
	 * Replaces the entire contents (full-state snapshot path) and clears all
	 * evicted shells — the incoming snapshot is authoritative. The array is
	 * stored as-is; callers treat the snapshot as immutable (React semantics).
	 */
	replaceAll(messages: ClineMessage[]): void {
		this.window.length = 0
		this.shells.length = 0
		this.indicesByTs.clear()
		this.retainedBytes = 0
		for (let i = 0; i < messages.length; i++) {
			this.window.push(messages[i])
			this.indexTs(messages[i].ts, i)
		}
		// The authoritative snapshot path: budget enforcement happens in
		// evictIfNeeded, which preserves the incoming identity semantics only
		// when nothing was evicted — see replaceAllAndEnforceBudget.
		for (const message of messages) {
			this.retainedBytes += estimateMessageBytes(message)
		}
		this.snapshot = messages
		this.enforceBudget()
	}

	/** Appends a message at the end (streaming delta path). */
	append(message: ClineMessage): void {
		this.window.push(message)
		this.indexTs(message.ts, this.window.length - 1)
		this.retainedBytes += estimateMessageBytes(message)
		this.snapshot = undefined
		this.enforceBudget()
	}

	/**
	 * Replaces the LAST full message with a matching ts (streaming partial
	 * update path — messageUpdated). Returns the replaced message, or
	 * undefined if no retained message has that ts (caller decides whether to
	 * warn/drop; a ts that only exists as a shell cannot be partial-updated
	 * and is treated as unknown).
	 */
	updateLastForTs(message: ClineMessage): ClineMessage | undefined {
		const indices = this.indicesByTs.get(message.ts)
		if (indices === undefined || indices.length === 0) {
			return undefined
		}

		const index = indices[indices.length - 1]
		const previous = this.window[index]
		this.window[index] = message
		this.retainedBytes += estimateMessageBytes(message) - estimateMessageBytes(previous)
		if (previous !== message) {
			this.snapshot = undefined
		}
		return previous
	}

	/**
	 * Prepends a page of earlier messages loaded from disk (load-earlier
	 * path). `prependCount` is the shell count being satisfied. The page
	 * replaces the oldest shells when it covers them; any trailing overlap
	 * with already-retained content is dropped rather than duplicated. The
	 * batch is accepted only if its length matches the page boundary the
	 * caller requested (no partial/inconsistent pages).
	 */
	prependMessages(page: ClineMessage[], prependCount: number): boolean {
		if (prependCount < 0 || page.length !== prependCount) {
			return false
		}

		// The page restores the NEWEST evicted messages (the ones immediately
		// before the current window head), i.e. the LAST `prependCount`
		// shells — shells are ordered oldest-first, so consume from the end.
		if (prependCount > this.shells.length) {
			return false
		}
		this.shells.splice(this.shells.length - prependCount, prependCount)

		// Drop page entries already retained: the page's tail may overlap the
		// window's HEAD (e.g. the page was computed against a stale eviction
		// boundary, or a resync repopulated recent content). See
		// computeTailOverlap for the pairwise verification.
		const overlap = this.computeTailOverlap(page)

		// Rebuild the window with the retained page portion in front.
		const retainedPage = page.slice(0, page.length - overlap)
		const newWindow = [...retainedPage, ...this.window]
		this.window.length = 0
		this.indicesByTs.clear()
		this.retainedBytes = 0
		for (let i = 0; i < newWindow.length; i++) {
			this.window.push(newWindow[i])
			this.indexTs(newWindow[i].ts, i)
			this.retainedBytes += estimateMessageBytes(newWindow[i])
		}
		this.snapshot = undefined
		return true
	}

	/**
	 * Immutable array view of the retained window. The same array instance is
	 * returned until the next mutation, so React's reference-equality memo
	 * comparisons (and Virtuoso) see a stable identity across reads.
	 */
	getMessages(): ClineMessage[] {
		if (this.snapshot === undefined) {
			this.snapshot = [...this.window]
		}
		return this.snapshot
	}

	/**
	 * Evicts oldest retained messages into shells until the estimated size is
	 * back under budget. Evicted indices are removed from the ts index. Never
	 * evicts below one message (a window with at least the newest content).
	 */
	private enforceBudget(): void {
		let evictFrom = 0
		while (this.retainedBytes > this.byteBudget && this.window.length - evictFrom > 1) {
			const message = this.window[evictFrom]
			this.shells.push({ evicted: true, ts: message.ts, type: message.type })
			this.retainedBytes -= estimateMessageBytes(message)
			const indices = this.indicesByTs.get(message.ts)
			if (indices !== undefined) {
				const idx = indices.indexOf(evictFrom)
				if (idx !== -1) {
					indices.splice(idx, 1)
				}
			}
			evictFrom++
		}

		if (evictFrom > 0) {
			this.window.splice(0, evictFrom)
			this.reindex()
			this.snapshot = undefined
		}
	}

	/** Rebuilds indicesByTs after index-shifting mutations. */
	private reindex(): void {
		this.indicesByTs.clear()
		for (let i = 0; i < this.window.length; i++) {
			this.indexTs(this.window[i].ts, i)
		}
	}

	/**
	 * Length of the page-tail run that duplicates the window's head.
	 *
	 * Finds the page entry whose ts equals the window's first message and
	 * verifies the page-suffix/window-prefix run pairwise (capped at the
	 * window length). Returns 0 when there is no overlap.
	 */
	private computeTailOverlap(page: ClineMessage[]): number {
		if (page.length === 0 || this.window.length === 0) {
			return 0
		}
		const windowHeadTs = this.window[0].ts
		for (let i = page.length - 1; i >= 0; i--) {
			if (page[i].ts !== windowHeadTs) {
				continue
			}
			const candidate = Math.min(page.length - i, this.window.length)
			let matches = true
			for (let j = 0; j < candidate; j++) {
				if (page[i + j].ts !== this.window[j].ts) {
					matches = false
					break
				}
			}
			if (matches) {
				return candidate
			}
		}
		return 0
	}

	private indexTs(ts: number, index: number): void {
		const indices = this.indicesByTs.get(ts)
		if (indices === undefined) {
			this.indicesByTs.set(ts, [index])
		} else {
			indices.push(index)
		}
	}
}
