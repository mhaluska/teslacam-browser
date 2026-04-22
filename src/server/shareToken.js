const crypto = require( "crypto" )
const logger = require( "./logger" )

var SHARE_SECRET = process.env.TC_SHARE_SECRET || null
var generatedSecret = false

function ensureSecret()
{
	if ( SHARE_SECRET ) return SHARE_SECRET

	SHARE_SECRET = crypto.randomBytes( 32 ).toString( "hex" )
	generatedSecret = true
	logger.info( "share_secret_generated", { persistent: false } )

	return SHARE_SECRET
}

function sign( eventPath, expiryMs )
{
	if ( typeof eventPath !== "string" || !eventPath.length ) throw new Error( "invalid_event_path" )
	if ( typeof expiryMs !== "number" || !isFinite( expiryMs ) || expiryMs <= Date.now() )
		throw new Error( "invalid_expiry" )

	var payload = Buffer.from( eventPath + "|" + String( Math.floor( expiryMs ) ), "utf8" )
		.toString( "base64url" )
	var hmac = crypto.createHmac( "sha256", ensureSecret() ).update( payload ).digest( "base64url" )

	return payload + "." + hmac
}

function verify( token )
{
	if ( typeof token !== "string" || token.length < 3 ) return null

	var dot = token.lastIndexOf( "." )
	if ( dot < 1 ) return null

	var payload = token.substring( 0, dot )
	var signature = token.substring( dot + 1 )

	var expected = crypto.createHmac( "sha256", ensureSecret() ).update( payload ).digest( "base64url" )

	if ( expected.length !== signature.length ) return null

	try
	{
		var ok = crypto.timingSafeEqual( Buffer.from( expected ), Buffer.from( signature ) )
		if ( !ok ) return null
	}
	catch ( _e ) { return null }

	var decoded
	try { decoded = Buffer.from( payload, "base64url" ).toString( "utf8" ) }
	catch ( _e ) { return null }

	var sep = decoded.lastIndexOf( "|" )
	if ( sep < 1 ) return null

	var eventPath = decoded.substring( 0, sep )
	var expiry = parseInt( decoded.substring( sep + 1 ), 10 )

	if ( !eventPath ) return null
	if ( !isFinite( expiry ) ) return null
	if ( Date.now() > expiry ) return null

	return { eventPath: eventPath, expiry: expiry }
}

function hasPersistentSecret()
{
	return !generatedSecret
}

module.exports = {
	sign: sign,
	verify: verify,
	hasPersistentSecret: hasPersistentSecret
}
