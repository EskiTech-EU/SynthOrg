const fs = require('fs');
const { DATA_DIR } = require('./paths');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(DATA_DIR, 'packages');
const CACHE_DIR = path.join(PACKAGES_DIR, 'cache');
const MANIFEST_PATH = path.join(PACKAGES_DIR, 'manifest.json');

// Curated dictionary for instant, perfect zero-latency titles & ~100-word descriptions
const CURATED_PACKAGES = {
  // Python packages
  'numpy': {
    title: 'NumPy: Calcolo Scientifico e Vettoriale',
    runtime: 'python',
    description: 'Libreria fondamentale per il calcolo scientifico in Python. Fornisce supporto per array e matrici multidimensionali ad alte prestazioni, insieme a un’ampia raccolta di funzioni matematiche di alto livello per operare su queste strutture dati. Indispensabile per algebra lineare, trasformate di Fourier e simulazioni numeriche.'
  },
  'pandas': {
    title: 'Pandas: Analisi Dati e Manipolazione Tabellare',
    runtime: 'python',
    description: 'Strumento principale per l’analisi e la manipolazione di strutture dati complesse. Introduce i DataFrame e le Series, consentendo operazioni rapide di pulizia dati, filtraggio, aggregazione, join, analisi di serie storiche e importazione/esportazione da formati CSV, Excel, JSON e database SQL.'
  },
  'matplotlib': {
    title: 'Matplotlib: Visualizzazione Dati e Grafici 2D',
    runtime: 'python',
    description: 'Libreria completa per la creazione di visualizzazioni statiche, animate e interattive in Python. Consente di generare istogrammi, grafici a linee, diagrammi a dispersione, grafici a torta e grafici complessi a più assi esportabili in formati PNG, SVG e PDF ad alta risoluzione.'
  },
  'scipy': {
    title: 'SciPy: Algoritmi Scientifici Avanzati',
    runtime: 'python',
    description: 'Raccolta di algoritmi matematici e funzioni di utilità costruita su NumPy. Fornisce moduli dedicati all’ottimizzazione, integrazione numerica, interpolazione, elaborazione dei segnali e delle immagini, algebra lineare avanzata e distribuzioni statistiche.'
  },
  'requests': {
    title: 'Requests: Client HTTP per API e Web Scraping',
    runtime: 'python',
    description: 'Elegante e semplice libreria HTTP per Python concepita per gli esseri umani. Permette di inviare richieste GET, POST, PUT, DELETE gestendo automaticamente sessioni, cookie persistenti, autenticazione, parametri query e payload JSON con decodifica trasparente dei contenuti.'
  },
  'beautifulsoup4': {
    title: 'BeautifulSoup4: Parsing HTML e XML',
    runtime: 'python',
    description: 'Libreria progettata per progetti di scraping ed estrazione dati da pagine web. Analizza documenti HTML o XML anche malformati, creando un albero di navigazione che rende immediata la ricerca, la selezione e l’estrazione di tag, attributi e blocchi di testo.'
  },
  'scikit-learn': {
    title: 'Scikit-Learn: Machine Learning e Data Mining',
    runtime: 'python',
    description: 'Strumento essenziale per l’apprendimento automatico supervisionato e non supervisionato. Include implementazioni efficienti per classificazione, regressione, clustering (k-means, DBSCAN), riduzione della dimensionalità (PCA) e pre-elaborazione delle feature con validazione dei modelli.'
  },
  'pillow': {
    title: 'Pillow (PIL): Elaborazione e Manipolazione Immagini',
    runtime: 'python',
    description: 'Fork moderno della Python Imaging Library. Aggiunge capacità di elaborazione grafica per apertura, manipolazione, ridimensionamento, rotazione, applicazione di filtri ed esportazione di decine di formati di immagine tra cui JPEG, PNG, WEBP, GIF e BMP.'
  },
  'sympy': {
    title: 'SymPy: Matematica Simbolica e Algebra Computazionale',
    runtime: 'python',
    description: 'Libreria Python per il calcolo simbolico. Consente di eseguire calcoli algebrici esatti, risolvere equazioni simboliche, calcolare derivate, integrali, limiti, sviluppi in serie di Taylor e semplificazioni algebriche senza approssimazioni in virgola mobile.'
  },
  'sqlite3': {
    title: 'SQLite3: Database Relazionale Serverless',
    runtime: 'python',
    description: 'Modulo integrato per l’accesso diretto a database relazionali SQLite su file o in memoria. Supporta transazioni ACID, query parametriche sicure, indici e funzioni personalizzate senza richiedere l’installazione di alcun demone o servizio server esterno.'
  },
  // Node.js packages
  'express': {
    title: 'Express: Web Framework Minimalista per Node.js',
    runtime: 'nodejs',
    description: 'Framework applicativo web flessibile e veloce per Node.js. Fornisce un robusto set di funzionalità per server HTTP, gestione delle route, middleware componibili, manipolazione di parametri e risposte JSON per la realizzazione rapida di API REST.'
  },
  'cheerio': {
    title: 'Cheerio: Parsing e Manipolazione HTML Fast-Core',
    runtime: 'nodejs',
    description: 'Implementazione rapidissima e snella della sintassi jQuery progettata specificamente per il server. Esegue il parsing di markup HTML e fornisce un’API per attraversare l’albero del DOM, estrarre testo e manipolare elementi senza l’overhead di un browser completo.'
  },
  'lodash': {
    title: 'Lodash: Utilità Funzionali per JavaScript',
    runtime: 'nodejs',
    description: 'Libreria di utilità moderna che garantisce modularità, prestazioni ed extra per manipolare array, numeri, oggetti, stringhe e funzioni di ordine superiore come debounce, throttle, deep clone e mappature complesse.'
  },
  'axios': {
    title: 'Axios: Client HTTP Basato su Promise',
    runtime: 'nodejs',
    description: 'Client HTTP isomorfo basato su Promise per Node.js e browser. Gestisce automaticamente la trasformazione dei dati JSON, intercettori di richieste e risposte, cancellazione delle chiamate e protezione automatica contro attacchi CSRF.'
  }
};

