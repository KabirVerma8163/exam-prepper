# Exam Prepper

Turn your notes and PDFs into quizzes you can take in the browser. Material and quizzes live in your browser (IndexedDB)—nothing is sent to a server unless you use your own LLM elsewhere.

**Live demo:** *(add your Vercel URL here when it’s deployed)*

---

## Try it locally

This is a static site (HTML, CSS, JS). You only need a local web server so browser APIs behave correctly (file URLs can be flaky).

**Option A — quick Python server** (from this folder):

```bash
python3 -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080) and use **Take Quiz** / **Generate** as usual.

**Option B — VS Code / Cursor**  
Use any “Live Server” style extension and open the project root.

**Optional — ingest script** (Node, for building `data/material.json` from files on disk—not required for the in-browser PDF flow):

```bash
cd scripts && npm install && npm run ingest
```

---

## How it works (simple path)

1. Open **Generate** (`docs.html`).
2. **Load material:** saved items, **upload PDFs** (drag-and-drop or click), or pick an existing **material.json**.
3. After a load, name it (e.g. “Biol 365”) and **Save for later**—it stays in IndexedDB.
4. Pick sources, set question options, **Copy Prompt**.
5. Paste the prompt into ChatGPT (or another LLM), then **Paste Result** on the same page.
6. Enter quiz name and subject (they can auto-fill from the pasted JSON), **Save to My Quizzes**, then **Take Quiz**.

From the main **Take Quiz** page you can also **Backup** / **Restore** all quizzes and saved materials as one JSON file.

---

## What’s in the app

### Generate (`docs.html`)

- **Step 1 — Load material** (three tabs):
  - **Saved material:** everything you saved before, with **Use** to reload instantly.
  - **Upload PDFs:** multiple PDFs; text is extracted in the browser (PDF.js), headings inferred from font size to build topics, output matches **material.json** shape.
  - **material.json:** file picker (same as before).
  - After any successful load: a bar with a label and **Save for later** → IndexedDB.
- **Step 2 — Source selector** (unchanged).
- **Step 3 — Question config** (unchanged).
- **Copy prompt** (unchanged).
- **Step 4 — Paste result:**
  - Quiz name and subject fields (subject can auto-fill when you paste).
  - Textarea for the model’s output.
  - **Save to My Quizzes** → IndexedDB; **Take Quiz** appears after save.
- **Your data:** **Export all data** (full backup) and **Restore from backup** (merge back in).

### Take Quiz (`index.html`)

- Links to **Generate**, plus **Backup** / **Restore** for the same export/import flow.

### `store.js`

- **materials** store in IndexedDB (alongside quizzes).
- Helpers: `saveMaterial`, `getMaterial`, `getAllMaterials`, `deleteMaterial`, plus `exportBackup` / `importBackup`.

---

## Project layout (high level)

| Path | Role |
|------|------|
| `index.html`, `review.html`, `setup.html`, `docs.html` | Main UI pages |
| `js/` | App logic (e.g. `store.js`, `theme.js`) |
| `css/styles.css` | Styling |
| `data/material.json` | Sample / bundled material (optional) |
| `scripts/` | Optional Node ingest for `material.json` |

---

## Privacy

Quiz and material data stay on your machine in the browser unless you export a backup file yourself. PDF processing and quiz storage happen client-side; only your use of an external LLM sends prompts off this site.
