// Reproduction evidence for https://github.com/Zoo-Code-Org/Zoo-Code/issues/1675
//
// Issue #1675 ("Gray Screen"): the webview renderer dies on long-running tasks.
// Triage hypothesis: the extension posts the FULL clineMessages array (the
// entire conversation) to the webview on every state update — and during
// streaming, the debounce (leading:true, trailing:true, maxWait:1000) posts at
// >= 1/sec. Prediction: posted payload bytes scale with TOTAL session size,
// not with the volume of new content.
//
// This spec measures that empirically through the real production path:
// streaming updates -> postStateToWebviewThrottled -> postStateToWebviewWithoutTaskHistory
// -> getStateToPostToWebview (embeds currentTask.clineMessages wholesale).
// Payloads are captured at the postMessageToWebview boundary — the exact object
// that would be structured-cloned across the webview bridge.
//
// NOTE: this file uses NO vi.mock module interception (which is unreliable in
// this checkout's environment); all doubles are runtime-only (spyOn/subclass),
// which does not depend on the module graph.

import * as vscodeMock from "vscode"
import type vscode from "vscode"
import type { ClineMessage } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { ClineProvider } from "../ClineProvider"

interface TrialOptions {
	historyCount: number
	historyBodyChars: number
	newMessages: number
	messageIntervalMs: number
}

interface TrialResult {
	historyCount: number
	newTextBytes: number
	postCount: number
	totalPostedBytes: number
	largestPostBytes: number
}

// The shared vscode alias mock (src/__mocks__/vscode.js) lacks tabGroups,
// which the REAL WorkspaceTracker constructed by ClineProvider touches at
// construction (WorkspaceTracker.ts:64). We patch the alias-mocked
// vscode.window at runtime — mutation, not vi.mock, following the precedent in
// src/utils/__tests__/path.spec.ts which mutates the shared alias mock
// directly. The original value is restored in afterEach.
const mockWindow = vscodeMock.window as unknown as Record<string, unknown>
let originalTabGroups: unknown
let tabGroupsPatched = false

function ensureTabGroupsOnSharedMock() {
	if (!tabGroupsPatched) {
		originalTabGroups = mockWindow.tabGroups
		mockWindow.tabGroups = {
			all: [],
			onDidChangeTabs: () => ({ dispose: () => {} }),
			onDidChangeTabGroups: () => ({ dispose: () => {} }),
			onDidChangeActiveTabGroup: () => ({ dispose: () => {} }),
		}
		tabGroupsPatched = true
	}
}

function restoreTabGroupsOnSharedMock() {
	if (tabGroupsPatched) {
		mockWindow.tabGroups = originalTabGroups
		tabGroupsPatched = false
	}
}

function makeMockContext() {
	const globalState: Record<string, unknown> = {
		mode: "architect",
		currentApiConfigName: "current-config",
	}
	const secrets: Record<string, unknown> = {}
	return {
		extensionPath: "/test/path",
		extensionUri: { fsPath: "/test/path" },
		globalState: {
			get: ((key: string) => globalState[key]) as never,
			update: ((key: string, value: unknown) => {
				globalState[key] = value
				return Promise.resolve()
			}) as never,
			keys: (() => Object.keys(globalState)) as never,
		},
		secrets: {
			get: ((key: string) => secrets[key]) as never,
			store: ((key: string, value: unknown) => {
				secrets[key] = value
				return Promise.resolve()
			}) as never,
			delete: ((key: string) => {
				delete secrets[key]
				return Promise.resolve()
			}) as never,
		},
		workspaceState: {
			get: (() => undefined) as never,
			update: (() => Promise.resolve()) as never,
			keys: (() => []) as never,
		},
		subscriptions: [],
		extension: { packageJSON: { version: "1.0.0" } },
		globalStorageUri: { fsPath: "/test/storage/path" },
		storageUri: { fsPath: "/test/storage/path" },
	} as unknown as vscode.ExtensionContext
}

// Runtime subclass: override the task lookup instead of module-mocking
// WorkspaceTracker/vscode. Only state-posting is exercised in this spec.
type MinimalTask = { taskId: string; clineMessages: ClineMessage[]; todoList: unknown[] }

