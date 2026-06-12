import crypto from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

// auth.js freezes TC_AUTH_* env at require time, so every configuration is
// loaded through a fresh module instance.
async function loadAuth(env) {
	vi.resetModules()
	for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
	return (await import("../src/server/auth.js")).default
}

const USER = "admin"
const PASSWORD = "correct horse battery staple"
const SECRET = "0".repeat(64)
const SESSION_MS = 7 * 24 * 60 * 60 * 1000

// Low-cost scrypt parameters keep the suite fast; they are still within
// parseScryptHash's accepted bounds.
function makeScryptHash(password, { n = 1024, r = 8, p = 1, saltBytes = 16, dkBytes = 32 } = {}) {
	const salt = Buffer.alloc(saltBytes, 7)
	const dk = crypto.scryptSync(password, salt, dkBytes, { N: n, r, p })
	return `scrypt$${n}$${r}$${p}$${salt.toString("base64")}$${dk.toString("base64")}`
}

const PASS_HASH = makeScryptHash(PASSWORD)
const ENABLED_ENV = { TC_AUTH_USER: USER, TC_AUTH_PASS_HASH: PASS_HASH, TC_AUTH_SECRET: SECRET }

function makeRes() {
	return {
		statusCode: 200,
		body: null,
		cookies: {},
		cleared: [],
		redirectedTo: null,
		status(code) {
			this.statusCode = code
			return this
		},
		send(body) {
			this.body = body
			return this
		},
		json(body) {
			this.body = body
			return this
		},
		cookie(name, value, opts) {
			this.cookies[name] = { value, opts }
			return this
		},
		clearCookie(name, opts) {
			this.cleared.push({ name, opts })
			return this
		},
		redirect(location) {
			this.redirectedTo = location
			return this
		},
	}
}

async function login(auth, username, password) {
	const res = makeRes()
	auth.loginHandler({ body: { username, password }, secure: false }, res)
	return res
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.useRealTimers()
})

describe("loginHandler", () => {
	it("returns 503 when auth is not configured", async () => {
		const auth = await loadAuth({})
		const res = await login(auth, USER, PASSWORD)
		expect(res.statusCode).toBe(503)
		expect(res.body).toContain("Authentication is not configured")
	})

	it("asks for credentials when fields are missing", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const res = await login(auth, USER, "")
		expect(res.body).toContain("Please enter username and password.")
		expect(res.cookies).toEqual({})
	})

	it("rejects a wrong password without setting a cookie", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const res = await login(auth, USER, "wrong")
		expect(res.body).toContain("Invalid username or password.")
		expect(res.cookies).toEqual({})
		expect(res.redirectedTo).toBeNull()
	})

	it("rejects a wrong username even with the correct password", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const res = await login(auth, "intruder", PASSWORD)
		expect(res.body).toContain("Invalid username or password.")
		expect(res.cookies).toEqual({})
	})

	it("signs a session cookie and redirects on success", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const res = await login(auth, USER, PASSWORD)

		expect(res.redirectedTo).toBe("/")

		const session = res.cookies.tc_session
		expect(session).toBeDefined()
		expect(session.opts).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", maxAge: SESSION_MS })
		expect(session.value).toMatch(/^admin\|\d+\./)
	})
})

describe("session cookie HMAC", () => {
	async function freshCookie(auth) {
		return (await login(auth, USER, PASSWORD)).cookies.tc_session.value
	}

	function runMiddleware(auth, cookieValue, reqOverrides = {}) {
		const req = { path: "/", headers: { cookie: `tc_session=${cookieValue}` }, xhr: true, ...reqOverrides }
		const res = makeRes()
		const next = vi.fn()
		auth.middleware(req, res, next)
		return { req, res, next }
	}

	it("accepts its own signed cookie and exposes req.user", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const { req, next } = runMiddleware(auth, await freshCookie(auth))
		expect(next).toHaveBeenCalledOnce()
		expect(req.user.username).toBe(USER)
		expect(req.user.expiry).toBeGreaterThan(Date.now())
	})

	it("rejects a tampered signature", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const cookie = await freshCookie(auth)
		const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A")
		const { res, next } = runMiddleware(auth, tampered)
		expect(next).not.toHaveBeenCalled()
		expect(res.statusCode).toBe(401)
	})

	it("rejects a cookie signed under a different secret", async () => {
		const otherAuth = await loadAuth({ ...ENABLED_ENV, TC_AUTH_SECRET: "1".repeat(64) })
		const foreignCookie = await freshCookie(otherAuth)

		const auth = await loadAuth(ENABLED_ENV)
		const { res, next } = runMiddleware(auth, foreignCookie)
		expect(next).not.toHaveBeenCalled()
		expect(res.statusCode).toBe(401)
	})

	it("rejects an expired session (default 7 days)", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		vi.useFakeTimers({ toFake: ["Date"] })

		const start = Date.now()
		vi.setSystemTime(start)
		const cookie = await freshCookie(auth)

		vi.setSystemTime(start + 8 * 24 * 60 * 60 * 1000)
		const { res, next } = runMiddleware(auth, cookie)
		expect(next).not.toHaveBeenCalled()
		expect(res.statusCode).toBe(401)
	})
})

