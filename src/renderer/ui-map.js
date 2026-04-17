( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.uiMap = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
    function toFiniteNumber( value )
    {
        var n = ( typeof value === "number" ) ? value : parseFloat( value )

        return isFinite( n ) ? n : null
    }

    function coordsEqual( a, b )
    {
        if ( !a || !b ) return false

        return a.lat === b.lat && a.lon === b.lon
    }

    function createEventMapComponent()
    {
        return {
            props:
            {
                eventLat: { type: [ Number, String ], default: null },
                eventLon: { type: [ Number, String ], default: null },
                currentLat: { type: [ Number, String ], default: null },
                currentLon: { type: [ Number, String ], default: null }
            },
            template: `<div ref="mapEl" class="event-json-map"></div>`,
            mounted: function()
            {
                var L = window.L

                if ( !L || !this.$refs.mapEl ) return

                var lat = toFiniteNumber( this.eventLat )
                var lon = toFiniteNumber( this.eventLon )

                if ( lat == null || lon == null ) return

                this._map = L.map( this.$refs.mapEl, { zoomControl: true, attributionControl: true } )
                    .setView( [ lat, lon ], 16 )

                L.tileLayer( "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
                    maxZoom: 19,
                    subdomains: "abcd",
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                } ).addTo( this._map )

                this._triggerMarker = L.marker( [ lat, lon ], { title: "Event location" } ).addTo( this._map )
                this._triggerCoords = { lat: lat, lon: lon }
                this._vehicleMarker = null
                this._vehicleCoords = null

                this.updateVehicle( toFiniteNumber( this.currentLat ), toFiniteNumber( this.currentLon ) )
            },
            beforeUnmount: function()
            {
                if ( this._map )
                {
                    this._map.remove()
                    this._map = null
                }

                this._triggerMarker = null
                this._vehicleMarker = null
                this._triggerCoords = null
                this._vehicleCoords = null
            },
            watch:
            {
                eventLat: function() { this.updateTrigger() },
                eventLon: function() { this.updateTrigger() },
                currentLat: function( v ) { this.updateVehicle( toFiniteNumber( v ), toFiniteNumber( this.currentLon ) ) },
                currentLon: function( v ) { this.updateVehicle( toFiniteNumber( this.currentLat ), toFiniteNumber( v ) ) }
            },
            methods:
            {
                updateTrigger: function()
                {
                    if ( !this._map ) return

                    var lat = toFiniteNumber( this.eventLat )
                    var lon = toFiniteNumber( this.eventLon )

                    if ( lat == null || lon == null ) return

                    var next = { lat: lat, lon: lon }

                    if ( coordsEqual( this._triggerCoords, next ) ) return

                    this._triggerCoords = next

                    if ( this._triggerMarker )
                    {
                        this._triggerMarker.setLatLng( [ lat, lon ] )
                    }
                    else
                    {
                        this._triggerMarker = window.L.marker( [ lat, lon ], { title: "Event location" } ).addTo( this._map )
                    }

                    if ( !this._vehicleMarker ) this._map.setView( [ lat, lon ], this._map.getZoom() )
                },
                updateVehicle: function( lat, lon )
                {
                    if ( !this._map || lat == null || lon == null ) return

                    var next = { lat: lat, lon: lon }

                    if ( coordsEqual( this._vehicleCoords, next ) ) return

                    this._vehicleCoords = next

                    var L = window.L

                    if ( !this._vehicleMarker )
                    {
                        this._vehicleMarker = L.circleMarker( [ lat, lon ], {
                            radius: 7,
                            color: "#0d6efd",
                            weight: 2,
                            fillColor: "#0d6efd",
                            fillOpacity: 0.85
                        } ).addTo( this._map )
                    }
                    else
                    {
                        this._vehicleMarker.setLatLng( [ lat, lon ] )
                    }

                    this._map.panTo( [ lat, lon ], { animate: true, duration: 0.25 } )
                }
            }
        }
    }

    return {
        createEventMapComponent: createEventMapComponent
    }
} ) );