class TestableProvider extends ClineProvider {
	constructor(private readonly fakeTask: MinimalTask) {
		super(
			makeMockContext(),
			{ appendLine: () => {}, clear: () => {}, dispose: () => {} } as unknown as vscode.OutputChannel,
			"sidebar",
			new ContextProxy(makeMockContext()),
			new WebviewFocusTracker(),
		)
	}

	public override getCurrentTask(): ReturnType<ClineProvider["getCurrentTask"]> {
		// The double assertion is unavoidable: the fake task provides only the
		// members the state-posting path reads (taskId, clineMessages, todoList),
		// and cannot be assigned to the full Task type.
		return this.fakeTask as unknown as ReturnType<ClineProvider["getCurrentTask"]>
	}
}

function makeHistoryTask(
	historyCount: number,
	historyBodyChars: number,
): {
	task: MinimalTask
	historyBytes: number
} {
	const messages: ClineMessage[] = []
	for (let i = 0; i < historyCount; i++) {
		messages.push({
			ts: 1_700_000_000_000 + i,
			type: "say",
			say: "text",
			text: "h".repeat(historyBodyChars),
		} as ClineMessage)
	}
	return {
		task: {
			taskId: "long-session-task",
			clineMessages: messages,
			todoList: [],
		},
		historyBytes: JSON.stringify(messages).length,
	}
}

