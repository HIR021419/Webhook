# Webhook

Service de déploiement automatique générique : reçoit les webhooks push
GitHub et redéploie le projet concerné. Un seul service, un seul port,
réutilisable pour tous tes projets — chacun a son propre secret et sa
propre config, ajoutée sans toucher au code.

Tourne en dehors de Docker/du repo de chaque projet, en tant que service
systemd indépendant sur le VPS.

## Comment ça marche

- Chaque projet a une entrée dans `projects.json` : `slug` (utilisé dans
  l'URL), `secretEnv` (nom de la variable d'env qui contient son secret),
  `siteDir` (où le repo est cloné sur le VPS), `branch`, `deployCmd`
  (commande lancée une fois le code à jour).
- URL du webhook pour un projet : `http://<VPS>:<PORT>/webhook/<slug>`
- `projects.json` et `.env` ne sont pas versionnés (secrets + chemins
  propres au VPS) — seul `projects.example.json` sert de modèle.

## Mise en place sur le VPS

### 1. Clé SSH personnelle (pour les clones manuels)

Sur un VPS neuf, `git clone git@github.com:...` échoue avec
`Permission denied (publickey)` tant qu'aucune clé n'est connue de
GitHub. Générer une clé avec l'utilisateur de ta session (`ubuntu` ou
équivalent — **jamais avec `sudo`/`root`**, `sudo` n'a pas accès à ton
agent SSH) :

```bash
ssh-keygen -t ed25519 -C "toi@example.com"
```

Ajouter la clé publique (`cat ~/.ssh/id_ed25519.pub`) sur GitHub : soit
en Deploy Key sur le repo à cloner, soit comme clé de ton compte.
Vérifier :

```bash
ssh -T git@github.com   # sans sudo
```

Cette clé ne sert qu'aux actions manuelles (clone initial). Les
déploiements automatiques utilisent une clé séparée, propre à
l'utilisateur `deploy` (étape 3).

### 2. Utilisateur dédié

```bash
sudo useradd -r -m -d /opt/deploy-webhook -s /usr/sbin/nologin deploy
sudo usermod -aG docker deploy   # si les deployCmd utilisent docker
```

⚠️ Le `-d /opt/deploy-webhook` fait de ce dossier le `$HOME` de
`deploy`. Toute clé SSH pour cet utilisateur doit donc vivre dans
`/opt/deploy-webhook/.ssh/` — **pas** `/home/deploy/.ssh/`, qui n'est
pas son vrai home et sera ignoré par SSH.

### 3. Ce repo

```bash
git clone git@github.com:<toi>/Webhook.git ~/deploy-webhook   # avec la clé de l'étape 1, sans sudo
sudo rsync -a ~/deploy-webhook/ /opt/deploy-webhook/
cd /opt/deploy-webhook
sudo npm install --omit=dev
sudo cp .env.example .env
sudo cp projects.example.json projects.json
```

Éditer `projects.json` pour lister tes projets, puis `.env` pour donner
à chacun son secret (`openssl rand -hex 32`).

```bash
sudo chown -R deploy:deploy /opt/deploy-webhook
```

Génère ensuite la clé dédiée à `deploy`, dans son vrai home
(`/opt/deploy-webhook`, pas `/home/deploy`) :

```bash
sudo -u deploy ssh-keygen -t ed25519 -C "vps-deploy-webhook" -f /opt/deploy-webhook/.ssh/id_ed25519 -N ""
sudo cat /opt/deploy-webhook/.ssh/id_ed25519.pub
```

C'est cette clé (pas celle de l'étape 1) qu'il faut ajouter en Deploy
Key sur chaque repo que `deploy` doit `git fetch` automatiquement —
chaque projet listé dans `projects.json`, et ce repo Webhook lui-même
si tu veux que `deploy` puisse le mettre à jour. Vérifier :

```bash
sudo -u deploy ssh -T git@github.com
```

### 4. Service systemd

```bash
sudo cp deploy-webhook.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deploy-webhook
sudo systemctl status deploy-webhook
```

Vérifier que ça écoute :

```bash
curl http://localhost:9000/health   # doit répondre "ok"
```

### 5. Pare-feu

```bash
sudo ufw allow 9000/tcp
```

### 6. Configurer le webhook côté GitHub (pour chaque projet)

Repo du projet → Settings → Webhooks → Add webhook :

- Payload URL : `http://<IP_VPS>:9000/webhook/<slug>` (le `slug` défini
  dans `projects.json` pour ce projet)
- Content type : `application/json`
- Secret : la valeur mise dans `.env` sous le nom `secretEnv` du projet
- Events : "Just the push event"

GitHub envoie un `ping` immédiatement après la création — la réponse
`pong` (HTTP 200) confirme que tout est branché.

## Ajouter un nouveau projet

1. Cloner le repo du projet en tant que `ubuntu` (pas `root` — voir
   pourquoi plus bas), dans un dossier où `ubuntu` a le droit d'écrire :
   `git clone git@github.com:<toi>/<projet>.git ~/<projet>`
2. Le déplacer vers son emplacement final et **le donner à `deploy`** :
   ```bash
   sudo mv ~/<projet> /opt/<projet>
   sudo chown -R deploy:deploy /opt/<projet>
   ```
   Indispensable : le service tourne sous l'utilisateur `deploy`
   (`User=deploy` dans `deploy-webhook.service`), donc `deploy.sh` fait
   ses `git fetch`/`git reset --hard` en tant que `deploy`. Si le dossier
   appartient à `root`, ces commandes échouent sans sudo — et on ne veut
   surtout pas donner sudo à `deploy` (ça viderait l'intérêt d'avoir un
   utilisateur dédié restreint).
3. Ajouter la clé publique de `deploy`
   (`sudo cat /opt/deploy-webhook/.ssh/id_ed25519.pub` — son vrai home,
   pas `/home/deploy`) comme Deploy Key sur ce repo GitHub — c'est elle
   qui sert aux `git fetch` automatiques, pas la clé personnelle
   utilisée pour le clone manuel à l'étape 1.
4. Ajouter une entrée dans `projects.json` (nouveau `slug`, `siteDir`
   pointant vers `/opt/<projet>`).
5. Ajouter le secret correspondant dans `.env`.
6. Ajouter le dossier à `ReadWritePaths` dans
   `/etc/systemd/system/deploy-webhook.service`, puis
   `sudo systemctl daemon-reload && sudo systemctl restart deploy-webhook`.
7. Créer le webhook côté GitHub avec l'URL `/webhook/<nouveau-slug>`.

`projects.json` est relu à chaque requête — pas besoin de redémarrer le
service pour lui seul, seulement si `ReadWritePaths` change (étape 6).

## Logs

```bash
tail -f /opt/deploy-webhook/logs/<slug>.log   # logs de déploiement d'un projet
sudo journalctl -u deploy-webhook -f          # logs du service
```

## Test manuel d'un déploiement

```bash
sudo -u deploy bash deploy.sh /opt/mon-projet main "docker compose up --build -d"
```
