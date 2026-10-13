import { describe, it, expect } from "vitest"
import uiUtils from "../src/renderer/ui-utils.js"

const { stabilizeBlinkers } = uiUtils

// One sample every 0.1 s; `pattern` is a string of L/R/B/- per sample.
function samplesFrom(pattern, step = 0.1) {
	return [...pattern].map((c, i) => ({
		tSec: i * step,
		blinkerLeft: c === "L" || c === "B",
		blinkerRight: c === "R" || c === "B",
	}))
}

const left = s => s.map(x => (x.blinkerLeft ? "1" : "0")).join("")
const right = s => s.map(x => (x.blinkerRight ? "1" : "0")).join("")

describe("stabilizeBlinkers", () => {
	it("fills a short gap between lamp flashes", () => {
		const out = stabilizeBlinkers(samplesFrom("-LLL----LLL-"))
		expect(left(out)).toBe("011111111110")
	})

	it("keeps a gap of a second or more", () => {
		const out = stabilizeBlinkers(samplesFrom("L" + "-".repeat(11) + "L"))
		expect(left(out)).toBe("1" + "0".repeat(11) + "1")
	})

	it("treats left and right independently", () => {
		const out = stabilizeBlinkers(samplesFrom("L--L-R--R"))
		expect(left(out)).toBe("111100000")
		expect(right(out)).toBe("000001111")
	})

	it("aligns hazard flags that dropped out on one side", () => {
		const out = stabilizeBlinkers(samplesFrom("BB-LB--RB"))
		expect(left(out)).toBe("111111111")
		expect(right(out)).toBe("111111111")
	})

	it("leaves samples without tSec untouched and does not mutate the input", () => {
		const input = [{ blinkerLeft: true }, { blinkerLeft: false }, { blinkerLeft: true }]
		const out = stabilizeBlinkers(input)
		expect(out.map(x => x.blinkerLeft)).toEqual([true, false, true])
		const timed = samplesFrom("L-L")
		stabilizeBlinkers(timed)
		expect(timed[1].blinkerLeft).toBe(false)
	})
})
