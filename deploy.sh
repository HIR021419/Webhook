#!/usr/bin/env bash
# Script de déploiement générique, appelé par webhook.js avec 3 arguments :
#   $1 = SITE_DIR    chemin du repo à mettre à jour
#   $2 = BRANCH      branche à déployer (ex: main)
#   $3 = DEPLOY_CMD  commande à lancer une fois le code à jour
#
# Un lock par SITE_DIR empêche deux déploiements concurrents du même
# projet ; deux projets différents peuvent en revanche déployer en
# parallèle sans se bloquer.
set -euo pipefail

SITE_DIR="$1"
BRANCH="$2"
DEPLOY_CMD="$3"

LOCK_ID=$(echo -n "$SITE_DIR" | md5sum | cut -d' ' -f1)
LOCK_FILE="/tmp/deploy-webhook-${LOCK_ID}.lock"

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[$(date -Iseconds)] Un déploiement de $SITE_DIR est déjà en cours, celui-ci est ignoré."
  exit 0
fi

echo "[$(date -Iseconds)] Début du déploiement de $SITE_DIR (branche $BRANCH)"

cd "$SITE_DIR"

# reset --hard plutôt que pull : le serveur ne doit jamais avoir de
# modifications locales à merger, on veut toujours refléter la branche
# distante exactement.
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "[$(date -Iseconds)] Exécution : $DEPLOY_CMD"
eval "$DEPLOY_CMD"

echo "[$(date -Iseconds)] Déploiement terminé (commit $(git rev-parse --short HEAD))"
