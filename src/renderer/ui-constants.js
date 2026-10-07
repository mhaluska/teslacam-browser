( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.uiConstants = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
	var CAM_GRID_TOP = [ "left_pillar", "front", "right_pillar" ]
	var CAM_GRID_BOTTOM = [ "right_repeater", "back", "left_repeater" ]
	var CAM_GRID_ALL = CAM_GRID_TOP.concat( CAM_GRID_BOTTOM )

	/** Seconds — when a follower camera's currentTime drifts further than this from the leader's
	 *  shared clock during play, the follower is re-seeked. Wide enough to absorb decoder jitter
	 *  and timeupdate scheduling slack (timeupdate fires ~every 250ms in Chrome) without spurious
	 *  seeks; tight enough that a ~1s decoder stall is corrected on the next leader timeupdate. */
	var DRIFT_CORRECTION_THRESHOLD_SEC = 0.25

	/** Seconds per frame-step. 1/30 covers both 30fps and 36fps footage without falling short of a frame. */
	var FRAME_STEP_SECONDS = 1 / 30
	var FRAME_STEP_LARGE_MULTIPLIER = 10

	/** Map tiles: OpenStreetMap's standard layer needs no API key. Its tile usage policy
	 *  requires a Referer, so tiles opt back in to one (the app page itself sends none). */
	var MAP_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
	var MAP_TILE_OPTIONS = {
		maxZoom: 19,
		referrerPolicy: "strict-origin-when-cross-origin",
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
	}

	return {
		CAM_GRID_TOP: CAM_GRID_TOP,
		CAM_GRID_BOTTOM: CAM_GRID_BOTTOM,
		CAM_GRID_ALL: CAM_GRID_ALL,
		DRIFT_CORRECTION_THRESHOLD_SEC: DRIFT_CORRECTION_THRESHOLD_SEC,
		FRAME_STEP_SECONDS: FRAME_STEP_SECONDS,
		FRAME_STEP_LARGE_MULTIPLIER: FRAME_STEP_LARGE_MULTIPLIER,
		MAP_TILE_URL: MAP_TILE_URL,
		MAP_TILE_OPTIONS: MAP_TILE_OPTIONS
	}
} ) );
