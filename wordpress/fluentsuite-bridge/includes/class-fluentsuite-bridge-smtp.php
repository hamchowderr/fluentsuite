<?php
/**
 * Routes for FluentSMTP: status, email log search, one logged email, delivery report (reads); test email and
 * resend of failed emails (sending, only with FLUENTSUITE_BRIDGE_ALLOW_SENDING); deleting logs (destructive).
 *
 * FluentSMTP's own endpoints are admin-ajax only (cookie + nonce), which Application Passwords cannot reach.
 * These routes read the same data FluentSMTP's screens show.
 *
 * Rules:
 * - Access is FluentSMTP's own permission (fluentMailCurrentUserCanManage, administrators by default).
 * - Connection settings pass through an allowlist: API keys, passwords, OAuth tokens and usernames never
 *   leave the site.
 * - Message bodies are only returned by the single-email route, and only when asked for.
 * - Sending routes refuse unless wp-config.php defines FLUENTSUITE_BRIDGE_ALLOW_SENDING as true. A resend goes
 *   only to the email's original recipients, and only for emails whose status is `failed`.
 * - Deleting needs a criterion (ids, one recipient, or an age); there is no "delete all".
 * - Stored values are unserialized with allowed_classes=false.
 * - Every query is prepared.
 */

defined('ABSPATH') || exit;

final class FluentSuite_Bridge_Smtp
{
    const NS = 'fluentsuite/v1';

    /** The largest body returned, in bytes. FluentSuite shows far less; this only bounds the response. */
    const BODY_MAX = 200000;

    /** Header names whose values are never returned. */
    const SECRET_HEADERS = '/(authorization|api[-_]?key|token|secret|password|cookie|signature)/i';

    public static function register_routes()
    {
        $read = [__CLASS__, 'can_manage'];
        $date = ['type' => 'string', 'pattern' => '^\d{4}-\d{2}-\d{2}$'];

        register_rest_route(self::NS, '/smtp/status', [
            'methods'             => 'GET',
            'callback'            => [__CLASS__, 'status'],
            'permission_callback' => $read,
        ]);

        register_rest_route(self::NS, '/smtp/logs', [
            'methods'             => 'GET',
            'callback'            => [__CLASS__, 'logs'],
            'permission_callback' => $read,
            'args'                => [
                'status'   => ['type' => 'string', 'enum' => ['sent', 'failed', 'pending']],
                'after'    => $date,
                'before'   => $date,
                'to'       => ['type' => 'string', 'maxLength' => 200],
                'subject'  => ['type' => 'string', 'maxLength' => 200],
                'source'   => ['type' => 'string', 'maxLength' => 200],
                'search'   => ['type' => 'string', 'maxLength' => 200],
                'ids'      => ['type' => 'array', 'items' => ['type' => 'integer', 'minimum' => 1], 'maxItems' => 100],
                'page'     => ['type' => 'integer', 'minimum' => 1, 'default' => 1],
                'per_page' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 100, 'default' => 20],
            ],
        ]);

        register_rest_route(self::NS, '/smtp/logs/(?P<id>\d+)', [
            'methods'             => 'GET',
            'callback'            => [__CLASS__, 'log'],
            'permission_callback' => $read,
            'args'                => [
                'include_body' => ['type' => 'boolean', 'default' => false],
            ],
        ]);

        register_rest_route(self::NS, '/smtp/test-email', [
            'methods'             => 'POST',
            'callback'            => [__CLASS__, 'test_email'],
            'permission_callback' => $read,
            'args'                => [
                'to'   => ['type' => 'string', 'format' => 'email', 'required' => true],
                'from' => ['type' => 'string', 'format' => 'email'],
            ],
        ]);

        register_rest_route(self::NS, '/smtp/resend', [
            'methods'             => 'POST',
            'callback'            => [__CLASS__, 'resend'],
            'permission_callback' => $read,
            'args'                => [
                'ids' => [
                    'type'     => 'array',
                    'items'    => ['type' => 'integer', 'minimum' => 1],
                    'minItems' => 1,
                    'maxItems' => 50,
                    'required' => true,
                ],
            ],
        ]);