class PackageManager {
  constructor(options = {}) {
    this.root = options.root || ROOT;
    this.cacheDir = options.cacheDir || CACHE_DIR;
    this.manifestPath = options.manifestPath || MANIFEST_PATH;
    this.manifest = this._loadManifest();
  }

  _loadManifest() {
    try {
      if (fs.existsSync(this.manifestPath)) {
        const content = fs.readFileSync(this.manifestPath, 'utf8');
        return JSON.parse(content);
      }
    } catch (e) {
      console.warn('[PackageManager] Errore lettura manifest.json, ricreazione:', e.message);
    }
    return { packages: {} };
  }

  _saveManifest() {
    try {
      const dir = path.dirname(this.manifestPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
    } catch (e) {
      console.error('[PackageManager] Errore salvataggio manifest:', e.message);
    }
  }

  /**
   * Scans cacheDir and local packages directory to discover wheel, tgz or installed packages
   */
  async scan() {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const discovered = {};

    // 1. Scan filesystem cache
    const scanFolder = (folder) => {
      if (!fs.existsSync(folder)) return;
      const entries = fs.readdirSync(folder, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          scanFolder(fullPath);
        } else if (entry.isFile()) {
          const parsed = this._parsePackageFileName(entry.name, fullPath);
          if (parsed) {
            discovered[parsed.name] = parsed;
          }
        }
      }
    };

    scanFolder(this.cacheDir);

    // 2. Merge with manifest and curated defaults
    const currentPackages = this.manifest.packages || {};

    // Retain existing enabled status or initialize with curated defaults
    for (const [name, meta] of Object.entries(discovered)) {
      if (!currentPackages[name]) {
        currentPackages[name] = {
          name,
          version: meta.version || 'latest',
          runtime: meta.runtime || 'python',
          title: meta.title,
          description: meta.description,
          isDefault: true,
          sizeBytes: meta.sizeBytes || 0,
          cachedAt: new Date().toISOString()
        };
      } else {
        // Update version and size if detected
        currentPackages[name].version = meta.version || currentPackages[name].version;
        currentPackages[name].sizeBytes = meta.sizeBytes || currentPackages[name].sizeBytes;
      }
    }

    // Ensure baseline curated packages exist in manifest for instant availability
    for (const [cName, cMeta] of Object.entries(CURATED_PACKAGES)) {
      if (!currentPackages[cName]) {
        currentPackages[cName] = {
          name: cName,
          version: 'installed',
          runtime: cMeta.runtime,
          title: cMeta.title,
          description: cMeta.description,
          isDefault: ['numpy', 'pandas', 'requests', 'matplotlib', 'express'].includes(cName),
          sizeBytes: 0,
          cachedAt: new Date().toISOString()
        };
      }
    }

    this.manifest.packages = currentPackages;
    this.manifest.lastScan = new Date().toISOString();
    this._saveManifest();

    return this.list();
  }

