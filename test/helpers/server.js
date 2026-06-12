import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"

// Fixture layout shared by the integration suites. Folder/clip names must
// match folderRegex / clipRegex in src/renderer/helpers.js.
export const EVENT_A = "SavedClips/2025-01-01_12-00-00"
export const EVENT_B = "SavedClips/2025-01-02_12-00-00"
export const SENTRY_OLD = "SentryClips/2020-01-01_12-00-00"
export const EVENT_A_FILES = ["2025-01-01_12-00-01-front.mp4", "2025-01-01_12-00-01-back.mp4"]
export const EVENT_B_FILES = ["2025-01-02_12-00-01-front.mp4"]
export const SENTRY_OLD_FILES = ["2020-01-01_12-00-01-front.mp4"]
export const EVENT_REASON = "user_interaction_dashcam_panel_save"

/**
 * Set env vars, then load services so module-level env reads (TC_HIDE_DELETE_BUTTONS,
 * TC_SHARE_ENABLED, TC_AUTH_*, ...) see them. Must be the first thing a suite does;
 * vitest runs each test file in its own fork, so the env and module state stay isolated.
 */
export async function bootServices(env = {}) {
	for (const [key, value] of Object.entries(env)) process.env[key] = value

	const services = (await import("../../src/server/services.js")).default
	services.setVersion("0.0.0-test")
	return services
}

export async function startServer(services) {
	const server = services.initializeExpress(0, { host: "127.0.0.1" })
	if (!server) throw new Error("initializeExpress returned no server (already initialized in this process?)")

	await once(server, "listening")
	return { server, base: `http://127.0.0.1:${server.address().port}` }
}

export function stopServer(server) {
	if (!server) return Promise.resolve()
	return new Promise((resolve) => server.close(resolve))
}

export async function makeFixtureRoot() {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "teslacam-it-"))
	const events = [
		{ rel: EVENT_A, files: EVENT_A_FILES, reason: EVENT_REASON },
		{ rel: EVENT_B, files: EVENT_B_FILES, reason: EVENT_REASON },
		{ rel: SENTRY_OLD, files: SENTRY_OLD_FILES, reason: null },
	]

	for (const event of events) {
		const dir = path.join(root, event.rel)
		await fs.promises.mkdir(dir, { recursive: true })
		for (const file of event.files) {
			await fs.promises.writeFile(path.join(dir, file), `video-bytes:${event.rel}/${file}`)
		}
		if (event.reason) {
			await fs.promises.writeFile(path.join(dir, "event.json"), JSON.stringify({ reason: event.reason }))
		}
	}

	return root
}

export function removeFixtureRoot(root) {
	return fs.promises.rm(root, { recursive: true, force: true })
}

export function fileExists(...parts) {
	return fs.promises.access(path.join(...parts)).then(
		() => true,
		() => false,
	)
}

export function jsonPost(base, route, body, headers = {}) {
	return fetch(base + route, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	})
}
