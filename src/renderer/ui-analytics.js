( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.uiAnalytics = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
    var uiUtils = ( typeof window !== "undefined" && window.uiUtils )
        ? window.uiUtils
        : require( "./ui-utils" )

    var computeTripStats = uiUtils.computeTripStats
    var buildTelemetryCsv = uiUtils.buildTelemetryCsv
    var buildTelemetryGpx = uiUtils.buildTelemetryGpx

    function downloadBlob( filename, mime, text )
    {
        try
        {
            var blob = new Blob( [ text ], { type: mime + ";charset=utf-8" } )
            var url = URL.createObjectURL( blob )
            var a = document.createElement( "a" )

            a.href = url
            a.download = filename
            a.style.display = "none"

            document.body.appendChild( a )
            a.click()
            document.body.removeChild( a )

            setTimeout( function() { URL.revokeObjectURL( url ) }, 0 )
        }
        catch ( e )
        {
            /* best-effort — browser may block downloads in some contexts */
            console.error( "download failed", e )
        }
    }

    function sanitizeFilenamePart( s )
    {
        if ( s == null ) return ""

        return String( s ).replace( /[^A-Za-z0-9._-]+/g, "_" ).replace( /^_+|_+$/g, "" )
    }

    var TABS = [
        { id: "trail",   label: "Trail"   },
        { id: "charts",  label: "Charts"  },
        { id: "stats",   label: "Stats"   },
        { id: "export",  label: "Export"  }
    ]

    var G = 9.80665

    var CHART_SYNC_KEY_PREFIX = "clip-analytics-"
    var CHART_SYNC_KEY_SEED = 0

    function msToMph( v ) { return v * 2.23694 }
    function msToKph( v ) { return v * 3.6 }

    function hasValidGps( s )
    {
        if ( !s ) return false

        var lat = s.latitudeDeg
        var lon = s.longitudeDeg

        return typeof lat === "number" && typeof lon === "number"
            && isFinite( lat ) && isFinite( lon )
            && !( lat === 0 && lon === 0 )
    }

    function speedToColor( mps, maxMps )
    {
        var t = ( maxMps > 0 && typeof mps === "number" && isFinite( mps ) ) ? Math.max( 0, Math.min( 1, mps / maxMps ) ) : 0
        // Green (120) → Yellow (60) → Red (0)
        var hue = 120 - 120 * t

        return "hsl(" + hue.toFixed( 0 ) + ", 78%, 45%)"
    }

    function accelToColor( ax, maxAbs )
    {
        if ( typeof ax !== "number" || !isFinite( ax ) || !( maxAbs > 0 ) ) return "hsl(0, 0%, 55%)"

        var t = Math.max( -1, Math.min( 1, ax / maxAbs ) )

        if ( t >= 0 )
        {
            // positive accelX (acceleration) → green
            var sat = Math.round( 30 + t * 55 )
            var light = 55 - Math.round( t * 15 )

            return "hsl(120, " + sat + "%, " + light + "%)"
        }

        // negative accelX (braking) → red
        var sat2 = Math.round( 30 + ( -t ) * 55 )
        var light2 = 55 - Math.round( ( -t ) * 15 )

        return "hsl(0, " + sat2 + "%, " + light2 + "%)"
    }

    function findNearestSampleIndex( samples, t )
    {
        var n = samples.length

        if ( !n ) return -1

        if ( t <= samples[ 0 ].tSec ) return 0
        if ( t >= samples[ n - 1 ].tSec ) return n - 1

        var lo = 0
        var hi = n - 1

        while ( lo < hi - 1 )
        {
            var mid = ( lo + hi ) >> 1

            if ( samples[ mid ].tSec <= t ) lo = mid
            else hi = mid
        }

        var dLo = Math.abs( samples[ lo ].tSec - t )
        var dHi = Math.abs( samples[ hi ].tSec - t )

        return dLo <= dHi ? lo : hi
    }

    function createClipAnalyticsComponent()
    {
        return {
            props:
            {
                loading: { type: Boolean, default: false },
                error:   { type: String,  default: null  },
                samples: { type: Array,   default: function() { return [] } },
                currentTime: { type: Number, default: 0 },
                eventLabel: { type: String, default: "" },
                speedUnit:  { type: String, default: "km" },
                shownCounter: { type: Number, default: 0 },
                baseTime:   { type: Date, default: null }
            },
            emits: [ "seek" ],
            data: function()
            {
                return {
                    activeTab: "trail",
                    tabs: TABS,
                    trailColorMode: "speed"
                }
            },
            created: function()
            {
                this._chartSyncKey = CHART_SYNC_KEY_PREFIX + ( ++CHART_SYNC_KEY_SEED )
                this._chartEls = []
                this._playheadEls = []
                this._charts = []
                this._chartResizeObserver = null
                this._chartDragState = null
            },
            computed:
            {
                hasSamples: function() { return Array.isArray( this.samples ) && this.samples.length > 0 },
                gpsSamples: function()
                {
                    if ( !this.hasSamples ) return []

                    var out = []

                    for ( var i = 0; i < this.samples.length; i++ )
                    {
                        if ( hasValidGps( this.samples[ i ] ) ) out.push( this.samples[ i ] )
                    }

                    return out
                },
                hasGps: function() { return this.gpsSamples.length > 1 },
                trailMaxSpeed: function()
                {
                    var m = 0

                    for ( var i = 0; i < this.gpsSamples.length; i++ )
                    {
                        var v = this.gpsSamples[ i ].speedMps

                        if ( typeof v === "number" && isFinite( v ) && v > m ) m = v
                    }

                    return m
                },
                trailMaxAbsAccel: function()
                {
                    var m = 0

                    for ( var i = 0; i < this.gpsSamples.length; i++ )
                    {
                        var v = this.gpsSamples[ i ].accelX
                        var a = ( typeof v === "number" && isFinite( v ) ) ? Math.abs( v ) : 0

                        if ( a > m ) m = a
                    }

                    // Clamp to a sensible floor so near-zero clips don't saturate.
                    return Math.max( m, 2.0 )
                },
                trailLegend: function()
                {
                    if ( this.trailColorMode === "speed" )
                    {
                        var unit = this.speedUnit === "mi" ? "mph" : "km/h"
                        var mult = this.speedUnit === "mi" ? msToMph( 1 ) : msToKph( 1 )
                        var maxDisplay = ( this.trailMaxSpeed * mult ).toFixed( 0 )

                        return "green → red · 0 → " + maxDisplay + " " + unit
                    }

                    var maxG = ( this.trailMaxAbsAccel / G ).toFixed( 2 )

                    return "red (brake) → grey → green (accel) · ±" + maxG + " g"
                },
                chartXValues: function()
                {
                    if ( !this.hasSamples ) return []

                    var out = new Array( this.samples.length )

                    for ( var i = 0; i < this.samples.length; i++ )
                    {
                        var t = this.samples[ i ].tSec

                        out[ i ] = ( typeof t === "number" && isFinite( t ) ) ? t : 0
                    }

                    return out
                },
                tripStats: function()
                {
                    return computeTripStats( this.samples )
                },
                statCells: function()
                {
                    var s = this.tripStats
                    var unit = this.speedUnit === "mi" ? "mph" : "km/h"
                    var mult = this.speedUnit === "mi" ? msToMph( 1 ) : msToKph( 1 )
                    var useMi = this.speedUnit === "mi"

                    function fmtSpeed( mps )
                    {
                        if ( mps == null || !isFinite( mps ) ) return "—"

                        return ( mps * mult ).toFixed( 1 ) + " " + unit
                    }

                    function fmtDistance( meters )
                    {
                        if ( meters == null || !isFinite( meters ) ) return "—"

                        if ( useMi )
                        {
                            var miles = meters / 1609.344

                            return miles >= 0.1 ? miles.toFixed( 2 ) + " mi" : ( meters * 3.28084 ).toFixed( 0 ) + " ft"
                        }

                        return meters >= 1000 ? ( meters / 1000 ).toFixed( 2 ) + " km" : meters.toFixed( 0 ) + " m"
                    }

                    function fmtDuration( sec )
                    {
                        if ( sec == null || !isFinite( sec ) ) return "—"

                        var m = Math.floor( sec / 60 )
                        var r = sec - m * 60

                        return m > 0 ? ( m + "m " + r.toFixed( 1 ) + "s" ) : ( r.toFixed( 1 ) + "s" )
                    }

                    function fmtG( g )
                    {
                        if ( g == null || !isFinite( g ) ) return "—"

                        return g.toFixed( 2 ) + " g"
                    }

                    function fmtPct( p )
                    {
                        if ( p == null || !isFinite( p ) ) return "—"

                        return ( p * 100 ).toFixed( 0 ) + "%"
                    }

                    return [
                        { label: "Min speed",      value: fmtSpeed( s.minSpeedMps ) },
                        { label: "Avg speed",      value: fmtSpeed( s.avgSpeedMps ) },
                        { label: "Max speed",      value: fmtSpeed( s.maxSpeedMps ) },
                        { label: "Distance",       value: fmtDistance( s.distanceMeters ) },
                        { label: "Duration",       value: fmtDuration( s.durationSec ) },
                        { label: "Max lateral G",  value: fmtG( s.maxLateralG ) },
                        { label: "Autopilot",      value: fmtPct( s.autopilotPct ) },
                        { label: "Samples",        value: String( s.count ) }
                    ]
                },
                chartDefs: function()
                {
                    if ( !this.hasSamples ) return []

                    var samples = this.samples
                    var n = samples.length
                    var speedUnit = this.speedUnit === "mi" ? "mph" : "km/h"
                    var speedMult = this.speedUnit === "mi" ? msToMph( 1 ) : msToKph( 1 )

                    var speedArr = new Array( n )
                    var steerArr = new Array( n )
                    var accArr = new Array( n )
                    var brakeArr = new Array( n )
                    var aXArr = new Array( n )
                    var aYArr = new Array( n )

                    for ( var i = 0; i < n; i++ )
                    {
                        var s = samples[ i ]

                        speedArr[ i ] = ( typeof s.speedMps === "number" && isFinite( s.speedMps ) ) ? s.speedMps * speedMult : null
                        steerArr[ i ] = ( typeof s.steeringWheelAngle === "number" && isFinite( s.steeringWheelAngle ) ) ? s.steeringWheelAngle : null
                        accArr[ i ]   = ( typeof s.acceleratorPedal === "number" && isFinite( s.acceleratorPedal ) ) ? s.acceleratorPedal : null
                        brakeArr[ i ] = s.brakeApplied ? 1 : 0
                        aXArr[ i ]    = ( typeof s.accelX === "number" && isFinite( s.accelX ) ) ? s.accelX / G : null
                        aYArr[ i ]    = ( typeof s.accelY === "number" && isFinite( s.accelY ) ) ? s.accelY / G : null
                    }

                    return [
                        {
                            id: "speed",
                            label: "Speed (" + speedUnit + ")",
                            height: 130,
                            series:
                            [
                                { label: "Speed", stroke: "#0d6efd", fill: "rgba(13,110,253,0.22)", width: 1.5, values: speedArr }
                            ]
                        },
                        {
                            id: "steering",
                            label: "Steering (°)",
                            height: 110,
                            series:
                            [
                                { label: "Angle", stroke: "#6610f2", width: 1.5, values: steerArr }
                            ]
                        },
                        {
                            id: "pedals",
                            label: "Pedals",
                            height: 110,
                            series:
                            [
                                { label: "Accelerator", stroke: "#198754", fill: "rgba(25,135,84,0.28)", width: 1.3, values: accArr },
                                { label: "Brake",       stroke: "#dc3545", fill: "rgba(220,53,69,0.28)", width: 1.3, values: brakeArr }
                            ]
                        },
                        {
                            id: "accel",
                            label: "Acceleration (g)",
                            height: 130,
                            series:
                            [
                                { label: "Longitudinal", stroke: "#fd7e14", width: 1.4, values: aXArr },
                                { label: "Lateral",      stroke: "#20c997", width: 1.4, values: aYArr }
                            ]
                        }
                    ]
                }
            },
            watch:
            {
                activeTab: function( tab )
                {
                    if ( tab === "trail" ) this._scheduleTrailRefresh( true )
                    if ( tab === "charts" ) this._scheduleChartsRefresh( true )
                },
                samples: function()
                {
                    this._scheduleTrailRefresh( true )
                    if ( this.activeTab === "charts" ) this._scheduleChartsRefresh( true )
                },
                speedUnit: function()
                {
                    if ( this.activeTab === "charts" ) this._scheduleChartsRefresh( false )
                },
                trailColorMode: function()
                {
                    this._rebuildTrailPolyline()
                },
                currentTime: function()
                {
                    this._updateTrailVehicle()
                    this._updateChartPlayheads()
                },
                shownCounter: function()
                {
                    if ( this.activeTab === "trail" ) this._scheduleTrailRefresh( true )
                    if ( this.activeTab === "charts" ) this._scheduleChartsRefresh( true )
                }
            },
            mounted: function()
            {
                this._trailMap = null
                this._trailPolylineGroup = null
                this._trailVehicleMarker = null

                if ( this.activeTab === "trail" ) this._scheduleTrailRefresh( true )
            },
            beforeUnmount: function()
            {
                this._destroyTrailMap()
                this._destroyCharts()
            },
            methods:
            {
                _scheduleTrailRefresh: function( fitBounds )
                {
                    var self = this

                    self.$nextTick( function()
                    {
                        self._ensureTrailMap()

                        if ( self._trailMap )
                        {
                            self._trailMap.invalidateSize()
                            self._rebuildTrailPolyline( fitBounds )
                            self._updateTrailVehicle()
                        }
                    } )
                },
                _ensureTrailMap: function()
                {
                    if ( this._trailMap || !this.hasGps ) return

                    var el = this.$refs.trailMapEl
                    var L = window.L

                    if ( !el || !L ) return

                    this._trailMap = L.map( el, { zoomControl: true, attributionControl: true } )

                    L.tileLayer( "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
                        maxZoom: 19,
                        subdomains: "abcd",
                        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                    } ).addTo( this._trailMap )

                    this._trailPolylineGroup = L.layerGroup().addTo( this._trailMap )
                },
                _destroyTrailMap: function()
                {
                    if ( this._trailMap )
                    {
                        this._trailMap.remove()
                        this._trailMap = null
                    }

                    this._trailPolylineGroup = null
                    this._trailVehicleMarker = null
                },
                _rebuildTrailPolyline: function( fitBounds )
                {
                    if ( !this._trailMap || !this._trailPolylineGroup ) return

                    this._trailPolylineGroup.clearLayers()

                    var samples = this.gpsSamples

                    if ( samples.length < 2 ) return

                    var L = window.L
                    var mode = this.trailColorMode
                    var maxSpeed = this.trailMaxSpeed
                    var maxAccel = this.trailMaxAbsAccel
                    var latLngs = []

                    for ( var i = 1; i < samples.length; i++ )
                    {
                        var a = samples[ i - 1 ]
                        var b = samples[ i ]
                        var color = mode === "accel"
                            ? accelToColor( b.accelX, maxAccel )
                            : speedToColor( b.speedMps, maxSpeed )

                        L.polyline(
                            [ [ a.latitudeDeg, a.longitudeDeg ], [ b.latitudeDeg, b.longitudeDeg ] ],
                            { color: color, weight: 5, opacity: 0.9, interactive: false }
                        ).addTo( this._trailPolylineGroup )

                        latLngs.push( [ b.latitudeDeg, b.longitudeDeg ] )
                    }

                    if ( fitBounds && latLngs.length )
                    {
                        this._trailMap.fitBounds( latLngs, { padding: [ 20, 20 ] } )
                    }
                },
                exportBasename: function()
                {
                    var parts = []

                    if ( this.baseTime instanceof Date && !isNaN( this.baseTime.getTime() ) )
                    {
                        parts.push( this.baseTime.toISOString().replace( /[:.]/g, "-" ).replace( /T/, "_" ).replace( /Z$/, "" ) )
                    }
                    else
                    {
                        parts.push( "teslacam-clip" )
                    }

                    for ( var i = 0; i < this.samples.length; i++ )
                    {
                        var s = this.samples[ i ]
                        var lat = s.latitudeDeg
                        var lon = s.longitudeDeg

                        if ( typeof lat === "number" && typeof lon === "number" && isFinite( lat ) && isFinite( lon ) && !( lat === 0 && lon === 0 ) )
                        {
                            parts.push( lat.toFixed( 5 ) + "_" + lon.toFixed( 5 ) )
                            break
                        }
                    }

                    return sanitizeFilenamePart( parts.join( "-" ) ) || "teslacam-clip"
                },
                downloadCsv: function()
                {
                    if ( !this.hasSamples ) return

                    var text = buildTelemetryCsv( this.samples, this.baseTime )

                    downloadBlob( this.exportBasename() + ".csv", "text/csv", text )
                },
                downloadGpx: function()
                {
                    if ( !this.hasSamples ) return

                    var text = buildTelemetryGpx( this.samples, this.baseTime, { name: this.eventLabel || "TeslaCam clip" } )

                    downloadBlob( this.exportBasename() + ".gpx", "application/gpx+xml", text )
                },
                _scheduleChartsRefresh: function( rebuild )
                {
                    var self = this

                    self.$nextTick( function()
                    {
                        if ( rebuild ) self._rebuildCharts()
                        else self._resizeCharts()

                        self._updateChartPlayheads()
                    } )
                },
                _rebuildCharts: function()
                {
                    this._destroyCharts()

                    if ( !window.uPlot || !this.hasSamples ) return

                    var defs = this.chartDefs
                    var xs = this.chartXValues

                    if ( !defs.length || !xs.length ) return

                    var chartEls = this.$refs.chartEls ? [].concat( this.$refs.chartEls ) : []
                    var playheadEls = this.$refs.playheadEls ? [].concat( this.$refs.playheadEls ) : []

                    this._chartEls = chartEls
                    this._playheadEls = playheadEls

                    var xMin = xs[ 0 ]
                    var xMax = xs[ xs.length - 1 ]
                    var self = this

                    for ( var i = 0; i < defs.length; i++ )
                    {
                        var def = defs[ i ]
                        var el = chartEls[ i ]

                        if ( !el ) continue

                        var width = Math.max( 320, Math.floor( el.clientWidth || el.parentElement.clientWidth || 600 ) )
                        var data = [ xs ]
                        var series = [ {} ]

                        for ( var j = 0; j < def.series.length; j++ )
                        {
                            var s = def.series[ j ]

                            data.push( s.values )
                            series.push( {
                                label: s.label,
                                stroke: s.stroke,
                                fill: s.fill || null,
                                width: s.width || 1.4,
                                spanGaps: true,
                                points: { show: false }
                            } )
                        }

                        var opts = {
                            width: width,
                            height: def.height,
                            title: def.label,
                            scales: { x: { time: false, min: xMin, max: xMax } },
                            legend: { show: def.series.length > 1, live: false },
                            cursor: { sync: { key: this._chartSyncKey }, drag: { setScale: false } },
                            axes: [
                                { label: "", values: function( _u, vals ) { return vals.map( function( v ) { return v.toFixed( 0 ) + "s" } ) } },
                                {}
                            ],
                            series: series,
                            hooks: {
                                setCursor: [ function( u )
                                {
                                    // Intentionally empty — uPlot handles the live crosshair.
                                } ]
                            }
                        }

                        var u = new window.uPlot( opts, data, el )
                        var chartInfo = { id: def.id, uplot: u, def: def, el: el, capturedTSec: null }

                        this._charts.push( chartInfo )

                        ;( function( info )
                        {
                            function seekFromEvent( evt )
                            {
                                var rect = info.el.getBoundingClientRect()
                                var left = evt.clientX - rect.left - info.uplot.bbox.left / devicePixelRatio
                                var plotWidth = info.uplot.bbox.width / devicePixelRatio

                                if ( plotWidth <= 0 ) return null

                                var t = info.uplot.posToVal( left, "x" )

                                if ( !isFinite( t ) ) return null

                                return Math.max( xMin, Math.min( xMax, t ) )
                            }

                            function onDown( evt )
                            {
                                if ( evt.button !== 0 ) return

                                var t = seekFromEvent( evt )

                                if ( t == null ) return

                                self._chartDragState = { info: info, seek: seekFromEvent }
                                self.$emit( "seek", t )
                                evt.preventDefault()
                            }

                            info.el.addEventListener( "mousedown", onDown )
                            info.onDown = onDown
                        } )( chartInfo )
                    }

                    if ( !this._chartDragBound )
                    {
                        this._chartDragBound = true

                        this._onChartMove = function( evt )
                        {
                            if ( !self._chartDragState ) return

                            var t = self._chartDragState.seek( evt )

                            if ( t != null ) self.$emit( "seek", t )
                        }

                        this._onChartUp = function() { self._chartDragState = null }

                        window.addEventListener( "mousemove", this._onChartMove )
                        window.addEventListener( "mouseup", this._onChartUp )
                    }

                    if ( !this._chartResizeObserver && typeof ResizeObserver !== "undefined" )
                    {
                        this._chartResizeObserver = new ResizeObserver( function() { self._resizeCharts() } )

                        var host = this.$refs.chartsHost

                        if ( host ) this._chartResizeObserver.observe( host )
                    }
                },
                _resizeCharts: function()
                {
                    for ( var i = 0; i < this._charts.length; i++ )
                    {
                        var c = this._charts[ i ]

                        if ( !c.el || !c.uplot ) continue

                        var w = Math.max( 320, Math.floor( c.el.clientWidth || c.el.parentElement.clientWidth || 600 ) )

                        if ( Math.abs( c.uplot.width - w ) > 1 ) c.uplot.setSize( { width: w, height: c.def.height } )
                    }

                    this._updateChartPlayheads()
                },
                _updateChartPlayheads: function()
                {
                    if ( !this._charts.length ) return

                    var t = this.currentTime

                    for ( var i = 0; i < this._charts.length; i++ )
                    {
                        var c = this._charts[ i ]
                        var ph = this._playheadEls[ i ]

                        if ( !c.uplot || !ph ) continue

                        var plotLeft = c.uplot.bbox.left / devicePixelRatio
                        var plotWidth = c.uplot.bbox.width / devicePixelRatio
                        var x = c.uplot.valToPos( t, "x" )

                        if ( !isFinite( x ) || x < 0 || x > plotWidth ) { ph.style.display = "none"; continue }

                        ph.style.display = "block"
                        ph.style.left = ( plotLeft + x ) + "px"
                        ph.style.top = c.uplot.bbox.top / devicePixelRatio + "px"
                        ph.style.height = c.uplot.bbox.height / devicePixelRatio + "px"
                    }
                },
                _destroyCharts: function()
                {
                    for ( var i = 0; i < this._charts.length; i++ )
                    {
                        var c = this._charts[ i ]

                        if ( c.onDown && c.el ) c.el.removeEventListener( "mousedown", c.onDown )
                        if ( c.uplot ) c.uplot.destroy()
                    }

                    this._charts = []

                    if ( this._chartResizeObserver )
                    {
                        this._chartResizeObserver.disconnect()
                        this._chartResizeObserver = null
                    }

                    if ( this._chartDragBound )
                    {
                        this._chartDragBound = false
                        window.removeEventListener( "mousemove", this._onChartMove )
                        window.removeEventListener( "mouseup", this._onChartUp )
                    }
                },
                _updateTrailVehicle: function()
                {
                    if ( !this._trailMap || !this.gpsSamples.length ) return

                    var idx = findNearestSampleIndex( this.gpsSamples, this.currentTime )

                    if ( idx < 0 ) return

                    var s = this.gpsSamples[ idx ]
                    var L = window.L

                    if ( !this._trailVehicleMarker )
                    {
                        var icon = L.divIcon( {
                            className: "event-vehicle-marker",
                            html: '<div class="event-vehicle-dot"></div>',
                            iconSize: [ 16, 16 ],
                            iconAnchor: [ 8, 8 ]
                        } )

                        this._trailVehicleMarker = L.marker( [ s.latitudeDeg, s.longitudeDeg ], {
                            icon: icon,
                            keyboard: false,
                            interactive: false
                        } ).addTo( this._trailMap )
                    }
                    else
                    {
                        this._trailVehicleMarker.setLatLng( [ s.latitudeDeg, s.longitudeDeg ] )
                    }
                }
            },
            template: `
                <div class="clip-analytics">
                    <ul class="nav nav-tabs clip-analytics-tabs" role="tablist">
                        <li class="nav-item" v-for="t in tabs" :key="t.id">
                            <button type="button" class="nav-link" :class="{ active: activeTab === t.id }"
                                @click.prevent="activeTab = t.id">{{ t.label }}</button>
                        </li>
                    </ul>

                    <div v-if="!loading && !error && hasSamples" class="clip-analytics-status small">
                        <span class="badge bg-secondary">{{ samples.length }} sample{{ samples.length === 1 ? "" : "s" }}</span>
                        <span class="text-muted ms-2">
                            GPS: {{ hasGps ? "yes" : "no" }} · spanning {{ tripStats.durationSec != null ? tripStats.durationSec.toFixed( 1 ) + "s" : "—" }}
                        </span>
                    </div>

                    <div v-if="loading" class="clip-analytics-msg text-muted">Loading telemetry…</div>
                    <div v-else-if="error" class="clip-analytics-msg text-danger">{{ error }}</div>
                    <div v-else-if="!hasSamples" class="clip-analytics-msg text-muted">No telemetry in these clips.</div>
                    <div v-else class="clip-analytics-body">

                        <div v-show="activeTab === 'trail'" class="clip-analytics-tab">
                            <div v-if="!hasGps" class="clip-analytics-msg text-muted">No GPS in these clips.</div>
                            <div v-if="hasGps" class="clip-trail-controls mb-2 d-flex flex-wrap align-items-center justify-content-center gap-3 small">
                                <div class="form-check form-check-inline m-0">
                                    <input class="form-check-input" type="radio" id="trailColorSpeed" value="speed" v-model="trailColorMode">
                                    <label class="form-check-label" for="trailColorSpeed">Color by speed</label>
                                </div>
                                <div class="form-check form-check-inline m-0">
                                    <input class="form-check-input" type="radio" id="trailColorAccel" value="accel" v-model="trailColorMode">
                                    <label class="form-check-label" for="trailColorAccel">Color by longitudinal G</label>
                                </div>
                                <span class="text-muted">{{ trailLegend }}</span>
                            </div>
                            <div v-if="hasGps" ref="trailMapEl" class="clip-trail-map"></div>
                        </div>

                        <div v-show="activeTab === 'charts'" class="clip-analytics-tab">
                            <div class="clip-analytics-charts" ref="chartsHost">
                                <div v-for="(c, i) in chartDefs" :key="c.id" class="clip-analytics-chart-wrap">
                                    <div ref="chartEls" class="clip-analytics-chart"></div>
                                    <div ref="playheadEls" class="clip-analytics-playhead"></div>
                                </div>
                                <div class="small text-muted mt-1 text-center">Click or drag on a chart to scrub the video.</div>
                            </div>
                        </div>

                        <div v-show="activeTab === 'stats'" class="clip-analytics-tab">
                            <div class="clip-analytics-stats-grid">
                                <div class="clip-analytics-stat" v-for="cell in statCells" :key="cell.label">
                                    <div class="clip-analytics-stat-label">{{ cell.label }}</div>
                                    <div class="clip-analytics-stat-value">{{ cell.value }}</div>
                                </div>
                            </div>
                            <div class="small text-muted mt-3 text-center" v-if="tripStats.firstTSec != null && tripStats.lastTSec != null">
                                Span {{ tripStats.firstTSec.toFixed( 1 ) }}s → {{ tripStats.lastTSec.toFixed( 1 ) }}s · {{ tripStats.count }} samples
                            </div>
                        </div>

                        <div v-show="activeTab === 'export'" class="clip-analytics-tab">
                            <div class="clip-analytics-export">
                                <p class="small text-muted mb-3">
                                    Download this clip's telemetry. CSV suits Excel / Python / general analysis; GPX opens in
                                    RaceChrono, Google Earth, Strava, gpx.studio and most GPS tools.
                                </p>
                                <div class="d-flex flex-wrap gap-2 justify-content-center">
                                    <button type="button" class="btn btn-primary" @click.prevent="downloadCsv" :disabled="!hasSamples">
                                        <span class="bi bi-filetype-csv" aria-hidden="true"></span>
                                        Download CSV
                                    </button>
                                    <button type="button" class="btn btn-primary" @click.prevent="downloadGpx" :disabled="!hasSamples || !hasGps">
                                        <span class="bi bi-geo-alt" aria-hidden="true"></span>
                                        Download GPX
                                    </button>
                                </div>
                                <div class="small text-muted mt-3 text-center" v-if="!hasGps">GPX export disabled: no GPS points in this clip.</div>
                            </div>
                        </div>

                    </div>
                </div>
            `
        }
    }

    return {
        createClipAnalyticsComponent: createClipAnalyticsComponent
    }
} ) );
