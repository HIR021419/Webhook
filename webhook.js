require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 9000;
const PROJECTS_FILE = process.env.PROJECTS_FILE || path.join(__dirname, 'projects.json');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const DEPLOY_SCRIPT = path.join(__dirname, 'deploy.sh');

if (!fs.existsSync(PROJECTS_FILE)) {
  console.error(`Fichier de config introuvable : ${PROJECTS_FILE}`);
  console.error('Copier projects.example.json vers projects.json et l\'adapter.');
  process.exit(1);
}
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function loadProjects() {
  const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  const bySlug = {};
  for (const project of raw) {
    if (!project.slug || !project.secretEnv || !project.siteDir || !project.deployCmd) {
      throw new Error(`Config de projet invalide (slug/secretEnv/siteDir/deployCmd requis) : ${JSON.stringify(project)}`);
    }
    const secret = process.env[project.secretEnv];
    if (!secret) {
      throw new Error(`Variable d'env "${project.secretEnv}" manquante pour le projet "${project.slug}"`);
    }
    bySlug[project.slug] = { ...project, secret, branch: project.branch || 'main' };
  }
  return bySlug;
}

// Rechargé à chaque requête : ajouter un projet ne nécessite pas de
// redémarrer le service, juste d'éditer projects.json + .env.
app.post('/webhook/:slug', express.raw({ type: 'application/json', limit: '5mb' }), (req, res) => {
  let projects;
  try {
    projects = loadProjects();
  } catch (err) {
    console.error('Erreur de config:', err.message);
    return res.status(500).send('Erreur de configuration serveur');
  }

  const project = projects[req.params.slug];
  if (!project) {
    return res.status(404).send('Projet inconnu');
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.status(401).send('Signature manquante');
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', project.secret).update(req.body).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).send('Signature invalide');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Payload JSON invalide');
  }

  const event = req.headers['x-github-event'];

  // Permet de tester la config du webhook depuis l'UI GitHub ("Redeliver").
  if (event === 'ping') {
    return res.status(200).send('pong');
  }

  if (event !== 'push' || payload.ref !== `refs/heads/${project.branch}`) {
    return res.status(200).send(`Ignoré (pas un push sur ${project.branch})`);
  }

  // On répond tout de suite : GitHub attend une réponse sous 10s.
  res.status(200).send(`Déploiement de "${project.slug}" déclenché`);
  runDeploy(project, payload);
});

app.get('/health', (req, res) => res.status(200).send('ok'));

function runDeploy(project, payload) {
  const commit = payload.after ? payload.after.slice(0, 7) : '?';
  const pusher = payload.pusher && payload.pusher.name ? payload.pusher.name : 'inconnu';
  const logFile = path.join(LOG_DIR, `${project.slug}.log`);

  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] Push de ${pusher} (commit ${commit}) sur ${project.branch} — déploiement de "${project.slug}"\n`);

  const logFd = fs.openSync(logFile, 'a');
  const child = spawn('bash', [DEPLOY_SCRIPT, project.siteDir, project.branch, project.deployCmd], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Webhook de déploiement en écoute sur le port ${PORT}`);
});