describe("webview state-post churn (issue #1675 reproduction evidence)", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	afterAll(() => {
		restoreTabGroupsOnSharedMock()
	})

	// Runs one simulated streaming window against a fresh provider and returns
	// the payloads posted through the real throttled state-post path.
	async function runStreamingTrial(options: TrialOptions): Promise<TrialResult> {
		const { historyCount, historyBodyChars, newMessages, messageIntervalMs } = options
		const { task } = makeHistoryTask(historyCount, historyBodyChars)

		ensureTabGroupsOnSharedMock()
		const provider = new TestableProvider(task)

		// Capture the exact payloads that would cross the webview bridge, without
		// depending on module mocking: spyOn is a runtime patch.
		const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)

		const newTextChunks: string[] = []

		vi.useFakeTimers()

		try {
			for (let i = 0; i < newMessages; i++) {
				// 50 streaming updates are tiny partials, like a real streaming turn.
				const text = `streaming chunk ${i} `.repeat(3)
				newTextChunks.push(text)
				task.clineMessages.push({
					ts: 1_700_100_000_000 + i,
					type: "say",
					say: "text",
					text,
				} as ClineMessage)
				await provider.postStateToWebviewThrottled()
				await vi.advanceTimersByTimeAsync(messageIntervalMs)
			}

			// Flush any pending trailing debounce so the window is complete.
			await provider.flushPostStateToWebviewThrottled()

			const statePosts = postMessageSpy.mock.calls.filter(([message]) => message.type === "state")
			const postedSizes = statePosts.map(([message]) => JSON.stringify(message).length)
			const totalPostedBytes = postedSizes.reduce((sum, size) => sum + size, 0)
			const largestPostBytes = postedSizes.reduce((max, size) => Math.max(max, size), 0)

			return {
				historyCount,
				newTextBytes: newTextChunks.reduce((sum, text) => sum + text.length, 0),
				postCount: statePosts.length,
				totalPostedBytes,
				largestPostBytes,
			}
		} finally {
			vi.useRealTimers()
			await provider.dispose().catch(() => undefined)
		}
	}

	test("streams post payloads proportional to conversation size, not to new data (#1675 mechanism)", async () => {
		const smallSession = await runStreamingTrial({
			historyCount: 100,
			historyBodyChars: 2_000,
			newMessages: 50,
			messageIntervalMs: 20,
		})

		// Mark the streaming gate so both trials stay greppable in output.

		const largeSession = await runStreamingTrial({
			historyCount: 2_000,
			historyBodyChars: 2_000,
			newMessages: 50,
			messageIntervalMs: 20,
		})

		// Reporter-scale wire-volume trial (issue #1675 field scale): 25,000
		// history messages (~50MB of bodies). Pre-fix, one streaming second at
		// this scale posted O(50MB); post-fix it posts O(new data). Gated behind
		// CHURN_HEAVY=1 because JSON.stringify on the old-path payload is
		// expensive; the baseline (before-fix) numbers for the same trial are
		// recorded in the issue analysis: ~100MB posted per simulated second.
		if (process.env.CHURN_HEAVY === "1") {
			const reporterSession = await runStreamingTrial({
				historyCount: 25_000,
				historyBodyChars: 2_000,
				newMessages: 50,
				messageIntervalMs: 20,
			})
			expect(reporterSession.largestPostBytes).toBeLessThan(reporterSession.newTextBytes * 20)
			expect(reporterSession.totalPostedBytes).toBeLessThan(smallSession.totalPostedBytes * 2)
		}

		// Vitest's resolveVerbosity may suppress console output; assertions
		// below carry the evidence. The report string stays for non-silent runs.
		const report = [
			"issue #1675 churn reproduction (one simulated streaming second):",
			`  session A: history=${smallSession.historyCount} msgs, new data=${smallSession.newTextBytes} bytes`,
			`    -> ${smallSession.postCount} state posts, ${smallSession.totalPostedBytes} total bytes, largest single post ${smallSession.largestPostBytes} bytes`,
			`  session B: history=${largeSession.historyCount} msgs, new data=${largeSession.newTextBytes} bytes`,
			`    -> ${largeSession.postCount} state posts, ${largeSession.totalPostedBytes} total bytes, largest single post ${largeSession.largestPostBytes} bytes`,
		]
		console.info(report.join("\n"))

		// Regression gate for the Step 2 fix (messagesAppended delta channel):
		//
		// Before the fix (measured on the unfixed code): session B posted
		// 8,251,520 bytes for the same streaming window, 19x session A —
		// posted churn was O(total conversation). After the fix, streaming
		// state posts omit clineMessages and new messages travel as small
		// messagesAppended deltas, so posted bytes must be proportional to
		// NEW data and independent of history size.
		//
		// 1. No state post dwarfs the streamed volume: a single post stays
		//    within new-data scale (state fields + a few deltas; generous 20x
		//    headroom over the raw new text).
		expect(largeSession.largestPostBytes).toBeLessThan(largeSession.newTextBytes * 20)

		// 2. History independence: session B has 20x the history of session A
		//    with IDENTICAL streaming volume, so total posted bytes must be
		//    within 2x of session A (not 5-20x as before the fix; small slack
		//    absorbs per-post state-field variance).
		expect(largeSession.totalPostedBytes).toBeLessThan(smallSession.totalPostedBytes * 2)
		expect(largeSession.totalPostedBytes).toBeGreaterThan(smallSession.totalPostedBytes / 2)

		// Sanity: at least one state post happened in each trial.
		expect(smallSession.postCount).toBeGreaterThan(0)
		expect(largeSession.postCount).toBeGreaterThan(0)
	})

	// Runs a burst of UI actions through the REAL production message handler
	// (webviewMessageHandler "ttsEnabled" — one of ~40 call sites that invoke
	// provider.postStateToWebview() directly; a settings toggle is the
	// canonical mouse-driven trigger) against a session with the given
	// history, and measures the payloads at the postMessageToWebview boundary.
	async function runUiActionTrial(options: {
		historyCount: number
		historyBodyChars: number
		uiActions: number
	}): Promise<TrialResult> {
		const { historyCount, historyBodyChars, uiActions } = options
		const { task } = makeHistoryTask(historyCount, historyBodyChars)

		ensureTabGroupsOnSharedMock()
		const provider = new TestableProvider(task)

		const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)

		const { webviewMessageHandler } = await import("../webviewMessageHandler")

		try {
			// A user clicking a settings toggle routes through the message
			// handler; the handler persists state and posts the full refresh.
			for (let i = 0; i < uiActions; i++) {
				await webviewMessageHandler(provider, { type: "ttsEnabled", bool: i % 2 === 0 })
			}

			const statePosts = postMessageSpy.mock.calls.filter(([message]) => message.type === "state")
			const postedSizes = statePosts.map(([message]) => JSON.stringify(message).length)
			const totalPostedBytes = postedSizes.reduce((sum, size) => sum + size, 0)
			const largestPostBytes = postedSizes.reduce((max, size) => Math.max(max, size), 0)

			return {
				historyCount,
				// A UI-action burst streams no new conversation content; the only
				// "new data" is the state fields themselves. History size is the
				// scale reference the assertions below reason about.
				newTextBytes: 0,
				postCount: statePosts.length,
				totalPostedBytes,
				largestPostBytes,
			}
		} finally {
			await provider.dispose().catch(() => undefined)
		}
	}

	test("UI-action state posts embed the whole conversation (#1675 remaining gap)", async () => {
		const smallSession = await runUiActionTrial({
			historyCount: 100,
			historyBodyChars: 2_000,
			uiActions: 20,
		})

		const largeSession = await runUiActionTrial({
			historyCount: 2_000,
			historyBodyChars: 2_000,
			uiActions: 20,
		})

		// #1675 residual path (live-captured 2026-10-21: webview heap
		// sawtoothed to 3.9 GB with the UI-action sites already converted):
		// Task.ts stream-completion posts called
		// postStateToWebviewWithoutTaskHistory — which by design strips only
		// taskHistory and still embeds the whole clineMessages array — on
		// every message boundary. The bug was the CALL SITE, not the variant:
		// completions must use the message-free post.
		//
		// Gate 1 (static): Task.ts may call
		// postStateToWebviewWithoutTaskHistory only ONCE — the startTask
		// re-baseline over a freshly-emptied array. Any completion-site call
		// reintroduces O(conversation) churn per message.
		{
			const { readFile } = await import("node:fs/promises")
			const path = await import("node:path")
			const taskSource = await readFile(path.join(__dirname, "../../task/Task.ts"), "utf8")
			const occurrences = taskSource.split("postStateToWebviewWithoutTaskHistory()").length - 1
			expect(
				occurrences,
				"Task.ts must not call postStateToWebviewWithoutTaskHistory from completion sites (only the startTask re-baseline)",
			).toBe(1)
		}

		// Gate 2 (runtime): the variant Task.ts now uses must actually be
		// state-only — a few KB even against a 2000×2000-char conversation,
		// never the ~4 MB of an embedded session.
		{
			const { task } = makeHistoryTask(2_000, 2_000)
			const provider = new TestableProvider(task)
			const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)

			await provider.postStateToWebviewWithoutClineMessages()

			const statePosts = postMessageSpy.mock.calls.filter(([message]) => message.type === "state")
			const largestPostBytes = statePosts.reduce(
				(max, [message]) => Math.max(max, JSON.stringify(message).length),
				0,
			)
			console.info(`[churn-gate] message-free post largest: ${largestPostBytes} bytes`)
			expect(largestPostBytes, "message-free post must not embed the conversation").toBeLessThan(300_000)

			await provider.dispose().catch(() => undefined)
		}

		console.info(
			[
				"issue #1675 UI-action churn (20 synthetic settings toggles):",
				`  session A: history=${smallSession.historyCount} msgs`,
				`    -> ${smallSession.postCount} state posts, ${smallSession.totalPostedBytes} total bytes, largest single post ${smallSession.largestPostBytes} bytes`,
				`  session B: history=${largeSession.historyCount} msgs`,
				`    -> ${largeSession.postCount} state posts, ${largeSession.totalPostedBytes} total bytes, largest single post ${largeSession.largestPostBytes} bytes`,
			].join("\n"),
		)

		// Regression gate for the windowed/UI-scoped state-post fix (remediation
		// step "Window the remaining full-state posts"): post-fix, a UI-action
		// post carries only the state fields the action affects (the webview
		// keeps clineMessages via the delta channel; the merge treats omitted
		// clineMessages as "keep current"), NOT the entire conversation. The
		// 2000-message session must therefore stay within a small multiple of
		// the 100-message session regardless of history size.
		//
		// Pre-fix expectation (the measured mechanism this trial documents):
		// every toggle embeds the FULL clineMessages array, so session B posts
		// ~20x session A's bytes. The gate allows at most 3x headroom to absorb
		// state-field variance.
		expect(largeSession.totalPostedBytes).toBeLessThan(smallSession.totalPostedBytes * 3)

		// A single post must be conversation-size-independent: bounded state
		// fields, never the wire-scale of a 2000x2000-char history (~4MB).
		expect(largeSession.largestPostBytes).toBeLessThan(300_000)

		// Sanity: every UI action posted state.
		expect(smallSession.postCount).toBeGreaterThan(0)
		expect(largeSession.postCount).toBeGreaterThan(0)
	})
})
