=== FluentSuite Bridge ===
Contributors: chowderr
Tags: fluentsmtp, rest-api, mcp, email-logs
Requires at least: 6.2
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.2.1
License: MIT
License URI: https://opensource.org/licenses/MIT

REST routes for the FluentSuite MCP server where a Fluent plugin has no REST API of its own. Today: FluentSMTP.

== Description ==

FluentSuite is an MCP server for the Fluent WordPress plugins. FluentSMTP has no REST API, so this small plugin adds read routes for its email logs, connections and a sending report under `/wp-json/fluentsuite/v1/`.

* Routes use normal WordPress REST authentication (Application Passwords) and check FluentSMTP's own permission.
* Connection settings are returned without passwords, keys or tokens.
* Deleting logs always previews first and needs the previewed count to go ahead.
* Sending routes (a test email, resending failed emails) stay off unless `wp-config.php` has `define( 'FLUENTSUITE_BRIDGE_ALLOW_SENDING', true );`.

FluentSuite is independent and not affiliated with WPManageNinja.

== Installation ==

1. Upload the `fluentsuite-bridge` folder to `wp-content/plugins/`, or upload its zip under Plugins > Add New > Upload Plugin.
2. Activate it. FluentSMTP must be active too.
3. Create an Application Password for a user who can manage FluentSMTP, and give it to FluentSuite.

== Changelog ==

= 0.2.1 =
* Every database query binds the table name and every value through `$wpdb->prepare()` (identifier placeholders), with no pre-built SQL fragments.
* Adds this readme.

= 0.2.0 =
* Sending report, log deletion with preview, test email and resend routes.
