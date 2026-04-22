( function()
{
	function extractToken()
	{
		var m = window.location.pathname.match( /^\/share\/([^/]+)$/ )
		return m ? m[ 1 ] : null
	}

	var token = extractToken()

	function urlFor( kind, rel )
	{
		var base = "/share/" + token + "/" + kind
		return rel ? base + "/" + rel : base
	}

	function decodeExpiry( t )
	{
		try
		{
			var payload = t.split( "." )[ 0 ]
			var decoded = atob( payload.replace( /-/g, "+" ).replace( /_/g, "/" ) )
			var sep = decoded.lastIndexOf( "|" )
			if ( sep < 0 ) return null
			var ms = parseInt( decoded.substring( sep + 1 ), 10 )
			return isFinite( ms ) ? new Date( ms ).toLocaleString() : null
		}
		catch ( _e ) { return null }
	}

	var app = Vue.createApp( {
		data: function()
		{
			return {
				loading: true,
				error: null,
				event: null,
				timespans: [],
				expiresAt: token ? decodeExpiry( token ) : null
			}
		},
		mounted: function()
		{
			var self = this

			if ( !token ) { self.loading = false; self.error = "Missing share token"; return }

			Promise.all( [
				fetch( urlFor( "eventJson" ) ).then( r => r.ok ? r.json() : null ).catch( () => null ),
				fetch( urlFor( "files" ) ).then( r =>
				{
					if ( r.status === 410 ) throw new Error( "expired" )
					if ( !r.ok ) throw new Error( "fetch_failed" )
					return r.json()
				} )
			] )
			.then( function( results )
			{
				self.event = results[ 0 ]

				var files = results[ 1 ]
				var timespans = []

				if ( Array.isArray( files ) )
				{
					for ( var i = 0; i < files.length; i++ )
					{
						var pair = files[ i ]
						var title = pair[ 0 ]
						var views = pair[ 1 ] || []
						var viewList = Array.from( views ).map( function( v )
						{
							return { camera: v.camera, url: v.file }
						} )
						timespans.push( { title: title, views: viewList } )
					}
				}

				self.timespans = timespans
				self.loading = false
			} )
			.catch( function( e )
			{
				self.loading = false
				self.error = e && e.message === "expired" ? "Share link expired." : "Unable to load event."
			} )
		}
	} )

	app.mount( "#root" )
} )()