        register_rest_route(self::NS, '/smtp/logs/delete', [
            'methods'             => 'POST',
            'callback'            => [__CLASS__, 'delete_logs'],
            'permission_callback' => $read,
            'args'                => [
                'ids'             => ['type' => 'array', 'items' => ['type' => 'integer', 'minimum' => 1], 'maxItems' => 500],
                'to'              => ['type' => 'string', 'format' => 'email'],
                'older_than_days' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 3650],
                'status'          => ['type' => 'string', 'enum' => ['sent', 'failed']],
                'dry_run'         => ['type' => 'boolean', 'default' => true],
                'expected_count'  => ['type' => 'integer', 'minimum' => 0],
            ],
        ]);

        register_rest_route(self::NS, '/smtp/report', [
            'methods'             => 'GET',
            'callback'            => [__CLASS__, 'report'],
            'permission_callback' => $read,
            'args'                => [
                'after'  => $date,
                'before' => $date,
            ],
        ]);
    }

    public static function can_manage()
    {
        if (function_exists('fluentMailCurrentUserCanManage')) {
            return fluentMailCurrentUserCanManage();
        }
        // FluentSMTP before 2.3.0, or not active: the same default capability.
        return current_user_can('manage_options');
    }

    // ---- Routes -------------------------------------------------------------------------------

    public static function status()
    {
        if ($error = self::inactive()) {
            return $error;
        }
        $settings = get_option('fluentmail-settings');
        $settings = is_array($settings) ? $settings : [];
        $misc = isset($settings['misc']) && is_array($settings['misc']) ? $settings['misc'] : [];
        $byConstant = defined('FLUENTMAIL_SIMULATE_EMAILS') && FLUENTMAIL_SIMULATE_EMAILS;

        $table = self::table();
        global $wpdb;
        $weekAgo = gmdate('Y-m-d H:i:s', current_time('timestamp') - 7 * DAY_IN_SECONDS);
        $last = $wpdb->get_row("SELECT * FROM {$table} WHERE status = 'failed' ORDER BY created_at DESC, id DESC LIMIT 1", ARRAY_A);

        return rest_ensure_response([
            'bridge'      => [
                'version'         => FLUENTSUITE_BRIDGE_VERSION,
                'sending_allowed' => self::sending_allowed(),
            ],
            'fluentsmtp'  => [
                'version' => defined('FLUENTMAIL_PLUGIN_VERSION') ? FLUENTMAIL_PLUGIN_VERSION : null,
            ],
            'simulate'    => [
                'enabled'     => $byConstant || (isset($misc['simulate_emails']) && $misc['simulate_emails'] === 'yes'),
                'by_constant' => $byConstant,
            ],
            'logging'     => [
                'enabled'        => !isset($misc['log_emails']) || $misc['log_emails'] === 'yes',
                'retention_days' => isset($misc['log_saved_interval_days']) ? (int) $misc['log_saved_interval_days'] : null,
            ],
            'connections' => self::connections($settings, $misc),
            'totals'      => self::counts(''),
            'last_7_days' => self::counts($wpdb->prepare('WHERE created_at >= %s', $weekAgo)),
            'last_failure' => $last ? self::row($last) : null,
        ]);
    }

    public static function logs(WP_REST_Request $request)
    {
        if ($error = self::inactive()) {
            return $error;
        }
        global $wpdb;
        $table = self::table();
        list($where, $args) = self::filters($request);
        $perPage = (int) $request['per_page'];
        $page = (int) $request['page'];

        $countSql = "SELECT COUNT(*) FROM {$table} {$where}";
        $total = (int) $wpdb->get_var($args ? $wpdb->prepare($countSql, $args) : $countSql);
        $listSql = "SELECT * FROM {$table} {$where} ORDER BY created_at DESC, id DESC LIMIT %d OFFSET %d";
        $rows = $wpdb->get_results($wpdb->prepare($listSql, array_merge($args, [$perPage, ($page - 1) * $perPage])), ARRAY_A);

        return rest_ensure_response([
            'total'        => $total,
            'per_page'     => $perPage,
            'current_page' => $page,
            'last_page'    => max(1, (int) ceil($total / $perPage)),
            'data'         => array_map([__CLASS__, 'row'], $rows ?: []),
        ]);
    }

    public static function log(WP_REST_Request $request)
    {
        if ($error = self::inactive()) {
            return $error;
        }
        global $wpdb;
        $table = self::table();
        $raw = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d", (int) $request['id']), ARRAY_A);
        if (!$raw) {
            return new WP_Error('fluentsuite_not_found', 'No logged email with that id.', ['status' => 404]);
        }
        $out = self::row($raw);
        $headers = self::unserialize($raw['headers']);
        $out['headers'] = [];
        if (is_array($headers)) {
            foreach ($headers as $key => $value) {
                $name = is_string($key) ? $key : (is_array($value) && isset($value[0]) ? (string) $value[0] : (string) $key);
                $val = is_array($value) ? (isset($value[1]) ? $value[1] : '') : $value;
                $out['headers'][] = [
                    'name'  => $name,
                    'value' => preg_match(self::SECRET_HEADERS, $name) ? '[masked]' : self::text($val, 500),
                ];
            }
        }
        $attachments = self::unserialize($raw['attachments']);
        $out['attachments'] = [];
        if (is_array($attachments)) {
            foreach ($attachments as $a) {
                $path = is_array($a) ? (isset($a[2]) && $a[2] ? $a[2] : (isset($a[0]) ? $a[0] : '')) : $a;
                if (is_string($path) && $path !== '') {
                    $out['attachments'][] = wp_basename($path);
                }
            }
        }
        $response = self::unserialize($raw['response']);
        $out['response'] = self::message($response);
        $extra = self::unserialize($raw['extra']);
        $out['send_time_ms'] = is_array($extra) && isset($extra['send_time_ms']) ? (int) $extra['send_time_ms'] : null;
        $out['updated_at'] = $raw['updated_at'];

        if ($request['include_body']) {
            $body = (string) $raw['body'];
            $out['body_truncated'] = strlen($body) > self::BODY_MAX;
            $out['body'] = $out['body_truncated'] ? substr($body, 0, self::BODY_MAX) : $body;
        }
        return rest_ensure_response($out);
    }

    public static function test_email(WP_REST_Request $request)
    {
        if ($error = self::inactive() ?: self::sending_off()) {
            return $error;
        }
        $settings = get_option('fluentmail-settings');
        $mappings = is_array($settings) && isset($settings['mappings']) && is_array($settings['mappings']) ? $settings['mappings'] : [];
        $from = $request['from'] ? strtolower($request['from']) : '';
        if ($from !== '' && !array_key_exists($from, array_change_key_case($mappings, CASE_LOWER))) {
            return new WP_Error('fluentsuite_unknown_sender', 'That From address is not one of FluentSMTP\'s sender addresses.', ['status' => 400]);
        }
        $error = null;
        $catch = function ($wpError) use (&$error) {
            $error = is_wp_error($wpError) ? $wpError->get_error_message() : 'Sending failed.';
        };
        add_action('wp_mail_failed', $catch);
        try {
            $sent = (new \FluentMail\App\Models\Settings())->sendTestEmail(
                ['email' => $request['to'], 'from' => $from, 'isHtml' => 'true'],
                fluentMailGetSettings()
            );
        } catch (\Exception $e) {
            $sent = false;
            $error = $e->getMessage();
        }
        remove_action('wp_mail_failed', $catch);
        return rest_ensure_response([
            'sent'      => (bool) $sent && $error === null,
            'error'     => $error !== null ? self::text($error, 500) : null,
            'simulated' => self::simulated(),
        ]);
    }

    public static function resend(WP_REST_Request $request)
    {
        if ($error = self::inactive() ?: self::sending_off()) {
            return $error;
        }
        global $wpdb;
        $table = self::table();
        $ids = array_values(array_unique(array_map('intval', (array) $request['ids'])));
        $logger = new \FluentMail\App\Models\Logger();
        $results = [];
        foreach ($ids as $id) {
            $status = $wpdb->get_var($wpdb->prepare("SELECT status FROM {$table} WHERE id = %d", $id));
            if ($status === null) {
                $results[] = ['id' => $id, 'status' => 'skipped', 'error' => 'No logged email with that id.'];
                continue;
            }
            if ($status !== 'failed') {
                // Only failed emails are ever resent from here.
                $results[] = ['id' => $id, 'status' => 'skipped', 'error' => "Not a failed email (status {$status})."];
                continue;
            }
            $error = null;
            $catch = function ($wpError) use (&$error) {
                $error = is_wp_error($wpError) ? $wpError->get_error_message() : 'Sending failed.';
            };
            add_action('wp_mail_failed', $catch);
            try {
                // check_realtime keeps the row `failed` when the resend fails too (plain `retry` marks it sent).
                // No custom recipients: the email goes only to the people it was addressed to.
                $logger->resendEmailFromLog($id, 'check_realtime');
            } catch (\Exception $e) {
                $error = $e->getMessage();
            }
            remove_action('wp_mail_failed', $catch);
            $now = $wpdb->get_var($wpdb->prepare("SELECT status FROM {$table} WHERE id = %d", $id));
            $results[] = [
                'id'     => $id,
                'status' => $error === null && $now === 'sent' ? 'sent' : 'failed',
                'error'  => $error !== null ? self::text($error, 500) : null,
            ];
        }
        return rest_ensure_response(['simulated' => self::simulated(), 'results' => $results]);
    }

    public static function delete_logs(WP_REST_Request $request)
    {
        if ($error = self::inactive()) {
            return $error;
        }
        global $wpdb;
        $table = self::table();
        $criteria = array_filter([
            'ids'             => !empty($request['ids']),
            'to'              => (bool) $request['to'],
            'older_than_days' => (bool) $request['older_than_days'],
        ]);
        if (count($criteria) !== 1) {
            return new WP_Error('fluentsuite_invalid_criteria', 'Give exactly one of ids, to or older_than_days. There is no "delete all".', ['status' => 400]);
        }
        $where = [];
        $args = [];
        if (!empty($request['ids'])) {
            $ids = array_values(array_unique(array_map('intval', (array) $request['ids'])));
            $where[] = 'id IN (' . implode(',', array_fill(0, count($ids), '%d')) . ')';
            $args = array_merge($args, $ids);
        }
        if ($request['older_than_days']) {
            $where[] = 'created_at < %s';
            $args[] = gmdate('Y-m-d H:i:s', current_time('timestamp') - (int) $request['older_than_days'] * DAY_IN_SECONDS);
        }
        if ($request['to']) {
            // Narrowed by LIKE, then matched exactly on the unserialized recipients.
            $where[] = '`to` LIKE %s';
            $args[] = '%' . $wpdb->esc_like($request['to']) . '%';
        }
        if ($request['status']) {
            $where[] = 'status = %s';
            $args[] = $request['status'];
        }
        $sql = "SELECT * FROM {$table} WHERE " . implode(' AND ', $where) . ' ORDER BY created_at DESC, id DESC LIMIT 5001';
        $rows = $wpdb->get_results($wpdb->prepare($sql, $args), ARRAY_A) ?: [];
        if ($request['to']) {
            $email = strtolower($request['to']);
            $rows = array_values(array_filter($rows, function ($raw) use ($email) {
                foreach (self::recipients(self::unserialize($raw['to'])) as $r) {
                    if (strtolower($r['email']) === $email) {
                        return true;
                    }
                }
                return false;
            }));
        }
        if (count($rows) > 5000) {
            return new WP_Error('fluentsuite_too_many', 'More than 5,000 logs match. Narrow the criteria.', ['status' => 400]);
        }
        $count = count($rows);
        if ($request['dry_run']) {
            return rest_ensure_response([
                'dry_run' => true,
                'count'   => $count,
                'sample'  => array_map([__CLASS__, 'row'], array_slice($rows, 0, 5)),
            ]);
        }
        if ($request['expected_count'] === null) {
            return new WP_Error('fluentsuite_expected_count_required', 'expected_count (the previewed count) is required to delete. Nothing was deleted.', ['status' => 400]);
        }
        if ($count > (int) $request['expected_count']) {
            return new WP_Error('fluentsuite_count_changed', sprintf('%d logs match now, more than the %d previewed. Nothing was deleted.', $count, (int) $request['expected_count']), ['status' => 409]);
        }
        $deleted = 0;
        foreach (array_chunk(array_map(function ($r) {
            return (int) $r['id'];
        }, $rows), 500) as $chunk) {
            $deleted += (int) $wpdb->query($wpdb->prepare(
                "DELETE FROM {$table} WHERE id IN (" . implode(',', array_fill(0, count($chunk), '%d')) . ')',
                $chunk
            ));
        }
        return rest_ensure_response(['dry_run' => false, 'deleted' => $deleted]);
    }

    public static function report(WP_REST_Request $request)
    {
        if ($error = self::inactive()) {
            return $error;
        }
        global $wpdb;
        $table = self::table();
        $today = gmdate('Y-m-d', current_time('timestamp'));
        $before = $request['before'] ? $request['before'] : $today;
        $after = $request['after'] ? $request['after'] : gmdate('Y-m-d', strtotime($before . ' -29 days'));
        if ($after > $before) {
            return new WP_Error('fluentsuite_invalid_range', '`after` must not be later than `before`.', ['status' => 400]);
        }
        if (strtotime($before) - strtotime($after) > 366 * DAY_IN_SECONDS) {
            return new WP_Error('fluentsuite_invalid_range', 'The range can be at most 366 days.', ['status' => 400]);
        }
        $range = $wpdb->prepare('WHERE created_at BETWEEN %s AND %s', $after . ' 00:00:00', $before . ' 23:59:59');

        $days = [];
        foreach ($wpdb->get_results("SELECT DATE(created_at) AS d, status, COUNT(*) AS n FROM {$table} {$range} GROUP BY d, status ORDER BY d", ARRAY_A) ?: [] as $r) {
            if (!isset($days[$r['d']])) {
                $days[$r['d']] = ['date' => $r['d'], 'sent' => 0, 'failed' => 0];
            }
            if ($r['status'] === 'sent' || $r['status'] === 'failed') {
                $days[$r['d']][$r['status']] += (int) $r['n'];
            }
        }

        $sources = [];
        foreach ($wpdb->get_results("SELECT source, status, COUNT(*) AS n FROM {$table} {$range} GROUP BY source, status", ARRAY_A) ?: [] as $r) {
            $name = $r['source'] !== null && $r['source'] !== '' ? $r['source'] : '(unknown)';
            if (!isset($sources[$name])) {
                $sources[$name] = ['source' => $name, 'sent' => 0, 'failed' => 0];
            }
            if ($r['status'] === 'sent' || $r['status'] === 'failed') {
                $sources[$name][$r['status']] += (int) $r['n'];
            }
        }
        // Busiest first; ties by name, so the order is stable.
        usort($sources, function ($a, $b) {
            $diff = ($b['sent'] + $b['failed']) - ($a['sent'] + $a['failed']);
            return $diff !== 0 ? $diff : strcmp($a['source'], $b['source']);
        });

        // Failure reasons are grouped from the most recent 2,000 failures in the range.
        $reasons = [];
        $failed = $wpdb->get_results("SELECT id, response, created_at FROM {$table} {$range} AND status = 'failed' ORDER BY created_at DESC, id DESC LIMIT 2000", ARRAY_A) ?: [];
        foreach ($failed as $r) {
            $message = self::message(self::unserialize($r['response']));
            $message = $message !== null ? $message : '(no error recorded)';
            if (!isset($reasons[$message])) {
                $reasons[$message] = ['error' => $message, 'count' => 0, 'latest_id' => (int) $r['id'], 'latest_at' => $r['created_at']];
            }
            $reasons[$message]['count']++;
        }
        // Most common first; ties by the most recent failure.
        usort($reasons, function ($a, $b) {
            return $b['count'] !== $a['count'] ? $b['count'] - $a['count'] : $b['latest_id'] - $a['latest_id'];
        });

        return rest_ensure_response([
            'after'           => $after,
            'before'          => $before,
            'totals'          => self::counts($range),
            'days'            => array_values($days),
            'sources'         => array_slice($sources, 0, 20),
            'failure_reasons' => array_slice($reasons, 0, 20),
        ]);
    }

    // ---- Helpers ------------------------------------------------------------------------------

    public static function sending_allowed()
    {
        return defined('FLUENTSUITE_BRIDGE_ALLOW_SENDING') && FLUENTSUITE_BRIDGE_ALLOW_SENDING === true;
    }

    private static function sending_off()
    {
        if (!self::sending_allowed()) {
            return new WP_Error(
                'fluentsuite_sending_disabled',
                'Sending is turned off in the FluentSuite Bridge on this site. To allow it, add define(\'FLUENTSUITE_BRIDGE_ALLOW_SENDING\', true); to wp-config.php.',
                ['status' => 403]
            );
        }
        return null;
    }

    private static function simulated()
    {
        if (defined('FLUENTMAIL_SIMULATE_EMAILS') && FLUENTMAIL_SIMULATE_EMAILS) {
            return true;
        }
        $settings = get_option('fluentmail-settings');
        return is_array($settings) && isset($settings['misc']['simulate_emails']) && $settings['misc']['simulate_emails'] === 'yes';
    }

    private static function inactive()
    {
        if (!defined('FLUENTMAIL_PLUGIN_VERSION')) {
            return new WP_Error('fluentsuite_fluentsmtp_inactive', 'FluentSMTP is not active on this site.', ['status' => 424]);
        }
        return null;
    }

    private static function table()
    {
        global $wpdb;
        return $wpdb->prefix . (defined('FLUENT_MAIL_DB_PREFIX') ? FLUENT_MAIL_DB_PREFIX : 'fsmpt_') . 'email_logs';
    }

    /** Builds the WHERE clause for the log search. Values are bound, never interpolated. */
    private static function filters(WP_REST_Request $request)
    {
        global $wpdb;
        $where = [];
        $args = [];
        if ($request['status']) {
            $where[] = 'status = %s';
            $args[] = $request['status'];
        }
        if ($request['after']) {
            $where[] = 'created_at >= %s';
            $args[] = $request['after'] . ' 00:00:00';
        }
        if ($request['before']) {
            $where[] = 'created_at <= %s';
            $args[] = $request['before'] . ' 23:59:59';
        }
        if ($request['to']) {
            $where[] = '`to` LIKE %s';
            $args[] = '%' . $wpdb->esc_like($request['to']) . '%';
        }
        if ($request['subject']) {
            $where[] = 'subject LIKE %s';
            $args[] = '%' . $wpdb->esc_like($request['subject']) . '%';
        }
        if ($request['source']) {
            $where[] = 'source = %s';
            $args[] = $request['source'];
        }
        if (!empty($request['ids'])) {
            $ids = array_values(array_unique(array_map('intval', (array) $request['ids'])));
            $where[] = 'id IN (' . implode(',', array_fill(0, count($ids), '%d')) . ')';
            $args = array_merge($args, $ids);
        }
        if ($request['search']) {
            $like = '%' . $wpdb->esc_like($request['search']) . '%';
            $where[] = '(`to` LIKE %s OR `from` LIKE %s OR subject LIKE %s)';
            array_push($args, $like, $like, $like);
        }
        return [$where ? 'WHERE ' . implode(' AND ', $where) : '', $args];
    }

    private static function counts($where)
    {
        global $wpdb;
        $table = self::table();
        $out = ['sent' => 0, 'failed' => 0];
        foreach ($wpdb->get_results("SELECT status, COUNT(*) AS n FROM {$table} {$where} GROUP BY status", ARRAY_A) ?: [] as $r) {
            if (isset($out[$r['status']])) {
                $out[$r['status']] = (int) $r['n'];
            }
        }
        return $out;
    }

    /** A short, secret-free summary of one log row. */
    public static function row(array $raw)
    {
        $extra = self::unserialize($raw['extra']);
        $row = [
            'id'           => (int) $raw['id'],
            'created_at'   => $raw['created_at'],
            'status'       => $raw['status'],
            'to'           => self::recipients(self::unserialize($raw['to'])),
            'from'         => self::text(self::unserialize($raw['from']), 255),
            'subject'      => self::text($raw['subject'], 255),
            'source'       => $raw['source'] !== null && $raw['source'] !== '' ? $raw['source'] : null,
            'provider'     => is_array($extra) && isset($extra['provider']) ? (string) $extra['provider'] : null,
            'retries'      => (int) $raw['retries'],
            'resent_count' => (int) $raw['resent_count'],
            'error'        => null,
        ];
        if ($raw['status'] === 'failed') {
            $row['error'] = self::message(self::unserialize($raw['response']));
        }
        return $row;
    }

    /** Connection settings through an allowlist. Never API keys, passwords, tokens or usernames. */
    private static function connections(array $settings, array $misc)
    {
        $connections = isset($settings['connections']) && is_array($settings['connections']) ? $settings['connections'] : [];
        $mappings = isset($settings['mappings']) && is_array($settings['mappings']) ? $settings['mappings'] : [];
        $out = [];
        foreach ($connections as $key => $connection) {
            $p = isset($connection['provider_settings']) && is_array($connection['provider_settings']) ? $connection['provider_settings'] : [];
            $provider = isset($p['provider']) ? (string) $p['provider'] : 'unknown';
            $senders = [];
            foreach ($mappings as $email => $mappedKey) {
                if ($mappedKey === $key) {
                    $senders[] = (string) $email;
                }
            }
            $item = [
                'id'           => (string) $key,
                'title'        => isset($connection['title']) ? (string) $connection['title'] : $provider,
                'provider'     => $provider,
                'sender_email' => isset($p['sender_email']) ? (string) $p['sender_email'] : null,
                'sender_name'  => isset($p['sender_name']) ? (string) $p['sender_name'] : null,
                'senders'      => $senders,
                'is_default'   => isset($misc['default_connection']) && $misc['default_connection'] === $key,
                'is_fallback'  => isset($misc['fallback_connection']) && $misc['fallback_connection'] === $key,
            ];
            if ($provider === 'smtp') {
                // Host, port and encryption help explain connection errors and are not secrets.
                $item['host'] = isset($p['host']) ? (string) $p['host'] : null;
                $item['port'] = isset($p['port']) ? (string) $p['port'] : null;
                $item['encryption'] = isset($p['encryption']) ? (string) $p['encryption'] : null;
            }
            $out[] = $item;
        }
        return $out;
    }

    private static function recipients($to)
    {
        $out = [];
        foreach (is_array($to) ? $to : [$to] as $r) {
            if (is_array($r) && isset($r['email'])) {
                $out[] = ['email' => (string) $r['email'], 'name' => isset($r['name']) && $r['name'] !== '' ? (string) $r['name'] : null];
            } elseif (is_string($r) && $r !== '') {
                foreach (explode(',', $r) as $part) {
                    $part = trim($part);
                    if (preg_match('/^(.*)<([^>]+)>$/', $part, $m)) {
                        $out[] = ['email' => trim($m[2]), 'name' => trim($m[1], " \"'") ?: null];
                    } elseif ($part !== '') {
                        $out[] = ['email' => $part, 'name' => null];
                    }
                }
            }
        }
        return $out;
    }

    /** The human-readable error or status inside a stored provider response. */
    private static function message($response)
    {
        if (is_string($response)) {
            return $response !== '' ? self::text($response, 500) : null;
        }
        if (!is_array($response)) {
            return null;
        }
        foreach (['message', 'error_message', 'error', 'status', 'fallback'] as $key) {
            if (isset($response[$key]) && is_string($response[$key]) && $response[$key] !== '') {
                return self::text($response[$key], 500);
            }
        }
        foreach ($response as $value) {
            if (is_string($value) && $value !== '') {
                return self::text($value, 500);
            }
            if (is_array($value) && ($nested = self::message($value)) !== null) {
                return $nested;
            }
        }
        return null;
    }

    /** Stored values are PHP-serialized by FluentSMTP. Objects are never instantiated. */
    private static function unserialize($value)
    {
        if (!is_string($value) || !is_serialized($value)) {
            return $value;
        }
        $out = @unserialize(trim($value), ['allowed_classes' => false]);
        return $out === false && $value !== 'b:0;' ? null : $out;
    }

    private static function text($value, $max)
    {
        $s = is_scalar($value) ? (string) $value : '';
        return function_exists('mb_substr') ? mb_substr($s, 0, $max) : substr($s, 0, $max);
    }
}
