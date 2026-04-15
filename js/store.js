// IndexedDB-backed quiz library
// Stores quizzes + study materials in the browser — persists across sessions.
const Store = (() => {
  const DB_NAME    = 'exam_prepper';
  const DB_VERSION = 2;
  const Q_STORE    = 'quizzes';
  const M_STORE    = 'materials';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(Q_STORE)) {
          const os = db.createObjectStore(Q_STORE, { keyPath: 'id' });
          os.createIndex('subject',       'subject',       { unique: false });
          os.createIndex('last_accessed', 'last_accessed', { unique: false });
        }
        if (!db.objectStoreNames.contains(M_STORE)) {
          const ms = db.createObjectStore(M_STORE, { keyPath: 'id' });
          ms.createIndex('last_updated', 'last_updated', { unique: false });
        }
      };
      req.onsuccess  = e => resolve(e.target.result);
      req.onerror    = e => reject(e.target.error);
    });
  }

  // ── Quiz Write ─────────────────────────────────────────────────────────────

  async function saveQuiz(quizData, subjectOverride) {
    if (!quizData.id) quizData.id = generateId();
    const db = await openDB();
    const subject = subjectOverride || quizData.subject || guessSubject(quizData.title);
    const record = {
      id:            quizData.id,
      title:         quizData.title || 'Untitled Quiz',
      subject,
      created_at:    quizData.generated_at || new Date().toISOString(),
      last_accessed: new Date().toISOString(),
      question_count: quizData.questions?.length || 0,
      answered_count: quizData.questions?.filter(q => q.user_answer !== null).length || 0,
      graded_count:   quizData.questions?.filter(q => q.grading?.status === 'graded').length || 0,
      data:           quizData
    };
    return tx(db, Q_STORE, 'readwrite', s => s.put(record)).then(() => record);
  }

  async function updateProgress(quizData) {
    const db   = await openDB();
    const prev = await tx(db, Q_STORE, 'readonly', s => s.get(quizData.id));
    if (!prev) return saveQuiz(quizData);
    const record = {
      ...prev,
      last_accessed:  new Date().toISOString(),
      answered_count: quizData.questions?.filter(q => q.user_answer !== null).length || 0,
      graded_count:   quizData.questions?.filter(q => q.grading?.status === 'graded').length || 0,
      data:           quizData
    };
    return tx(db, Q_STORE, 'readwrite', s => s.put(record)).then(() => record);
  }

  async function deleteQuiz(id) {
    const db = await openDB();
    return tx(db, Q_STORE, 'readwrite', s => s.delete(id));
  }

  async function getAllMeta() {
    const db      = await openDB();
    const records = await tx(db, Q_STORE, 'readonly', s => s.getAll());
    return records.map(r => ({ ...r, data: undefined }));
  }

  async function getQuiz(id) {
    const db = await openDB();
    return tx(db, Q_STORE, 'readonly', s => s.get(id));
  }

  // ── Material Write ─────────────────────────────────────────────────────────

  async function saveMaterial(materialData, label) {
    const db = await openDB();
    const id = materialData.id || ('mat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
    const record = {
      id,
      label:        label || materialData.label || 'My Material',
      source_count: materialData.sources?.length || 0,
      last_updated: new Date().toISOString(),
      data:         { ...materialData, id }
    };
    return tx(db, M_STORE, 'readwrite', s => s.put(record)).then(() => record);
  }

  async function getMaterial(id) {
    const db = await openDB();
    return tx(db, M_STORE, 'readonly', s => s.get(id));
  }

  async function getAllMaterials() {
    const db = await openDB();
    const records = await tx(db, M_STORE, 'readonly', s => s.getAll());
    return records.map(r => ({ ...r, data: undefined }));
  }

  async function deleteMaterial(id) {
    const db = await openDB();
    return tx(db, M_STORE, 'readwrite', s => s.delete(id));
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  async function exportBackup() {
    const db        = await openDB();
    const quizzes   = await tx(db, Q_STORE, 'readonly', s => s.getAll());
    const materials = await tx(db, M_STORE, 'readonly', s => s.getAll());
    return { backup_version: 1, exported_at: new Date().toISOString(), quizzes, materials };
  }

  async function importBackup(backup) {
    if (!backup?.quizzes && !backup?.materials) throw new Error('Not a valid backup file');
    const db = await openDB();
    for (const q of (backup.quizzes || []))   await tx(db, Q_STORE, 'readwrite', s => s.put(q));
    for (const m of (backup.materials || [])) await tx(db, M_STORE, 'readwrite', s => s.put(m));
    return { quizzes: (backup.quizzes || []).length, materials: (backup.materials || []).length };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function tx(db, storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const t   = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      if (!req || typeof req.onsuccess === 'undefined') { resolve(); return; }
      req.onsuccess = () => resolve(req.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function generateId() {
    const ts  = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 7);
    return `quiz_${ts}_${rnd}`;
  }

  function guessSubject(title) {
    if (!title) return 'General';
    const m = title.match(/^([A-Za-z]+[\s_]*\d{3,})/);
    return m ? m[1].trim() : 'General';
  }

  return {
    saveQuiz, updateProgress, deleteQuiz, getAllMeta, getQuiz,
    saveMaterial, getMaterial, getAllMaterials, deleteMaterial,
    exportBackup, importBackup,
    generateId, guessSubject
  };
})();
