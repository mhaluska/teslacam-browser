// Modules to control application life and create native browser window
const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, nativeTheme } = require( "electron" )
const menu = require( "./menu" )
const services = require( "../server/services" )
const { autoUpdater } = require( "electron-updater" )
const settings = require( "electron-settings" )
const logger = require( "../server/logger" )
const fs = require( "fs" )
const path = require( "path" )

if ( app.isPackaged )
{
	autoUpdater.checkForUpdatesAndNotify()
}

// Keep a global reference to the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow
let backendInitialized = false

function normalizeThemePreference( p )
{
	if ( p === "light" || p === "dark" || p === "system" ) return p

	return "system"
}

function normalizeSpeedUnit( u )
{
	if ( u === "km" || u === "mi" || u === "auto" ) return u

	return "auto"
}

function syncNativeThemeSource( preference )
{
	var p = normalizeThemePreference( preference )

	if ( p === "light" ) nativeTheme.themeSource = "light"
	else if ( p === "dark" ) nativeTheme.themeSource = "dark"
	else nativeTheme.themeSource = "system"
}

function selectFolders( webContents )
{
	const folders = dialog.showOpenDialogSync( { properties: [ "openDirectory" ] } )

	if ( !folders || folders.length < 1 ) return

	settings.setSync( "folders", folders )
	services.openFolders( folders )

	if ( webContents && !webContents.isDestroyed() ) webContents.reload()
}

function createWindow()
{
	// Create the browser window.
	mainWindow = new BrowserWindow(
	{
		width: 1000,
		height: 700,
		webPreferences:
		{
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join( __dirname, "preload.js" )
		}
	} )

	// and load the index.html of the app.
	mainWindow.loadFile( path.join( __dirname, "../renderer/index.html" ) )

	// Open the DevTools.
	// mainWindow.webContents.openDevTools()

	// Emitted when the window is closed.
	mainWindow.on( "closed", function ()
	{
		// Dereference the window object, usually you would store windows
		// in an array if your app supports multi windows, this is the time
		// when you should delete the corresponding element.
		mainWindow = null
	} )

	menu.initialize( () => selectFolders( mainWindow.webContents ) )

	initialize()
}

app.whenReady().then( createWindow )

// Quit when all windows are closed.
app.on( "window-all-closed", function ()
{
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if ( process.platform !== 'darwin' ) app.quit()
} )

app.on( "activate", function ()
{
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if ( mainWindow === null ) createWindow()
} )

function initialize()
{
	const port = 8088

	services.setVersion( app.getVersion() )

	var lastFolder = settings.getSync( "folders" )

	if ( lastFolder ) lastFolder = lastFolder[ 0 ]
	else lastFolder = settings.getSync( "folder" )

	//If we have last folders, we need to make sure that the folder still exists before trying to open it
	if ( lastFolder )
	{
		fs.stat( `${lastFolder}`, function(err)
		{
			if ( !err )
			{
				logger.info( "opening_last_folder", { folder: lastFolder } )
				services.setFolder( lastFolder )
			}
			else if ( err.code === 'ENOENT' )
			{
				logger.warn( "last_folder_missing", { folder: lastFolder } )
				services.setFolder( "" )
			}
		});
	}
	else
	{
		services.setFolder( "" )
	}

	function setFolder( args )
	{
		services.setFolder( args.folder )
		settings.setSync( "folder", args.folder )

		return args
	}

	async function open()
	{
		const folders = dialog.showOpenDialogSync( { properties: [ "openDirectory" ] } )

		if ( folders && folders.length > 0 ) settings.setSync( "folders", folders )

		return await services.openFolders( folders )
	}

	function browse()
	{
		logger.info( "opening_browser", { url: `http://localhost:${port}` } )
		shell.openExternal( `http://localhost:${port}` )
	}

	if ( !backendInitialized )
	{
		services.initializeExpress( port )

		ipcMain.handle( "openFolders", async () => await open() )
		ipcMain.handle( "reopenFolders", async () => await services.reopenFolders() )
		ipcMain.handle( "openFolder", async ( _event, folder ) => setFolder( await services.openFolder( folder ) ) )
		ipcMain.handle( "getFiles", async ( _event, p ) => await services.getFiles( p, f => path.join( services.args().folder, f ) ) )
		ipcMain.handle( "readEventJson", async ( _event, p ) => await services.readEventJson( p ) )

		ipcMain.handle( "getClipTelemetry", async ( _event, p ) => await services.readClipTelemetry( p ) )
		ipcMain.handle( "getClipSeqSummary", async ( _event, p ) => await services.readClipSeqSummary( p ) )

		ipcMain.handle( "getThemePreference", () => normalizeThemePreference( settings.getSync( "themePreference" ) ) )
		ipcMain.handle( "setThemePreference", ( _event, mode ) =>
		{
			var m = normalizeThemePreference( mode )

			settings.setSync( "themePreference", m )
			syncNativeThemeSource( m )

			return m
		} )

		syncNativeThemeSource( normalizeThemePreference( settings.getSync( "themePreference" ) ) )

		ipcMain.handle( "getSpeedUnit", () => normalizeSpeedUnit( settings.getSync( "speedUnit" ) ) )
		ipcMain.handle( "setSpeedUnit", ( _event, mode ) =>
		{
			var m = normalizeSpeedUnit( mode )

			settings.setSync( "speedUnit", m )

			return m
		} )

		ipcMain.on( "openBrowser", () => browse() )
		ipcMain.on( "deleteFiles", ( _event, files ) => services.deleteFiles( files ).catch( e => logger.warn( "ipc_delete_files_failed", { error: e } ) ) )
		ipcMain.on( "copyFilePaths", ( _event, filePaths ) => clipboard.writeText( services.copyFilePaths( filePaths ) ) )
		ipcMain.on( "deleteFolder", ( _event, folder ) => services.deleteFolder( folder ).catch( e => logger.warn( "ipc_delete_folder_failed", { error: e } ) ) )
		ipcMain.handle( "bulkDeleteFolders", async ( _event, paths ) =>
		{
			var deleted = []
			var failed = []

			if ( !Array.isArray( paths ) ) return { deleted: deleted, failed: failed }

			for ( var rel of paths )
			{
				try
				{
					await services.deleteFolder( rel )
					deleted.push( rel )
				}
				catch ( e )
				{
					failed.push( { path: rel, error: String( e && e.message ? e.message : e ) } )
				}
			}

			return { deleted: deleted, failed: failed }
		} )
		ipcMain.on( "copyPath", ( _event, p ) => clipboard.writeText( services.copyPath( p ) ) )
		ipcMain.on( "openExternal", ( _event, p ) => shell.showItemInFolder( p ) )

		backendInitialized = true
	}
}
