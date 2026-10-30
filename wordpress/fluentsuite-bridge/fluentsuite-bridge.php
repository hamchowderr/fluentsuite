<?php
/**
 * Plugin Name:       FluentSuite Bridge
 * Plugin URI:        https://github.com/hamchowderr/fluentsuite
 * Description:       REST routes for FluentSuite (an MCP server) where a Fluent plugin has no REST API of its own. Today: FluentSMTP. Independent project, not affiliated with WPManageNinja.
 * Version:           0.2.1
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            Otaku Solutions
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 *
 * Routes live under /wp-json/fluentsuite/v1/ and use normal WordPress REST authentication
 * (Application Passwords). Each route checks the Fluent plugin's own permission.
 *
 * Sending routes (test email, resend failed emails) stay disabled unless wp-config.php has:
 *     define('FLUENTSUITE_BRIDGE_ALLOW_SENDING', true);
 */

defined('ABSPATH') || exit;

define('FLUENTSUITE_BRIDGE_VERSION', '0.2.1');

require_once __DIR__ . '/includes/class-fluentsuite-bridge-smtp.php';

add_action('rest_api_init', ['FluentSuite_Bridge_Smtp', 'register_routes']);
