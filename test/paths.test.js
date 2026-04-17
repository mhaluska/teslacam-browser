import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import services from "../src/server/services.js"

let fixtureRoot

beforeAll(async () => {
	fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "teslacam-paths-"))
	await fs.promises.mkdir(path.join(fixtureRoot, "SavedClips", "2025-01-01_12-00-00"), { recursive: true })
	await fs.promises.writeFile(
		path.join(fixtureRoot, "SavedClips", "2025-01-01_12-00-00", "event.json"),
		JSON.stringify({ timestamp: "2025-01-01T12:00:00Z", reason: "user_interaction_dashcam_panel_save" }),
	)
	services.setFolder(fixtureRoot)
})

afterAll(async () => {
	if (fixtureRoot) await fs.promises.rm(fixtureRoot, { recursive: true, force: true })
})

describe("path sanitization through public API", () => {
	it("rejects parent-directory traversal with ..", async () => {
		await expect(services.getFiles("../etc", (p) => p)).rejects.toThrow(/path_outside_root|invalid_path/)
	})

	it("strips leading slashes and treats the rest as relative (intentional URL-path handling)", async () => {
		// sanitizeRelativePath strips leading /\ so that Express-supplied paths
		// like "/SavedClips/..." are treated as relative to the root. This means
		// "/etc" becomes "etc" inside the root, not an absolute filesystem path.
		// Result: the path stays sandboxed under the root; we just get ENOENT
		// for the nonexistent "etc" inside the fixture.
		await expect(services.getFiles("/etc", (p) => p)).rejects.toThrow(/ENOENT|no such/)
	})

	it("rejects true absolute paths on platforms where path.isAbsolute is true after stripping", async () => {
		// Belt-and-suspenders: if anything gets past the slash strip with
		// path.isAbsolute returning true, the guard throws.
		const absoluteNoSlash = "C:\\Windows" // Windows-absolute, no leading slash
		if (path.isAbsolute(absoluteNoSlash)) {
			await expect(services.getFiles(absoluteNoSlash, (p) => p)).rejects.toThrow(/absolute_path_not_allowed/)
		}
	})

	it("rejects non-string paths", async () => {
		await expect(services.getFiles(null, (p) => p)).rejects.toThrow()
		await expect(services.getFiles(undefined, (p) => p)).rejects.toThrow()
		await expect(services.getFiles(123, (p) => p)).rejects.toThrow()
	})

	it("rejects empty paths where disallowed", async () => {
		await expect(services.getFiles("", (p) => p)).rejects.toThrow(/invalid_path/)
	})

	it("rejects traversal embedded inside a longer path", async () => {
		await expect(
			services.getFiles("SavedClips/../../../etc", (p) => p),
		).rejects.toThrow(/path_outside_root|invalid_path/)
	})

	it("accepts legitimate subpaths", async () => {
		const files = await services.getFiles("SavedClips/2025-01-01_12-00-00", (p) => "videos/" + p)
		expect(Array.isArray(files)).toBe(true)
	})

	it("copyPath rejects traversal, accepts empty (=root) and stripped-slash paths", () => {
		expect(() => services.copyPath("../etc")).toThrow(/path_outside_root|invalid_path/)
		// Empty is allowed for copyPath (root folder)
		expect(services.copyPath("")).toBe(path.resolve(fixtureRoot))
		// Leading slash is stripped and treated as relative — resolves under root.
		expect(services.copyPath("/SavedClips")).toBe(path.join(path.resolve(fixtureRoot), "SavedClips"))
	})
})

describe("readEventJson safety", () => {
	it("returns null for missing event.json without throwing", async () => {
		const result = await services.readEventJson("SavedClips")
		expect(result).toBeNull()
	})

	it("returns null (does not throw) for non-string or empty input", async () => {
		expect(await services.readEventJson(null)).toBeNull()
		expect(await services.readEventJson("")).toBeNull()
		expect(await services.readEventJson(123)).toBeNull()
	})

	it("reads an event.json from a valid subpath", async () => {
		const data = await services.readEventJson("SavedClips/2025-01-01_12-00-00")
		expect(data).toBeTruthy()
		expect(data.reason).toBe("user_interaction_dashcam_panel_save")
	})

	it("does not read event.json outside the root via traversal", async () => {
		// Traversal raises; readEventJson catches and returns null (documented behavior).
		const data = await services.readEventJson("../../etc")
		expect(data).toBeNull()
	})
})
