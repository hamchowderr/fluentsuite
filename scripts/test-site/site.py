#!/usr/bin/env python3
"""Builds and drives the FluentSuite test WordPress site on Coolify. See docs/test-site.md.

    site.py create                 # project, service, random admin password (only in Coolify)
    site.py push                   # copy remote/ (setup.sh, seed.php, wp) and the bridge plugin into the service
    site.py setup [steps]          # bootstrap install plugins smtp bridge forms seed mcp-user (default: all)
    site.py apppass <out-file>     # new Application Password for fluentsuite-mcp: stored as a Coolify variable
                                   # and written to <out-file> (mode 0600). Never printed.
    site.py copy-pro               # copy FluentCRM Pro / FluentBooking Pro from the hub site and activate CRM Pro
    site.py seed-pro <pw-file>     # one draft email sequence (Pro), via REST as fluentsuite-mcp
    site.py versions               # WordPress, PHP and plugin versions
    site.py smtp-status            # FluentSMTP simulate flag, bridge sending lock, version and email log counts
    site.py forms-status           # Fluent Forms version and entries per test form
    site.py bridge-sending on|off  # the bridge's sending lock; `on` refuses unless FluentSMTP simulates
    site.py run '<command>'        # one shell command in the wordpress container, as root (255 chars max)
    site.py remove                 # delete the service with its volumes, then the project

Configuration comes from environment variables (see docs/test-site.md); nothing about the infrastructure is
hard-coded:

    COOLIFY_URL                     Coolify base URL (required)
    COOLIFY_TOKEN                   Coolify API token, unless a proxy injects credentials
    FLUENTSUITE_TEST_SITE_URL       the test site's public URL, https://… (required)
    COOLIFY_SERVER_UUID             server to create the service on (create only)
    FLUENTSUITE_TEST_PROJECT_UUID   the test project; default: found by name
    FLUENTSUITE_TEST_SERVICE_UUID   the test service; default: found by name
    FLUENTSUITE_HUB_URL             licensed hub site to copy Pro plugins from (copy-pro only)
    FLUENTSUITE_HUB_SERVICE         its Coolify service name (copy-pro only)

Modelled on waas-plugins scripts/test-storefront/storefront.py.

Coolify notes: a scheduled-task command keeps only 255 characters (so the work lives in remote/setup.sh); task
output comes back empty (so results are written to an unguessable file under wp-content/uploads, fetched once and
deleted); and env values from GET are null (so variables are only ever set from known values, never round-tripped).
"""
import base64
import io
import json
import os
import secrets
import sys
import tarfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def env(name, needed_for='this command'):
    value = os.environ.get(name, '').strip()
    if not value:
        sys.exit(f'{name} is not set (needed for {needed_for}); see docs/test-site.md')
    return value


API = env('COOLIFY_URL', 'every command').rstrip('/') + '/api/v1'
PROJECT = 'FluentSuite (test)'
SERVICE = 'fluentsuite-test'
SITE = env('FLUENTSUITE_TEST_SITE_URL', 'every command').rstrip('/')
if not SITE.startswith('https://'):
    sys.exit('FLUENTSUITE_TEST_SITE_URL must start with https://')
CONTAINER = 'wordpress'
REMOTE = '/opt/wpcli/x'  # on the wpcli volume, so it survives restarts
BRIDGE = os.path.join(HERE, '..', '..', 'wordpress', 'fluentsuite-bridge')
CHUNK = 20000  # Coolify sends a service's .env as one shell argument; 20 KB per restart is known to work
STEPS = ['bootstrap', 'install', 'plugins', 'smtp', 'bridge', 'forms', 'seed', 'mcp-user']
APP_PASSWORD_VAR = 'FLUENTSUITE_MCP_APP_PASSWORD'
# Pro plugins come from the owner's licensed hub site on the same Coolify (read only: a temporary archive in its
# uploads, fetched by the test site, then deleted). The license key itself is never copied: Pro features work
# without activation, and leaving it inactive here means the test site can never use a license seat.
PRO_PLUGINS = ['fluentcampaign-pro', 'fluent-booking-pro']


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, headers={'accept': 'application/json'})
    if os.environ.get('COOLIFY_TOKEN'):
        req.add_header('authorization', 'Bearer ' + os.environ['COOLIFY_TOKEN'])
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header('content-type', 'application/json')
    try:
        with urllib.request.urlopen(req, data, timeout=60) as res:
            text = res.read().decode()
    except urllib.error.HTTPError as e:
        # Coolify's error bodies carry a message, never the request body.
        sys.exit(f'Coolify {method} {path}: HTTP {e.code} {e.read().decode()[:300]}')
    return json.loads(text) if text else None


