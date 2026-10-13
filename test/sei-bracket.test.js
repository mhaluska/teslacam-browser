import { describe, it, expect } from "vitest"
import uiUtils from "../src/renderer/ui-utils.js"

const { pickSeiInterpolationBracket } = uiUtils

const timed = times => times.map((tSec, i) => ({ tSec, i }))

describe("pickSeiInterpolationBracket", () => {
	it("blends between the two samples around the time", () => {
		const br = pickSeiInterpolationBracket(timed([0, 0.1, 0.2]), 0.15, 0.2)
		expect(br.cur.i).toBe(1)
		expect(br.next.i).toBe(2)
		expect(br.alpha).toBeCloseTo(0.5)
	})

	it("returns nothing before SEI starts (parked car records the clip start without SEI)", () => {
		const samples = timed([45.7, 45.8, 45.9])
		expect(pickSeiInterpolationBracket(samples, 0, 60)).toBeNull()
		expect(pickSeiInterpolationBracket(samples, 45, 60)).toBeNull()
		expect(pickSeiInterpolationBracket(samples, 45.4, 60).cur.i).toBe(0)
	})

	it("returns nothing after SEI ends", () => {
		const samples = timed([0, 0.1, 0.2])
		expect(pickSeiInterpolationBracket(samples, 0.6, 60).cur.i).toBe(2)
		expect(pickSeiInterpolationBracket(samples, 5, 60)).toBeNull()
	})

	it("returns nothing inside a hole in the SEI stream but holds near its edges", () => {
		const samples = timed([0, 0.1, 10, 10.1])
		expect(pickSeiInterpolationBracket(samples, 5, 11)).toBeNull()
		expect(pickSeiInterpolationBracket(samples, 0.4, 11).cur.i).toBe(1)
		expect(pickSeiInterpolationBracket(samples, 9.7, 11).cur.i).toBe(1)
	})

	it("handles a single timed sample", () => {
		const samples = timed([3])
		expect(pickSeiInterpolationBracket(samples, 3.2, 10).cur.i).toBe(0)
		expect(pickSeiInterpolationBracket(samples, 0, 10)).toBeNull()
	})

	it("spreads untimed samples over the duration", () => {
		const samples = [{ i: 0 }, { i: 1 }, { i: 2 }]
		expect(pickSeiInterpolationBracket(samples, 5, 10).cur.i).toBe(1)
		expect(pickSeiInterpolationBracket([], 5, 10)).toBeNull()
	})
})
