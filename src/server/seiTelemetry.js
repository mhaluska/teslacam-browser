( function ( root, factory )
{
	if ( typeof define === "function" && define.amd ) define( [ "fs", "path", "protobufjs" ], factory );
	else if ( typeof exports === "object" ) module.exports = factory( require( "fs" ), require( "path" ), require( "protobufjs" ) );
	else root.seiTelemetry = factory( root.fs, root.path, root.protobuf );
}( typeof self !== "undefined" ? self : this, function ( fs, path, protobuf )
{
	const logger = typeof require === "function" ? require( "./logger" ) : null;
	const protoPath = path.join( __dirname, "dashcam.proto" );
	var SeiMetadata = null;

	async function ensureProtoLoaded()
	{
		if ( SeiMetadata ) return

		var root = await protobuf.load( protoPath )

		SeiMetadata = root.lookupType( "SeiMetadata" )
	}

	const NAL_ID_SEI = 6;
	const NAL_SEI_ID_USER_DATA_UNREGISTERED = 5;

	const GEAR_LABELS = [ "P", "D", "R", "N" ];
	const AUTOPILOT_LABELS = [ "NONE", "SELF_DRIVING", "AUTOSTEER", "TACC" ];

	const TAIL_BYTES = 4 * 1024 * 1024;


	// --- MP4 atom / frame-time helpers (formerly mp4FrameTimes.js) ---

	async function readTail( fullPath )
	{
		var fh = await fs.promises.open( fullPath, "r" )

		try
		{
			var stat = await fh.stat()
			var start = Math.max( 0, stat.size - TAIL_BYTES )
			var len = stat.size - start
			var buf = Buffer.alloc( len )

			await fh.read( buf, 0, len, start )

			return buf
		}
		finally
		{
			await fh.close()
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

	function isVideoTrak( trakBody )
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

	async function getVideoFrameStartTimesSec( fullPath )
	{
		try
		{
			var data = await readTail( fullPath );
			var traks = readAtoms( data, 0, data.length, "trak" );

			for ( var t = 0; t < traks.length; t++ )
			{
				var trak = traks[ t ];

				if ( !isVideoTrak( trak ) ) continue;

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
			if ( logger ) logger.warn( "sei_telemetry_frame_times_failed", { error: e } )
		}

		return null
	}


	// --- SEI telemetry extraction ---

	/** Tesla sends accelerator as 0–1 ratio or 0–100 percent; normalize to 0–1 for the UI. */
	function normalizeAcceleratorPedal( v )
	{
		if ( typeof v !== "number" || !isFinite( v ) ) return null

		if ( v >= 0 && v <= 1 ) return Math.max( 0, Math.min( 1, v ) )

		if ( v > 1 && v <= 100 ) return Math.max( 0, Math.min( 1, v / 100 ) )

		if ( v > 100 ) return 1

		if ( v < 0 ) return 0

		return null
	}

	function stripEmulationPrevention( data )
	{
		var out = [];
		var zeroCount = 0;

		for ( var i = 0; i < data.length; i++ )
		{
			var byte = data[ i ];

			if ( zeroCount >= 2 && byte === 0x03 )
			{
				zeroCount = 0;
				continue;
			}

			out.push( byte );
			zeroCount = byte !== 0 ? 0 : zeroCount + 1;
		}

		return Buffer.from( out );
	}

	function extractProtoPayload( nal )
	{
		if ( !nal || nal.length < 4 ) return null;

		for ( var i = 3; i < nal.length - 1; i++ )
		{
			var byte = nal[ i ];

			if ( byte === 0x42 ) continue;

			if ( byte === 0x69 )
			{
				if ( i > 2 )
				{
					var raw = nal.subarray( i + 1, nal.length - 1 );

					return stripEmulationPrevention( raw );
				}

				break;
			}

			break;
		}

		return null;
	}

	function isAvcSeiUserDataUnregistered( nal )
	{
		if ( nal.length < 2 ) return false;

		return ( nal[ 0 ] & 0x1f ) === NAL_ID_SEI && nal[ 1 ] === NAL_SEI_ID_USER_DATA_UNREGISTERED;
	}

	function decodeSample( payload )
	{
		try
		{
			// protobufjs exposes decoded fields in camelCase, not snake_case from .proto
			var msg = SeiMetadata.decode( payload );
			var g = msg.gearState;
			var a = msg.autopilotState;
			var fsq = msg.frameSeqNo;

			return {
				gear: typeof g === "number" && g >= 0 && g <= 3 ? GEAR_LABELS[ g ] : null,
				frameSeqNo: fsq != null ? fsq.toString() : null,
				speedKmh: typeof msg.vehicleSpeedMps === "number" ? Math.round( msg.vehicleSpeedMps * 3.6 ) : null,
				acceleratorPedal: normalizeAcceleratorPedal( msg.acceleratorPedalPosition ),
				steeringWheelAngle: typeof msg.steeringWheelAngle === "number" ? msg.steeringWheelAngle : null,
				blinkerLeft: !!msg.blinkerOnLeft,
				blinkerRight: !!msg.blinkerOnRight,
				brakeApplied: !!msg.brakeApplied,
				autopilot: typeof a === "number" && a >= 0 && a <= 3 ? AUTOPILOT_LABELS[ a ] : "NONE",
				latitudeDeg: typeof msg.latitudeDeg === "number" ? msg.latitudeDeg : null,
				longitudeDeg: typeof msg.longitudeDeg === "number" ? msg.longitudeDeg : null,
				headingDeg: typeof msg.headingDeg === "number" ? msg.headingDeg : null
			};
		}
		catch ( _e )
		{
			return null;
		}
	}

	async function findMdat( fh )
	{
		var pos = 0;
		var stat = await fh.stat();
		var fileSize = stat.size;

		while ( pos + 8 <= fileSize )
		{
			var header = Buffer.alloc( 8 );

			await fh.read( header, 0, 8, pos );

			var size32 = header.readUInt32BE( 0 );
			var atomType = header.toString( "ascii", 4, 8 );
			var headerSize = 8;
			var atomSize = size32;

			if ( size32 === 1 )
			{
				var large = Buffer.alloc( 8 );

				await fh.read( large, 0, 8, pos + 8 );

				atomSize = Number( large.readBigUInt64BE( 0 ) );
				headerSize = 16;
			}

			if ( atomSize < headerSize ) throw new Error( "invalid MP4 atom size" );

			if ( atomType === "mdat" ) return { offset: pos + headerSize, size: atomSize - headerSize };

			pos += atomSize;

			if ( atomSize === 0 ) break;
		}

		throw new Error( "mdat atom not found" );
	}

	async function parseMdatNals( fh, offset, size, onNalPayload )
	{
		var carry = Buffer.alloc( 0 );
		var chunkSize = 4 * 1024 * 1024;
		var readPos = 0;
		var videoFrameIdx = -1;
		var pendingSeiPayloads = [];

		function tryConsumeBuffer( buf )
		{
			var data = carry.length ? Buffer.concat( [ carry, buf ] ) : buf;
			var p = 0;

			while ( p + 4 <= data.length )
			{
				var nalSize = data.readUInt32BE( p );

				p += 4;

				if ( nalSize < 2 )
				{
					if ( p + nalSize > data.length )
					{
						carry = data.subarray( p - 4 );
						return;
					}

					p += nalSize;
					continue;
				}

				if ( p + nalSize > data.length )
				{
					carry = data.subarray( p - 4 );
					return;
				}

				var nal = data.subarray( p, p + nalSize );
				var nalType = nal[ 0 ] & 0x1f;

				p += nalSize;

				if ( nalType === 1 || nalType === 5 )
				{
					videoFrameIdx++;

					for ( var k = 0; k < pendingSeiPayloads.length; k++ )
						onNalPayload( pendingSeiPayloads[ k ], videoFrameIdx );

					pendingSeiPayloads = [];
				}
				else if ( isAvcSeiUserDataUnregistered( nal ) )
				{
					var protoBytes = extractProtoPayload( nal );

					if ( protoBytes && protoBytes.length ) pendingSeiPayloads.push( protoBytes );
				}
			}

			carry = data.subarray( p );
		}

		while ( readPos < size )
		{
			var toRead = Math.min( chunkSize, size - readPos );
			var chunk = Buffer.alloc( toRead );

			await fh.read( chunk, 0, toRead, offset + readPos );
			readPos += toRead;
			tryConsumeBuffer( chunk );
		}

		// Flush any trailing SEI payloads after the last frame
		for ( var k = 0; k < pendingSeiPayloads.length; k++ )
			onNalPayload( pendingSeiPayloads[ k ], videoFrameIdx >= 0 ? videoFrameIdx : 0 );
	}

	async function attachPresentationTimes( samples, fullPath )
	{
		if ( !samples || !samples.length ) return

		var timeline = await getVideoFrameStartTimesSec( fullPath )

		if ( !timeline || !timeline.frameStartSec || timeline.frameCount < 1 ) return

		var fc = timeline.frameCount
		var fst = timeline.frameStartSec

		for ( var j = 0; j < samples.length; j++ )
		{
			var fi = samples[ j ].frameIdx

			if ( fi != null && fi >= 0 && fi < fc )
			{
				samples[ j ].tSec = fst[ fi ]
			}
			else
			{
				var n = samples.length
				var fallbackFi = n === 1 ? 0 : Math.min( fc - 1, Math.floor( ( j + 0.5 ) * fc / n ) )

				samples[ j ].tSec = fst[ fallbackFi ]
			}
		}
	}

	async function extractSamplesFromFile( fullPath )
	{
		await ensureProtoLoaded()

		var samples = [];
		var fh = await fs.promises.open( fullPath, "r" );

		try
		{
			var mdat = await findMdat( fh );

			await parseMdatNals( fh, mdat.offset, mdat.size, function( payload, frameIdx )
			{
				var sample = decodeSample( payload );

				if ( sample )
				{
					sample.frameIdx = frameIdx;
					samples.push( sample );
				}
			} );
		}
		finally
		{
			await fh.close();
		}

		await attachPresentationTimes( samples, fullPath );

		return samples;
	}

	return {
		extractSamplesFromFile: extractSamplesFromFile,
		normalizeAcceleratorPedal: normalizeAcceleratorPedal
	};
} ) );
