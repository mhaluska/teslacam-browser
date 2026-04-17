( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.helpers = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
	const folderRegex = /(?<y>\d+)-(?<m>\d+)-(?<d>\d+)_(?<h>\d+)-(?<mm>\d+)(?:-(?<s>\d+))?$/;
	const clipRegex = /(?<y>\d+)-(?<m>\d+)-(?<d>\d+)_(?<h>\d+)-(?<mm>\d+)(?:-(?<s>\d+))?-(?<c>.*).mp4$/;

	function matchRegex( regex, value )
	{
		return regex.exec( value );
	}

	var matchFolder = ( folder ) => matchRegex( folderRegex, folder )
	var matchClip = ( file ) => matchRegex( clipRegex, file )

	function extractDate( match )
	{
		var year = Number( match.groups[ "y" ] )
		var month = Number( match.groups[ "m" ] ) - 1
		var day = Number( match.groups[ "d" ] )
		var hour = Number( match.groups[ "h" ] )
		var minute = Number( match.groups[ "mm" ] )
		var second = match.groups[ "s" ] ? Number( match.groups[ "s" ] ) : 0

		return new Date( year, month, day, hour, minute, second )
	}

	function groupBy( list, keyGetter )
	{
		const map = new Map();

		list.forEach( ( item ) =>
		{
			const key = keyGetter( item );
			const collection = map.get( key );

			if ( !collection ) map.set( key, [ item ] );
			else collection.push(item);
		});

		return map;
	}

	function groupFiles( folder, files, getVideoPath )
	{
		var fileInfos = []

		if ( files )
		{
			for ( var file of files )
			{
				var match = matchClip( file )

				if ( match && match.length > 0 )
				{
					var date = extractDate( match )
					var camera = match.groups[ "c" ]
					var filePath = folder + "/" + file // path.join( folder, file )

					fileInfos.push(
						{
							date: date,
							camera: camera,
							file: getVideoPath( filePath ),
							filePath: filePath,
							fileName: file
						} )
				}
			}

			fileInfos.sort( ( f1, f2 ) => f1.date.getTime() - f2.date.getTime() )
		}

		return groupBy( fileInfos, f => f.date.toString() )
	}

	function isInViewport( elem )
	{
		var bounding = elem.getBoundingClientRect()

		return (
			bounding.top >= 0 &&
			bounding.left >= 0 &&
			bounding.bottom <= ( window.innerHeight || document.documentElement.clientHeight ) &&
			bounding.right <= ( window.innerWidth || document.documentElement.clientWidth )
		)
	}

	const eventTimestampRegex = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/

	function parseEventTimestamp( s )
	{
		if ( typeof s !== "string" ) return null

		var m = eventTimestampRegex.exec( s )
		if ( !m ) return null

		return new Date(
			Number( m[ 1 ] ),
			Number( m[ 2 ] ) - 1,
			Number( m[ 3 ] ),
			Number( m[ 4 ] ),
			Number( m[ 5 ] ),
			Number( m[ 6 ] ) )
	}

	function humanizeReason( s )
	{
		if ( s == null || s === "" ) return ""

		var text = String( s ).replace( /_/g, " " )

		return text.charAt( 0 ).toUpperCase() + text.slice( 1 )
	}

	function computeTriggerOffsetSeconds( timespans, triggerDate )
	{
		if ( !Array.isArray( timespans ) || timespans.length < 1 ) return null
		if ( !( triggerDate instanceof Date ) || isNaN( triggerDate.getTime() ) ) return null

		var triggerMs = triggerDate.getTime()
		var cumulative = 0

		for ( var ts of timespans )
		{
			var duration = Number( ts.duration )
			if ( !isFinite( duration ) || duration <= 0 ) return null

			var startMs = ts.time instanceof Date ? ts.time.getTime() : new Date( ts.time ).getTime()
			if ( isNaN( startMs ) ) return null

			var endMs = startMs + duration * 1000

			if ( triggerMs >= startMs && triggerMs < endMs )
			{
				return cumulative + ( triggerMs - startMs ) / 1000
			}

			cumulative += duration
		}

		return null
	}

	return {
		matchFolder: matchFolder,
		matchClip: matchClip,
		extractDate: extractDate,
		groupBy: groupBy,
		groupFiles: groupFiles,
		isInViewport: isInViewport,
		parseEventTimestamp: parseEventTimestamp,
		humanizeReason: humanizeReason,
		computeTriggerOffsetSeconds: computeTriggerOffsetSeconds
	}
} ) );
