( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.uiAnalytics = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
    var TABS = [
        { id: "trail",   label: "Trail"   },
        { id: "charts",  label: "Charts"  },
        { id: "stats",   label: "Stats"   },
        { id: "export",  label: "Export"  }
    ]

    var G = 9.80665

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
                shownCounter: { type: Number, default: 0 }
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
                        var mult = this.speedUnit === "mi" ? 2.23694 : 3.6
                        var maxDisplay = ( this.trailMaxSpeed * mult ).toFixed( 0 )

                        return "green → red · 0 → " + maxDisplay + " " + unit
                    }

                    var maxG = ( this.trailMaxAbsAccel / G ).toFixed( 2 )

                    return "red (brake) → grey → green (accel) · ±" + maxG + " g"
                }
            },
            watch:
            {
                activeTab: function( tab )
                {
                    if ( tab === "trail" ) this._scheduleTrailRefresh( true )
                },
                samples: function()
                {
                    this._scheduleTrailRefresh( true )
                },
                trailColorMode: function()
                {
                    this._rebuildTrailPolyline()
                },
                currentTime: function()
                {
                    this._updateTrailVehicle()
                },
                shownCounter: function()
                {
                    if ( this.activeTab === "trail" ) this._scheduleTrailRefresh( true )
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

                    <div v-if="loading" class="clip-analytics-msg text-muted">Loading telemetry…</div>
                    <div v-else-if="error" class="clip-analytics-msg text-danger">{{ error }}</div>
                    <div v-else-if="!hasSamples" class="clip-analytics-msg text-muted">No telemetry in these clips.</div>
                    <div v-else class="clip-analytics-body">

                        <div v-show="activeTab === 'trail'" class="clip-analytics-tab">
                            <div v-if="!hasGps" class="clip-analytics-msg text-muted">No GPS in these clips.</div>
                            <template v-else>
                                <div class="clip-trail-controls mb-2 d-flex flex-wrap align-items-center justify-content-center gap-3 small">
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
                                <div ref="trailMapEl" class="clip-trail-map"></div>
                            </template>
                        </div>

                        <div v-show="activeTab === 'charts'" class="clip-analytics-tab">
                            <div class="clip-analytics-placeholder text-muted">Charts coming soon.</div>
                        </div>

                        <div v-show="activeTab === 'stats'" class="clip-analytics-tab">
                            <div class="clip-analytics-placeholder text-muted">Stats coming soon.</div>
                        </div>

                        <div v-show="activeTab === 'export'" class="clip-analytics-tab">
                            <div class="clip-analytics-placeholder text-muted">Export coming soon.</div>
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
