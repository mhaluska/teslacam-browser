( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [ "../renderer/helpers", "fs", "path", "express" ], factory );
	else if ( typeof exports === 'object' ) module.exports = factory( require( "../renderer/helpers" ), require( "fs" ), require( "path" ), require( "express" ) );
	else root.services = factory( root.helpers, root.fs, root.path, root.express );
}( typeof self !== 'undefined' ? self : this, function ( helpers, fs, path, express )
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
	var clipTelemetryCacheKeySuffix = "\0tSecV4"
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

	/**
	 * Normalize a user-supplied path fragment into a safe relative path.
	 * Strips leading slashes (so Express-supplied "/foo/bar" is treated as
	 * relative), rejects anything Node considers absolute, and rejects empty
	 * strings unless explicitly allowed.
	 *
	 * @param {unknown} raw - caller-provided path fragment
	 * @param {boolean} [allowEmpty=false] - permit an empty result (means "root")
	 * @returns {string} sanitized relative path (may be empty when allowEmpty=true)
	 * @throws {Error} invalid_path | absolute_path_not_allowed
	 */
	function sanitizeRelativePath( raw, allowEmpty )
	{
		if ( typeof raw !== "string" ) throw new Error( "invalid_path" )
		var rel = raw.replace( /^[/\\]+/, "" ).trim()
		if ( path.isAbsolute( rel ) ) throw new Error( "absolute_path_not_allowed" )
		if ( !allowEmpty && !rel.length ) throw new Error( "invalid_path" )

		return rel
	}

	/**
	 * Resolve a caller-supplied relative path against the configured root and
	 * guarantee the result stays inside the root (path traversal guard).
	 *
	 * @param {unknown} raw - caller-provided path fragment
	 * @param {boolean} [allowEmpty=false] - treat empty as "the root"
	 * @returns {{ root: string, relative: string, resolved: string }}
	 * @throws {Error} invalid_path | absolute_path_not_allowed | path_outside_root | no_root_folder
	 */
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

	function requireDeletesEnabled( request, response, next )
	{
		if ( hideDeleteButtons ) return response.status( 403 ).json( { error: "delete_disabled" } )
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
				express.static( folder, { maxAge: "7d" } ) )
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

	async function readEventMetaForAbsoluteFolder( absoluteFolder )
	{
		var meta = { reason: null, hasThumb: false }

		if ( typeof absoluteFolder !== "string" || !absoluteFolder.length ) return meta

		try
		{
			var content = await fs.promises.readFile( path.join( absoluteFolder, "event.json" ), "utf8" )
			var parsed = JSON.parse( content )

			if ( parsed && typeof parsed.reason === "string" && parsed.reason.length ) meta.reason = parsed.reason
		}
		catch ( _e ) { /* missing or unreadable event.json — leave reason null */ }

		try
		{
			await fs.promises.access( path.join( absoluteFolder, "thumb.png" ) )
			meta.hasThumb = true
		}
		catch ( _e ) { /* no thumb.png — leave hasThumb false */ }

		return meta
	}

	async function runPool( items, limit, fn )
	{
		var i = 0

		async function worker()
		{
			while ( i < items.length )
			{
				var index = i++
				await fn( items[ index ] )
			}
		}

		var workers = []
		var n = Math.min( Math.max( 1, limit ), items.length )
		for ( var w = 0; w < n; w++ ) workers.push( worker() )

		await Promise.all( workers )
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

	async function readClipSeqSummary( relativeFilePath )
	{
		var res = await readClipTelemetry( relativeFilePath )

		if ( !res || res.error ) return res

		var samples = Array.isArray( res.samples ) ? res.samples : []

		if ( !samples.length ) return { sampleCount: 0, firstSeq: null, lastSeq: null, firstTSec: null, lastTSec: null }

		var first = samples[ 0 ]
		var last = samples[ samples.length - 1 ]

		function toNum( v )
		{
			if ( v == null ) return null

			var n = typeof v === "number" ? v : parseInt( v, 10 )

			return ( typeof n === "number" && isFinite( n ) ) ? n : null
		}

		return {
			sampleCount: samples.length,
			firstSeq: toNum( first.frameSeqNo ),
			lastSeq: toNum( last.frameSeqNo ),
			firstTSec: typeof first.tSec === "number" ? first.tSec : null,
			lastTSec: typeof last.tSec === "number" ? last.tSec : null
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

		invalidateDiskUsageCache()
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

	async function sumFolderBytes( folderPath )
	{
		var total = 0

		try
		{
			var entries = await fs.promises.readdir( folderPath, { withFileTypes: true } )

			for ( var entry of entries )
			{
				if ( entry.isFile() )
				{
					try
					{
						var s = await fs.promises.stat( path.join( folderPath, entry.name ) )
						total += s.size
					}
					catch ( _e ) { /* skip unreadable files */ }
				}
			}
		}
		catch ( e )
		{
			logger.warn( "disk_usage_readdir_failed", { folder: folderPath, error: e } )
		}

		return total
	}

	function reasonBucket( info )
	{
		var folder = ( info.relative || "" ).split( /[/\\]/ )[ 0 ]
		if ( info.reason ) return info.reason
		if ( folder === "RecentClips" || info.recent ) return "RecentClips"
		if ( folder === "SavedClips" ) return "SavedClips"
		if ( folder === "SentryClips" || folder === "TeslaSentry" ) return "SentryClips"
		return "Other"
	}

	var diskUsageCache = { folder: null, ts: 0, value: null }
	var DISK_USAGE_TTL_MS = 60 * 1000

	async function computeDiskUsage()
	{
		var opened = await openFolder()
		var cacheKey = opened.folder

		if ( diskUsageCache.folder === cacheKey
			&& diskUsageCache.value
			&& ( Date.now() - diskUsageCache.ts ) < DISK_USAGE_TTL_MS )
		{
			return diskUsageCache.value
		}

		var infos = opened.folderInfos || []
		var perInfo = new Array( infos.length )

		await runPool( infos, 8, async function( info )
		{
			var idx = infos.indexOf( info )
			perInfo[ idx ] = await sumFolderBytes( info.path )
		} )

		var totalBytes = 0
		var byReason = {}
		var byDayMap = new Map()
		var oldest = null
		var newest = null

		for ( var i = 0; i < infos.length; i++ )
		{
			var info = infos[ i ]
			var bytes = perInfo[ i ] || 0
			var reason = reasonBucket( info )
			var date = ( info.date instanceof Date ) ? info.date : new Date( info.date )
			var dayKey = isNaN( date.getTime() ) ? "unknown" : date.toISOString().slice( 0, 10 )

			totalBytes += bytes
			byReason[ reason ] = ( byReason[ reason ] || 0 ) + bytes

			var day = byDayMap.get( dayKey )
			if ( !day )
			{
				day = { date: dayKey, bytes: 0, byReason: {} }
				byDayMap.set( dayKey, day )
			}
			day.bytes += bytes
			day.byReason[ reason ] = ( day.byReason[ reason ] || 0 ) + bytes

			if ( !isNaN( date.getTime() ) )
			{
				if ( !oldest || date < oldest ) oldest = date
				if ( !newest || date > newest ) newest = date
			}
		}

		var byDay = Array.from( byDayMap.values() )
		byDay.sort( function( a, b ) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0 } )

		var value = {
			totalBytes: totalBytes,
			byReason: byReason,
			byDay: byDay,
			eventCount: infos.length,
			oldestDate: oldest ? oldest.toISOString() : null,
			newestDate: newest ? newest.toISOString() : null
		}

		diskUsageCache = { folder: cacheKey, ts: Date.now(), value: value }

		return value
	}

	function invalidateDiskUsageCache()
	{
		diskUsageCache = { folder: null, ts: 0, value: null }
	}

	async function cleanupOlderThan( days, reasons, options )
	{
		options = options || {}
		var dryRun = !!options.dryRun

		if ( typeof days !== "number" || !isFinite( days ) || days < 0 )
			throw new Error( "invalid_days" )
		if ( !Array.isArray( reasons ) || !reasons.length )
			throw new Error( "invalid_reasons" )

		var opened = await openFolder()
		var cutoff = Date.now() - days * 24 * 60 * 60 * 1000
		var candidates = ( opened.folderInfos || [] ).filter( info =>
		{
			var d = ( info.date instanceof Date ) ? info.date : new Date( info.date )
			if ( isNaN( d.getTime() ) ) return false
			if ( d.getTime() >= cutoff ) return false
			return reasons.indexOf( reasonBucket( info ) ) >= 0
		} )

		if ( dryRun )
		{
			var totalBytes = 0
			for ( var info of candidates ) totalBytes += await sumFolderBytes( info.path )

			return { dryRun: true, count: candidates.length, bytes: totalBytes, paths: candidates.map( i => i.relative ) }
		}

		var deleted = []
		var failed = []

		for ( var info of candidates )
		{
			try
			{
				await deleteFolder( info.relative )
				deleted.push( info.relative )
			}
			catch ( e )
			{
				failed.push( { path: info.relative, error: String( e && e.message ? e.message : e ) } )
			}
		}

		return { deleted: deleted, failed: failed }
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
								date = helpers.extractDate( clipMatch )
								var existing = folderInfos.find( i => i.path == baseFolder )

								if ( existing )
								{
									if ( date > existing.date ) existing.date = date
								}
								else
								{
									relative = path.relative( folder, baseFolder )

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

		await runPool( folderInfos, 16, async info =>
		{
			var meta = await readEventMetaForAbsoluteFolder( info.path )
			info.reason = meta.reason
			info.hasThumb = meta.hasThumb
		} )

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
							imgSrc: [ "'self'", "data:", "https://*.basemaps.cartocdn.com" ],
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

        expressApp.get( "/healthz", ( request, response ) => response.json( { ok: true } ) )
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

        expressApp.get( "/", ( request, response ) => response.sendFile( path.join( __dirname, "../renderer/external.html" ) ) )
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

		expressApp.post( "/cleanupOlderThan", requireDeletesEnabled, deleteLimiter, requireCsrf, async ( request, response ) =>
		{
			var days = request.body && request.body.days
			var reasons = request.body && request.body.reasons
			var dryRun = !!( request.body && request.body.dryRun )

			try
			{
				var result = await cleanupOlderThan( days, reasons, { dryRun: dryRun } )

				if ( !dryRun )
					logger.info( "cleanup_older_than_completed",
						{ days: days, reasons: reasons,
						  deleted: result.deleted.length, failed: result.failed.length } )

				response.json( result )
			}
			catch ( e )
			{
				var msg = String( e && e.message ? e.message : e )

				if ( msg === "invalid_days" || msg === "invalid_reasons" )
					return response.status( 400 ).json( { error: msg } )

				logger.warn( "cleanup_older_than_failed", { error: e } )
				response.status( 500 ).json( { error: "cleanup_failed" } )
			}
		} )

		expressApp.get( "/diskUsage", apiLimiter, async ( _request, response ) =>
		{
			try
			{
				response.json( await computeDiskUsage() )
			}
			catch ( e )
			{
				logger.warn( "disk_usage_route_failed", { error: e } )
				response.status( 500 ).json( { error: "disk_usage_failed" } )
			}
		} )

		expressApp.get( /^\/clipSeqSummary(?:\/.*)?$/, apiLimiter, async ( request, response ) =>
		{
			try
			{
				var rel = getRequestRelativePath( request, "/clipSeqSummary" )
				response.json( await readClipSeqSummary( rel ) )
			}
			catch ( _e )
			{
				response.status( 400 ).json( { error: "invalid_path" } )
			}
		} )

        expressApp.post( "/deleteFiles", requireDeletesEnabled, deleteLimiter, requireCsrf, async ( request, response ) =>
        {
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

        expressApp.post( "/deleteFolder", requireDeletesEnabled, deleteLimiter, requireCsrf, async ( request, response ) =>
        {
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

        expressApp.post( "/bulkDeleteFolders", requireDeletesEnabled, deleteLimiter, requireCsrf, async ( request, response ) =>
        {
            var paths = request.body && request.body.paths

            if ( !Array.isArray( paths ) || !paths.length )
                return response.status( 400 ).send( "Expected JSON object { paths: string[] }" )

            for ( var p of paths )
            {
                if ( typeof p !== "string" || !p.length )
                    return response.status( 400 ).send( "Each path must be a non-empty string" )
            }

            var deleted = []
            var failed = []

            for ( var rel of paths )
            {
                try
                {
                    await deleteFolder( rel )
                    deleted.push( rel )
                }
                catch ( e )
                {
                    failed.push( { path: rel, error: String( e && e.message ? e.message : e ) } )
                }
            }

            logger.info( "bulk_delete_completed", { requested: paths.length, deleted: deleted.length, failed: failed.length } )

            response.json( { deleted: deleted, failed: failed } )
        } )

		expressApp.use( "/content", express.static( path.join( __dirname, "../renderer" ) ) )
		var nodeModulesDir = path.join( __dirname, "../../node_modules" )
		var libCacheHeaders = { "Cache-Control": "public, max-age=31536000, immutable" }
		expressApp.get( "/node_modules/flatpickr/dist/flatpickr.min.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "flatpickr/dist/flatpickr.min.css" ) ) } )
		expressApp.get( "/node_modules/flatpickr/dist/flatpickr.min.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "flatpickr/dist/flatpickr.min.js" ) ) } )
		expressApp.get( "/node_modules/bootstrap/dist/css/bootstrap.min.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "bootstrap/dist/css/bootstrap.min.css" ) ) } )
		expressApp.get( "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "bootstrap/dist/js/bootstrap.bundle.min.js" ) ) } )
		expressApp.get( "/node_modules/bootstrap-icons/font/bootstrap-icons.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "bootstrap-icons/font/bootstrap-icons.css" ) ) } )
		expressApp.get( "/node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "bootstrap-icons/font/fonts/bootstrap-icons.woff2" ) ) } )
		expressApp.get( "/node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "bootstrap-icons/font/fonts/bootstrap-icons.woff" ) ) } )
		expressApp.get( "/node_modules/vue/dist/vue.global.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "vue/dist/vue.global.js" ) ) } )
		expressApp.get( "/node_modules/leaflet/dist/leaflet.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "leaflet/dist/leaflet.css" ) ) } )
		expressApp.get( "/node_modules/leaflet/dist/leaflet.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "leaflet/dist/leaflet.js" ) ) } )
		expressApp.use( "/node_modules/leaflet/dist/images", express.static( path.join( nodeModulesDir, "leaflet/dist/images" ), { maxAge: "365d", immutable: true } ) )
		expressApp.get( "/node_modules/uplot/dist/uPlot.min.css", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "uplot/dist/uPlot.min.css" ) ) } )
		expressApp.get( "/node_modules/uplot/dist/uPlot.iife.min.js", ( request, response ) => { response.set( libCacheHeaders ); response.sendFile( path.join( nodeModulesDir, "uplot/dist/uPlot.iife.min.js" ) ) } )

		// Terminal error handler. Catches anything that slipped past route-level try/catch.
		// Must have 4 args for Express to recognize it as an error handler.
		expressApp.use( ( err, request, response, _next ) =>
		{
			logger.error( "unhandled_request_error", {
				method: request.method,
				path: request.path,
				error: err
			} )

			if ( response.headersSent ) return

			response.status( 500 ).json( { error: "internal" } )
		} )

        var server = expressApp.listen( port, () =>
        {
            logger.info( "server_listening", { port: port } )
        } )
        server.on( "error", function ( err )
        {
            logger.error( "server_listen_failed", { port: port, error: err } )
            if ( initializeOptions.headless ) process.exit( 1 )
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
		readClipSeqSummary: readClipSeqSummary,
        deleteFiles: deleteFiles,
        copyFilePaths: copyFilePaths,
        deleteFolder: deleteFolder,
        copyPath: copyPath,
        computeDiskUsage: computeDiskUsage,
        cleanupOlderThan: cleanupOlderThan,
        initializeExpress: initializeExpress
	}
} ) );
