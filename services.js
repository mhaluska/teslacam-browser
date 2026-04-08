( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [ "./helpers", "fs", "path", "express", "serve-index" ], factory );
	else if ( typeof exports === 'object' ) module.exports = factory( require( "./helpers" ), require( "fs" ), require( "path" ), require( "express" ), require( "serve-index" ) );
	else root.services = factory( root.helpers, root.fs, root.path, root.express, root.serveIndex );
}( typeof self !== 'undefined' ? self : this, function ( helpers, fs, path, express, serveIndex )
{
	const seiTelemetry = require( "./seiTelemetry" )
	const auth = require( "./auth" )

	const expressApp = express()
	var version = "0.0.1"
	var lastArgs = { version: version, folder: "" }
	var clipTelemetryCache = new Map()
	var clipTelemetryCacheKeySuffix = "\0tSecV2"

    function setVersion( v )
    {
		version = v
		lastArgs.version = v
		console.log( "TeslaCam Browser version set to " + v )
    }

	function setFolder( f )
	{
		lastArgs.folder = f
		console.log( "Root folder set to " + f )
	}

	function reopenFolders()
	{
		if ( !lastArgs ) return lastArgs

		if ( lastArgs.folders && lastArgs.folders.length > 0 )
			return openFolders( lastArgs.folders )

		if ( lastArgs.folder )
		{
			Object.assign( lastArgs, openFolder( lastArgs.folder ) )
			return lastArgs
		}

		return lastArgs
	}

	function openFolders( folders )
	{
		if ( folders && folders.length > 0 )
		{
            var folder = folders[ 0 ] + "/"

            Object.assign( lastArgs, openFolder( folder ) )

			console.log( `OBSOLETE?: Serving content from ${folder}` )

			expressApp.use(
				"/videos",
				express.static( folder ),
				serveIndex( folder, { 'icons': true } ) )
		}

		return lastArgs
	}

	function args()
	{
		return lastArgs
	}

	function getFiles( p, getVideoPath )
	{
		var folder = path.join( lastArgs.folder, p )
		var files = fs.readdirSync( folder )

		return Array.from( helpers.groupFiles( p, files, getVideoPath ) )
	}

	function readEventJson( relativeFolder )
	{
		if ( !lastArgs.folder || typeof relativeFolder !== "string" || !relativeFolder.length )
			return null

		var rel = relativeFolder.replace( /^[/\\]+/, "" )

		if ( !rel.length ) return null

		var full = path.join( lastArgs.folder, rel, "event.json" )
		var resolvedRoot = path.resolve( lastArgs.folder )
		var resolvedFile = path.resolve( full )
		var relCheck = path.relative( resolvedRoot, resolvedFile )

		if ( relCheck.startsWith( ".." ) || path.isAbsolute( relCheck ) )
			return null

		try
		{
			if ( !fs.existsSync( resolvedFile ) ) return null

			return JSON.parse( fs.readFileSync( resolvedFile, "utf8" ) )
		}
		catch ( e )
		{
			console.log( e )
			return null
		}
	}

	function readClipTelemetry( relativeFilePath )
	{
		if ( !lastArgs.folder || typeof relativeFilePath !== "string" || !relativeFilePath.length )
			return { success: false, error: "no_folder", samples: [] }

		var rel = relativeFilePath.replace( /^[/\\]+/, "" )

		if ( !rel.length ) return { success: false, error: "bad_path", samples: [] }

		var full = path.join( lastArgs.folder, rel )
		var resolvedRoot = path.resolve( lastArgs.folder )
		var resolvedFile = path.resolve( full )
		var relCheck = path.relative( resolvedRoot, resolvedFile )

		if ( relCheck.startsWith( ".." ) || path.isAbsolute( relCheck ) )
			return { success: false, error: "invalid_path", samples: [] }

		try
		{
			if ( !fs.existsSync( resolvedFile ) ) return { success: false, error: "not_found", samples: [] }

			var stat = fs.statSync( resolvedFile )
			var cacheKey = resolvedFile + clipTelemetryCacheKeySuffix
			var cached = clipTelemetryCache.get( cacheKey )

			if ( cached && cached.mtimeMs === stat.mtimeMs )
				return cached.result

			var samples = seiTelemetry.extractSamplesFromFile( resolvedFile )

			var result = { success: true, samples: samples }

			clipTelemetryCache.set( cacheKey, { mtimeMs: stat.mtimeMs, result: result } )

			return result
		}
		catch ( e )
		{
			console.log( e )

			return { success: false, error: String( e.message || e ), samples: [] }
		}
	}


	function deleteFiles( files )
	{
		var resolvedFiles = files.map( f => path.join( lastArgs.folder, f ) )

		console.log( `Deleting files: ${resolvedFiles}` )

		for ( var file of resolvedFiles ) fs.unlinkSync( file )

		console.log( `Deleted files: ${resolvedFiles}` )

		var folderPath = path.dirname( resolvedFiles[ 0 ] )
		var remaining = fs.readdirSync( folderPath )

		if ( remaining.length < 1 )
		{
			console.log( `Deleting folder: ${folderPath}` )

			fs.rmdirSync( folderPath )

			console.log( `Deleted folder: ${folderPath}` )
		}
	}

	function deleteFolder( folder )
	{
		if ( !lastArgs.folder || typeof folder !== "string" || !folder.length )
		{
			console.log( `deleteFolder: invalid root or relative path (root=${lastArgs.folder}, folder=${folder})` )
			return false
		}

		var folderPath = path.join( lastArgs.folder, folder )
		var files = fs.readdirSync( folderPath )

		deleteFiles( files.map( f => path.join( folder, f ) ) )
		return true
	}

	function copyFilePaths( filePaths )
	{
		return filePaths.map( f => `"${path.join( lastArgs.folder, f )}"` ).join( " " )
	}

	function copyPath( folderPath )
	{
		return path.join( lastArgs.folder, folderPath )
	}

	function openFolder( folder )
	{
		if ( !folder ) folder = lastArgs.folder

		var specialFolders = [ "TeslaCam", "SavedClips", "RecentClips", "SentryClips", "TeslaSentry" ]
		var folderInfos = []

		function addSubfolders( baseFolder )
		{
			try
			{
				var subfolders = fs.readdirSync( baseFolder )

				for ( var subfolder of subfolders )
				{
					if ( specialFolders.includes( subfolder ) )
					{
						addSubfolders( path.join( baseFolder, subfolder ) )
					}
					else
					{
						var match = helpers.matchFolder( subfolder )
					
						if ( match && match.length > 0 )
						{
							function addFolder( match )
							{
								var date = helpers.extractDate( match )
								var folderPath = path.join( baseFolder, subfolder )
								var relative = path.relative( folder, folderPath )
						
								folderInfos.push( { date: date, path: folderPath, relative: relative, recent: false } )
							}

							addFolder( match )
						}
						else
						{
							var clipMatch = helpers.matchClip( subfolder )

							if ( clipMatch && clipMatch.length > 0 )
							{
								var date = helpers.extractDate( clipMatch )
								var existing = folderInfos.find( i => i.path == baseFolder )

								if ( existing )
								{
									if ( date > existing.date ) existing.date = date
								}
								else
								{
									var relative = path.relative( folder, baseFolder )

									folderInfos.push( { date: date, path: baseFolder, relative: relative, recent: true } )
								}
							}
						}
					}
				}
			}
			catch (e)
			{
			}
		}

		folder = path.normalize( ( folder || "" ) + path.sep )

		addSubfolders( folder )

		var dateGroups = helpers.groupBy( folderInfos, g => g.date.toDateString() )
		var dates = Array.from( dateGroups.keys() ).map( d => new Date( d ) )
		var parsedFolder = path.parse( folder )

		var folderNames = [ parsedFolder.root ]
			.concat( parsedFolder.dir.replace( parsedFolder.root, "" ).split( path.sep ) )
			.concat( [ parsedFolder.base ] )
			.filter( f => f.length > 0 )

		var folderPathParts = folderNames
			.map( ( f, i ) => { return { path: path.join( ...folderNames.slice( 0, i + 1 ) ), name: f } } )

		//console.log( parsedFolder )
		//console.log( folderNames )
		//console.log( folderPathParts )

		function isDirectory( p )
		{
			try
			{
				return fs.lstatSync( p ).isDirectory()
			}
			catch (e)
			{
				return false
			}
		}

		var subfolders = []

		try
		{
			subfolders = fs.readdirSync( folder )
				.map( f => { return { path: path.join( folder, f ), name: f } } )
				.filter( f => isDirectory( f.path ) )
		}
		catch (e)
		{
		}

		return {
			folder: folder,
			folderInfos: folderInfos,
			dateGroups: Array.from( dateGroups ),
            dates: dates,
            parsedFolder: parsedFolder,
			folderPathParts: folderPathParts,
			subfolders: subfolders,
			version: version
        }
    }

    function initializeExpress( port )
    {
		function serveVideos( args )
		{
			lastArgs = args

			console.log( ` ${args.folder}` )

			expressApp.use(
				"/videos",
				express.static( args.folder ),
				serveIndex( args.folder, { 'icons': true } ) )

			return args
		}

        expressApp.use( express.urlencoded( { extended: false } ) )

        expressApp.get( "/login", auth.loginPageHandler )
        expressApp.post( "/login", auth.loginHandler )
        expressApp.post( "/logout", auth.logoutHandler )
        expressApp.get( "/auth-enabled", ( request, response ) => response.json( { enabled: auth.isEnabled() } ) )

        if ( auth.isEnabled() )
        {
            console.log( " Authentication enabled" )
            expressApp.use( auth.middleware )
        }

        expressApp.get( "/", ( request, response ) => response.sendFile( __dirname + "/external.html" ) )
        expressApp.get( "/openFolders", ( request, response ) => response.send( openFolders() ) )
        expressApp.get( "/reopenFolders", ( request, response ) => response.send( reopenFolders() ) )
        expressApp.get( "/args", ( request, response ) => response.send( args() ) )
        expressApp.get( "/openDefaultFolder", ( request, response ) => response.send( serveVideos( openFolder() ) ) )
        expressApp.use( "/openFolder", ( request, response ) => response.send( serveVideos( openFolder( decodeURIComponent( request.path ) ) ) ) )
        expressApp.use( "/copyFilePaths", ( request, response ) => response.send( copyFilePaths( decodeURIComponent( request.path ) ) ) )
        expressApp.use( "/copyPath", ( request, response ) => response.send( copyPath( decodeURIComponent( request.path ) ) ) )
        expressApp.use( "/files", ( request, response ) => response.send( getFiles( decodeURIComponent( request.path ), p => "videos/" + p ) ) )
        expressApp.use( "/eventJson", ( request, response ) => response.json( readEventJson( decodeURIComponent( request.path ) ) ) )
        expressApp.use( "/clipTelemetry", ( request, response ) => response.json( readClipTelemetry( decodeURIComponent( request.path ) ) ) )

        expressApp.use( express.json( { limit: "1mb" } ) )

        expressApp.post( "/deleteFiles", ( request, response ) =>
        {
            var paths = request.body && request.body.paths

            if ( !Array.isArray( paths ) )
                return response.status( 400 ).send( "Expected JSON object { paths: string[] }" )

            try
            {
                deleteFiles( paths )
                response.sendStatus( 200 )
            }
            catch ( e )
            {
                console.log( e )
                response.status( 500 ).send( String( e ) )
            }
        } )

        expressApp.post( "/deleteFolder", ( request, response ) =>
        {
            var rel = request.body && request.body.path

            if ( typeof rel !== "string" || !rel.length )
                return response.status( 400 ).send( "Expected JSON object { path: string }" )

            try
            {
                if ( !deleteFolder( rel ) )
                    return response.status( 400 ).send( "No root folder open or invalid path" )

                response.sendStatus( 200 )
            }
            catch ( e )
            {
                console.log( e )
                response.status( 500 ).send( String( e ) )
            }
        } )

        expressApp.use( "/content", express.static( __dirname ) )
        expressApp.use( "/node_modules", express.static( __dirname + "/node_modules" ) )

        expressApp.listen( port, ( err ) =>
        {
            if (err)
            {
                return console.log( `Something bad happened`, err )
            }
    
            console.log( `Server is listening on port ${port}` )
        } )
    }

	return {
		setVersion: setVersion,
		setFolder: setFolder,
        openFolders: openFolders,
        reopenFolders: reopenFolders,
        openFolder: openFolder,
		args: args,
		getFiles: getFiles,
		readEventJson: readEventJson,
		readClipTelemetry: readClipTelemetry,
        deleteFiles: deleteFiles,
        copyFilePaths: copyFilePaths,
        deleteFolder: deleteFolder,
        copyPath: copyPath,
        initializeExpress: initializeExpress,
        openFolder: openFolder
	}
} ) );
