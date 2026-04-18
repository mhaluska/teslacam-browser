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

		var speedBlended = lerpNum( cur.speedKmh, next.speedKmh, alpha )
		var pedalBlended = lerpNum( cur.acceleratorPedal, next.acceleratorPedal, alpha )
		var spd = speedBlended != null ? Math.round( speedBlended ) : null
		var pedal = pedalBlended != null ? Math.max( 0, Math.min( 1, pedalBlended ) ) : null

		return {
			gear: cur.gear,
			speedKmh: spd,
			acceleratorPedal: pedal,
			blinkerLeft: cur.blinkerLeft,
			blinkerRight: cur.blinkerRight,
			brakeApplied: cur.brakeApplied,
			autopilot: cur.autopilot,
			steeringWheelAngle: cur.steeringWheelAngle
		}
	}

	function normalizeThemePreference( p )
	{
		if ( p === "light" || p === "dark" || p === "system" ) return p

		return "system"
	}

	return {
		pickSeiInterpolationBracket: pickSeiInterpolationBracket,
		blendDashSamples: blendDashSamples,
		normalizeThemePreference: normalizeThemePreference
	}
} ) );
