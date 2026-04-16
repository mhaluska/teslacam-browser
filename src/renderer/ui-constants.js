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

	return {
		CAM_GRID_TOP: CAM_GRID_TOP,
		CAM_GRID_BOTTOM: CAM_GRID_BOTTOM,
		CAM_GRID_ALL: CAM_GRID_ALL,
		DURATION_MATCH_EPSILON_SEC: DURATION_MATCH_EPSILON_SEC
	}
} ) );
