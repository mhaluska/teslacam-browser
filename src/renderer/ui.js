( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.ui = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
    var uiConstants = ( typeof window !== "undefined" && window.uiConstants )
        ? window.uiConstants
        : require( "./ui-constants" )

    var uiUtils = ( typeof window !== "undefined" && window.uiUtils )
        ? window.uiUtils
        : require( "./ui-utils" )

    var uiVideo = ( typeof window !== "undefined" && window.uiVideo )
        ? window.uiVideo
        : require( "./ui-video" )

    var uiMap = ( typeof window !== "undefined" && window.uiMap )
        ? window.uiMap
        : require( "./ui-map" )

    var helpers = ( typeof window !== "undefined" && window.helpers )
        ? window.helpers
        : require( "./helpers" )

    var CAM_GRID_ALL = uiConstants.CAM_GRID_ALL
    var normalizeThemePreference = uiUtils.normalizeThemePreference
    var humanizeReason = helpers.humanizeReason
    var shortenReason = helpers.shortenReason
    var isTriggerReason = helpers.isTriggerReason
    var parseEventTimestamp = helpers.parseEventTimestamp
    var computeTriggerOffsetSeconds = helpers.computeTriggerOffsetSeconds

    function createVueApp( handlers )
    {
        var args = { version: null };

        return {
            data: function()
            {
                return {
                args: args,
                showSidebar: true,
                showFolders: false,
                combineClips: true,
                parsedPath: null,
                selectedFolder: null,
                selectedDate: new Date(),
                times: [],
                selectedTime: null,
                selectedPath: null,
                clipEvent: null,
                clipEventLoading: false,
                clipEventLoadId: 0,
                timespans: [],
                controls:
                {
                    playing: false,
                    timespan: null,
                    speed: 1
                },
                playing: null,
                loading: null,
                themePreference: "system",
                confirmMessage: "",
                confirmCallback: null,
                currentGps: null
                }
            },
            provide: function()
            {
                var self = this

                return {
                    publishGps: function( gps )
                    {
                        if ( !gps || typeof gps.lat !== "number" || typeof gps.lon !== "number" ) return

                        var prev = self.currentGps

                        if ( prev && prev.lat === gps.lat && prev.lon === gps.lon ) return

                        self.currentGps = { lat: gps.lat, lon: gps.lon }
                    }
                }
            },
            watch:
            {
                selectedFolder: function( folder, oldFolder )
                {
                    if ( folder )
                    {
                        handlers.openFolder( folder, f => this.args = f )
                    }
                },
                selectedDate: function( newDate, oldDate )
                {
                    this.setDate( newDate )
                },
                selectedTime: function( newTime, oldTime )
                {
                    var index = this.times.indexOf( newTime )

                    if ( index >= 0 && index < this.times.length )
                    {
                        var time = this.times[ index ]

                        this.selectedPath = time.time.relative
                    }
                    else
                    {
                        this.selectedPath = null
                    }
                },
                selectedPath: function( newPath, oldPath )
                {
                    function makeTimespan( key, value )
                    {
                        var views = Array.from( value )

                        views.sort( function( v1, v2 )
                        {
                            var i1 = CAM_GRID_ALL.indexOf( v1.camera )
                            var i2 = CAM_GRID_ALL.indexOf( v2.camera )
                            var k1 = i1 >= 0 ? i1 : CAM_GRID_ALL.length
                            var k2 = i2 >= 0 ? i2 : CAM_GRID_ALL.length

                            if ( k1 !== k2 ) return k1 - k2

                            return v1.camera.localeCompare( v2.camera )
                        } )

                        var viewMap = new Map( views.map( function( v ) { return [ v.camera, v ] } ) )

                        return {    // Timespan
                            title: key,
                            time: new Date( key ),
                            scrub: 0,
                            playing: false,
                            visible: false,
                            currentTime: 0,
                            duration: null,
                            ended: false,
                            views: views,
                            viewMap: viewMap
                        }
                    }

                    this.currentGps = null

                    if ( newPath )
                    {
                        var self = this
                        var token = ++self.clipEventLoadId

                        self.clipEventLoading = true
                        self.clipEvent = null

                        handlers.readEventJson( newPath, function( data )
                        {
                            if ( token !== self.clipEventLoadId ) return

                            self.clipEventLoading = false
                            self.clipEvent = data
                            self._pendingAutoSeek = newPath
                            self.tryAutoSeek()
                        } )

                        handlers.getFiles( newPath, files =>
                            {
                                this.timespans = files
                                    .map( ( [ key, value ] ) => makeTimespan( key, value ) )
                            } )
                    }
                    else
                    {
                        this.clipEventLoadId++
                        this.clipEventLoading = false
                        this.clipEvent = null
                        this.timespans = []
                        this._pendingAutoSeek = null
                    }
                },
                "args.dates": function( dates, oldDates )
                {
                    flatpickr(
                        document.querySelector( "#calendar" ),
                        {
                            onChange: d => this.selectedDate = d[ 0 ],
                            enable: dates,
                            inline: true,
                            defaultDate: this.selectedDate
                        } )
                },
                "controls.timespan.ended": function( ended, oldEnded )
                {
                    if ( ended && this.controls.playing )
                    {
                        var index = this.timespans.indexOf( this.controls.timespan )

                        if ( index < this.timespans.length - 1 )
                        {
                            var oldTimespan = this.controls.timespan
                            var timespan = this.timespans[ index + 1 ]

                            this.controls.timespan = timespan

                            timespan.currentTime = 0
                            timespan.ended = false
                            timespan.visible = true

                            if ( oldTimespan )
                            {
                                oldTimespan.ended = false
                                oldTimespan.visible = false
                            }

                            Vue.nextTick( () =>
                            {
                                timespan.playing = true

                                if ( oldTimespan ) oldTimespan.playing = false
                            } )
                        }
                        else
                        {
                            this.controls.playing = false
                        }
                    }
                },
                "controls.timespan.playing": function( playing, oldPlaying )
                {
                    if ( !playing && this.controls.timespan && this.controls.timespan.ended ) return

                    this.controls.playing = playing
                },
                duration: function( duration )
                {
                    if ( this._lastResetTimespans !== this.timespans )
                    {
                        this._lastResetTimespans = this.timespans
                        this.controls.timespan = ( this.timespans.length > 0 ) ? this.timespans[ 0 ] : null
                        this.controls.playing = false
                        this.controls.scrub = 0
                    }

                    this.tryAutoSeek()
                }
            },
            computed:
            {
                duration: function()
                {
                    if ( !this.timespans || this.timespans.length < 1 ) return 0

                    var pending = this.timespans.filter( function( t )
                    {
                        return !( t.duration != null && isFinite( t.duration ) && t.duration > 0 )
                    } )

                    this.loading = ( pending.length > 0 )
                        ? Math.round( ( 1.0 - ( pending.length / this.timespans.length ) ) * 100 )
                        : null

                    return this.timespans.reduce( function( t, ts )
                    {
                        var d = ts.duration

                        return t + ( ( d != null && isFinite( d ) ) ? d : 0 )
                    }, 0 )
                },
                currentTime:
                {
                    get: function()
                    {
                        var startTime = 0

                        for ( var timespan of this.timespans )
                        {
                            if ( timespan == this.controls.timespan )
                            {
                                return startTime + Number( timespan.currentTime )
                            }
    
                            startTime += timespan.duration
                        }
                    },
                    set: function( newTime )
                    {
                        var startTime = 0

                        for ( var timespan of this.timespans )
                        {
                            if ( newTime < startTime + timespan.duration )
                            {
                                this.controls.timespan = timespan
                                timespan.currentTime = newTime - startTime
                                break
                            }

                            startTime += timespan.duration
                        }
                    }
                },
                triggerOffsetSeconds: function()
                {
                    if ( !this.clipEvent || !this.timespans || this.timespans.length < 1 ) return null
                    if ( !isTriggerReason( this.clipEvent.reason ) ) return null

                    var trigger = parseEventTimestamp( this.clipEvent.timestamp )
                    if ( !trigger ) return null

                    return computeTriggerOffsetSeconds( this.timespans, trigger )
                },
                triggerMarkerStyle: function()
                {
                    var offset = this.triggerOffsetSeconds
                    var total = this.duration

                    if ( offset == null || !( total > 0 ) ) return { display: "none" }

                    var pct = Math.max( 0, Math.min( 100, ( offset / total ) * 100 ) )

                    return { left: pct + "%" }
                },
                triggerMarkerTitle: function()
                {
                    if ( !this.clipEvent || this.triggerOffsetSeconds == null ) return ""

                    return humanizeReason( this.clipEvent.reason ) || "Trigger"
                },
                eventLatNum: function()
                {
                    if ( !this.clipEvent ) return null

                    var lat = parseFloat( this.clipEvent.est_lat )

                    return isFinite( lat ) ? lat : null
                },
                eventLonNum: function()
                {
                    if ( !this.clipEvent ) return null

                    var lon = parseFloat( this.clipEvent.est_lon )

                    return isFinite( lon ) ? lon : null
                },
                openStreetMapUrl: function()
                {
                    if ( !this.clipEvent ) return ""

                    var lat = parseFloat( this.clipEvent.est_lat )
                    var lon = parseFloat( this.clipEvent.est_lon )

                    if ( !isFinite( lat ) || !isFinite( lon ) ) return ""

                    return "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=17/" + lat + "/" + lon
                },
                themeCycleIconClass: function()
                {
                    if ( this.themePreference === "light" ) return "bi bi-sun"
                    if ( this.themePreference === "dark" ) return "bi bi-moon"

                    return "bi bi-display"
                },
                themeCycleTitle: function()
                {
                    if ( this.themePreference === "system" ) return "Theme: System — click for Light"
                    if ( this.themePreference === "light" ) return "Theme: Light — click for Dark"

                    return "Theme: Dark — click for System"
                }
            },
            mounted: function()
            {
                var self = this

                self._systemMq = window.matchMedia( "(prefers-color-scheme: dark)" )
                self._systemThemeListener = function()
                {
                    if ( self.themePreference === "system" ) self.applyDocumentTheme()
                }

                if ( self._systemMq.addEventListener ) self._systemMq.addEventListener( "change", self._systemThemeListener )
                else if ( self._systemMq.addListener ) self._systemMq.addListener( self._systemThemeListener )

                function applyLoaded( pref )
                {
                    self.themePreference = normalizeThemePreference( pref )
                    self.applyDocumentTheme()
                }

                if ( handlers.getThemePreference ) handlers.getThemePreference( applyLoaded )
                else applyLoaded( "system" )
            },
            beforeUnmount: function()
            {
                var self = this

                if ( self._systemMq && self._systemThemeListener )
                {
                    if ( self._systemMq.removeEventListener ) self._systemMq.removeEventListener( "change", self._systemThemeListener )
                    else if ( self._systemMq.removeListener ) self._systemMq.removeListener( self._systemThemeListener )
                }
            },
            methods:
            {
                effectiveTheme: function()
                {
                    if ( this.themePreference === "light" ) return "light"
                    if ( this.themePreference === "dark" ) return "dark"

                    return this._systemMq && this._systemMq.matches ? "dark" : "light"
                },
                applyDocumentTheme: function()
                {
                    document.documentElement.setAttribute( "data-theme", this.effectiveTheme() )
                },
                setThemePreference: function( mode )
                {
                    var self = this
                    var m = normalizeThemePreference( mode )

                    function done()
                    {
                        self.themePreference = m
                        self.applyDocumentTheme()
                    }

                    if ( handlers.setThemePreference ) handlers.setThemePreference( m, done )
                    else done()
                },
                cycleThemePreference: function()
                {
                    var order = [ "system", "light", "dark" ]
                    var i = order.indexOf( this.themePreference )

                    if ( i < 0 ) i = 0

                    this.setThemePreference( order[ ( i + 1 ) % order.length ] )
                },
                formatEventReason: function( reason )
                {
                    if ( reason == null || reason === "" ) return "—"

                    return String( reason ).replace( /_/g, " " )
                },
                displayStreet: function( street )
                {
                    if ( street == null || String( street ).trim() === "" ) return "—"

                    return street
                },
                displayCameraName: function( camera )
                {
                    var name = helpers.cameraName( camera )

                    return name || "—"
                },
                openFolders: function()
                {
                    handlers.openFolders( this.loaded )
                },
                openBrowser: function()
                {
                    handlers.openBrowser()
                },
                setDate: function( newDate )
                {
                    if ( newDate )
                    {
                        function getTimes( dateGroups, date )
                        {
                            var times = []
                            var timeValues = dateGroups.get( date.toDateString() )
                    
                            if ( timeValues )
                            {
                                for ( var time of timeValues )
                                {
                                    var name = new Date( time.date ).toLocaleTimeString()

                                    var folder = ( time.relative || "" ).split( /[/\\]/ )[ 0 ]
                                    var short = time.reason ? shortenReason( time.reason ) : null

                                    if ( short ) name = "[" + short + "] " + name
                                    else if ( folder === "RecentClips" || time.recent ) name = "[Recent] " + name
                                    else if ( folder === "SavedClips" ) name = "[Saved] " + name
                                    else if ( folder === "SentryClips" || folder === "TeslaSentry" ) name = "[Sentry] " + name

                                    var thumbUrl = ( time.hasThumb && handlers.getAssetUrl )
                                        ? handlers.getAssetUrl( time.relative + "/thumb.png" )
                                        : null

                                    times.push( { time: time, name: name, thumbUrl: thumbUrl } )
                                }
                            }
                    
                            return times
                        }
                    
                        this.times = getTimes( new Map( this.args.dateGroups ), newDate )
                        this.selectedTime = ( this.times.length > 0 ) ? this.times[ 0 ] : null
                        this.selectedPath = ( this.selectedTime ) ? this.selectedTime.time.relative : null
                    }
                    else
                    {
                        this.times = []
                        this.selectedTime = null
                        this.selectedPath = null
                    }
                },
                loaded: function( args )
                {
                    this.args = args
                },
                playPause: function( timespan )
                {
                    if ( this.controls.timespan && this.controls.timespan != timespan )
                    {
                        this.controls.timespan.playing = false
                    }

                    if ( this.controls ) this.controls.timespan = timespan

                    timespan.visible |= ( timespan.playing = !timespan.playing )
                },
                scrubInput: function( timespan )
                {
                    timespan.playing = false

                    if ( this.controls ) this.controls.timespan = timespan

                    this._pendingAutoSeek = null
                },
                tryAutoSeek: function()
                {
                    if ( !this._pendingAutoSeek || this._pendingAutoSeek !== this.selectedPath ) return
                    if ( !this.clipEvent ) return
                    if ( !this.timespans || this.timespans.length < 1 ) return

                    // Wait for every timespan to report a duration before committing —
                    // triggerOffsetSeconds is null while any is still loading, and we
                    // must not treat that loading state as "no trigger".
                    for ( var ts of this.timespans )
                    {
                        if ( !( ts.duration > 0 ) ) return
                    }

                    var total = this.duration
                    if ( !( total > 0 ) ) return

                    var offset = this.triggerOffsetSeconds
                    if ( offset == null ) { this._pendingAutoSeek = null; return }

                    this.controls.playing = false
                    this.currentTime = Math.max( 0, Math.min( total, offset - 10 ) )
                    this._pendingAutoSeek = null
                },
                deleteFiles: function( timespan )
                {
                    var files = timespan.views.map( v => v.filePath )

                    this.showConfirm( `Are you sure you want to delete ${files.length} files from ${timespan.title}?`, () =>
                    {
                        handlers.deleteFiles( files )

                        this.timespans = this.timespans.filter( t => t !== timespan )

                        if ( this.timespans.length < 1 )
                        {
                            this.times = this.times.filter( t => t.time.relative !== this.selectedPath )
                            this.selectedTime = this.times.length > 0 ? this.times[ 0 ] : null
                            this.selectedPath = this.selectedTime ? this.selectedTime.time.relative : null
                        }

                        handlers.reopenFolders( this.loaded )
                    } )
                },
                copyFilePaths: function( timespan )
                {
                    var files = timespan.views.map( v => v.filePath )

                    handlers.copyFilePaths( files )

                    alert( "Copied file paths to clipboard" )
                },
                showConfirm: function( message, callback )
                {
                    this.confirmMessage = message
                    this.confirmCallback = callback

                    this.$nextTick( () =>
                    {
                        var el = document.getElementById( "confirmDeleteModal" )
                        var modal = window.bootstrap.Modal.getOrCreateInstance( el )
                        modal.show()
                    } )
                },
                confirmAction: function()
                {
                    if ( this.confirmCallback ) this.confirmCallback()

                    this.confirmCallback = null

                    var el = document.getElementById( "confirmDeleteModal" )
                    var modal = window.bootstrap.Modal.getInstance( el )
                    if ( modal ) modal.hide()
                },
                deleteFolder: function( folder )
                {
                    this.showConfirm( `Are you sure you want to delete ${folder}?`, () =>
                    {
                        handlers.deleteFolder( folder )

                        this.timespans = []
                        this.times = this.times.filter( t => t.time.relative !== folder )
                        this.selectedTime = this.times.length > 0 ? this.times[ 0 ] : null
                        this.selectedPath = this.selectedTime ? this.selectedTime.time.relative : null

                        handlers.reopenFolders( this.loaded )
                    } )
                },
                copyPath: function( path )
                {
                    handlers.copyPath( path )
                },
                timespanTime: function( timespan )
                {
                    if ( !timespan ) return null

                    var time = new Date( timespan.time )

                    time.setSeconds( time.getSeconds() - timespan.duration + Number( timespan.currentTime ) )

                    return time
                }
            }
        }
    }

    function initialize( handlers )
    {
        var appConfig = createVueApp( handlers )
        var app = Vue.createApp( appConfig )

        app.component( "VideoGroup", uiVideo.createVideoGroupComponent( handlers ) )
        app.component( "Videos", uiVideo.createVideosComponent( handlers ) )
        app.component( "SynchronizedVideo", uiVideo.createVideoComponent( handlers ) )
        app.component( "EventMap", uiMap.createEventMapComponent() )

        var vueApp = app.mount( '#root' )

        handlers.openFolder( null, f => vueApp.args = f )

        return vueApp
    }

    return {
        initialize: initialize
    }
} ) );
