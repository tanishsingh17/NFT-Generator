import fs from "fs-extra";
import path from "path";
import { glob } from "glob";
import sharp from "sharp";
import config from "./config.js";

const {
  editionSize,
  shuffleMetadata,
  width,
  height,
  traitsDir,
  outputDir,
  imagesSubdir,
  metadataSubdir,
  rarityDelimiter,
  uniqueDnaTorrance,
  namePrefix,
  description,
  baseUri,
  extraMetadata,
  incompatible,
  requires,
  mandatoryLayers,
  preview
} = config;

const outImages = path.join(outputDir, imagesSubdir);
const outMetadata = path.join(outputDir, metadataSubdir);
const outLogs = path.join(outputDir, "_logs");

const toTitle = (s) => s.replace(/^\d+_/, "").replace(/_/g, " ").trim();
const parseWeight = (filename) => {
  const base = path.parse(filename).name;
  const idx = base.lastIndexOf(rarityDelimiter);
  if (idx === -1) return { name: base, weight: 1 };
  const name = base.slice(0, idx);
  const weight = Number(base.slice(idx + 1)) || 1;
  return { name, weight };
};

async function readLayers() {
  const layerDirs = (await fs.readdir(traitsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const layers = [];
  for (const dir of layerDirs) {
    const folder = path.join(traitsDir, dir);
    const files = await glob("*.png", { cwd: folder, nodir: true });
    if (!files.length) continue;

    const elements = files.map((f) => {
      const { name, weight } = parseWeight(f);
      return {
        id: `${toTitle(dir)}:${name}`,
        layer: toTitle(dir),
        name,
        weight,
        path: path.join(folder, f)
      };
    });

    layers.push({
      id: toTitle(dir),
      elements,
    });
  }

  if (!layers.length) {
    throw new Error("No layers found under ./traits. Add layered PNGs first.");
  }
  return layers;
}

function weightedPick(elements) {
  const total = elements.reduce((sum, e) => sum + e.weight, 0);
  let r = Math.random() * total;
  for (const e of elements) {
    if ((r -= e.weight) <= 0) return e;
  }
  return elements[elements.length - 1];
}

function traitKey(layerName, valueName) {
  return `${layerName}:${valueName}`;
}

function violatesIncompatibilities(selection) {
  // selection: array of { layer, name }
  const chosen = new Set(selection.map((s) => traitKey(s.layer, s.name)));
  for (const k of chosen) {
    const bad = incompatible[k];
    if (bad && bad.some((b) => chosen.has(b))) {
      return true;
    }
  }
  return false;
}

function enforceRequirements(selection) {
  const chosen = new Set(selection.map((s) => traitKey(s.layer, s.name)));
  const mustAdd = new Map(); // layer -> traitValue
  for (const k of chosen) {
    const reqs = requires[k];
    if (reqs) {
      for (const target of reqs) {
        const [layer, value] = target.split(":");
        mustAdd.set(layer, value);
      }
    }
  }
  return mustAdd;
}

function dnaFromSelection(selection) {
  // DNA string order by layer id for uniqueness
  return selection
    .slice()
    .sort((a, b) => a.layer.localeCompare(b.layer))
    .map((s) => `${s.layer}:${s.name}`)
    .join("|");
}

async function composeImage(selection, filepath) {
  // Prepare composite list in proper layer order
  const ordered = selection.slice().sort((a, b) => a._order - b._order);
  // Use sharp to composite
  let base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  });

  const layers = await Promise.all(
    ordered.map(async (s) => {
      // Ensure resized to canvas size (trait assets should be same size or be positioned, here we just fit)
      return {
        input: await sharp(s.path).resize(width, height, { fit: "contain" }).toBuffer()
      };
    })
  );

  base = base.composite(layers);
  await base.png().toFile(filepath);
}

function metadataForToken(tokenId, selection, imageUri) {
  const attributes = selection
    .sort((a, b) => a._order - b._order)
    .map((s) => ({
      trait_type: s.layer,
      value: s.name
    }));

  return {
    name: `${namePrefix} #${tokenId}`,
    description,
    image: imageUri,
    edition: tokenId,
    attributes,
    ...extraMetadata
  };
}

