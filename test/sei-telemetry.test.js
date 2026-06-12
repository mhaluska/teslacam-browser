import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import seiTelemetry from "../src/server/seiTelemetry.js"
import { atom, buildMoov, buildSeiNal, encodeSei, epEncode, largeAtom, lengthPrefixed, videoNal, writeTmpMp4 } from "./helpers/mp4Fixture.js"

const SAMPLE_0 = {
	gearState: 1, // GEAR_DRIVE
	frameSeqNo: 1001,
	vehicleSpeedMps: 12.5,
	acceleratorPedalPosition: 55, // percent scale, normalized to 0.55
	blinkerOnLeft: true,
	brakeApplied: true,
	autopilotState: 2, // AUTOSTEER
	latitudeDeg: 48.15,
	longitudeDeg: 17.11,
	headingDeg: 90,
}
const SAMPLE_1 = { gearState: 2, frameSeqNo: 1002, vehicleSpeedMps: 0.25 }

let dir

beforeAll(async () => {
	dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "teslacam-sei-"))
})

afterAll(async () => {
	await fs.promises.rm(dir, { recursive: true, force: true })
})

async function mdatWithNals(...nals) {
	return atom("mdat", Buffer.concat(nals.map(lengthPrefixed)))
}

describe("extractSamplesFromFile", () => {
	it("decodes SEI samples and maps them onto stts frame times", async () => {
		const mdat = await mdatWithNals(buildSeiNal(await encodeSei(SAMPLE_0)), videoNal(), buildSeiNal(await encodeSei(SAMPLE_1)), videoNal())
		const file = await writeTmpMp4(dir, "happy.mp4", mdat, buildMoov({ timescale: 1000, deltas: [500, 500] }))

		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(2)

		const [s0, s1] = samples
		expect(s0).toMatchObject({
			gear: "D",
			frameSeqNo: "1001",
			speedMps: 12.5,
			acceleratorPedal: 0.55,
			blinkerLeft: true,
			blinkerRight: false,
			brakeApplied: true,
			autopilot: "AUTOSTEER",
			headingDeg: 90,
			frameIdx: 0,
			tSec: 0,
		})
		expect(s0.latitudeDeg).toBeCloseTo(48.15, 10)
		expect(s0.longitudeDeg).toBeCloseTo(17.11, 10)

		expect(s1).toMatchObject({ gear: "R", frameSeqNo: "1002", autopilot: "NONE", frameIdx: 1, tSec: 0.5 })
		expect(s1.speedMps).toBeCloseTo(0.25, 6)
		// proto3 scalars default to 0 when absent, so unset coordinates decode as 0.
		expect(s1.latitudeDeg).toBe(0)
	})

	it("round-trips payloads through emulation-prevention stripping", async () => {
		// latitude 2.0 encodes as fixed64 with a run of six zero bytes, forcing
		// epEncode to insert 0x03 escapes that the parser must strip again.
		const proto = await encodeSei({ latitudeDeg: 2.0, gearState: 1 })
		expect(epEncode(proto).length).toBeGreaterThan(proto.length)

		const file = await writeTmpMp4(dir, "ep.mp4", await mdatWithNals(buildSeiNal(proto), videoNal()))
		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
		expect(samples[0].latitudeDeg).toBe(2.0)
		expect(samples[0].gear).toBe("D")
	})

	it("flushes a trailing SEI that has no following video frame", async () => {
		const file = await writeTmpMp4(dir, "trailing.mp4", await mdatWithNals(buildSeiNal(await encodeSei(SAMPLE_0))))
		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
		expect(samples[0].frameIdx).toBe(0)
	})

	it("returns samples without tSec when there is no moov", async () => {
		const file = await writeTmpMp4(dir, "no-moov.mp4", await mdatWithNals(buildSeiNal(await encodeSei(SAMPLE_0)), videoNal()))
		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
		expect(samples[0].tSec).toBeUndefined()
	})

	it("supports 64-bit mdat atom sizes", async () => {
		const body = Buffer.concat([lengthPrefixed(buildSeiNal(await encodeSei(SAMPLE_0))), lengthPrefixed(videoNal())])
		const file = await writeTmpMp4(dir, "large-mdat.mp4", largeAtom("mdat", body), buildMoov({ timescale: 1000, deltas: [500] }))

		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
		expect(samples[0].tSec).toBe(0)
	})

	it("ignores other NAL types and sub-2-byte NAL stubs", async () => {
		const aud = Buffer.from([0x09, 0x10])
		const stub = Buffer.from([0x01])
		const file = await writeTmpMp4(dir, "mixed-nals.mp4", await mdatWithNals(aud, stub, buildSeiNal(await encodeSei(SAMPLE_0)), videoNal(), aud))

		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
		expect(samples[0].frameIdx).toBe(0)
	})
})

