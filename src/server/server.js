// Modules to control application life and create native browser window
const services = require( "./services" )
const logger = require( "./logger" )
const fs = require( "fs" )
const path = require( "path" )

const port = 8088
const defaultFolder = ( process.argv.length > 2 ) ? process.argv[ 2 ] : ""

services.setVersion( require('../../package.json').version )

if ( !defaultFolder )
{
    logger.error( "headless_startup_path_missing", { hint: "node server.js /path/to/TeslaCam" } )
    process.exit( 1 )
}

const resolvedFolder = path.resolve( defaultFolder )

try
{
    if ( !fs.statSync( resolvedFolder ).isDirectory() )
    {
        logger.error( "headless_startup_path_not_directory", { path: resolvedFolder } )
        process.exit( 1 )
    }
}
catch ( e )
{
    logger.error( "headless_startup_path_inaccessible", { path: resolvedFolder, error: e } )
    process.exit( 1 )
}

const bindHostRaw = typeof process.env.TC_BIND_HOST === "string" ? process.env.TC_BIND_HOST.trim() : ""
const bindHost = bindHostRaw.length > 0 ? bindHostRaw : "127.0.0.1"

services.setFolder( resolvedFolder )
services.initializeExpress( port, { headless: true, host: bindHost } )
