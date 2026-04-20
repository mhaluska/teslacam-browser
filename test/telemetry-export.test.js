import { describe, it, expect } from "vitest"
import uiUtils from "../src/renderer/ui-utils.js"

const { buildTelemetryCsv, buildTelemetryGpx, CSV_COLUMNS } = uiUtils

const base = new Date("2025-10-15T14:23:07.000Z")

const SAMPLES = [
	{
		tSec: 0,
		latitudeDeg: 50.1,
		longitudeDeg: 14.4,
		speedMps: 10,
		headingDeg: 90,
		steeringWheelAngle: -3.5,
		acceleratorPedal: 0.25,
		brakeApplied: false,
		accelX: 1.2, accelY: 0.1, accelZ: 9.8,
		gear: "D",
		autopilot: "NONE",
		blinkerLeft: false,
		blinkerRight: true,
		frameSeqNo: "12345"
	},
	{
		tSec: 1,
		latitudeDeg: 50.101,
		longitudeDeg: 14.4,
		speedMps: 11,
		headingDeg: 91,
		steeringWheelAngle: -4.0,
		acceleratorPedal: 0.3,
		brakeApplied: true,
		accelX: -2.0, accelY: 0.2, accelZ: 9.8,
		gear: "D",
		autopilot: "TACC",
		blinkerLeft: false,
		blinkerRight: false,
		frameSeqNo: "12346"
	}
]

describe("buildTelemetryCsv", () => {
	it("emits a header row with all expected columns", () => {
		const csv = buildTelemetryCsv([], base)
		expect(csv.split("\n")[0]).toBe(CSV_COLUMNS.join(","))
	})

	it("writes one row per sample + trailing newline", () => {
		const csv = buildTelemetryCsv(SAMPLES, base)
		const lines = csv.split("\n")
		expect(lines[0]).toBe(CSV_COLUMNS.join(","))
		expect(lines.length).toBe(4) // header + 2 samples + trailing empty
		expect(lines[lines.length - 1]).toBe("")
	})

	it("converts m/s to km/h on the speedKph column", () => {
		const csv = buildTelemetryCsv(SAMPLES, base)
		const row1 = csv.split("\n")[1].split(",")
		const kphIdx = CSV_COLUMNS.indexOf("speedKph")
		expect(parseFloat(row1[kphIdx])).toBeCloseTo(36, 2)
	})

	it("renders isoTime from baseTime + tSec", () => {
		const csv = buildTelemetryCsv(SAMPLES, base)
		const row2 = csv.split("\n")[2].split(",")
		const isoIdx = CSV_COLUMNS.indexOf("isoTime")
		// Sample at tSec=1 → 1s after base
		expect(row2[isoIdx]).toBe("2025-10-15T14:23:08.000Z")
	})

	it("escapes string fields containing commas", () => {
		const csv = buildTelemetryCsv(
			[{ tSec: 0, gear: "D,R", frameSeqNo: "1" }],
			base
		)
		expect(csv).toContain('"D,R"')
	})

	it("leaves numeric fields blank when source is missing", () => {
		const csv = buildTelemetryCsv([{ tSec: 0 }], base)
		const row = csv.split("\n")[1]
		const cells = row.split(",")
		const latIdx = CSV_COLUMNS.indexOf("latitudeDeg")
		expect(cells[latIdx]).toBe("")
	})
})

describe("buildTelemetryGpx", () => {
	it("emits a valid GPX 1.1 preamble and gpxtpx namespace", () => {
		const gpx = buildTelemetryGpx(SAMPLES, base)
		expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
		expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"')
		expect(gpx).toContain("xmlns:gpxtpx=")
	})

	it("writes one <trkpt> per GPS sample", () => {
		const gpx = buildTelemetryGpx(SAMPLES, base)
		const count = (gpx.match(/<trkpt /g) || []).length
		expect(count).toBe(2)
	})

	it("skips (0,0) placeholder samples", () => {
		const gpx = buildTelemetryGpx(
			[
				{ tSec: 0, latitudeDeg: 0, longitudeDeg: 0, speedMps: 1 },
				{ tSec: 1, latitudeDeg: 50, longitudeDeg: 14, speedMps: 2 }
			],
			base
		)
		const count = (gpx.match(/<trkpt /g) || []).length
		expect(count).toBe(1)
	})

	it("embeds speed m/s in gpxtpx extension", () => {
		const gpx = buildTelemetryGpx(SAMPLES, base)
		expect(gpx).toContain("<gpxtpx:speed>10.000</gpxtpx:speed>")
	})

	it("escapes XML-special characters in the track name", () => {
		const gpx = buildTelemetryGpx(SAMPLES, base, { name: "Clip <A> & B" })
		expect(gpx).toContain("Clip &lt;A&gt; &amp; B")
	})
})
