import type { KeyValueStore } from '../game/session';

/** localStorage protégé (navigation privée, quota, stockage bloqué…). */
export const store: KeyValueStore = {
  getItem(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignoré */
    }
  },
  removeItem(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignoré */
    }
  },
};
