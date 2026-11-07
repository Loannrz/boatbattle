# Boatbattle

Bataille navale aux lasers et miroirs, de 2 à 4 joueurs, de téléphone à téléphone.
Application web installable (PWA), pensée pour le téléphone en mode portrait. Elle n'a ni compte ni serveur et fonctionne hors ligne une fois chargée.

## Lancer en local

Il faut [Node.js](https://nodejs.org) 22.12 ou plus.

```bash
npm ci             # installe exactement les versions du package-lock.json
npm run dev        # serveur de développement : http://localhost:5173
npm test           # tests : moteur, grands triangles, jeux de pièces, session, protocole, parties à 3-4, hub, codes de connexion
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

**Mises à jour** : quand une nouvelle version est publiée, l'app la télécharge en arrière-plan puis affiche « Nouvelle version prête – Recharger ». Tous les téléphones doivent avoir la même version pour jouer ensemble. Sinon l'app le signale à la connexion, car règles, couleurs ou protocole peuvent différer. Les sauvegardes d'une ancienne version (parties à deux d'avant le multijoueur) sont ignorées.

## Installer sur le téléphone

Ouvrez l'adresse publiée, puis :
- **iPhone (Safari)** : bouton Partager, puis *Sur l'écran d'accueil*.
- **Android (Chrome)** : menu ⋮, puis *Installer l'application* (ou *Ajouter à l'écran d'accueil*).

L'app s'ouvre alors en plein écran. Après une première ouverture, elle marche hors ligne. Pour jouer à plusieurs téléphones, il faut quand même un réseau (wifi ou données mobiles).

## Jouer à plusieurs (2 à 4 téléphones)

La connexion est **en étoile** : chaque invité ne se connecte qu'à l'**hôte** (le téléphone qui crée la partie), qui relaie les messages aux autres. À 3 ou 4, l'hôte doit donc rester connecté.

1. Hôte : **Créer une partie**. Un QR code et un code texte s'affichent : ce code est **pour un seul joueur**. La partie utilise le jeu de pièces et les réglages de sorts choisis dans les Réglages.
2. Invité : **Rejoindre une partie**, puis **Scanner** le QR avec le bouton de l'app (ou **Coller** le message reçu). Il affiche à son tour un **code de réponse** (QR + texte) que l'hôte scanne ou colle.
3. La connexion s'établit : l'hôte arrive dans le **salon**, avec la liste des joueurs connectés. **Inviter un joueur** refait un code pour le suivant (jusqu'à 3 invités). Un invité déconnecté peut être retiré du salon.
4. **Lancer la partie** (au moins 2 joueurs, tous connectés). Chaque invité voit le jeu de pièces proposé et l'**accepte** (ou le refuse ; l'hôte peut alors en proposer un autre). Chacun place ses pièces et appuie sur **Prêt**. Le premier joueur est tiré au sort.

À savoir :
- **Lien d'invitation sur iPhone** : un lien ou un QR ouvert depuis Messages ou l'appareil photo s'ouvre dans **Safari**, pas dans l'app installée sur l'écran d'accueil (qui a sa propre mémoire). On peut jouer dans Safari. Pour jouer dans l'app installée, ouvrez-la et utilisez **Scanner** ou **Coller**.
- **Même wifi** : fonctionne dans la plupart des cas.
- **À distance** : les téléphones se parlent directement (WebRTC). Les serveurs STUN publics de Google et Cloudflare servent seulement à trouver l'adresse de chacun, et aucune donnée de jeu n'y passe. Il n'y a **pas de serveur relais (TURN)** : certains réseaux mobiles 4G/5G ou d'entreprise empêchent la connexion directe, et ça peut alors échouer. Essayez le wifi d'un côté, ou ajoutez un relais dans `src/config/network.ts`.
- **Secret** : votre placement ne quitte jamais votre téléphone. Les autres reçoivent seulement les résultats publics, et chacun recalcule sur sa propre grille les coups qui le visent. **L'hôte est un relais de confiance** : les messages entre deux invités passent par lui, il peut lire les sorts privés qu'il relaie et c'est lui qui indique de qui vient chaque message. Le jeu est pensé pour des amis qui jouent ensemble, pas contre un hôte malveillant. Entre invités, un tour n'est accepté que de celui qui l'a calculé (la cible), et chaque place reçoit un jeton secret à l'arrivée, exigé à la reconnexion, pour que personne ne prenne la place d'un autre.
- **Coupure** (écran verrouillé, app quittée, réseau coupé) : la partie est sauvegardée sur chaque téléphone. L'hôte touche **Reconnecter** (ou « Code de reconnexion ») pour créer un code ; le joueur déconnecté le lit, et le jeu reprend où il en était. Chaque téléphone revérifie le journal reçu (bon joueur, bonne cible, cible encore en jeu) ; un coup joué contre lui est toujours recalculé sur son propre plateau. Un coup qui vise un joueur hors ligne attend son retour.
- **Revanche** : lancée par l'hôte, avec les mêmes joueurs. « Revanche en changeant les joueurs » rouvre le salon.
- **Limites connues** :
  - Il n'y a pas d'abandon ni de « forfait ». Si un joueur ne revient jamais, la partie reste bloquée dès que c'est son tour ou qu'un coup l'attend comme cible ; il faut alors lancer une nouvelle partie.
  - Une app modifiée pourrait, en tant que cible, inventer le résultat d'un coup sur sa propre grille (comme à deux : la cible est seule à connaître sa grille) ; les autres n'ont aucun moyen de le vérifier.
  - Une app modifiée pourrait tenter d'envoyer deux coups différents pour un même tour à deux cibles ; chacun ne garde que le premier tour reçu de sa cible, et les journaux peuvent alors diverger.
  - Dans de rares cas (coupure juste au moment où un joueur est éliminé), un tiers peut rester en attente d'un tour que seul l'éliminé peut lui fournir ; il reprend quand celui-ci se reconnecte.

## Règles à 3 ou 4 joueurs

- **Chacun pour soi.** À ton tour, tu choisis la grille d'un adversaire encore en jeu (onglet **Tirer** : toutes les grilles sont affichées avec les tirs de tout le monde ; toucher une grille l'agrandit) puis tu tires, déclares une pièce ou lances un sort sur elle.
- Les tours **tournent** entre les joueurs encore en jeu. Un joueur dont toutes les pièces sont coulées est **éliminé** : il ne joue plus, n'est plus ciblable, mais garde la vue sur la partie. Le **dernier à flot** gagne ; l'écran de fin donne le classement (ordre d'élimination).
- **Carnet** : un carnet par adversaire (tes tirs et tes notes seulement). **Mon plateau** : les tirs reçus, avec leur auteur.
- **Visibilité** : tirs et déclarations (et leurs résultats) sont vus de tous. Un sort visé sur quelqu'un n'est détaillé qu'au lanceur et à la cible ; les autres voient « sort privé sur X ». Les sorts qui changent la grille du lanceur (Tempête, Renfort, Résurrection), les tirs multiples et les sorts d'ordre des tours sont publics. Les sorts secrets du lanceur sur lui-même ne montrent que « sort secret ».
- Le mode **Se passer le téléphone** et le **robot** restent à deux joueurs.

## Sorts (Réglages > Sorts)

Un sort remplace le tir du tour (sauf Gel). Les sorts marqués **3+** n'existent que dans les parties à 3 ou 4 joueurs (ils ne sont jamais tirés à deux).

| Sort | Effet | Visibilité |
|---|---|---|
| Révélation, Loupe, Radar, Histogramme, Prisme, Sonar, Indice, Diagonale, Moitié, Périmètre, Centre, Détecteur | Information sur la grille du joueur visé | privé (lanceur + cible) |
| Espion, Vol de sort, Sabotage | Réserve de sorts du joueur visé (compte, vol, destruction) | privé |
| Silence | Le joueur visé ne peut pas lancer de sort à son prochain tour | privé |
| Double tir, Salve, Rafale | Plusieurs tirs en un tour sur le joueur visé | public (ce sont des tirs) |
| Gel | Ne prend pas ton tour : tu rejoues tout de suite, et le joueur visé saute son prochain tour (à deux : tu joues deux tours de suite) | public |
| Renfort | Ajoute une pièce à ta grille, où tu veux | public (sans la position) |
| Tempête | Mélange toute ta grille, pièces coulées comprises ; les carnets te concernant sont remis à zéro | public |
| Résurrection | Une de tes pièces coulées (au hasard) revient en jeu à un **emplacement libre tiré au hasard**, que personne ne connaît ; les autres voient quelle pièce revient | public (nouvelle position secrète) |
| Brume, Leurre, Mirage, Camouflage, Déménagement, Pivot, Pioche | Effets sur ta propre grille ou ta réserve | secret |
| **Saut** (3+) | Le joueur suivant saute son tour | public |
| **Double saut** (3+) | Les deux joueurs suivants sautent leur tour (à trois, tu rejoues) | public |
| **Inversion** (3+) | Inverse le sens de rotation des tours | public |
| **Relais** (3+) | Le joueur que tu désignes joue juste après toi ; la rotation reprend à partir de lui | public |
| **Diversion** (3+) | Le joueur suivant doit viser le joueur que tu désignes (s'il est encore en jeu et n'est pas le suivant lui-même ; un sort sur soi-même reste permis) | public |
| **Silence général** (3+) | Aucun adversaire ne peut lancer de sort à son prochain tour | public |

Quand il ne reste que deux joueurs en jeu dans une partie à 3-4 : Saut reste utilisable (tu rejoues) ; Double saut, Inversion, Relais et Diversion sont refusés (sort conservé) car ils n'auraient aucun effet. Un joueur déjà gelé ne peut pas être gelé une seconde fois (le sort est conservé). L'obligation de Diversion survit à un Gel : si le joueur suivant gèle quelqu'un puis rejoue, il doit toujours viser le joueur désigné.

## Pièces, formes et jeux (Réglages)

- **Jeux de pièces** : *Classique* (les 12 pièces de la version papier) et *Triangles* (miroirs de côté 1 à 4) sont prédéfinis. Vous pouvez les dupliquer, puis modifier la copie : ajouter une forme, choisir sa couleur et son nombre d'exemplaires. Vous pouvez aussi créer, renommer ou supprimer vos propres jeux. L'app vérifie que le jeu tient sur la grille : 24 pièces et 50 cases au plus.
- **Éditeur de formes** : dessinez sur une petite grille de 5 × 5 avec des cases pleines et des demi-cases en diagonale (4 orientations). La forme doit être d'un seul tenant : les cases se touchent par un côté plein. Elle compte 12 cases au plus. Un aperçu montre les 4 rotations. Les côtés pleins arrêtent le laser et les diagonales le dévient.
- **Grands triangles** : un triangle de côté n occupe n cases le long de chaque côté de l'angle droit. Les cases de la diagonale sont des demi-cases (miroirs), les autres sont pleines.
- Tout est enregistré **sur ce téléphone**. Le jeu de la partie est envoyé aux autres téléphones au moment de la connexion.

## Où modifier les règles et les données

| Quoi | Fichier |
|---|---|
| Palette de couleurs, formes prédéfinies, jeux *Classique* et *Triangles* | `src/config/pieces.ts` |
| Règles réglables : annonce des miroirs, pièce annoncée une fois par tir, pièces coulées retirées, orientation exigée pour couler, pièces qui se touchent, **tour après une déclaration juste** | `src/config/rules.ts` |
| Serveurs STUN/TURN, délais réseau | `src/config/network.ts` |
| Moteur du laser (pur, documenté) | `src/engine/laser.ts` |
| Formes, jeux, validation | `src/engine/pieces.ts` |
| Vérification d'une déclaration « pièce coulée » | `src/engine/claim.ts` |
| Ordre des tours à N joueurs, éliminations, sorts d'ordre (Gel, Saut, Relais…) | `src/engine/turns.ts` |
| Définition des sorts (visibilité, nombre de joueurs minimal) | `src/engine/spells.ts` |

Après une modification, lancez `npm test`. Les tests décrivent les règles actuelles : adaptez-les si vous changez une règle. Changer une règle ou la palette change l'**empreinte de version** : tous les téléphones doivent avoir la même version de l'app.

## Organisation du code

- `src/engine/` : moteur pur (géométrie, formes, placement, laser, déclarations, tours) et ses tests. Les grands triangles sont comparés à un lancer de rayon géométrique indépendant.
- `src/game/` : session d'un joueur (protocole validé, journal public/privé, salon, sauvegarde, resynchronisation, jeu proposé et accepté), transport (hub en mémoire pour les tests), robot.
- `src/net/` : WebRTC (lien brut), hub en étoile (`hub.ts` : l'hôte accueille les invités, attribue les places et relaie), codes de connexion compacts, QR codes (génération et lecture).
- `src/ui/` : écrans, rendu SVG « papier », Réglages et éditeur de formes (sans framework).
- `scripts/make-icons.mjs` : génère les icônes (`npm run icons`).
