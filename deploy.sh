#!/bin/bash

set -e

NO_CACHE=()
for arg in "$@"; do
	case "$arg" in
	--no-cache) NO_CACHE=(--no-cache) ;;
	-h | --help)
		echo "Usage: $0 [--no-cache]"
		echo "  --no-cache  Pass through to docker compose build (no build cache)"
		exit 0
		;;
	*)
		echo "Unknown option: $arg" >&2
		echo "Usage: $0 [--no-cache]" >&2
		exit 1
		;;
	esac
done

if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

if [[ -z "${PRIMARY_DOMAIN:-}" ]]; then
	echo "PRIMARY_DOMAIN is not set in .env"
	exit 1
fi

if [[ -z "${DOG_SLUG:-}" ]]; then
	echo "DOG_SLUG is not set in .env"
	exit 1
fi

TAG=$(date +"%d%b%y_%H%M%S")
PREFIX="hey-${DOG_SLUG}"
export TAG=$TAG
echo -e "🛑 Stopping old containers..."
docker compose down --remove-orphans

echo -e "\n🏗 Building containers..."
docker compose build "${NO_CACHE[@]}"

echo -e "\n🏷️ Tagging ${PREFIX}-backend image with tag $TAG..."
docker tag "${PREFIX}-backend:latest" "${PREFIX}-backend:$TAG"
docker tag "${PREFIX}-frontend:latest" "${PREFIX}-frontend:$TAG"

echo -e "\n🚀 Starting containers..."
docker compose up -d

echo -e "\n📜 Showing live logs..."
docker compose logs -f
