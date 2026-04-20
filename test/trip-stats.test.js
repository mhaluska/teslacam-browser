import { describe, it, expect } from "vitest"
import uiUtils from "../src/renderer/ui-utils.js"

const { computeTripStats, haversineMeters } = uiUtils
const G = 9.80665

describe("haversineMeters", () => {
	it("returns 0 for identical points", () => {
		expect(haversineMeters(50, 14, 50, 14)).toBe(0)
	})

	it("matches a known 1-degree-latitude distance within 0.5%", () => {
		const d = haversineMeters(50, 14, 51, 14)
		// 1 degree of latitude ≈ 111,195 m
		expect(d).toBeGreaterThan(110_500)
		expect(d).toBeLessThan(111_700)
	})
})

describe("computeTripStats", () => {
	it("returns zeroed result for empty input", () => {
		const r = computeTripStats([])
		expect(r.count).toBe(0)
		expect(r.minSpeedMps).toBeNull()
		expect(r.distanceMeters).toBeNull()
		expect(r.autopilotPct).toBeNull()
	})

	it("computes min/max/avg speed from tSec-spaced samples", () => {
		const samples = [
			{ tSec: 0, speedMps: 10 },
			{ tSec: 1, speedMps: 20 },
			{ tSec: 2, speedMps: 30 }
		]
		const r = computeTripStats(samples)
		expect(r.count).toBe(3)
		expect(r.minSpeedMps).toBe(10)
		expect(r.maxSpeedMps).toBe(30)
		// Time-weighted average across two 1s windows at 20 and 30 m/s → 25
		expect(r.avgSpeedMps).toBeCloseTo(25, 5)
		expect(r.durationSec).toBe(2)
	})

	it("integrates GPS distance via haversine", () => {
		const samples = [
			{ tSec: 0, latitudeDeg: 50, longitudeDeg: 14 },
			{ tSec: 1, latitudeDeg: 50.001, longitudeDeg: 14 },
			{ tSec: 2, latitudeDeg: 50.002, longitudeDeg: 14 }
		]
		const r = computeTripStats(samples)
		// Two 0.001° steps ≈ 2 × 111.2 m = ~222 m
		expect(r.distanceMeters).toBeGreaterThan(220)
		expect(r.distanceMeters).toBeLessThan(225)
	})

	it("ignores (0,0) GPS as invalid placeholder", () => {
		const samples = [
			{ tSec: 0, latitudeDeg: 0, longitudeDeg: 0 },
			{ tSec: 1, latitudeDeg: 50, longitudeDeg: 14 },
			{ tSec: 2, latitudeDeg: 50.001, longitudeDeg: 14 }
		]
		const r = computeTripStats(samples)
		// Only the second step (50→50.001) should be counted.
		expect(r.distanceMeters).toBeGreaterThan(100)
		expect(r.distanceMeters).toBeLessThan(115)
	})

	it("reports max lateral G in g-units, not m/s²", () => {
		const samples = [
			{ tSec: 0, accelY: 0 },
			{ tSec: 1, accelY: -0.5 * G },
			{ tSec: 2, accelY: 0.8 * G }
		]
		const r = computeTripStats(samples)
		expect(r.maxLateralG).toBeCloseTo(0.8, 2)
	})

	it("computes autopilot percentage from non-NONE values", () => {
		const samples = [
			{ tSec: 0, autopilot: "NONE" },
			{ tSec: 1, autopilot: "TACC" },
			{ tSec: 2, autopilot: "AUTOSTEER" },
			{ tSec: 3, autopilot: "NONE" }
		]
		const r = computeTripStats(samples)
		expect(r.autopilotPct).toBeCloseTo(0.5, 5)
	})

	it("returns null metrics when source data is missing", () => {
		const r = computeTripStats([
			{ tSec: 0 },
			{ tSec: 1 }
		])
		expect(r.minSpeedMps).toBeNull()
		expect(r.avgSpeedMps).toBeNull()
		expect(r.distanceMeters).toBeNull()
		expect(r.maxLateralG).toBeNull()
		expect(r.autopilotPct).toBeNull()
		expect(r.durationSec).toBe(1)
	})
})
