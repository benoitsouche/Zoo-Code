// Coalescing delta queue for the messagesAppended channel (issue #1675 Step 2).
//
// Task#addToClineMessages fires once per streamed message, but the webview
// only needs the NEW messages, not the full conversation. This queue batches
// appended messages and mirrors the 500ms/1000ms-maxWait cadence the throttled
// state post uses — with one crucial difference: the FIRST message after an
// idle period is emitted immediately (leading edge), so streamed content starts
// rendering with the same latency as before this refactor, and subsequent
// `messageUpdated` partials for it are never dropped for an unknown ts.
//
// Each message is enqueued with its provider-side watermark (the total message
// count at enqueue time). The batch watermark is the last message's watermark,
// which makes continuity checkable by receivers without any shared counter:
//   applied iff  size + batch.length === watermark
//   gap     iff  watermark >  size + batch.length   (→ resync)
//   stale    iff  watermark <  size + batch.length   (→ drop)
//
// Pure module (no vscode/React imports) so it is unit-testable in isolation.

import type { ClineMessage } from "@roo-code/types"

export interface MessageDeltaQueueOptions {
	/** Coalesce window in milliseconds for messages after the leading edge. */
	waitMs: number
	/** Upper bound on coalesced batching even under continuous appends. */
	maxWaitMs: number
	/** Emission callback (posts the messagesAppended message). */
	emit: (messages: ClineMessage[], watermark: number) => void | Promise<void>
}

export interface EnqueuedMessage {
	message: ClineMessage
	/** Provider-side total message count at the moment this message was pushed. */
	watermark: number
}

export class MessageDeltaQueue {
	private pending: EnqueuedMessage[] = []
	private waitTimer: ReturnType<typeof setTimeout> | undefined
	private maxWaitTimer: ReturnType<typeof setTimeout> | undefined
	private flushInFlight: Promise<void> = Promise.resolve()

	constructor(private readonly options: MessageDeltaQueueOptions) {}

	/**
	 * Queue one appended message with its provider-side watermark. The first
	 * message after an idle period is emitted immediately (leading edge);
	 * messages pushed while an emission is pending or within the wait window
	 * coalesce into the next batch.
	 */
	push(message: ClineMessage, watermark: number): void {
		this.pending.push({ message, watermark })
		if (this.waitTimer === undefined) {
			// Leading edge: no coalescing window is open. Emit this message
			// straight through so it reaches the webview before any partial
			// text updates for its ts, then open the window for followers.
			void this.flush()
			this.openWindow()
			return
		}
		if (this.maxWaitTimer === undefined) {
			this.maxWaitTimer = setTimeout(() => {
				this.maxWaitTimer = undefined
				void this.flush()
			}, this.options.maxWaitMs)
		}
	}

	/** Number of messages waiting to be emitted. */
	get size(): number {
		return this.pending.length
	}

	/**
	 * Force-emit any pending messages immediately (before a full-state post,
	 * on resync, or on dispose). Serialized with in-flight emissions so batch
	 * order is preserved.
	 */
	async flush(): Promise<void> {
		if (this.pending.length === 0) {
			return
		}
		const batch = this.pending
		this.pending = []
		const watermark = batch[batch.length - 1].watermark
		this.flushInFlight = this.flushInFlight.then(async () => {
			await this.options.emit(
				batch.map((entry) => entry.message),
				watermark,
			)
		})
		await this.flushInFlight
	}

	/** Drop any pending messages without emitting. */
	clear(): void {
		this.clearTimers()
		this.pending = []
	}

	dispose(): void {
		this.clear()
	}

	private openWindow(): void {
		this.waitTimer = setTimeout(() => {
			this.waitTimer = undefined
			// Trailing edge: emit anything that coalesced behind the leading
			// message, then close the window so the next push leads again.
			if (this.maxWaitTimer !== undefined) {
				clearTimeout(this.maxWaitTimer)
				this.maxWaitTimer = undefined
			}
			void this.flush()
		}, this.options.waitMs)
	}

	private clearTimers(): void {
		if (this.waitTimer !== undefined) {
			clearTimeout(this.waitTimer)
			this.waitTimer = undefined
		}
		if (this.maxWaitTimer !== undefined) {
			clearTimeout(this.maxWaitTimer)
			this.maxWaitTimer = undefined
		}
	}
}