describe("malformed input", () => {
	it("rejects files with no mdat atom", async () => {
		const file = await writeTmpMp4(dir, "garbage.mp4", Buffer.alloc(64, 0xff))
		await expect(seiTelemetry.extractSamplesFromFile(file)).rejects.toThrow("mdat atom not found")
	})

	it("rejects atoms whose size is smaller than their header", async () => {
		const broken = Buffer.alloc(16)
		broken.writeUInt32BE(4, 0)
		broken.write("free", 4, "ascii")
		const file = await writeTmpMp4(dir, "tiny-atom.mp4", broken)
		await expect(seiTelemetry.extractSamplesFromFile(file)).rejects.toThrow("invalid MP4 atom size")
	})

	it("keeps complete samples when the mdat ends mid-NAL", async () => {
		const truncatedTail = Buffer.from([0x00, 0x00, 0x01, 0x00, 0xaa]) // claims 256 bytes, provides 1
		const body = Buffer.concat([
			lengthPrefixed(buildSeiNal(await encodeSei(SAMPLE_0))),
			lengthPrefixed(videoNal()),
			truncatedTail,
		])
		const file = await writeTmpMp4(dir, "truncated-nal.mp4", atom("mdat", body))

		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
	})

	it("does not hang when the mdat size claims more bytes than the file has", async () => {
		const nals = Buffer.concat([lengthPrefixed(buildSeiNal(await encodeSei(SAMPLE_0))), lengthPrefixed(videoNal())])
		const header = Buffer.alloc(8)
		header.writeUInt32BE(8 + nals.length + 100_000, 0)
		header.write("mdat", 4, "ascii")
		const file = await writeTmpMp4(dir, "truncated-file.mp4", header, nals)

		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
	})

	it("resyncs over oversized atoms inside moov and just skips frame times", async () => {
		const bogusTrak = Buffer.alloc(12)
		bogusTrak.writeUInt32BE(1_000_000, 0) // claims to extend far past the moov body
		bogusTrak.write("trak", 4, "ascii")

		const file = await writeTmpMp4(
			dir,
			"bad-moov.mp4",
			await mdatWithNals(buildSeiNal(await encodeSei(SAMPLE_0)), videoNal()),
			atom("moov", bogusTrak),
		)

		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
		expect(samples[0].tSec).toBeUndefined()
	})

	it("skips SEI payloads that are not valid protobuf", async () => {
		const bogusSei = buildSeiNal(Buffer.from([0xff, 0xff, 0xff]))
		const file = await writeTmpMp4(dir, "bad-proto.mp4", await mdatWithNals(bogusSei, videoNal(), buildSeiNal(await encodeSei(SAMPLE_1)), videoNal()))

		const samples = await seiTelemetry.extractSamplesFromFile(file)
		expect(samples).toHaveLength(1)
		expect(samples[0].frameSeqNo).toBe("1002")
	})
})

describe("normalizeAcceleratorPedal", () => {
	const { normalizeAcceleratorPedal } = seiTelemetry

	it("passes through the 0-1 ratio scale", () => {
		expect(normalizeAcceleratorPedal(0)).toBe(0)
		expect(normalizeAcceleratorPedal(0.5)).toBe(0.5)
		expect(normalizeAcceleratorPedal(1)).toBe(1)
	})

	it("converts the 0-100 percent scale and clamps outliers", () => {
		expect(normalizeAcceleratorPedal(55)).toBe(0.55)
		expect(normalizeAcceleratorPedal(100)).toBe(1)
		expect(normalizeAcceleratorPedal(150)).toBe(1)
		expect(normalizeAcceleratorPedal(-3)).toBe(0)
	})

	it("returns null for non-finite or non-numeric input", () => {
		expect(normalizeAcceleratorPedal(Number.NaN)).toBeNull()
		expect(normalizeAcceleratorPedal(Number.POSITIVE_INFINITY)).toBeNull()
		expect(normalizeAcceleratorPedal("55")).toBeNull()
		expect(normalizeAcceleratorPedal(null)).toBeNull()
	})
})
