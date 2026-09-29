import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, Save, Send, X, Zap } from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import MultiSearchSelect from '../../components/MultiSearchSelect';
import Toggle from '../../components/Toggle';
import WhatsAppModelePreview from '../../components/WhatsAppModelePreview';
import { libelleModele } from '../../utils/whatsapp';

/*
 * Modale de création / modification d'une action automatique WhatsApp :
 * événement → conditions (statuts, clients) → audience (+ employés notifiés)
 * → modèle approuvé → correspondance de chaque variable {{n}} (variable du
 * contexte ou texte fixe) → délai, anti-doublon, heures calmes, actif.
 * Bloc « Tester » : rendu à blanc sur un colis réel (POST /whatsapp/regles/tester)
 * et envoi optionnel au numéro de test de la configuration.
 */

function Pills({ options, value, onChange, name }) {
  return (
    <div className="radio-group wa-pills">
      {options.map((o) => (
        <label key={o.value} className={`radio-pill ${value === o.value ? 'radio-pill-checked' : ''}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function formulaireDepuis(regle, modeles) {
  const m = regle ? modeles.find((x) => x.nom === regle.modele && x.langue === regle.langue) : null;
  return {
    nom: regle?.nom || '',
    evenement: regle?.evenement || '',
    codes: regle?.conditions?.codes || [],
    clientsMode: regle?.conditions?.clients?.length ? 'selection' : 'tous',
    clients: (regle?.conditions?.clients || []).map(String),
    audience: regle?.audience || '',
    cibles: (regle?.cibles || []).map(String),
    modeleId: m ? String(m.id) : '',
    params: regle?.params || [],
    delaiMinutes: regle?.delaiMinutes ?? 0,
    dedupHeures: regle?.dedupHeures ?? 0,
    heuresCalmes: regle ? regle.heuresCalmes : true,
    actif: regle ? regle.actif : true
  };
}

export default function WhatsAppRegleModal({ regle, catalogue, modeles, referentiels, onClose, onSaved }) {
  const [form, setForm] = useState(() => formulaireDepuis(regle, modeles));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [avertissements, setAvertissements] = useState([]);
  const [testCode, setTestCode] = useState('');
  const [test, setTest] = useState({ busy: false, result: null, error: '' });

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const evenement = catalogue.evenements.find((e) => e.code === form.evenement) || null;
  const modele = modeles.find((m) => String(m.id) === form.modeleId) || null;
  const variables = useMemo(
    () => (evenement ? catalogue.variables.filter((v) => v.contextes.includes('*') || v.contextes.includes(evenement.contexte)) : []),
    [catalogue.variables, evenement]
  );
  const variablesOk = useMemo(() => new Set(variables.map((v) => v.code)), [variables]);

  function set(patch) {
    setError('');
    setForm((f) => ({ ...f, ...patch }));
  }

  function choisirEvenement(code) {
    const e = catalogue.evenements.find((x) => x.code === code);
    const audience = e && !e.audiences.includes(form.audience) ? e.audiences[0] : form.audience;
    const ok = new Set(catalogue.variables.filter((v) => e && (v.contextes.includes('*') || v.contextes.includes(e.contexte))).map((v) => v.code));
    set({
      evenement: code,
      codes: [],
      audience: audience || '',
      params: form.params.map((p) => (p.type === 'variable' && !ok.has(p.code) ? { type: 'variable', code: '' } : p))
    });
  }

  function choisirModele(id) {
    const m = modeles.find((x) => String(x.id) === String(id));
    const params = m
      ? Array.from({ length: m.nbVariables }, (_, i) => {
          const d = m.mappingDefaut?.[i];
          if (d?.type === 'fixe') return { type: 'fixe', texte: d.texte || '' };
          return { type: 'variable', code: d?.code && variablesOk.has(d.code) ? d.code : '' };
        })
      : [];
    set({ modeleId: String(id), params });
  }

  function setParam(i, patch) {
    set({ params: form.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  }

  function payload() {
    return {
      nom: form.nom.trim(),
      evenement: form.evenement,
      conditions: { codes: form.codes, clients: form.clientsMode === 'selection' ? form.clients.map(Number) : [] },
      audience: form.audience,
      cibles: form.cibles.map(Number),
      modele: modele?.nom || '',
      langue: modele?.langue || 'fr',
      params: form.params.map((p) => (p.type === 'fixe' ? { type: 'fixe', texte: p.texte || '' } : { type: 'variable', code: p.code || '' })),
      delaiMinutes: Number(form.delaiMinutes) || 0,
      dedupHeures: Number(form.dedupHeures) || 0,
      heuresCalmes: form.heuresCalmes,
      actif: form.actif
    };
  }

  const paramsExemple = form.params.map((p) => {
    if (p.type === 'fixe') return p.texte || '';
    const v = variables.find((x) => x.code === p.code);
    return v ? v.exemple : '';
  });

  function validerLocal() {
    if (!form.evenement) return 'Choisissez un événement.';
    if (!form.audience) return 'Choisissez une audience.';
    if (form.audience === 'admin' && !form.cibles.length) return 'Choisissez au moins un employé à notifier.';
    if (!modele) return 'Choisissez un modèle de message.';
    if (form.clientsMode === 'selection' && !form.clients.length) return 'Choisissez au moins un client, ou « Tous les clients ».';
    const manquante = form.params.findIndex((p) => (p.type === 'fixe' ? !String(p.texte || '').trim() : !p.code));
    if (manquante >= 0) return `Renseignez la variable {{${manquante + 1}}}.`;
    return '';
  }

  async function save(e) {
    e.preventDefault();
    const err = validerLocal();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = regle ? await api.put(`/whatsapp/regles/${regle.id}`, payload()) : await api.post('/whatsapp/regles', payload());
      setAvertissements(res.data.avertissements || []);
      onSaved(res.data);
      if (!(res.data.avertissements || []).length) onClose();
    } catch (err2) {
      setError(err2.response?.data?.message || "Échec de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  async function tester(envoyer) {
    const err = validerLocal();
    if (err) {
      setError(err);
      return;
    }
    setTest({ busy: true, result: null, error: '' });
    try {
      const res = await api.post('/whatsapp/regles/tester', { regle: payload(), parcelCode: testCode.trim(), envoyer });
      setTest({ busy: false, result: res.data, error: '' });
    } catch (err2) {
      setTest({ busy: false, result: err2.response?.data?.destinataires ? err2.response.data : null, error: err2.response?.data?.message || 'Test impossible.' });
    }
  }

  const modelesOptions = modeles
    .filter((m) => m.utilisable || String(m.id) === form.modeleId)
    .map((m) => ({ value: String(m.id), label: `${libelleModele(m)}${m.utilisable ? '' : ' (non utilisable)'}` }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide wa-crm wa-regle-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Zap size={20} />
            <div>
              <div className="cell-main">{regle ? 'Modifier la règle' : 'Nouvelle action automatique'}</div>
              <div className="cell-sub">Un événement métier déclenche l'envoi d'un modèle approuvé à une audience.</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Nom de la règle (facultatif)</span>
              <input type="text" value={form.nom} maxLength={100} placeholder="Ex. : Colis livré → destinataire" onChange={(e) => set({ nom: e.target.value })} />
            </label>

            <label className="modal-form-full">
              <span className="field-label">Événement déclencheur</span>
              <select className="modal-select" value={form.evenement} onChange={(e) => choisirEvenement(e.target.value)}>
                <option value="">— Choisir —</option>
                {catalogue.evenements.map((e) => (
                  <option key={e.code} value={e.code}>
                    {e.label}
                  </option>
                ))}
              </select>
              {evenement && <span className="cell-sub">{evenement.description}</span>}
            </label>

            {evenement?.statuts && (
              <div className="modal-form-full wa-field">
                <span className="field-label">Statuts concernés (aucun = tous)</span>
                <MultiSearchSelect
                  value={form.codes}
                  onChange={(v) => set({ codes: v })}
                  options={referentiels.statuts.map((s) => ({ value: s.code, label: `${s.label} (${s.code})` }))}
                  placeholder="Tous les statuts"
                />
              </div>
            )}

            {evenement && (
              <div className="modal-form-full wa-field">
                <span className="field-label">Audience</span>
                <Pills
                  name="audience"
                  value={form.audience}
                  onChange={(v) => set({ audience: v })}
                  options={evenement.audiences.map((a) => ({ value: a, label: catalogue.audiences[a] || a }))}
                />
                {form.audience === 'admin' && (
                  <MultiSearchSelect
                    className="wa-mt"
                    value={form.cibles}
                    onChange={(v) => set({ cibles: v })}
                    options={referentiels.utilisateurs.map((u) => ({ value: String(u.id), label: u.label }))}
                    placeholder="Employés à notifier (numéro de la fiche utilisateur)"
                  />
                )}
              </div>
            )}

            {evenement && evenement.contexte !== 'MESSAGE_RECU' && (
              <div className="modal-form-full wa-field">
                <span className="field-label">Clients concernés</span>
                <Pills
                  name="clients"
                  value={form.clientsMode}
                  onChange={(v) => set({ clientsMode: v })}
                  options={[
                    { value: 'tous', label: 'Tous les clients' },
                    { value: 'selection', label: 'Une sélection' }
                  ]}
                />
                {form.clientsMode === 'selection' && (
                  <MultiSearchSelect
                    className="wa-mt"
                    value={form.clients}
                    onChange={(v) => set({ clients: v })}
                    options={referentiels.magasins.map((m) => ({ value: String(m.id), label: m.label }))}
                    placeholder="Choisir les magasins"
                  />
                )}
              </div>
            )}

            <div className="modal-form-full wa-field">
              <span className="field-label">Modèle de message (approuvé par Meta)</span>
              {modelesOptions.length === 0 ? (
                <div className="form-notice">Aucun modèle approuvé : synchronisez les modèles depuis Meta (Modèles de message).</div>
              ) : (
                <SearchableSelect value={form.modeleId} onChange={choisirModele} options={modelesOptions} placeholder="Choisir un modèle" />
              )}
            </div>

            {modele && (
              <div className="modal-form-full wa-regle-grille">
                <div>
                  <span className="field-label">Variables du modèle</span>
                  {modele.nbVariables === 0 && <span className="cell-sub">Ce modèle n'a pas de variable.</span>}
                  <div className="wa-mapping">
                    {form.params.map((p, i) => (
                      <div key={i} className="wa-mapping-row">
                        <span className="mono">{`{{${i + 1}}}`}</span>
                        <select
                          className="modal-select"
                          value={p.type === 'fixe' ? '__fixe' : p.code || ''}
                          onChange={(e) =>
                            e.target.value === '__fixe' ? setParam(i, { type: 'fixe', texte: p.texte || '' }) : setParam(i, { type: 'variable', code: e.target.value })
                          }
                        >
                          <option value="">— Choisir —</option>
                          {variables.map((v) => (
                            <option key={v.code} value={v.code}>
                              {v.label} (ex. {v.exemple})
                            </option>
                          ))}
                          <option value="__fixe">Texte fixe…</option>
                        </select>
                        {p.type === 'fixe' && <input type="text" value={p.texte || ''} placeholder="Texte fixe" onChange={(e) => setParam(i, { texte: e.target.value })} />}
                      </div>
                    ))}
                  </div>
                </div>
                <WhatsAppModelePreview modele={modele} params={paramsExemple} />
              </div>
            )}

            <label>
              <span className="field-label">Délai avant envoi (minutes)</span>
              <input type="number" min={0} max={10080} value={form.delaiMinutes} onChange={(e) => set({ delaiMinutes: e.target.value })} />
              <span className="cell-sub">0 = immédiat. Utile pour laisser le temps d'une correction.</span>
            </label>
            <label>
              <span className="field-label">Anti-doublon (heures)</span>
              <input type="number" min={0} max={720} value={form.dedupHeures} onChange={(e) => set({ dedupHeures: e.target.value })} />
              <span className="cell-sub">Pas de second envoi de cette règle au même numéro (même colis) dans ce délai. 0 = désactivé.</span>
            </label>
            <div className="wa-switch-row">
              <Toggle checked={form.heuresCalmes} onChange={(v) => set({ heuresCalmes: v })} label="Respecter les heures calmes" />
              <span>Respecter les heures calmes (Configuration › Paramètres CRM)</span>
            </div>
            <div className="wa-switch-row">
              <Toggle checked={form.actif} onChange={(v) => set({ actif: v })} label="Règle active" />
              <span>Règle active</span>
            </div>
          </div>

          <div className="wa-test-bloc wa-regle-test">
            <h3>
              <FlaskConical size={15} /> Tester la règle
            </h3>
            <p>Rendu à blanc sur un colis réel (aucun envoi aux vrais destinataires) ; l'envoi éventuel part vers le numéro de test de la configuration.</p>
            <div className="wa-lier-recherche">
              <input type="text" value={testCode} placeholder="Code colis (facultatif : dernier objet en base sinon)" onChange={(e) => setTestCode(e.target.value)} />
              <button type="button" className="btn btn-ghost btn-sm" disabled={test.busy} onClick={() => tester(false)}>
                <FlaskConical size={14} /> Voir le rendu
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={test.busy || !test.result} onClick={() => tester(true)} title="Envoie le rendu au numéro de test">
                <Send size={14} /> Envoyer au numéro de test
              </button>
            </div>
            {test.error && <div className="field-error">{test.error}</div>}
            {test.result && (
              <div className="wa-test-result wa-test-regle">
                <div>
                  <span>Conditions</span>
                  <strong>{test.result.conditionsOk ? 'Remplies' : 'Non remplies pour ce colis (statut différent / client exclu)'}</strong>
                </div>
                <div>
                  <span>Destinataires</span>
                  <strong>
                    {test.result.destinataires?.length
                      ? test.result.destinataires
                          .map(
                            (d) =>
                              `${d.nom || d.type} · ${d.phone}${d.valide ? '' : ' (invalide)'}${
                                d.desactiveParClient ? ' (notification désactivée par le client : non envoyée)' : ''
                              }`
                          )
                          .join(' ; ')
                      : 'Aucun (numéro manquant)'}
                  </strong>
                </div>
                <div className="wa-test-apercu">
                  <span>Aperçu</span>
                  <strong>{test.result.apercu}</strong>
                </div>
                {test.result.envoi && (
                  <div>
                    <span>Envoi de test</span>
                    <strong className="field-success">Envoyé au {test.result.envoi.to} (journal n°{test.result.envoi.journalId})</strong>
                  </div>
                )}
              </div>
            )}
          </div>

          {avertissements.length > 0 && <div className="form-notice">{avertissements.join(' ')}</div>}
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {avertissements.length ? 'Fermer' : 'Annuler'}
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
