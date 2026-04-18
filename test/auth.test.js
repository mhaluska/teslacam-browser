import { describe, it, expect } from "vitest"
import auth from "../src/server/auth.js"

describe("auth.isEnabled", () => {
	it("returns false when TC_AUTH_USER / TC_AUTH_PASS_HASH are unset (default test env)", () => {
		// These env vars are frozen at require-time, so this asserts that the
		// CI/test environment does not accidentally have auth enabled.
		expect(auth.isEnabled()).toBe(false)
	})
})

describe("auth.shouldUseSecureCookie", () => {
	it("returns req.secure when TC_COOKIE_SECURE is 'auto' (default)", () => {
		expect(auth.shouldUseSecureCookie({ secure: true })).toBe(true)
		expect(auth.shouldUseSecureCookie({ secure: false })).toBe(false)
	})

	it("handles missing request gracefully", () => {
		expect(auth.shouldUseSecureCookie(null)).toBe(false)
		expect(auth.shouldUseSecureCookie(undefined)).toBe(false)
	})
})

describe("auth.middleware", () => {
	it("is a function with arity 3 (req, res, next)", () => {
		expect(typeof auth.middleware).toBe("function")
		expect(auth.middleware.length).toBe(3)
	})

	it("lets unauthenticated requests through /login, /auth-enabled, /csrf when auth is disabled", () => {
		// When auth is disabled, the main services.js pipeline does not install
		// the middleware at all, but the middleware itself still short-circuits
		// the whitelisted paths even if somehow invoked.
		let called = false
		const next = () => {
			called = true
		}
		auth.middleware({ path: "/login", headers: {} }, { redirect: () => { /* stub */ } }, next)
		expect(called).toBe(true)
	})
})
