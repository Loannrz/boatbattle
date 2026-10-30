/**
 * ============================================================
 *  RÈGLES RÉGLABLES  (fichier à modifier librement)
 * ============================================================
 * Le moteur (src/engine) lit ces options. Les tests (src/engine/*.test.ts)
 * décrivent le comportement par défaut : si vous changez une règle, adaptez-les.
 *
 * Les deux téléphones comparent une empreinte de ces règles à la connexion :
 * si elles diffèrent, la partie est refusée (il faut la même version de l'app).
 */

export interface Rules {
  /**
   * Un triangle qui DÉVIE le laser (touché sur sa diagonale) compte comme "touché"
   * et sa couleur est annoncée. Si false, seule une face plate annonce une couleur.
   */
  announceDeflections: boolean;
  /**
   * Une même pièce n'est annoncée qu'une fois par tir, même si le laser repasse dessus
   * (par exemple au retour après un rebond sur une face plate).
   */
  countEachPieceOnce: boolean;
  /** Une pièce coulée est retirée du plateau : le laser passe ensuite à travers. */
  sunkPiecesAreRemoved: boolean;
  /**
   * Pour couler une pièce avec des demi-cases, il faut aussi indiquer l'orientation de
   * chaque demi-case (utile seulement pour le petit triangle : pour les autres, les cases
   * suffisent à fixer l'orientation).
   */
  claimNeedsOrientation: boolean;
  /** Autoriser deux pièces à se toucher par un côté (elles ne peuvent jamais se chevaucher). */
  allowTouchingPieces: boolean;
  /**
   * Après une déclaration JUSTE, le tour passe à l'adversaire (true) ou le joueur rejoue (false).
   * Une déclaration fausse fait toujours perdre le tour.
   */
  correctClaimPassesTurn: boolean;
}

export const RULES: Rules = {
  announceDeflections: true,
  countEachPieceOnce: true,
  sunkPiecesAreRemoved: true,
  claimNeedsOrientation: false,
  allowTouchingPieces: true,
  correctClaimPassesTurn: true,
};
