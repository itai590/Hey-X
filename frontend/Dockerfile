# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build

ARG TZ=${TZ}
ARG PUBLIC_URL=${PUBLIC_URL}
ARG PRIMARY_DOMAIN=${PRIMARY_DOMAIN}
ARG VITE_BACKEND_ORIGIN

WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

ENV PUBLIC_URL=${PUBLIC_URL}
ENV VITE_TZ=${TZ}
ENV VITE_PRIMARY_DOMAIN=${PRIMARY_DOMAIN}
ENV VITE_BACKEND_ORIGIN=$VITE_BACKEND_ORIGIN

RUN npm run build

FROM nginx:mainline-alpine-perl
ARG PUBLIC_URL=${PUBLIC_URL}

COPY nginx.conf /etc/nginx/nginx.conf

COPY --from=build /app/dist /tmp/build
RUN DEST="/usr/share/nginx/html${PUBLIC_URL}" && \
    mkdir -p "$DEST" && cp -a /tmp/build/. "$DEST/"

RUN mkdir -p /etc/nginx/templates /etc/nginx/snippets
COPY nginx-http-only.conf nginx-ssl.conf.template /etc/nginx/templates/
COPY nginx-snippets/app-locations-root.conf.template nginx-snippets/app-locations-prefix.conf.template /etc/nginx/templates/
COPY security-headers.conf nginx-snippets/health-location.conf /etc/nginx/snippets/
COPY docker-entrypoint.sh /custom-entrypoint.sh
RUN chmod +x /custom-entrypoint.sh
EXPOSE 80 443
ENTRYPOINT ["/custom-entrypoint.sh"]
