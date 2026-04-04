( function ( root, factory )
{
	if ( typeof define === "function" && define.amd ) define( [ "fs", "path", "protobufjs" ], factory );
	else if ( typeof exports === "object" ) module.exports = factory( require( "fs" ), require( "path" ), require( "protobufjs" ) );
	else root.seiTelemetry = factory( root.fs, root.path, root.protobuf );
}( typeof self !== "undefined" ? self : this, function ( fs, path, protobuf )
{
	const protoPath = path.join( __dirname, "dashcam.proto" );
	const root = protobuf.loadSync( protoPath );
	const SeiMetadata = root.lookupType( "SeiMetadata" );

	const NAL_ID_SEI = 6;
	const NAL_SEI_ID_USER_DATA_UNREGISTERED = 5;

	const GEAR_LABELS = [ "P", "D", "R", "N" ];
	const AUTOPILOT_LABELS = [ "NONE", "SELF_DRIVING", "AUTOSTEER", "TACC" ];

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

	function findMdat( fd )
	{
		var pos = 0;
		var stat = fs.fstatSync( fd );
		var fileSize = stat.size;

		while ( pos + 8 <= fileSize )
		{
			var header = Buffer.alloc( 8 );

			fs.readSync( fd, header, 0, 8, pos );

			var size32 = header.readUInt32BE( 0 );
			var atomType = header.toString( "ascii", 4, 8 );
			var headerSize = 8;
			var atomSize = size32;

			if ( size32 === 1 )
			{
				var large = Buffer.alloc( 8 );

				fs.readSync( fd, large, 0, 8, pos + 8 );

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

	function parseMdatNals( fd, offset, size, onNalPayload )
	{
		var carry = Buffer.alloc( 0 );
		var chunkSize = 4 * 1024 * 1024;
		var readPos = 0;

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

				p += nalSize;

				if ( isAvcSeiUserDataUnregistered( nal ) )
				{
					var protoBytes = extractProtoPayload( nal );

					if ( protoBytes && protoBytes.length ) onNalPayload( protoBytes );
				}
			}

			carry = data.subarray( p );
		}

		while ( readPos < size )
		{
			var toRead = Math.min( chunkSize, size - readPos );
			var chunk = Buffer.alloc( toRead );

			fs.readSync( fd, chunk, 0, toRead, offset + readPos );
			readPos += toRead;
			tryConsumeBuffer( chunk );
		}
	}

	function extractSamplesFromFile( fullPath )
	{
		var samples = [];
		var fd = fs.openSync( fullPath, "r" );

		try
		{
			var mdat = findMdat( fd );

			parseMdatNals( fd, mdat.offset, mdat.size, function( payload )
			{
				var sample = decodeSample( payload );

				if ( sample ) samples.push( sample );
			} );
		}
		finally
		{
			fs.closeSync( fd );
		}

		return samples;
	}

	return {
		extractSamplesFromFile: extractSamplesFromFile,
		normalizeAcceleratorPedal: normalizeAcceleratorPedal
	};
} ) );
