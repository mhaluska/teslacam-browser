import path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
	EVENT_A,
	EVENT_A_FILES,
	EVENT_B,
	EVENT_B_FILES,
	EVENT_REASON,
	SENTRY_OLD,
	bootServices,
	fileExists,
	jsonPost,
	makeFixtureRoot,
	removeFixtureRoot,
	startServer,
	stopServer,
} from "./helpers/server.js"

// Auth stays disabled in this suite, so requireCsrf must no-op: every request
// below succeeds without an x-csrf-token header.
let services
let server
let base
let root
const roots = []

async function useFreshRoot() {
	root = await makeFixtureRoot()
	roots.push(root)
	services.setFolder(root)
}

beforeAll(async () => {
	services = await bootServices({
		TC_HIDE_DELETE_BUTTONS: "false",
		TC_DELETE_MAX_PER_MINUTE: "1000",
	})
	;({ server, base } = await startServer(services))
})

afterAll(async () => {
	await stopServer(server)
	await Promise.all(roots.map(removeFixtureRoot))
})

describe("GET /healthz", () => {
	it("returns ok", async () => {
		const res = await fetch(`${base}/healthz`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
	})
})

describe("POST /deleteFiles", () => {
	beforeEach(useFreshRoot)

	it("rejects a non-array body", async () => {
		const res = await jsonPost(base, "/deleteFiles", { paths: "x" })
		expect(res.status).toBe(400)
	})

	it("rejects empty-string entries", async () => {
		const res = await jsonPost(base, "/deleteFiles", { paths: [""] })
		expect(res.status).toBe(400)
	})

	it("rejects path traversal outside the root", async () => {
		const res = await jsonPost(base, "/deleteFiles", { paths: ["../escape.mp4"] })
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ error: "invalid_path_or_delete_failed" })
	})

	it("refuses to delete files at the root level", async () => {
		const fs = await import("node:fs")
		await fs.promises.writeFile(path.join(root, "stray.txt"), "x")
		const res = await jsonPost(base, "/deleteFiles", { paths: ["stray.txt"] })
		expect(res.status).toBe(400)
		expect(await fileExists(root, "stray.txt")).toBe(true)
	})

	it("refuses files spanning multiple folders", async () => {
		const res = await jsonPost(base, "/deleteFiles", {
			paths: [`${EVENT_A}/${EVENT_A_FILES[0]}`, `${EVENT_B}/${EVENT_B_FILES[0]}`],
		})
		expect(res.status).toBe(400)
		expect(await fileExists(root, EVENT_A, EVENT_A_FILES[0])).toBe(true)
		expect(await fileExists(root, EVENT_B, EVENT_B_FILES[0])).toBe(true)
	})

	it("rejects nonexistent files", async () => {
		const res = await jsonPost(base, "/deleteFiles", { paths: [`${EVENT_A}/nope.mp4`] })
		expect(res.status).toBe(400)
	})

	it("deletes files without a CSRF token while auth is disabled, and keeps a non-empty folder", async () => {
		const res = await jsonPost(base, "/deleteFiles", { paths: [`${EVENT_A}/${EVENT_A_FILES[0]}`] })
		expect(res.status).toBe(200)
		expect(await fileExists(root, EVENT_A, EVENT_A_FILES[0])).toBe(false)
		expect(await fileExists(root, EVENT_A)).toBe(true)
	})

	it("removes the parent folder once its last files are deleted", async () => {
		const paths = EVENT_A_FILES.map((f) => `${EVENT_A}/${f}`).concat([`${EVENT_A}/event.json`])
		const res = await jsonPost(base, "/deleteFiles", { paths })
		expect(res.status).toBe(200)
		expect(await fileExists(root, EVENT_A)).toBe(false)
	})
})

describe("POST /deleteFolder", () => {
	beforeEach(useFreshRoot)

	it("rejects a missing path", async () => {
		const res = await jsonPost(base, "/deleteFolder", {})
		expect(res.status).toBe(400)
	})

	it("rejects deleting the root itself", async () => {
		const res = await jsonPost(base, "/deleteFolder", { path: "." })
		expect(res.status).toBe(400)
	})

	it("rejects traversal", async () => {
		const res = await jsonPost(base, "/deleteFolder", { path: "../outside" })
		expect(res.status).toBe(400)
	})

	it("deletes a folder with its files", async () => {
		const res = await jsonPost(base, "/deleteFolder", { path: EVENT_B })
		expect(res.status).toBe(200)
		expect(await fileExists(root, EVENT_B)).toBe(false)
		expect(await fileExists(root, EVENT_A)).toBe(true)
	})
})

