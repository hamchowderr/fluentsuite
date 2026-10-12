<?php
// Seeds the FluentSuite test site with FICTIONAL FluentCRM data. Every email is @example.com.
// Deterministic (fixed random seed) so recorded fixtures are stable. Safe to re-run: skips if seeded.
// Run with: wp eval-file seed.php --user=admin

use FluentCrm\App\Models\Campaign;
use FluentCrm\App\Models\Lists;
use FluentCrm\App\Models\Subscriber;
use FluentCrm\App\Models\SubscriberNote;
use FluentCrm\App\Models\Tag;

if (!function_exists('FluentCrmApi')) {
    echo "FluentCRM is not active\n";
    exit(1);
}
if (Subscriber::where('email', 'like', '%@example.com')->count() >= 50) {
    echo "already seeded\n";
    return;
}

mt_srand(20261012);
$pick = function (array $items) { return $items[mt_rand(0, count($items) - 1)]; };

// Custom field definitions (FluentCRM stores them in an option).
fluentcrm_update_option('contact_custom_fields', [
    ['slug' => 'plan', 'label' => 'Plan', 'type' => 'select-one', 'options' => ['Free', 'Pro', 'Agency'], 'group' => 'Default'],
    ['slug' => 'company_size', 'label' => 'Company size', 'type' => 'select-one', 'options' => ['1-10', '11-50', '51-200'], 'group' => 'Default'],
]);

$tagIds = [];
foreach (['VIP', 'int:pricing', 'int:hosting', 'src:webinar-2026-09', 'src:referral', 'stage:lead', 'stage:customer', 'stage:churned', 'tmp:winback-2026-q4'] as $title) {
    $slug = sanitize_title(str_replace(':', '-', $title));
    $tag = Tag::where('slug', $slug)->first() ?: Tag::create(['title' => $title, 'slug' => $slug]);
    $tagIds[$title] = $tag->id;
}
$listIds = [];
foreach (['Newsletter', 'Product updates', 'Webinar attendees'] as $title) {
    $slug = sanitize_title($title);
    $list = Lists::where('slug', $slug)->first() ?: Lists::create(['title' => $title, 'slug' => $slug, 'is_public' => 0]);
    $listIds[$title] = $list->id;
}

$first = ['Ava', 'Ben', 'Chloe', 'Dev', 'Elif', 'Femi', 'Gita', 'Hugo', 'Ines', 'Jon', 'Kai', 'Lena', 'Mo', 'Nia', 'Omar', 'Pia', 'Quinn', 'Rui', 'Sana', 'Tom', 'Uma', 'Vik', 'Wen', 'Xan', 'Yara'];
$last = ['Adams', 'Brook', 'Costa', 'Dane', 'Ellis', 'Ford', 'Gray', 'Hale', 'Ito', 'Jones', 'Khan', 'Lopez', 'Moss', 'Nair', 'Okafor', 'Park', 'Reyes', 'Silva', 'Tan', 'Vega'];
$statuses = ['subscribed', 'subscribed', 'subscribed', 'subscribed', 'subscribed', 'subscribed', 'pending', 'unsubscribed', 'bounced'];
$sources = ['web', 'webinar', 'import', 'form', 'referral'];
$countries = ['US', 'GB', 'DE', 'NG', 'IN', 'BR', 'JP', 'AU'];
$now = current_time('timestamp');

$created = 0;
for ($i = 1; $i <= 50; $i++) {
    $fn = $first[($i - 1) % count($first)];
    $ln = $pick($last);
    $email = strtolower($fn . '.' . $ln . $i) . '@example.com';
    $status = $pick($statuses);
    $customer = mt_rand(1, 100) <= 30;
    $tags = [$customer ? 'stage:customer' : 'stage:lead'];
    foreach (['VIP' => 10, 'int:pricing' => 30, 'int:hosting' => 25, 'src:webinar-2026-09' => 20, 'src:referral' => 15] as $t => $pct) {
        if (mt_rand(1, 100) <= $pct) $tags[] = $t;
    }
    $lists = [];
    if ($status !== 'unsubscribed' && $status !== 'bounced') {
        $lists[] = 'Newsletter';
        if (mt_rand(1, 100) <= 50) $lists[] = 'Product updates';
        if (in_array('src:webinar-2026-09', $tags, true)) $lists[] = 'Webinar attendees';
    }
    $contact = FluentCrmApi('contacts')->createOrUpdate([
        'email' => $email,
        'first_name' => $fn,
        'last_name' => $ln,
        'status' => $status,
        'contact_type' => $customer ? 'customer' : 'lead',
        'source' => $pick($sources),
        'country' => $pick($countries),
        'plan' => $customer ? $pick(['Pro', 'Agency']) : 'Free',
        'company_size' => $pick(['1-10', '11-50', '51-200']),
        'tags' => array_map(function ($t) use ($tagIds) { return $tagIds[$t]; }, $tags),
        'lists' => array_map(function ($l) use ($listIds) { return $listIds[$l]; }, $lists),
    ], true);
    if (!$contact) continue;
    $created++;
    // Spread signups over the last 120 days so "recent signups" and growth reports have shape.
    $when = date('Y-m-d H:i:s', $now - mt_rand(0, 120) * DAY_IN_SECONDS - mt_rand(0, 86399));
    $active = mt_rand(1, 100) <= 70 ? date('Y-m-d H:i:s', $now - mt_rand(0, 30) * DAY_IN_SECONDS) : null;
    Subscriber::where('id', $contact->id)->update(['created_at' => $when, 'last_activity' => $active]);
    if (mt_rand(1, 100) <= 20) {
        SubscriberNote::create([
            'subscriber_id' => $contact->id,
            'created_by' => get_current_user_id(),
            'type' => $pick(['note', 'call', 'meeting']),
            'title' => $pick(['Asked about annual pricing', 'Demo booked', 'Follow up next week', 'Needs migration help']),
            'description' => '<p>Fictional note for testing.</p>',
        ]);
    }
}

// One draft campaign. Never scheduled or sent.
if (!Campaign::where('slug', 'october-product-update-test')->first()) {
    Campaign::create([
        'title' => 'October product update (test)',
        'slug' => 'october-product-update-test',
        'type' => 'campaign',
        'status' => 'draft',
        'email_subject' => 'What is new this October',
        'email_pre_header' => 'Fictional test campaign',
        'email_body' => '<p>Hello {{contact.first_name}}, this is a fictional test campaign.</p>',
        'design_template' => 'simple',
        'created_by' => get_current_user_id(),
    ]);
}

echo "seeded {$created} contacts, " . count($tagIds) . ' tags, ' . count($listIds) . " lists, 1 draft campaign\n";
echo "email sequences need FluentCRM Pro: not seeded\n";
