#!/usr/bin/env node

const crypto = require( "crypto" )

const password = process.argv[ 2 ]

if ( !password )
{
    console.error( "Usage: npm run hash-password -- \"yourpassword\"" )
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
