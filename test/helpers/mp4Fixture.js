import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import protobuf from "protobufjs"

// Builders for synthetic MP4 files whose byte layout matches the scanners in
// src/server/seiTelemetry.js (findMdat, parseMdatNals, extractProtoPayload,
// readAtoms, parseMdhdTimescale, isVideoTrak, parseStts).

const PROTO_PATH = fileURLToPath(new URL("../../src/server/dashcam.proto", import.meta.url))
let seiMetadataPromise = null

function loadSeiMetadata() {
	if (!seiMetadataPromise) {
		seiMetadataPromise = protobuf.load(PROTO_PATH).then((root) => root.lookupType("SeiMetadata"))
	}
	return seiMetadataPromise
}

/** Encode SeiMetadata fields (camelCase, e.g. gearState, vehicleSpeedMps) to wire bytes. */
export async function encodeSei(fields) {
	const SeiMetadata = await loadSeiMetadata()
	return Buffer.from(SeiMetadata.encode(SeiMetadata.create(fields)).finish())
}

/** Standard 32-bit-size MP4 atom: [u32 size][4cc type][body]. */
export function atom(type, body = Buffer.alloc(0)) {
	const header = Buffer.alloc(8)
	header.writeUInt32BE(8 + body.length, 0)
	header.write(type, 4, "ascii")
	return Buffer.concat([header, body])
}

/** 64-bit-size MP4 atom: size32=1 marker plus a u64 size field. */
export function largeAtom(type, body = Buffer.alloc(0)) {
	const header = Buffer.alloc(16)
	header.writeUInt32BE(1, 0)
	header.write(type, 4, "ascii")
	header.writeBigUInt64BE(BigInt(16 + body.length), 8)
	return Buffer.concat([header, body])
}

/**
 * H.264 emulation prevention: after two emitted zero bytes, escape a following
 * 0x00-0x03 with an extra 0x03. Exact inverse of stripEmulationPrevention.
 */
export function epEncode(buf) {
	const out = []
	let zeroCount = 0

	for (const byte of buf) {
		if (zeroCount >= 2 && byte <= 0x03) {
			out.push(0x03)
			zeroCount = 0
		}
		out.push(byte)
		zeroCount = byte === 0 ? zeroCount + 1 : 0
	}

	return Buffer.from(out)
}

/**
 * AVC SEI user_data_unregistered NAL the way Tesla emits it: NAL header 0x06,
 * payloadType 5, a size byte the parser skips, a 16-byte 0x42 UUID, the 0x69
 * marker, the EP-escaped protobuf payload, and the RBSP stop byte.
 */
export function buildSeiNal(protoBytes) {
	return Buffer.concat([
		Buffer.from([0x06, 0x05, 0xff]),
		Buffer.alloc(16, 0x42),
		Buffer.from([0x69]),
		epEncode(protoBytes),
		Buffer.from([0x80]),
	])
}

/** Minimal coded-slice NAL (type 5); advances the parser's video frame index. */
export function videoNal() {
	return Buffer.from([0x65, 0x88, 0x84])
}

/** mdat framing: NALs are prefixed with their u32 byte length. */
export function lengthPrefixed(nal) {
	const prefix = Buffer.alloc(4)
	prefix.writeUInt32BE(nal.length, 0)
	return Buffer.concat([prefix, nal])
}

/**
 * moov/trak/mdia(mdhd + hdlr"vide" + minf/stbl/stts) carrying just enough for
 * getVideoFrameStartTimesSec: a timescale and per-frame stts deltas.
 */
export function buildMoov({ timescale, deltas }) {
	const mdhdBody = Buffer.alloc(20)
	mdhdBody.writeUInt32BE(timescale, 12)

	const hdlrBody = Buffer.alloc(16)
	hdlrBody.write("vide", 8, "ascii")

	const sttsBody = Buffer.alloc(8 + deltas.length * 8)
	sttsBody.writeUInt32BE(deltas.length, 4)
	deltas.forEach((delta, i) => {
		sttsBody.writeUInt32BE(1, 8 + i * 8)
		sttsBody.writeUInt32BE(delta, 12 + i * 8)
	})

	const stbl = atom("stbl", atom("stts", sttsBody))
	const minf = atom("minf", stbl)
	const mdia = atom("mdia", Buffer.concat([atom("mdhd", mdhdBody), atom("hdlr", hdlrBody), minf]))
	return atom("moov", atom("trak", mdia))
}

export async function writeTmpMp4(dir, name, ...buffers) {
	const fullPath = path.join(dir, name)
	await fs.promises.writeFile(fullPath, Buffer.concat(buffers))
	return fullPath
}
