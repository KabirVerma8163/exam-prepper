// classify_slides.js
// Run this against a PDF to understand what's actually on each slide before
// tuning VLM trigger thresholds in extract_slides.js.
//
// Outputs: classify_report.json + a human-readable summary table to stdout.
//
// Usage: node classify_slides.js [path/to/slides.pdf]

import fs from "fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { createCanvas } from "canvas";

const PDF_PATH = process.argv[2] ?? "./slides.pdf";

// ─── THRESHOLDS (mirror extract_slides.js so comparison is meaningful) ────────
const SPARSE_TEXT_THRESHOLD      = 60;
const WIDE_LAYOUT_THRESHOLD      = 380;
const COLUMN_FRAGMENTATION_RATIO = 0.55;

// ─── LOAD ─────────────────────────────────────────────────────────────────────
async function loadPDF(path) {
  const data = new Uint8Array(fs.readFileSync(path));
  return pdfjsLib.getDocument({ data }).promise;
}

// ─── TEXT BLOCKS ──────────────────────────────────────────────────────────────
async function extractTextBlocks(page) {
  const content = await page.getTextContent();
  return content.items
    .filter(i => i.str.trim().length > 0)
    .map(i => ({
      text: i.str,
      x: i.transform[4],
      y: i.transform[5],
      fontSize: i.height
    }));
}

// ─── IMAGE COUNT ──────────────────────────────────────────────────────────────
// Walks the page operator list looking for paintImageXObject and
// paintInlineImageXObject calls. Each one is a distinct embedded image.
// Does NOT count vector graphics (paths, shapes) — only raster images.
async function countEmbeddedImages(page) {
  const ops = await page.getOperatorList();
  let count = 0;
  for (const op of ops.fnArray) {
    if (
      op === pdfjsLib.OPS.paintImageXObject ||
      op === pdfjsLib.OPS.paintInlineImageXObject ||
      op === pdfjsLib.OPS.paintImageMaskXObject
    ) {
      count++;
    }
  }
  return count;
}

// ─── COLORED TEXT ─────────────────────────────────────────────────────────────
// Walks the operator list tracking the current fill color state.
// When a text-drawing op fires with a non-black, non-default color,
// that segment is colored text.
//
// "Non-black" = any RGB where not all channels are near 0, and not the
// default gray(0) state. We allow a small epsilon for near-black.
//
// Returns { count, samples } where samples is the first few distinct colors seen.
async function detectColoredText(page) {
  const ops = await page.getOperatorList();
  const { fnArray, argsArray } = ops;

  // OPS constants we care about
  const {
    setFillRGBColor,    // rg  — args: [r, g, b]
    setFillGray,        // g   — args: [gray]
    setFillColorN,      // scn — args vary
    setFillColor,       // sc  — args vary
    setFillCMYKColor,   // k   — args: [c, m, y, k]
    showText,
    showSpacedText,
    nextLineShowText,
    nextLineSetSpacingShowText,
    beginText,
  } = pdfjsLib.OPS;

  const textOps = new Set([
    showText, showSpacedText, nextLineShowText, nextLineSetSpacingShowText
  ]);

  // Default PDF fill color is black (gray=0 or rgb=0,0,0)
  let currentColor = { type: "gray", value: 0 }; // black
  let coloredSegments = 0;
  const colorsSeen = new Set();

  function isBlack(color) {
    if (color.type === "gray") return color.value < 0.05;
    if (color.type === "rgb") {
      const [r, g, b] = color.value;
      return r < 0.05 && g < 0.05 && b < 0.05;
    }
    if (color.type === "cmyk") {
      const [c, m, y, k] = color.value;
      // All ink → black; white paper → no ink. Heuristic: near-black.
      return k > 0.9 && c < 0.1 && m < 0.1 && y < 0.1;
    }
    return true;
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn   = fnArray[i];
    const args = argsArray[i];

    if (fn === setFillGray) {
      currentColor = { type: "gray", value: args[0] };
    } else if (fn === setFillRGBColor) {
      currentColor = { type: "rgb", value: args };
    } else if (fn === setFillCMYKColor) {
      currentColor = { type: "cmyk", value: args };
    } else if (fn === setFillColorN || fn === setFillColor) {
      // Generic — treat as rgb if 3 args, gray if 1
      if (args.length === 3) {
        currentColor = { type: "rgb", value: args };
      } else if (args.length === 1) {
        currentColor = { type: "gray", value: args[0] };
      }
    } else if (textOps.has(fn)) {
      if (!isBlack(currentColor)) {
        coloredSegments++;
        // Record the color for the sample list
        const key = JSON.stringify(currentColor);
        colorsSeen.add(key);
      }
    }
  }

  return {
    coloredTextSegments: coloredSegments,
    distinctColors: colorsSeen.size,
    // Parse back to objects for the report
    colorSamples: [...colorsSeen].slice(0, 5).map(k => JSON.parse(k))
  };
}

