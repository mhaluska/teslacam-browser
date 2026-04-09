( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [ "./helpers", "fs", "path", "express", "serve-index" ], factory );
	else if ( typeof exports === 'object' ) module.exports = factory( require( "./helpers" ), require( "fs" ), require( "path" ), require( "express" ), require( "serve-index" ) );
	else root.services = factory( root.helpers, root.fs, root.path, root.express, root.serveIndex );
}( typeof self !== 'undefined' ? self : this, function ( helpers, fs, path, express, serveIndex )
{
	const seiTelemetry = require( "./seiTelemetry" )
	const auth = require( "./auth" )
	const helmet = require( "helmet" )
	const rateLimit = require( "express-rate-limit" )
	const crypto = require( "crypto" )

	const expressApp = express()
	var version = "0.0.1"
	var lastArgs = { version: version, folder: "" }
	var clipTelemetryCache = new Map()
	var clipTelemetryCacheKeySuffix = "\0tSecV2"
	var videosMounted = false
	var csrfCookieName = "tc_csrf"
	var csrfHeaderName = "x-csrf-token"
	var trustProxy = parseTrustProxySetting( process.env.TC_TRUST_IP )
	var csrfSecret = process.env.TC_CSRF_SECRET || crypto.randomBytes( 32 ).toString( "hex" )
	/** When true (default), delete UI is hidden and delete API returns 403. Set TC_HIDE_DELETE_BUTTONS=false to allow deletes. */
	var hideDeleteButtons = parseBoolean( process.env.TC_HIDE_DELETE_BUTTONS, true )

	function parseBoolean( value, fallback )
	{
		if ( value == null ) return fallback
		if ( value === true || value === false ) return value
		if ( typeof value !== "string" ) return fallback

		var v = value.trim().toLowerCase()
		if ( [ "1", "true", "yes", "on" ].includes( v ) ) return true
		if ( [ "0", "false", "no", "off" ].includes( v ) ) return false

		return fallback
	}

	function parseTrustProxySetting( value )
	{
		if ( typeof value !== "string" ) return false

		var entries = value
			.split( "," )
			.map( s => s.trim() )
			.filter( s => s.length > 0 )

		if ( entries.length < 1 ) return false
		if ( entries.length === 1 ) return entries[ 0 ]

		return entries
	}

	function normalizeInitializeOptions( options )
	{
		if ( !options || typeof options !== "object" )
			return { headless: false }

		return {
			headless: parseBoolean( options.headless, false )
		}
	}

	function attachAccessLoggingMiddleware( app )
	{
		app.use( ( request, response, next ) =>
		{
			var start = process.hrtime()

			response.on( "finish", () =>
			{
				var elapsed = process.hrtime( start )
				var durationMs = elapsed[ 0 ] * 1000 + elapsed[ 1 ] / 1000000
				var contentLength = response.getHeader( "content-length" )
				var entry = {
					ts: new Date().toISOString(),
					method: request.method,
					path: request.path || ( request.originalUrl || "" ).split( "?" )[ 0 ],
					status: response.statusCode,
					durationMs: Math.round( durationMs * 1000 ) / 1000,
					ip: request.ip,
					forwardedFor: request.get( "x-forwarded-for" ) || undefined,
					userAgent: request.get( "user-agent" ) || undefined,
					referer: request.get( "referer" ) || undefined,
					contentLength: contentLength != null ? String( contentLength ) : undefined
				}

				console.log( JSON.stringify( entry ) )
			} )

			next()
		} )
	}

	function getCookieOptions( request )
	{
		return {
			path: "/",
			sameSite: "Lax",
			httpOnly: false,
			secure: auth.shouldUseSecureCookie( request )
		}
	}

	function parseCookies( header )
	{
		var cookies = {}
		if ( !header ) return cookies

		header.split( ";" ).forEach( function( part )
		{
			var eq = part.indexOf( "=" )
			if ( eq < 0 ) return

			var key = part.substring( 0, eq ).trim()
			var val = part.substring( eq + 1 ).trim()

			try { cookies[ key ] = decodeURIComponent( val ) }
			catch ( _e ) { cookies[ key ] = val }
		} )

		return cookies
	}

	function ensureRootFolder()
	{
		if ( !lastArgs.folder || typeof lastArgs.folder !== "string" )
			throw new Error( "no_root_folder" )

		return path.resolve( lastArgs.folder )
	}

	function sanitizeRelativePath( raw, allowEmpty )
	{
		if ( typeof raw !== "string" ) throw new Error( "invalid_path" )
		var rel = raw.replace( /^[/\\]+/, "" ).trim()
		if ( path.isAbsolute( rel ) ) throw new Error( "absolute_path_not_allowed" )
		if ( !allowEmpty && !rel.length ) throw new Error( "invalid_path" )

		return rel
	}

	function resolveWithinRoot( raw, allowEmpty )
	{
		var root = ensureRootFolder()
		var rel = sanitizeRelativePath( raw, !!allowEmpty )
		var resolved = rel.length ? path.resolve( root, rel ) : root
		var relCheck = path.relative( root, resolved )

		if ( relCheck.startsWith( ".." ) || path.isAbsolute( relCheck ) )
			throw new Error( "path_outside_root" )

		return { root: root, relative: rel, resolved: resolved }
	}

	function getRequestRelativePath( request )
	{
		return decodeURIComponent( request.path || "" )
	}

	function ensureCsrfCookie( request, response )
	{
		var cookies = parseCookies( request.headers.cookie )
		var current = cookies[ csrfCookieName ]

		if ( current ) return current

		var token = crypto.createHmac( "sha256", csrfSecret )
			.update( String( Date.now() ) + "|" + String( Math.random() ) )
			.digest( "base64url" )

		response.cookie( csrfCookieName, token, getCookieOptions( request ) )
		return token
	}

	function requireCsrf( request, response, next )
	{
		if ( !auth.isEnabled() ) return next()

		var cookies = parseCookies( request.headers.cookie )
		var cookieToken = cookies[ csrfCookieName ]
		var headerToken = request.get( csrfHeaderName )

		if ( !cookieToken || !headerToken || cookieToken !== headerToken )
			return response.status( 403 ).json( { error: "csrf_invalid" } )

		next()
	}

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
		var target = resolveWithinRoot( p )
		var files = fs.readdirSync( target.resolved )

		return Array.from( helpers.groupFiles( target.relative, files, getVideoPath ) )
	}

	function readEventJson( relativeFolder )
	{
		if ( !lastArgs.folder || typeof relativeFolder !== "string" || !relativeFolder.length ) return null

		try
		{
			var target = resolveWithinRoot( relativeFolder )
			var resolvedFile = path.join( target.resolved, "event.json" )

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

		try
		{
			var target = resolveWithinRoot( relativeFilePath )
			var resolvedFile = target.resolved

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
		if ( !Array.isArray( files ) || files.length < 1 )
			throw new Error( "invalid_paths" )

		var resolvedItems = files.map( f => resolveWithinRoot( f ) )
		var root = ensureRootFolder()
		var parentFolder = path.dirname( resolvedItems[ 0 ].resolved )

		if ( parentFolder === root ) throw new Error( "refusing_root_level_delete" )

		for ( var item of resolvedItems )
		{
			if ( path.dirname( item.resolved ) !== parentFolder )
				throw new Error( "mixed_folders_not_allowed" )
		}

		var resolvedFiles = resolvedItems.map( i => i.resolved )

		console.log( `Deleting files: ${resolvedFiles}` )

		for ( var file of resolvedFiles ) fs.unlinkSync( file )

		console.log( `Deleted files: ${resolvedFiles}` )

		var remaining = fs.readdirSync( parentFolder )

		if ( remaining.length < 1 )
		{
			console.log( `Deleting folder: ${parentFolder}` )

			fs.rmdirSync( parentFolder )

			console.log( `Deleted folder: ${parentFolder}` )
		}
	}

	function deleteFolder( folder )
	{
		var target = resolveWithinRoot( folder )
		if ( target.resolved === target.root ) throw new Error( "refusing_root_delete" )

		var folderPath = target.resolved
		var files = fs.readdirSync( folderPath )

		deleteFiles( files.map( f => path.join( target.relative, f ) ) )
		return true
	}

	function copyFilePaths( filePaths )
	{
		return filePaths.map( f => `"${resolveWithinRoot( f ).resolved}"` ).join( " " )
	}

	function copyPath( folderPath )
	{
		return resolveWithinRoot( folderPath, true ).resolved
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

		var folderDisplay = folder.replace( /[/\\]+$/, "" )

		return {
			folder: folder,
			folderDisplay: folderDisplay,
			folderInfos: folderInfos,
			dateGroups: Array.from( dateGroups ),
            dates: dates,
            parsedFolder: parsedFolder,
			folderPathParts: folderPathParts,
			subfolders: subfolders,
			version: version,
			hideDeleteButtons: hideDeleteButtons
        }
    }

    function initializeExpress( port, options )
    {
		var initializeOptions = normalizeInitializeOptions( options )

		function serveVideos( args )
		{
			lastArgs = args

			console.log( ` ${args.folder}` )

			if ( !videosMounted )
			{
				expressApp.use(
					"/videos",
					express.static( args.folder ) )
				videosMounted = true
			}

			return args
		}

		var loginLimiter = rateLimit(
			{
				windowMs: 10 * 60 * 1000,
				max: parseInt( process.env.TC_LOGIN_MAX_ATTEMPTS || "10", 10 ),
				standardHeaders: true,
				legacyHeaders: false
			} )
		var deleteLimiter = rateLimit(
			{
				windowMs: 60 * 1000,
				max: parseInt( process.env.TC_DELETE_MAX_PER_MINUTE || "20", 10 ),
				standardHeaders: true,
				legacyHeaders: false
			} )
		var enableHelmet = parseBoolean( process.env.TC_ENABLE_HELMET, true )
		var enableCspUpgradeInsecureRequests = parseBoolean( process.env.TC_CSP_UPGRADE_INSECURE_REQUESTS, false )

		expressApp.set( "trust proxy", trustProxy )
        expressApp.use( express.urlencoded( { extended: false } ) )
		expressApp.use( express.json( { limit: "1mb" } ) )
		if ( initializeOptions.headless ) attachAccessLoggingMiddleware( expressApp )

		if ( enableHelmet )
		{
			expressApp.use( helmet(
				{
					contentSecurityPolicy:
					{
						directives:
						{
							defaultSrc: [ "'self'" ],
							scriptSrc: [ "'self'", "'unsafe-inline'", "'unsafe-eval'" ],
							scriptSrcAttr: [ "'unsafe-inline'" ],
							scriptSrcElem: [ "'self'", "'unsafe-inline'", "'unsafe-eval'" ],
							styleSrc: [ "'self'", "'unsafe-inline'" ],
							imgSrc: [ "'self'", "data:" ],
							fontSrc: [ "'self'", "data:" ],
							connectSrc: [ "'self'" ],
							frameSrc: [ "'self'", "https://www.openstreetmap.org" ],
							upgradeInsecureRequests: enableCspUpgradeInsecureRequests ? [] : null,
							objectSrc: [ "'none'" ],
							baseUri: [ "'self'" ],
							frameAncestors: [ "'none'" ]
						}
					},
					crossOriginEmbedderPolicy: false
				} ) )
		}

        expressApp.get( "/login", auth.loginPageHandler )
        expressApp.post( "/login", loginLimiter, auth.loginHandler )
		expressApp.get( "/csrf", ( request, response ) => response.json( { token: ensureCsrfCookie( request, response ) } ) )
        expressApp.post( "/logout", requireCsrf, auth.logoutHandler )
        expressApp.get( "/auth-enabled", ( request, response ) => response.json( { enabled: auth.isEnabled() } ) )

        if ( auth.isEnabled() )
        {
            console.log( " Authentication enabled" )
            expressApp.use( auth.middleware )
        }

        expressApp.get( "/", ( request, response ) => response.sendFile( __dirname + "/external.html" ) )
        expressApp.get( "/reopenFolders", ( request, response ) => response.send( reopenFolders() ) )
        expressApp.get( "/args", ( request, response ) => response.send( args() ) )
		expressApp.get( "/openDefaultFolder", ( request, response ) =>
		{
			try { response.send( serveVideos( openFolder() ) ) }
			catch ( _e ) { response.status( 400 ).json( { error: "invalid_root" } ) }
		} )
		expressApp.use( "/copyFilePaths", ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request )
				response.send( copyFilePaths( [ rel ] ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.use( "/copyPath", ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request )
				response.send( copyPath( rel ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.use( "/files", ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request )
				response.send( getFiles( rel, p => "videos/" + p ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.use( "/eventJson", ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request )
				response.json( readEventJson( rel ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.use( "/clipTelemetry", ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request )
				response.json( readClipTelemetry( rel ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { success: false, error: "invalid_path", samples: [] } )
			}
		} )

        expressApp.post( "/deleteFiles", deleteLimiter, requireCsrf, ( request, response ) =>
        {
            if ( hideDeleteButtons )
                return response.status( 403 ).json( { error: "delete_disabled" } )

            var paths = request.body && request.body.paths

            if ( !Array.isArray( paths ) )
                return response.status( 400 ).send( "Expected JSON object { paths: string[] }" )

            try
            {
                for ( var p of paths ) if ( typeof p !== "string" || !p.length ) return response.status( 400 ).send( "Each path must be a non-empty string" )
                deleteFiles( paths )
                response.sendStatus( 200 )
            }
            catch ( e )
            {
                console.log( e )
                response.status( 400 ).json( { error: "invalid_path_or_delete_failed" } )
            }
        } )

        expressApp.post( "/deleteFolder", deleteLimiter, requireCsrf, ( request, response ) =>
        {
            if ( hideDeleteButtons )
                return response.status( 403 ).json( { error: "delete_disabled" } )

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
                response.status( 400 ).json( { error: "invalid_path_or_delete_failed" } )
            }
        } )

		expressApp.get( "/content/app.css", ( request, response ) => response.sendFile( __dirname + "/app.css" ) )
		expressApp.get( "/content/helpers.js", ( request, response ) => response.sendFile( __dirname + "/helpers.js" ) )
		expressApp.get( "/content/ui.js", ( request, response ) => response.sendFile( __dirname + "/ui.js" ) )
		expressApp.get( "/content/favicon.svg", ( request, response ) => response.sendFile( __dirname + "/favicon.svg" ) )
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
