import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import settings from "../src/main/settings.js"

const { createSettingsStore } = settings

describe("createSettingsStore", () => {
	let dir
	let file

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-settings-"))
		file = path.join(dir, "settings.json")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("returns undefined when the file does not exist", () => {
		expect(createSettingsStore(file).getSync("folder")).toBeUndefined()
	})

	it("round-trips values within one store", () => {
		const store = createSettingsStore(file)
		store.setSync("folders", ["/a", "/b"])
		store.setSync("speedUnit", "km")
		expect(store.getSync("folders")).toEqual(["/a", "/b"])
		expect(store.getSync("speedUnit")).toBe("km")
	})

	it("persists values for a new store instance", () => {
		createSettingsStore(file).setSync("themePreference", "dark")
		expect(createSettingsStore(file).getSync("themePreference")).toBe("dark")
	})

	it("reads a file written by electron-settings", () => {
		fs.writeFileSync(file, JSON.stringify({ folder: "/x", folders: ["/y"], themePreference: "light" }))
		const store = createSettingsStore(file)
		expect(store.getSync("folders")).toEqual(["/y"])
		expect(store.getSync("folder")).toBe("/x")
		expect(store.getSync("themePreference")).toBe("light")
	})

	it("falls back to empty settings on corrupt JSON and overwrites it on save", () => {
		fs.writeFileSync(file, "{not json")
		const store = createSettingsStore(file)
		expect(store.getSync("folder")).toBeUndefined()
		store.setSync("folder", "/z")
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ folder: "/z" })
	})

	it("creates the parent directory and leaves no temp file behind", () => {
		const nested = path.join(dir, "nested", "deeper", "settings.json")
		createSettingsStore(nested).setSync("speedUnit", "mi")
		expect(JSON.parse(fs.readFileSync(nested, "utf8"))).toEqual({ speedUnit: "mi" })
		expect(fs.readdirSync(path.dirname(nested))).toEqual(["settings.json"])
	})
})