// ─── PIXEL-BASED IMAGE COVERAGE ───────────────────────────────────────────────
// Renders the page at low resolution (scale=0.5) and samples pixels to estimate
// what fraction of the slide area contains non-white content that isn't text.
// This is a rough proxy for "how much of this slide is a photo/chart/diagram"
// without needing to parse vector paths.
//
// Method: render at low res, then compare to a white baseline. Pixels that are
// significantly non-white and don't fall near a known text block are counted
// as "image pixels". Expressed as a fraction of total slide area.
//
// Note: this is an approximation — coloured backgrounds, dark themes, and
// vector graphics all affect the count. Treat as a relative signal, not truth.
async function estimateImageCoverage(page, textBlocks) {
  const scale = 0.5;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");

  // Fill white first so empty areas are white, not transparent
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  const { data, width, height } = ctx.getImageData(0, 0, viewport.width, viewport.height);
  const totalPixels = width * height;

  // Build a rough mask of text regions (scale-adjusted bounding boxes)
  // to exclude them from the non-white pixel count.
  // We don't have exact glyph bounds, so we approximate each block as a
  // small rect around its x,y with width ≈ text.length * fontSize * 0.6.
  const textMask = new Uint8Array(totalPixels);
  for (const b of textBlocks) {
    const bx = Math.round(b.x * scale);
    const by = Math.round((viewport.height / scale - b.y) * scale); // flip y
    const bw = Math.round(b.text.length * b.fontSize * 0.6 * scale);
    const bh = Math.round(b.fontSize * scale * 1.5);
    for (let row = Math.max(0, by - bh); row < Math.min(height, by + 4); row++) {
      for (let col = Math.max(0, bx); col < Math.min(width, bx + bw); col++) {
        textMask[row * width + col] = 1;
      }
    }
  }

  let nonWhiteNonText = 0;
  for (let idx = 0; idx < totalPixels; idx++) {
    if (textMask[idx]) continue;
    const r = data[idx * 4];
    const g = data[idx * 4 + 1];
    const b = data[idx * 4 + 2];
    // "non-white" = any channel below 240
    if (r < 240 || g < 240 || b < 240) {
      nonWhiteNonText++;
    }
  }

  return parseFloat((nonWhiteNonText / totalPixels).toFixed(4));
}

// ─── EXISTING HEURISTICS (mirrored from extract_slides.js) ───────────────────
function computeHeuristics(rawText, blocks) {
  const charCount = rawText.length;
  const xs = blocks.map(b => b.x);
  const xRange = blocks.length >= 3
    ? Math.max(...xs) - Math.min(...xs)
    : 0;

  const buckets = new Set(blocks.map(b => Math.round(b.x / 30)));
  const fragRatio = blocks.length >= 4
    ? parseFloat((buckets.size / blocks.length).toFixed(3))
    : 0;

  const isSparse     = charCount < SPARSE_TEXT_THRESHOLD;
  const isWide       = xRange > WIDE_LAYOUT_THRESHOLD;
  const isFragmented = fragRatio > COLUMN_FRAGMENTATION_RATIO;

  let currentTrigger = null;
  if (isSparse)              currentTrigger = "sparse_text";
  else if (isWide && isFragmented) currentTrigger = "structural_diagram";
  else if (isWide)           currentTrigger = "wide_layout";

  return { charCount, xRange: Math.round(xRange), fragRatio, isSparse, isWide, isFragmented, currentTrigger };
}

