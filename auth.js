const crypto = require( "crypto" )

const AUTH_USER = process.env.TC_AUTH_USER
const AUTH_PASS_HASH = process.env.TC_AUTH_PASS_HASH
const AUTH_SECRET = process.env.TC_AUTH_SECRET || crypto.randomBytes( 32 ).toString( "hex" )
const SESSION_DAYS = parseFloat( process.env.TC_SESSION_DAYS ) || 7
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000
const COOKIE_NAME = "tc_session"

function isEnabled()
{
    return !!( AUTH_USER && AUTH_PASS_HASH )
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

        cookies[ key ] = decodeURIComponent( val )
    } )

    return cookies
}

function middleware( req, res, next )
{
    // Whitelist paths that don't require auth
    if ( req.path === "/login" || req.path === "/auth-enabled" ) return next()
    if ( req.path.startsWith( "/node_modules/" ) ) return next()
    if ( req.path === "/content/app.css" ) return next()
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
  <link rel="stylesheet" href="node_modules/open-iconic/font/css/open-iconic-bootstrap.css" />
  <link rel="stylesheet" href="content/app.css" />
  <style>
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .login-card { width: 100%; max-width: 380px; }
    .login-heading { font-size: 1.5rem; font-weight: 600; }
  </style>
  <script>
    (function() {
      var theme = localStorage.getItem("themePreference");
      if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
      else if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
      else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
        document.documentElement.setAttribute("data-theme", "dark");
    })();
  </script>
</head>
<body>
  <div class="login-card">
    <div class="card">
      <div class="card-body p-4">
        <div class="text-center mb-4">
          <span class="oi oi-video" style="font-size: 2rem;"></span>
          <div class="login-heading mt-2">TeslaCam Browser</div>
        </div>
        ${ error ? '<div class="alert alert-danger" role="alert">' + error + '</div>' : '' }
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
    const username = req.body && req.body.username
    const password = req.body && req.body.password

    if ( !username || !password )
    {
        return res.send( loginPage( "Please enter username and password." ) )
    }

    const inputHash = crypto.createHash( "sha256" ).update( password ).digest( "hex" )

    // Timing-safe comparison for both username and password hash
    const hashMatch = inputHash.length === AUTH_PASS_HASH.length &&
        crypto.timingSafeEqual( Buffer.from( inputHash ), Buffer.from( AUTH_PASS_HASH ) )

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
        maxAge: SESSION_MS,
        path: "/"
    } )

    res.redirect( "/" )
}

function logoutHandler( req, res )
{
    res.clearCookie( COOKIE_NAME, { path: "/" } )
    res.redirect( "/login" )
}

module.exports = {
    isEnabled,
    middleware,
    loginPageHandler,
    loginHandler,
    logoutHandler
}
