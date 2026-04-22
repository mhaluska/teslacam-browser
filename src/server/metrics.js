// Minimal Prometheus exposition format implementation.
// No external dependency: we just track counters + a fixed-bucket
// histogram in memory and serialize on demand.

var counters = new Map()        // key = name|labelString  -> { name, labels, value, help }
var histograms = new Map()      // key = name              -> { name, buckets, bucketCounts[], sum, count, help }

function labelString( labels )
{
	if ( !labels ) return ""
	var keys = Object.keys( labels ).sort()
	var parts = []
	for ( var i = 0; i < keys.length; i++ )
	{
		var v = labels[ keys[ i ] ]
		if ( v == null ) continue
		parts.push( keys[ i ] + '="' + String( v ).replace( /\\/g, "\\\\" ).replace( /"/g, '\\"' ).replace( /\n/g, "\\n" ) + '"' )
	}
	return parts.length ? "{" + parts.join( "," ) + "}" : ""
}

function incrementCounter( name, labels, value, help )
{
	var key = name + "|" + labelString( labels || {} )
	var entry = counters.get( key )

	if ( !entry )
	{
		entry = { name: name, labels: labels || {}, value: 0, help: help || "" }
		counters.set( key, entry )
	}

	entry.value += ( typeof value === "number" && isFinite( value ) ? value : 1 )
	if ( help && !entry.help ) entry.help = help
}

function defineHistogram( name, buckets, help )
{
	var existing = histograms.get( name )
	if ( existing ) return existing

	var sorted = ( buckets || [ 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5 ] ).slice().sort( function( a, b ) { return a - b } )
	var entry = {
		name: name,
		buckets: sorted,
		bucketCounts: new Array( sorted.length ).fill( 0 ),
		sum: 0,
		count: 0,
		help: help || ""
	}

	histograms.set( name, entry )
	return entry
}

function observeHistogram( name, valueSeconds )
{
	if ( typeof valueSeconds !== "number" || !isFinite( valueSeconds ) ) return

	var entry = histograms.get( name )
	if ( !entry ) entry = defineHistogram( name )

	entry.sum += valueSeconds
	entry.count += 1

	for ( var i = 0; i < entry.buckets.length; i++ )
	{
		if ( valueSeconds <= entry.buckets[ i ] ) entry.bucketCounts[ i ] += 1
	}
}

function escapeHelp( s )
{
	return String( s || "" ).replace( /\\/g, "\\\\" ).replace( /\n/g, "\\n" )
}

function render()
{
	var lines = []
	var counterNames = new Set()

	counters.forEach( function( entry )
	{
		if ( !counterNames.has( entry.name ) )
		{
			counterNames.add( entry.name )
			if ( entry.help ) lines.push( "# HELP " + entry.name + " " + escapeHelp( entry.help ) )
			lines.push( "# TYPE " + entry.name + " counter" )
		}

		lines.push( entry.name + labelString( entry.labels ) + " " + entry.value )
	} )

	histograms.forEach( function( entry )
	{
		if ( entry.help ) lines.push( "# HELP " + entry.name + " " + escapeHelp( entry.help ) )
		lines.push( "# TYPE " + entry.name + " histogram" )

		var cumulative = 0
		for ( var i = 0; i < entry.buckets.length; i++ )
		{
			cumulative = entry.bucketCounts[ i ]
			lines.push( entry.name + '_bucket{le="' + entry.buckets[ i ] + '"} ' + cumulative )
		}
		lines.push( entry.name + '_bucket{le="+Inf"} ' + entry.count )
		lines.push( entry.name + "_sum " + entry.sum )
		lines.push( entry.name + "_count " + entry.count )
	} )

	return lines.join( "\n" ) + "\n"
}

function reset()
{
	counters.clear()
	histograms.clear()
}

module.exports = {
	incrementCounter: incrementCounter,
	defineHistogram: defineHistogram,
	observeHistogram: observeHistogram,
	render: render,
	reset: reset
}
