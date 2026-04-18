import { describe, it, expect, beforeEach } from "vitest"
import uiVideo from "../src/renderer/ui-video.js"

const queue = uiVideo._probeQueueForTesting
const noop = () => undefined

describe("metadata probe queue", () => {
	beforeEach(() => {
		queue.reset()
	})

	it("grants up to N concurrent slots synchronously", () => {
		const tokens = []

		for (let i = 0; i < queue.limit; i++) {
			tokens.push(queue.acquire(noop))
		}

		expect(queue.activeCount).toBe(queue.limit)
		expect(queue.queueLength).toBe(0)
		tokens.forEach(t => expect(t.active).toBe(true))
	})

	it("queues the next acquire once the limit is reached", () => {
		for (let i = 0; i < queue.limit; i++) {
			queue.acquire(noop)
		}

		let started = false
		const queued = queue.acquire(() => { started = true })

		expect(queued.active).toBe(false)
		expect(started).toBe(false)
		expect(queue.queueLength).toBe(1)
	})

	it("drains one queued entry when an active slot is released", () => {
		const actives = []

		for (let i = 0; i < queue.limit; i++) {
			actives.push(queue.acquire(noop))
		}

		let startCount = 0
		const queued = queue.acquire(() => { startCount++ })

		queue.release(actives[0])

		expect(startCount).toBe(1)
		expect(queued.active).toBe(true)
		expect(queue.activeCount).toBe(queue.limit)
	})

	it("drain skips cancelled entries without invoking startFn", () => {
		const actives = []

		for (let i = 0; i < queue.limit; i++) {
			actives.push(queue.acquire(noop))
		}

		let cancelledStarted = false
		let nextStarted = false
		const cancelled = queue.acquire(() => { cancelledStarted = true })
		const next = queue.acquire(() => { nextStarted = true })

		queue.release(cancelled)

		expect(cancelled.cancelled).toBe(true)

		queue.release(actives[0])

		expect(cancelledStarted).toBe(false)
		expect(nextStarted).toBe(true)
		expect(next.active).toBe(true)
		expect(queue.activeCount).toBe(queue.limit)
		expect(queue.queueLength).toBe(0)
	})

	it("double-release is a no-op", () => {
		const token = queue.acquire(noop)

		queue.release(token)
		const active = queue.activeCount

		queue.release(token)

		expect(queue.activeCount).toBe(active)
	})

	it("release of an unknown token does not throw", () => {
		expect(() => queue.release(null)).not.toThrow()
		expect(() => queue.release(undefined)).not.toThrow()
	})
})