def project_uuid():
    if os.environ.get('FLUENTSUITE_TEST_PROJECT_UUID'):
        return os.environ['FLUENTSUITE_TEST_PROJECT_UUID']
    for p in api('GET', '/projects'):
        if p['name'] == PROJECT:
            return p['uuid']
    return None


def service_uuid():
    if os.environ.get('FLUENTSUITE_TEST_SERVICE_UUID'):
        return os.environ['FLUENTSUITE_TEST_SERVICE_UUID']
    for s in api('GET', '/services'):
        if s['name'] == SERVICE:
            return s['uuid']
    sys.exit(f'No service named {SERVICE}; run create first')


def healthy(uuid, minutes):
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        time.sleep(8)
        s = api('GET', f'/services/{uuid}')
        statuses = [c.get('status') or '' for c in s.get('applications', []) + s.get('databases', [])]
        if statuses and all(x.startswith('running') and 'unhealthy' not in x and 'starting' not in x for x in statuses):
            return True
    return False


def wait_healthy(uuid):
    if not healthy(uuid, 4):
        api('POST', f'/services/{uuid}/start')
        if not healthy(uuid, 8):
            sys.exit(f'{SERVICE} did not become healthy')


def run(uuid, command, timeout=900):
    """Runs one command through an on-demand scheduled task (Coolify has no exec endpoint)."""
    if len(command) > 255:
        sys.exit('Coolify keeps 255 characters of a task command')
    task = api('POST', f'/services/{uuid}/scheduled-tasks', {
        'name': 'fs-' + secrets.token_hex(3), 'command': command, 'container': CONTAINER,
        'frequency': '0 0 1 1 *', 'timeout': timeout, 'enabled': False,
    })
    try:
        api('POST', f'/services/{uuid}/scheduled-tasks/{task["uuid"]}/execute')
        deadline = time.time() + timeout + 60
        while time.time() < deadline:
            time.sleep(4)
            done = [e for e in api('GET', f'/services/{uuid}/scheduled-tasks/{task["uuid"]}/executions') or []
                    if e.get('status') in ('success', 'failed') or e.get('finished_at')]
            if done:
                if done[0].get('message'):
                    print(done[0]['message'])
                if done[0]['status'] != 'success':
                    sys.exit(f'Task failed: {command.split()[0:3]}')
                return
        sys.exit('Task timed out')
    finally:
        api('DELETE', f'/services/{uuid}/scheduled-tasks/{task["uuid"]}')


def fetch_result(uuid, step):
    """Runs a setup step that writes its result to a random file under uploads, fetches it, then deletes it."""
    name = f'fs-{secrets.token_hex(16)}.txt'
    run(uuid, f'sh {REMOTE}/setup.sh {step} {name}')
    try:
        with urllib.request.urlopen(f'{SITE}/wp-content/uploads/{name}', timeout=30) as res:
            return res.read().decode()
    finally:
        run(uuid, f'sh {REMOTE}/setup.sh rmfile {name}')


def set_env(uuid, key, value, locked=False):
    """Creates or updates a service variable. PATCH only updates variables that already exist."""
    body = {'key': key, 'value': value, 'is_literal': True, 'is_shown_once': locked}
    if any(e['key'] == key for e in api('GET', f'/services/{uuid}/envs') or []):
        api('PATCH', f'/services/{uuid}/envs', body)
    else:
        api('POST', f'/services/{uuid}/envs', body)


def compose(with_package):
    text = open(os.path.join(HERE, 'compose.yml')).read()
    if with_package:
        text = text.replace('      WP_ADMIN_PASSWORD: ${WP_ADMIN_PASSWORD}\n',
                            '      WP_ADMIN_PASSWORD: ${WP_ADMIN_PASSWORD}\n      FS_PKG: ${FS_PKG:-}\n')
    return base64.b64encode(text.encode()).decode()


