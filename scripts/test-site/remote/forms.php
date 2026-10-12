<?php
/**
 * Fluent Forms on the test site: four forms from Fluent Forms' own templates, and fictional entries.
 *
 * Run with `wp eval-file forms.php --user=admin`. Entries are inserted directly into Fluent Forms' tables, so no
 * submission hooks run: no notifications, no integration feeds, no webhooks. FluentSMTP's simulate mode must be on
 * as a second net. Every address is @example.com; IPs are from the 192.0.2.0/24 documentation range; uploaded
 * "files" are names in URLs that point nowhere. Re-running is safe: it stops if the forms already exist.
 */

if (!defined('FLUENTFORM_VERSION') || !class_exists('\FluentForm\App\Services\Form\FormService')) {
    WP_CLI::error('Fluent Forms is not active');
}
if (!defined('FLUENTMAIL_SIMULATE_EMAILS') || !FLUENTMAIL_SIMULATE_EMAILS) {
    WP_CLI::error('FLUENTMAIL_SIMULATE_EMAILS must be true before seeding Fluent Forms here');
}

global $wpdb;
$forms = $wpdb->prefix . 'fluentform_forms';
if ((int) $wpdb->get_var("SELECT COUNT(*) FROM {$forms} WHERE title LIKE '%(test)'") > 0) {
    WP_CLI::log('Fluent Forms test forms already exist');
    return;
}

mt_srand(20261012);
$plan = [
    ['basic_contact_form', 'Contact (test)', 24],
    ['newsletter_form', 'Newsletter signup (test)', 18],
    ['volunteer_signup_form', 'Event registration (test)', 12],
    ['payment_donation_form', 'Donation (test)', 8],
];
$people = [
    ['Ava', 'Thompson'], ['Liam', 'Carter'], ['Mia', 'Rossi'], ['Noah', 'Patel'], ['Zoe', 'Kim'],
    ['Ethan', 'Brooks'], ['Isla', 'Novak'], ['Lucas', 'Moreau'], ['Yara', 'Khan'], ['Omar', 'Haddad'],
    ['Lena', 'Vogel'], ['Ravi', 'Iyer'], ['Sofia', 'Lind'], ['Jonas', 'Berg'], ['Chloe', 'Dubois'],
];
$places = [['Lisbon', 'PT'], ['Austin', 'US'], ['Toronto', 'CA'], ['Leeds', 'GB'], ['Berlin', 'DE'], ['Sydney', 'AU']];
$messages = [
    'Hi, I would like a quote for the starter plan.',
    'Can you call me back next week about pricing?',
    'Your verification code is 482913. (Pasted by mistake in a test entry.)',
    'Please reset my account: https://example.com/wp-login.php?action=rp&key=FAKEkey9876543210zyxw&login=test',
    'Is there a discount for nonprofits?',
    'Loved the webinar, do you have the slides?',
];

$service = new \FluentForm\App\Services\Form\FormService();
$now = current_time('timestamp');
$created = 0;
$entries = 0;