// ─── CLASSIFY SINGLE SLIDE ────────────────────────────────────────────────────
async function classifySlide(page, slideNum) {
  const textBlocks  = await extractTextBlocks(page);
  const rawText     = textBlocks.map(b => b.text).join(" ");
  const heuristics  = computeHeuristics(rawText, textBlocks);
  const imageCount  = await countEmbeddedImages(page);
  const coloredText = await detectColoredText(page);
  const imgCoverage = await estimateImageCoverage(page, textBlocks);

  // Title: largest font block in the top 30% (same logic as extract_slides)
  const sorted  = [...textBlocks].sort((a, b) => b.y - a.y);
  const topY    = sorted[0]?.y ?? 0;
  const btmY    = sorted[sorted.length - 1]?.y ?? 0;
  const topZone = textBlocks.filter(b => b.y > topY - (topY - btmY) * 0.3);
  const title   = (topZone.sort((a, b) => b.fontSize - a.fontSize)[0]
                ?? textBlocks.sort((a, b) => b.fontSize - a.fontSize)[0])
                ?.text.trim().slice(0, 40) ?? "";

  return {
    slide: slideNum,
    title,
    ...heuristics,
    imageCount,
    ...coloredText,
    imgCoverage,
  };
}

// ─── TABLE PRINTER ────────────────────────────────────────────────────────────
function printTable(rows) {
  const cols = [
    { key: "slide",               label: "Slide", width: 5 },
    { key: "currentTrigger",      label: "Trigger", width: 18 },
    { key: "charCount",           label: "Chars", width: 6 },
    { key: "xRange",              label: "xRange", width: 7 },
    { key: "fragRatio",           label: "Frag", width: 6 },
    { key: "imageCount",          label: "Imgs", width: 5 },
    { key: "coloredTextSegments", label: "ColTxt", width: 7 },
    { key: "distinctColors",      label: "Clrs", width: 5 },
    { key: "imgCoverage",         label: "ImgPx%", width: 7 },
    { key: "title",               label: "Title", width: 35 },
  ];

  const header = cols.map(c => c.label.padEnd(c.width)).join(" | ");
  const divider = cols.map(c => "-".repeat(c.width)).join("-+-");
  console.log("\n" + header);
  console.log(divider);

  for (const row of rows) {
    const line = cols.map(c => {
      let val = row[c.key] ?? "-";
      if (val === null || val === undefined) val = "-";
      return String(val).slice(0, c.width).padEnd(c.width);
    }).join(" | ");
    console.log(line);
  }

  console.log("\n");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Classifying: ${PDF_PATH}`);
  const pdf  = await loadPDF(PDF_PATH);
  const rows = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    process.stdout.write(`  Slide ${i}/${pdf.numPages}...`);
    try {
      const page = await pdf.getPage(i);
      const result = await classifySlide(page, i);
      rows.push(result);
      process.stdout.write(` trigger=${result.currentTrigger ?? "none"}, imgs=${result.imageCount}, colTxt=${result.coloredTextSegments}\n`);
    } catch (err) {
      console.warn(` ERROR: ${err.message}`);
      rows.push({ slide: i, error: err.message });
    }
  }

  printTable(rows.filter(r => !r.error));

  // Summary: false positive candidates = wide_layout fires with 0 images,
  // low imgCoverage, and low colored text
  const suspicious = rows.filter(r =>
    r.currentTrigger === "wide_layout" &&
    r.imageCount === 0 &&
    r.imgCoverage < 0.02 &&
    r.coloredTextSegments < 5
  );

  if (suspicious.length > 0) {
    console.log(`Likely false positives (wide_layout, no images, <2% image pixels, <5 colored text segs):`);
    console.log(suspicious.map(r => `  Slide ${r.slide}: "${r.title}"`).join("\n"));
    console.log(`\nConsider raising WIDE_LAYOUT_THRESHOLD or adding an image-presence guard.`);
  }

  fs.writeFileSync("classify_report.json", JSON.stringify(rows, null, 2));
  console.log("\nFull report → classify_report.json");
})();
