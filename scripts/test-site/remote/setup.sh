#!/bin/sh
# FluentSuite test site setup steps, run by Coolify scheduled tasks as root in the wordpress container.
#   sh /opt/wpcli/x/setup.sh <step> [arg]
# Steps, in order: bootstrap install plugins smtp bridge forms seed mcp-user; any time: versions, smtp-status, forms-status, bridge-sending on|off, apppass <file>, prune-apppass.
# Coolify keeps 255 characters of a task command and returns no output, so results that the
# driver needs are written to a file under wp-content/uploads, fetched once, then deleted.
set -eu
X=/opt/wpcli/x
WP="sh $X/wp"
OUT=/var/www/html/wp-content/uploads
case "${1:-}" in
  bootstrap)
    mkdir -p /opt/wpcli
    curl -fsSL -o /opt/wpcli/wp-cli.phar https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar
    $WP --version ;;
  install)
    # The site URL comes as an argument from site.py (FLUENTSUITE_TEST_SITE_URL).
    $WP core is-installed && { echo already installed; exit 0; }
    [ -n "${WP_ADMIN_PASSWORD:-}" ] || { echo WP_ADMIN_PASSWORD missing; exit 1; }
    case "${2:-}" in https://*) ;; *) echo "install needs the site URL (https://…)"; exit 2 ;; esac
    $WP core install --url="$2" --title="FluentSuite test site" --admin_user=admin \
      --admin_password="$WP_ADMIN_PASSWORD" --admin_email=admin@example.com --skip-email
    $WP option update blog_public 0
    $WP rewrite structure '/%postname%/' --hard ;;
  plugins)
    # Free plugins from wordpress.org. Install once, then just activate; updates are a separate, deliberate step.
    for p in fluent-crm; do
      $WP plugin is-installed $p || $WP plugin install $p
      $WP plugin activate $p
    done
    $WP plugin list --fields=name,status,version ;;
  seed)
    # Fictional contacts only (example.com). Re-running is safe: it skips when seed data exists.
    $WP eval-file $X/seed.php --user=admin ;;
  smtp)
    # FluentSMTP in simulate mode: set in wp-config BEFORE the plugin is active, so no email ever leaves the box
    # (FluentCRM's included). smtp.php adds a connection to 127.0.0.1:1 and fictional log rows.
    $WP config set FLUENTMAIL_SIMULATE_EMAILS true --raw --type=constant
    $WP plugin is-installed fluent-smtp || $WP plugin install fluent-smtp --version=2.4.1
    $WP plugin activate fluent-smtp
    $WP eval-file $X/smtp.php --user=admin ;;
  forms)
    # Fluent Forms, with four forms from its own templates and fictional entries inserted directly (no submission
    # hooks, so no notifications or feeds). Needs FluentSMTP's simulate mode on first (the smtp step).
    $WP plugin is-installed fluentform || $WP plugin install fluentform --version=6.2.15
    $WP plugin activate fluentform
    $WP eval-file $X/forms.php --user=admin ;;
  forms-status)
    case "${2:-}" in fs-*.txt) ;; *) echo "forms-status needs a file name like fs-<random>.txt"; exit 2 ;; esac
    { echo "simulate=$($WP config get FLUENTMAIL_SIMULATE_EMAILS)"; echo "fluentform=$($WP plugin get fluentform --field=version)"
      $WP eval 'global $wpdb; foreach ($wpdb->get_results("SELECT f.id, f.title, COUNT(s.id) n, SUM(s.status=\"unread\") u, SUM(s.status=\"trashed\") t FROM {$wpdb->prefix}fluentform_forms f LEFT JOIN {$wpdb->prefix}fluentform_submissions s ON s.form_id=f.id GROUP BY f.id") as $r) echo "form $r->id \"$r->title\": $r->n entries ($r->u unread, $r->t trashed)\n";'
    } > "$OUT/$2"
    chmod 644 "$OUT/$2" ;;
  bridge)
    # The FluentSuite Bridge plugin pushed from this checkout (replaces any older copy). Sending stays off:
    # FLUENTSUITE_BRIDGE_ALLOW_SENDING is not set here.
    P=/var/www/html/wp-content/plugins/fluentsuite-bridge
    rm -rf $P && cp -r $X/fluentsuite-bridge $P && chown -R 33:33 $P
    $WP plugin activate fluentsuite-bridge ;;
  bridge-sending)
    # Turns the bridge's sending lock on or off. Only ever on while FluentSMTP simulates (nothing can leave).
    case "${2:-}" in
      on) [ "$($WP config get FLUENTMAIL_SIMULATE_EMAILS)" = "1" ] || { echo "refusing: simulate mode is off"; exit 1; }
          $WP config set FLUENTSUITE_BRIDGE_ALLOW_SENDING true --raw --type=constant ;;
      off) $WP config delete FLUENTSUITE_BRIDGE_ALLOW_SENDING --type=constant 2>/dev/null || true ;;
      *) echo "bridge-sending needs on or off"; exit 2 ;;
    esac ;;
  smtp-status)
    # Simulate flag, FluentSMTP version and email log counts by status, written like `versions`.
    case "${2:-}" in fs-*.txt) ;; *) echo "smtp-status needs a file name like fs-<random>.txt"; exit 2 ;; esac
    { echo "simulate=$($WP config get FLUENTMAIL_SIMULATE_EMAILS)"; echo "bridge_sending=$($WP config get FLUENTSUITE_BRIDGE_ALLOW_SENDING 2>/dev/null || echo off)"; echo "fluent-smtp=$($WP plugin get fluent-smtp --field=version)"
      $WP eval 'global $wpdb; foreach ($wpdb->get_results("SELECT status, COUNT(*) n FROM {$wpdb->prefix}fsmpt_email_logs GROUP BY status") as $r) echo "$r->status=$r->n\n";'
    } > "$OUT/$2"
    chmod 644 "$OUT/$2" ;;
  mcp-user)
    # A dedicated administrator for the MCP server, so its Application Password can be revoked on its own.
    $WP user get fluentsuite-mcp --field=ID >/dev/null 2>&1 && { echo exists; exit 0; }
    $WP user create fluentsuite-mcp mcp@example.com --role=administrator --display_name="FluentSuite MCP" \
      --user_pass="$(head -c 24 /dev/urandom | base64)" ;;
  apppass)
    # Creates a new Application Password for fluentsuite-mcp and writes it to $OUT/<file> (0600, owner www-data).
    case "${2:-}" in fs-*.txt) ;; *) echo "apppass needs a file name like fs-<random>.txt"; exit 2 ;; esac
    umask 077
    $WP user application-password create fluentsuite-mcp "fluentsuite-mcp $(date -u +%Y%m%d%H%M)" --porcelain > "$OUT/$2"
    chown 33:33 "$OUT/$2"; chmod 644 "$OUT/$2" ;;
  prune-apppass)
    # Revokes every fluentsuite-mcp Application Password except the newest.
    for u in $($WP user application-password list fluentsuite-mcp --orderby=created --order=desc --field=uuid | tail -n +2); do
      $WP user application-password delete fluentsuite-mcp "$u"
    done ;;
  rmfile)
    case "${2:-}" in fs-*.txt) rm -f "$OUT/$2" ;; *) exit 2 ;; esac ;;
  versions)
    case "${2:-}" in fs-*.txt) ;; *) echo "versions needs a file name like fs-<random>.txt"; exit 2 ;; esac
    { $WP core version; $WP plugin list --fields=name,status,version --format=csv; php -r 'echo PHP_VERSION, "\n";'; } > "$OUT/$2"
    chmod 644 "$OUT/$2" ;;
  *) echo "unknown step"; exit 2 ;;
esac