function pickTraitsForLayers(layers) {
  // Random pick per layer, then enforce requirements
  const picked = [];
  let order = 0;
  for (const layer of layers) {
    const el = weightedPick(layer.elements);
    picked.push({ ...el, _order: order++ });
  }

  // Enforce "mandatoryLayers" presence (use highest weight element if missing)
  if (mandatoryLayers?.length) {
    for (const m of mandatoryLayers) {
      if (!picked.find((p) => p.layer === m)) {
        const layer = layers.find((l) => l.id === m);
        if (layer) {
          // pick the highest weight as default
          const sorted = layer.elements.slice().sort((a, b) => b.weight - a.weight);
          picked.push({ ...sorted[0], _order: order++ });
        }
      }
    }
  }

  // Enforce "requires"
  const mustAdd = enforceRequirements(picked);
  if (mustAdd.size) {
    for (const [layerName, valueName] of mustAdd.entries()) {
      const idx = picked.findIndex((p) => p.layer === layerName);
      if (idx >= 0) {
        picked[idx] = {
          ...picked[idx],
          name: valueName,
          id: traitKey(layerName, valueName)
        };
      } else {
        // Insert new trait from that layer matching the required value
        const layer = layers.find((l) => l.id === layerName);
        if (layer) {
          const found = layer.elements.find((e) => e.name === valueName);
          if (found) picked.push({ ...found, _order: order++ });
        }
      }
    }
  }

  return picked;
}

async function ensureDirs() {
  await fs.ensureDir(outImages);
  await fs.ensureDir(outMetadata);
  await fs.ensureDir(outLogs);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function buildPreviewGrid(imagePaths) {
  if (!preview?.generate) return;
  const { cols, rows, filename, margin } = preview;
  const gridW = cols * width + (cols + 1) * margin;
  const gridH = rows * height + (rows + 1) * margin;

  const composites = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= imagePaths.length) break;
      const imgBuf = await fs.readFile(imagePaths[idx]);
      composites.push({
        input: imgBuf,
        top: margin + r * (height + margin),
        left: margin + c * (width + margin)
      });
    }
  }

  const canvas = sharp({
    create: {
      width: gridW,
      height: gridH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  await canvas.composite(composites).png().toFile(path.join(outputDir, filename));
}

async function main() {
  console.time("generate");
  await ensureDirs();
  const layers = await readLayers();

  const dnaSet = new Set();
  const allMetadata = [];
  const imagePaths = [];

  let failures = 0;

  for (let edition = 1; edition <= editionSize; edition++) {
    let attempts = 0;
    let selection, dna;

    do {
      selection = pickTraitsForLayers(layers);
      attempts++;
      // reject incompatible combos
      if (violatesIncompatibilities(selection)) continue;
      dna = dnaFromSelection(selection);
    } while (dnaSet.has(dna) && attempts < uniqueDnaTorrance);

    if (attempts >= uniqueDnaTorrance) {
      failures++;
      console.warn(`⚠️  Could not find unique DNA for token #${edition} after ${attempts} tries.`);
      continue;
    }

    dnaSet.add(dna);

    const imgPath = path.join(outImages, `${edition}.png`);
    await composeImage(selection, imgPath);

    const imageUri = baseUri.endsWith("/")
      ? `${baseUri}${edition}.png`
      : `${baseUri}/${edition}.png`;

    const meta = metadataForToken(edition, selection, imageUri);
    const metaPath = path.join(outMetadata, `${edition}.json`);
    await fs.writeJson(metaPath, meta, { spaces: 2 });

    allMetadata.push(meta);
    imagePaths.push(imgPath);

    process.stdout.write(`\rGenerated ${edition}/${editionSize}`);
  }

  // Optionally shuffle token IDs in metadata filenames (images stay numbered)
  if (shuffleMetadata) {
    const indices = allMetadata.map((_, i) => i + 1);
    shuffle(indices);
    // rewrite metadata files to shuffled tokenIds
    await fs.emptyDir(outMetadata);
    for (let newId = 1; newId <= allMetadata.length; newId++) {
      const originalIdx = indices[newId - 1] - 1;
      const meta = { ...allMetadata[originalIdx], name: `${namePrefix} #${newId}`, edition: newId, image: baseUri.endsWith("/") ? `${baseUri}${newId}.png` : `${baseUri}/${newId}.png` };
      await fs.writeJson(path.join(outMetadata, `${newId}.json`), meta, { spaces: 2 });
    }
  }

  // _metadata.json (array)
  await fs.writeJson(path.join(outputDir, "_metadata.json"), allMetadata, { spaces: 2 });

  // DNA log
  await fs.writeFile(path.join(outLogs, "dna.txt"), Array.from(dnaSet).join("\n"), "utf8");

  // Preview sheet
  await buildPreviewGrid(imagePaths);

  console.log(`\n✅ Done. Images: ${outImages}  Metadata: ${outMetadata}`);
  if (failures) {
    console.log(`Note: ${failures} token(s) were skipped due to uniqueness pressure. Increase editionSize or relax rules/weights.`);
  }
  console.timeEnd("generate");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
