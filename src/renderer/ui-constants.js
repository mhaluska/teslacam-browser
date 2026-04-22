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

	/** Seconds — camera durations differ slightly per file; only the longest track(s) should drive timespan.currentTime. */
	var DURATION_MATCH_EPSILON_SEC = 0.03

	/** Seconds per frame-step. 1/30 covers both 30fps and 36fps footage without falling short of a frame. */
	var FRAME_STEP_SECONDS = 1 / 30
	var FRAME_STEP_LARGE_MULTIPLIER = 10

	return {
		CAM_GRID_TOP: CAM_GRID_TOP,
		CAM_GRID_BOTTOM: CAM_GRID_BOTTOM,
		CAM_GRID_ALL: CAM_GRID_ALL,
		DURATION_MATCH_EPSILON_SEC: DURATION_MATCH_EPSILON_SEC,
		FRAME_STEP_SECONDS: FRAME_STEP_SECONDS,
		FRAME_STEP_LARGE_MULTIPLIER: FRAME_STEP_LARGE_MULTIPLIER
	}
} ) );
