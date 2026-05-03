#!/bin/bash
##
## Usage
# generate usage:
# ./delete_excessive_woofs.sh [dry-run|delete]
#

set -e

MODE=${1:-dry-run}
DOG_SLUG=${DOG_SLUG:-sheldon}
PREFIX="hey-${DOG_SLUG}"

if [[ "$MODE" == "dry-run" ]]; then
	echo "[🔍] Dry run: listing messages with more than 16 'Woof!'s"
	docker exec "${PREFIX}-backend" sh -c "
sqlite3 /app/backend/data/hey.db <<'EOF'
.headers on
.mode column
SELECT COUNT(*) AS to_be_deleted
FROM messages
WHERE (length(text) - length(replace(text, 'Woof!', ''))) / length('Woof!') > 16;

SELECT id, text, create_time
FROM messages
WHERE (length(text) - length(replace(text, 'Woof!', ''))) / length('Woof!') > 16
ORDER BY create_time DESC;
EOF
"
else
	echo "[⚠️] Deleting messages with more than 16 'Woof!'s..."
	COUNT=$(docker exec "${PREFIX}-backend" sh -c "
sqlite3 /app/backend/data/hey.db <<'EOF'
SELECT COUNT(*) FROM messages
WHERE (length(text) - length(replace(text, 'Woof!', ''))) / length('Woof!') > 16;
EOF
" | tail -n1)

	docker exec "${PREFIX}-backend" sh -c "
sqlite3 /app/backend/data/hey.db <<'EOF'
DELETE FROM messages
WHERE (length(text) - length(replace(text, 'Woof!', ''))) / length('Woof!') > 16;
EOF
"

	echo "[✔] Deleted $COUNT message(s) with excessive 'Woof!'s"
fi
