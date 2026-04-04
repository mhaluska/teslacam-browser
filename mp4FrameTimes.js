( function ( root, factory )
{
	if ( typeof define === "function" && define.amd ) define( [ "fs" ], factory );
	else if ( typeof exports === "object" ) module.exports = factory( require( "fs" ) );
	else root.mp4FrameTimes = factory( root.fs );
}( typeof self !== "undefined" ? self : this, function ( fs )
{
	const TAIL_BYTES = 4 * 1024 * 1024;

	function readTail( fullPath )
	{
		var stat = fs.statSync( fullPath );
		var fd = fs.openSync( fullPath, "r" );

		try
		{
			var start = Math.max( 0, stat.size - TAIL_BYTES );
			var len = stat.size - start;
			var buf = Buffer.alloc( len );

			fs.readSync( fd, buf, 0, len, start );

			return buf
		}
		finally
		{
			fs.closeSync( fd )
		}
	}

	function readAtoms( data, start, end, typeWanted )
	{
		var out = [];
		var pos = start;

		while ( pos + 8 <= end )
		{
			var size32 = data.readUInt32BE( pos );
			var typ = data.toString( "ascii", pos + 4, pos + 8 );
			var header = 8;
			var atomSize = size32;

			if ( size32 === 1 )
			{
				atomSize = Number( data.readBigUInt64BE( pos + 8 ) );
				header = 16
			}

			if ( atomSize < header || pos + atomSize > end )
			{
				pos += 1;
				continue
			}

			var bodyStart = pos + header;
			var bodyEnd = pos + atomSize;

			if ( typ === typeWanted ) out.push( data.subarray( bodyStart, bodyEnd ) );

			if ( typ === "moov" || typ === "trak" || typ === "mdia" || typ === "minf" || typ === "stbl" || typ === "edts" || typ === "dinf" )
				out = out.concat( readAtoms( data, bodyStart, bodyEnd, typeWanted ) );

			pos += atomSize
		}

		return out
	}

	function parseMdhdTimescale( mdhdBody )
	{
		if ( mdhdBody.length < 20 ) return null;

		var ver = mdhdBody[ 0 ];

		if ( ver === 0 )
		{
			if ( mdhdBody.length < 20 ) return null;

			return mdhdBody.readUInt32BE( 12 )
		}

		if ( mdhdBody.length < 32 ) return null;

		return mdhdBody.readUInt32BE( 20 )
	}

	function isVideoTrak( trakBody, data )
	{
		var hdlrs = readAtoms( trakBody, 0, trakBody.length, "hdlr" );

		for ( var i = 0; i < hdlrs.length; i++ )
		{
			var b = hdlrs[ i ];

			if ( b.length >= 12 && b.toString( "ascii", 8, 12 ) === "vide" ) return true
		}

		return false
	}

	function parseStts( sttsBody, timescale )
	{
		if ( sttsBody.length < 12 || !timescale ) return null;

		var entryCount = sttsBody.readUInt32BE( 4 );
		var off = 8;
		var starts = [];
		var totalTicks = 0;
		var frame = 0;

		for ( var e = 0; e < entryCount; e++ )
		{
			if ( off + 8 > sttsBody.length ) break;

			var sampleCount = sttsBody.readUInt32BE( off );
			var delta = sttsBody.readUInt32BE( off + 4 );

			off += 8;

			for ( var s = 0; s < sampleCount; s++ )
			{
				starts.push( totalTicks / timescale );
				totalTicks += delta;
				frame++
			}
		}

		if ( starts.length < 1 ) return null;

		return { frameStartSec: Float64Array.from( starts ), frameCount: starts.length, mediaDurationSec: totalTicks / timescale }
	}

	function getVideoFrameStartTimesSec( fullPath )
	{
		try
		{
			var data = readTail( fullPath );
			var traks = readAtoms( data, 0, data.length, "trak" );

			for ( var t = 0; t < traks.length; t++ )
			{
				var trak = traks[ t ];

				if ( !isVideoTrak( trak, data ) ) continue;

				var mdhds = readAtoms( trak, 0, trak.length, "mdhd" );
				var timescale = null;

				for ( var m = 0; m < mdhds.length; m++ )
				{
					timescale = parseMdhdTimescale( mdhds[ m ] );

					if ( timescale ) break
				}

				if ( !timescale ) continue;

				var sttss = readAtoms( trak, 0, trak.length, "stts" );

				if ( !sttss.length ) continue;

				var parsed = parseStts( sttss[ 0 ], timescale );

				if ( parsed ) return parsed
			}
		}
		catch ( e )
		{
			console.log( "mp4FrameTimes:", e.message || e )
		}

		return null
	}

	return {
		getVideoFrameStartTimesSec: getVideoFrameStartTimesSec
	};
} ) );
