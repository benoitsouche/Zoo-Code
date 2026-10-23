// Tests for the messagesAppended delta channel in the CLI agent
// (issue #1675 Step 2 co-update). Pure test: real MessageProcessor, real
// StateStore, real TypedEventEmitter — no module mocking.

import type { ClineMessage, ExtensionMessage } from "@roo-code/types"
import { MessageProcessor } from "../message-processor.js"
import { StateStore } from "../state-store.js"
import { TypedEventEmitter } from "../events.js"

/** Minimal say:text message factory. */
function msg(ts: number, text: string, partial = false): ClineMessage {
	return { ts, type: "say", say: "text", text, partial, ask: undefined } as unknown as ClineMessage
}

/** messagesAppended ExtensionMessage factory. */
function appendedMessage(messages: ClineMessage[], messagesWatermark?: number): ExtensionMessage {
	return {
		type: "messagesAppended",
		messages,
		...(messagesWatermark !== undefined ? { messagesWatermark } : {}),
	} as ExtensionMessage
}

describe("MessageProcessor messagesAppended (issue #1675 Step 2)", () => {
	let store: StateStore
	let emitter: TypedEventEmitter
	let processor: MessageProcessor

	beforeEach(() => {
		store = new StateStore()
		emitter = new TypedEventEmitter()
		processor = new MessageProcessor(store, emitter)
	})

	test("appends a continuous batch and emits per-message events", () => {
		const messages: ClineMessage[] = []
		emitter.on("message", (m: ClineMessage) => messages.push(m))

		// Hydrate with 2 messages (count = 2), then a continuous batch of 3
		// whose watermark is exactly 5.
		store.setMessages([msg(1, "a"), msg(2, "b")])
		messages.length = 0

		processor.processMessage(appendedMessage([msg(3, "c"), msg(4, "d"), msg(5, "e")], 5))

		expect(store.getMessages().length).toBe(5)
		expect(store.getMessages().map((m) => m.text)).toEqual(["a", "b", "c", "d", "e"])
		expect(messages.length).toBe(3)
	})

	test("drops a discontinuous batch and emits stateResyncNeeded", () => {
		const resyncs: Array<{ held: number; watermark: number }> = []
		emitter.on("stateResyncNeeded", (payload) => resyncs.push(payload as { held: number; watermark: number }))

		store.setMessages([msg(1, "a"), msg(2, "b")])

		// Watermark 9 means messages 3..6 were lost (held 2 + batch 3 != 9).
		processor.processMessage(appendedMessage([msg(7, "g"), msg(8, "h"), msg(9, "i")], 9))

		expect(store.getMessages().length).toBe(2)
		expect(resyncs.length).toBe(1)
		expect(resyncs[0]).toEqual({ held: 2, watermark: 9 })
	})

	test("treats a batch without watermark as continuous (backward compatible)", () => {
		store.setMessages([msg(1, "a")])

		processor.processMessage(appendedMessage([msg(2, "b")]))

		expect(store.getMessages().length).toBe(2)
	})

	test("an empty batch is a no-op", () => {
		store.setMessages([msg(1, "a")])

		processor.processMessage(appendedMessage([], 1))

		expect(store.getMessages().length).toBe(1)
	})

	test("a stale post-resync batch is dropped", () => {
		store.setMessages([msg(1, "a"), msg(2, "b"), msg(3, "c")])

		// A resync already brought the store to 3 messages; a stale batch from
		// before the snapshot carries a smaller watermark and must not append.
		processor.processMessage(appendedMessage([msg(2, "b")], 2))

		const messages = store.getMessages()
		expect(messages.length).toBe(3)
		expect(messages[messages.length - 1]?.text).toBe("c")
	})
})
