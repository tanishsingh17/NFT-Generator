export default {
  // Core
  editionSize: 10,          // how many NFTs to generate (change as needed)
  shuffleMetadata: true,     // randomize tokenId order after generation
  width: 1024,
  height: 1024,
  traitsDir: "./traits",     // folder where you keep your trait layers
  outputDir: "./output",     // where final images + metadata will go
  imagesSubdir: "images",
  metadataSubdir: "metadata",
  rarityDelimiter: "#",      // use filenames like TraitName#30.png for rarity weights
  uniqueDnaTorrance: 10000,  // max retries to find a unique combo

  // Collection metadata (ERC-721 style)
  namePrefix: "Piggos",
  description: "A fully generative collection bringing back the classic degen vibes on the mother chain.",
  baseUri: "ipfs://__REPLACE_WITH_YOUR_CID__", // replace with your images folder CID from IPFS


  // Rules: define incompatibilities and required combos
  // Use exact format: "LayerName:TraitValue"
  // Example: "Base:Alien" cannot have "Head:Crown"
  incompatible: {
    "Base:Alien": ["Head:Crown"],
    "Clothes:Armor": ["Mouth:Smile"] // example custom rule
  },

  // Required combos: when a given trait appears, force other traits
  // Example: If "Eye:Laser" is used, force "Mouth:Fangs"
  requires: {
    "Eye:Laser": ["Mouth:Fangs"]
  },

  // Optional: lock certain layers to always appear (by folder name)
  mandatoryLayers: ["Background", "Base"],

  // Optional: preview contact sheet
  preview: {
    generate: true,
    cols: 10,
    rows: 10, // 10x10 = 100 NFTs in preview
    filename: "preview.png",
    margin: 10
  }
};

