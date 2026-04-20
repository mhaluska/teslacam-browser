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
                currentLon: { type: [ Number, String ], default: null },
                currentHeading: { type: [ Number, String ], default: null }
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
                    .setView( [ lat, lon ], 17 )

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
                currentLon: function( v ) { this.updateVehicle( toFiniteNumber( this.currentLat ), toFiniteNumber( v ) ) },
                currentHeading: function() { this.updateVehicleHeading() }
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
                buildVehicleArrowIcon: function( heading )
                {
                    var L = window.L
                    var rot = ( typeof heading === "number" && isFinite( heading ) ) ? heading : null
                    var hasHeading = rot != null
                    var html = hasHeading
                        ? '<div class="event-vehicle-arrow" style="transform: rotate(' + rot + 'deg)"><svg viewBox="-12 -12 24 24" width="22" height="22"><polygon points="0,-9 6,6 0,3 -6,6" fill="#0d6efd" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg></div>'
                        : '<div class="event-vehicle-dot"></div>'

                    return L.divIcon( {
                        className: "event-vehicle-marker",
                        html: html,
                        iconSize: [ 22, 22 ],
                        iconAnchor: [ 11, 11 ]
                    } )
                },
                updateVehicle: function( lat, lon )
                {
                    if ( !this._map || lat == null || lon == null ) return

                    var next = { lat: lat, lon: lon }

                    if ( coordsEqual( this._vehicleCoords, next ) ) return

                    this._vehicleCoords = next

                    var L = window.L
                    var heading = toFiniteNumber( this.currentHeading )

                    if ( !this._vehicleMarker )
                    {
                        this._vehicleMarker = L.marker( [ lat, lon ], {
                            icon: this.buildVehicleArrowIcon( heading ),
                            keyboard: false,
                            interactive: false
                        } ).addTo( this._map )
                    }
                    else
                    {
                        this._vehicleMarker.setLatLng( [ lat, lon ] )
                    }

                    this._map.panTo( [ lat, lon ], { animate: true, duration: 0.25 } )
                },
                updateVehicleHeading: function()
                {
                    if ( !this._vehicleMarker ) return

                    this._vehicleMarker.setIcon( this.buildVehicleArrowIcon( toFiniteNumber( this.currentHeading ) ) )
                }
            }
        }
    }

    return {
        createEventMapComponent: createEventMapComponent
    }
} ) );
