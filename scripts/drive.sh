#!/bin/bash
# Pre-flight for a real GPS drive, then open the HTTPS tunnel.
#
# Real GPS and the microphone are secure-context-only, so a phone cannot use
# http://<laptop-ip>:3000 at all — an HTTPS tunnel over the dev server is how a
# real drive gets recorded. Everything the app needs (API, tiles, the voice
# WebSocket) is proxied through port 3000, so tunnelling that one port is enough.
#
#   ./scripts/drive.sh           # pre-flight, then open the tunnel
#   ./scripts/drive.sh --check   # pre-flight only, no tunnel, nothing published
#
# Ctrl-C stops the tunnel and releases the sleep block.
set -uo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f infra/docker-compose.yml --project-directory ."
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

http_ok() { curl -sf -o /dev/null --max-time 5 "$1"; }

bold "Pre-flight"

# --- backing services -------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  fail "Docker isn't running — start Docker Desktop, then re-run this."
  exit 1
fi

for svc in postgres valhalla martin; do
  if [ -n "$($COMPOSE ps -q "$svc" 2>/dev/null)" ] && \
     [ "$(docker inspect -f '{{.State.Running}}' "$($COMPOSE ps -q "$svc")" 2>/dev/null)" = "true" ]; then
    ok "$svc"
  else
    warn "$svc is down — starting it"
    $COMPOSE up -d "$svc" >/dev/null 2>&1
    sleep 3
  fi
done

# Valhalla answering /status matters more than the container being up: a failed
# tile build still leaves a running container that cannot route.
if http_ok http://127.0.0.1:8002/status; then ok "valhalla is routing"; else
  fail "valhalla is up but not answering /status — check: docker logs gloway-valhalla-1"
  exit 1
fi

# --- app processes ----------------------------------------------------------
# Deliberately not started here: these are dev servers you probably want in
# their own terminals with visible logs.
MISSING=0
if http_ok http://127.0.0.1:8000/docs; then ok "backend  :8000"; else
  fail "backend is down. Start it with:"
  echo "      poetry --directory backend run uvicorn api.main:app --port 8000"
  MISSING=1
fi
if http_ok http://127.0.0.1:3000; then
  # Check it's actually OUR app, not another project squatting the port.
  # macOS resolves `localhost` to ::1 first, so a second dev server bound to
  # IPv6 wins `localhost:3000` while Vite holds IPv4 — and the tunnel would
  # then publish somebody else's app to the internet. This has already
  # happened here once (a Next.js app on ::1). Hence 127.0.0.1 everywhere
  # above, and this guard.
  if curl -s --max-time 5 http://127.0.0.1:3000 | grep -q "Gloway"; then
    ok "frontend :3000"
  else
    fail "Something other than Gloway is answering on :3000."
    echo "      Find it with:  lsof -nP -iTCP:3000 -sTCP:LISTEN"
    echo "      Stop it (or stop Gloway's vite and restart it) before tunnelling —"
    echo "      otherwise this publishes the wrong app to the public internet."
    MISSING=1
  fi
  OTHER=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | wc -l | tr -d ' ')
  if [ "${OTHER:-1}" -gt 1 ]; then
    warn "More than one process is listening on :3000 (IPv4 + IPv6)."
    warn "This script uses 127.0.0.1 so it reaches Gloway, but plain"
    warn "'localhost:3000' in a browser may reach the other one."
  fi
else
  fail "frontend is down. Start it with:"
  echo "      npm --prefix frontend run dev"
  MISSING=1
fi
[ "$MISSING" = "1" ] && { echo; fail "Start the above, then re-run this script."; exit 1; }

# --- where you may drive ----------------------------------------------------
echo
bold "Region you can route in"
python3 -c "
import json, math
r = json.load(open('data/region.json')); b = r['bbox']
w = (b['east'] - b['west']) * 111.32 * math.cos(math.radians((b['south'] + b['north']) / 2))
h = (b['north'] - b['south']) * 110.54
print(f\"  {r['description']}\")
print(f\"  lat {b['south']} .. {b['north']}   lon {b['west']} .. {b['east']}   ({w:.1f} x {h:.1f} km)\")
"
cat <<'EOF'
  Start the trip while inside this box. Outside it the origin silently falls
  back to the map centre, and the drive records a start you weren't at.
EOF

# --- reminders that are easy to get wrong in the car -------------------------
echo
bold "Before you pull away"
cat <<'EOF'
  1. Open the https://… URL below on your phone (Safari/Chrome, not an in-app browser)
  2. Register an email via the gear — preferences need a user to persist to
  3. Check the toggle reads "Live GPS", not "Simulate"
  4. Tap Start drive and grant location permission WHILE PARKED
  5. Keep the screen awake and stay in the browser — a web page's GPS stops
     when the screen locks, and the drive dies with it
  6. Tap "Arrive" at the end: it flushes the last GPS batch before completing

  This tunnel is a public, unauthenticated entry point to your database.
  Treat the URL as a secret and Ctrl-C when you're done driving.
EOF

if [ "$CHECK_ONLY" = "1" ]; then
  echo
  bold "--check: pre-flight only. Nothing was published."
  exit 0
fi

echo
bold "Starting tunnel (Ctrl-C to stop)"
# caffeinate WRAPS the tunnel rather than running beside it, so the machine
# stays awake exactly as long as the tunnel lives and releases on exit — no
# stray process to remember to kill. A laptop that sleeps mid-drive takes the
# trip with it, since the tunnel forwards to this machine.
exec caffeinate -dimsu cloudflared tunnel --url http://127.0.0.1:3000
