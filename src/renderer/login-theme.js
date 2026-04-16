(function () {
    var theme = localStorage.getItem( "themePreference" );

    if ( theme === "dark" ) document.documentElement.setAttribute( "data-theme", "dark" );
    else if ( theme === "light" ) document.documentElement.setAttribute( "data-theme", "light" );
    else if ( window.matchMedia && window.matchMedia( "(prefers-color-scheme: dark)" ).matches )
        document.documentElement.setAttribute( "data-theme", "dark" );
})();
