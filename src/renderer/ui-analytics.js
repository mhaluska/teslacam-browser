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
                speedUnit:  { type: String, default: "km" }
            },
            emits: [ "seek" ],
            data: function()
            {
                return {
                    activeTab: "trail",
                    tabs: TABS
                }
            },
            computed:
            {
                hasSamples: function() { return Array.isArray( this.samples ) && this.samples.length > 0 },
                hasGps: function()
                {
                    if ( !this.hasSamples ) return false

                    for ( var i = 0; i < this.samples.length; i++ )
                    {
                        var s = this.samples[ i ]
                        var lat = s && s.latitudeDeg
                        var lon = s && s.longitudeDeg

                        if ( typeof lat === "number" && typeof lon === "number"
                            && isFinite( lat ) && isFinite( lon )
                            && !( lat === 0 && lon === 0 ) ) return true
                    }

                    return false
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
                            <div v-else class="clip-analytics-placeholder text-muted">Trail coming soon.</div>
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
