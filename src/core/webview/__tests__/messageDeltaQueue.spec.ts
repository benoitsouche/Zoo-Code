// Unit tests for MessageDeltaQueue (issue #1675 Step 2) — pure logic, fake timers.
//
// Semantics under test:
//  - Leading edge: the FIRST message after an idle period is emitted immediately
//    (streams render with pre-refactor latency; its ts is known before partials).
//  - Coalescing: messages pushed within the wait window after the leader batch
//    into a trailing emission.
//  - maxWait bounds coalescing under continuous appends.
//  - Watermarks are captured per message at push time; a batch carries the last
//    message's watermark, enabling receiver-side continuity checks.

import type { ClineMessage } from "@roo-code/types"
import { MessageDeltaQueue } from "../messageDeltaQueue"

function msg(n: number): ClineMessage {
	return { ts: n, type: "say", say: "text", text: `m${n}` } as ClineMessage
}

function makeQueue() {
	const emitted: Array<{ messages: ClineMessage[]; watermark: number }> = []
	const queue = new MessageDeltaQueue({
		waitMs: 500,
		maxWaitMs: 1000,
		emit: (messages, watermark) => {
			emitted.push({ messages, watermark })
		},
	})
	return { queue, emitted }
}

describe("MessageDeltaQueue", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test("leading edge: first message after idle is emitted immediately", async () => {
		const { queue, emitted } = makeQueue()

		queue.push(msg(1), 1)
		// Leading-edge emission is scheduled via flushInFlight microtasks —
		// flush() awaits it, so after a no-op tick the emission has run.
		await vi.advanceTimersByTimeAsync(0)

		expect(emitted).toHaveLength(1)
		expect(emitted[0].messages.map((m) => m.text)).toEqual(["m1"])
		expect(emitted[0].watermark).toBe(1)
	})

	test("messages within the wait window coalesce into one trailing batch", async () => {
		const { queue, emitted } = makeQueue()

		queue.push(msg(1), 1) // leading edge, emitted immediately
		await vi.advanceTimersByTimeAsync(0)

		queue.push(msg(2), 2)
		queue.push(msg(3), 3)

		// Nothing new until the wait window elapses.
		expect(emitted).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(500)
		expect(emitted).toHaveLength(2)
		expect(emitted[1].messages.map((m) => m.text)).toEqual(["m2", "m3"])
		// Batch watermark = last message's watermark.
		expect(emitted[1].watermark).toBe(3)
	})

	test("the window closes after a trailing batch, so the next message leads again", async () => {
		const { queue, emitted } = makeQueue()

		queue.push(msg(1), 1)
		await vi.advanceTimersByTimeAsync(0)
		queue.push(msg(2), 2)
		await vi.advanceTimersByTimeAsync(500)

		// After the trailing emission the window is closed: msg 3 leads.
		queue.push(msg(3), 3)
		await vi.advanceTimersByTimeAsync(0)

		const texts = emitted.map((e) => e.messages.map((m) => m.text).join(","))
		expect(texts).toEqual(["m1", "m2", "m3"])
	})

	test("maxWait bounds coalescing under continuous appends", async () => {
		const { queue, emitted } = makeQueue()

		// Continuous appends every 100ms — never idle for 500ms.
		for (let round = 0; round < 15; round++) {
			queue.push(msg(round), round + 1)
			await vi.advanceTimersByTimeAsync(100)
		}

		// At least two emissions: the leader plus at least one maxWait batch.
		expect(emitted.length).toBeGreaterThanOrEqual(2)
		// No loss: every pushed message is emitted exactly once.
		const total = emitted.reduce((sum, e) => sum + e.messages.length, 0)
		expect(total).toBe(15)
	})

	test("manual flush emits pending messages immediately and clears the queue", async () => {
		const { queue, emitted } = makeQueue()

		queue.push(msg(1), 1)
		await vi.advanceTimersByTimeAsync(0)
		queue.push(msg(2), 2)

		await queue.flush()
		expect(emitted).toHaveLength(2)
		expect(emitted[1].messages.map((m) => m.text)).toEqual(["m2"])

		// Second flush with nothing pending is a no-op.
		await queue.flush()
		expect(emitted).toHaveLength(2)
	})

	test("clear drops pending messages without emitting", async () => {
		const { queue, emitted } = makeQueue()

		queue.push(msg(1), 1)
		await vi.advanceTimersByTimeAsync(0)
		queue.push(msg(2), 2)
		queue.clear()
		await vi.advanceTimersByTimeAsync(1000)

		expect(emitted).toHaveLength(1) // only the leading-edge batch
		expect(queue.size).toBe(0)
	})

	test("no message is emitted twice when a timed flush races a manual flush", async () => {
		const { queue, emitted } = makeQueue()

		queue.push(msg(1), 1)
		queue.push(msg(2), 2)

		const timed = vi.advanceTimersByTimeAsync(500)
		await queue.flush()
		await timed

		const total = emitted.reduce((sum, e) => sum + e.messages.length, 0)
		expect(total).toBe(2)
	})

	test("flush during an in-flight emission waits and preserves order", async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		const order: string[] = []
		let calls = 0

		const queue = new MessageDeltaQueue({
			waitMs: 10,
			maxWaitMs: 5000,
			emit: async (messages, _watermark) => {
				calls++
				order.push(`start-${messages[0].text}`)
				if (calls === 1) {
					await gate
					order.push("end-1")
					return
				}
				order.push(`end-${messages[0].text}`)
			},
		})

		// Drain so the first batch is genuinely in-flight (gated).
		queue.push(msg(1), 1)
		const firstDrain = vi.advanceTimersByTimeAsync(0)
		await firstDrain
		expect(order).toEqual(["start-m1"])

		// A message appended while the emission is gated goes into a new batch.
		queue.push(msg(2), 2)
		const manualFlush = queue.flush()

		release()
		await manualFlush

		expect(order.indexOf("end-1")).toBeLessThan(order.indexOf("start-m2"))
	})
})
