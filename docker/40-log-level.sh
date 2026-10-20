#!/bin/sh
# Applies LOG_LEVEL (debug | info | warn | error, default info) before nginx starts.
# Per-request access logs are only written at debug; the other levels set the
# minimum severity of the error log.

set -eu

level="$(printf '%s' "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
snippet=/etc/nginx/snippets/access_log.conf

case "$level" in
  debug) error_level=info;   access="access_log /var/log/nginx/access.log main;" ;;
  info)  error_level=notice; access="access_log off;" ;;
  warn)  error_level=warn;   access="access_log off;" ;;
  error) error_level=error;  access="access_log off;" ;;
  *)
    echo "$0: unknown LOG_LEVEL '$level', using info" >&2
    error_level=notice; access="access_log off;" ;;
esac

echo "$access" > "$snippet"
sed -i "s|^error_log .*|error_log /var/log/nginx/error.log $error_level;|" /etc/nginx/nginx.conf
echo "$0: LOG_LEVEL=$level (error_log $error_level, access log $([ "$level" = debug ] && echo on || echo off))"
