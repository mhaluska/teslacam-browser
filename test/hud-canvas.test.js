import { describe, it, expect } from "vitest"
import uiHudCanvas from "../src/renderer/ui-hud-canvas.js"
import uiUtils from "../src/renderer/ui-utils.js"

const { drawDashHud, isBlinkVisible } = uiHudCanvas
const { computeDashView } = uiUtils

// Records every method call and property write so tests can inspect what was drawn.
function makeCtx() {
	const calls = []
	const state = {}
	const methods = [
		"save", "restore", "translate", "scale", "rotate", "beginPath", "closePath", "moveTo", "lineTo",
		"arc", "arcTo", "fill", "stroke", "fillRect", "fillText", "clip",
	]
	const ctx = new Proxy(state, {
		get(target, prop) {
			if (prop === "calls") return calls
			if (prop === "measureText") return text => ({ width: String(text).length * 10 })
			if (prop === "createLinearGradient") return () => ({ addColorStop: () => undefined })
			if (methods.includes(prop)) return (...args) => calls.push({ fn: prop, args, fillStyle: target.fillStyle })
			return target[prop]
		},
		set(target, prop, value) {
			target[prop] = value
			return true
		},
	})
	return ctx
}

const FULL = {
	gear: "D",
	speedMps: 70 / 3.6,
	acceleratorPedal: 0.4,
	blinkerLeft: true,
	blinkerRight: false,
	brakeApplied: false,
	autopilot: "AUTOSTEER",
	steeringWheelAngle: 15,
	accelX: 1,
	accelY: -2,
	headingDeg: 200,
}

const texts = ctx => ctx.calls.filter(c => c.fn === "fillText").map(c => c.args[0])
const opts = { width: 1448, height: 938, videoTime: 0 }

describe("drawDashHud", () => {
	it("draws nothing without a view", () => {
		const ctx = makeCtx()
		drawDashHud(ctx, null, opts)
		expect(ctx.calls).toHaveLength(0)
	})

	it("draws gear, speed, unit and compass letters for full telemetry", () => {
		const ctx = makeCtx()
		drawDashHud(ctx, computeDashView(FULL, "km"), opts)
		expect(texts(ctx)).toEqual(expect.arrayContaining(["D", "70", "km/h", "N", "E", "S", "W"]))
		const saves = ctx.calls.filter(c => c.fn === "save").length
		const restores = ctx.calls.filter(c => c.fn === "restore").length
		expect(saves).toBe(restores)
	})

	it("skips compass and G-meter when heading and accel are missing", () => {
		const ctx = makeCtx()
		drawDashHud(ctx, computeDashView({ gear: "P" }, "mi"), opts)
		const t = texts(ctx)
		expect(t).toEqual(expect.arrayContaining(["P", "—", "mph"]))
		expect(t).not.toContain("N")
	})

	it("keeps the panel inside the frame", () => {
		const ctx = makeCtx()
		drawDashHud(ctx, computeDashView(FULL, "km"), { width: 640, height: 400, videoTime: 0 })
		const xs = ctx.calls.filter(c => c.fn === "moveTo").slice(0, 1).map(c => c.args[0])
		expect(xs[0]).toBeGreaterThanOrEqual(0)
		expect(xs[0]).toBeLessThan(640)
	})

	it("hides an active blinker during the off half of the blink period", () => {
		const view = computeDashView(FULL, "km")
		const on = makeCtx()
		const off = makeCtx()
		drawDashHud(on, view, { ...opts, videoTime: 0.1 })
		drawDashHud(off, view, { ...opts, videoTime: 0.4 })
		const green = ctx => ctx.calls.filter(c => c.fn === "fill" && c.fillStyle === "#4ade80").length
		expect(green(on)).toBe(1)
		expect(green(off)).toBe(0)
	})
})

describe("isBlinkVisible", () => {
	it("toggles every 0.3 s", () => {
		expect(isBlinkVisible(0)).toBe(true)
		expect(isBlinkVisible(0.29)).toBe(true)
		expect(isBlinkVisible(0.31)).toBe(false)
		expect(isBlinkVisible(0.61)).toBe(true)
		expect(isBlinkVisible(Number.NaN)).toBe(true)
	})
})
