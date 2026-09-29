/*
 * Enregistrement d'un message vocal pour WhatsApp (compositeur des
 * Discussions). Meta n'accepte que audio/ogg (codec Opus, mono), audio/mp4
 * (AAC), audio/aac, audio/mpeg et audio/amr : le webm que produit
 * MediaRecorder sur Chrome / Edge est refusé. Trois voies, par préférence :
 *  1. WebCodecs (AudioEncoder Opus) + multiplexage Ogg fait ici → audio/ogg
 *     (Chrome, Edge, Firefox ≥ 130) : affiché comme une note vocale ;
 *  2. MediaRecorder audio/ogg;codecs=opus (anciens Firefox) ;
 *  3. MediaRecorder audio/mp4 (Safari) : affiché comme un fichier audio.
 * Sinon capaciteVocal() renvoie null et le bouton micro est désactivé.
 * Le fichier part tel quel au backend (champ multipart « audio ») qui le
 * téléverse chez Meta sans conversion.
 */

/** Opus travaille à 48 kHz : c'est aussi l'unité des positions de granule Ogg. */
const TAUX_OPUS = 48000;
const CONFIG_OPUS = { codec: 'opus', sampleRate: TAUX_OPUS, numberOfChannels: 1, bitrate: 32000 };
/** Pré-saut (lookahead) par défaut de libopus à 48 kHz, si l'encodeur ne fournit pas son en-tête. */
const PRE_SKIP_DEFAUT = 312;
/** Paquets par page Ogg (20 ms chacun → ~1 s de son par page). */
const PAQUETS_PAR_PAGE = 50;

let capacitePromise = null;

/** 'opus' | 'ogg' | 'mp4' | null (détection mise en cache). */
export function capaciteVocal() {
  if (!capacitePromise) capacitePromise = detecter();
  return capacitePromise;
}

async function detecter() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined' && typeof AudioContext !== 'undefined') {
    try {
      const { supported } = await AudioEncoder.isConfigSupported(CONFIG_OPUS);
      if (supported) return 'opus';
    } catch {
      /* WebCodecs partiel : on passe aux replis */
    }
  }
  if (typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'ogg';
    if (MediaRecorder.isTypeSupported('audio/mp4')) return 'mp4';
  }
  return null;
}

/**
 * Démarre la capture du micro. Renvoie { stop(): Promise<File>, annuler() }.
 * Lève une erreur si le navigateur ne sait pas enregistrer ou si l'accès au
 * micro est refusé (err.name === 'NotAllowedError').
 */
