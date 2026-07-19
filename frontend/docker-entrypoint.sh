#!/bin/sh
set -e

# Wipe default configs so only the chosen profile is loaded
rm -f /etc/nginx/conf.d/*.conf

# Must match React build PUBLIC_URL (same path the static files live under in /usr/share/nginx/html)
PUBLIC_URL="${PUBLIC_URL:-/hey-x-${DOG_SLUG}}"
PUBLIC_URL="${PUBLIC_URL%/}"
# Trimming "/" leaves empty → site root
[ -z "$PUBLIC_URL" ] && PUBLIC_URL="/"

write_app_dynamic_conf() {
	mkdir -p /etc/nginx/snippets
	if [ "$PUBLIC_URL" = "/" ]; then
		cp /etc/nginx/templates/app-locations-root.conf.template /etc/nginx/snippets/app-dynamic.conf
	else
		sed "s|%%PUBLIC_URL%%|${PUBLIC_URL}|g" /etc/nginx/templates/app-locations-prefix.conf.template \
			>/etc/nginx/snippets/app-dynamic.conf
	fi
}

write_app_dynamic_conf

PRIMARY_DOMAIN="${PRIMARY_DOMAIN:-}"
TLS_CERTIFICATE_NAME="${TLS_CERTIFICATE_NAME:-$PRIMARY_DOMAIN}"

PRIMARY_CERT=""
if [ -n "$TLS_CERTIFICATE_NAME" ]; then
	PRIMARY_CERT="/etc/letsencrypt/live/${TLS_CERTIFICATE_NAME}/fullchain.pem"
fi

substitute_ssl_template() {
	out="$1"
	cp /etc/nginx/templates/nginx-ssl.conf.template "$out"

	# 127.0.0.1 localhost: Docker healthchecks; keep them on the named vhost server so a
	# separate default_server block can return 444 for unknown Host (open-redirect hardening).
	SSL_SERVER_NAMES="${PRIMARY_DOMAIN} www.${PRIMARY_DOMAIN} 127.0.0.1 localhost"

	sed -i \
		-e "s|@PRIMARY_DOMAIN@|${PRIMARY_DOMAIN}|g" \
		-e "s|@TLS_CERTIFICATE_NAME@|${TLS_CERTIFICATE_NAME}|g" \
		-e "s|@SSL_SERVER_NAMES@|${SSL_SERVER_NAMES}|g" \
		"$out"
}

if [ -n "$PRIMARY_DOMAIN" ] && [ -f "$PRIMARY_CERT" ]; then
	echo "[entrypoint] SSL mode: primary certificate present"
	substitute_ssl_template /etc/nginx/conf.d/default.conf
else
	echo "[entrypoint] HTTP-only mode (set PRIMARY_DOMAIN + mount certs for HTTPS)"
	cp /etc/nginx/templates/nginx-http-only.conf /etc/nginx/conf.d/default.conf
fi

# Named volume copies image defaults: access.log/error.log symlinks → /dev/stdout|stderr.
# Then tail(1) inside exec blocks on that path; backend NGINX_LOG_PATH needs a real file.
ensure_real_logfile() {
	f="$1"
	if [ -L "$f" ] || [ ! -f "$f" ]; then
		rm -f "$f"
		touch "$f"
		chown nginx:nginx "$f"
	fi
}
ensure_real_logfile /var/log/nginx/access.log
ensure_real_logfile /var/log/nginx/error.log

if [ "${NGINX_ENTRYPOINT_TEST:-}" = 1 ]; then
	nginx -t
	exit $?
fi

exec nginx -g "daemon off;"
