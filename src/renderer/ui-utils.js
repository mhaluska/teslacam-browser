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
			accelZ: lerpNum( cur.accelZ, next.accelZ, alpha )
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

	// Countries that use mph on the road (excluding American Samoa, Bahamas etc.
	// that are rare locales in practice). Explicit list beats Intl guessing.
	var MPH_REGIONS = [ "US", "GB", "UK", "LR", "MM" ]

	function resolveAutoSpeedUnit( locale )
	{
		if ( typeof locale !== "string" || !locale ) return "km"

		var parts = locale.replace( "_", "-" ).split( "-" )

		for ( var i = 1; i < parts.length; i++ )
		{
			var region = parts[ i ].toUpperCase()

			if ( MPH_REGIONS.indexOf( region ) >= 0 ) return "mi"
		}

		return "km"
	}

	function effectiveSpeedUnit( pref, locale )
	{
		var p = normalizeSpeedUnit( pref )

		if ( p === "km" || p === "mi" ) return p

		return resolveAutoSpeedUnit( locale )
	}

	return {
		pickSeiInterpolationBracket: pickSeiInterpolationBracket,
		blendDashSamples: blendDashSamples,
		normalizeThemePreference: normalizeThemePreference,
		normalizeSpeedUnit: normalizeSpeedUnit,
		resolveAutoSpeedUnit: resolveAutoSpeedUnit,
		effectiveSpeedUnit: effectiveSpeedUnit
	}
} ) );
