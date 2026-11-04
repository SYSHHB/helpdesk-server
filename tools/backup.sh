#!/bin/sh
# Makes one compressed copy of all helpdesk data. Run it on the server, for example every night with cron:
#   0 2 * * * /root/backup.sh
# Change VOLUME to the name of the volume you created in Coolify (see: docker volume ls).
VOLUME=helpdesk-data
DEST=/root/helpdesk-backups
mkdir -p "$DEST"
docker run --rm -v "$VOLUME":/data:ro -v "$DEST":/backup alpine \
  tar czf "/backup/helpdesk-$(date +%F).tgz" -C /data .
# keep the last 30 copies
ls -1t "$DEST"/helpdesk-*.tgz | tail -n +31 | xargs -r rm --
echo "Backup written to $DEST. Copy it to another place too (another computer or OneDrive)."
