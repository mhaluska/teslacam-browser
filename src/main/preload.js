const { contextBridge, ipcRenderer } = require( "electron" )

const INVOKE_CHANNELS = [
	"openFolders", "reopenFolders", "openFolder", "getFiles",
	"readEventJson", "getClipTelemetry", "getClipSeqSummary",
	"getThemePreference", "setThemePreference",
	"getSpeedUnit", "setSpeedUnit",
	"bulkDeleteFolders",
	"getDiskUsage",
	"cleanupOlderThan"
]

const SEND_CHANNELS = [
	"openBrowser", "deleteFiles", "deleteFolder",
	"copyFilePaths", "copyPath", "openExternal"
]

contextBridge.exposeInMainWorld( "electronAPI", {
	invoke: ( channel, ...args ) =>
	{
		if ( !INVOKE_CHANNELS.includes( channel ) )
			throw new Error( "ipc_channel_not_allowed: " + channel )

		return ipcRenderer.invoke( channel, ...args )
	},
	send: ( channel, ...args ) =>
	{
		if ( !SEND_CHANNELS.includes( channel ) )
			throw new Error( "ipc_channel_not_allowed: " + channel )

		ipcRenderer.send( channel, ...args )
	}
} )
