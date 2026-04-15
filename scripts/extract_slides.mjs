import fs from "fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { createCanvas } from "canvas";

const PDF_PATH = "./slides.pdf";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── THRESHOLDS ───────────────────────────────────────────────────────────────

// Slides with fewer raw characters than this trigger VLM regardless of content.
const SPARSE_TEXT_THRESHOLD = 60;

// image_content: minimum imgCoverage for a slide with imageCount > 0 to trigger.
// Filters out invisible 1-pixel tracking objects that register as paintImageXObject.
// From the data: smallest real image = 5.4%; false objects cluster below that.
const IMAGE_COVERAGE_MIN = 0.05;

// vector_diagram: minimum imgCoverage for a slide with no embedded raster images.
// From the data: legitimate vector diagrams 10.9%–30.3%; template noise 2.7%–9.5%.
const VECTOR_COVERAGE_MIN = 0.10;

// ─── LOAD PDF ─────────────────────────────────────────────────────────────────
async function loadPDF(path) {
  const data = new Uint8Array(fs.readFileSync(path));
  return pdfjsLib.getDocument({ data }).promise;
}

// ─── EXTRACT TEXT BLOCKS ──────────────────────────────────────────────────────
// pdfjs returns each text run with a 6-element transform matrix.
// transform[4] = x, transform[5] = y (origin is bottom-left in PDF space).
// item.height approximates font size.
async function extractTextBlocks(page) {
  const content = await page.getTextContent();
  return content.items
    .filter(item => item.str.trim().length > 0)
    .map(item => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      fontSize: item.height
    }));
}

// ─── VISUAL PRESENCE CHECKS ───────────────────────────────────────────────────
// These run on the page operator list — no rendering required.
// They act as a confirmation gate: layout geometry alone is not enough to
// trigger Gemini; there must also be evidence of actual visual content.

// Count raster images embedded in the page (paintImageXObject calls).
// Vector graphics (paths, shapes drawn with PDF ops) do NOT count here —
// those are caught by imgCoverage below.
async function countEmbeddedImages(page) {
  const ops = await page.getOperatorList();
  let count = 0;
  for (const op of ops.fnArray) {
    if (
      op === pdfjsLib.OPS.paintImageXObject       ||
      op === pdfjsLib.OPS.paintInlineImageXObject  ||
      op === pdfjsLib.OPS.paintImageMaskXObject
    ) count++;
  }
  return count;
}

// Count text segments drawn in a non-black color.
// Walks the operator list tracking the current fill color state machine.
// Returns the number of text-draw ops that fired with non-black fill.
async function countColoredTextSegments(page) {
  const { fnArray, argsArray } = await page.getOperatorList();
  const { setFillRGBColor, setFillGray, setFillColorN, setFillColor,
          setFillCMYKColor, showText, showSpacedText,
          nextLineShowText, nextLineSetSpacingShowText } = pdfjsLib.OPS;
  const textOps = new Set([showText, showSpacedText, nextLineShowText, nextLineSetSpacingShowText]);

  let currentColor = { type: "gray", value: 0 }; // PDF default: black
  let colored = 0;

  function isBlack(c) {
    if (c.type === "gray")  return c.value < 0.05;
    if (c.type === "rgb")   return c.value[0] < 0.05 && c.value[1] < 0.05 && c.value[2] < 0.05;
    if (c.type === "cmyk")  return c.value[3] > 0.9 && c.value[0] < 0.1 && c.value[1] < 0.1 && c.value[2] < 0.1;
    return true;
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if      (fn === setFillGray)    currentColor = { type: "gray", value: args[0] };
    else if (fn === setFillRGBColor) currentColor = { type: "rgb",  value: args };
    else if (fn === setFillCMYKColor) currentColor = { type: "cmyk", value: args };
    else if (fn === setFillColorN || fn === setFillColor) {
      if (args.length === 3) currentColor = { type: "rgb",  value: args };
      else if (args.length === 1) currentColor = { type: "gray", value: args[0] };
    }
    else if (textOps.has(fn) && !isBlack(currentColor)) colored++;
  }
  return colored;
}

// Render at low resolution and estimate what fraction of the slide area is
// non-white content outside of text block bounding boxes.
// Catches vector diagrams and charts that don't show up as paintImageXObject.
async function estimateImageCoverage(page, textBlocks) {
  const scale = 0.4; // low res — just need the pixel distribution
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const { data, width, height } = ctx.getImageData(0, 0, viewport.width, viewport.height);
  const total = width * height;

  // Rough text mask: exclude approximate bounding boxes of extracted text blocks
  const mask = new Uint8Array(total);
  for (const b of textBlocks) {
    const bx = Math.round(b.x * scale);
    const by = Math.round((viewport.height / scale - b.y) * scale);
    const bw = Math.round(b.text.length * b.fontSize * 0.6 * scale);
    const bh = Math.round(b.fontSize * scale * 1.5);
    for (let r = Math.max(0, by - bh); r < Math.min(height, by + 4); r++)
      for (let c = Math.max(0, bx); c < Math.min(width, bx + bw); c++)
        mask[r * width + c] = 1;
  }

  let nonWhite = 0;
  for (let idx = 0; idx < total; idx++) {
    if (mask[idx]) continue;
    if (data[idx*4] < 240 || data[idx*4+1] < 240 || data[idx*4+2] < 240) nonWhite++;
  }
  return nonWhite / total;
}

