#!/usr/bin/env bash
# Backup / restore the app registry around a Pushpin deploy.
#
# App Platform rebuilds the container on every deploy, wiping the local SQLite
# file — so the apps and their pk_/sk_ keys have to be exported before and
# imported after. Nothing does this automatically.
#
#   ./deploy-apps.sh preflight   # check + back up, BEFORE pushing
#   ./deploy-apps.sh restore     # re-import, AFTER the deploy is live
#   ./deploy-apps.sh create      # first-time setup: create the apps this
#                                # platform expects, then back them up
#
# ADMIN_SECRET comes from .env (gitignored) or the environment. The backup is
# written to apps-backup.json, also gitignored: it holds live keys in plaintext.
set -euo pipefail

cd "$(dirname "$0")"

# Read .env rather than sourcing it. A secret is arbitrary bytes — spaces,
# braces, quotes — and `. ./.env` would execute it as shell, which both breaks
# and can echo fragments of the value into an error message.
if [ -z "${ADMIN_SECRET:-}" ] && [ -f .env ]; then
    ADMIN_SECRET="$(sed -n 's/^[[:space:]]*ADMIN_SECRET[[:space:]]*=//p' .env | head -1 | tr -d '\r')"
    # tolerate a quoted value
    case "$ADMIN_SECRET" in
        \"*\") ADMIN_SECRET="${ADMIN_SECRET#\"}"; ADMIN_SECRET="${ADMIN_SECRET%\"}" ;;
        \'*\') ADMIN_SECRET="${ADMIN_SECRET#\'}"; ADMIN_SECRET="${ADMIN_SECRET%\'}" ;;
    esac
fi

HOST="${PUSHPIN_HOST:-https://pushpin-myf3y.ondigitalocean.app}"
export BACKUP="apps-backup.json"
: "${ADMIN_SECRET:?not set — put it in .env or the environment (it is in the DigitalOcean app config)}"

api() { curl -fsS -m 30 -H "x-admin-secret: $ADMIN_SECRET" "$@"; }

case "${1:-}" in
preflight)
    echo "-> $HOST"
    api "$HOST/" > /dev/null && echo "   reachable"

    echo "-> checking for channels this release would start gating"
    api "$HOST/admin/stats" > /tmp/pushpin-stats.json
    python3 <<'PY'
import json, sys
stats = json.load(open("/tmp/pushpin-stats.json"))
apps = stats.get("stats", stats) or {}
clashes = [(a, c) for a, s in apps.items() for c in (s.get("channels") or {})
           if c.startswith(("private-", "presence-"))]
if clashes:
    print("   STOP - these live channels would begin requiring authorization:")
    for a, c in clashes:
        print("     %s  %s" % (a, c))
    sys.exit(1)
print("   none - safe to deploy")
PY
    rm -f /tmp/pushpin-stats.json

    echo "-> backing up apps"
    # Download to a temp file and validate BEFORE touching the existing backup.
    # An export that comes back empty (which is what a wiped, un-restored
    # instance returns) must never be allowed to overwrite a good backup.
    api "$HOST/admin/export" > "$BACKUP.new"
    BACKUP_NEW="$BACKUP.new" python3 <<'PYEOF'
import json, os, sys
new = json.load(open(os.environ["BACKUP_NEW"]))
if not new.get("ok"):
    print("   export failed"); sys.exit(1)

apps = new.get("apps") or []
old = []
if os.path.exists(os.environ["BACKUP"]):
    try:
        old = json.load(open(os.environ["BACKUP"])).get("apps") or []
    except Exception:
        pass

if not apps:
    print("   the live instance has NO apps registered.")
    if old:
        print("   refusing to overwrite a backup holding %d apps." % len(old))
        sys.exit(1)
    print("   nothing to back up - it needs apps created before it is useful.")
    sys.exit(3)

if old and len(apps) < len(old):
    print("   live has %d apps, backup has %d - refusing to shrink it." % (len(apps), len(old)))
    sys.exit(1)

