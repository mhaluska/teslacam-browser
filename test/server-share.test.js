import crypto from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	EVENT_A,
	EVENT_A_FILES,
	EVENT_B,
	EVENT_B_FILES,
	EVENT_REASON,
	bootServices,
	jsonPost,
	makeFixtureRoot,
	removeFixtureRoot,
	startServer,
	stopServer,
} from "./helpers/server.js"

const SHARE_SECRET = "f".repeat(64)

// Same scheme as src/server/shareToken.js sign(), but without its
// expiry-in-the-future guard, so tests can mint already-expired tokens.
function mintToken(eventPath, expiryMs) {
	const payload = Buffer.from(`${eventPath}|${Math.floor(expiryMs)}`, "utf8").toString("base64url")
	const hmac = crypto.createHmac("sha256", SHARE_SECRET).update(payload).digest("base64url")
	return `${payload}.${hmac}`
}

let server
let base
let root
let token

beforeAll(async () => {
	const services = await bootServices({ TC_SHARE_ENABLED: "true", TC_SHARE_SECRET: SHARE_SECRET })
	root = await makeFixtureRoot()
	services.setFolder(root)
	;({ server, base } = await startServer(services))

	// Auth is disabled, so requireCsrf must no-op on /shareLink too.
	const res = await jsonPost(base, "/shareLink", { eventPath: EVENT_A, ttlHours: 1 })
	expect(res.status).toBe(200)

	const body = await res.json()
	expect(body.path).toBe(`/share/${body.token}`)
	expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
	token = body.token
})

afterAll(async () => {
	await stopServer(server)
	await removeFixtureRoot(root)
})

describe("POST /shareLink validation", () => {
	it("rejects invalid ttlHours", async () => {
		for (const ttlHours of [0, -1, 721, "1", null]) {
			const res = await jsonPost(base, "/shareLink", { eventPath: EVENT_A, ttlHours })
			expect(res.status).toBe(400)
			expect(await res.json()).toEqual({ error: "invalid_ttl" })
		}
	})

	it("rejects a missing or traversing eventPath", async () => {
		for (const eventPath of [undefined, "", "../outside"]) {
			const res = await jsonPost(base, "/shareLink", { eventPath, ttlHours: 1 })
			expect(res.status).toBe(400)
			expect(await res.json()).toEqual({ error: "invalid_event_path" })
		}
	})
})

describe("GET /share/:token", () => {
	it("serves the share page for a valid token", async () => {
		const res = await fetch(`${base}/share/${token}`)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/html")
	})

	it("rejects a tampered signature with 410", async () => {
		const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")
		expect((await fetch(`${base}/share/${tampered}`)).status).toBe(410)
	})

	it("rejects an expired token with 410", async () => {
		const expired = mintToken(EVENT_A, Date.now() - 10_000)
		expect((await fetch(`${base}/share/${expired}`)).status).toBe(410)
	})
})

describe("share subpath routes", () => {
	it("lists files with /share-prefixed video paths", async () => {
		const res = await fetch(`${base}/share/${token}/files`)
		expect(res.status).toBe(200)

		const groups = await res.json()
		const files = groups.flatMap(([, infos]) => infos)
		expect(files).toHaveLength(EVENT_A_FILES.length)
		for (const file of files) {
			expect(file.file).toMatch(new RegExp(`^/share/${token}/videos/${EVENT_A}/`))
		}
	})

	it("returns the event.json of the shared event", async () => {
		const res = await fetch(`${base}/share/${token}/eventJson`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ reason: EVENT_REASON })
	})

	it("streams video bytes within the share scope", async () => {
		const rel = `${EVENT_A}/${EVENT_A_FILES[0]}`
		const res = await fetch(`${base}/share/${token}/videos/${rel}`)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe(`video-bytes:${rel}`)
	})

	it("rejects paths outside the token's event folder", async () => {
		const res = await fetch(`${base}/share/${token}/videos/${EVENT_B}/${EVENT_B_FILES[0]}`)
		expect(res.status).toBe(403)
		expect(await res.json()).toEqual({ error: "path_outside_share" })
	})

	it("rejects subpaths on an expired token with 410", async () => {
		const expired = mintToken(EVENT_A, Date.now() - 10_000)
		const res = await fetch(`${base}/share/${expired}/files`)
		expect(res.status).toBe(410)
		expect(await res.json()).toEqual({ error: "invalid_or_expired" })
	})
})
