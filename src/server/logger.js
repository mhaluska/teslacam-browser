function normalizeError( err )
{
	if ( !err ) return undefined
	if ( err instanceof Error )
	{
		return {
			name: err.name,
			message: err.message,
			stack: err.stack
		}
	}

	return err
}

function write( level, event, fields )
{
	var payload = {
		ts: new Date().toISOString(),
		level: level,
		event: event
	}

	if ( fields && typeof fields === "object" )
	{
		var copy = Object.assign( {}, fields )
		if ( Object.prototype.hasOwnProperty.call( copy, "error" ) )
			copy.error = normalizeError( copy.error )
		Object.assign( payload, copy )
	}
	else if ( fields != null )
	{
		payload.message = String( fields )
	}

	var line = JSON.stringify( payload )
	if ( level === "error" ) console.error( line )
	else console.log( line )
}

function info( event, fields ) { write( "info", event, fields ) }
function warn( event, fields ) { write( "warn", event, fields ) }
function error( event, fields ) { write( "error", event, fields ) }

module.exports = {
	info: info,
	warn: warn,
	error: error
}
