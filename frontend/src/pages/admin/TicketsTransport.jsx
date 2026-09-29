import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, Printer, RefreshCw, Ticket } from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Tickets vides > Tickets transport — générateur d'étiquettes de liaison
 * entre deux sociétés partenaires (portage de tickets_transport.php) :
 * expéditeur + destinataire + nombre → tickets 100 × 100 mm (QR + code en
 * clair) imprimés en PDF (une page par ticket ou 4 par page A4).
 *
 * Code : CODE_EXP + timestamp ms + compteur 3 chiffres + CODE_DEST —
 * timestamp en millisecondes (le legacy utilisait la seconde : deux postes
 * générant le même couple dans la même seconde produisaient des codes
 * identiques) ; le lot est en plus vérifié côté serveur contre les codes
 * déjà scannés avant impression. Comme le legacy, rien n'est enregistré en
 * base : le code n'existe que sur le papier jusqu'au scan.
 */

const MAX_TICKETS = 100;

/** Libellé d'une société dans les selects : NOM (Ville) [CODE]. */
function societeLabel(s) {
  return `${s.nom}${s.ville ? ` (${s.ville})` : ''}${s.code ? ` [${s.code}]` : ''}`;
}

export default function TicketsTransport() {
  const [societes, setSocietes] = useState([]);
  const [form, setForm] = useState({ exp: '', dest: '', count: '4', format: '100' });
  const [tickets, setTickets] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get('/tickets-vides/societes')
      .then((res) => setSocietes(res.data.societes))
      .catch(() => {});
  }, []);

  const options = useMemo(
    () => societes.map((s) => ({ value: s.id, label: societeLabel(s) })),
    [societes]
  );
  const exp = societes.find((s) => String(s.id) === String(form.exp)) || null;
  const dest = societes.find((s) => String(s.id) === String(form.dest)) || null;

  /** Codes d'un lot : timestamp ms commun + compteur (regénérable par code). */
  function makeCode(expSociete, destSociete, counter) {
    return `${expSociete.code}${Date.now()}${String(counter).padStart(3, '0')}${destSociete.code}`;
  }

  /**
   * Vérifie le lot contre les codes déjà en circulation (envois / retours /
   * colis) et regénère les conflits — 3 passes maximum.
   */
  async function verifierEtCorriger(codes, expSociete, destSociete) {
    let liste = [...codes];
    for (let passe = 0; passe < 3; passe += 1) {
      const res = await api.post('/tickets-vides/verifier', { codes: liste });
      const doublons = new Set(res.data.doublons || []);
      if (!doublons.size) return liste;
      liste = liste.map((code, i) =>
        doublons.has(code) ? makeCode(expSociete, destSociete, 900 + i) : code
      );
    }
    return liste;
  }

  async function generer() {
    setError('');
    if (!exp || !dest) {
      setError('Veuillez sélectionner la société expéditrice et la société destinataire.');
      return;
    }
    if (exp.id === dest.id) {
      setError("L'expéditeur et le destinataire doivent être différents.");
      return;
    }
    if (!exp.code || !dest.code) {
      const sans = !exp.code ? exp.nom : dest.nom;
      setError(`${sans} n'a pas de code société. Définissez-le dans Transport > Configuration.`);
      return;
    }
    const count = Math.min(Math.max(parseInt(form.count, 10) || 1, 1), MAX_TICKETS);
    setBusy(true);
    try {
      const codes = await verifierEtCorriger(
        Array.from({ length: count }, (_, i) => makeCode(exp, dest, i + 1)),
        exp,
        dest
      );
      setTickets(
        codes.map((code) => ({
          code,
          exp: { nom: exp.nom, ville: exp.ville, telephone: exp.telephone },
          dest: { nom: dest.nom, ville: dest.ville, telephone: dest.telephone }
        }))
      );
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la vérification des codes.');
    } finally {
      setBusy(false);
    }
  }

  /** PDF des tickets, ouvert dans un onglet (ouvert pendant le clic). */
  async function imprimer() {
    if (!tickets.length || busy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération des tickets…');
    setBusy(true);
    try {
      const { genererTicketsTransportPdf } = await import('../../utils/ticketsVidesPdf');
      const url = await genererTicketsTransportPdf({
        tickets,
        format: form.format,
        onProgress: progressionOnglet(win, 'Génération des tickets…', 'ticket')
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
            <Ticket size={18} /> Tickets transport
          </h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={imprimer}
            disabled={!tickets.length || busy}
          >
            <Printer size={15} /> Imprimer ({tickets.length})
          </button>
        </div>

        <div className="tickets-toolbar">
          <div className="tickets-field">
            <span className="field-label">Société expéditrice</span>
            <SearchableSelect
              value={form.exp}
              onChange={(v) => setForm((f) => ({ ...f, exp: String(v) }))}
              placeholder="— Sélectionner —"
              options={options}
            />
          </div>
          <div className="tickets-field">
            <span className="field-label">Société destinataire</span>
            <SearchableSelect
              value={form.dest}
              onChange={(v) => setForm((f) => ({ ...f, dest: String(v) }))}
              placeholder="— Sélectionner —"
              options={options}
            />
          </div>
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

        {tickets.length > 0 && (
          <div className="tickets-grid">
            {tickets.map((t) => (
              <div key={t.code} className="ticket-preview">
                <div className="ticket-preview-societe">{t.exp.nom}</div>
                <ArrowDown size={16} />
                <div className="ticket-preview-code">{t.code}</div>
                <div className="ticket-preview-societe">{t.dest.nom}</div>
              </div>
            ))}
          </div>
        )}
        {tickets.length === 0 && (
          <p className="cell-sub">
            Sélectionnez les deux sociétés puis « Générer » : les codes sont vérifiés contre les
            colis déjà scannés avant impression. Les tickets ne sont pas enregistrés — imprimez-les
            avant de quitter la page.
          </p>
        )}
      </section>
    </div>
  );
}
