// Minimal synchronous JSON settings store. Replaces electron-settings and keeps its
// on-disk contract (<userData>/settings.json, plain JSON) so existing prefs carry over.
const fs = require( "fs" )
const path = require( "path" )

function createSettingsStore( filePath )
{
	var data = null

	function load()
	{
		if ( data ) return data

		try
		{
			var parsed = JSON.parse( fs.readFileSync( filePath, "utf8" ) )

			data = parsed && typeof parsed === "object" && !Array.isArray( parsed ) ? parsed : {}
		}
		catch ( _e ) { data = {} }

		return data
	}

	function getSync( key )
	{
		return load()[ key ]
	}

	// Write to a temp file and rename so a crash mid-write never leaves a truncated file.
	function setSync( key, value )
	{
		load()[ key ] = value

		var tmpPath = `${filePath}.tmp`

		fs.mkdirSync( path.dirname( filePath ), { recursive: true } )
		fs.writeFileSync( tmpPath, JSON.stringify( data ) )
		fs.renameSync( tmpPath, filePath )
	}

	return {
		getSync: getSync,
		setSync: setSync
	}
}

var defaultStore = null

// Resolve electron lazily so tests can load this module without an Electron runtime.
function store()
{
	if ( !defaultStore )
	{
		const { app } = require( "electron" )

		defaultStore = createSettingsStore( path.join( app.getPath( "userData" ), "settings.json" ) )
	}

	return defaultStore
}

module.exports = {
	createSettingsStore: createSettingsStore,
	getSync: key => store().getSync( key ),
	setSync: ( key, value ) => store().setSync( key, value )
}
