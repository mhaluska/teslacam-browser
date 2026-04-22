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
    var downloadBlob = uiUtils.downloadBlob
    var sanitizeFilenamePart = uiUtils.sanitizeFilenamePart

    var uiVideo = ( typeof window !== "undefined" && window.uiVideo )
        ? window.uiVideo
        : require( "./ui-video" )

    var uiMap = ( typeof window !== "undefined" && window.uiMap )
        ? window.uiMap
        : require( "./ui-map" )

    var uiAnalytics = ( typeof window !== "undefined" && window.uiAnalytics )
        ? window.uiAnalytics
        : require( "./ui-analytics" )

    var helpers = ( typeof window !== "undefined" && window.helpers )
        ? window.helpers
        : require( "./helpers" )

    var CAM_GRID_ALL = uiConstants.CAM_GRID_ALL
    var CAM_GRID_TOP = uiConstants.CAM_GRID_TOP
    var CAM_GRID_BOTTOM = uiConstants.CAM_GRID_BOTTOM
    var FRAME_STEP_SECONDS = uiConstants.FRAME_STEP_SECONDS
    var FRAME_STEP_LARGE_MULTIPLIER = uiConstants.FRAME_STEP_LARGE_MULTIPLIER
    var normalizeThemePreference = uiUtils.normalizeThemePreference
    var normalizeSpeedUnit = uiUtils.normalizeSpeedUnit
    var effectiveSpeedUnit = uiUtils.effectiveSpeedUnit
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
                selectionMode: false,
                selectedPaths: [],
                clipEvent: null,
                clipEventLoading: false,
                clipEventLoadId: 0,
                timespans: [],
                controls:
                {
                    playing: false,
                    timespan: null,
                    speed: 1,
                    loopStart: null,
                    loopEnd: null,
                    exporting: false
                },
                playing: null,
                loading: null,
                themePreference: "system",
                speedUnitPreference: "auto",
                confirmMessage: "",
                confirmCallback: null,
                currentGps: null,
                currentHeading: null,
                seqDiagnostics: { loading: false, results: null, error: null },
                clipAnalytics: { loading: false, error: null, samples: [], loadId: 0, shownCounter: 0 },
                diskUsage: { loading: false, error: null, data: null },
                diskUsageOpen: false,
                cleanupDays: 30,
                cleanupReasons: { SavedClips: false, SentryClips: true, RecentClips: false },
                cleanupPreview: null,
                cleanupBusy: false
                }
            },
            provide: function()
            {
                var self = this

                return {
                    publishGps: function( gps )
                    {
                        if ( !gps || typeof gps.lat !== "number" || typeof gps.lon !== "number" ) return

                        // Keep the map on the trigger location until the user presses play
                        // for this event. Once unlocked, keep tracking even when paused or scrubbing.
                        if ( !self.controls.playing && !self.currentGps ) return

                        var heading = ( typeof gps.heading === "number" && isFinite( gps.heading ) ) ? gps.heading : null

                        if ( self.currentHeading !== heading ) self.currentHeading = heading

                        var prev = self.currentGps

                        if ( prev && prev.lat === gps.lat && prev.lon === gps.lon ) return

                        self.currentGps = { lat: gps.lat, lon: gps.lon }
                    },
                    getSpeedUnit: function()
                    {
                        return self.resolvedSpeedUnit
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
                    this.selectedPaths = []
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
                    this._resetClipAnalytics()

                    if ( newPath )
                    {
                        // Unmount the previous clip's videos before firing the
                        // new fetches. Otherwise the active <video> elements
                        // keep saturating the HTTP/1.1 pool while the files/
                        // eventJson requests queue behind them, producing a
                        // long stall when switching dates during playback.
                        this.timespans = []
                        this.loading = 0

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
                                var timespans = files
                                    .map( ( [ key, value ] ) => makeTimespan( key, value ) )

                                // Kick off the front-cam telemetry fetch before
                                // the synchronized-video mounts so it enters the
                                // HTTP/1.1 connection pool ahead of the video
                                // preloads that would otherwise saturate it.
                                if ( timespans.length > 0 && timespans[ 0 ].viewMap )
                                {
                                    var front = timespans[ 0 ].viewMap.get( "front" )

                                    if ( front ) uiVideo.primeClipTelemetry( front.filePath, handlers )
                                }

                                this.timespans = timespans
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
                        this.controls.loopStart = null
                        this.controls.loopEnd = null
                    }

                    this.tryAutoSeek()
                },
                currentTime: function( newTime )
                {
                    var a = this.controls.loopStart
                    var b = this.controls.loopEnd

                    if ( a == null || b == null ) return
                    if ( !this.controls.playing ) return
                    if ( !( newTime >= b ) ) return
                    if ( this._loopWrapping ) return
                    if ( this.controls.exporting ) return

                    // Pause → seek → resume. While playing, each video's timeChanged
                    // handler writes video.currentTime back into timespan.currentTime,
                    // so a naive write to currentTime would be overwritten on the next
                    // frame. Cycling playing re-fires startPlayback which seeks each
                    // video to the new timespan.currentTime.
                    var self = this

                    self._loopWrapping = true
                    self.controls.playing = false
                    self.currentTime = a

                    Vue.nextTick( function()
                    {
                        self.controls.playing = true
                        self._loopWrapping = false
                    } )
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
                loopRangeStyle: function()
                {
                    var a = this.controls.loopStart
                    var b = this.controls.loopEnd
                    var total = this.duration

                    if ( a == null || b == null || !( total > 0 ) ) return { display: "none" }

                    var lo = Math.max( 0, Math.min( 100, ( Math.min( a, b ) / total ) * 100 ) )
                    var hi = Math.max( 0, Math.min( 100, ( Math.max( a, b ) / total ) * 100 ) )

                    return { left: lo + "%", width: ( hi - lo ) + "%" }
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
                clipAnalyticsEventLabel: function()
                {
                    if ( !this.clipEvent ) return ""

                    var parts = []

                    if ( this.clipEvent.timestamp ) parts.push( this.clipEvent.timestamp )
                    if ( this.clipEvent.city ) parts.push( this.clipEvent.city )

                    return parts.join( " — " )
                },
                clipAnalyticsBaseTime: function()
                {
                    if ( !this.timespans || !this.timespans.length ) return null

                    var first = this.timespans[ 0 ]
                    var t = first && first.time

                    if ( t instanceof Date && !isNaN( t.getTime() ) )
                    {
                        var dur = ( first && typeof first.duration === "number" && isFinite( first.duration ) ) ? first.duration : 0

                        // `timespan.time` is the END of the first clip; subtract its duration
                        // so baseTime lines up with tSec = 0 at the start of the first clip.
                        return new Date( t.getTime() - dur * 1000 )
                    }

                    return null
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
                },
                resolvedSpeedUnit: function()
                {
                    var timezone = ""

                    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "" }
                    catch ( _e ) { timezone = "" }

                    return effectiveSpeedUnit( this.speedUnitPreference, timezone )
                },
                speedUnitCycleIconClass: function()
                {
                    return "bi bi-speedometer2"
                },
                speedUnitCycleTitle: function()
                {
                    var resolved = this.resolvedSpeedUnit === "mi" ? "mph" : "km/h"

                    if ( this.speedUnitPreference === "auto" ) return "Speed: Auto (" + resolved + ") — click for km/h"
                    if ( this.speedUnitPreference === "km" ) return "Speed: km/h — click for mph"

                    return "Speed: mph — click for Auto"
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

                function applySpeedUnit( pref )
                {
                    self.speedUnitPreference = normalizeSpeedUnit( pref )
                }

                if ( handlers.getSpeedUnit ) handlers.getSpeedUnit( applySpeedUnit )
                else applySpeedUnit( "auto" )

                self._keydownListener = function( e ) { self.handleGlobalKey( e ) }
                window.addEventListener( "keydown", self._keydownListener )
            },
            beforeUnmount: function()
            {
                var self = this

                if ( self._systemMq && self._systemThemeListener )
                {
                    if ( self._systemMq.removeEventListener ) self._systemMq.removeEventListener( "change", self._systemThemeListener )
                    else if ( self._systemMq.removeListener ) self._systemMq.removeListener( self._systemThemeListener )
                }

                if ( self._keydownListener )
                {
                    window.removeEventListener( "keydown", self._keydownListener )
                    self._keydownListener = null
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
                setSpeedUnitPreference: function( mode )
                {
                    var self = this
                    var m = normalizeSpeedUnit( mode )

                    function done()
                    {
                        self.speedUnitPreference = m
                    }

                    if ( handlers.setSpeedUnit ) handlers.setSpeedUnit( m, done )
                    else done()
                },
                cycleSpeedUnitPreference: function()
                {
                    var order = [ "auto", "km", "mi" ]
                    var i = order.indexOf( this.speedUnitPreference )

                    if ( i < 0 ) i = 0

                    this.setSpeedUnitPreference( order[ ( i + 1 ) % order.length ] )
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
                toggleSelectionMode: function()
                {
                    this.selectionMode = !this.selectionMode
                    if ( !this.selectionMode ) this.selectedPaths = []
                },
                toggleSelectedPath: function( relative )
                {
                    var i = this.selectedPaths.indexOf( relative )
                    if ( i < 0 ) this.selectedPaths.push( relative )
                    else this.selectedPaths.splice( i, 1 )
                },
                selectAllVisible: function()
                {
                    this.selectedPaths = this.times.map( t => t.time.relative )
                },
                clearSelection: function()
                {
                    this.selectedPaths = []
                },
                bulkCopyPaths: function()
                {
                    if ( !this.selectedPaths.length ) return

                    handlers.copyFilePaths( this.selectedPaths.slice() )
                    alert( "Copied " + this.selectedPaths.length + " path(s) to clipboard" )
                },
                bulkDeleteFolders: function()
                {
                    var self = this
                    var paths = this.selectedPaths.slice()

                    if ( !paths.length ) return
                    if ( !handlers.bulkDeleteFolders )
                    {
                        alert( "Bulk delete not supported in this build" )
                        return
                    }

                    this.showConfirm(
                        "Are you sure you want to delete " + paths.length + " event folder(s)?",
                        async function()
                        {
                            var result = await handlers.bulkDeleteFolders( paths )
                            var failed = ( result && result.failed ) || []

                            if ( failed.length )
                            {
                                alert( "Deleted " + ( paths.length - failed.length ) + " / " + paths.length
                                    + ". " + failed.length + " failed:\n"
                                    + failed.map( f => f.path + ": " + f.error ).join( "\n" ) )
                            }

                            self.selectionMode = false
                            self.selectedPaths = []
                            self.timespans = []
                            self.selectedTime = null
                            self.selectedPath = null

                            handlers.reopenFolders( self.loaded )
                        } )
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
                handleGlobalKey: function( e )
                {
                    if ( e.defaultPrevented ) return
                    if ( e.ctrlKey || e.metaKey || e.altKey ) return

                    var t = e.target
                    if ( t )
                    {
                        var tag = t.tagName
                        if ( tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ) return
                        if ( t.isContentEditable ) return
                    }

                    if ( document.querySelector( ".modal.show" ) ) return

                    if ( !this.timespans || !this.timespans.length ) return
                    if ( !( this.duration > 0 ) ) return

                    var key = e.key

                    if ( key === "ArrowLeft" )
                    {
                        this.stepFrames( e.shiftKey ? -FRAME_STEP_LARGE_MULTIPLIER : -1 )
                        e.preventDefault()
                    }
                    else if ( key === "ArrowRight" )
                    {
                        this.stepFrames( e.shiftKey ? FRAME_STEP_LARGE_MULTIPLIER : 1 )
                        e.preventDefault()
                    }
                    else if ( key === " " || key === "Spacebar" )
                    {
                        this.controls.playing = !this.controls.playing
                        e.preventDefault()
                    }
                    else if ( key === "[" )
                    {
                        this.setLoopA()
                        e.preventDefault()
                    }
                    else if ( key === "]" )
                    {
                        this.setLoopB()
                        e.preventDefault()
                    }
                    else if ( key === "\\" )
                    {
                        this.clearLoop()
                        e.preventDefault()
                    }
                },
                stepFrames: function( frames )
                {
                    if ( !( this.duration > 0 ) ) return

                    this.controls.playing = false

                    var next = this.currentTime + frames * FRAME_STEP_SECONDS
                    // Clamp just shy of total — the currentTime setter uses a strict
                    // `<` comparison against the end, so duration itself never matches.
                    var maxSeek = this.duration - 0.001

                    if ( next < 0 ) next = 0
                    else if ( next > maxSeek ) next = maxSeek

                    this.currentTime = next
                },
                skipSeconds: function( seconds )
                {
                    if ( !( this.duration > 0 ) ) return

                    var wasPlaying = this.controls.playing
                    var next = this.currentTime + seconds
                    var maxSeek = this.duration - 0.001

                    if ( next < 0 ) next = 0
                    else if ( next > maxSeek ) next = maxSeek

                    // Cycle playback if needed so each <video> re-seeks — same reason
                    // as the loop-wrap watcher: while playing, timeChanged writes the
                    // raw video.currentTime back onto timespan.currentTime, which would
                    // otherwise clobber a naive jump.
                    if ( wasPlaying )
                    {
                        var self = this

                        self.controls.playing = false
                        self.currentTime = next

                        Vue.nextTick( function()
                        {
                            self.controls.playing = true
                        } )
                    }
                    else
                    {
                        this.currentTime = next
                    }
                },
                loopMarkerStyle: function( t )
                {
                    var total = this.duration

                    if ( t == null || !( total > 0 ) ) return { display: "none" }

                    var pct = Math.max( 0, Math.min( 100, ( t / total ) * 100 ) )

                    return { left: pct + "%" }
                },
                setLoopA: function()
                {
                    var t = this.currentTime

                    if ( t == null || !isFinite( t ) ) return

                    this.controls.loopStart = t

                    if ( this.controls.loopEnd != null && this.controls.loopEnd <= t )
                    {
                        this.controls.loopEnd = null
                    }
                },
                setLoopB: function()
                {
                    var t = this.currentTime

                    if ( t == null || !isFinite( t ) ) return

                    this.controls.loopEnd = t

                    if ( this.controls.loopStart != null && this.controls.loopStart >= t )
                    {
                        this.controls.loopStart = null
                    }
                },
                clearLoop: function()
                {
                    this.controls.loopStart = null
                    this.controls.loopEnd = null
                },
                currentClipBaseName: function()
                {
                    var ts = this.controls && this.controls.timespan
                    var view = ts && ts.viewMap ? ts.viewMap.get( "front" ) : null

                    if ( view && view.fileName ) return view.fileName.replace( /\.[^.]+$/, "" ).replace( /-front$/, "" )

                    return "teslacam-clip"
                },
                exportRangeWebm: function()
                {
                    if ( this.controls.exporting ) return

                    var a = this.controls.loopStart
                    var b = this.controls.loopEnd

                    if ( a == null || b == null || !( b > a ) ) return
                    if ( typeof MediaRecorder === "undefined" ) { console.error( "MediaRecorder unavailable" ); return }

                    var front = document.querySelector( "video.video.front" )

                    if ( !front || typeof front.captureStream !== "function" )
                    {
                        console.error( "front camera video not ready or captureStream unsupported" )

                        return
                    }

                    var mime = [
                        "video/webm;codecs=vp9",
                        "video/webm;codecs=vp8",
                        "video/webm"
                    ].find( function( m ) { return MediaRecorder.isTypeSupported( m ) } )

                    if ( !mime ) { console.error( "no supported WebM MIME type" ); return }

                    var self = this
                    var chunks = []
                    var stream = front.captureStream( 36 )
                    var rec = new MediaRecorder( stream, { mimeType: mime } )

                    rec.ondataavailable = function( e ) { if ( e.data && e.data.size ) chunks.push( e.data ) }

                    var savedSpeed = self.controls.speed
                    var fileName = sanitizeFilenamePart( self.currentClipBaseName() )
                        + "_range_" + a.toFixed( 3 ) + "-" + b.toFixed( 3 ) + "s.webm"
                    var stopTimer = null
                    var rafHandle = null

                    function cleanup()
                    {
                        if ( rafHandle )
                        {
                            window.cancelAnimationFrame( rafHandle )
                            rafHandle = null
                        }

                        if ( stopTimer )
                        {
                            window.clearTimeout( stopTimer )
                            stopTimer = null
                        }

                        self.controls.speed = savedSpeed
                        self.controls.exporting = false
                    }

                    rec.onstop = function()
                    {
                        cleanup()
                        self.controls.playing = false

                        var blob = new Blob( chunks, { type: mime } )

                        if ( blob.size ) downloadBlob( fileName, blob )
                        else console.error( "export produced 0 bytes" )
                    }

                    rec.onerror = function( e )
                    {
                        console.error( "MediaRecorder error:", e && e.error ? e.error : e )
                        cleanup()
                    }

                    self.controls.exporting = true
                    self.controls.playing = false
                    self.controls.speed = 1
                    self.currentTime = a

                    // Wait one seeked event on the front camera before starting, then
                    // kick off playback and poll currentTime for the stop condition.
                    function onSeeked()
                    {
                        front.removeEventListener( "seeked", onSeeked )

                        try { rec.start( 100 ) }
                        catch ( err ) { console.error( "rec.start failed:", err ); cleanup(); return }

                        self.controls.playing = true

                        function poll()
                        {
                            if ( rec.state !== "recording" ) return

                            if ( self.currentTime >= b )
                            {
                                try { rec.stop() } catch ( _ ) { /* noop */ }

                                return
                            }

                            rafHandle = window.requestAnimationFrame( poll )
                        }

                        rafHandle = window.requestAnimationFrame( poll )

                        // Safety ceiling: 1.5x the wall-clock length of the range.
                        var maxMs = Math.max( 2000, Math.ceil( ( b - a ) * 1500 ) )

                        stopTimer = window.setTimeout( function()
                        {
                            if ( rec.state === "recording" )
                            {
                                console.warn( "export safety timeout — stopping recorder" )
                                try { rec.stop() } catch ( _ ) { /* noop */ }
                            }
                        }, maxMs )
                    }

                    front.addEventListener( "seeked", onSeeked )
                },
                snapshotMosaic: function()
                {
                    var ts = this.controls && this.controls.timespan

                    if ( !ts || !ts.views ) return

                    var rows = [ CAM_GRID_TOP, CAM_GRID_BOTTOM ]
                    var rowEls = rows.map( function( row )
                    {
                        return row.map( function( cam )
                        {
                            return document.querySelector( "video.video." + cam )
                        } )
                    } )

                    var anyVideo = null
                    var cellW = 0
                    var cellH = 0

                    for ( var r = 0; r < rowEls.length; r++ )
                    {
                        for ( var c = 0; c < rowEls[ r ].length; c++ )
                        {
                            var v = rowEls[ r ][ c ]

                            if ( v && v.videoWidth && v.videoHeight )
                            {
                                if ( !anyVideo ) anyVideo = v
                                if ( v.videoWidth > cellW ) cellW = v.videoWidth
                                if ( v.videoHeight > cellH ) cellH = v.videoHeight
                            }
                        }
                    }

                    if ( !anyVideo ) return

                    // Downscale so the mosaic never exceeds ~2400 px wide.
                    var maxMosaicWidth = 2400
                    var scale = Math.min( 1, maxMosaicWidth / ( cellW * 3 ) )
                    var tileW = Math.round( cellW * scale )
                    var tileH = Math.round( cellH * scale )
                    var canvas = document.createElement( "canvas" )

                    canvas.width = tileW * 3
                    canvas.height = tileH * 2

                    var ctx = canvas.getContext( "2d" )

                    ctx.fillStyle = "#000"
                    ctx.fillRect( 0, 0, canvas.width, canvas.height )

                    try
                    {
                        for ( var rr = 0; rr < rowEls.length; rr++ )
                        {
                            for ( var cc = 0; cc < rowEls[ rr ].length; cc++ )
                            {
                                var el = rowEls[ rr ][ cc ]

                                if ( el && el.videoWidth && el.videoHeight )
                                {
                                    ctx.drawImage( el, cc * tileW, rr * tileH, tileW, tileH )
                                }
                            }
                        }

                        var t = this.currentTime || 0
                        var name = sanitizeFilenamePart( this.currentClipBaseName() ) + "_mosaic_t" + t.toFixed( 3 ) + "s.png"

                        canvas.toBlob( function( blob )
                        {
                            if ( blob ) downloadBlob( name, blob )
                            else console.error( "mosaic snapshot: toBlob returned null (canvas tainted?)" )
                        }, "image/png" )
                    }
                    catch ( e )
                    {
                        console.error( "mosaic snapshot failed:", e && e.message ? e.message : e )
                    }
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

                    this.showConfirm( `Are you sure you want to delete ${files.length} files from ${timespan.title}?`, async () =>
                    {
                        await handlers.deleteFiles( files )

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
                _resetClipAnalytics: function( patch )
                {
                    var prev = this.clipAnalytics || {}
                    var base = {
                        loading: false,
                        error: null,
                        samples: [],
                        loadId: ( typeof prev.loadId === "number" ? prev.loadId : 0 ) + 1,
                        shownCounter: ( typeof prev.shownCounter === "number" ? prev.shownCounter : 0 )
                    }

                    this.clipAnalytics = Object.assign( base, patch || {} )
                },
                openClipAnalytics: function()
                {
                    var self = this

                    self.$nextTick( function()
                    {
                        var el = document.getElementById( "clipAnalyticsModal" )

                        if ( !el || !window.bootstrap ) return

                        if ( !self._clipAnalyticsShownBound )
                        {
                            el.addEventListener( "shown.bs.modal", function()
                            {
                                var prev = self.clipAnalytics.shownCounter
                                var next = ( typeof prev === "number" && isFinite( prev ) ) ? prev + 1 : 1

                                self.clipAnalytics = Object.assign( {}, self.clipAnalytics, { shownCounter: next } )
                            } )
                            self._clipAnalyticsShownBound = true
                        }

                        window.bootstrap.Modal.getOrCreateInstance( el ).show()
                    } )

                    if ( !handlers.getClipTelemetry )
                    {
                        self._resetClipAnalytics( { error: "Unsupported in this build" } )

                        return
                    }

                    if ( !self.timespans || !self.timespans.length )
                    {
                        self._resetClipAnalytics( { error: "No clip loaded" } )

                        return
                    }

                    var fetches = []

                    self.timespans.forEach( function( ts )
                    {
                        var front = ts.viewMap ? ts.viewMap.get( "front" ) : null

                        if ( front ) fetches.push( { timespan: ts, view: front } )
                    } )

                    if ( !fetches.length )
                    {
                        self._resetClipAnalytics( { error: "No front-camera clips available" } )

                        return
                    }

                    self._resetClipAnalytics( { loading: true } )

                    var token = self.clipAnalytics.loadId
                    var pending = fetches.length
                    var perClip = new Array( fetches.length )

                    fetches.forEach( function( f, idx )
                    {
                        handlers.getClipTelemetry( f.view.filePath, function( res )
                        {
                            if ( token !== self.clipAnalytics.loadId ) return

                            perClip[ idx ] = {
                                timespan: f.timespan,
                                samples: ( res && Array.isArray( res.samples ) ) ? res.samples : [],
                                error: ( res && res.error ) ? res.error : null
                            }

                            if ( --pending === 0 )
                            {
                                var offset = 0
                                var stitched = []
                                var firstError = null

                                for ( var i = 0; i < perClip.length; i++ )
                                {
                                    var entry = perClip[ i ]

                                    if ( entry.error && !firstError ) firstError = entry.error

                                    for ( var j = 0; j < entry.samples.length; j++ )
                                    {
                                        var s = entry.samples[ j ]
                                        var t = ( typeof s.tSec === "number" && isFinite( s.tSec ) ) ? s.tSec : 0
                                        var copy = Object.assign( {}, s, { tSec: t + offset, timespanIndex: i, localTSec: t } )

                                        stitched.push( copy )
                                    }

                                    var dur = ( entry.timespan && isFinite( entry.timespan.duration ) ) ? Number( entry.timespan.duration ) : 0

                                    offset += dur
                                }

                                self.clipAnalytics = Object.assign( {}, self.clipAnalytics, {
                                    loading: false,
                                    error: ( !stitched.length && firstError ) ? firstError : null,
                                    samples: stitched
                                } )
                            }
                        } )
                    } )
                },
                seekToSampleTime: function( tSec )
                {
                    if ( typeof tSec !== "number" || !isFinite( tSec ) ) return

                    var total = this.duration

                    if ( !( total > 0 ) ) return

                    this.controls.playing = false
                    this.currentTime = Math.max( 0, Math.min( total, tSec ) )
                },
                openSeqDiagnostics: function()
                {
                    var self = this

                    self.seqDiagnostics = { loading: true, results: null, error: null }

                    self.$nextTick( function()
                    {
                        var el = document.getElementById( "seqDiagnosticsModal" )

                        if ( el && window.bootstrap ) window.bootstrap.Modal.getOrCreateInstance( el ).show()
                    } )

                    if ( !handlers.getClipSeqSummary )
                    {
                        self.seqDiagnostics = { loading: false, results: null, error: "Unsupported in this build" }

                        return
                    }

                    var timespan = self.controls.timespan || ( self.timespans.length ? self.timespans[ 0 ] : null )

                    if ( !timespan || !timespan.views || !timespan.views.length )
                    {
                        self.seqDiagnostics = { loading: false, results: null, error: "No clip loaded" }

                        return
                    }

                    var views = timespan.views.slice()
                    var pending = views.length
                    var results = []

                    views.forEach( function( v, idx )
                    {
                        handlers.getClipSeqSummary( v.filePath, function( res )
                        {
                            results[ idx ] = { camera: v.camera, fileName: v.fileName, summary: res || { error: "empty" } }

                            if ( --pending === 0 )
                            {
                                var baseline = null

                                for ( var i = 0; i < results.length; i++ )
                                {
                                    var s = results[ i ].summary
                                    if ( s && !s.error && typeof s.firstSeq === "number" ) { baseline = s.firstSeq; break }
                                }

                                results.forEach( function( r )
                                {
                                    if ( r.summary && !r.summary.error && typeof r.summary.firstSeq === "number" && baseline != null )
                                        r.delta = r.summary.firstSeq - baseline
                                    else
                                        r.delta = null
                                } )

                                self.seqDiagnostics = { loading: false, results: results, error: null }
                            }
                        } )
                    } )
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
                    this.showConfirm( `Are you sure you want to delete ${folder}?`, async () =>
                    {
                        await handlers.deleteFolder( folder )

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
                formatBytes: function( bytes )
                {
                    if ( bytes == null || !isFinite( bytes ) ) return "—"
                    if ( bytes < 1024 ) return bytes + " B"

                    var units = [ "KB", "MB", "GB", "TB" ]
                    var n = bytes / 1024
                    var i = 0

                    while ( n >= 1024 && i < units.length - 1 ) { n /= 1024; i++ }

                    return ( n >= 10 ? n.toFixed( 0 ) : n.toFixed( 1 ) ) + " " + units[ i ]
                },
                loadDiskUsage: function()
                {
                    var self = this

                    if ( !handlers.getDiskUsage )
                    {
                        self.diskUsage = { loading: false, error: "Unsupported in this build", data: null }
                        return
                    }

                    self.diskUsage = { loading: true, error: null, data: self.diskUsage && self.diskUsage.data }

                    handlers.getDiskUsage( function( res )
                    {
                        if ( res && res.error )
                            self.diskUsage = { loading: false, error: String( res.error ), data: null }
                        else
                            self.diskUsage = { loading: false, error: null, data: res || null }
                    } )
                },
                toggleDiskUsage: function()
                {
                    this.diskUsageOpen = !this.diskUsageOpen
                    if ( this.diskUsageOpen && !this.diskUsage.data && !this.diskUsage.loading )
                        this.loadDiskUsage()
                },
                selectedCleanupReasons: function()
                {
                    var out = []
                    for ( var k in this.cleanupReasons )
                    {
                        if ( this.cleanupReasons[ k ] ) out.push( k )
                    }
                    return out
                },
                previewCleanup: function()
                {
                    var self = this

                    if ( !handlers.cleanupOlderThan )
                    {
                        self.cleanupPreview = { error: "Unsupported in this build" }
                        return
                    }

                    var reasons = self.selectedCleanupReasons()
                    var days = Number( self.cleanupDays )

                    if ( !reasons.length ) { self.cleanupPreview = { error: "Pick at least one reason" }; return }
                    if ( !isFinite( days ) || days < 0 ) { self.cleanupPreview = { error: "Invalid days" }; return }

                    self.cleanupBusy = true
                    self.cleanupPreview = null

                    handlers.cleanupOlderThan( { days: days, reasons: reasons, dryRun: true }, function( res )
                    {
                        self.cleanupBusy = false

                        if ( !res ) { self.cleanupPreview = { error: "request_failed" }; return }
                        if ( res.error ) { self.cleanupPreview = { error: res.error }; return }

                        self.cleanupPreview = { count: res.count, bytes: res.bytes, paths: res.paths || [] }
                    } )
                },
                runCleanup: function()
                {
                    var self = this

                    if ( !self.cleanupPreview || self.cleanupPreview.error ) return
                    if ( !self.cleanupPreview.count ) return

                    var reasons = self.selectedCleanupReasons()
                    var days = Number( self.cleanupDays )

                    self.showConfirm(
                        "Delete " + self.cleanupPreview.count + " event folder(s) older than "
                            + days + " days (" + self.formatBytes( self.cleanupPreview.bytes ) + ")?",
                        function()
                        {
                            self.cleanupBusy = true

                            handlers.cleanupOlderThan( { days: days, reasons: reasons, dryRun: false }, function( res )
                            {
                                self.cleanupBusy = false

                                if ( !res || res.error )
                                {
                                    self.cleanupPreview = { error: ( res && res.error ) || "request_failed" }
                                    return
                                }

                                var failed = ( res.failed || [] ).length

                                if ( failed )
                                {
                                    alert( "Cleanup: " + res.deleted.length + " deleted, " + failed + " failed." )
                                }

                                self.cleanupPreview = null
                                self.loadDiskUsage()
                                handlers.reopenFolders( self.loaded )
                            } )
                        } )
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
        app.component( "MetadataProbe", uiVideo.createMetadataProbeComponent( handlers ) )
        app.component( "EventMap", uiMap.createEventMapComponent() )
        app.component( "ClipAnalytics", uiAnalytics.createClipAnalyticsComponent() )

        var vueApp = app.mount( '#root' )

        handlers.openFolder( null, f => vueApp.args = f )

        return vueApp
    }

    return {
        initialize: initialize
    }
} ) );
