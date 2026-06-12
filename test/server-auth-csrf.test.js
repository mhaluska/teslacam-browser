import crypto from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	EVENT_A,
	EVENT_A_FILES,
	bootServices,
	fileExists,
	jsonPost,
	makeFixtureRoot,
	removeFixtureRoot,
	startServer,
	stopServer,
} from "./helpers/server.js"

const USER = "admin"
const PASSWORD = "correct horse battery staple"

function makeScryptHash(password) {
	const salt = Buffer.alloc(16, 7)
	const dk = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 })
	return `scrypt$1024$8$1$${salt.toString("base64")}$${dk.toString("base64")}`
}

function cookieValue(setCookies, name) {
	const match = setCookies.find((c) => c.startsWith(`${name}=`))
	return match ? match.split(";")[0].split("=").slice(1).join("=") : null
}

function postLogin(base, username, password) {
	return fetch(`${base}/login`, {
		method: "POST",
		body: new URLSearchParams({ username, password }),
		redirect: "manual",
	})
}

let server
let base
let root
let sessionCookie

beforeAll(async () => {
	const services = await bootServices({
		TC_AUTH_USER: USER,
		TC_AUTH_PASS_HASH: makeScryptHash(PASSWORD),
		TC_AUTH_SECRET: "2".repeat(64),
		TC_LOGIN_MAX_ATTEMPTS: "100",
		TC_HIDE_DELETE_BUTTONS: "false",
		TC_DELETE_MAX_PER_MINUTE: "1000",
	})
	root = await makeFixtureRoot()
	services.setFolder(root)
	;({ server, base } = await startServer(services))
})

afterAll(async () => {
	await stopServer(server)
	await removeFixtureRoot(root)
})

describe("login over HTTP", () => {
	it("reports auth as enabled", async () => {
		expect(await (await fetch(`${base}/auth-enabled`)).json()).toEqual({ enabled: true })
	})

	it("serves the login form", async () => {
		const res = await fetch(`${base}/login`)
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("<form method=\"POST\" action=\"/login\">")
	})

	it("rejects wrong credentials without a session cookie", async () => {
		const res = await postLogin(base, USER, "wrong")
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("Invalid username or password.")
		expect(cookieValue(res.headers.getSetCookie(), "tc_session")).toBeNull()
	})

	it("sets a HttpOnly Lax session cookie and redirects on success", async () => {
		const res = await postLogin(base, USER, PASSWORD)
		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("/")

		const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("tc_session="))
		expect(setCookie).toContain("HttpOnly")
		expect(setCookie).toContain("SameSite=Lax")
		expect(setCookie).toContain("Path=/")

		sessionCookie = `tc_session=${cookieValue(res.headers.getSetCookie(), "tc_session")}`
	})
})

describe("auth middleware over HTTP", () => {
	it("returns 401 JSON to API clients without a session", async () => {
		const res = await fetch(`${base}/`, { headers: { accept: "application/json" } })
		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({ error: "unauthorized" })
	})

	it("redirects browsers without a session to /login", async () => {
		const res = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" })
		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("/login")
	})

	it("serves the app with a valid session cookie", async () => {
		const res = await fetch(`${base}/`, { headers: { cookie: sessionCookie } })
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("<html")
	})

	it("rejects a tampered session cookie", async () => {
		const tampered = sessionCookie.slice(0, -1) + (sessionCookie.endsWith("A") ? "B" : "A")
		const res = await fetch(`${base}/`, { headers: { cookie: tampered, accept: "application/json" } })
		expect(res.status).toBe(401)
	})
})

describe("CSRF enforcement", () => {
	async function getCsrf() {
		const res = await fetch(`${base}/csrf`)
		const { token } = await res.json()
		return { token, setCookies: res.headers.getSetCookie() }
	}

	it("issues a token with a matching cookie and reuses an existing one", async () => {
		const first = await getCsrf()
		expect(cookieValue(first.setCookies, "tc_csrf")).toBe(first.token)

		const res = await fetch(`${base}/csrf`, { headers: { cookie: `tc_csrf=${first.token}` } })
		expect((await res.json()).token).toBe(first.token)
		expect(res.headers.getSetCookie()).toEqual([])
	})

	it("rejects POST /logout without or with a mismatched token", async () => {
		const bare = await fetch(`${base}/logout`, { method: "POST", redirect: "manual" })
		expect(bare.status).toBe(403)
		expect(await bare.json()).toEqual({ error: "csrf_invalid" })

		const { token } = await getCsrf()
		const mismatched = await fetch(`${base}/logout`, {
			method: "POST",
			redirect: "manual",
			headers: { cookie: `tc_csrf=${token}`, "x-csrf-token": "not-the-token" },
		})
		expect(mismatched.status).toBe(403)
	})

	it("logs out with a matching cookie/header pair and clears the session", async () => {
		const { token } = await getCsrf()
		const res = await fetch(`${base}/logout`, {
			method: "POST",
			redirect: "manual",
			headers: { cookie: `tc_csrf=${token}; ${sessionCookie}`, "x-csrf-token": token },
		})
		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("/login")

		const cleared = res.headers.getSetCookie().find((c) => c.startsWith("tc_session="))
		expect(cleared).toContain("Expires=")
	})

	it("guards the full delete chain: auth, then CSRF, then the handler", async () => {
		const target = `${EVENT_A}/${EVENT_A_FILES[0]}`

		// No session: the auth middleware rejects before CSRF is even consulted.
		const unauthenticated = await jsonPost(base, "/deleteFiles", { paths: [target] }, { accept: "application/json" })
		expect(unauthenticated.status).toBe(401)

		// Session but no CSRF token: 403 from requireCsrf.
		const noCsrf = await jsonPost(base, "/deleteFiles", { paths: [target] }, { cookie: sessionCookie })
		expect(noCsrf.status).toBe(403)
		expect(await noCsrf.json()).toEqual({ error: "csrf_invalid" })
		expect(await fileExists(root, target)).toBe(true)

		// Session + matching CSRF pair: the file is deleted.
		const { token } = await getCsrf()
		const ok = await jsonPost(
			base,
			"/deleteFiles",
			{ paths: [target] },
			{ cookie: `tc_csrf=${token}; ${sessionCookie}`, "x-csrf-token": token },
		)
		expect(ok.status).toBe(200)
		expect(await fileExists(root, target)).toBe(false)
	})
})
