/**
 * Détecteur de codes (QR + code-barres CODE128) multi-navigateurs.
 *
 * - API native BarcodeDetector quand elle est réellement disponible
 *   (Chrome/Edge Android : rapide, matériel).
 * - Sinon repli ZXing en JavaScript pur, chargé à la demande : couvre
 *   iPhone/iPad (tous les navigateurs iOS utilisent WebKit, sans cette API)
 *   ainsi que Firefox et certains Chrome de bureau où l'API existe mais ne
 *   supporte aucun format.
 *
 * Usage : const detector = await createCodeDetector();
 *         const code = await detector.detect(videoElement); // string | null
 */
export async function createCodeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (Array.isArray(formats) && formats.length > 0) {
        const native = new window.BarcodeDetector();
        return {
          async detect(video) {
            const codes = await native.detect(video);
            return codes?.[0]?.rawValue?.trim() || null;
          }
        };
      }
    } catch {
      /* API présente mais inutilisable : on passe au repli ZXing */
    }
  }

  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library')
  ]);
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.CODE_128,
    BarcodeFormat.EAN_13,
    BarcodeFormat.CODE_39
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  return {
    async detect(video) {
      if (!video?.videoWidth || !video?.videoHeight) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      try {
        return reader.decodeFromCanvas(canvas)?.getText()?.trim() || null;
      } catch {
        return null; // rien de lisible sur cette image
      }
    }
  };
}
