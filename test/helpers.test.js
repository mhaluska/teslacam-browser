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
