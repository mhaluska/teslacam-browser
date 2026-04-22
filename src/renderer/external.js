(function () {
  var lastArgs = { folder: "" }
  var csrfToken = null
  var csrfTokenPromise = null

  function joinFilePaths( filePaths )
  {
    return filePaths.map( f => `"${joinFolderPath( f )}"` ).join( " " )
  }

  function joinFolderPath( folderPath )
  {
    return lastArgs.folder + folderPath
  }

  function copyToClipboard( value )
  {
    navigator.clipboard.writeText( value )
  }

  function ensureCsrfToken()
  {
    if ( csrfToken ) return Promise.resolve( csrfToken )
    if ( csrfTokenPromise ) return csrfTokenPromise

    csrfTokenPromise = fetch( "/csrf" )
      .then( r => r.ok ? r.json() : Promise.reject( new Error( "csrf_request_failed" ) ) )
      .then( function( data )
      {
        csrfToken = data && data.token ? data.token : null
        if ( !csrfToken ) throw new Error( "csrf_missing" )
        return csrfToken
      } )
      .finally( function() { csrfTokenPromise = null } )

    return csrfTokenPromise
  }

  function postJson( url, body )
  {
    return ensureCsrfToken().then( function( token )
    {
      return fetch( url,
        {
          method: "POST",
          headers:
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": token
          },
          body: JSON.stringify( body )
        } )
    } )
  }

  var THEME_STORAGE_KEY = "themePreference"
  var SPEED_UNIT_STORAGE_KEY = "speedUnit"

  ui.initialize(
    {
      openFolders: success => fetch("openDefaultFolder").then(r => r.json()).then(a => success( lastArgs = a )),
      reopenFolders: success => fetch("reopenFolders").then(r => r.json()).then(a => { success( lastArgs = a ); return lastArgs }),
      openFolder: (_p, success) => fetch( "openDefaultFolder").then(r => r.json()).then(a => success( lastArgs = a )),
      getFiles: (p, success) => fetch("files/" + p).then(r => r.json()).then(success),
      readEventJson: (p, success) => fetch("eventJson/" + p).then(r => r.json()).then(data => success(data)).catch(() => success(null)),
      getClipTelemetry: (p, success) => fetch("clipTelemetry/" + encodeURI(p)).then(r => r.json()).then(data => success(data)).catch(() => success({ error: "request_failed" })),
      getClipSeqSummary: (p, success) => fetch("clipSeqSummary/" + encodeURI(p)).then(r => r.json()).then(data => success(data)).catch(() => success({ error: "request_failed" })),
      getAssetUrl: rel => rel ? "videos/" + rel : null,
      openBrowser: () => fetch("openBrowser", { method: "POST" }),
      deleteFiles: files => postJson( "/deleteFiles", { paths: files } ),
      deleteFolder: folder => postJson( "/deleteFolder", { path: folder } ),
      bulkDeleteFolders: paths => postJson( "/bulkDeleteFolders", { paths: paths } ).then( r => r.json() ).catch( e => ( { deleted: [], failed: paths.map( p => ( { path: p, error: String( e.message || e ) } ) ) } ) ),
      getDiskUsage: success => fetch( "/diskUsage" ).then( r => r.json() ).then( success ).catch( e => success( { error: String( e.message || e ) } ) ),
      copyFilePaths: filePaths => copyToClipboard( joinFilePaths( filePaths ) ),
      copyPath: path => copyToClipboard( joinFolderPath( path ) ),
      openExternal: path => window.open(path),
      getThemePreference: function( success )
      {
        var v = localStorage.getItem( THEME_STORAGE_KEY )

        if ( v !== "light" && v !== "dark" && v !== "system" ) v = "system"

        success( v )
      },
      setThemePreference: function( mode, success )
      {
        localStorage.setItem( THEME_STORAGE_KEY, mode )

        if ( success ) success()
      },
      getSpeedUnit: function( success )
      {
        var v = localStorage.getItem( SPEED_UNIT_STORAGE_KEY )

        if ( v !== "km" && v !== "mi" && v !== "auto" ) v = "auto"

        success( v )
      },
      setSpeedUnit: function( mode, success )
      {
        localStorage.setItem( SPEED_UNIT_STORAGE_KEY, mode )

        if ( success ) success()
      }
    } )

    var _fetch = window.fetch
    window.fetch = function() {
      return _fetch.apply(this, arguments).then(function(r) {
        if (r.status === 401) window.location.href = "/login"
        return r
      })
    }

    fetch( "/auth-enabled" ).then( r => r.json() ).then( function( data )
    {
      if ( data && data.enabled )
      {
        ensureCsrfToken().catch( function() { /* ignore */ } )
        var btn = document.getElementById( "logoutBtn" )
        btn.style.display = ""
        btn.addEventListener( "click", function()
        {
          postJson( "/logout", {} ).then( function() { window.location.href = "/login" } )
        } )
      }
    } )
})();
