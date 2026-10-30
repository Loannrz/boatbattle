/**
 * QR codes : génération (qrcode-generator) et lecture par la caméra (jsQR, chargé à la demande).
 * Les deux bibliothèques sont incluses dans l'app (fonctionne hors ligne).
 */

import qrcode from 'qrcode-generator';

/** Retourne un <svg> (texte) du QR code, net à toute taille. */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const size = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export interface Scanner {
  stop(): void;
}

/**
 * Ouvre la caméra arrière dans `video` et appelle `onText` au premier QR lu.
 * Lève une erreur si la caméra est refusée ou indisponible.
 */
export async function startScanner(video: HTMLVideoElement, onText: (text: string) => void): Promise<Scanner> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Caméra indisponible sur ce navigateur.');
  // Charger le décodeur d'abord : si cela échoue, la caméra n'est jamais allumée.
  const { default: jsQR } = await import('jsqr');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  let stopped = false;
  let raf = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  try {
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true'); // iOS : pas de plein écran automatique
    video.muted = true;
    await video.play().catch(() => undefined);
  } catch (e) {
    stop();
    throw e;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    stop();
    throw new Error('Analyse d’image indisponible.');
  }

  const tick = () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        // image réduite : plus rapide, suffisant pour un QR affiché sur un écran
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (found?.data) {
          stop();
          onText(found.data);
          return;
        }
      }
    } catch {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { stop };
}
