( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [ "./helpers", "fs", "path", "express", "serve-index" ], factory );
	else if ( typeof exports === 'object' ) module.exports = factory( require( "./helpers" ), require( "fs" ), require( "path" ), require( "express" ), require( "serve-index" ) );
	else root.services = factory( root.helpers, root.fs, root.path, root.express, root.serveIndex );
}( typeof self !== 'undefined' ? self : this, function ( helpers, fs, path, express, serveIndex )
{
	const seiTelemetry = require( "./seiTelemetry" )
	const auth = require( "./auth" )
	const logger = require( "./logger" )
	const helmet = require( "helmet" )
	const compression = require( "compression" )
	const rateLimit = require( "express-rate-limit" )
	const crypto = require( "crypto" )
	const net = require( "net" )

	function LruCache( maxSize )
	{
		this._max = maxSize
		this._map = new Map()
	}

	LruCache.prototype.get = function( key )
	{
		if ( !this._map.has( key ) ) return undefined

		var value = this._map.get( key )

		this._map.delete( key )
		this._map.set( key, value )

		return value
	}

	LruCache.prototype.set = function( key, value )
	{
		if ( this._map.has( key ) ) this._map.delete( key )

		this._map.set( key, value )

		if ( this._map.size > this._max )
		{
			var oldest = this._map.keys().next().value

			this._map.delete( oldest )
		}
	}

	const expressApp = express()
	var version = "0.0.1"
	var lastArgs = { version: version, folder: "" }
	var clipTelemetryCache = new LruCache( 200 )
	var clipTelemetryCacheKeySuffix = "\0tSecV2"
	var videosMounted = false
	var expressInitialized = false
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

	function isValidTrustProxyEntry( entry )
	{
		if ( entry === "loopback" || entry === "linklocal" || entry === "uniquelocal" ) return true

		var slash = entry.indexOf( "/" )
		if ( slash < 0 ) return net.isIP( entry ) !== 0

		var base = entry.slice( 0, slash )
		var prefix = entry.slice( slash + 1 )
		var family = net.isIP( base )
		if ( family === 0 ) return false
		if ( !/^\d+$/.test( prefix ) ) return false

		var n = Number( prefix )
		var max = family === 4 ? 32 : 128

		return n >= 0 && n <= max
	}

	function parseTrustProxySetting( value )
	{
		if ( typeof value !== "string" ) return false

		var trimmed = value.trim().toLowerCase()
		if ( trimmed === "true" ) return true
		if ( trimmed === "false" ) return false
		if ( /^\d+$/.test( trimmed ) ) return Number( trimmed )

		var entries = value
			.split( "," )
			.map( s => s.trim() )
			.filter( s => s.length > 0 )

		var valid = entries.filter( isValidTrustProxyEntry )
		var invalid = entries.filter( e => !isValidTrustProxyEntry( e ) )

		if ( invalid.length ) logger.warn( "trust_proxy_invalid_entries", { invalid: invalid } )

		if ( valid.length === 0 ) return false
		if ( valid.length === 1 ) return valid[ 0 ]

		return valid
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

				logger.info( "http_access", entry )
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

	function getRequestRelativePath( request, mountPath )
	{
		// Express already decodes request.path; resolveWithinRoot validates traversal.
		var p = request.path || ""
		if ( mountPath && p.indexOf( mountPath ) === 0 ) p = p.slice( mountPath.length )
		return p
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
		logger.info( "version_set", { version: v } )
    }

	function setFolder( f )
	{
		lastArgs.folder = f
		logger.info( "root_folder_set", { folder: f } )
	}

	async function reopenFolders()
	{
		if ( !lastArgs ) return lastArgs

		if ( lastArgs.folders && lastArgs.folders.length > 0 )
			return await openFolders( lastArgs.folders )

		if ( lastArgs.folder )
		{
			Object.assign( lastArgs, await openFolder( lastArgs.folder ) )
			return lastArgs
		}

		return lastArgs
	}

	async function openFolders( folders )
	{
		if ( folders && folders.length > 0 )
		{
            var folder = folders[ 0 ] + "/"

            Object.assign( lastArgs, await openFolder( folder ) )

			logger.info( "serve_content_folder", { folder: folder, source: "openFolders" } )

			expressApp.use(
				"/videos",
				express.static( folder, { maxAge: "7d" } ),
				serveIndex( folder, { 'icons': true } ) )
		}

		return lastArgs
	}

	function args()
	{
		return lastArgs
	}

	async function getFiles( p, getVideoPath )
	{
		var target = resolveWithinRoot( p )
		var files = await fs.promises.readdir( target.resolved )

		return Array.from( helpers.groupFiles( target.relative, files, getVideoPath ) )
	}

	async function readEventJson( relativeFolder )
	{
		if ( !lastArgs.folder || typeof relativeFolder !== "string" || !relativeFolder.length ) return null

		try
		{
			var target = resolveWithinRoot( relativeFolder )
			var resolvedFile = path.join( target.resolved, "event.json" )

			try { await fs.promises.access( resolvedFile ) }
			catch ( _e ) { return null }

			var content = await fs.promises.readFile( resolvedFile, "utf8" )

			return JSON.parse( content )
		}
		catch ( e )
		{
			logger.warn( "read_event_json_failed", { error: e } )
			return null
		}
	}

	async function readClipTelemetry( relativeFilePath )
	{
		if ( !lastArgs.folder || typeof relativeFilePath !== "string" || !relativeFilePath.length )
			return { error: "no_folder" }

		try
		{
			var target = resolveWithinRoot( relativeFilePath )
			var resolvedFile = target.resolved

			try { await fs.promises.access( resolvedFile ) }
			catch ( _e ) { return { error: "not_found" } }

			var stat = await fs.promises.stat( resolvedFile )
			var cacheKey = resolvedFile + clipTelemetryCacheKeySuffix
			var cached = clipTelemetryCache.get( cacheKey )

			if ( cached && cached.mtimeMs === stat.mtimeMs )
				return cached.result

			var samples = await seiTelemetry.extractSamplesFromFile( resolvedFile )

			var result = { samples: samples }

			clipTelemetryCache.set( cacheKey, { mtimeMs: stat.mtimeMs, result: result } )

			return result
		}
		catch ( e )
		{
			logger.warn( "read_clip_telemetry_failed", { error: e } )

			return { error: String( e.message || e ) }
		}
	}


	async function deleteFiles( files )
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

		logger.info( "delete_files_started", { files: resolvedFiles } )

		for ( var file of resolvedFiles ) await fs.promises.unlink( file )

		logger.info( "delete_files_completed", { files: resolvedFiles } )

		var remaining = await fs.promises.readdir( parentFolder )

		if ( remaining.length < 1 )
		{
			logger.info( "delete_folder_started", { folder: parentFolder } )

			await fs.promises.rmdir( parentFolder )

			logger.info( "delete_folder_completed", { folder: parentFolder } )
		}
	}

	async function deleteFolder( folder )
	{
		var target = resolveWithinRoot( folder )
		if ( target.resolved === target.root ) throw new Error( "refusing_root_delete" )

		var folderPath = target.resolved
		var files = await fs.promises.readdir( folderPath )

		await deleteFiles( files.map( f => path.join( target.relative, f ) ) )
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

	async function openFolder( folder )
	{
		if ( !folder ) folder = lastArgs.folder

		var specialFolders = [ "TeslaCam", "SavedClips", "RecentClips", "SentryClips", "TeslaSentry" ]
		var folderInfos = []

		async function addSubfolders( baseFolder )
		{
			try
			{
				var entries = await fs.promises.readdir( baseFolder, { withFileTypes: true } )

				for ( var entry of entries )
				{
					var subfolder = entry.name

					if ( specialFolders.includes( subfolder ) )
					{
						await addSubfolders( path.join( baseFolder, subfolder ) )
					}
					else
					{
						var match = helpers.matchFolder( subfolder )

						if ( match && match.length > 0 )
						{
							var date = helpers.extractDate( match )
							var folderPath = path.join( baseFolder, subfolder )
							var relative = path.relative( folder, folderPath )

							folderInfos.push( { date: date, path: folderPath, relative: relative, recent: false } )
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
			catch ( e )
			{
				logger.warn( "openfolder_readdir_failed", { folder: baseFolder, error: e } )
			}
		}

		folder = path.normalize( ( folder || "" ) + path.sep )

		await addSubfolders( folder )

		var dateGroups = helpers.groupBy( folderInfos, g => g.date.toDateString() )
		var dates = Array.from( dateGroups.keys() ).map( d => new Date( d ) )
		var parsedFolder = path.parse( folder )

		var folderNames = [ parsedFolder.root ]
			.concat( parsedFolder.dir.replace( parsedFolder.root, "" ).split( path.sep ) )
			.concat( [ parsedFolder.base ] )
			.filter( f => f.length > 0 )

		var folderPathParts = folderNames
			.map( ( f, i ) => { return { path: path.join( ...folderNames.slice( 0, i + 1 ) ), name: f } } )

		var subfolders = []

		try
		{
			var entries = await fs.promises.readdir( folder, { withFileTypes: true } )

			subfolders = entries
				.filter( function( entry ) { return entry.isDirectory() } )
				.map( function( entry ) { return { path: path.join( folder, entry.name ), name: entry.name } } )
		}
		catch ( e )
		{
			logger.warn( "openfolder_readdir_failed", { folder: folder, error: e } )
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
		if ( expressInitialized )
		{
			logger.warn( "initialize_express_skipped_already_initialized" )
			return
		}
		expressInitialized = true

		var initializeOptions = normalizeInitializeOptions( options )

		function serveVideos( args )
		{
			lastArgs = args

			logger.info( "serve_videos_folder", { folder: args.folder } )

			if ( !videosMounted )
			{
				expressApp.use(
					"/videos",
					express.static( args.folder, { maxAge: "7d" } ) )
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
		var apiLimiter = rateLimit(
			{
				windowMs: 60 * 1000,
				max: parseInt( process.env.TC_API_MAX_PER_MINUTE || "600", 10 ),
				standardHeaders: true,
				legacyHeaders: false
			} )
		var enableHelmet = parseBoolean( process.env.TC_ENABLE_HELMET, true )
		var enableCspUpgradeInsecureRequests = parseBoolean( process.env.TC_CSP_UPGRADE_INSECURE_REQUESTS, false )

		expressApp.set( "trust proxy", trustProxy )
		expressApp.use( compression() )
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
							// 'unsafe-eval' kept: Vue compiles string templates at runtime via new Function.
							scriptSrc: [ "'self'", "'unsafe-eval'" ],
							scriptSrcAttr: [ "'none'" ],
							scriptSrcElem: [ "'self'", "'unsafe-eval'" ],
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
            logger.info( "authentication_enabled" )
            expressApp.use( auth.middleware )
        }

        expressApp.get( "/", ( request, response ) => response.sendFile( __dirname + "/external.html" ) )
        expressApp.get( "/reopenFolders", apiLimiter, async ( request, response ) =>
		{
			try { response.send( await reopenFolders() ) }
			catch ( _e ) { response.status( 400 ).json( { error: "reopen_failed" } ) }
		} )
        expressApp.get( "/args", ( request, response ) => response.send( args() ) )
		expressApp.get( "/openDefaultFolder", apiLimiter, async ( request, response ) =>
		{
			try { response.send( serveVideos( await openFolder() ) ) }
			catch ( _e ) { response.status( 400 ).json( { error: "invalid_root" } ) }
		} )
		expressApp.get( /^\/copyFilePaths(?:\/.*)?$/, apiLimiter, ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request, "/copyFilePaths" )
				response.send( copyFilePaths( [ rel ] ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.get( /^\/copyPath(?:\/.*)?$/, apiLimiter, ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request, "/copyPath" )
				response.send( copyPath( rel ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.get( /^\/files(?:\/.*)?$/, apiLimiter, async ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request, "/files" )
				response.send( await getFiles( rel, p => "videos/" + p ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.get( /^\/eventJson(?:\/.*)?$/, apiLimiter, async ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request, "/eventJson" )
				response.json( await readEventJson( rel ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )
		expressApp.get( /^\/clipTelemetry(?:\/.*)?$/, apiLimiter, async ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request, "/clipTelemetry" )
				response.json( await readClipTelemetry( rel ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )

        expressApp.post( "/deleteFiles", deleteLimiter, requireCsrf, async ( request, response ) =>
        {
            if ( hideDeleteButtons )
                return response.status( 403 ).json( { error: "delete_disabled" } )

            var paths = request.body && request.body.paths

            if ( !Array.isArray( paths ) )
                return response.status( 400 ).send( "Expected JSON object { paths: string[] }" )

            try
            {
                for ( var p of paths ) if ( typeof p !== "string" || !p.length ) return response.status( 400 ).send( "Each path must be a non-empty string" )
                await deleteFiles( paths )
                response.sendStatus( 200 )
            }
            catch ( e )
            {
                logger.warn( "delete_files_route_failed", { error: e } )
                response.status( 400 ).json( { error: "invalid_path_or_delete_failed" } )
            }
        } )

        expressApp.post( "/deleteFolder", deleteLimiter, requireCsrf, async ( request, response ) =>
        {
            if ( hideDeleteButtons )
                return response.status( 403 ).json( { error: "delete_disabled" } )

            var rel = request.body && request.body.path

            if ( typeof rel !== "string" || !rel.length )
                return response.status( 400 ).send( "Expected JSON object { path: string }" )

            try
            {
                if ( !( await deleteFolder( rel ) ) )
                    return response.status( 400 ).send( "No root folder open or invalid path" )

                response.sendStatus( 200 )
            }
            catch ( e )
            {
                logger.warn( "delete_folder_route_failed", { error: e } )
                response.status( 400 ).json( { error: "invalid_path_or_delete_failed" } )
            }
        } )

		expressApp.get( "/content/app.css", ( request, response ) => response.sendFile( __dirname + "/app.css" ) )
		expressApp.get( "/content/helpers.js", ( request, response ) => response.sendFile( __dirname + "/helpers.js" ) )
		expressApp.get( "/content/ui-constants.js", ( request, response ) => response.sendFile( __dirname + "/ui-constants.js" ) )
		expressApp.get( "/content/ui.js", ( request, response ) => response.sendFile( __dirname + "/ui.js" ) )
		expressApp.get( "/content/external.js", ( request, response ) => response.sendFile( __dirname + "/external.js" ) )
		expressApp.get( "/content/favicon.svg", ( request, response ) => response.sendFile( __dirname + "/favicon.svg" ) )
		var libCacheHeaders = { "Cache-Control": "public, max-age=31536000, immutable" }
		expressApp.get( "/node_modules/flatpickr/dist/flatpickr.min.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/flatpickr/dist/flatpickr.min.css" ) } )
		expressApp.get( "/node_modules/flatpickr/dist/flatpickr.min.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/flatpickr/dist/flatpickr.min.js" ) } )
		expressApp.get( "/node_modules/bootstrap/dist/css/bootstrap.min.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/bootstrap/dist/css/bootstrap.min.css" ) } )
		expressApp.get( "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js" ) } )
		expressApp.get( "/node_modules/bootstrap-icons/font/bootstrap-icons.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/bootstrap-icons/font/bootstrap-icons.css" ) } )
		expressApp.get( "/node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2" ) } )
		expressApp.get( "/node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff" ) } )
		expressApp.get( "/node_modules/vue/dist/vue.global.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( __dirname + "/node_modules/vue/dist/vue.global.js" ) } )

        expressApp.listen( port, ( err ) =>
        {
            if (err)
            {
                return logger.error( "server_listen_failed", { port: port, error: err } )
            }
    
            logger.info( "server_listening", { port: port } )
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
