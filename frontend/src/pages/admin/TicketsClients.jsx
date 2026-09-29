import { useState } from 'react';
import { Printer, RefreshCw, Ticket } from 'lucide-react';
import api from '../../api/client';
import { usePlatform } from '../../context/PlatformContext';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Tickets vides > Tickets clients — générateur d'étiquettes colis VIERGES
 * (portage de tickets_vendeurs.php) : rouleaux d'étiquettes ne portant que
 * le code (QR + code-barres CODE128), tous les autres champs en lignes
 * pointillées à remplir à la main. Remises aux vendeurs sans dashboard ; le
 * colis devient réel quand un opérateur le saisit en recopiant le code dans
 * le tracking.
 *
 * Code : JJMMAA + 5 caractères (alphabet sans I/O/0/1, comme le legacy) —
 * mais le lot est vérifié côté serveur contre delevery_parcel avant
 * impression (le legacy ne vérifiait l'unicité que dans le navigateur, un
 * doublon n'était détecté qu'à la saisie du colis). Rien n'est enregistré
 * en base : le code n'existe que sur le papier.
 */

const MAX_TICKETS = 100;
/* Alphabet sans I, O, 0, 1 (lecture manuscrite / manuelle sans ambiguïté). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Un code JJMMAA + 5 caractères aléatoires. */
function makeCode() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const prefix = `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear() % 100).padStart(2, '0')}`;
  let suffix = '';
  for (let i = 0; i < 5; i += 1) suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return prefix + suffix;
}

/** Lot de codes uniques (unicité locale ; le serveur vérifie le reste). */
function makeBatch(count, existants) {
  const codes = new Set();
  while (codes.size < count) {
    const code = makeCode();
    if (!existants.has(code)) codes.add(code);
  }
  return [...codes];
}

export default function TicketsClients() {
  const { config } = usePlatform();
  const [form, setForm] = useState({ count: '4', format: '100' });
  const [codes, setCodes] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function generer() {
    setError('');
    const count = Math.min(Math.max(parseInt(form.count, 10) || 1, 1), MAX_TICKETS);
    setBusy(true);
    try {
      // Vérification serveur (colis existants) + regénération des conflits.
      let liste = makeBatch(count, new Set());
      for (let passe = 0; passe < 3; passe += 1) {
        const res = await api.post('/tickets-vides/verifier', { codes: liste });
        const doublons = new Set(res.data.doublons || []);
        if (!doublons.size) break;
        const propres = liste.filter((c) => !doublons.has(c));
        liste = [...propres, ...makeBatch(count - propres.length, new Set(propres))];
      }
      setCodes(liste);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la vérification des codes.');
    } finally {
      setBusy(false);
    }
  }

  /** PDF des tickets, ouvert dans un onglet (ouvert pendant le clic). */
  async function imprimer() {
    if (!codes.length || busy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération des tickets…');
    setBusy(true);
    try {
      const { genererTicketsClientsPdf } = await import('../../utils/ticketsVidesPdf');
      const url = await genererTicketsClientsPdf({
        onProgress: progressionOnglet(win, 'Génération des tickets…', 'ticket'),
        codes,
        logoUrl: config?.logo,
        format: form.format
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert('Erreur lors de la génération des tickets.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Ticket size={18} /> Tickets clients (étiquettes vierges)
          </h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={imprimer}
            disabled={!codes.length || busy}
          >
            <Printer size={15} /> Imprimer ({codes.length})
          </button>
        </div>

        <div className="tickets-toolbar">
          <label className="tickets-field tickets-field-small">
            <span className="field-label">Nombre</span>
            <input
              type="number"
              min="1"
              max={MAX_TICKETS}
              value={form.count}
              onChange={(e) => setForm((f) => ({ ...f, count: e.target.value }))}
            />
          </label>
          <label className="tickets-field tickets-field-small">
            <span className="field-label">Format</span>
            <select
              value={form.format}
              onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))}
            >
              <option value="100">100 × 100 mm</option>
              <option value="a4">A4 (4 / page)</option>
            </select>
          </label>
          <button type="button" className="btn btn-primary" onClick={generer} disabled={busy}>
            <RefreshCw size={15} /> {busy ? 'Génération…' : 'Générer'}
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        {codes.length > 0 ? (
          <div className="tickets-grid">
            {codes.map((code) => (
              <div key={code} className="ticket-preview">
                <div className="ticket-preview-societe">Étiquette vierge</div>
                <div className="ticket-preview-code">{code}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="cell-sub">
            Générez un lot d'étiquettes vierges à remettre aux vendeurs : chaque code est vérifié
            contre les colis existants avant impression. Les tickets ne sont pas enregistrés —
            imprimez-les avant de quitter la page.
          </p>
        )}
      </section>
    </div>
  );
}
