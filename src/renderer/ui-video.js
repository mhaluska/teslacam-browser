( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.uiVideo = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
    var uiConstants = ( typeof window !== "undefined" && window.uiConstants )
        ? window.uiConstants
        : require( "./ui-constants" )

    var uiUtils = ( typeof window !== "undefined" && window.uiUtils )
        ? window.uiUtils
        : require( "./ui-utils" )

    var CAM_GRID_TOP = uiConstants.CAM_GRID_TOP
    var CAM_GRID_BOTTOM = uiConstants.CAM_GRID_BOTTOM
    var CAM_GRID_ALL = uiConstants.CAM_GRID_ALL
    var DURATION_MATCH_EPSILON_SEC = uiConstants.DURATION_MATCH_EPSILON_SEC

    var pickSeiInterpolationBracket = uiUtils.pickSeiInterpolationBracket
    var blendDashSamples = uiUtils.blendDashSamples

    var METADATA_PROBE_CONCURRENCY = 3
    var METADATA_PROBE_SAFETY_TIMEOUT_MS = 15000
    var probeActiveCount = 0
    var probeQueue = []

    var telemetryPrimeCache = new Map()

    function primeClipTelemetry( filePath, handlers )
    {
        if ( !filePath || !handlers || typeof handlers.getClipTelemetry !== "function" ) return null

        telemetryPrimeCache.clear()

        var promise = new Promise( function( resolve )
        {
            handlers.getClipTelemetry( filePath, resolve )
        } )

        telemetryPrimeCache.set( filePath, promise )

        return promise
    }

    function consumeClipTelemetry( filePath )
    {
        if ( !filePath || !telemetryPrimeCache.has( filePath ) ) return null

        var promise = telemetryPrimeCache.get( filePath )

        telemetryPrimeCache.delete( filePath )

        return promise
    }

    function acquireProbeSlot( startFn )
    {
        var token = { start: startFn, cancelled: false, active: false, released: false }

        if ( probeActiveCount < METADATA_PROBE_CONCURRENCY )
        {
            token.active = true
            probeActiveCount++
        }
        else
        {
            probeQueue.push( token )
        }

        return token
    }

    function releaseProbeSlot( token )
    {
        if ( !token || token.released ) return

        token.released = true

        if ( !token.active )
        {
            token.cancelled = true
            return
        }

        probeActiveCount--

        while ( probeActiveCount < METADATA_PROBE_CONCURRENCY && probeQueue.length > 0 )
        {
            var next = probeQueue.shift()

            if ( next.cancelled || next.released ) continue

            next.active = true
            probeActiveCount++
            next.start()
            break
        }
    }

    function _resetProbeQueueForTests()
    {
        probeActiveCount = 0
        probeQueue.length = 0
    }

    function createVideoGroupComponent( handlers )
    {
        return {
            props: [ "controls", "timespans" ],
            data: function()
            {
                return {
                    error: null,
                    duration: null,
                    camGridTop: CAM_GRID_TOP,
                    camGridBottom: CAM_GRID_BOTTOM
                }
            },
            template:
                `<div>
                    <div v-for="timespan in timespans" :key="timespan.title">
                        <div v-if="timespan === controls.timespan || isNextTimespan( timespan )" class="cam-grid" :style="timespan !== controls.timespan ? 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;clip:rect(0,0,0,0)' : ''">
                            <div class="cam-row cam-row-top">
                                <div v-for="camera in camGridTop" :key="camera + '-top'" class="cam-cell">
                                    <template v-if="viewFor( timespan, camera )">
                                        <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
                                        <div class="cam-video-wrap">
                                            <synchronized-video :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                        </div>
                                    </template>
                                </div>
                            </div>
                            <div class="cam-row cam-row-bottom">
                                <div v-for="camera in camGridBottom" :key="camera + '-bottom'" class="cam-cell">
                                    <template v-if="viewFor( timespan, camera )">
                                        <div class="cam-video-wrap">
                                            <synchronized-video :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                        </div>
                                        <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
                                    </template>
                                </div>
                            </div>
                            <div v-if="extraViews( timespan ).length" class="cam-row cam-row-extras d-flex flex-wrap">
                                <div v-for="view in extraViews( timespan )" :key="view.camera + '-' + view.fileName" class="cam-cell cam-cell-extra">
                                    <div class="text-center cam-label" :title="view.fileName">{{ view.camera }}</div>
                                    <synchronized-video :timespan="timespan" :view="view" :playbackRate="controls.speed"></synchronized-video>
                                </div>
                            </div>
                        </div>
                        <metadata-probe v-else-if="metadataProbeView( timespan )"
                            :view="metadataProbeView( timespan )"
                            @duration="onProbeDuration( timespan, $event )"
                        ></metadata-probe>
                        <div class="alert alert-danger error" v-if="timespan === controls.timespan" v-show="error">
                            <div>{{ error }}</div>
                            <div @click="openBrowser" style="cursor: pointer;">Try external browser</div>
                        </div>
                    </div>
                </div>`,
            watch:
            {
                "controls.playing": function( playing, oldPlaying )
                {
                    for ( var timespan of this.timespans )
                    {
                        timespan.playing = ( timespan == this.controls.timespan )
                            ? playing
                            : false
                    }
                }
            },
            methods:
            {
                openBrowser: function()
                {
                    handlers.openBrowser()
                },
                viewFor: function( timespan, camera )
                {
                    return timespan.viewMap
                        ? timespan.viewMap.get( camera )
                        : timespan.views.find( function( v ) { return v.camera === camera } )
                },
                labelTitle: function( timespan, camera )
                {
                    var v = this.viewFor( timespan, camera )

                    return v ? v.fileName : ""
                },
                extraViews: function( timespan )
                {
                    return timespan.views.filter( function( v )
                    {
                        return CAM_GRID_ALL.indexOf( v.camera ) < 0
                    } )
                },
                isNextTimespan: function( timespan )
                {
                    var idx = this.timespans.indexOf( this.controls.timespan )

                    return idx >= 0 && idx < this.timespans.length - 1 && this.timespans[ idx + 1 ] === timespan
                },
                metadataProbeView: function( timespan )
                {
                    var v = this.viewFor( timespan, "front" )

                    if ( v ) return v

                    if ( timespan.views && timespan.views.length > 0 ) return timespan.views[ 0 ]

                    return null
                },
                onProbeDuration: function( timespan, duration )
                {
                    if ( !duration || !isFinite( duration ) ) return

                    timespan.duration = Math.max( timespan.duration || 0, duration )
                },
                currentTime: function( scrub, view )
                {
                    var camera = view.camera

                    if ( this.$refs[ camera ] && this.$refs[ camera ].length > 0 )
                    {
                        var video = this.$refs[ camera ][ 0 ]

                        return !video.paused
                            ? video.currentTime
                            : scrub * this.$refs[ camera ][ 0 ].duration / 100
                    }

                    return 0
                },
                durationChanged: function( timespan, camera, video )
                {
                    timespan.duration = Math.max( timespan.duration, video.duration )
                    this.duration = Math.max( this.duration, timespan.duration )
                },
                timeChanged: function( timespan, camera, video )
                {
                    if ( camera == "front" && !video.paused )
                    {
                        timespan.scrub = Math.round( video.currentTime / video.duration * 100 )
                    }
                }
            }
        }
    }

    function createVideosComponent( handlers )
    {
        return {
            props: [ "controls", "timespan" ],
            data: function()
            {
                return {
                    error: null,
                    duration: null,
                    camGridTop: CAM_GRID_TOP,
                    camGridBottom: CAM_GRID_BOTTOM
                }
            },
            template:
                `<div>
                    <div class="cam-grid">
                        <div class="cam-row cam-row-top">
                            <div v-for="camera in camGridTop" :key="camera + '-top'" class="cam-cell">
                                <template v-if="viewFor( timespan, camera )">
                                    <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
                                    <div class="cam-video-wrap">
                                        <synchronized-video :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                    </div>
                                </template>
                            </div>
                        </div>
                        <div class="cam-row cam-row-bottom">
                            <div v-for="camera in camGridBottom" :key="camera + '-bottom'" class="cam-cell">
                                <template v-if="viewFor( timespan, camera )">
                                    <div class="cam-video-wrap">
                                        <synchronized-video :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                    </div>
                                    <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
                                </template>
                            </div>
                        </div>
                        <div v-if="extraViews( timespan ).length" class="cam-row cam-row-extras d-flex flex-wrap">
                            <div v-for="view in extraViews( timespan )" :key="view.camera + '-' + view.fileName" class="cam-cell cam-cell-extra">
                                <div class="text-center cam-label" :title="view.fileName">{{ view.camera }}</div>
                                <synchronized-video :timespan="timespan" :view="view" :playbackRate="controls.speed"></synchronized-video>
                            </div>
                        </div>
                    </div>
                    <div class="alert alert-danger error" v-show="error">
                        <div>{{ error }}</div>
                        <div @click="openBrowser" style="cursor: pointer;">Try external browser</div>
                    </div>
                </div>`,
            methods:
            {
                openBrowser: function()
                {
                    handlers.openBrowser()
                },
                viewFor: function( timespan, camera )
                {
                    return timespan.viewMap
                        ? timespan.viewMap.get( camera )
                        : timespan.views.find( function( v ) { return v.camera === camera } )
                },
                labelTitle: function( timespan, camera )
                {
                    var v = this.viewFor( timespan, camera )

                    return v ? v.fileName : ""
                },
                extraViews: function( timespan )
                {
                    return timespan.views.filter( function( v )
                    {
                        return CAM_GRID_ALL.indexOf( v.camera ) < 0
                    } )
                }
            }
        }
    }

    function createVideoComponent( handlers )
    {
        return {
            props: [ "timespan", "view", "playbackRate" ],
            inject: {
                publishGps: { default: null }
            },
            data: function()
            {
                return {
                    error: null,
                    duration: null,
                    timeout: null,
                    telemetryStatus: "idle",
                    telemetrySamples: [],
                    telemetryError: null,
                    telemetryReqId: 0,
                    telemetryDebounceTimer: null,
                    overlayVideoTime: 0,
                    overlayVideoDuration: 0,
                    overlayRafHandle: null
                }
            },
            template:
                `<div :class="[ 'tc-cam-stack', view.camera === 'front' ? 'tc-cam-front' : '' ]">
                    <div v-if="view.camera === 'front'" class="tc-dash-overlay" aria-hidden="true">
                        <div v-if="telemetryStatus === 'loading'" class="tc-dash-msg">Loading telemetry…</div>
                        <div v-else-if="telemetryStatus === 'error'" class="tc-dash-msg tc-dash-err">{{ telemetryError }}</div>
                        <div v-else-if="telemetryStatus === 'empty'" class="tc-dash-msg">No telemetry in this clip</div>
                        <div v-else-if="telemetryStatus === 'ready' && dashDisplay" class="tc-dash-cluster">
                            <div class="tc-dash-col tc-dash-col-left">
                                <div class="tc-dash-gear">{{ dashDisplay.gear || "—" }}</div>
                                <svg class="tc-ico-pedal tc-ico-brake" :class="{ on: dashDisplay.brakeApplied }" viewBox="4 2 24 36" aria-hidden="true">
                                    <rect x="6" y="4" width="20" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="2"/>
                                    <line x1="9" y1="12" x2="23" y2="12" stroke="currentColor" stroke-width="2"/>
                                    <line x1="9" y1="18" x2="23" y2="18" stroke="currentColor" stroke-width="2"/>
                                    <line x1="9" y1="24" x2="23" y2="24" stroke="currentColor" stroke-width="2"/>
                                </svg>
                            </div>
                            <svg class="tc-arrow" :class="{ on: dashDisplay.blinkerLeft }" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 3L2 12l8 9v-6h12V9H10V3z"/></svg>
                            <div class="tc-speed-block">
                                <div class="tc-speed-val">{{ speedDisplay.value }}</div>
                                <div class="tc-speed-unit">{{ speedDisplay.unit }}</div>
                            </div>
                            <svg class="tc-arrow" :class="{ on: dashDisplay.blinkerRight }" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 3l8 9-8 9v-6H2V9h12V3z"/></svg>
                            <div class="tc-dash-col tc-dash-col-right">
                                <svg class="tc-ico-wheel" :class="{ on: dashDisplay.autopilot && dashDisplay.autopilot !== 'NONE' }" :style="dashDisplay.steeringWheelAngle != null ? { transform: 'rotate(' + dashDisplay.steeringWheelAngle + 'deg)' } : {}" viewBox="0 0 40 40" aria-hidden="true">
                                    <circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" stroke-width="2.5"/>
                                    <circle cx="20" cy="20" r="4" fill="currentColor" stroke="none"/>
                                    <line x1="16" y1="20" x2="5" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                    <line x1="24" y1="20" x2="35" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                    <line x1="20" y1="24" x2="20" y2="35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                </svg>
                                <div class="tc-throttle" title="Accelerator">
                                    <div class="tc-throttle-fill" :style="{ height: throttleFillPct + '%' }"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <video ref="video" class="video" :class="view.camera" :src="view.file" :playbackRate="playbackRate" crossorigin="anonymous" preload="auto" @durationchange="durationChanged" @timeupdate="timeChanged" @ended="ended" title="Open in file explorer" @click="openExternal" playsinline></video>
                </div>`,
            computed:
            {
                dashDisplay: function()
                {
                    if ( this.telemetryStatus !== "ready" || !this.telemetrySamples.length ) return null

                    var br = pickSeiInterpolationBracket(
                        this.telemetrySamples,
                        this.overlayVideoTime,
                        this.overlayVideoDuration )

                    if ( !br ) return null

                    return blendDashSamples( br.cur, br.next, br.alpha )
                },
                throttleFillPct: function()
                {
                    var d = this.dashDisplay

                    if ( !d || d.acceleratorPedal == null ) return 0

                    return Math.round( Math.max( 0, Math.min( 1, d.acceleratorPedal ) ) * 100 )
                },
                speedDisplay: function()
                {
                    var d = this.dashDisplay

                    if ( !d || d.speedMps == null ) return { value: "—", unit: "km/h" }

                    return { value: Math.round( d.speedMps * 3.6 ), unit: "km/h" }
                }
            },
            mounted: function()
            {
                if ( this.view.camera === "front" ) this.fetchFrontTelemetry()
                if ( this.timespan.playing ) this.startPlayback()
            },
            beforeUnmount: function()
            {
                this.stopOverlayLoop()

                if ( this.telemetryDebounceTimer )
                {
                    window.clearTimeout( this.telemetryDebounceTimer )
                    this.telemetryDebounceTimer = null
                }

                var video = this.$refs[ "video" ]

                if ( video )
                {
                    video.pause()
                    video.removeAttribute( "src" )
                    video.load()
                }
            },
            watch:
            {
                "view.filePath": function()
                {
                    if ( this.view.camera !== "front" ) return

                    if ( this.telemetryDebounceTimer ) window.clearTimeout( this.telemetryDebounceTimer )

                    var self = this

                    this.telemetryDebounceTimer = window.setTimeout( function()
                    {
                        self.telemetryDebounceTimer = null
                        self.fetchFrontTelemetry()
                    }, 150 )
                },
                "timespan.playing":
                {
                    handler: function( playing, oldPlaying )
                    {
                        if ( playing )
                        {
                            this.startPlayback()
                        }
                        else
                        {
                            this.stopOverlayLoop()

                            var video = this.$refs[ "video" ]

                            if ( this.timeout )
                            {
                                window.clearTimeout( this.timeout )
                                this.timeout = null
                            }
                            else if ( video )
                            {
                                video.pause()
                            }

                            this.syncOverlayClock()
                        }
                    }
                },
                "timespan.currentTime":
                {
                    handler: function( currentTime, oldTime )
                    {
                        this.syncPausedPosition()
                    }
                },
                overlayVideoTime: function()
                {
                    this.publishCurrentGps()
                },
                telemetryStatus: function()
                {
                    if ( this.telemetryStatus === "ready" ) this.publishCurrentGps()
                }
            },
            methods:
            {
                fetchFrontTelemetry: function()
                {
                    if ( this.view.camera !== "front" || !handlers.getClipTelemetry ) return

                    var self = this
                    var token = ++this.telemetryReqId
                    var filePath = this.view.filePath

                    this.telemetryStatus = "loading"
                    this.telemetrySamples = []
                    this.telemetryError = null

                    var primed = consumeClipTelemetry( filePath )
                    var promise = primed || new Promise( function( resolve )
                    {
                        handlers.getClipTelemetry( filePath, resolve )
                    } )

                    promise.then( function( res )
                    {
                        if ( token !== self.telemetryReqId ) return

                        if ( !res || res.error )
                        {
                            self.telemetryStatus = "error"
                            self.telemetryError = res && res.error ? res.error : "failed"

                            return
                        }

                        if ( !Array.isArray( res.samples ) || !res.samples.length )
                        {
                            self.telemetryStatus = "empty"

                            return
                        }

                        self.telemetrySamples = res.samples
                        self.telemetryStatus = "ready"
                    } )
                },
                publishCurrentGps: function()
                {
                    if ( this.view.camera !== "front" || typeof this.publishGps !== "function" ) return
                    if ( this.telemetryStatus !== "ready" || !this.telemetrySamples.length ) return

                    var br = pickSeiInterpolationBracket(
                        this.telemetrySamples,
                        this.overlayVideoTime,
                        this.overlayVideoDuration )

                    if ( !br ) return

                    var cur = br.cur
                    var next = br.next
                    var alpha = br.alpha

                    var curLat = ( cur && typeof cur.latitudeDeg === "number" ) ? cur.latitudeDeg : null
                    var curLon = ( cur && typeof cur.longitudeDeg === "number" ) ? cur.longitudeDeg : null
                    var nextLat = ( next && typeof next.latitudeDeg === "number" ) ? next.latitudeDeg : null
                    var nextLon = ( next && typeof next.longitudeDeg === "number" ) ? next.longitudeDeg : null

                    var lat = ( curLat != null && nextLat != null )
                        ? curLat * ( 1 - alpha ) + nextLat * alpha
                        : ( curLat != null ? curLat : nextLat )
                    var lon = ( curLon != null && nextLon != null )
                        ? curLon * ( 1 - alpha ) + nextLon * alpha
                        : ( curLon != null ? curLon : nextLon )

                    if ( lat == null || lon == null || !isFinite( lat ) || !isFinite( lon ) ) return

                    this.publishGps( { lat: lat, lon: lon } )
                },
                startPlayback: function()
                {
                    var video = this.$refs[ "video" ]

                    if ( !video ) return

                    if ( video.readyState < 1 )
                    {
                        video.addEventListener( "loadedmetadata", () => this.startPlayback(), { once: true } )

                        return
                    }

                    video.playbackRate = this.playbackRate

                    var currentTime = this.timespan.currentTime - ( this.timespan.duration - video.duration )

                    if ( currentTime < 0 )
                    {
                        var delay = -currentTime / this.playbackRate

                        console.log( `Delaying ${this.view.filePath} for ${delay}` )

                        this.timeout = window.setTimeout(
                            () =>
                            {
                                this.timeout = null

                                video.style.opacity = 1.0
                                video.currentTime = 0.0
                                video.play().catch( e => { this.error = e.message; console.error( e.message ); } )
                                this.startOverlayLoop()
                            },
                            delay * 1000 )
                    }
                    else if ( isFinite( currentTime ) && !isNaN( currentTime ) )
                    {
                        console.log( `Playing ${this.view.filePath}` )

                        this.timeout = null

                        video.style.opacity = 1.0
                        video.currentTime = currentTime
                        video.play().catch( e => { this.error = e.message; console.error( e.message ); } )
                        this.startOverlayLoop()
                    }
                },
                syncOverlayClock: function()
                {
                    if ( this.view.camera !== "front" ) return

                    var video = this.$refs[ "video" ]

                    if ( !video ) return

                    this.overlayVideoTime = video.currentTime
                    this.overlayVideoDuration = video.duration && isFinite( video.duration ) ? video.duration : 0
                },
                startOverlayLoop: function()
                {
                    if ( this.view.camera !== "front" || this.overlayRafHandle ) return

                    var self = this

                    function tick()
                    {
                        var video = self.$refs[ "video" ]

                        if ( video && !video.paused )
                        {
                            self.overlayVideoTime = video.currentTime
                            self.overlayVideoDuration = video.duration && isFinite( video.duration ) ? video.duration : 0
                        }

                        self.overlayRafHandle = window.requestAnimationFrame( tick )
                    }

                    self.overlayRafHandle = window.requestAnimationFrame( tick )
                },
                stopOverlayLoop: function()
                {
                    if ( this.overlayRafHandle )
                    {
                        window.cancelAnimationFrame( this.overlayRafHandle )
                        this.overlayRafHandle = null
                    }
                },
                durationChanged: function( event )
                {
                    var video = event.target

                    this.timespan.duration = Math.max( this.timespan.duration || 0, video.duration )
                    this.syncOverlayClock()
                },
                syncPausedPosition: function()
                {
                    var video = this.$refs[ "video" ]

                    if ( !video || this.timespan.playing ) return

                    // If this camera's metadata hasn't loaded yet, leave it fully visible and
                    // retry the sync once it does — otherwise the NaN from video.duration
                    // traps the video at opacity 0.3 because the watcher only re-fires on
                    // currentTime changes, not on metadata arriving.
                    if ( !isFinite( video.duration ) )
                    {
                        var self = this
                        video.addEventListener( "loadedmetadata",
                            function() { self.syncPausedPosition() },
                            { once: true } )
                        video.style.opacity = 1.0
                        return
                    }

                    var adjustedTime = this.timespan.currentTime - ( this.timespan.duration - video.duration )

                    if ( isFinite( adjustedTime ) && adjustedTime >= 0 )
                    {
                        video.currentTime = adjustedTime
                        video.style.opacity = 1.0
                    }
                    else video.style.opacity = 0.3

                    this.syncOverlayClock()
                },
                timeChanged: function( event )
                {
                    var video = event.target

                    if ( !video.paused
                        && this.timespan.duration != null
                        && isFinite( this.timespan.duration )
                        && isFinite( video.duration )
                        && Math.abs( video.duration - this.timespan.duration ) < DURATION_MATCH_EPSILON_SEC )
                    {
                        this.timespan.currentTime = video.currentTime
                    }
                },
                ended()
                {
                    var video = this.$refs[ "video" ]

                    if ( video
                        && isFinite( video.duration )
                        && isFinite( this.timespan.duration )
                        && Math.abs( video.duration - this.timespan.duration ) < DURATION_MATCH_EPSILON_SEC )
                    {
                        this.timespan.ended = true
                    }
                },
                openExternal: function()
                {
                    handlers.openExternal( this.view.file )
                }
            }
        }
    }

    function createMetadataProbeComponent( handlers )
    {
        return {
            props: [ "view" ],
            emits: [ "duration" ],
            data: function()
            {
                return {
                    slotToken: null,
                    safetyTimer: null,
                    resolved: false
                }
            },
            template:
                `<video ref="video"
                    preload="metadata"
                    muted
                    playsinline
                    crossorigin="anonymous"
                    tabindex="-1"
                    aria-hidden="true"
                    style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;clip:rect(0,0,0,0)"
                    @durationchange="onDurationChange"
                    @error="onLoadError"
                ></video>`,
            mounted: function()
            {
                var self = this

                this.slotToken = acquireProbeSlot( function() { self.beginLoad() } )

                if ( this.slotToken.active ) this.beginLoad()
            },
            beforeUnmount: function()
            {
                this.finish()

                var video = this.$refs[ "video" ]

                if ( video )
                {
                    video.pause()
                    video.removeAttribute( "src" )
                    video.load()
                }
            },
            methods:
            {
                beginLoad: function()
                {
                    if ( this.resolved ) return

                    var video = this.$refs[ "video" ]

                    if ( !video || !this.view )
                    {
                        this.finish()
                        return
                    }

                    video.setAttribute( "src", this.view.file )
                    video.load()

                    var self = this

                    this.safetyTimer = window.setTimeout( function()
                    {
                        self.safetyTimer = null
                        self.finish()
                    }, METADATA_PROBE_SAFETY_TIMEOUT_MS )
                },
                onDurationChange: function( event )
                {
                    var video = event.target

                    if ( video && isFinite( video.duration ) )
                    {
                        this.$emit( "duration", video.duration )
                    }

                    this.finish()
                },
                onLoadError: function()
                {
                    this.finish()
                },
                finish: function()
                {
                    if ( this.resolved ) return

                    this.resolved = true

                    if ( this.safetyTimer )
                    {
                        window.clearTimeout( this.safetyTimer )
                        this.safetyTimer = null
                    }

                    if ( this.slotToken )
                    {
                        releaseProbeSlot( this.slotToken )
                        this.slotToken = null
                    }
                }
            }
        }
    }

    return {
        createVideoGroupComponent: createVideoGroupComponent,
        createVideosComponent: createVideosComponent,
        createVideoComponent: createVideoComponent,
        createMetadataProbeComponent: createMetadataProbeComponent,
        primeClipTelemetry: primeClipTelemetry,
        _probeQueueForTesting:
        {
            acquire: acquireProbeSlot,
            release: releaseProbeSlot,
            reset: _resetProbeQueueForTests,
            get activeCount() { return probeActiveCount },
            get queueLength() { return probeQueue.length },
            get limit() { return METADATA_PROBE_CONCURRENCY }
        }
    }
} ) );
