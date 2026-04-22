import { describe, it, expect, beforeEach } from "vitest"
import metrics from "../src/server/metrics.js"

describe("metrics", () => {
	beforeEach(() => { metrics.reset() })

	it("renders a counter with labels", () => {
		metrics.incrementCounter("tc_http_requests_total", { method: "GET", status: "200" }, 1, "HTTP requests")
		metrics.incrementCounter("tc_http_requests_total", { method: "GET", status: "200" }, 2)
		metrics.incrementCounter("tc_http_requests_total", { method: "POST", status: "500" })

		const out = metrics.render()
		expect(out).toContain("# HELP tc_http_requests_total HTTP requests")
		expect(out).toContain("# TYPE tc_http_requests_total counter")
		expect(out).toContain('tc_http_requests_total{method="GET",status="200"} 3')
		expect(out).toContain('tc_http_requests_total{method="POST",status="500"} 1')
	})

	it("renders a histogram with bucket counts, sum and count", () => {
		metrics.defineHistogram("tc_parse_duration_seconds", [0.1, 1, 5], "Parse duration")
		metrics.observeHistogram("tc_parse_duration_seconds", 0.05)
		metrics.observeHistogram("tc_parse_duration_seconds", 0.5)
		metrics.observeHistogram("tc_parse_duration_seconds", 3)

		const out = metrics.render()
		expect(out).toContain("# TYPE tc_parse_duration_seconds histogram")
		expect(out).toContain('tc_parse_duration_seconds_bucket{le="0.1"} 1')
		expect(out).toContain('tc_parse_duration_seconds_bucket{le="1"} 2')
		expect(out).toContain('tc_parse_duration_seconds_bucket{le="5"} 3')
		expect(out).toContain('tc_parse_duration_seconds_bucket{le="+Inf"} 3')
		expect(out).toMatch(/tc_parse_duration_seconds_sum 3\.55/)
		expect(out).toContain("tc_parse_duration_seconds_count 3")
	})

	it("escapes quote and backslash in label values", () => {
		metrics.incrementCounter("tc_test_total", { label: 'a"b\\c' })
		const out = metrics.render()
		expect(out).toContain('tc_test_total{label="a\\"b\\\\c"} 1')
	})
})
