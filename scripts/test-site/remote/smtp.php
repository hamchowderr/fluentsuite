<?php
/**
 * FluentSMTP on the test site: a connection that cannot deliver, plus fictional email log rows.
 *
 * Run with `wp eval-file smtp.php --user=admin` after FLUENTMAIL_SIMULATE_EMAILS is set in wp-config (setup.sh does
 * that first). Simulate mode means FluentSMTP never hands mail to any provider; the connection below also points
 * at 127.0.0.1:1, so even with simulate mode off nothing could leave the box. Every address is @example.com.
 * Re-running is safe: settings are rewritten to the same values and log rows are only seeded once.
 */

if (!function_exists('fluentMailSetSettings')) {
    WP_CLI::error('FluentSMTP is not active');
}
if (!defined('FLUENTMAIL_SIMULATE_EMAILS') || !FLUENTMAIL_SIMULATE_EMAILS) {
    WP_CLI::error('FLUENTMAIL_SIMULATE_EMAILS must be true before configuring FluentSMTP here');
}

$key = 'fluentsuite_test_smtp';
$sender = 'noreply@example.com';
$settings = get_option('fluentmail-settings') ?: [];
$settings['connections'] = [
    $key => [
        'title'             => 'SMTP Server',
        'provider_settings' => [
            'provider'         => 'smtp',
            'sender_name'      => 'FluentSuite Test',
            'sender_email'     => $sender,
            'force_from_name'  => 'no',
            'force_from_email' => 'yes',
            'return_path'      => 'yes',
            'host'             => '127.0.0.1',
            'port'             => '1',
            'auth'             => 'no',
            'username'         => '',
            'password'         => '',
            'auto_tls'         => 'no',
            'encryption'       => 'none',
            'key_store'        => 'db',
        ],
    ],
];
$settings['mappings'] = [$sender => $key, 'wordpress@example.com' => $key];
$settings['misc'] = array_merge($settings['misc'] ?? [], [
    'log_emails'              => 'yes',
    'log_saved_interval_days' => '365',
    'simulate_emails'         => 'yes',
    'default_connection'      => $key,
    'fallback_connection'     => '',
]);
fluentMailSetSettings($settings);
WP_CLI::log('FluentSMTP: simulate mode on, connection 127.0.0.1:1, logs kept 365 days');

global $wpdb;
$table = $wpdb->prefix . 'fsmpt_email_logs';

// Two emails carrying FAKE credentials (a reset link and a one-time code), for testing FluentSuite's secret
// masking against the live site. Neither works anywhere: the key and code are made up.
$secretSubjects = ['Password reset for your account', 'Your verification code'];
if (!(int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE subject = %s", $secretSubjects[0]))) {
    $at = current_time('mysql');
    $site = home_url();
    $bodies = [
        '<p>Someone asked to reset the password for ava.thompson.</p><p><a href="' . $site
            . '/wp-login.php?action=rp&key=FAKEkey0123456789abcd&login=ava.thompson">Reset your password</a></p>',
        '<p>Your verification code is <strong>482913</strong>. It expires in 10 minutes.</p>',
    ];
    foreach ($secretSubjects as $n => $subject) {
        $wpdb->insert($table, [
            'to'          => maybe_serialize([['email' => 'ava.thompson@example.com', 'name' => 'Ava Thompson']]),
            'from'        => 'FluentSuite Test <wordpress@example.com>',
            'subject'     => $subject,
            'body'        => $bodies[$n],
            'headers'     => maybe_serialize(['content-type' => 'text/html']),
            'attachments' => maybe_serialize([]),
            'status'      => 'failed',
            'response'    => maybe_serialize(['code' => 'smtp_connect', 'message' => 'SMTP Error: Could not connect to SMTP host. Connection refused (111)']),
            'extra'       => maybe_serialize(['provider' => 'Smtp']),
            'retries'     => 0,
            'resent_count' => 0,
            'source'      => 'WordPress',
            'created_at'  => $at,
            'updated_at'  => $at,
        ]);
    }
    WP_CLI::log('seeded 2 emails with fake secrets (reset link, one-time code)');
}

if ((int) $wpdb->get_var("SELECT COUNT(*) FROM {$table} WHERE `from` LIKE '%@example.com%' AND subject NOT IN ('Password reset for your account', 'Your verification code')") > 0) {
    WP_CLI::log('email logs already seeded');
    return;
}

$people = [
    ['Ava Thompson', 'ava.thompson'], ['Liam Carter', 'liam.carter'], ['Mia Rossi', 'mia.rossi'],
    ['Noah Patel', 'noah.patel'], ['Zoe Kim', 'zoe.kim'], ['Ethan Brooks', 'ethan.brooks'],
    ['Isla Novak', 'isla.novak'], ['Lucas Moreau', 'lucas.moreau'],
];
$kinds = [
    ['Welcome to the newsletter', 'FluentCRM', '<p>Thanks for subscribing (fictional).</p>'],
    ['Your order receipt #10%02d', 'FluentCart', '<p>Fictional receipt.</p>'],
    ['Password reset request', 'WordPress', '<p>Fictional reset email. No real link.</p>'],
    ['We received your message', 'Fluent Forms', '<p>Fictional form confirmation.</p>'],
    ['Booking confirmed for Friday', 'FluentBooking', '<p>Fictional booking.</p>'],
];
$errors = [
    ['code' => 'smtp_connect', 'message' => 'SMTP Error: Could not connect to SMTP host. Connection refused (111)'],
    ['code' => 'smtp_auth', 'message' => 'SMTP Error: Could not authenticate.'],
    ['code' => 'recipient_rejected', 'message' => 'SMTP Error: The following recipients failed: 550 5.1.1 mailbox unavailable'],
];

$now = current_time('timestamp');
$rows = 0;
for ($i = 0; $i < 36; $i++) {
    $person = $people[$i % count($people)];
    $kind = $kinds[$i % count($kinds)];
    $failed = in_array($i % 6, [2, 5], true) && $i < 30;
    $error = $errors[$i % count($errors)];
    $at = gmdate('Y-m-d H:i:s', $now - (int) (($i * 9.5 + 1) * HOUR_IN_SECONDS));
    $wpdb->insert($table, [
        'to'           => maybe_serialize([['email' => $person[1] . '@example.com', 'name' => $person[0]]]),
        'from'         => 'FluentSuite Test <' . $sender . '>',
        'subject'      => sprintf($kind[0], $i),
        'body'         => $kind[2],
        'headers'      => maybe_serialize(['content-type' => 'text/html']),
        'attachments'  => maybe_serialize([]),
        'status'       => $failed ? 'failed' : 'sent',
        'response'     => maybe_serialize($failed ? $error : ['status' => 'Sending was simulated. No email was actually sent.']),
        'extra'        => maybe_serialize(['provider' => $failed ? 'Smtp' : 'Simulator']),
        'retries'      => $failed ? $i % 3 : 0,
        'resent_count' => 0,
        'source'       => $kind[1],
        'created_at'   => $at,
        'updated_at'   => $at,
    ]);
    $rows++;
}
WP_CLI::log("seeded {$rows} fictional email log rows (@example.com)");
