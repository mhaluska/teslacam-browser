import { describe, it, expect } from "vitest"
import helpers from "../src/renderer/helpers.js"

describe("matchFolder", () => {
	it("matches Tesla clip folder names", () => {
		const m = helpers.matchFolder("2025-10-15_14-23-07")
		expect(m).toBeTruthy()
		expect(m.groups.y).toBe("2025")
		expect(m.groups.m).toBe("10")
		expect(m.groups.d).toBe("15")
		expect(m.groups.h).toBe("14")
		expect(m.groups.mm).toBe("23")
		expect(m.groups.s).toBe("07")
	})

	it("matches folders without seconds", () => {
		const m = helpers.matchFolder("2025-10-15_14-23")
		expect(m).toBeTruthy()
		expect(m.groups.s).toBeUndefined()
	})

	it("rejects non-matching folder names", () => {
		expect(helpers.matchFolder("RecentClips")).toBeNull()
		expect(helpers.matchFolder("arbitrary_folder")).toBeNull()
		expect(helpers.matchFolder("")).toBeNull()
	})
})

describe("matchClip", () => {
	it("matches Tesla clip filenames with camera suffix", () => {
		const m = helpers.matchClip("2025-10-15_14-23-07-front.mp4")
		expect(m).toBeTruthy()
		expect(m.groups.c).toBe("front")
	})

	it("parses back/left_repeater/right_repeater cameras", () => {
		expect(helpers.matchClip("2025-10-15_14-23-07-back.mp4").groups.c).toBe("back")
		expect(helpers.matchClip("2025-10-15_14-23-07-left_repeater.mp4").groups.c).toBe("left_repeater")
		expect(helpers.matchClip("2025-10-15_14-23-07-right_repeater.mp4").groups.c).toBe("right_repeater")
	})

	it("rejects non-mp4 files", () => {
		expect(helpers.matchClip("2025-10-15_14-23-07-front.mov")).toBeNull()
	})

	it("rejects filenames without any dash before .mp4", () => {
		// NOTE: the clipRegex requires at least one dash between the timestamp
		// tail and the `.mp4` suffix (and the `.` is actually a wildcard in the
		// current regex, but the dash is still required). "14-23.mp4" has no
		// trailing dash so it can't match.
		expect(helpers.matchClip("2025-10-15_14-23.mp4")).toBeNull()
	})
})

describe("extractDate", () => {
	it("converts a folder regex match to a Date", () => {
		const m = helpers.matchFolder("2025-06-01_09-30-45")
		const d = helpers.extractDate(m)
		expect(d.getFullYear()).toBe(2025)
		expect(d.getMonth()).toBe(5) // June is 5 (0-indexed)
		expect(d.getDate()).toBe(1)
		expect(d.getHours()).toBe(9)
		expect(d.getMinutes()).toBe(30)
		expect(d.getSeconds()).toBe(45)
	})

	it("defaults seconds to 0 when missing", () => {
		const m = helpers.matchFolder("2025-06-01_09-30")
		const d = helpers.extractDate(m)
		expect(d.getSeconds()).toBe(0)
	})
})

describe("groupBy", () => {
	it("groups items by key", () => {
		const items = [
			{ name: "a", group: 1 },
			{ name: "b", group: 2 },
			{ name: "c", group: 1 },
		]
		const result = helpers.groupBy(items, (x) => x.group)
		expect(result.get(1)).toHaveLength(2)
		expect(result.get(2)).toHaveLength(1)
	})

	it("returns an empty map for empty input", () => {
		const result = helpers.groupBy([], (x) => x)
		expect(result.size).toBe(0)
	})
})

describe("groupFiles", () => {
	it("groups clip files by timestamp and extracts camera info", () => {
		const files = [
			"2025-10-15_14-23-07-front.mp4",
			"2025-10-15_14-23-07-back.mp4",
			"2025-10-15_14-23-07-left_repeater.mp4",
			"not-a-clip.txt",
		]
		const result = helpers.groupFiles("SavedClips/foo", files, (p) => "videos/" + p)
		const groups = Array.from(result.values())
		expect(groups).toHaveLength(1)
		expect(groups[0]).toHaveLength(3)
		expect(groups[0].every((f) => f.file.startsWith("videos/SavedClips/foo/"))).toBe(true)
	})

	it("returns an empty map when no files match", () => {
		const result = helpers.groupFiles("SavedClips/foo", ["readme.txt"], (p) => p)
		expect(result.size).toBe(0)
	})

	it("handles null/undefined files gracefully", () => {
		const result = helpers.groupFiles("f", null, (p) => p)
		expect(result.size).toBe(0)
	})
})