  _parsePackageFileName(filename, fullPath) {
    const stats = fs.statSync(fullPath);
    const sizeBytes = stats.size;

    // Python Wheel: numpy-1.26.4-cp311-cp311-manylinux...whl
    if (filename.endsWith('.whl')) {
      const parts = filename.split('-');
      const rawName = parts[0].toLowerCase().replace(/_/g, '-');
      const version = parts[1] || 'unknown';
      const curated = CURATED_PACKAGES[rawName] || {};
      return {
        name: rawName,
        version,
        runtime: 'python',
        title: curated.title || `${this._capitalize(rawName)}: Libreria Python`,
        description: curated.description || `Libreria Python ${rawName} versione ${version} conservata nella cache persistente della sandbox locale.`,
        sizeBytes
      };
    }

    // Node.js Tarball: express-4.19.2.tgz
    if (filename.endsWith('.tgz')) {
      const match = filename.match(/^(.+)-([0-9]+\.[0-9]+\.[0-9]+.*)\.tgz$/);
      if (match) {
        const rawName = match[1].toLowerCase();
        const version = match[2];
        const curated = CURATED_PACKAGES[rawName] || {};
        return {
          name: rawName,
          version,
          runtime: 'nodejs',
          title: curated.title || `${this._capitalize(rawName)}: Modulo Node.js`,
          description: curated.description || `Modulo Node.js ${rawName} versione ${version} conservato nella cache persistente della sandbox locale.`,
          sizeBytes
        };
      }
    }

    return null;
  }

  _capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  list() {
    // If empty, auto-scan to populate defaults
    if (!this.manifest.packages || Object.keys(this.manifest.packages).length === 0) {
      for (const [cName, cMeta] of Object.entries(CURATED_PACKAGES)) {
        if (!this.manifest.packages) this.manifest.packages = {};
        this.manifest.packages[cName] = {
          name: cName,
          version: 'installed',
          runtime: cMeta.runtime,
          title: cMeta.title,
          description: cMeta.description,
          isDefault: ['numpy', 'pandas', 'requests', 'matplotlib', 'express'].includes(cName),
          sizeBytes: 0,
          cachedAt: new Date().toISOString()
        };
      }
      this._saveManifest();
    }

    const pkgs = Object.values(this.manifest.packages || {});
    // Sort: default active first, then alphabetically
    return pkgs.sort((a, b) => {
      if (a.isDefault === b.isDefault) return a.name.localeCompare(b.name);
      return a.isDefault ? -1 : 1;
    });
  }

  listDefault() {
    return this.list().filter(p => p.isDefault);
  }

  toggleDefault(name, isDefault) {
    if (!this.manifest.packages[name]) {
      throw Object.assign(new Error(`Pacchetto "${name}" non trovato.`), { status: 404 });
    }
    this.manifest.packages[name].isDefault = Boolean(isDefault);
    this._saveManifest();
    return this.manifest.packages[name];
  }

  updateMeta(name, { title, description }) {
    if (!this.manifest.packages[name]) {
      throw Object.assign(new Error(`Pacchetto "${name}" non trovato.`), { status: 404 });
    }
    if (title) this.manifest.packages[name].title = String(title).trim();
    if (description) this.manifest.packages[name].description = String(description).trim();
    this._saveManifest();
    return this.manifest.packages[name];
  }
}

module.exports = {
  PackageManager,
  CURATED_PACKAGES,
  CACHE_DIR,
  PACKAGES_DIR
};
