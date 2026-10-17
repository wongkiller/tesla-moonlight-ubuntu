#!/bin/bash
# VM DNS fake-IP hijacks plain DNS (even to 1.1.1.1) -> 198.18.x for Cloudflare edges and most
# public names. The fake-IP proxy only relays TCP/443, so cloudflared edges AND the WebRTC
# TURN/STUN hosts (UDP/3478, TCP/3478, TCP/80) break when resolved through it.
# Resolve via DoH (HTTPS to 1.1.1.1) and pin fresh IPs in /etc/hosts. Idempotent / safe to re-run:
# only lines for the names below are replaced; if DoH fails for a name, its previous pins are kept,
# else a static fallback is written.
# 2026-10-17: added TURN/STUN/Realtime hosts (server-side TURN allocation failed -> WebRTC stuck
# at "WebRTC Peer Negotiation", streamer log "Failed to allocate on turn.Client turn.cloudflare.com:3478").
set -u
HOSTS=${PIN_HOSTS_FILE:-/etc/hosts}
names="region1.v2.argotunnel.com region2.v2.argotunnel.com api.cloudflare.com \
turn.cloudflare.com stun.cloudflare.com rtc.live.cloudflare.com \
stun.l.google.com stun1.l.google.com stun2.l.google.com stun3.l.google.com stun4.l.google.com"

static_for() {  # last-known-good IPs (2026-10-17 DoH); refreshed by DoH on every run
  case "$1" in
    region1.v2.argotunnel.com) echo 198.41.192.47 ;;
    region2.v2.argotunnel.com) echo 198.41.200.233 ;;
    api.cloudflare.com) echo 104.19.192.174 ;;
    turn.cloudflare.com) echo 141.101.90.1 ;;
    stun.cloudflare.com) echo 162.159.207.0 ;;
    rtc.live.cloudflare.com) echo "104.18.12.207 104.18.13.207" ;;
    stun*.l.google.com) echo 74.125.250.129 ;;
  esac
}
# exact-name match on the hostname column(s) of a hosts line
has_name() { awk -v n="$1" '{for(i=2;i<=NF;i++) if($i==n){f=1}} END{exit !f}' <<<"$2"; }

if ! command -v curl >/dev/null || ! command -v python3 >/dev/null; then
  # fresh image before install.sh: static fallback for names not pinned yet
  for n in $names; do
    grep -qE "[[:space:]]${n//./\\.}([[:space:]]|$)" "$HOSTS" || for ip in $(static_for "$n"); do echo "$ip $n" >> "$HOSTS"; done
  done
  echo "pin-cf-edges: static fallback (no curl/python3 yet)"; exit 0
fi

orig=$(cat "$HOSTS")
tmp=$(mktemp)
# keep every line that does not name one of our hosts
while IFS= read -r line; do
  keep=1
  case "$line" in \#*|"") ;; *) for n in $names; do has_name "$n" "$line" && { keep=0; break; }; done ;; esac
  [ $keep = 1 ] && printf '%s\n' "$line" >> "$tmp"
done <<<"$orig"

for n in $names; do
  ips=$(curl -s --max-time 8 -H 'accept: application/dns-json' "https://1.1.1.1/dns-query?name=$n&type=A" \
    | python3 -c 'import sys,json;print(" ".join(a["data"] for a in json.load(sys.stdin).get("Answer",[]) if a.get("type")==1 and not a["data"].startswith("198.18.")))' 2>/dev/null)
  if [ -n "$ips" ]; then
    for ip in $ips; do echo "$ip $n" >> "$tmp"; done
  else
    prev=$(while IFS= read -r line; do case "$line" in \#*|"") ;; *) has_name "$n" "$line" && awk '{print $1}' <<<"$line";; esac; done <<<"$orig" | grep -v '^198\.18\.')
    src=prev; [ -n "$prev" ] || { prev=$(static_for "$n"); src=static; }
    for ip in $prev; do echo "$ip $n" >> "$tmp"; done
    echo "pin-cf-edges: WARN no DoH answer for $n, kept $src pins" >&2
  fi
done
cat "$tmp" > "$HOSTS"; rm -f "$tmp"   # in-place write (bind-mounted /etc/hosts can't be renamed over)
cnt=0; for n in $names; do cnt=$((cnt + $(awk -v n="$n" '$1!~/^#/{for(i=2;i<=NF;i++) if($i==n) c++} END{print c+0}' "$HOSTS"))); done
echo "pin-cf-edges: $cnt pins ($(echo $names | wc -w) names)"
