# Boatbattle

Bataille navale aux lasers et miroirs, à deux, de téléphone à téléphone.
Application web installable (PWA), pensée pour le téléphone en mode portrait. Elle n'a ni compte ni serveur et fonctionne hors ligne une fois chargée.

## Lancer en local

Il faut [Node.js](https://nodejs.org) 22.12 ou plus.

```bash
npm ci             # installe exactement les versions du package-lock.json
npm run dev        # serveur de développement : http://localhost:5173
npm test           # tests : moteur, grands triangles, jeux de pièces, session, protocole, codes de connexion
npm run build      # version de production dans le dossier dist/
npm run preview    # sert la version de production en local
```

Pour tester seul, l'accueil propose deux modes sur un seul appareil :
- **Se passer le téléphone** : deux joueurs, avec un écran de passage entre chaque tour.
- **S'entraîner contre un robot** : le robot place ses pièces et tire au hasard.

Sur un téléphone, `http://192.168.x.x:5173` affiche bien l'app, mais sans HTTPS le navigateur bloque la caméra, le partage, l'installation et le hors-ligne. Pour un vrai test sur téléphone, mettez l'app en ligne (ci-dessous), c'est gratuit.

> **Bureau synchronisé avec iCloud** : si le projet est dans un dossier synchronisé (Bureau ou Documents sur Mac), iCloud peut créer des doublons « fichier 2.js » dans `node_modules`, ce qui provoque des erreurs étranges. En cas de doute : `rm -rf node_modules && npm ci`. Mieux encore : déplacez le projet hors du dossier synchronisé.

## Héberger gratuitement

L'app est un simple dossier de fichiers statiques (`dist/`). Les chemins sont relatifs : elle marche à la racine d'un domaine comme dans un sous-dossier.

**GitHub Pages**
1. Créez un dépôt GitHub et poussez ce dossier sur la branche `main`.
2. Dans le dépôt : *Settings > Pages > Source : GitHub Actions*.
3. Le fichier `.github/workflows/deploy.yml` lance les tests, construit et publie à chaque push. L'adresse ressemble à `https://votre-pseudo.github.io/boatbattle/`.

**Cloudflare Pages**
Créez un projet relié au dépôt, avec la commande de build `npm run build` et le dossier de sortie `dist`.

**Mises à jour** : quand une nouvelle version est publiée, l'app la télécharge en arrière-plan puis affiche « Nouvelle version prête – Recharger ». Les deux téléphones doivent avoir la même version pour jouer ensemble. Sinon l'app le signale à la connexion, car règles, couleurs ou protocole peuvent différer.

## Installer sur le téléphone

Ouvrez l'adresse publiée, puis :
- **iPhone (Safari)** : bouton Partager, puis *Sur l'écran d'accueil*.
- **Android (Chrome)** : menu ⋮, puis *Installer l'application* (ou *Ajouter à l'écran d'accueil*).

L'app s'ouvre alors en plein écran. Après une première ouverture, elle marche hors ligne. Pour jouer à deux téléphones, il faut quand même un réseau (wifi ou données mobiles).

## Connecter deux téléphones

1. Téléphone A : **Créer une partie**. Un QR code et un code texte s'affichent. La partie utilise le jeu de pièces choisi dans les Réglages.
2. Téléphone B : **Rejoindre une partie**, puis **Scanner** le QR avec le bouton de l'app (ou **Coller** le message reçu).
3. Téléphone B affiche à son tour un **code de réponse** (QR + texte). Téléphone A le scanne ou le colle.
4. La connexion s'établit. Téléphone B voit le jeu de pièces proposé et l'**accepte** (ou le refuse ; A peut alors en proposer un autre). Chacun place ses pièces et appuie sur **Prêt**. Le premier joueur est tiré au sort.

À savoir :
- **Lien d'invitation sur iPhone** : un lien ou un QR ouvert depuis Messages ou l'appareil photo s'ouvre dans **Safari**, pas dans l'app installée sur l'écran d'accueil (qui a sa propre mémoire). On peut jouer dans Safari. Pour jouer dans l'app installée, ouvrez-la et utilisez **Scanner** ou **Coller**.
- **Même wifi** : fonctionne dans la plupart des cas.
- **À distance** : les téléphones se parlent directement (WebRTC). Les serveurs STUN publics de Google et Cloudflare servent seulement à trouver l'adresse de chacun, et aucune donnée de jeu n'y passe. Il n'y a **pas de serveur relais (TURN)** : certains réseaux mobiles 4G/5G ou d'entreprise empêchent la connexion directe, et ça peut alors échouer. Essayez le wifi d'un côté, ou ajoutez un relais dans `src/config/network.ts`.
- **Secret** : votre placement ne quitte jamais votre téléphone. L'autre reçoit seulement les résultats publics des tirs.
- **Coupure** (écran verrouillé, app quittée, réseau coupé) : la partie est sauvegardée sur chaque téléphone. Touchez **Reconnecter** : l'un crée un code, l'autre le lit, et le jeu reprend où il en était. Chaque téléphone revérifie le journal reçu ; un coup joué contre lui est toujours recalculé sur son propre plateau.

## Pièces, formes et jeux (Réglages)

- **Jeux de pièces** : *Classique* (les 12 pièces de la version papier) et *Triangles* (miroirs de côté 1 à 4) sont prédéfinis. Vous pouvez les dupliquer, puis modifier la copie : ajouter une forme, choisir sa couleur et son nombre d'exemplaires. Vous pouvez aussi créer, renommer ou supprimer vos propres jeux. L'app vérifie que le jeu tient sur la grille : 24 pièces et 50 cases au plus.
- **Éditeur de formes** : dessinez sur une petite grille de 5 × 5 avec des cases pleines et des demi-cases en diagonale (4 orientations). La forme doit être d'un seul tenant : les cases se touchent par un côté plein. Elle compte 12 cases au plus. Un aperçu montre les 4 rotations. Les côtés pleins arrêtent le laser et les diagonales le dévient.
- **Grands triangles** : un triangle de côté n occupe n cases le long de chaque côté de l'angle droit. Les cases de la diagonale sont des demi-cases (miroirs), les autres sont pleines.
- Tout est enregistré **sur ce téléphone**. Le jeu de la partie est envoyé à l'autre téléphone au moment de la connexion.

## Où modifier les règles et les données

| Quoi | Fichier |
|---|---|
| Palette de couleurs, formes prédéfinies, jeux *Classique* et *Triangles* | `src/config/pieces.ts` |
| Règles réglables : annonce des miroirs, pièce annoncée une fois par tir, pièces coulées retirées, orientation exigée pour couler, pièces qui se touchent, **tour après une déclaration juste** | `src/config/rules.ts` |
| Serveurs STUN/TURN, délais réseau | `src/config/network.ts` |
| Moteur du laser (pur, documenté) | `src/engine/laser.ts` |
| Formes, jeux, validation | `src/engine/pieces.ts` |
| Vérification d'une déclaration « pièce coulée » | `src/engine/claim.ts` |
| Ordre des tours | `src/engine/turns.ts` |

Après une modification, lancez `npm test`. Les tests décrivent les règles actuelles : adaptez-les si vous changez une règle. Changer une règle ou la palette change l'**empreinte de version** : les deux téléphones doivent avoir la même version de l'app.

## Organisation du code

- `src/engine/` : moteur pur (géométrie, formes, placement, laser, déclarations, tours) et ses tests. Les grands triangles sont comparés à un lancer de rayon géométrique indépendant.
- `src/game/` : session d'un joueur (protocole validé, sauvegarde, resynchronisation, jeu proposé et accepté), robot.
- `src/net/` : WebRTC, codes de connexion compacts, QR codes (génération et lecture).
- `src/ui/` : écrans, rendu SVG « papier », Réglages et éditeur de formes (sans framework).
- `scripts/make-icons.mjs` : génère les icônes (`npm run icons`).
