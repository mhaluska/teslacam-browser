import { describe, it, expect } from "vitest"
import uiUtils from "../src/renderer/ui-utils.js"

const { computeDashView } = uiUtils
const G = 9.80665

describe("computeDashView", () => {
	it("converts speed to km/h by default and mph for 'mi'", () => {
		expect(computeDashView({ speedMps: 20 }, "km").speed).toEqual({ value: 72, unit: "km/h" })
		expect(computeDashView({ speedMps: 20 }, "mi").speed).toEqual({ value: 45, unit: "mph" })
	})

	it("shows a dash when speed is unknown or there is no sample", () => {
		expect(computeDashView({ speedMps: null }, "km").speed).toEqual({ value: "—", unit: "km/h" })
		expect(computeDashView(null, "mi").speed).toEqual({ value: "—", unit: "mph" })
	})

	it("clamps the throttle to 0..100 %", () => {
		expect(computeDashView({ acceleratorPedal: 0.456 }, "km").throttlePct).toBe(46)
		expect(computeDashView({ acceleratorPedal: 1.7 }, "km").throttlePct).toBe(100)
		expect(computeDashView({ acceleratorPedal: -0.2 }, "km").throttlePct).toBe(0)
		expect(computeDashView({}, "km").throttlePct).toBe(0)
	})

	it("places the G-meter dot opposite the felt force", () => {
		// Accelerating forward (accelY negative) pushes the dot down.
		const g = computeDashView({ accelX: 0, accelY: -0.5 * G }, "km").gMeter
		expect(g.visible).toBe(true)
		expect(g.clipped).toBe(false)
		expect(g.x).toBeCloseTo(0)
		expect(g.y).toBeCloseTo(0.5)
	})

	it("clamps the G-meter dot to 1.2 g", () => {
		const g = computeDashView({ accelX: 3 * G, accelY: 0 }, "km").gMeter
		expect(g.clipped).toBe(true)
		expect(Math.hypot(g.x, g.y)).toBeCloseTo(1.2)
		expect(g.title).toBe("G: 3.00g")
	})

	it("hides the G-meter without accelerometer data", () => {
		expect(computeDashView({ accelX: 1 }, "km").gMeter.visible).toBe(false)
	})

	it("derives indicator flags", () => {
		const v = computeDashView(
			{ gear: "D", brakeApplied: true, blinkerLeft: true, autopilot: "AUTOSTEER", steeringWheelAngle: -12, headingDeg: 90 },
			"km",
		)
		expect(v).toMatchObject({
			gear: "D",
			brake: true,
			blinkerLeft: true,
			blinkerRight: false,
			autopilotOn: true,
			wheelAngle: -12,
			headingDeg: 90,
		})
		expect(computeDashView({ autopilot: "NONE" }, "km").autopilotOn).toBe(false)
	})
})
