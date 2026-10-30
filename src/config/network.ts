/**
 * Réglages réseau (WebRTC).
 *
 * Serveurs STUN publics et gratuits : ils servent uniquement à découvrir l'adresse
 * publique de chaque téléphone (aucune donnée de jeu n'y transite).
 *
 * TURN (relais) : non configuré par défaut car il n'existe pas de relais gratuit,
 * fiable et sans inscription. Sans TURN, certaines connexions à distance
 * (4G/5G de certains opérateurs, réseaux d'entreprise) peuvent échouer.
 * Pour en ajouter un : { urls: 'turn:exemple.com:3478', username: '...', credential: '...' }
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** Durée max de collecte des adresses réseau avant de générer le code (ms). */
export const ICE_GATHER_TIMEOUT_MS = 6000;
/** Intervalle des messages de vie, et délai sans nouvelles avant de déclarer la connexion perdue (ms). */
export const HEARTBEAT_MS = 3000;
export const HEARTBEAT_TIMEOUT_MS = 12000;
