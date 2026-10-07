( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.uiHudCanvas = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
	// Canvas 2D twin of the .tc-dash-cluster overlay in ui-video.js. Sizes are
	// in "rem" units (matching app.css) scaled to the frame width, so the HUD
	// keeps the same proportions at any export resolution.
	var FRAME_WIDTH_IN_REM = 48
	var FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

	var PANEL_BG = "rgba( 74, 85, 85, 0.88 )"
	var PANEL_MIN_WIDTH = 33
	var PANEL_PAD_X = 1
	var PANEL_PAD_Y = 0.5
	var PANEL_RADIUS = 0.65
	var PANEL_BOTTOM = 0.35
	var PANEL_GAP = 1.1
	var DIAL_SIZE = 3.75
	var COL_MIN_WIDTH = 2.5
	var ARROW_SIZE = 1.6

	var WHITE = "#fff"
	var DIM = "rgba( 255, 255, 255, 0.35 )"
	var BRIGHT = "rgba( 255, 255, 255, 0.9 )"
	var BLINKER_ON = "#4ade80"
	var BRAKE_ON = "#ef4444"
	var AUTOPILOT_ON = "#3b82f6"
	var ALERT = "#f87171"

	// Same period as the tc-blink CSS animation (visible for the first half).
	var BLINK_PERIOD_SEC = 0.6

	var LEFT_ARROW = [ [ 10, 3 ], [ 2, 12 ], [ 10, 21 ], [ 10, 15 ], [ 22, 15 ], [ 22, 9 ], [ 10, 9 ] ]
	var RIGHT_ARROW = [ [ 14, 3 ], [ 22, 12 ], [ 14, 21 ], [ 14, 15 ], [ 2, 15 ], [ 2, 9 ], [ 14, 9 ] ]

	function font( weight, sizePx )
	{
		return weight + " " + sizePx + "px " + FONT_FAMILY
	}

	function roundRectPath( ctx, x, y, w, h, r )
	{
		ctx.beginPath()
		ctx.moveTo( x + r, y )
		ctx.arcTo( x + w, y, x + w, y + h, r )
		ctx.arcTo( x + w, y + h, x, y + h, r )
		ctx.arcTo( x, y + h, x, y, r )
		ctx.arcTo( x, y, x + w, y, r )
		ctx.closePath()
	}

	function circle( ctx, cx, cy, r )
	{
		ctx.beginPath()
		ctx.arc( cx, cy, r, 0, Math.PI * 2 )
	}

	function line( ctx, x1, y1, x2, y2 )
	{
		ctx.beginPath()
		ctx.moveTo( x1, y1 )
		ctx.lineTo( x2, y2 )
		ctx.stroke()
	}

	/** Run draw() in an SVG-like coordinate space: viewBox [vx, vy, vw, vh] fitted ("meet") into the box. */
	function withViewBox( ctx, x, y, w, h, vb, draw )
	{
		var s = Math.min( w / vb[ 2 ], h / vb[ 3 ] )

		ctx.save()
		ctx.translate( x + ( w - vb[ 2 ] * s ) / 2, y + ( h - vb[ 3 ] * s ) / 2 )
		ctx.scale( s, s )
		ctx.translate( -vb[ 0 ], -vb[ 1 ] )
		draw()
		ctx.restore()
	}

	function isBlinkVisible( videoTime )
	{
		var t = typeof videoTime === "number" && isFinite( videoTime ) ? videoTime : 0
		var phase = ( ( t % BLINK_PERIOD_SEC ) + BLINK_PERIOD_SEC ) % BLINK_PERIOD_SEC

		return phase < BLINK_PERIOD_SEC / 2
	}

	function drawCompass( ctx, x, y, size, headingDeg )
	{
		withViewBox( ctx, x, y, size, size, [ -1.4, -1.4, 2.8, 2.8 ], function()
		{
			ctx.strokeStyle = BRIGHT
			ctx.fillStyle = BRIGHT
			ctx.globalAlpha = 0.55
			ctx.lineWidth = 0.08
			circle( ctx, 0, 0, 1.15 )
			ctx.stroke()
			ctx.globalAlpha = 1

			ctx.save()
			ctx.rotate( -headingDeg * Math.PI / 180 )
			ctx.textAlign = "center"
			ctx.textBaseline = "alphabetic"
			ctx.font = font( 700, 0.55 )
			ctx.fillStyle = ALERT
			ctx.fillText( "N", 0, -0.75 )
			ctx.font = font( 400, 0.4 )
			ctx.fillStyle = BRIGHT
			ctx.globalAlpha = 0.7
			ctx.fillText( "E", 0.85, 0.2 )
			ctx.fillText( "S", 0, 1.05 )
			ctx.fillText( "W", -0.85, 0.2 )
			ctx.globalAlpha = 1
			ctx.restore()

			ctx.fillStyle = BRIGHT
			ctx.beginPath()
			ctx.moveTo( 0, -0.55 )
			ctx.lineTo( 0.2, 0.15 )
			ctx.lineTo( -0.2, 0.15 )
			ctx.closePath()
			ctx.fill()
		} )
	}

	function drawPedal( ctx, x, y, w, h, on )
	{
		withViewBox( ctx, x, y, w, h, [ 4, 2, 24, 36 ], function()
		{
			ctx.strokeStyle = on ? BRAKE_ON : DIM
			ctx.lineWidth = 2
			roundRectPath( ctx, 6, 4, 20, 32, 5 )
			ctx.stroke()
			line( ctx, 9, 12, 23, 12 )
			line( ctx, 9, 18, 23, 18 )
			line( ctx, 9, 24, 23, 24 )
		} )
	}

	function drawArrow( ctx, x, y, size, points, on, videoTime )
	{
		if ( on && !isBlinkVisible( videoTime ) ) return

		withViewBox( ctx, x, y, size, size, [ 0, 0, 24, 24 ], function()
		{
			ctx.fillStyle = on ? BLINKER_ON : DIM
			ctx.beginPath()
			ctx.moveTo( points[ 0 ][ 0 ], points[ 0 ][ 1 ] )

			for ( var i = 1; i < points.length; i++ ) ctx.lineTo( points[ i ][ 0 ], points[ i ][ 1 ] )

			ctx.closePath()
			ctx.fill()
		} )
	}

	function drawWheel( ctx, x, y, size, on, angleDeg )
	{
		withViewBox( ctx, x, y, size, size, [ 0, 0, 40, 40 ], function()
		{
			if ( angleDeg != null && isFinite( angleDeg ) )
			{
				ctx.translate( 20, 20 )
				ctx.rotate( angleDeg * Math.PI / 180 )
				ctx.translate( -20, -20 )
			}

			var color = on ? AUTOPILOT_ON : DIM

			ctx.strokeStyle = color
			ctx.fillStyle = color
			ctx.lineWidth = 2.5
			circle( ctx, 20, 20, 15 )
			ctx.stroke()
			circle( ctx, 20, 20, 4 )
			ctx.fill()
			ctx.lineWidth = 2
			ctx.lineCap = "round"
			line( ctx, 16, 20, 5, 20 )
			line( ctx, 24, 20, 35, 20 )
			line( ctx, 20, 24, 20, 35 )
			ctx.lineCap = "butt"
		} )
	}

	function drawThrottle( ctx, x, y, w, h, pct, u )
	{
		var border = 0.125 * u
		var innerH = h - border * 2
		var fillH = innerH * Math.max( 0, Math.min( 100, pct ) ) / 100

		if ( fillH > 0 )
		{
			var top = y + border + innerH - fillH
			var grad = ctx.createLinearGradient( 0, y + h - border, 0, y + border )

			grad.addColorStop( 0, "#2b8a3e" )
			grad.addColorStop( 1, "#69db7c" )

			ctx.save()
			roundRectPath( ctx, x + border, y + border, w - border * 2, innerH, Math.max( 0, 0.25 * u - border ) )
			ctx.clip()
			ctx.fillStyle = grad
			ctx.fillRect( x + border, top, w - border * 2, fillH )
			ctx.restore()
		}

		ctx.strokeStyle = DIM
		ctx.lineWidth = border
		roundRectPath( ctx, x + border / 2, y + border / 2, w - border, h - border, 0.25 * u )
		ctx.stroke()
	}

	function drawGMeter( ctx, x, y, size, g )
	{
		withViewBox( ctx, x, y, size, size, [ -1.4, -1.4, 2.8, 2.8 ], function()
		{
			var color = g.clipped ? ALERT : BRIGHT

			ctx.strokeStyle = color
			ctx.fillStyle = color
			ctx.globalAlpha = 0.55
			ctx.lineWidth = 0.08
			circle( ctx, 0, 0, 1.2 )
			ctx.stroke()
			ctx.globalAlpha = 0.35
			ctx.lineWidth = 0.05
			circle( ctx, 0, 0, 0.6 )
			ctx.stroke()
			ctx.lineWidth = 0.04
			line( ctx, -1.2, 0, 1.2, 0 )
			line( ctx, 0, -1.2, 0, 1.2 )
			ctx.globalAlpha = 1
			circle( ctx, g.x, g.y, 0.22 )
			ctx.fill()
		} )
	}

	/**
	 * Draw the dashboard HUD for one frame.
	 * @param ctx   CanvasRenderingContext2D
	 * @param view  result of uiUtils.computeDashView (null → nothing drawn)
	 * @param opts  { width, height, videoTime } — frame size in px; videoTime drives blinker phase
	 */
	function drawDashHud( ctx, view, opts )
	{
		if ( !ctx || !view || !opts || !( opts.width > 0 ) || !( opts.height > 0 ) ) return

		var u = opts.width / FRAME_WIDTH_IN_REM
		var hasCompass = view.headingDeg != null && isFinite( view.headingDeg )
		var hasGMeter = !!( view.gMeter && view.gMeter.visible )
		var speedText = String( view.speed && view.speed.value != null ? view.speed.value : "—" )
		var unitText = view.speed && view.speed.unit ? view.speed.unit : ""

		ctx.save()

		ctx.font = font( 600, 1.75 * u )
		var speedW = ctx.measureText( speedText ).width
		ctx.font = font( 400, 0.65 * u )
		speedW = Math.max( speedW, ctx.measureText( unitText ).width )

		var items = []

		if ( hasCompass ) items.push( { kind: "compass", w: DIAL_SIZE * u } )
		items.push( { kind: "left", w: COL_MIN_WIDTH * u } )
		items.push( { kind: "arrowL", w: ARROW_SIZE * u } )
		items.push( { kind: "speed", w: speedW } )
		items.push( { kind: "arrowR", w: ARROW_SIZE * u } )
		items.push( { kind: "right", w: COL_MIN_WIDTH * u } )
		if ( hasGMeter ) items.push( { kind: "gmeter", w: DIAL_SIZE * u } )

		var contentW = items.reduce( function( s, it ) { return s + it.w }, 0 )
		var minGapsW = PANEL_GAP * u * ( items.length - 1 )
		var panelW = Math.min( opts.width, Math.max( PANEL_MIN_WIDTH * u, contentW + minGapsW + PANEL_PAD_X * 2 * u ) )
		var innerH = DIAL_SIZE * u
		var panelH = innerH + PANEL_PAD_Y * 2 * u
		var panelX = ( opts.width - panelW ) / 2
		var panelY = opts.height - PANEL_BOTTOM * u - panelH
		var innerY = panelY + PANEL_PAD_Y * u
		var midY = innerY + innerH / 2
		// justify-content: space-between
		var gap = items.length > 1 ? ( panelW - PANEL_PAD_X * 2 * u - contentW ) / ( items.length - 1 ) : 0

		ctx.fillStyle = PANEL_BG
		roundRectPath( ctx, panelX, panelY, panelW, panelH, PANEL_RADIUS * u )
		ctx.fill()

		var x = panelX + PANEL_PAD_X * u

		items.forEach( function( it )
		{
			var cx = x + it.w / 2

			switch ( it.kind )
			{
				case "compass":
					drawCompass( ctx, x, midY - it.w / 2, it.w, view.headingDeg )
					break
				case "left":
					ctx.fillStyle = WHITE
					ctx.textAlign = "center"
					ctx.textBaseline = "top"
					ctx.font = font( 700, 1.35 * u )
					ctx.fillText( view.gear || "—", cx, innerY )
					drawPedal( ctx, cx - 0.625 * u, innerY + innerH - 2.25 * u, 1.25 * u, 2.25 * u, view.brake )
					break
				case "arrowL":
					drawArrow( ctx, x, midY - it.w / 2, it.w, LEFT_ARROW, view.blinkerLeft, opts.videoTime )
					break
				case "arrowR":
					drawArrow( ctx, x, midY - it.w / 2, it.w, RIGHT_ARROW, view.blinkerRight, opts.videoTime )
					break
				case "speed":
					var blockH = 1.75 * u + 0.65 * u * 1.5
					var top = midY - blockH / 2

					ctx.fillStyle = WHITE
					ctx.textAlign = "center"
					ctx.textBaseline = "top"
					ctx.font = font( 600, 1.75 * u )
					ctx.fillText( speedText, cx, top )
					ctx.globalAlpha = 0.9
					ctx.font = font( 400, 0.65 * u )
					ctx.fillText( unitText, cx, top + 1.75 * u + 0.65 * u * 0.25 )
					ctx.globalAlpha = 1
					break
				case "right":
					drawWheel( ctx, cx - 0.8 * u, innerY, 1.6 * u, view.autopilotOn, view.wheelAngle )
					drawThrottle( ctx, cx - 0.625 * u, innerY + innerH - 2 * u, 1.25 * u, 2 * u, view.throttlePct || 0, u )
					break
				case "gmeter":
					drawGMeter( ctx, x, midY - it.w / 2, it.w, view.gMeter )
					break
			}

			x += it.w + gap
		} )

		ctx.restore()
	}

	return {
		drawDashHud: drawDashHud,
		isBlinkVisible: isBlinkVisible
	}
} ) );