describe("POST /bulkDeleteFolders", () => {
	beforeEach(useFreshRoot)

	it("rejects non-array and empty bodies", async () => {
		expect((await jsonPost(base, "/bulkDeleteFolders", { paths: "x" })).status).toBe(400)
		expect((await jsonPost(base, "/bulkDeleteFolders", { paths: [] })).status).toBe(400)
		expect((await jsonPost(base, "/bulkDeleteFolders", { paths: [42] })).status).toBe(400)
	})

	it("reports deleted and failed entries per folder", async () => {
		const res = await jsonPost(base, "/bulkDeleteFolders", { paths: [EVENT_B, "SavedClips/nope"] })
		expect(res.status).toBe(200)

		const body = await res.json()
		expect(body.deleted).toEqual([EVENT_B])
		expect(body.failed).toHaveLength(1)
		expect(body.failed[0].path).toBe("SavedClips/nope")
		expect(await fileExists(root, EVENT_B)).toBe(false)
	})
})

describe("POST /cleanupOlderThan", () => {
	beforeEach(useFreshRoot)

	it("rejects invalid days and reasons", async () => {
		expect((await jsonPost(base, "/cleanupOlderThan", { days: -1, reasons: ["SentryClips"] })).status).toBe(400)
		expect((await jsonPost(base, "/cleanupOlderThan", { days: "365", reasons: ["SentryClips"] })).status).toBe(400)
		expect((await jsonPost(base, "/cleanupOlderThan", { days: 365, reasons: [] })).status).toBe(400)
		expect((await jsonPost(base, "/cleanupOlderThan", { days: 365, reasons: "SentryClips" })).status).toBe(400)
	})

	it("dryRun reports candidates without deleting", async () => {
		const res = await jsonPost(base, "/cleanupOlderThan", { days: 365, reasons: ["SentryClips"], dryRun: true })
		expect(res.status).toBe(200)

		const body = await res.json()
		expect(body).toMatchObject({ dryRun: true, count: 1, paths: [SENTRY_OLD] })
		expect(body.bytes).toBeGreaterThan(0)
		expect(await fileExists(root, SENTRY_OLD)).toBe(true)
	})

	it("respects the age cutoff", async () => {
		const res = await jsonPost(base, "/cleanupOlderThan", { days: 36500, reasons: ["SentryClips"], dryRun: true })
		expect((await res.json()).count).toBe(0)
	})

	it("deletes matching folders and keeps the rest", async () => {
		const res = await jsonPost(base, "/cleanupOlderThan", { days: 365, reasons: ["SentryClips"] })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: [SENTRY_OLD], failed: [] })
		expect(await fileExists(root, SENTRY_OLD)).toBe(false)
		expect(await fileExists(root, EVENT_A)).toBe(true)
		expect(await fileExists(root, EVENT_B)).toBe(true)
	})
})

describe("GET /diskUsage", () => {
	beforeEach(useFreshRoot)

	it("aggregates totals by reason and day", async () => {
		const res = await fetch(`${base}/diskUsage`)
		expect(res.status).toBe(200)

		const body = await res.json()
		expect(body.eventCount).toBe(3)
		expect(body.totalBytes).toBeGreaterThan(0)
		expect(Object.keys(body.byReason).sort()).toEqual([EVENT_REASON, "SentryClips"].sort())
		expect(body.byDay.map((d) => d.date)).toEqual(["2020-01-01", "2025-01-01", "2025-01-02"])
		expect(body.oldestDate).not.toBeNull()
		expect(body.newestDate).not.toBeNull()
	})

	it("is invalidated by deletes despite the 60s cache TTL", async () => {
		const before = await (await fetch(`${base}/diskUsage`)).json()
		expect(before.eventCount).toBe(3)

		expect((await jsonPost(base, "/deleteFolder", { path: EVENT_B })).status).toBe(200)

		const after = await (await fetch(`${base}/diskUsage`)).json()
		expect(after.eventCount).toBe(2)
		expect(after.totalBytes).toBeLessThan(before.totalBytes)
	})
})