def create():
    # A strong random admin password, stored only in Coolify and never printed. A supplied one must be as long.
    password = os.environ.get('FLUENTSUITE_TEST_ADMIN_PASSWORD') or secrets.token_urlsafe(36)
    if len(password) < 32:
        sys.exit('FLUENTSUITE_TEST_ADMIN_PASSWORD must be at least 32 random characters (or leave it unset)')
    project = project_uuid() or api('POST', '/projects', {
        'name': PROJECT, 'description': 'Throwaway WordPress site with fictional data for testing FluentSuite'})['uuid']
    if any(s['name'] == SERVICE for s in api('GET', '/services')):
        sys.exit(f'{SERVICE} already exists; remove it first')
    uuid = api('POST', '/services', {
        'name': SERVICE, 'description': 'FluentSuite test site. Runbook docs/test-site.md in hamchowderr/fluentsuite',
        'project_uuid': project, 'environment_name': 'production',
        'server_uuid': env('COOLIFY_SERVER_UUID', 'create'),
        'docker_compose_raw': compose(False), 'urls': [{'name': CONTAINER, 'url': SITE}],
        'instant_deploy': False,
    })['uuid']
    # Readable in Coolify (masked until clicked) so the owner can log in.
    set_env(uuid, 'WP_ADMIN_PASSWORD', password)
    api('POST', f'/services/{uuid}/start')
    wait_healthy(uuid)
    print(f'project {project}, service {uuid}')


def build():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:xz') as tar:
        for name in sorted(os.listdir(os.path.join(HERE, 'remote'))):
            tar.add(os.path.join(HERE, 'remote', name), arcname=name)
        # The FluentSuite Bridge plugin from this checkout, installed by the `bridge` step.
        tar.add(BRIDGE, arcname='fluentsuite-bridge')
    return buf.getvalue()


def push():
    uuid = service_uuid()
    data = base64.b64encode(build()).decode()
    chunks = [data[i:i + CHUNK] for i in range(0, len(data), CHUNK)]
    api('PATCH', f'/services/{uuid}', {'docker_compose_raw': compose(True)})
    run(uuid, 'rm -rf /opt/wpcli/pkg && mkdir -p /opt/wpcli/pkg')
    for i, chunk in enumerate(chunks):
        print(f'chunk {i + 1}/{len(chunks)}')
        set_env(uuid, 'FS_PKG', chunk)
        api('POST', f'/services/{uuid}/restart')
        time.sleep(15)
        wait_healthy(uuid)
        try:
            run(uuid, f'printenv FS_PKG > /opt/wpcli/pkg/c{i:02d}')
        except SystemExit:
            # Coolify sometimes reports the service healthy just before a container restarts once more.
            wait_healthy(uuid)
            run(uuid, f'printenv FS_PKG > /opt/wpcli/pkg/c{i:02d}')
    unpack = f'cd /opt/wpcli/pkg && cat c* | tr -d "\\n" | base64 -d > p.txz && rm -rf {REMOTE} && mkdir -p {REMOTE} && tar -xJf p.txz -C {REMOTE}'
    try:
        run(uuid, unpack)
    except SystemExit:
        # Same restart race as above: wait, then try once more.
        wait_healthy(uuid)
        run(uuid, unpack)
    api('PATCH', f'/services/{uuid}', {'docker_compose_raw': compose(False)})
    for env in api('GET', f'/services/{uuid}/envs'):
        if env['key'] == 'FS_PKG':
            api('DELETE', f'/services/{uuid}/envs/{env["uuid"]}')
    api('POST', f'/services/{uuid}/restart')
    time.sleep(15)
    wait_healthy(uuid)


def setup(args):
    uuid = service_uuid()
    for step in args or STEPS:
        if step not in STEPS:
            sys.exit(f'unknown step {step}; steps: {" ".join(STEPS)}')
        print(f'== {step}')
        # install needs the site URL; the container doesn't know it.
        run(uuid, f'sh {REMOTE}/setup.sh {step}' + (f' {SITE}' if step == 'install' else ''))


