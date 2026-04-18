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

const certDir = path.resolve( __dirname, "../../certs" )
const certPath = path.join( certDir, "server.crt" )
const keyPath = path.join( certDir, "server.key" )

function loadOrCreateCert()
{
    if ( fs.existsSync( certPath ) && fs.existsSync( keyPath ) )
    {
        return { key: fs.readFileSync( keyPath ), cert: fs.readFileSync( certPath ) }
    }

    const selfsigned = require( "selfsigned" )
    const attrs = [ { name: "commonName", value: "localhost" } ]
    const pems = selfsigned.generate( attrs, {
        days: 3650,
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
            { name: "basicConstraints", cA: false },
            { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
            { name: "extKeyUsage", serverAuth: true },
            { name: "subjectAltName", altNames: [
                { type: 2, value: "localhost" },
                { type: 7, ip: "127.0.0.1" },
                { type: 7, ip: "::1" }
            ] }
        ]
    } )

    fs.mkdirSync( certDir, { recursive: true } )
    fs.writeFileSync( keyPath, pems.private, { mode: 0o600 } )
    fs.writeFileSync( certPath, pems.cert )

    logger.info( "self_signed_cert_generated", { certPath: certPath } )

    return { key: pems.private, cert: pems.cert }
}

const tls = loadOrCreateCert()

services.setFolder( resolvedFolder )
services.initializeExpress( port, { headless: true, tls: tls } )
