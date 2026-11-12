# warapp-api helper — source me (bash or zsh), then pipe into jq:
#
#   source <skill>/scripts/warapp.sh
#   warapp_game 45670418 | jq '{name, state}'
#   warapp_map 45670418 | jq '.bonuses | length'
#
# Every call is POST https://war.app/API/GameFeed?GameID=<n> with the form body
# Email=<email>&APIToken=<token>. Credentials come from WARAPP_EMAIL /
# WARAPP_API_TOKEN, else from the dotenv file WARAPP_ENV_FILE (default
# ~/.config/warapp-mcp/.env — the same file warapp-mcp reads). The environment
# wins over the file. The file is parsed, never sourced, and the credentials
# live only in function-local variables: they are never exported, never put
# on curl's command line (the body goes in on stdin) and never printed — an
# upstream error has both scrubbed before it reaches stderr.
#
# Return codes: 0 ok · 1 usage (bad game id) · 2 no credentials ·
# 3 Auth failed (wrong email/token) · 4 no such game · 5 anything else
# (network, HTTP error, non-JSON answer, other GameFeed error).
#
# war.app answers errors as HTTP 200 {"termsOfUse": …, "error": …}; these
# functions turn that into the codes above, so a 0 means a real game body.
#
# Variable names avoid `path` and `status` (special in zsh).

# _warapp_gameid <id>: a positive whole number below 2^31.
_warapp_gameid() {
  case "${1:-}" in
    '' | *[!0-9]* | 0*)
      echo "warapp: game id must be a positive whole number, got '${1:-}'" >&2
      return 1
      ;;
  esac
  if [ "${#1}" -gt 10 ] || [ "$1" -gt 2147483647 ]; then
    echo "warapp: game id must be below 2^31, got '$1'" >&2
    return 1
  fi
}

# _warapp_load: fill the CALLER's local _warapp_email/_warapp_token.
_warapp_load() {
  local file line key val
  _warapp_email="${WARAPP_EMAIL:-}"
  _warapp_token="${WARAPP_API_TOKEN:-}"
  file="${WARAPP_ENV_FILE:-$HOME/.config/warapp-mcp/.env}"
  if [ -r "$file" ] && [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      line="${line#export }"
      case "$line" in *=*) ;; *) continue ;; esac
      key="${line%%=*}"
      val="${line#*=}"
      case "$val" in
        \"*\") val="${val#\"}"; val="${val%\"}" ;;
        \'*\') val="${val#\'}"; val="${val%\'}" ;;
      esac
      case "$key" in
        WARAPP_EMAIL) [ -n "$_warapp_email" ] || _warapp_email="$val" ;;
        WARAPP_API_TOKEN) [ -n "$_warapp_token" ] || _warapp_token="$val" ;;
      esac
    done <"$file"
  fi
  if [ -z "$_warapp_email" ] || [ -z "$_warapp_token" ]; then
    echo "warapp: set WARAPP_EMAIL and WARAPP_API_TOKEN (or put them in $file)." >&2
    echo "warapp: the token is shown at https://war.app/API/GetAPIToken while signed in." >&2
    return 2
  fi
}

# _warapp_uri: URL-encode stdin (kept off argv).
_warapp_uri() {
  jq -sRr @uri
}

# warapp_feed <game-id> [Param=value …]: the raw GameFeed body for one game.
# Extra arguments are appended to the query, e.g. GetSettings=true GetMap=false
# GetHistory=true GetChat=true.
warapp_feed() {
  local game="${1:-}" query='' arg body rc err _warapp_email _warapp_token
  _warapp_gameid "$game" || return 1
  shift
  for arg in "$@"; do
    query="$query&$arg"
  done
  _warapp_load || return 2
  body="$(
    printf 'Email=%s&APIToken=%s' \
      "$(printf '%s' "$_warapp_email" | _warapp_uri)" \
      "$(printf '%s' "$_warapp_token" | _warapp_uri)" |
      curl -sS --fail-with-body --max-time 30 --retry 1 \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-binary @- \
        "${WARAPP_BASE_URL:-https://war.app}/API/GameFeed?GameID=$game$query"
  )"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "warapp: request to war.app failed (curl exit $rc)" >&2
    return 5
  fi
  if ! printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "warapp: war.app answered with something that is not JSON" >&2
    return 5
  fi
  err="$(printf '%s' "$body" | jq -r '.error // empty | tostring')"
  case "$err" in
    '') ;;
    'Auth failed')
      echo "warapp: Auth failed — wrong email or API token. Get the current token at https://war.app/API/GetAPIToken while signed in (changing the password rotates it)." >&2
      return 3
      ;;
    *ServerGameKeyNotFound*)
      echo "warapp: no game $game (or it is not visible to you)" >&2
      return 4
      ;;
    *)
      err="${err//"$_warapp_token"/[redacted]}"
      err="${err//"$_warapp_email"/[redacted]}"
      echo "warapp: war.app error: $err" >&2
      return 5
      ;;
  esac
  printf '%s\n' "$body"
}

# warapp_game <game-id> [Param=value …]: game, players and settings, without the
# map (GetSettings=true GetMap=false). Use warapp_map for the map.
warapp_game() {
  local game="${1:-}"
  _warapp_gameid "$game" || return 1
  shift
  warapp_feed "$game" GetSettings=true GetMap=false "$@"
}

# warapp_map <game-id>: the game's map object. Maps never change for a map id,
# and war.app asks callers to cache, so it is kept in WARAPP_CACHE_DIR
# (default ~/.cache/warapp-mcp) and fetched once per game.
warapp_map() {
  local game="${1:-}" dir mapid out rc
  _warapp_gameid "$game" || return 1
  dir="${WARAPP_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/warapp-mcp}"
  if [ -r "$dir/game-$game.map" ]; then
    mapid="$(cat "$dir/game-$game.map")"
    case "$mapid" in
      '' | *[!0-9]*) ;;
      *)
        if [ -r "$dir/map-$mapid.json" ]; then
          cat "$dir/map-$mapid.json"
          return 0
        fi
        ;;
    esac
  fi
  out="$(warapp_feed "$game")"
  rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  mapid="$(printf '%s' "$out" | jq -r '.map.id // empty | tostring')"
  case "$mapid" in
    '' | *[!0-9]*)
      echo "warapp: the response for game $game carries no usable map id" >&2
      return 5
      ;;
  esac
  mkdir -p "$dir" &&
    printf '%s' "$out" | jq '.map' >"$dir/map-$mapid.json.tmp" &&
    mv "$dir/map-$mapid.json.tmp" "$dir/map-$mapid.json" &&
    printf '%s\n' "$mapid" >"$dir/game-$game.map"
  printf '%s' "$out" | jq '.map'
}
