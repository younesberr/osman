import { useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCheck, Eye, MessageCircle, MessagesSquare, Reply, Send, Timer, UserX } from 'lucide-react';
import api from '../../api/client';
import { StatIconCard, formatNombre } from '../../components/DashboardLayout';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';

/*
 * Page /admin/api-liaison/whatsapp/statistiques — indicateurs du CRM WhatsApp
 * sur une période : volumes (envoyés, remis, lus, échecs, reçus), taux de
 * réponse et délai médian de réponse d'un employé, discussions, envois par jour
 * (barres CSS), par modèle, par règle, erreurs Meta les plus fréquentes.
 * Données : GET /api/whatsapp/statistiques?from&to.
 */

function bg(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.08)`;
}

const CONSEILS = {
  131047: 'Fenêtre de 24 h fermée : utilisez un modèle approuvé.',
  131026: 'Numéro absent de WhatsApp ou paramètres de confidentialité.',
  132001: 'Modèle inexistant ou non approuvé pour cette langue : synchronisez les modèles.',
  132000: 'Nombre de variables différent de celui du modèle : corrigez la règle.',
  190: 'Jeton expiré : enregistrez un jeton permanent (Configuration).',
  131056: 'Trop de messages vers le même numéro : espacer les envois.',
  130429: 'Limite de débit Meta : les envois sont réessayés automatiquement.',
  numero_invalide: 'Numéro non marocain ou mal saisi sur le colis / la fiche.',
  modele: 'Modèle non utilisable (statut Meta ou élément non pris en charge).',
  expire: 'Envoi non traité à temps (intégration désactivée ou serveur arrêté).',
  interrompu: 'Serveur redémarré pendant l’envoi : renvoyer depuis le Journal si besoin.',
  annule: 'Annulé manuellement depuis le Journal.'
};

function formatMinutes(min) {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h >= 24 ? `${(min / 1440).toFixed(1).replace('.', ',')} j` : `${h} h ${String(m).padStart(2, '0')}`;
}

function BarresJour({ parJour }) {
  const max = Math.max(1, ...parJour.map((j) => Math.max(j.envoyes, j.recus, j.echecs)));
  const pct = (v) => `${Math.max(0, (v / max) * 100)}%`;
  return (
    <div className="chart-card">
      <h3>Messages par jour</h3>
      {parJour.every((j) => !j.envoyes && !j.recus && !j.echecs) ? (
        <div className="chart-empty">Aucun message sur la période.</div>
      ) : (
        <>
          <div className="bars-scroll">
            <div className="bars">
              {parJour.map((j) => (
                <div key={j.jour} className="bars-col" title={`${j.jour} : ${j.envoyes} envoyé(s), ${j.recus} reçu(s), ${j.echecs} échec(s)`}>
                  <div className="bars-track">
                    <span className="bar" style={{ height: pct(j.envoyes), background: 'var(--primary)' }} />
                    <span className="bar" style={{ height: pct(j.recus), background: '#7c3aed' }} />
                    <span className="bar" style={{ height: pct(j.echecs), background: 'var(--danger)' }} />
                  </div>
                  <div className="bars-label">{j.jour.slice(8, 10)}/{j.jour.slice(5, 7)}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="bars-legend">
            <span>
              <i className="wa-legende" style={{ background: 'var(--primary)' }} /> Envoyés
            </span>
            <span>
              <i className="wa-legende" style={{ background: '#7c3aed' }} /> Reçus
            </span>
            <span>
              <i className="wa-legende" style={{ background: 'var(--danger)' }} /> Échecs
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function LignesBarres({ titre, lignes, cle, vide }) {
  const max = Math.max(1, ...lignes.map((l) => l.total));
  return (
    <div className="chart-card">
      <h3>{titre}</h3>
      {lignes.length === 0 ? (
        <div className="chart-empty">{vide}</div>
      ) : (
        <div className="chart-rows">
          {lignes.map((l) => (
            <div key={l[cle]} className="chart-row">
              <span className="chart-row-label" title={String(l[cle])}>
                {l[cle]}
              </span>
              <span className="chart-row-track">
                <span className="chart-row-bar" style={{ width: `${(l.total / max) * 100}%` }} />
              </span>
              <span className="chart-row-value">
                {formatNombre(l.total)}
                <em>
                  {l.envoyes ? `${Math.round((l.remis / l.envoyes) * 100)} % remis` : ''}
                  {l.echecs ? ` · ${l.echecs} échec(s)` : ''}
                </em>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WhatsAppStatistiques() {
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    api
      .get('/whatsapp/statistiques', { params: { from: range.from, to: range.to } })
      .then((res) => !cancelled && setData(res.data))
      .catch((err) => !cancelled && setError(err.response?.data?.message || 'Erreur de chargement des statistiques.'));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const t = data?.totaux;
  const taux = data?.taux;
  const rep = data?.reponses;
  const conv = data?.conversations;

  return (
    <div className="platform-page wa-crm">
      <div className="stats-toolbar wa-stats-toolbar">
        <h2>
          <BarChart3 size={18} /> Statistiques WhatsApp
        </h2>
        <DateRangeSelect value={range} onChange={setRange} />
      </div>
      {error && <div className="form-error">{error}</div>}

      <section className="dash-section" style={{ marginTop: 0 }}>
        <h2>Messages de la période</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard icon={Send} label="Envoyés" value={formatNombre(t?.envoyes)} sub={t ? `${formatNombre(t.planifies)} planifié(s) en attente` : undefined} color="#1c428a" bg={bg('#1c428a')} />
          <StatIconCard icon={CheckCheck} label="Remis" value={taux ? `${taux.remis} %` : undefined} sub={t ? `${formatNombre(t.remis)} messages remis` : undefined} color="#10b759" bg={bg('#10b759')} />
          <StatIconCard icon={Eye} label="Lus" value={taux ? `${taux.lus} %` : undefined} sub={t ? `${formatNombre(t.lus)} messages lus` : undefined} color="#0090e7" bg={bg('#0090e7')} />
          <StatIconCard icon={AlertTriangle} label="Échecs" value={formatNombre(t?.echecs)} sub={taux ? `${taux.echecs} % des envois` : undefined} color="#e74c3c" bg={bg('#e74c3c')} />
        </div>
      </section>

      <section className="dash-section">
        <h2>Réponses et discussions</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard icon={MessageCircle} label="Messages reçus" value={formatNombre(t?.recus)} color="#7c3aed" bg={bg('#7c3aed')} />
          <StatIconCard
            icon={Reply}
            label="Taux de réponse"
            value={rep ? `${rep.taux} %` : undefined}
            sub={rep ? `${formatNombre(rep.repondues)} / ${formatNombre(rep.questions)} messages entrants répondus par un employé` : undefined}
            color="#10b759"
            bg={bg('#10b759')}
          />
          <StatIconCard icon={Timer} label="Délai médian de réponse" value={rep ? formatMinutes(rep.delaiMedianMinutes) : undefined} color="#ffab00" bg={bg('#ffab00')} />
          <StatIconCard
            icon={MessagesSquare}
            label="Discussions ouvertes"
            value={formatNombre(conv?.ouvertes)}
            sub={conv ? `${formatNombre(conv.nonLues)} non lue(s) · ${formatNombre(conv.nonAffectees)} non affectée(s) · ${formatNombre(conv.creees)} créée(s) sur la période` : undefined}
            color="#1c428a"
            bg={bg('#1c428a')}
          />
          <StatIconCard icon={UserX} label="Contacts désinscrits" value={formatNombre(conv?.optOut)} sub="opt-out (STOP)" color="#e74c3c" bg={bg('#e74c3c')} />
        </div>
      </section>

      {data && (
        <>
          <section className="dash-section">
            <BarresJour parJour={data.parJour} />
          </section>
          <section className="dash-section">
            <div className="charts-grid">
              <LignesBarres titre="Par modèle" lignes={data.parModele} cle="modele" vide="Aucun modèle envoyé sur la période." />
              <LignesBarres titre="Par règle (actions automatiques)" lignes={data.parRegle} cle="regle" vide="Aucun envoi automatique sur la période." />
            </div>
          </section>
          <section className="dash-section">
            <div className="chart-card">
              <h3>Erreurs les plus fréquentes</h3>
              {data.erreurs.length === 0 ? (
                <div className="chart-empty">Aucun échec sur la période.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Message</th>
                        <th>Occurrences</th>
                        <th>Conseil</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.erreurs.map((e) => (
                        <tr key={e.code}>
                          <td className="mono">{e.code}</td>
                          <td className="wa-cell-wrap">{e.message}</td>
                          <td>{formatNombre(e.n)}</td>
                          <td className="wa-cell-wrap">{CONSEILS[e.code] || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