export async function demarrerEnregistrement() {
  const mode = await capaciteVocal();
  if (!mode) throw new Error('Enregistrement vocal non pris en charge par ce navigateur.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
  try {
    return mode === 'opus' ? await enregistrerOpus(stream) : enregistrerMediaRecorder(stream, mode);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Voie 1 : WebCodecs → Ogg/Opus                                       */
/* ------------------------------------------------------------------ */

async function enregistrerOpus(stream) {
  const ctx = new AudioContext({ sampleRate: TAUX_OPUS });
  const config = ctx.sampleRate === TAUX_OPUS ? CONFIG_OPUS : { ...CONFIG_OPUS, sampleRate: ctx.sampleRate };
  if (ctx.sampleRate !== TAUX_OPUS) {
    const { supported } = await AudioEncoder.isConfigSupported(config);
    if (!supported) {
      await ctx.close();
      throw new Error(`Fréquence d'échantillonnage ${ctx.sampleRate} Hz non prise en charge par l'encodeur.`);
    }
  }
  const muxeur = new MuxeurOggOpus(ctx.sampleRate);
  let erreur = null;
  const encodeur = new AudioEncoder({
    output: (chunk, meta) => {
      const description = meta?.decoderConfig?.description;
      if (description) muxeur.definirEntete(description);
      const octets = new Uint8Array(chunk.byteLength);
      chunk.copyTo(octets);
      muxeur.ajouterPaquet(octets, chunk.timestamp + (chunk.duration || 0));
    },
    error: (e) => {
      erreur = e;
    }
  });
  encodeur.configure(config);

  // ScriptProcessorNode : déprécié mais présent partout, sans module worklet
  // (donc sans contrainte CSP). Entrée mixée en mono, sortie muette.
  const source = ctx.createMediaStreamSource(stream);
  const processeur = ctx.createScriptProcessor(4096, 1, 1);
  let trames = 0;
  processeur.onaudioprocess = (e) => {
    if (encodeur.state !== 'configured') return;
    const entree = e.inputBuffer.getChannelData(0);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: ctx.sampleRate,
      numberOfFrames: entree.length,
      numberOfChannels: 1,
      timestamp: Math.round((trames * 1e6) / ctx.sampleRate),
      data: entree.slice(0)
    });
    trames += entree.length;
    try {
      encodeur.encode(data);
    } finally {
      data.close();
    }
  };
  source.connect(processeur);
  processeur.connect(ctx.destination);
  // Sans attente : si la politique de lecture auto retenait le contexte, la
  // promesse resterait en suspens ; l'enregistrement démarre dès qu'il tourne.
  ctx.resume().catch(() => {});

  function couper() {
    processeur.onaudioprocess = null;
    try {
      source.disconnect();
      processeur.disconnect();
    } catch {
      /* déjà déconnecté */
    }
    stream.getTracks().forEach((t) => t.stop());
  }

  return {
    async stop() {
      couper();
      try {
        if (encodeur.state === 'configured') await encodeur.flush();
      } finally {
        if (encodeur.state !== 'closed') encodeur.close();
        ctx.close().catch(() => {});
      }
      if (erreur) throw erreur;
      const blob = muxeur.terminer();
      return new File([blob], `vocal-${Date.now()}.ogg`, { type: 'audio/ogg' });
    },
    annuler() {
      couper();
      if (encodeur.state !== 'closed') encodeur.close();
      ctx.close().catch(() => {});
    }
  };
}

/**
 * Multiplexeur Ogg minimal pour un flux Opus mono (RFC 7845) : page 0 =
 * OpusHead (BOS), page 1 = OpusTags, puis les paquets audio par pages d'une
 * seconde environ, dernière page marquée EOS. La position de granule d'une
 * page est le nombre total d'échantillons (à 48 kHz) décodés à la fin du
 * dernier paquet qu'elle contient.
 */
class MuxeurOggOpus {
  constructor(tauxEntree) {
    this.tauxEntree = tauxEntree;
    this.entete = null;
    this.paquets = [];
  }

  /** En-tête OpusHead fourni par l'encodeur (pré-saut exact) ; ignoré s'il n'en a pas la forme. */
  definirEntete(description) {
    if (this.entete) return;
    const o =
      description instanceof ArrayBuffer
        ? new Uint8Array(description)
        : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
    if (o.length >= 19 && String.fromCharCode(...o.subarray(0, 8)) === 'OpusHead') this.entete = o.slice(0);
  }

  ajouterPaquet(octets, finMicrosecondes) {
    this.paquets.push({ octets, granule: Math.round((finMicrosecondes * TAUX_OPUS) / 1e6) });
  }

  terminer() {
    if (!this.paquets.length) throw new Error('Enregistrement vide : aucun son capté.');
    const serie = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const pages = [];
    let seq = 0;
    pages.push(pageOgg(serie, seq++, 0x02, 0, [this.entete || opusHead(this.tauxEntree)]));
    pages.push(pageOgg(serie, seq++, 0x00, 0, [opusTags()]));
    for (let i = 0; i < this.paquets.length; ) {
      const lot = [];
      let segments = 0;
      while (i < this.paquets.length && lot.length < PAQUETS_PAR_PAGE) {
        const n = Math.floor(this.paquets[i].octets.length / 255) + 1;
        if (lot.length && segments + n > 255) break;
        segments += n;
        lot.push(this.paquets[i]);
        i += 1;
      }
      const derniere = i >= this.paquets.length;
      pages.push(pageOgg(serie, seq++, derniere ? 0x04 : 0x00, lot[lot.length - 1].granule, lot.map((p) => p.octets)));
    }
    return new Blob(pages, { type: 'audio/ogg' });
  }
}

/** Une page Ogg : en-tête de 27 octets + table des segments + paquets (lacing par 255). */
function pageOgg(serie, seq, drapeaux, granule, paquets) {
  const lacing = [];
  let taille = 0;
  for (const p of paquets) {
    let reste = p.length;
    while (reste >= 255) {
      lacing.push(255);
      reste -= 255;
    }
    lacing.push(reste);
    taille += p.length;
  }
  const page = new Uint8Array(27 + lacing.length + taille);
  const vue = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // version
  page[5] = drapeaux; // 0x02 BOS, 0x04 EOS
  vue.setBigUint64(6, BigInt(granule), true);
  vue.setUint32(14, serie, true);
  vue.setUint32(18, seq, true);
  vue.setUint32(22, 0, true); // CRC calculé ci-dessous
  page[26] = lacing.length;
  page.set(lacing, 27);
  let pos = 27 + lacing.length;
  for (const p of paquets) {
    page.set(p, pos);
    pos += p.length;
  }
  vue.setUint32(22, crcOgg(page), true);
  return page;
}

/** CRC-32 Ogg : polynôme 0x04c11db7, sans réflexion, init 0, sans XOR final. */
const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crcOgg(octets) {
  let c = 0;
  for (let i = 0; i < octets.length; i += 1) c = ((c << 8) ^ TABLE_CRC[((c >>> 24) ^ octets[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

/** En-tête d'identification OpusHead (19 octets, mono, famille de mappage 0). */
function opusHead(tauxEntree) {
  const o = new Uint8Array(19);
  const v = new DataView(o.buffer);
  o.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  o[8] = 1; // version
  o[9] = 1; // canaux
  v.setUint16(10, PRE_SKIP_DEFAUT, true);
  v.setUint32(12, tauxEntree, true); // fréquence d'entrée (informative)
  v.setInt16(16, 0, true); // gain de sortie
  o[18] = 0; // famille de mappage
  return o;
}

/** En-tête de commentaires OpusTags (vendeur seul, aucun commentaire). */
function opusTags() {
  const vendeur = new TextEncoder().encode('ORTALOG');
  const o = new Uint8Array(8 + 4 + vendeur.length + 4);
  const v = new DataView(o.buffer);
  o.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  v.setUint32(8, vendeur.length, true);
  o.set(vendeur, 12);
  v.setUint32(12 + vendeur.length, 0, true);
  return o;
}

/* ------------------------------------------------------------------ */
/* Voies 2 et 3 : MediaRecorder natif (ogg/opus ou mp4)                */
/* ------------------------------------------------------------------ */

function enregistrerMediaRecorder(stream, mode) {
  const mimeType = mode === 'ogg' ? 'audio/ogg;codecs=opus' : 'audio/mp4';
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
  } catch {
    recorder = new MediaRecorder(stream, { mimeType });
  }
  const morceaux = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) morceaux.push(e.data);
  };
  recorder.start();
  const liberer = () => stream.getTracks().forEach((t) => t.stop());
  const type = mode === 'ogg' ? 'audio/ogg' : 'audio/mp4';
  const extension = mode === 'ogg' ? 'ogg' : 'm4a';
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        const finir = () => {
          liberer();
          if (!morceaux.length) return reject(new Error('Enregistrement vide : aucun son capté.'));
          const blob = new Blob(morceaux, { type });
          return resolve(new File([blob], `vocal-${Date.now()}.${extension}`, { type }));
        };
        recorder.onerror = (e) => {
          liberer();
          reject(e.error || new Error('Enregistrement interrompu.'));
        };
        recorder.onstop = finir;
        if (recorder.state === 'inactive') finir();
        else recorder.stop();
      }),
    annuler() {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      liberer();
    }
  };
}