describe("middleware", () => {
	const whitelisted = [
		{ path: "/login" },
		{ path: "/auth-enabled" },
		{ path: "/csrf" },
		{ path: "/metrics" },
		{ path: "/share/some-token" },
		{ path: "/content/app.css" },
		{ path: "/node_modules/bootstrap/dist/css/bootstrap.min.css" },
		{ path: "/logout", method: "POST" },
	]

	it.each(whitelisted)("lets $path through without a session", async (req) => {
		const auth = await loadAuth(ENABLED_ENV)
		const next = vi.fn()
		auth.middleware({ headers: {}, ...req }, makeRes(), next)
		expect(next).toHaveBeenCalledOnce()
	})

	it("returns 401 JSON for xhr and Accept: application/json requests", async () => {
		const auth = await loadAuth(ENABLED_ENV)

		for (const req of [
			{ path: "/", headers: {}, xhr: true },
			{ path: "/", headers: { accept: "application/json" } },
		]) {
			const res = makeRes()
			auth.middleware(req, res, vi.fn())
			expect(res.statusCode).toBe(401)
			expect(res.body).toEqual({ error: "unauthorized" })
		}
	})

	it("redirects plain browser requests to /login", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const res = makeRes()
		auth.middleware({ path: "/", headers: { accept: "text/html" } }, res, vi.fn())
		expect(res.redirectedTo).toBe("/login")
	})
})

describe("scrypt hash parsing (via loginHandler)", () => {
	const malformed = [
		["non-scrypt string", "plaintext-password"],
		["wrong part count", "scrypt$1024$8$1$onlyfourparts"],
		["non-integer N", "scrypt$abc$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
		["N not a power of two", makeScryptHash(PASSWORD).replace("$1024$", "$1000$")],
		["N too large", makeScryptHash(PASSWORD).replace("$1024$", `$${2 ** 21}$`)],
		["r too large", makeScryptHash(PASSWORD).replace("$8$", "$33$")],
		["p too large", makeScryptHash(PASSWORD).replace(/\$1\$/, "$17$")],
		["salt too short", makeScryptHash(PASSWORD, { saltBytes: 8 })],
		["derived key too short", `scrypt$1024$8$1$${Buffer.alloc(16, 7).toString("base64")}$${Buffer.alloc(8, 7).toString("base64")}`],
	]

	it.each(malformed)("treats %s as an invalid login", async (_label, hash) => {
		const auth = await loadAuth({ ...ENABLED_ENV, TC_AUTH_PASS_HASH: hash })
		const res = await login(auth, USER, PASSWORD)
		expect(res.body).toContain("Invalid username or password.")
		expect(res.cookies).toEqual({})
	})
})

describe("logoutHandler", () => {
	it("clears the session cookie and redirects to /login", async () => {
		const auth = await loadAuth(ENABLED_ENV)
		const res = makeRes()
		auth.logoutHandler({ secure: false }, res)

		expect(res.cleared).toHaveLength(1)
		expect(res.cleared[0].name).toBe("tc_session")
		expect(res.cleared[0].opts).toMatchObject({ path: "/", httpOnly: true, sameSite: "Lax" })
		expect(res.redirectedTo).toBe("/login")
	})
})

describe("parseCookies", () => {
	it("parses multiple cookies, decodes values and skips malformed parts", async () => {
		const auth = await loadAuth({})
		expect(auth.parseCookies("a=1; b=hello%20world; malformed; c=x=y")).toEqual({
			a: "1",
			b: "hello world",
			c: "x=y",
		})
		expect(auth.parseCookies(undefined)).toEqual({})
	})
})