print("   %d apps:" % len(apps))
for a in apps:
    print("     %s  %s" % (a["id"], a["name"]))
PYEOF
    rc=$?
    if [ $rc -eq 0 ]; then
        mv "$BACKUP.new" "$BACKUP"
    else
        rm -f "$BACKUP.new"
        [ $rc -eq 3 ] || exit $rc
    fi
    echo
    echo "Backed up. Safe to push."
    ;;

restore)
    [ -f "$BACKUP" ] || { echo "no $BACKUP - run preflight first" >&2; exit 1; }
    echo "-> $HOST"
    api "$HOST/" > /dev/null && echo "   reachable"

    echo "-> importing (upsert by id; keys preserved, nothing deleted)"
    python3 <<'PY' > /tmp/pushpin-import.json
import json, os
print(json.dumps({"apps": json.load(open(os.environ["BACKUP"]))["apps"]}))
PY
    api -X POST -H 'content-type: application/json' \
        --data-binary @/tmp/pushpin-import.json "$HOST/admin/import"
    rm -f /tmp/pushpin-import.json
    echo

    echo "-> verifying keys survived"
    api "$HOST/admin/export" > /tmp/pushpin-after.json
    python3 <<'PY'
import json, os, sys
after = {a["id"]: a for a in json.load(open("/tmp/pushpin-after.json"))["apps"]}
before = {a["id"]: a for a in json.load(open(os.environ["BACKUP"]))["apps"]}
missing = [i for i in before if i not in after]
changed = [i for i in before if i in after and (
    before[i]["publishKey"] != after[i]["publishKey"] or
    before[i]["subscribeKey"] != after[i]["subscribeKey"])]
if missing: print("   MISSING:", missing)
if changed: print("   KEYS CHANGED:", changed)
if missing or changed: sys.exit(1)
print("   all %d apps restored, keys byte-identical" % len(before))
PY
    rm -f /tmp/pushpin-after.json
    echo
    echo "Restored. Existing client configs keep working."
    ;;

create)
    # For an instance with an empty registry — a fresh deploy that had no
    # backup to restore from. Creates only what is missing, matched on name,
    # so running it twice does not produce duplicate apps with new keys.
    echo "-> $HOST"
    api "$HOST/" > /dev/null && echo "   reachable"

    api "$HOST/admin/apps" > /tmp/pushpin-existing.json
    existing=$(python3 -c '
import json
print("\n".join(a["name"] for a in json.load(open("/tmp/pushpin-existing.json"))["apps"]))
')
    rm -f /tmp/pushpin-existing.json

    while IFS= read -r name; do
        [ -n "$name" ] || continue
        if printf '%s\n' "$existing" | grep -qxF "$name"; then
            echo "   exists, leaving alone: $name"
            continue
        fi
        echo "   creating: $name"
        api -X POST -H 'content-type: application/json' \
            --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1]}))' "$name")" \
            "$HOST/admin/apps" > /dev/null
    done <<'NAMES'
Anomaly Music - Develop
Anomaly Music - Production
Anomaly Social - Develop
Anomaly Social - Production
NAMES

    echo "-> backing up"
    api "$HOST/admin/export" > "$BACKUP.new"
    BACKUP_NEW="$BACKUP.new" python3 <<'PYEOF'
import json, os, sys
d = json.load(open(os.environ["BACKUP_NEW"]))
apps = d.get("apps") or []
if not d.get("ok") or not apps:
    print("   export came back empty - not writing a backup"); sys.exit(1)
print("   %d apps registered:" % len(apps))
for a in apps:
    print("     %s  %s" % (a["id"], a["name"]))
PYEOF
    mv "$BACKUP.new" "$BACKUP"
    echo
    echo "Keys are in apps-backup.json. Keep it - it is what restore needs"
    echo "after the next deploy, and it is the only copy."
    ;;

*)
    echo "usage: $0 {preflight|create|restore}" >&2
    exit 2
    ;;
esac