def apppass(out_file):
    uuid = service_uuid()
    value = fetch_result(uuid, 'apppass').strip()
    if len(value.replace(' ', '')) != 24:
        sys.exit('Unexpected Application Password output')
    run(uuid, f'sh {REMOTE}/setup.sh prune-apppass')  # only the new one stays valid
    fd = os.open(out_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(value)
    # Masked in Coolify until clicked, so the owner can copy it into a GitHub Actions secret.
    set_env(uuid, APP_PASSWORD_VAR, value)
    print(f'Application Password for fluentsuite-mcp stored in Coolify ({APP_PASSWORD_VAR}) and {out_file}')


def versions():
    print(fetch_result(service_uuid(), 'versions'))


def copy_pro():
    hub_url = env('FLUENTSUITE_HUB_URL', 'copy-pro').rstrip('/')
    hub_service = env('FLUENTSUITE_HUB_SERVICE', 'copy-pro')
    hub = next((x['uuid'] for x in api('GET', '/services') if x['name'] == hub_service), None)
    if not hub:
        sys.exit(f'No Coolify service named {hub_service}')
    uuid = service_uuid()
    name = f'fs-{secrets.token_hex(16)}.tgz'
    up = '/var/www/html/wp-content/uploads'
    run(hub, f'cd {up} && tar czf {name} -C ../plugins {" ".join(PRO_PLUGINS)} && chmod 644 {name}')
    try:
        run(uuid, f'cd /var/www/html/wp-content/plugins && curl -fsSL {hub_url}/wp-content/uploads/{name} | tar xz'
                  f' && chown -R 33:33 {" ".join(PRO_PLUGINS)}')
    finally:
        run(hub, f'rm -f {up}/{name}')
    # FluentBooking Pro needs the free FluentBooking plugin; it is activated with that module.
    run(uuid, f'sh {REMOTE}/wp plugin activate fluentcampaign-pro')
    print('copied ' + ', '.join(PRO_PLUGINS) + '; activated fluentcampaign-pro (license not activated)')


def seed_pro(password_file):
    """One draft email sequence with two emails, through the REST API. Nobody is enrolled, so nothing sends."""
    password = open(password_file).read().strip().replace(' ', '')
    auth = 'Basic ' + base64.b64encode(f'fluentsuite-mcp:{password}'.encode()).decode()

    def rest(method, route, body=None):
        req = urllib.request.Request(f'{SITE}/wp-json/fluent-crm/v2/{route}', method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'authorization': auth, 'content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())

    title = 'New lead nurture (test)'
    if any(x['title'] == title for x in rest('GET', 'sequences?per_page=50')['sequences']['data']):
        print('sequence exists')
        return
    seq = rest('POST', 'sequences', {'title': title})['sequence']
    for i in (1, 2):
        rest('POST', f'sequences/{seq["id"]}/email', {'email': {
            'title': f'Welcome step {i}', 'email_subject': f'Welcome step {i}',
            'email_body': f'<p>Fictional sequence email {i}.</p>',
            'settings': {'timings': {'delay': i * 2, 'delay_unit': 'days'}}}})
    print(f'sequence {seq["id"]} with 2 emails (draft, nobody enrolled)')


def remove():
    uuid = service_uuid()
    api('DELETE', f'/services/{uuid}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true')
    while any(s['name'] == SERVICE for s in api('GET', '/services')):
        time.sleep(5)
    project = project_uuid()
    if project and not api('GET', f'/projects/{project}/production').get('services'):
        api('DELETE', f'/projects/{project}')
    print('removed')


if __name__ == '__main__':
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ''), sys.argv[2:]
    if cmd == 'create':
        create()
    elif cmd == 'push':
        push()
    elif cmd == 'setup':
        setup(args)
    elif cmd == 'apppass' and args:
        apppass(args[0])
    elif cmd == 'versions':
        versions()
    elif cmd == 'bridge-sending' and args and args[0] in ('on', 'off'):
        run(service_uuid(), f'sh {REMOTE}/setup.sh bridge-sending {args[0]}')
    elif cmd == 'forms-status':
        print(fetch_result(service_uuid(), 'forms-status'))
    elif cmd == 'smtp-status':
        print(fetch_result(service_uuid(), 'smtp-status'))
    elif cmd == 'run' and args:
        run(service_uuid(), args[0])
    elif cmd == 'copy-pro':
        copy_pro()
    elif cmd == 'seed-pro' and args:
        seed_pro(args[0])
    elif cmd == 'remove':
        remove()
    else:
        sys.exit(__doc__)
