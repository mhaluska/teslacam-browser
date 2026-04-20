( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.uiUtils = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
	/** Map video currentTime to two SEI samples + blend factor (uses tSec from server when present). */
	function pickSeiInterpolationBracket( samples, t, dur )
	{
		var n = samples.length

		if ( !n ) return null

		if ( n === 1 ) return { cur: samples[ 0 ], next: samples[ 0 ], alpha: 0 }

		if ( samples[ 0 ].tSec != null && samples[ n - 1 ].tSec != null && isFinite( samples[ 0 ].tSec ) )
		{
			if ( typeof t !== "number" || !isFinite( t ) || t < 0 ) t = 0

			if ( t <= samples[ 0 ].tSec ) return { cur: samples[ 0 ], next: samples[ 0 ], alpha: 0 }

			if ( t >= samples[ n - 1 ].tSec ) return { cur: samples[ n - 1 ], next: samples[ n - 1 ], alpha: 0 }

			var lo = 0
			var hi = n - 1

			while ( lo < hi - 1 )
			{
				var mid = ( lo + hi ) >> 1

				if ( samples[ mid ].tSec <= t ) lo = mid
				else hi = mid
			}

			var cur = samples[ lo ]
			var next = samples[ lo + 1 ]
			var denom = next.tSec - cur.tSec
			var alpha = denom > 0 ? ( t - cur.tSec ) / denom : 0

			return { cur: cur, next: next, alpha: Math.max( 0, Math.min( 1, alpha ) ) }
		}

		if ( !dur || dur <= 0 || !isFinite( dur ) ) return { cur: samples[ 0 ], next: samples[ 0 ], alpha: 0 }

		var u = Math.max( 0, Math.min( 1, t / dur ) )
		var f = u * ( n - 1 )
		var i0 = Math.floor( f )
		var i1 = Math.min( n - 1, i0 + 1 )
		alpha = f - i0

		return { cur: samples[ i0 ], next: samples[ i1 ], alpha: alpha }
	}

	function lerpAngleDeg( a, b, alpha )
	{
		if ( a == null && b == null ) return null

		if ( a == null ) return b

		if ( b == null ) return a

		var diff = ( ( b - a + 540 ) % 360 ) - 180
		var result = a + diff * alpha

		return ( result % 360 + 360 ) % 360
	}

	function blendDashSamples( cur, next, alpha )
	{
		function lerpNum( a, b, al )
		{
			if ( a == null && b == null ) return null

			if ( a == null ) return b

			if ( b == null ) return a

			return a * ( 1 - al ) + b * al
		}

		var speedBlended = lerpNum( cur.speedMps, next.speedMps, alpha )
		var pedalBlended = lerpNum( cur.acceleratorPedal, next.acceleratorPedal, alpha )
		var pedal = pedalBlended != null ? Math.max( 0, Math.min( 1, pedalBlended ) ) : null

		return {
			gear: cur.gear,
			speedMps: speedBlended,
			acceleratorPedal: pedal,
			blinkerLeft: cur.blinkerLeft,
			blinkerRight: cur.blinkerRight,
			brakeApplied: cur.brakeApplied,
			autopilot: cur.autopilot,
			steeringWheelAngle: cur.steeringWheelAngle,
			accelX: lerpNum( cur.accelX, next.accelX, alpha ),
			accelY: lerpNum( cur.accelY, next.accelY, alpha ),
			accelZ: lerpNum( cur.accelZ, next.accelZ, alpha ),
			headingDeg: lerpAngleDeg( cur.headingDeg, next.headingDeg, alpha )
		}
	}

	function normalizeThemePreference( p )
	{
		if ( p === "light" || p === "dark" || p === "system" ) return p

		return "system"
	}

	function normalizeSpeedUnit( u )
	{
		if ( u === "km" || u === "mi" || u === "auto" ) return u

		return "auto"
	}

	// IANA zones in countries that post road signs in mph: US (incl. territories),
	// UK + Crown Dependencies, Liberia, Myanmar. Timezone reflects OS "Region"
	// setting, which is where the user actually drives — more reliable than
	// navigator.language (which tracks UI language, e.g. en-US on a Czech Mac).
	var MPH_TIMEZONES = [
		// United States
		"America/New_York", "America/Detroit", "America/Chicago", "America/Denver",
		"America/Boise", "America/Phoenix", "America/Los_Angeles", "America/Anchorage",
		"America/Juneau", "America/Sitka", "America/Yakutat", "America/Nome",
		"America/Adak", "America/Metlakatla", "America/Menominee",
		"America/Indiana/Indianapolis", "America/Indiana/Vincennes", "America/Indiana/Winamac",
		"America/Indiana/Marengo", "America/Indiana/Petersburg", "America/Indiana/Vevay",
		"America/Indiana/Tell_City", "America/Indiana/Knox",
		"America/Kentucky/Louisville", "America/Kentucky/Monticello",
		"America/North_Dakota/Center", "America/North_Dakota/New_Salem", "America/North_Dakota/Beulah",
		"America/Puerto_Rico", "America/St_Thomas",
		"Pacific/Honolulu", "Pacific/Guam", "Pacific/Pago_Pago", "Pacific/Saipan",
		// United Kingdom + Crown Dependencies
		"Europe/London", "Europe/Belfast", "Europe/Jersey", "Europe/Guernsey", "Europe/Isle_of_Man",
		// Liberia
		"Africa/Monrovia",
		// Myanmar
		"Asia/Yangon", "Asia/Rangoon"
	]

	function resolveAutoSpeedUnit( timezone )
	{
		if ( typeof timezone !== "string" || !timezone ) return "km"

		return MPH_TIMEZONES.indexOf( timezone ) >= 0 ? "mi" : "km"
	}

	function effectiveSpeedUnit( pref, timezone )
	{
		var p = normalizeSpeedUnit( pref )

		if ( p === "km" || p === "mi" ) return p

		return resolveAutoSpeedUnit( timezone )
	}

	/** Flag runs where consecutive SEI frameSeqNo values jump further than the
	 *  typical SEI cadence for the clip. Tesla firmware emits SEI on every
	 *  frame on some builds and every N frames on others — we learn the median
	 *  cadence from the clip itself and only flag real outliers. */
	function detectSeqGaps( samples )
	{
		if ( !samples || samples.length < 3 ) return []

		var seqs = []

		for ( var i = 0; i < samples.length; i++ )
		{
			var s = samples[ i ]
			var raw = s && s.frameSeqNo != null ? s.frameSeqNo : null
			var n = raw != null ? parseInt( raw, 10 ) : null

			seqs.push( ( typeof n === "number" && isFinite( n ) ) ? { seq: n, tSec: s.tSec } : null )
		}

		var deltas = []

		for ( i = 1; i < seqs.length; i++ )
		{
			if ( !seqs[ i ] || !seqs[ i - 1 ] ) continue

			var d = seqs[ i ].seq - seqs[ i - 1 ].seq

			if ( d > 0 ) deltas.push( d )
		}

		if ( !deltas.length ) return []

		var sorted = deltas.slice().sort( function( a, b ) { return a - b } )
		var median = sorted[ Math.floor( sorted.length / 2 ) ] || 1
		var threshold = Math.max( median * 2.5, median + 2 )
		var gaps = []

		for ( i = 1; i < seqs.length; i++ )
		{
			if ( !seqs[ i ] || !seqs[ i - 1 ] ) continue

			var gap = seqs[ i ].seq - seqs[ i - 1 ].seq

			if ( gap > threshold )
			{
				gaps.push( {
					fromSeq: seqs[ i - 1 ].seq,
					toSeq: seqs[ i ].seq,
					missing: Math.max( 0, gap - median ),
					approxSec: ( seqs[ i - 1 ].tSec != null && seqs[ i ].tSec != null )
						? ( seqs[ i ].tSec - seqs[ i - 1 ].tSec )
						: null
				} )
			}
		}

		return gaps
	}

	var G = 9.80665
	var EARTH_RADIUS_M = 6371008.8

	function haversineMeters( lat1, lon1, lat2, lon2 )
	{
		var toRad = Math.PI / 180
		var dLat = ( lat2 - lat1 ) * toRad
		var dLon = ( lon2 - lon1 ) * toRad
		var a = Math.sin( dLat / 2 ) * Math.sin( dLat / 2 )
			+ Math.cos( lat1 * toRad ) * Math.cos( lat2 * toRad )
			* Math.sin( dLon / 2 ) * Math.sin( dLon / 2 )
		var c = 2 * Math.atan2( Math.sqrt( a ), Math.sqrt( 1 - a ) )

		return EARTH_RADIUS_M * c
	}

	/** Summary trip statistics derived from stitched SEI samples.
	 *  Expects samples with `tSec`, optional `latitudeDeg`/`longitudeDeg`,
	 *  `speedMps`, `accelY`, and `autopilot`. Missing fields are skipped
	 *  silently — callers render "—" when a metric is null. */
	function computeTripStats( samples )
	{
		var result = {
			count: 0,
			firstTSec: null,
			lastTSec: null,
			durationSec: null,
			minSpeedMps: null,
			maxSpeedMps: null,
			avgSpeedMps: null,
			distanceMeters: null,
			maxLateralG: null,
			autopilotPct: null
		}

		if ( !Array.isArray( samples ) || !samples.length ) return result

		result.count = samples.length

		var firstT = null
		var lastT = null
		var minSpeed = null
		var maxSpeed = null
		var speedSum = 0
		var speedWeight = 0
		var distance = 0
		var prevGps = null
		var prevT = null
		var maxLatAbs = 0
		var hasLat = false
		var apOn = 0
		var apTotal = 0

		for ( var i = 0; i < samples.length; i++ )
		{
			var s = samples[ i ]
			var t = ( typeof s.tSec === "number" && isFinite( s.tSec ) ) ? s.tSec : null

			if ( t != null )
			{
				if ( firstT == null || t < firstT ) firstT = t
				if ( lastT == null || t > lastT ) lastT = t
			}

			if ( typeof s.speedMps === "number" && isFinite( s.speedMps ) )
			{
				if ( minSpeed == null || s.speedMps < minSpeed ) minSpeed = s.speedMps
				if ( maxSpeed == null || s.speedMps > maxSpeed ) maxSpeed = s.speedMps

				var dt = ( prevT != null && t != null ) ? ( t - prevT ) : 0

				if ( dt > 0 && dt < 5 )
				{
					speedSum += s.speedMps * dt
					speedWeight += dt
				}
			}

			if ( typeof s.accelY === "number" && isFinite( s.accelY ) )
			{
				hasLat = true

				var absLat = Math.abs( s.accelY )

				if ( absLat > maxLatAbs ) maxLatAbs = absLat
			}

			if ( typeof s.autopilot === "string" )
			{
				apTotal += 1
				if ( s.autopilot !== "NONE" && s.autopilot !== "" ) apOn += 1
			}

			var lat = s.latitudeDeg
			var lon = s.longitudeDeg
			var gpsValid = typeof lat === "number" && typeof lon === "number"
				&& isFinite( lat ) && isFinite( lon )
				&& !( lat === 0 && lon === 0 )

			if ( gpsValid )
			{
				if ( prevGps ) distance += haversineMeters( prevGps.lat, prevGps.lon, lat, lon )

				prevGps = { lat: lat, lon: lon }
			}

			prevT = t
		}

		result.firstTSec = firstT
		result.lastTSec = lastT
		result.durationSec = ( firstT != null && lastT != null ) ? Math.max( 0, lastT - firstT ) : null
		result.minSpeedMps = minSpeed
		result.maxSpeedMps = maxSpeed
		result.avgSpeedMps = speedWeight > 0 ? ( speedSum / speedWeight ) : null
		result.distanceMeters = prevGps ? distance : null
		result.maxLateralG = hasLat ? ( maxLatAbs / G ) : null
		result.autopilotPct = apTotal > 0 ? ( apOn / apTotal ) : null

		return result
	}

	return {
		pickSeiInterpolationBracket: pickSeiInterpolationBracket,
		blendDashSamples: blendDashSamples,
		lerpAngleDeg: lerpAngleDeg,
		detectSeqGaps: detectSeqGaps,
		normalizeThemePreference: normalizeThemePreference,
		normalizeSpeedUnit: normalizeSpeedUnit,
		resolveAutoSpeedUnit: resolveAutoSpeedUnit,
		effectiveSpeedUnit: effectiveSpeedUnit,
		haversineMeters: haversineMeters,
		computeTripStats: computeTripStats
	}
} ) );
