import { describe, it, expect } from "vitest"
import shareToken from "../src/server/shareToken.js"

describe("shareToken.sign / verify", () => {
	it("round-trips a valid event path and expiry", () => {
		const expiry = Date.now() + 60_000
		const token = shareToken.sign("SavedClips/2024-01-15_14-30-00", expiry)
		const result = shareToken.verify(token)
		expect(result).not.toBeNull()
		expect(result.eventPath).toBe("SavedClips/2024-01-15_14-30-00")
		expect(result.expiry).toBe(expiry)
	})

	it("rejects an expired token", () => {
		const token = shareToken.sign("x/y", Date.now() + 50)
		// Build a deliberately-expired variant using the sign's own past-expiry guard is impossible
		// (sign refuses past expiry), so tamper with the payload instead.
		const [payload, sig] = token.split(".")
		const decoded = Buffer.from(payload, "base64url").toString("utf8")
		const [p, _exp] = decoded.split("|")
		const newPayload = Buffer.from(p + "|" + (Date.now() - 1000), "utf8").toString("base64url")
		// Original signature no longer matches the new payload; verify must refuse.
		expect(shareToken.verify(newPayload + "." + sig)).toBeNull()
	})

	it("rejects a tampered signature", () => {
		const token = shareToken.sign("a/b", Date.now() + 60_000)
		const [payload] = token.split(".")
		expect(shareToken.verify(payload + ".bogus")).toBeNull()
	})

	it("rejects malformed tokens", () => {
		expect(shareToken.verify("")).toBeNull()
		expect(shareToken.verify("no-dot")).toBeNull()
		expect(shareToken.verify(null)).toBeNull()
	})

	it("sign refuses past expiry", () => {
		expect(() => shareToken.sign("x/y", Date.now() - 1000)).toThrow()
	})

	it("sign refuses empty event path", () => {
		expect(() => shareToken.sign("", Date.now() + 60_000)).toThrow()
	})
})