foreach ($plan as $index => list($template, $title, $count)) {
    $form = $service->store(['predefined' => $template]);
    $form->title = $title;
    $fields = json_decode($form->form_fields, true);

    // The contact form gets two extra fields for testing FluentSuite's PII rules: a file upload and a
    // sensitive-looking text field ("tax_id"). Neither is ever filled with anything real.
    if ($index === 0) {
        $fields['fields'][] = [
            'index' => 90, 'element' => 'input_file', 'attributes' => ['type' => 'file', 'name' => 'attachment'],
            'settings' => ['label' => 'Attachment', 'container_class' => '', 'validation_rules' => []],
            'editor_options' => ['title' => 'File Upload'], 'uniqElKey' => 'el_fs_attachment',
        ];
        $fields['fields'][] = [
            'index' => 91, 'element' => 'input_text', 'attributes' => ['type' => 'text', 'name' => 'tax_id', 'value' => ''],
            'settings' => ['label' => 'Tax ID', 'container_class' => '', 'validation_rules' => []],
            'editor_options' => ['title' => 'Simple Text'], 'uniqElKey' => 'el_fs_tax_id',
        ];
        $form->form_fields = wp_json_encode($fields);
    }
    $form->save();
    $created++;

    $flat = [];
    $walk = function ($list) use (&$walk, &$flat) {
        foreach ((array) $list as $field) {
            if (!empty($field['columns'])) {
                foreach ($field['columns'] as $column) {
                    $walk($column['fields'] ?? []);
                }
                continue;
            }
            if (!empty($field['attributes']['name'])) {
                $flat[] = $field;
            }
        }
    };
    $walk($fields['fields'] ?? []);

    for ($i = 1; $i <= $count; $i++) {
        $person = $people[($i + $index * 3) % count($people)];
        $place = $places[($i + $index) % count($places)];
        $email = strtolower($person[0] . '.' . $person[1] . ($i + $index * 30)) . '@example.com';
        $response = [];
        foreach ($flat as $field) {
            $name = $field['attributes']['name'];
            switch ($field['element']) {
                case 'input_name':
                    $response[$name] = ['first_name' => $person[0], 'last_name' => $person[1]];
                    break;
                case 'input_email':
                    $response[$name] = $email;
                    break;
                case 'textarea':
                    $response[$name] = $messages[($i + $index) % count($messages)];
                    break;
                case 'phone':
                    $response[$name] = '+1 555 01' . str_pad((string) (10 + $i), 2, '0', STR_PAD_LEFT);
                    break;
                case 'input_file':
                    // Every other entry "uploaded" a file. The URL points nowhere.
                    if ($i % 2) {
                        $response[$name] = [home_url('/wp-content/uploads/fluentform/fake-' . $i . '-quote-request.pdf')];
                    }
                    break;
                case 'address':
                    $response[$name] = ['address_line_1' => $i . ' Example Street', 'city' => $place[0], 'country' => $place[1]];
                    break;
                case 'input_checkbox':
                case 'select':
                case 'input_radio':
                    $options = array_keys((array) ($field['settings']['advanced_options'] ?? $field['options'] ?? []));
                    $values = array_map(function ($o) {
                        return is_array($o) ? ($o['value'] ?? '') : $o;
                    }, (array) ($field['settings']['advanced_options'] ?? []));
                    $value = $values ? $values[$i % count($values)] : 'Option ' . ($i % 3 + 1);
                    $response[$name] = $field['element'] === 'input_checkbox' ? [$value] : $value;
                    break;
                case 'input_number':
                    $response[$name] = (string) (10 + $i * 5);
                    break;
                case 'input_text':
                    $response[$name] = $name === 'tax_id' ? 'FAKE-TAX-' . str_pad((string) $i, 4, '0', STR_PAD_LEFT) : 'Test value ' . $i;
                    break;
                case 'input_date':
                    $response[$name] = gmdate('Y-m-d', $now + $i * DAY_IN_SECONDS);
                    break;
                default:
                    if (strpos($field['element'], 'payment') !== false || strpos($field['element'], 'custom_payment') !== false) {
                        $response[$name] = (string) (10 * (($i % 5) + 1));
                    }
            }
        }
        $at = gmdate('Y-m-d H:i:s', $now - (int) ((($count - $i) * 3.7 + $index) * DAY_IN_SECONDS));
        $status = $i % 7 === 0 ? 'trashed' : ($i % 3 === 0 ? 'unread' : 'read');
        $row = [
            'form_id'       => $form->id,
            'serial_number' => $i,
            'response'      => wp_json_encode($response),
            'source_url'    => home_url('/' . sanitize_title($title) . '/'),
            'user_id'       => null,
            'status'        => $status,
            'is_favourite'  => $i % 5 === 0 ? 1 : 0,
            'browser'       => ['Chrome', 'Firefox', 'Safari'][$i % 3],
            'device'        => ['desktop', 'mobile'][$i % 2],
            'ip'            => '192.0.2.' . (10 + $i),
            'city'          => $place[0],
            'country'       => $place[1],
            'created_at'    => $at,
            'updated_at'    => $at,
        ];
        if ($template === 'payment_donation_form') {
            $amount = 10 * (($i % 5) + 1);
            $row += [
                'payment_status' => $i % 4 === 0 ? 'failed' : 'paid',
                'payment_method' => 'stripe',
                'payment_type'   => 'product',
                'currency'       => 'USD',
                'payment_total'  => $amount * 100,
                'total_paid'     => $i % 4 === 0 ? 0 : $amount * 100,
            ];
        }
        $wpdb->insert($wpdb->prefix . 'fluentform_submissions', $row);
        $submissionId = (int) $wpdb->insert_id;

        // Entry details (what Fluent Forms searches and shows per field).
        foreach ($response as $name => $value) {
            foreach (is_array($value) && array_keys($value) !== range(0, count($value) - 1) ? $value : ['' => $value] as $sub => $v) {
                $wpdb->insert($wpdb->prefix . 'fluentform_entry_details', [
                    'form_id'        => $form->id,
                    'submission_id'  => $submissionId,
                    'field_name'     => $name,
                    'sub_field_name' => (string) $sub,
                    'field_value'    => is_array($v) ? maybe_serialize($v) : (string) $v,
                ]);
            }
        }
        if ($i === 2) {
            $wpdb->insert($wpdb->prefix . 'fluentform_submission_meta', [
                'response_id' => $submissionId, 'form_id' => $form->id, 'meta_key' => '_notes',
                'value' => 'Called back, interested in the starter plan (fictional note).', 'status' => null,
                'user_id' => get_current_user_id(), 'name' => 'Admin', 'created_at' => $at, 'updated_at' => $at,
            ]);
        }
        $entries++;
    }
}
WP_CLI::log("created {$created} forms and {$entries} fictional entries (@example.com), with no submission hooks run");
