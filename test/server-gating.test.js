import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bootServices, jsonPost, makeFixtureRoot, removeFixtureRoot, startServer, stopServer } from "./helpers/server.js"

// Default env: deletes hidden, sharing off, metrics off, auth off.
let server
let base
let root

beforeAll(async () => {
	const services = await bootServices({})
	root = await makeFixtureRoot()
	services.setFolder(root)
	;({ server, base } = await startServer(services))
})

afterAll(async () => {
	await stopServer(server)
	await removeFixtureRoot(root)
})

describe("delete routes are disabled by default", () => {
	const requests = [
		["/deleteFiles", { paths: ["SavedClips/2025-01-01_12-00-00/2025-01-01_12-00-01-front.mp4"] }],
		["/deleteFolder", { path: "SavedClips/2025-01-01_12-00-00" }],
		["/bulkDeleteFolders", { paths: ["SavedClips/2025-01-01_12-00-00"] }],
		["/cleanupOlderThan", { days: 365, reasons: ["SentryClips"] }],
	]

	it.each(requests)("%s returns 403 delete_disabled", async (route, body) => {
		const res = await jsonPost(base, route, body)
		expect(res.status).toBe(403)
		expect(await res.json()).toEqual({ error: "delete_disabled" })
	})
})

describe("share routes are disabled by default", () => {
	it("POST /shareLink returns 404", async () => {
		const res = await jsonPost(base, "/shareLink", { eventPath: "SavedClips/2025-01-01_12-00-00", ttlHours: 1 })
		expect(res.status).toBe(404)
		expect(await res.json()).toEqual({ error: "not_found" })
	})

	it("GET /share/:token returns 404 before any token check", async () => {
		const res = await fetch(`${base}/share/whatever`)
		expect(res.status).toBe(404)
		expect(await res.json()).toEqual({ error: "not_found" })
	})
})

describe("other defaults", () => {
	it("GET /metrics returns 404 when metrics are disabled", async () => {
		expect((await fetch(`${base}/metrics`)).status).toBe(404)
	})

	it("GET /auth-enabled reports disabled", async () => {
		expect(await (await fetch(`${base}/auth-enabled`)).json()).toEqual({ enabled: false })
	})
})
