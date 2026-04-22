const crypto = require( "crypto" )
const logger = require( "./logger" )

const AUTH_USER = process.env.TC_AUTH_USER
const AUTH_PASS_HASH = process.env.TC_AUTH_PASS_HASH
const AUTH_SECRET = process.env.TC_AUTH_SECRET || crypto.randomBytes( 32 ).toString( "hex" )
const SESSION_DAYS = parseFloat( process.env.TC_SESSION_DAYS ) || 7
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000
const COOKIE_NAME = "tc_session"
const COOKIE_SECURE = ( process.env.TC_COOKIE_SECURE || "auto" ).toLowerCase()
const SCRYPT_ONLY_HINT = "TC_AUTH_PASS_HASH must use scrypt$N$r$p$saltBase64$dkBase64 format. Generate with: npm run hash-password"
const SCRYPT_PREFIX = "scrypt$"
const MIN_SALT_BYTES = 16
const MAX_SALT_BYTES = 128
const MIN_DK_BYTES = 16
const MAX_DK_BYTES = 128
const MAX_SCRYPT_N = 1 << 20
const MAX_SCRYPT_R = 32
const MAX_SCRYPT_P = 16
let warnedInvalidPasswordHash = false

function escapeHtml( str )
{
    if ( typeof str !== "string" ) return ""
    return str
        .replace( /&/g, "&amp;" )
        .replace( /</g, "&lt;" )
        .replace( />/g, "&gt;" )
        .replace( /"/g, "&quot;" )
        .replace( /'/g, "&#39;" )
}

function shouldUseSecureCookie( req )
{
    if ( COOKIE_SECURE === "true" || COOKIE_SECURE === "1" ) return true
    if ( COOKIE_SECURE === "false" || COOKIE_SECURE === "0" ) return false

    return !!( req && req.secure )
}

function isEnabled()
{
    return !!( AUTH_USER && AUTH_PASS_HASH )
}

function parseScryptHash( encoded )
{
    if ( typeof encoded !== "string" || !encoded.startsWith( SCRYPT_PREFIX ) ) return null

    const parts = encoded.split( "$" )
    if ( parts.length !== 6 || parts[ 0 ] !== "scrypt" ) return null

    const n = parseInt( parts[ 1 ], 10 )
    const r = parseInt( parts[ 2 ], 10 )
    const p = parseInt( parts[ 3 ], 10 )

    if ( !Number.isInteger( n ) || !Number.isInteger( r ) || !Number.isInteger( p ) ) return null
    if ( n < 2 || ( n & ( n - 1 ) ) !== 0 || n > MAX_SCRYPT_N ) return null
    if ( r < 1 || r > MAX_SCRYPT_R ) return null
    if ( p < 1 || p > MAX_SCRYPT_P ) return null

    let salt
    let expected
    try
    {
        salt = Buffer.from( parts[ 4 ], "base64" )
        expected = Buffer.from( parts[ 5 ], "base64" )
    }
    catch ( _e )
    {
        return null
    }

    if ( salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES ) return null
    if ( expected.length < MIN_DK_BYTES || expected.length > MAX_DK_BYTES ) return null

    return { n, r, p, salt, expected }
}

function verifyPasswordHash( password )
{
    if ( typeof password !== "string" || typeof AUTH_PASS_HASH !== "string" ) return false

    const scryptHash = parseScryptHash( AUTH_PASS_HASH )

    if ( scryptHash )
    {
        try
        {
            const maxmem = Math.max( 32 * 1024 * 1024, 256 * scryptHash.n * scryptHash.r * scryptHash.p )
            const derived = crypto.scryptSync(
                password,
                scryptHash.salt,
                scryptHash.expected.length,
                { N: scryptHash.n, r: scryptHash.r, p: scryptHash.p, maxmem: maxmem } )

            return crypto.timingSafeEqual( derived, scryptHash.expected )
        }
        catch ( _e )
        {
            return false
        }
    }

    if ( !warnedInvalidPasswordHash )
    {
        warnedInvalidPasswordHash = true
        logger.warn( "auth_pass_hash_invalid_format", { hint: SCRYPT_ONLY_HINT } )
    }

    return false
}

function sign( payload )
{
    const hmac = crypto.createHmac( "sha256", AUTH_SECRET ).update( payload ).digest( "base64url" )
    return payload + "." + hmac
}

function verify( cookie )
{
    if ( !cookie || typeof cookie !== "string" ) return null

    const dotIndex = cookie.lastIndexOf( "." )
    if ( dotIndex < 0 ) return null

    const payload = cookie.substring( 0, dotIndex )
    const signature = cookie.substring( dotIndex + 1 )

    const expected = crypto.createHmac( "sha256", AUTH_SECRET ).update( payload ).digest( "base64url" )

    if ( expected.length !== signature.length ) return null

    const valid = crypto.timingSafeEqual(
        Buffer.from( expected ),
        Buffer.from( signature )
    )

    if ( !valid ) return null

    const parts = payload.split( "|" )
    if ( parts.length !== 2 ) return null

    const [ username, expiryStr ] = parts
    const expiry = parseInt( expiryStr, 10 )

    if ( isNaN( expiry ) || Date.now() > expiry ) return null
    if ( username !== AUTH_USER ) return null

    return { username, expiry }
}

function parseCookies( header )
{
    const cookies = {}
    if ( !header ) return cookies

    header.split( ";" ).forEach( function( part )
    {
        const eq = part.indexOf( "=" )
        if ( eq < 0 ) return

        const key = part.substring( 0, eq ).trim()
        const val = part.substring( eq + 1 ).trim()

        try { cookies[ key ] = decodeURIComponent( val ) }
        catch ( _e ) { cookies[ key ] = val }
    } )

    return cookies
}

function middleware( req, res, next )
{
    // Whitelist paths that don't require auth
    if ( req.path === "/login" || req.path === "/auth-enabled" || req.path === "/csrf" ) return next()
    if ( req.path.startsWith( "/share/" ) ) return next()
    if ( req.path === "/node_modules/bootstrap/dist/css/bootstrap.min.css" ) return next()
    if ( req.path === "/node_modules/bootstrap-icons/font/bootstrap-icons.css" ) return next()
    if ( req.path.startsWith( "/node_modules/bootstrap-icons/font/fonts/" ) ) return next()
    if ( req.path === "/content/app.css" ) return next()
    if ( req.path === "/content/favicon.svg" ) return next()
    if ( req.path === "/content/login-theme.js" ) return next()
    if ( req.method === "POST" && req.path === "/logout" ) return next()

    const cookies = parseCookies( req.headers.cookie )
    const session = verify( cookies[ COOKIE_NAME ] )

    if ( session )
    {
        req.user = session
        return next()
    }

    // AJAX requests get 401, browser requests get redirected
    if ( req.xhr || ( req.headers.accept && req.headers.accept.indexOf( "application/json" ) >= 0 ) )
    {
        return res.status( 401 ).json( { error: "unauthorized" } )
    }

    res.redirect( "/login" )
}

function loginPage( error )
{
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TeslaCam Browser - Login</title>
  <link rel="icon" type="image/svg+xml" href="content/favicon.svg">
  <link rel="stylesheet" href="node_modules/bootstrap/dist/css/bootstrap.min.css" />
  <link rel="stylesheet" href="node_modules/bootstrap-icons/font/bootstrap-icons.css" />
  <link rel="stylesheet" href="content/app.css" />
  <style>
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .login-card { width: 100%; max-width: 380px; }
    .login-heading { font-size: 1.5rem; font-weight: 600; }
  </style>
  <script src="content/login-theme.js"></script>
</head>
<body>
  <div class="login-card">
    <div class="card">
      <div class="card-body p-4">
        <div class="text-center mb-4">
          <span class="bi bi-camera-video" style="font-size: 2rem;"></span>
          <div class="login-heading mt-2">TeslaCam Browser</div>
        </div>
        ${ error ? '<div class="alert alert-danger" role="alert">' + escapeHtml( error ) + '</div>' : '' }
        <form method="POST" action="/login">
          <div class="form-group">
            <label for="username">Username</label>
            <input type="text" class="form-control" id="username" name="username" required autofocus>
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" class="form-control" id="password" name="password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block mt-4">Sign In</button>
        </form>
      </div>
    </div>
  </div>
</body>
</html>`
}

function loginPageHandler( req, res )
{
    res.send( loginPage( null ) )
}

function loginHandler( req, res )
{
    if ( !isEnabled() )
    {
        return res.status( 503 ).send( loginPage( "Authentication is not configured on this server." ) )
    }

    const username = req.body && req.body.username
    const password = req.body && req.body.password

    if ( !username || !password )
    {
        return res.send( loginPage( "Please enter username and password." ) )
    }

    // Timing-safe comparison for both username and password hash
    const hashMatch = verifyPasswordHash( password )

    const userMatch = username.length === AUTH_USER.length &&
        crypto.timingSafeEqual( Buffer.from( username ), Buffer.from( AUTH_USER ) )

    if ( !hashMatch || !userMatch )
    {
        return res.send( loginPage( "Invalid username or password." ) )
    }

    const expiry = Date.now() + SESSION_MS
    const payload = username + "|" + expiry
    const cookie = sign( payload )

    res.cookie( COOKIE_NAME, cookie, {
        httpOnly: true,
        sameSite: "Lax",
        secure: shouldUseSecureCookie( req ),
        maxAge: SESSION_MS,
        path: "/"
    } )

    res.redirect( "/" )
}

function logoutHandler( req, res )
{
    res.clearCookie( COOKIE_NAME, { path: "/", sameSite: "Lax", httpOnly: true, secure: shouldUseSecureCookie( req ) } )
    res.redirect( "/login" )
}

module.exports = {
    isEnabled,
    middleware,
    loginPageHandler,
    loginHandler,
    logoutHandler,
    shouldUseSecureCookie
}
