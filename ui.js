( function ( root, factory )
{
	if ( typeof define === 'function' && define.amd ) define( [], factory );
	else if ( typeof exports === 'object' ) module.exports = factory();
	else root.ui = factory();
}( typeof self !== 'undefined' ? self : this, function ()
{
    var CAM_GRID_TOP = [ "left_pillar", "front", "right_pillar" ]
    var CAM_GRID_BOTTOM = [ "right_repeater", "back", "left_repeater" ]
    var CAM_GRID_ALL = CAM_GRID_TOP.concat( CAM_GRID_BOTTOM )

    function normalizeThemePreference( p )
    {
        if ( p === "light" || p === "dark" || p === "system" ) return p

        return "system"
    }

    function createVueApp( handlers )
    {
        var args = { version: null };

        return new Vue(
        {
            el: '#root',
            data:
            {
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
                themePreference: "system"
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

                        return {    // Timespan
                            title: key,
                            time: new Date( key ),
                            scrub: 0,
                            playing: false,
                            visible: false,
                            currentTime: 0,
                            duration: null,
                            ended: false,
                            views: views
                        }
                    }

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
                    }
                },
                "args.dates": function( dates, oldDates )
                {
                    flatpickr(
                        $( "#calendar" ),
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
                            timespan.playing = true
                            timespan.visible = true

                            if ( oldTimespan )
                            {
                                oldTimespan.ended = false
                                oldTimespan.currentTime = 0
                                oldTimespan.visible = false
                            }
                        }
                        else
                        {
                            this.controls.playing = false
                        }
                    }
                },
                "controls.timespan.playing": function( playing, oldPlaying )
                {
                    this.controls.playing = playing
                },
                duration: function( duration )
                {
                    this.controls.timespan = ( this.timespans.length > 0 ) ? this.timespans[ 0 ] : null
                    this.controls.playing = false
                    this.controls.scrub = 0
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
                eventMapEmbedUrl: function()
                {
                    if ( !this.clipEvent ) return ""

                    var lat = parseFloat( this.clipEvent.est_lat )
                    var lon = parseFloat( this.clipEvent.est_lon )

                    if ( !isFinite( lat ) || !isFinite( lon ) ) return ""

                    var d = 0.003

                    return "https://www.openstreetmap.org/export/embed.html?bbox="
                        + ( lon - d ) + "," + ( lat - d ) + "," + ( lon + d ) + "," + ( lat + d )
                        + "&layer=mapnik&marker=" + lat + "," + lon
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
                    if ( this.themePreference === "light" ) return "oi oi-sun"
                    if ( this.themePreference === "dark" ) return "oi oi-moon"

                    return "oi oi-monitor"
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
            beforeDestroy: function()
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
                openFolders: function()
                {
                    // TODO: Still used?
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
                    
                                    if ( time.recent ) name += " (Recent)"
                    
                                    times.push( { time: time, name: name } )
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
                },
                deleteFiles: function( timespan )
                {
                    var files = timespan.views.map( v => v.filePath )

                    if ( confirm( `Are you sure you want to delete ${files.length} files from ${timespan.title}?` ) )
                    {
                        handlers.deleteFiles( files )
                        handlers.reopenFolders( this.loaded )
                    }
                },
                copyFilePaths: function( timespan )
                {
                    var files = timespan.views.map( v => v.filePath )

                    handlers.copyFilePaths( files )

                    alert( "Copied file paths to clipboard" )
                },
                deleteFolder: function( folder )
                {
                    if ( confirm( `Are you sure you want to delete ${folder}?` ) )
                    {
                        handlers.deleteFolder( folder )
                        handlers.reopenFolders( this.loaded )
                    }
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
        });
    }

    function createVideoGroupComponent( handlers )
    {
        return Vue.component( "VideoGroup",
        {
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
                        <div v-if="timespan === controls.timespan" class="cam-grid">
                            <div class="cam-row cam-row-top">
                                <div v-for="camera in camGridTop" :key="camera + '-top'" class="cam-cell">
                                    <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
                                    <div class="cam-video-wrap">
                                        <synchronized-video v-if="viewFor( timespan, camera )" :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                        <div v-else class="cam-placeholder"></div>
                                    </div>
                                </div>
                            </div>
                            <div class="cam-row cam-row-bottom">
                                <div v-for="camera in camGridBottom" :key="camera + '-bottom'" class="cam-cell">
                                    <div class="cam-video-wrap">
                                        <synchronized-video v-if="viewFor( timespan, camera )" :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                        <div v-else class="cam-placeholder"></div>
                                    </div>
                                    <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
                                </div>
                            </div>
                            <div v-if="extraViews( timespan ).length" class="cam-row cam-row-extras d-flex flex-wrap">
                                <div v-for="view in extraViews( timespan )" :key="view.camera + '-' + view.fileName" class="cam-cell cam-cell-extra">
                                    <div class="text-center cam-label" :title="view.fileName">{{ view.camera }}</div>
                                    <synchronized-video :timespan="timespan" :view="view" :playbackRate="controls.speed"></synchronized-video>
                                </div>
                            </div>
                        </div>
                        <video v-else-if="metadataProbeView( timespan )"
                            :src="metadataProbeView( timespan ).file"
                            preload="metadata"
                            muted
                            playsinline
                            crossorigin="anonymous"
                            tabindex="-1"
                            aria-hidden="true"
                            style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;clip:rect(0,0,0,0)"
                            @durationchange="inactiveTimespanDuration( timespan, $event )"
                        ></video>
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
                        timespan.ended = false
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
                    for ( var i = 0; i < timespan.views.length; i++ )
                    {
                        if ( timespan.views[ i ].camera === camera ) return timespan.views[ i ]
                    }
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
                metadataProbeView: function( timespan )
                {
                    var v = this.viewFor( timespan, "front" )

                    if ( v ) return v

                    if ( timespan.views && timespan.views.length > 0 ) return timespan.views[ 0 ]

                    return null
                },
                inactiveTimespanDuration: function( timespan, event )
                {
                    var video = event.target

                    if ( !video.duration || !isFinite( video.duration ) ) return

                    timespan.duration = Math.max( timespan.duration || 0, video.duration )
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
        } )
    }

    function createVideosComponent( handlers )
    {
        return Vue.component( "Videos",
        {
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
                                <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
                                <div class="cam-video-wrap">
                                    <synchronized-video v-if="viewFor( timespan, camera )" :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                    <div v-else class="cam-placeholder"></div>
                                </div>
                            </div>
                        </div>
                        <div class="cam-row cam-row-bottom">
                            <div v-for="camera in camGridBottom" :key="camera + '-bottom'" class="cam-cell">
                                <div class="cam-video-wrap">
                                    <synchronized-video v-if="viewFor( timespan, camera )" :timespan="timespan" :view="viewFor( timespan, camera )" :playbackRate="controls.speed"></synchronized-video>
                                    <div v-else class="cam-placeholder"></div>
                                </div>
                                <div class="text-center cam-label" :title="labelTitle( timespan, camera )">{{ camera }}</div>
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
                    for ( var i = 0; i < timespan.views.length; i++ )
                    {
                        if ( timespan.views[ i ].camera === camera ) return timespan.views[ i ]
                    }
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
        } )
    }

    function createVideoComponent( handlers )
    {
        return Vue.component( "SynchronizedVideo",
        {
            props: [ "timespan", "view", "playbackRate" ],
            data: function()
            {
                return {
                    error: null,
                    duration: null,
                    timeout: null
                }
            },
            template:
                `<video ref="video" class="video" :class="view.camera" :src="view.file" :autoplay="timespan.playing" :playbackRate.prop="playbackRate" crossorigin="anonymous" preload="auto" @durationchange="durationChanged" @timeupdate="timeChanged" @ended="ended" title="Open in file explorer" @click="openExternal" playsinline></video>`,
            watch:
            {
                "timespan.playing":
                {
                    handler: function( playing, oldPlaying )
                    {
                        var video = this.$refs[ "video" ]

                        if ( video )
                        {
                            if ( playing )
                            {
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
                                }
                            }
                            else
                            {
                                if ( this.timeout )
                                {
                                    window.clearTimeout( this.timeout )
                                    this.timeout = null
                                }
                                else
                                {
                                    video.pause()
                                }
                            }
                        }
                    }
                },
                "timespan.currentTime":
                {
                    handler: function( currentTime, oldTime )
                    {
                        var video = this.$refs[ "video" ]

                        if ( video && !this.timespan.playing )
                        {
                            var adjustedTime = currentTime - ( this.timespan.duration - video.duration )

                            if ( !isNaN( adjustedTime ) && isFinite( adjustedTime ) && adjustedTime >= 0 )
                            {
                                video.currentTime = adjustedTime
                                video.style.opacity = 1.0
                            }
                            else video.style.opacity = 0.3
                        }
                    }
                }
            },
            methods:
            {
                durationChanged: function( event )
                {
                    var video = event.target

                    this.timespan.duration = Math.max( this.timespan.duration || 0, video.duration )
                },
                timeChanged: function( event )
                {
                    var video = event.target

                    if ( !video.paused && video.duration == this.timespan.duration )
                    {
                        this.timespan.currentTime = video.currentTime
                    }
                },
                ended()
                {
                    this.timespan.playing = false
                    this.timespan.ended = true
                },
                openExternal: function()
                {
                    handlers.openExternal( this.view.file )
                }
            }
        } )
    }

    function initialize( handlers )
    {
        var videoGroupComponent = createVideoGroupComponent( handlers )
        var videosComponent = createVideosComponent( handlers )
        var videoComponent = createVideoComponent( handlers )

        var vueApp = createVueApp( handlers )

        handlers.openFolder( null, f => vueApp.args = f )

        return vueApp
    }

    return {
        initialize: initialize
    }
} ) );
