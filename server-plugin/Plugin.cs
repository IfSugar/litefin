namespace Litefin.Web;

using System;
using System.Collections.Generic;
using System.Globalization;
using Litefin.Web.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

/// <summary>
/// ============================================================================
/// Litefin Web - Jellyfin Server Plugin
/// ============================================================================
/// Embedded Jellyfin server plugin responsible for serving the modern Litefin
/// web client directly from the host at http://{server_url}/litefin.
/// Manages configuration storage, plugin page discovery, and web hosting.
/// ============================================================================
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// Injected with server application paths and XML serializer by Jellyfin.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        // Cache singleton instance for controller and configuration access
        Instance = this;
    }

    /// <summary>
    /// Gets the active singleton instance of the Litefin Web plugin.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Gets the display name of the plugin displayed in the Jellyfin Dashboard.
    /// </summary>
    public override string Name => "Litefin Web";

    /// <summary>
    /// Gets the description of the plugin.
    /// </summary>
    public override string Description => "Embedded modern Litefin client with Movi WebAssembly video player.";

    /// <summary>
    /// Gets the unique GUID identifier for the Litefin Web plugin.
    /// Used for manifest cataloging and configuration storage.
    /// </summary>
    public override Guid Id => Guid.Parse("b4a2c918-7e3f-4d92-a1b8-6e54f0a9d123");

    /// <summary>
    /// Registers the plugin's configuration page with the Jellyfin Dashboard.
    /// Enables administrator configuration directly from Server Settings -> Plugins.
    /// </summary>
    /// <returns>Collection of plugin web pages.</returns>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        // Define dashboard settings page mapped to embedded configPage.html resource
        return
        [
            new PluginPageInfo
            {
                Name = this.Name,
                DisplayName = this.Configuration?.PluginMenuTitle ?? this.Name,
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Configuration.configPage.html",
                    this.GetType().Namespace),
                EnableInMainMenu = true,
                MenuSection = "plugins",
                MenuIcon = "tv"
            }
        ];
    }
}
