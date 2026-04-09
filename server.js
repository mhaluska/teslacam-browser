// Modules to control application life and create native browser window
const services = require( "./services" )
const fs = require( "fs" )
const path = require( "path" )

const port = 8088
const defaultFolder = ( process.argv.length > 2 ) ? process.argv[ 2 ] : ""

services.setVersion( require('./package.json').version )

if ( !defaultFolder )
{
    console.error( "Headless mode requires a TeslaCam path: node server.js /path/to/TeslaCam" )
    process.exit( 1 )
}

const resolvedFolder = path.resolve( defaultFolder )

try
{
    if ( !fs.statSync( resolvedFolder ).isDirectory() )
    {
        console.error( "Provided path is not a directory: " + resolvedFolder )
        process.exit( 1 )
    }
}
catch ( e )
{
    console.error( "Cannot access path: " + resolvedFolder )
    process.exit( 1 )
}

services.setFolder( resolvedFolder )
services.initializeExpress( port, { headless: true } )