// ─── TRIGGER LOGIC ────────────────────────────────────────────────────────────
// Geometry (x-range, fragmentation) is dropped as a primary signal — the data
// showed it fires on ~50/64 slides and misses images that fall outside the
// layout footprint the heuristic was tuned for.
//
// Three content-signal conditions, evaluated in order:
//
//   1. sparse_text  — almost no extractable text; whatever is on the slide
//                     isn't text, so we always want Gemini.
//
//   2. image_content — at least one raster image is embedded AND imgCoverage
//                      confirms it occupies meaningful area (filters out 1-pixel
//                      invisible tracking objects that register as images).
//                      Threshold 0.05 = 5% of slide area. From the data:
//                      all real images are ≥ 5.4%; false positives cluster below.
//
//   3. vector_diagram — no embedded raster image, but the rendered slide has
//                       substantial non-white, non-text area. This catches
//                       flowcharts, tables, and vector charts drawn as PDF paths.
//                       Threshold 0.10 = 10% of slide area. From the data:
//                       legitimate vector slides: 10.9%–30.3%; template noise
//                       (section titles, decorative underlines): 2.7%–9.5%.
//
// coloredText is deliberately dropped as a standalone trigger — from the data,
// the slide template itself contributes 5–20 colored segments on pure-text slides
// (page numbers, footer colors), making it unreliable without imgCoverage backup.
// Slides where colored text is the content (e.g. annotated code) also have
// imageCount > 0 or imgCoverage > 0.10 and are already caught by those signals.

// Coverage in the range (VECTOR_COVERAGE_MIN, VECTOR_COVERAGE_MIN * 1.5) is
// "borderline" — could be a small diagram or could be template decoration.
// Gemini gets a more sceptical prompt for these.
const VECTOR_COVERAGE_BORDERLINE = VECTOR_COVERAGE_MIN * 1.5;

async function vlmTriggerReason(rawText, blocks, page) {
  // Condition 1: trivially sparse — always fire, skip coverage computation
  if (rawText.length < SPARSE_TEXT_THRESHOLD) return { trigger: "sparse_text", borderline: false };

  const imageCount = await countEmbeddedImages(page);

  // Condition 2: raster image present — confirm it occupies real area
  if (imageCount > 0) {
    const imgCoverage = await estimateImageCoverage(page, blocks);
    if (imgCoverage > IMAGE_COVERAGE_MIN) return { trigger: "image_content", borderline: false };
    console.log(`    ↳ imageCount=${imageCount} suppressed (imgCoverage=${imgCoverage.toFixed(3)} < ${IMAGE_COVERAGE_MIN}, likely invisible object)`);
  }

  // Condition 3: vector diagram — check non-white pixel area
  const imgCoverage = await estimateImageCoverage(page, blocks);
  if (imageCount === 0 && imgCoverage > VECTOR_COVERAGE_MIN) {
    const borderline = imgCoverage < VECTOR_COVERAGE_BORDERLINE;
    if (borderline) console.log(`    ↳ vector_diagram borderline (imgCoverage=${imgCoverage.toFixed(3)}, may be template noise)`);
    return { trigger: "vector_diagram", borderline };
  }

  return { trigger: null, borderline: false };
}

// ─── RECONSTRUCT SLIDE STRUCTURE ──────────────────────────────────────────────
function buildSlideStructure(blocks) {
  if (blocks.length === 0) return { title: "", bullets: [] };

  const sorted = [...blocks].sort((a, b) => b.y - a.y);
  const topY    = sorted[0].y;
  const bottomY = sorted[sorted.length - 1].y;
  const pageHeight = topY - bottomY || 1;

  // Title: largest font block in the top 30% of the page.
  const topZone = blocks.filter(b => b.y > topY - pageHeight * 0.3);
  const titleBlock =
    topZone.sort((a, b) => b.fontSize - a.fontSize)[0] ??
    [...blocks].sort((a, b) => b.fontSize - a.fontSize)[0];

  // Group remaining blocks into lines by y-bucketing (4-unit bins).
  const bodyBlocks = blocks.filter(b => b !== titleBlock);
  const lineMap = {};
  for (const b of bodyBlocks) {
    const key = Math.round(b.y / 4) * 4;
    if (!lineMap[key]) lineMap[key] = [];
    lineMap[key].push(b);
  }

  const bullets = Object.entries(lineMap)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([, line]) => {
      const lineBlocks = line.sort((a, b) => a.x - b.x);
      const text = lineBlocks.map(b => b.text).join(" ").trim();
      const indentLevel = Math.max(0, Math.round((lineBlocks[0].x - titleBlock.x) / 20));
      return { text, level: indentLevel };
    })
    .filter(b => b.text.length > 0);

  return { title: titleBlock.text.trim(), bullets };
}

