#!/usr/bin/env node

const crypto = require( "crypto" )
const readline = require( "readline" )

function askPassword( prompt )
{
    return new Promise( ( resolve ) =>
    {
        const rl = readline.createInterface( {
            input: process.stdin,
            output: process.stdout
        } )

        rl._writeToOutput = function( str )
        {
            if ( str.includes( prompt ) )
            {
                rl.output.write( prompt )
            }
            else
            {
                rl.output.write( "*" )
            }
        }

        rl.question( prompt, ( answer ) =>
        {
            rl.output.write( "\n" )
            rl.close()
            resolve( answer )
        } )
    } )
}

async function main()
{
    const password = await askPassword( "Enter password: " )

    if ( !password )
    {
        console.error( "Error: Password cannot be empty." )
        process.exit( 1 )
    }

    const confirm = await askPassword( "Confirm password: " )

    if ( password !== confirm )
    {
        console.error( "Error: Passwords do not match." )
        process.exit( 1 )
    }

    const N = 16384
    const r = 8
    const p = 1
    const dkLen = 32
    const salt = crypto.randomBytes( 16 )
    const maxmem = Math.max( 32 * 1024 * 1024, 256 * N * r * p )
    const dk = crypto.scryptSync( password, salt, dkLen, { N: N, r: r, p: p, maxmem: maxmem } )

    console.log( `scrypt$${N}$${r}$${p}$${salt.toString( "base64" )}$${dk.toString( "base64" )}` )
}

main()