describe("parseEventTimestamp", () => {
	it("parses Tesla event.json timestamp as local wall time", () => {
		const d = helpers.parseEventTimestamp("2026-03-23T17:49:47")
		expect(d).toBeInstanceOf(Date)
		expect(d.getFullYear()).toBe(2026)
		expect(d.getMonth()).toBe(2)
		expect(d.getDate()).toBe(23)
		expect(d.getHours()).toBe(17)
		expect(d.getMinutes()).toBe(49)
		expect(d.getSeconds()).toBe(47)
	})

	it("ignores trailing characters after seconds", () => {
		const d = helpers.parseEventTimestamp("2026-03-23T17:49:47.500Z")
		expect(d.getSeconds()).toBe(47)
	})

	it("returns null for non-matching input", () => {
		expect(helpers.parseEventTimestamp("not a date")).toBeNull()
		expect(helpers.parseEventTimestamp("")).toBeNull()
		expect(helpers.parseEventTimestamp(null)).toBeNull()
		expect(helpers.parseEventTimestamp(undefined)).toBeNull()
		expect(helpers.parseEventTimestamp(12345)).toBeNull()
	})
})

describe("humanizeReason", () => {
	it("replaces underscores with spaces and capitalizes the first letter", () => {
		expect(helpers.humanizeReason("sentry_aware_object_detection")).toBe("Sentry aware object detection")
		expect(helpers.humanizeReason("user_interaction_honk")).toBe("User interaction honk")
	})

	it("returns an empty string for null/empty input", () => {
		expect(helpers.humanizeReason(null)).toBe("")
		expect(helpers.humanizeReason(undefined)).toBe("")
		expect(helpers.humanizeReason("")).toBe("")
	})
})

describe("computeTriggerOffsetSeconds", () => {
	const sampleTimespans = [
		{ time: new Date(2026, 2, 23, 17, 48, 47), duration: 60.03 },
		{ time: new Date(2026, 2, 23, 17, 49, 47), duration: 59.45 },
	]

	it("returns the offset for the verified Sentry sample", () => {
		// Trigger 17:49:47 is the exact boundary between the two clips; it falls
		// inside the tail of clip 1 (which ends 30 ms later), so the offset is
		// 60 s — visually indistinguishable from 60.03 s on the scrubber.
		const trigger = new Date(2026, 2, 23, 17, 49, 47)
		const offset = helpers.computeTriggerOffsetSeconds(sampleTimespans, trigger)
		expect(offset).toBeCloseTo(60, 2)
	})

	it("returns the offset relative to the second timespan when trigger falls inside it", () => {
		const trigger = new Date(2026, 2, 23, 17, 50, 17) // 30 s into clip 2
		const offset = helpers.computeTriggerOffsetSeconds(sampleTimespans, trigger)
		expect(offset).toBeCloseTo(90.03, 2)
	})

	it("returns the offset within the first timespan", () => {
		const trigger = new Date(2026, 2, 23, 17, 49, 17) // 30 s into clip 1
		const offset = helpers.computeTriggerOffsetSeconds(sampleTimespans, trigger)
		expect(offset).toBeCloseTo(30, 2)
	})

	it("returns null when the trigger falls before the first timespan", () => {
		const trigger = new Date(2026, 2, 23, 17, 47, 0)
		expect(helpers.computeTriggerOffsetSeconds(sampleTimespans, trigger)).toBeNull()
	})

	it("returns null when the trigger falls after the last timespan", () => {
		const trigger = new Date(2026, 2, 23, 17, 51, 0)
		expect(helpers.computeTriggerOffsetSeconds(sampleTimespans, trigger)).toBeNull()
	})

	it("returns null for empty timespans", () => {
		expect(helpers.computeTriggerOffsetSeconds([], new Date())).toBeNull()
		expect(helpers.computeTriggerOffsetSeconds(null, new Date())).toBeNull()
	})

	it("returns null when a timespan has no usable duration", () => {
		const trigger = new Date(2026, 2, 23, 17, 49, 47)
		const broken = [{ time: new Date(2026, 2, 23, 17, 48, 47), duration: null }]
		expect(helpers.computeTriggerOffsetSeconds(broken, trigger)).toBeNull()
	})

	it("returns null for an invalid trigger date", () => {
		expect(helpers.computeTriggerOffsetSeconds(sampleTimespans, null)).toBeNull()
		expect(helpers.computeTriggerOffsetSeconds(sampleTimespans, new Date("invalid"))).toBeNull()
	})
})