// ─── RENDER PAGE ──────────────────────────────────────────────────────────────
// scale=2 → 144 DPI effective. Helps Gemini read small diagram labels.
async function renderPageToImage(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toBuffer("image/png");
}

// ─── GEMINI FLASH ─────────────────────────────────────────────────────────────

// Prompt is varied based on why the VLM was triggered.
// Structural slides get an explicit graph/edge-list extraction instruction;
// sparse/image-only slides get a general visual description prompt.
function buildPrompt(triggerReason, borderline = false) {
  if (triggerReason === "vector_diagram") {
    if (borderline) {
      return (
        "This slide triggered a visual-content check but the signal is weak — it may contain a small diagram, " +
        "a decorative element, or just a coloured template border. Look carefully:\n" +
        "- If there is a genuine diagram, flowchart, chart, or table: describe it thoroughly. " +
        "For flowcharts list every node and connection as 'A → B'.\n" +
        "- If the only non-text content is decorative (borders, lines, background shapes, logos, " +
        "page numbers, or slide template elements): respond with exactly: text only\n" +
        "Be conservative — only describe content that would actually be useful for generating exam questions."
      );
    }
    return (
      "This slide appears to contain a flowchart, vector diagram, table, or chart drawn as graphics. Do the following:\n" +
      "1. If there is a flowchart or graph: list every node/box and every directed connection " +
      "as 'A → B'. Include branch points, parallel tracks, and any colour-coded groupings.\n" +
      "2. If there is a chart or plot: describe axis labels, units, data series, and the key " +
      "trend or comparison being made.\n" +
      "3. If there is a table: reproduce its structure and values as text.\n" +
      "4. If there is a multi-column layout: describe each column's content and its relationship.\n" +
      "Be exhaustive — this output will be used to generate quiz questions. " +
      "If there is no notable visual content beyond plain text, respond with exactly: text only"
    );
  }
  // sparse_text and image_content
  return (
    "Describe any diagrams, charts, figures, equations, screenshots, or visual content on this slide. " +
    "Be specific — include axis labels, data trends, key values, tool names, or structural relationships if present. " +
    "If there is no notable visual content beyond plain text, respond with exactly: text only"
  );
}

async function analyzeWithGemini(imageBuffer, triggerReason, borderline = false) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY env var not set");

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: buildPrompt(triggerReason, borderline) },
          { inline_data: { mime_type: "image/png", data: imageBuffer.toString("base64") } }
        ]
      }],
      generationConfig: { temperature: 0.1 } // low temp: factual extraction, not creative
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "no response";
}

// ─── FORMAT AS MARKDOWN ───────────────────────────────────────────────────────
function formatSlide(slideNum, structure, visualDesc, triggerReason) {
  const lines = [`## Slide ${slideNum}: ${structure.title || "(untitled)"}`];

  for (const bullet of structure.bullets) {
    lines.push(`${"  ".repeat(bullet.level)}- ${bullet.text}`);
  }

  if (visualDesc && visualDesc.toLowerCase() !== "text only") {
    const tag = triggerReason === "vector_diagram" ? "[Diagram Structure]" : "[Visual]";
    lines.push(`\n> **${tag}** ${visualDesc}`);
  }

  return lines.join("\n");
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────
async function processSlides(pdfPath) {
  const pdf = await loadPDF(pdfPath);
  const slides = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);

      // 1. Pull digital text — fast, lossless, no rendering needed
      const textBlocks = await extractTextBlocks(page);
      const rawText = textBlocks.map(b => b.text).join(" ");

      // 2. Reconstruct title + bullet hierarchy from layout metadata
      const structure = buildSlideStructure(textBlocks);

      // 3. Evaluate trigger conditions — geometry first, then visual confirmation
      const { trigger: triggerReason, borderline } = await vlmTriggerReason(rawText, textBlocks, page);

      let visualDesc = null;
      if (triggerReason) {
        console.log(`  Slide ${i}: trigger=${triggerReason}${borderline ? " (borderline)" : ""} → calling Gemini Flash`);
        const imageBuffer = await renderPageToImage(page);
        visualDesc = await analyzeWithGemini(imageBuffer, triggerReason, borderline);
      }

      slides.push(formatSlide(i, structure, visualDesc, triggerReason));
      console.log(`✓ Slide ${i}/${pdf.numPages}`);
    } catch (err) {
      console.warn(`✗ Slide ${i} failed: ${err.message}`);
      slides.push(`## Slide ${i}: [EXTRACTION ERROR — ${err.message}]`);
    }
  }

  return slides.join("\n\n---\n\n");
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!GEMINI_API_KEY) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    console.error("Usage: GEMINI_API_KEY=your_key node extract_slides.js");
    process.exit(1);
  }

  const markdown = await processSlides(PDF_PATH);
  fs.writeFileSync("slides.md", markdown);
  console.log("\nDone → slides.md");
})();
