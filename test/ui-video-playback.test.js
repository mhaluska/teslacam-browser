import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import uiConstants from "../src/renderer/ui-constants.js"
import uiVideo from "../src/renderer/ui-video.js"

// Exercises the real component methods (no jsdom): a fake `this` carries the
// data() fields plus the props/$refs the methods touch, and `window` timers are
// stubbed onto vitest's fake clock.

const DRIFT = uiConstants.DRIFT_CORRECTION_THRESHOLD_SEC
const component = uiVideo.createVideoComponent({})

function makeVideo(overrides = {}) {
	return {
		readyState: 4,
		duration: 60,
		currentTime: 0,
		paused: false,
		playbackRate: 1,
		style: {},
		play: vi.fn(() => Promise.resolve()),
		pause: vi.fn(),
		addEventListener: vi.fn(),
		...overrides,
	}
}

function makeVm({ camera = "front", timespan = {}, video = makeVideo(), playbackRate = 1 } = {}) {
	const vm = Object.create(component.methods)
	Object.assign(vm, component.data(), {
		view: { camera, filePath: "SavedClips/x/front.mp4", file: "u" },
		timespan,
		playbackRate,
		$refs: { video },
	})
	return vm
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal("window", {
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
		requestAnimationFrame: vi.fn(() => 1),
		cancelAnimationFrame: vi.fn(),
	})
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("startPlayback", () => {
	it("seeks to the duration-adjusted shared time and plays immediately", () => {
		const video = makeVideo({ duration: 45 })
		const vm = makeVm({ timespan: { currentTime: 20, duration: 60 }, video })

		vm.startPlayback()

		expect(video.currentTime).toBe(5) // 20 - (60 - 45)
		expect(video.play).toHaveBeenCalledOnce()
		expect(video.style.opacity).toBe(1.0)
		expect(vm.timeout).toBeNull()
		expect(window.requestAnimationFrame).toHaveBeenCalled() // front overlay loop
	})

	it("delays a shorter camera until the shared clock reaches its start", () => {
		const video = makeVideo({ duration: 45 })
		const vm = makeVm({ camera: "back", timespan: { currentTime: 5, duration: 60 }, video })

		vm.startPlayback() // adjusted time is -10s

		expect(vi.getTimerCount()).toBe(1)
		expect(video.play).not.toHaveBeenCalled()

		vi.advanceTimersByTime(10_000)

		expect(video.currentTime).toBe(0)
		expect(video.play).toHaveBeenCalledOnce()
		expect(video.style.opacity).toBe(1.0)
		expect(vm.timeout).toBeNull()
	})

	it("scales the start delay by the playback rate", () => {
		const video = makeVideo({ duration: 45 })
		const vm = makeVm({ timespan: { currentTime: 5, duration: 60 }, video, playbackRate: 2 })

		vm.startPlayback()

		expect(video.playbackRate).toBe(2)
		vi.advanceTimersByTime(4_999)
		expect(video.play).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(video.play).toHaveBeenCalledOnce()
	})

	it("cancels a pending delayed start on re-entry instead of resetting to zero later", () => {
		// Regression test for 71879ab: a skip/seek during the delay window used to
		// leak the old timer, which later reset video.currentTime to 0 mid-playback.
		const video = makeVideo({ duration: 45 })
		const timespan = { currentTime: 5, duration: 60 }
		const vm = makeVm({ timespan, video })

		vm.startPlayback()
		expect(vi.getTimerCount()).toBe(1)

		timespan.currentTime = 30
		vm.startPlayback()

		expect(video.play).toHaveBeenCalledOnce()
		expect(video.currentTime).toBe(15) // 30 - (60 - 45)

		vi.runAllTimers()

		expect(vi.getTimerCount()).toBe(0)
		expect(video.play).toHaveBeenCalledOnce() // stale timer never fired
		expect(video.currentTime).toBe(15) // never reset to 0
	})

	it("waits for metadata before doing anything when readyState < 1", () => {
		const video = makeVideo({ readyState: 0 })
		const vm = makeVm({ timespan: { currentTime: 20, duration: 60 }, video })

		vm.startPlayback()

		expect(video.addEventListener).toHaveBeenCalledWith("loadedmetadata", expect.any(Function), { once: true })
		expect(video.play).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("records a play() rejection in the component error state", async () => {
		const video = makeVideo({ duration: 60, play: vi.fn(() => Promise.reject(new Error("boom"))) })
		const vm = makeVm({ timespan: { currentTime: 20, duration: 60 }, video })

		vm.startPlayback()
		await Promise.resolve()
		await Promise.resolve()

		expect(vm.error).toBe("boom")
	})
})

describe("correctDriftDuringPlay", () => {
	function driftSetup({ camera = "back", drift, videoOverrides = {}, timespanOverrides = {} } = {}) {
		const timespan = { playing: true, currentTime: 30, duration: 60, ...timespanOverrides }
		const adjusted = timespan.currentTime - (timespan.duration - 45)
		const video = makeVideo({ duration: 45, currentTime: adjusted + drift, ...videoOverrides })
		return { vm: makeVm({ camera, timespan, video }), video, adjusted }
	}

	it("snaps a follower back once drift exceeds the threshold", () => {
		const { vm, video, adjusted } = driftSetup({ drift: DRIFT + 0.01 })
		vm.correctDriftDuringPlay()
		expect(video.currentTime).toBe(adjusted)
	})

	it("tolerates drift exactly at the threshold", () => {
		const { vm, video, adjusted } = driftSetup({ drift: DRIFT })
		vm.correctDriftDuringPlay()
		expect(video.currentTime).toBe(adjusted + DRIFT)
	})

	it("never corrects the leader", () => {
		const { vm, video, adjusted } = driftSetup({ camera: "front", drift: 5 })
		vm.correctDriftDuringPlay()
		expect(video.currentTime).toBe(adjusted + 5)
	})

	it("is a no-op while paused or not playing", () => {
		for (const setup of [
			driftSetup({ drift: 5, timespanOverrides: { playing: false } }),
			driftSetup({ drift: 5, videoOverrides: { paused: true } }),
		]) {
			setup.vm.correctDriftDuringPlay()
			expect(setup.video.currentTime).toBe(setup.adjusted + 5)
		}
	})

	it("is a no-op on non-finite durations or a negative adjusted time", () => {
		for (const setup of [
			driftSetup({ drift: 5, videoOverrides: { duration: Number.NaN } }),
			driftSetup({ drift: 5, timespanOverrides: { duration: Number.NaN } }),
			driftSetup({ drift: 5, timespanOverrides: { currentTime: 5 } }), // adjusted = -10
		]) {
			const before = setup.video.currentTime
			setup.vm.correctDriftDuringPlay()
			expect(setup.video.currentTime).toBe(before)
		}
	})
})

describe("timeChanged (leader clock)", () => {
	it("maps the leader's local time onto the shared timeline despite duration mismatch", () => {
		// Regression test for 80fabb8: a duration-match gate used to freeze the
		// shared clock whenever a sibling was >=30ms longer than the front camera.
		const timespan = { currentTime: 0, duration: 60 }
		const vm = makeVm({ timespan })

		vm.timeChanged({ target: { currentTime: 10, duration: 45, paused: false } })

		expect(timespan.currentTime).toBe(25) // 10 + (60 - 45)
	})

	it("ignores followers, paused videos and non-finite durations", () => {
		const cases = [
			{ camera: "back", target: { currentTime: 10, duration: 45, paused: false } },
			{ camera: "front", target: { currentTime: 10, duration: 45, paused: true } },
			{ camera: "front", target: { currentTime: 10, duration: Number.NaN, paused: false } },
			{ camera: "front", target: { currentTime: 10, duration: 45, paused: false }, duration: Number.NaN },
		]

		for (const c of cases) {
			const timespan = { currentTime: 7, duration: c.duration ?? 60 }
			makeVm({ camera: c.camera, timespan }).timeChanged({ target: c.target })
			expect(timespan.currentTime).toBe(7)
		}
	})
})

describe("onPause", () => {
	it("flushes the final leader position onto the shared timeline even when paused", () => {
		// Regression test for 9825073: the flush used to be dropped on duration
		// mismatch, trapping the cursor at the last timeupdate sample.
		const timespan = { currentTime: 0, duration: 60 }
		const vm = makeVm({ timespan })

		vm.onPause({ target: { currentTime: 12, duration: 45, paused: true } })

		expect(timespan.currentTime).toBe(27) // 12 + (60 - 45)
	})

	it("ignores follower pauses", () => {
		const timespan = { currentTime: 7, duration: 60 }
		makeVm({ camera: "back", timespan }).onPause({ target: { currentTime: 12, duration: 45, paused: true } })
		expect(timespan.currentTime).toBe(7)
	})
})

describe("ended", () => {
	it("advances the clip when the front camera ends, regardless of durations", () => {
		// Regression test for a5422b8: a duration-match gate used to swallow the
		// transition when the front camera was shorter than its longest sibling.
		const timespan = { ended: false, duration: 60 }
		makeVm({ timespan, video: makeVideo({ duration: 45 }) }).ended()
		expect(timespan.ended).toBe(true)
	})

	it("ignores follower ended events", () => {
		const timespan = { ended: false, duration: 60 }
		makeVm({ camera: "back", timespan }).ended()
		expect(timespan.ended).toBe(false)
	})
})
